import net from 'node:net'
import { EventEmitter } from 'node:events'
import { pipePath, encodeCmd } from './platform.js'

const MAX_FRAME = 16 * 1024 * 1024
const MAX_QUEUE = 64
const RECONNECT_MS = 2500

export class Bridge extends EventEmitter {
  /**
   * @param {{ connect?: (path: string) => any, reconnectMs?: number }} [opts]
   *        connect / reconnectMs 只给单测用，默认真连命名管道、2.5 秒重连
   */
  constructor (opts = {}) {
    super()
    this._open = typeof opts.connect === 'function' ? opts.connect : (p) => net.connect(p)
    this._reconnectMs = Number(opts.reconnectMs) > 0 ? Number(opts.reconnectMs) : RECONNECT_MS
    this.pid = 0
    this.evt = null
    this.cmd = null
    this.buf = Buffer.alloc(0)
    this.evtUp = false
    this.cmdUp = false
    this.frames = 0
    this.lastEventAt = 0
    this._reconnectTimer = null
    this._closing = false
    this._sockets = new Set()
    this._queue = []
    this._needDrain = false
    this.backpressure = 0
    this.dropped = 0
    this.reconnects = 0
    this.lastBackpressureAt = 0
  }

  /** 两条管道都连上才算通 */
  get connected () { return this.evtUp && this.cmdUp }

  /* 路径由平台层决定：Windows 命名管道 / Linux unix socket */
  get evtPath () { return pipePath(this.pid, 'evt') }
  get cmdPath () { return pipePath(this.pid, 'cmd') }

  attach (pid) {
    if (!pid) return
    if (this.pid === Number(pid) && this.connected) return
    this.detach()
    this.pid = Number(pid)
    this.buf = Buffer.alloc(0)
    this._openBoth()
  }

  /** 活着的 socket 数量（重连时不应增长，单测用） */
  socketCount () { return this._sockets.size }

  _track (sock) {
    this._sockets.add(sock)
    return sock
  }

  _drop (sock) {
    if (!sock) return
    this._sockets.delete(sock)
    try { sock.removeAllListeners() } catch {}
    try { sock.destroy() } catch {}
  }

  _closeSockets () {
    this._drop(this.evt)
    this._drop(this.cmd)
    this.evt = null
    this.cmd = null
    this.evtUp = false
    this.cmdUp = false
    this._needDrain = false
    this._queue.length = 0
  }

  _openBoth () {
    if (!this.pid) return
    this._closeSockets()
    this._connectEvt()
  }

  _connectEvt () {
    if (!this.pid) return
    const sock = this._track(this._open(this.evtPath))
    this.evt = sock

    sock.on('connect', () => {
      this.evtUp = true
      this.emit('status', { connected: this.connected, phase: 'evt-connected', pid: this.pid })
      this._connectCmd()                 /* 成对重建 */
    })

    sock.on('data', (chunk) => this._onFrame(chunk))

    sock.on('error', (e) => {
      // ENOENT/ECONNREFUSED 属正常（还没注入完），不刷错误
      if (!/ENOENT|ECONNREFUSED|EPIPE/.test(e.message)) {
        this.emit('status', { connected: this.connected, phase: 'evt-error', error: e.message })
      }
    })

    sock.on('close', () => this._teardown('evt'))
  }

  _connectCmd () {
    if (!this.pid) return
    const sock = this._track(this._open(this.cmdPath))
    this.cmd = sock

    sock.on('connect', () => {
      this.cmdUp = true
      this.emit('status', { connected: this.connected, phase: this.connected ? 'ready' : 'cmd-connected', pid: this.pid })
    })
    sock.on('data', () => {})            /* cmd 是单向下行，回包走 evt */
    sock.on('drain', () => {
      this._needDrain = false
      this._flush()
    })
    sock.on('error', () => {})
    sock.on('close', () => this._teardown('cmd'))
  }

  /**
   * 任一条断开 ⇒ 两条一起清掉再成对重建。
   * 半连接（evt 在、cmd 没了）会让 send() 永远写不出去，比整条断更麻烦。
   */
  _teardown (which) {
    if (this._closing) return
    this._closing = true
    const pid = this.pid
    this._closeSockets()                 /* 触发另一条的 close，被 _closing 挡住 */
    this._closing = false
    this.emit('status', { connected: false, phase: which + '-closed', pid })
    this._scheduleReconnect()
  }

  _scheduleReconnect () {
    if (this._reconnectTimer || !this.pid) return
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null
      if (!this.connected && this.pid) {
        this.reconnects++
        this._openBoth()
      }
    }, this._reconnectMs)
  }

  _onFrame (chunk) {
    this.buf = Buffer.concat([this.buf, chunk])
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0)
      if (len > MAX_FRAME) {
        this.emit('status', { connected: this.connected, phase: 'bad-frame', len })
        this.buf = Buffer.alloc(0)
        return
      }
      if (this.buf.length < 4 + len) return
      const text = this.buf.subarray(4, 4 + len).toString('utf8')
      this.buf = this.buf.subarray(4 + len)
      this.frames++
      this.lastEventAt = Date.now()
      let obj = null
      try { obj = JSON.parse(text) } catch {}
      if (obj) this.emit('event', obj)
    }
  }

  /**
   * @returns {boolean} 是否已交给底层（false = 通道没连上）
   *
   * 背压策略：write() 返回 false 说明内核缓冲区满了，此时数据**已经**进了
   * Node 的写队列，所以不重发（重发会重复一条命令），只把后续命令排进
   * 有界队列，等 drain 再补发；队列满（MAX_QUEUE）丢最老的并累计告警。
   */
  send (obj) {
    const sock = this.cmd
    /* 连接态双校验：只判 connected 会在 socket 已 destroy 但标志还没翻的窗口里写进虚空 */
    if (!sock || !this.cmdUp || sock.destroyed || sock.writable === false) return false

    let text
    try { text = JSON.stringify(obj) } catch { return false }

    if (this._needDrain) {
      if (this._queue.length >= MAX_QUEUE) {
        this._queue.shift()
        this.dropped++
        this._warnBackpressure('queue-full')
      }
      this._queue.push(text)
      return true
    }

    try {
      if (sock.write(encodeCmd(text)) === false) {
        this._needDrain = true
        this._warnBackpressure('write-false')
      }
      return true
    } catch {
      return false
    }
  }

  _flush () {
    const sock = this.cmd
    while (this._queue.length) {
      if (!sock || sock.destroyed || sock.writable === false) return
      const text = this._queue.shift()
      try {
        if (sock.write(encodeCmd(text)) === false) {
          this._needDrain = true
          this._warnBackpressure('flush-false')
          return
        }
      } catch { return }
    }
  }

  _warnBackpressure (why) {
    this.backpressure++
    const now = Date.now()
    if (now - this.lastBackpressureAt < 1000) return      // 一秒内只报一次，避免刷屏
    this.lastBackpressureAt = now
    this.emit('status', {
      connected: this.connected,
      phase: 'backpressure',
      why,
      queued: this._queue.length,
      total: this.backpressure,
      dropped: this.dropped
    })
  }

  detach () {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null }
    this._closing = true
    try { this._closeSockets() } finally { this._closing = false }
    this.pid = 0
  }

  status () {
    return {
      pid: this.pid,
      connected: this.connected,
      evtUp: this.evtUp,
      cmdUp: this.cmdUp,
      frames: this.frames,
      lastEventAt: this.lastEventAt,
      backpressure: this.backpressure,
      dropped: this.dropped,
      reconnects: this.reconnects,
      queued: this._queue.length,
      sockets: this._sockets.size
    }
  }
}

export const bridge = new Bridge()
