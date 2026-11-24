import { EventEmitter } from 'node:events'
import { Bridge } from './pipe.js'
import { pidsFromPipes, isAlive } from './qq.js'

/** 一个账号 */
class Account {
  constructor (pid) {
    this.pid = Number(pid)
    this.uin = 0
    this.nick = ''
    this.bridge = new Bridge()
    this.ready = false
    this.readyEmitted = false
    this.seenAt = Date.now()
    this.firstSeenAt = Date.now()
    this.identityTried = 0
  }

  get connected () { return this.bridge.connected }

  toJSON () {
    return {
      pid: this.pid,
      uin: this.uin || null,
      nick: this.nick || '',
      connected: this.connected,
      ready: this.ready,
      alive: isAlive(this.pid),
      evtPath: this.bridge.evtPath,
      lastEventAt: this.bridge.lastEventAt,
      frames: this.bridge.frames,
      firstSeenAt: this.firstSeenAt
    }
  }
}

class Pool extends EventEmitter {
  constructor () {
    super()
    /** @type {Map<number, Account>} */
    this.accounts = new Map()
    this.activePid = 0
    this._scanning = false
  }

  ensure (pid) {
    const p = Number(pid)
    if (!p) return null
    let a = this.accounts.get(p)
    if (!a) {
      a = new Account(p)
      this.accounts.set(p, a)
      this._wire(a)
      a.bridge.attach(p)
      this.emit('account-new', a.toJSON())
    } else if (a.bridge.pid !== p) {
      /* 通道被 detach 过（比如断线后），重新挂上 */
      a.bridge.attach(p)
    }
    return a
  }

  _wire (a) {
    a.bridge.on('event', (ev) => {
      a.seenAt = Date.now()
      if (!a.ready) a.ready = true
      this._markReady(a)
      if (ev && typeof ev === 'object') {
        Object.defineProperty(ev, '__pid', { value: a.pid, enumerable: false, configurable: true })
        /* 用 getter：认主是异步的，事件可能比 uin 早到 */
        Object.defineProperty(ev, '__selfId', { get: () => a.uin || 0, enumerable: false, configurable: true })
      }
      this.emit('event', ev, a)
    })
    a.bridge.on('status', (s) => {
      if (s && s.connected) {
        a.ready = true
        /* 两条管道都通了就算 ready（事件还没来也要认主，否则 UI 上一直没 uin） */
        if (s.phase === 'ready') this._markReady(a)
      } else if (s && s.phase && /closed/.test(s.phase)) {
        a.ready = false
        a.readyEmitted = false          /* 重连后要重新认主 */
      }
      this.emit('status', Object.assign({ pid: a.pid, uin: a.uin || 0 }, s))
      this._maybePickActive()
    })
  }

  _markReady (a) {
    if (a.readyEmitted) return
    a.readyEmitted = true
    this.emit('account-ready', a.toJSON())
  }

  /** 没有当前账号时，自动挑一个已连上的。
   *  优先级：进程还活着的 > 先接入的。残留的假管道/僵尸 pid 不会被选中。 */
  _maybePickActive () {
    if (this.pinned) return                       /* 用户手动选过，不再自动改 */
    const live = [...this.accounts.values()].filter((a) => a.bridge.connected)
    if (!live.length) return
    live.sort((a, b) => {
      const av = isAlive(a.pid) ? 0 : 1
      const bv = isAlive(b.pid) ? 0 : 1
      if (av !== bv) return av - bv
      return a.firstSeenAt - b.firstSeenAt
    })
    /* 当前账号进程还活着就不动它；否则换成排序第一（活着的优先） */
    const cur = this.accounts.get(this.activePid)
    if (cur && cur.bridge.connected && isAlive(cur.pid)) return
    if (this.activePid !== live[0].pid) {
      this.activePid = live[0].pid
      this.emit('active', this.currentJson())
    }
  }

  /** 扫管道，接上所有新进程，清掉已经没管道的 */
  scan () {
    if (this._scanning) return this.list()
    this._scanning = true
    try {
      const pids = new Set(pidsFromPipes())
      for (const p of pids) this.ensure(p)
      const now = Date.now()
      for (const [p, a] of this.accounts) {
        if (pids.has(p)) continue
        /* 管道没了：容忍 60 秒（QQ 重启时管道会瞬时消失），超时才摘掉 */
        if (now - a.seenAt > 60000) {
          a.bridge.detach()
          this.accounts.delete(p)
          this.emit('account-gone', { pid: p, uin: a.uin || null })
          if (this.activePid === p) { this.activePid = 0; this._maybePickActive() }
        }
      }
      this._maybePickActive()
    } finally {
      this._scanning = false
    }
    return this.list()
  }

  current () {
    const a = this.accounts.get(this.activePid)
    if (a) return a
    for (const x of this.accounts.values()) if (x.bridge.connected) { this.activePid = x.pid; return x }
    return null
  }

  currentJson () {
    const a = this.current()
    return a ? a.toJSON() : null
  }

  list () {
    return [...this.accounts.values()].map((a) => a.toJSON())
  }

  byKey (key) {
    if (key === undefined || key === null || key === '') return this.current()
    const s = String(key).trim()
    for (const a of this.accounts.values()) {
      if (String(a.pid) === s) return a
      if (a.uin && String(a.uin) === s) return a
    }
    return null
  }

  select (key) {
    const a = this.byKey(key)
    if (!a) return { ok: false, msg: `没有这个账号：${key}` }
    if (!a.bridge.connected) return { ok: false, msg: `账号 ${a.uin || a.pid} 的通道没连上` }
    this.activePid = a.pid
    this.pinned = true                     /* 手动选过就别被自动逻辑抢走 */
    this.emit('active', a.toJSON())
    return { ok: true, account: a.toJSON() }
  }

  /** 身份（uin/昵称）由 index.js 探到后回填 */
  setIdentity (pid, uin, nick) {
    const a = this.accounts.get(Number(pid))
    if (!a) return
    a.uin = Number(uin) || 0
    if (nick) a.nick = String(nick)
    this.emit('account-identity', a.toJSON())
    if (this.activePid === a.pid) this.emit('active', a.toJSON())
  }

  get pid () { const a = this.current(); return a ? a.pid : 0 }
  get connected () { const a = this.current(); return !!(a && a.bridge.connected) }
  get evtPath () { const a = this.current(); return a ? a.bridge.evtPath : '' }
  get cmdPath () { const a = this.current(); return a ? a.bridge.cmdPath : '' }
  get frames () { const a = this.current(); return a ? a.bridge.frames : 0 }
  get lastEventAt () { const a = this.current(); return a ? a.bridge.lastEventAt : 0 }

  send (obj) {
    const a = this.current()
    if (!a) return false
    return a.bridge.send(obj)
  }

  sendTo (key, obj) {
    const a = this.byKey(key)
    if (!a) return false
    return a.bridge.send(obj)
  }

  status () {
    const a = this.current()
    const s = a ? a.bridge.status() : { pid: 0, connected: false, evtUp: false, cmdUp: false, frames: 0, lastEventAt: 0, backpressure: 0, dropped: 0, reconnects: 0, queued: 0, sockets: 0 }
    return Object.assign(s, { uin: a ? a.uin : 0, accounts: this.list(), activePid: this.activePid })
  }

  statusOf (key) {
    const a = this.byKey(key)
    return a ? a.bridge.status() : null
  }

  /** attach(pid) = 接入该 pid 并切为当前账号 */
  attach (pid) {
    const a = this.ensure(pid)
    if (a) {
      if (!a.bridge.pid || a.bridge.pid !== a.pid) a.bridge.attach(a.pid)
      this.activePid = a.pid
    }
  }

  detach () {
    const a = this.current()
    if (a) { a.bridge.detach(); a.ready = false }
  }

  detachPid (pid) {
    const a = this.accounts.get(Number(pid))
    if (a) { a.bridge.detach(); a.ready = false }
  }
}

export const pool = new Pool()

/** pool 的别名，保持既有 `import { bridge }` 可用 */
export const bridge = pool
