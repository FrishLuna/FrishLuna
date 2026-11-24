import net from 'node:net'
import { Bridge } from '../app/server/pipe.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PID_A = 990001
const PID_B = 990002

let pass = 0
const fails = []

async function test (name, fn) {
  try { await fn(); pass++; console.log('PASS  ' + name) } catch (e) {
    fails.push(name + ' ← ' + (e.message || e))
    console.log('FAIL  ' + name + '  ← ' + (e.message || e))
  }
}

function assert (c, m) { if (!c) throw new Error(m || '断言失败') }

/** 假 payload：两条管道，cmd 侧把收到的每行 JSON 计数 */
async function fakePayload (pid) {
  const got = []
  const socks = new Set()

  const cmdSrv = net.createServer((sock) => {
    socks.add(sock)
    let buf = ''
    sock.on('data', (c) => {
      buf += c.toString('utf8')
      /* cmd 通道是裸 JSON、无分隔符：连续写入会被内核合并成一个 chunk，
         这里按大括号配平切分出每条完整命令（等价于一个正确的读端） */
      let depth = 0
      let start = -1
      for (let i = 0; i < buf.length; i++) {
        const ch = buf[i]
        if (ch === '{') { if (depth === 0) start = i; depth++ } else if (ch === '}') {
          depth--
          if (depth === 0 && start >= 0) {
            try { got.push(JSON.parse(buf.slice(start, i + 1))) } catch {}
            buf = buf.slice(i + 1)
            i = -1
            start = -1
          }
        }
      }
    })
    sock.on('error', () => {})
    sock.on('close', () => socks.delete(sock))
  })
  const evtSrv = net.createServer((sock) => {
    socks.add(sock)
    sock.on('error', () => {})
    sock.on('close', () => socks.delete(sock))
    /* 推一帧：uint32 LE 长度 + JSON，验证收帧路径 */
    const body = Buffer.from(JSON.stringify({ evt: 'hb', n: 1 }), 'utf8')
    const head = Buffer.alloc(4)
    head.writeUInt32LE(body.length, 0)
    sock.write(Buffer.concat([head, body]))
  })

  await new Promise((res, rej) => {
    cmdSrv.listen(`\\\\.\\pipe\\frishluna.${pid}.cmd`, () => {
      evtSrv.listen(`\\\\.\\pipe\\frishluna.${pid}.evt`, res).on('error', rej)
    }).on('error', rej)
  })

  return {
    got,
    socks,
    killClients () { for (const s of socks) s.destroy() },
    async close () {
      for (const s of socks) s.destroy()
      await new Promise((r) => cmdSrv.close(r))
      await new Promise((r) => evtSrv.close(r))
    }
  }
}

async function waitFor (fn, ms = 4000, label = '条件') {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await sleep(30)
  }
  throw new Error(`等待${label}超时（${ms}ms）`)
}

const A = await fakePayload(PID_A)
const B = await fakePayload(PID_B)

try {
  const bridge = new Bridge()
  const phases = []
  let hbSeen = 0
  bridge.on('status', (s) => phases.push(s.phase))
  bridge.on('event', (e) => { if (e && e.evt === 'hb') hbSeen++ })

  await test('两条命名管道都连上才算 ready', async () => {
    bridge.attach(PID_A)
    await waitFor(() => bridge.connected, 4000, '连接')
    assert(phases.includes('ready'), '没发 ready 状态')
    assert(bridge.status().sockets === 2, '活 socket 不是 2：' + bridge.status().sockets)
    await waitFor(() => hbSeen >= 1, 2000, 'evt 帧')
  })

  await test('cmd 通道真实落地（一条命令原样到对端）', async () => {
    const ok = bridge.send({ cmd: 'ping', n: 7 })
    assert(ok, 'send 返回 false')
    await waitFor(() => A.got.some((o) => o.cmd === 'ping' && o.n === 7), 2000, '命令到达')
  })

  await test('连续 50 条不产生背压、不丢帧', async () => {
    const before = A.got.length
    for (let i = 0; i < 50; i++) assert(bridge.send({ cmd: 'ping', i }), '第 ' + i + ' 条没写进去')
    await waitFor(() => A.got.length >= before + 50, 3000, '50 条落地')
    assert(bridge.status().backpressure === 0, '出现背压：' + bridge.status().backpressure)
    assert(bridge.status().dropped === 0, '有丢弃：' + bridge.status().dropped)
  })

  await test('对端断开 3 次，每次都能自动重连且 socket 不增长', async () => {
    for (let i = 0; i < 3; i++) {
      A.killClients()
      await waitFor(() => !bridge.connected, 2000, '断开感知')
      await waitFor(() => bridge.connected, 5000, `第 ${i + 1} 次重连`)
      assert(bridge.status().sockets === 2, `第 ${i + 1} 次重连后 socket 数 = ${bridge.status().sockets}`)
    }
    assert(bridge.status().reconnects >= 3, '重连计数没涨：' + bridge.status().reconnects)
  })

  await test('QQ 换 pid：attach 新 pid 后走新管道，旧 socket 全销毁', async () => {
    const replaced = bridge.status().reconnects
    bridge.attach(PID_B)
    await waitFor(() => bridge.connected, 4000, '新 pid 连接')
    assert(bridge.status().pid === PID_B, 'pid 没切：' + bridge.status().pid)
    assert(bridge.status().sockets === 2, 'socket 数不是 2：' + bridge.status().sockets)
    const ok = bridge.send({ cmd: 'ping', via: 'newpid' })
    assert(ok, '新管道 send 失败')
    await waitFor(() => B.got.some((o) => o.via === 'newpid'), 2000, '新管道命令到达')
    assert(bridge.status().reconnects === replaced, 'attach 不该走重连计时器')
  })

  await test('detach 后归零，不留后台重连', async () => {
    bridge.detach()
    await sleep(200)
    assert(bridge.status().sockets === 0, 'socket 没清干净：' + bridge.status().sockets)
    assert(bridge.connected === false, 'detach 后还连着')
  })

  bridge.detach()
} finally {
  await A.close()
  await B.close()
}

console.log(`\n通过 ${pass} · 失败 ${fails.length}`)
if (fails.length) { fails.forEach((f) => console.log('  • ' + f)); process.exit(1) }
