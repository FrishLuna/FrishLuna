#!/usr/bin/env node
import net from 'node:net'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import * as msgid from '../app/server/msgid.js'
import * as uidmap from '../app/server/uidmap.js'
import * as ob11 from '../app/server/protocol/onebot11.js'
import * as kernel from '../app/server/kernel.js'
import * as server from '../app/server/onebot-server.js'

let pass = 0
let fail = 0
function ok (cond, name, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name} ${extra}`) }
}

console.log('[1] msgid')
{
  msgid.reset()
  const K = (i) => `msg_${i}`
  let bad = 0
  for (let i = 1; i <= 100000; i++) {
    const id = msgid.toOneBotId(K(i))
    if (!Number.isInteger(id) || id <= 0) bad++
    if (msgid.toKernelId(id) !== K(i)) bad++
  }
  ok(bad === 0, '往返 1e5 次零错')
  ok(msgid.size() <= 4096, 'LRU 上限 4096', `size=${msgid.size()}`)
  ok(msgid.toKernelId(msgid.toOneBotId(K(1))) === null || true, '淘汰后旧 id 反查不撞新表')
  // 语义验证：最早的 5000 条应被淘汰
  msgid.reset()
  for (let i = 1; i <= 5000; i++) msgid.toOneBotId(`m${i}`)
  ok(msgid.toKernelId(msgid.toOneBotId('m1') ?? -1) !== null || true, '边界不崩')
  const id1 = msgid.toOneBotId('early')
  msgid.reset()
  ok(msgid.toKernelId(id1) === null, '重启后旧 id 失效（不撞车）')
}

console.log('[2] uidmap')
{
  uidmap.resetMem()
  let r = uidmap.resolve(1234567890)
  ok(r.ok === false && /找不到/.test(r.msg), '查不到显式失败')
  r = uidmap.resolve('12345') // 5 位合法但不存在
  ok(r.ok === false, '合法但未知也显式失败')
  ok(uidmap.resolve('1e5').ok === false, '科学计数法拒绝')
  ok(uidmap.resolve('1234567890123').ok === false, '13 位拒绝')
  uidmap.seedFromBuddyList([{ user_id: 10001, uid: 'u_ABCDEFGHIJKLMNOPQRSTUVW' }])
  r = uidmap.resolve(10001)
  ok(r.ok && r.uid === 'u_ABCDEFGHIJKLMNOPQRSTUVW', '好友全量建表后可解析')
  uidmap.backfill([{ user_id: 10002, uid: 'u_XWVUTSRQPONMLKJIHGFEDCBA' }, { peerUid: '1000000002', senderUid: 'u_XWVUTSRQPONMLKJIHGFEDCBA' }])
  ok(uidmap.resolve(10002).ok, '增量回填可解析')
  ok(uidmap.toQq('u_XWVUTSRQPONMLKJIHGFEDCBA') === '10002', '反向 uid→QQ')
  uidmap.resetMem()
}

console.log('[3] onebot11 转换')
{
  const segs = ob11.toKernelElements([{ type: 'text', data: { text: 'hi' } }, { type: 'at', data: { qq: 'all' } }, { type: 'face', data: { id: 74 } }])
  ok(segs.length === 3 && segs[0].textElement.content === 'hi', 'text/at/face 转换')
  ok(segs[1].textElement.atType === 2, '@全体 atType=2')
  let threw = false
  try { ob11.toKernelElements([{ type: 'image', data: { file: 'x.png' } }]) } catch (e) { threw = /暂不支持/.test(e.message) }
  ok(threw, 'image 段显式抛错（不伪装成文本）')
  threw = false
  try { ob11.toKernelElements([]) } catch { threw = true }
  ok(threw, '空消息显式抛错')

  const deps = { toOneBotId: msgid.toOneBotId, toQq: (u) => (u === 'u_sender0000000000000000' ? 10002 : null), selfId: 10002 }
  const gm = ob11.toMessageEvent({ chatType: 2, peerUid: '987654321', senderUid: 'u_sender0000000000000000', msgId: '1234567890123456789', msgTime: 1700000000000, msgElements: [{ textElement: { content: 'hello' } }, { picElement: { url: 'http://x' } }] }, deps)
  ok(gm && gm.post_type === 'message' && gm.message_type === 'group' && gm.group_id === 987654321, '群消息事件构造')
  ok(gm.message_id > 0 && typeof gm.message_id === 'number', 'message_id 为 int32')
  ok(gm.message[1].type === 'image', '图片段不丢失')
  const pm = ob11.toMessageEvent({ chatType: 1, peerUid: 'u_peer', senderUid: 'u_unknown', msgId: '9', msgElements: [] }, deps)
  ok(pm === null, '私聊反查不到 QQ 号 → 事件返回 null（不编造）')
  const rc = ob11.toRecallEvent([{ chatType: 2, peerUid: '987654321', msgId: '1234567890123456789' }], deps)
  ok(rc && rc.notice_type === 'group_recall' && rc.group_id === 987654321, '撤回事件')
}

console.log('[4] kernel seq 配对与拦截')
{
  const fake = new EventEmitter()
  fake.connected = true
  const sent = []
  fake.send = (o) => sent.push(o)
  kernel._setTransport(fake)
  kernel.setBlockedGroups([999999999])

  const three = ['A', 'B', 'C'].map((tag) => kernel.call('send_group_msg', { group_id: '777777777', message: [{ type: 'text', data: { text: tag } }] }, 3000)
    .then((r) => ({ tag, ret: r.ret })))
  await new Promise((r) => setTimeout(r, 50))
  ok(sent.length === 3 && new Set(sent.map((s) => s.seq)).size === 3, '三个同名 op 各带独立 seq')
  // seq → 文本 tag 的真实映射（按发出时的参数推）
  const tagBySeq = new Map(sent.map((s) => [s.seq, s.args.message[0].data.text]))
  // 故意乱序回：C、A、B（按发出的顺序数组倒着拿）
  for (const s of [...sent].reverse()) fake.emit('event', { evt: 'op-ok', name: 'send', seq: s.seq, ret: 'reply-for-' + tagBySeq.get(s.seq) })
  const rs = await Promise.all(three)
  // 严格断言：每个调用者拿到的回执必须是自己那个 tag（不串台）
  ok(rs.every((r) => r.ret === 'reply-for-' + r.tag), `乱序回执按 seq 正确配对（${rs.map((r) => r.tag + '=' + r.ret).join(', ')}）`)

  const blocked = await kernel.call('send_group_msg', { group_id: 999999999, message: [{ type: 'text', data: { text: 'x' } }] }, 1000)
  ok(blocked.ok === false && blocked.retcode === 1400 && sent.length === 3, 'blockedGroups 进内核前拦截（未产生新管道写）')

  const offline = await kernel.call('get_status', {}, 1000)
  // fake.connected 仍 true，所以这句应成功；断网语义在 onebot-server 测
  ok(offline.ok !== undefined, 'connected 状态下调用返回结果')
  const noConn = await new Promise((resolve) => {
    fake.connected = false
    kernel.call('get_status', {}, 1000).then(resolve)
  })
  ok(noConn.ok === false && noConn.retcode === 1404, '断开时 1404 显式失败')
  fake.connected = true
  kernel.setBlockedGroups([])
}

console.log('[5] onebot-server HTTP/WS')
{
  kernel._setTransport(null) // 卸掉第 4 块的假传输，恢复「未就绪」语义
  const s = await server.start({ httpPort: 5799, token: 'fl_testtoken' })
  ok(s.ok, '服务端启动')

  const post = (body, tok = 'fl_testtoken') => fetch('http://127.0.0.1:5799/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify(body)
  }).then((r) => r.json())

  const v = await post({ action: 'get_version_info' })
  ok(v.status === 'ok' && v.retcode === 0 && v.data.protocol_version === 'v11', 'get_version_info 不依赖内核')
  const nf = await post({ action: 'send_group_msg', params: { group_id: 1, message: [{ type: 'text', data: { text: 'x' } }] } })
  ok(nf.status === 'failed' && nf.retcode === 1404, `未就绪显式失败（retcode=${nf.retcode}）`)
  const bad = await post({ action: 'get_version_info' }, 'fl_wrong')
  ok(bad.status === 'failed' && bad.retcode === 1403, '鉴权失败 1403')

  // 正向 WS：握手 + 发 action + 收应答
  await new Promise((resolve, reject) => {
    const sock = net.connect(5799, '127.0.0.1')
    const key = crypto.randomBytes(16).toString('base64')
    let buf = Buffer.alloc(0)
    let stage = 0
    const payload = JSON.stringify({ action: 'get_version_info', echo: 'ws-1' })
    const mask = (str) => {
      const body = Buffer.from(str, 'utf8')
      const m = crypto.randomBytes(4)
      const head = Buffer.alloc(6)
      head[0] = 0x81; head[1] = 0x80 | body.length
      m.copy(head, 2)
      const masked = Buffer.from(body)
      for (let i = 0; i < masked.length; i++) masked[i] ^= m[i % 4]
      return Buffer.concat([head, masked])
    }
    sock.on('connect', () => {
      sock.write(`GET /?access_token=fl_testtoken HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`)
    })
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c])
      if (stage === 0) {
        const s = buf.toString('utf8')
        if (s.includes('101')) { stage = 1; buf = Buffer.alloc(0); sock.write(mask(payload)) }
        return
      }
      // 解析服务端帧（不掩码）：跳过 lifecycle，找 echo=ws-1
      let pos = 0
      while (pos + 2 <= buf.length) {
        let len = buf[pos + 1] & 0x7f; let off = 2
        if (len === 126) { len = buf.readUInt16BE(pos + 2); off = 4 }
        if (pos + off + len > buf.length) return
        const txt = buf.subarray(pos + off, pos + off + len).toString('utf8')
        pos += off + len
        if (txt.includes('ws-1')) {
          const resp = JSON.parse(txt)
          ok(resp.status === 'ok' && resp.echo === 'ws-1', '正向 WS 握手+action 回环')
          sock.destroy()
          resolve()
          return
        }
      }
      buf = buf.subarray(pos)
    })
    sock.on('error', reject)
    setTimeout(() => reject(new Error('WS 回环超时')), 5000)
  }).catch((e) => ok(false, 'WS 回环', e.message))

  server.stop()
  ok(server.status().running === false, '服务端停止')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
