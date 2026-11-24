import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { Bridge } from '../app/server/pipe.js'
import * as lab from '../app/server/lab.js'
import { execute, listCommands, matchTrigger, normalizeText, isPureText } from '../app/server/commands.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

let pass = 0
const fails = []
const results = []

function test (name, fn) {
  const p = Promise.resolve().then(fn)
  return p.then(
    () => { pass++; results.push(`PASS  ${name}`); },
    (e) => {
      const msg = e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : String(e)
      fails.push(`${name}\n      ${msg}`)
      results.push(`FAIL  ${name}  ← ${msg}`)
    }
  )
}

function assert (cond, msg) {
  if (!cond) throw new Error(msg || '断言失败')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* payload 加载器 */

function loadPayload (rel, sandbox) {
  const file = path.join(ROOT, rel)
  const src = fs.readFileSync(file, 'utf8')
  sandbox.__events = []
  sandbox.__fl_emit = (s) => { try { sandbox.__events.push(JSON.parse(s)) } catch {} }
  sandbox.setInterval = setInterval
  sandbox.clearInterval = clearInterval
  sandbox.setTimeout = setTimeout
  sandbox.clearTimeout = clearTimeout
  sandbox.console = console
  vm.runInNewContext(src, sandbox, { filename: rel })
  return sandbox
}

function evts (sb, name) { return sb.__events.filter((e) => e.evt === name) }

/* 假内核 */

/** 按 9.9.36 契约：sendMsg 必须 4 个参数，第 2 个必须是函数，返回 Promise */
/* vm 沙箱和宿主是不同 realm，instanceof Map 会失效，只能用形状判断 */
function isMapLike (v) {
  return !!v && typeof v === 'object' && typeof v.get === 'function' && typeof v.set === 'function'
}

function fakeMsgService (result) {
  const calls = []
  const recallCalls = []
  /* 会话里「当前还在」的消息：撤回校验靠它判断 id 是否存在、内容是否已删 */
  const store = { msgs: [] }
  return {
    calls,
    recallCalls,
    store,
    addKernelMsgListener (l) { this.listener = l },
    /* 内核真实形状：generateMsgUniqueId(chatType, serverTime) → 数字串 */
    generateMsgUniqueId (chatType, t) { return '7' + String(chatType) + String(t || 0).slice(-8) },
    /* 内核真实形状：getMsgsIncludeSelf(peer, msgId, count, includeSelf) → Promise<{msgList}> */
    getMsgsIncludeSelf () { return Promise.resolve({ msgList: store.msgs }) },
    /* 内核真实形状：recallMsg(peer, [msgId]) —— 恒回 result:0（不真删，见 ops.js 注释） */
    recallMsg (...args) { recallCalls.push(args); return Promise.resolve({ result: 0 }) },
    /* 内核真实形状：sendMsg('0', peer, msgElements, new Map()) */
    sendMsg (...args) {
      calls.push(args)
      if (args.length !== 4) {
        throw new Error(`assertion (argc == 4) failed: sendMsg needs 4 arguments`)
      }
      if (args[0] !== '0') throw new Error('arg1 必须是字符串 msgId 占位')
      if (!args[1] || typeof args[1] !== 'object') {
        throw new Error('Cannot convert undefined or null to object')
      }
      if (!Array.isArray(args[2])) throw new Error('arg3 必须是元素数组')
      if (!isMapLike(args[3])) throw new Error('arg4 必须是 Map')
      return Promise.resolve(result)
    }
  }
}

function fakeSession (ms) {
  return {
    getSessionId: () => 'nt_1',
    getMsgService: () => ms,
    getMSFService: () => ({ getServerTime: () => 1794998000000 }),
    getRecentContactService: () => ({ getRecentContactListSync: () => ({ sortedContactList: [] }) })
  }
}


/* #fl 只剩状态卡 */

async function commandSuite () {
  await test('S1 裸 #fl 回四行状态卡', async () => {
    const r = await execute('#fl', { source: 'qq', uin: '1' })
    const rows = String(r.text).split(/\r?\n/)
    assert(rows.length === 4, '不是四行：' + r.text)
    assert(rows[0] === 'FrishLuna 状态', '首行不对：' + rows[0])
    assert(/^版本: /.test(rows[1]), '第二行不是版本：' + rows[1])
    assert(/^平台: /.test(rows[2]), '第三行不是平台：' + rows[2])
    assert(/^运行时长: /.test(rows[3]), '第四行不是运行时长：' + rows[3])
  })

  await test('S2 带参数一律静默忽略：#fl status/info/eval/say/help/reload 不回卡也不回提示', async () => {
    for (const raw of ['#fl info', '#fl eval 1+1', '#fl say 123456789 hi', '#fl help', '#fl reload', '#fl status']) {
      const r = await execute(raw)
      assert(r.ok === false, raw + ' 仍被当成有效触发')
      assert(String(r.text) === '', raw + ' 不该回任何文本，实际：' + r.text)
      assert(matchTrigger(raw, '#fl') === false, raw + ' 仍命中触发判定')
    }
  })

  await test('S3 命令表为空（不再暴露任何子命令）', async () => {
    const list = listCommands()
    assert(Array.isArray(list) && list.length === 0, '仍暴露子命令：' + JSON.stringify(list))
  })

  await test('S4 commands.js 里没有命令注册与管理员闸门', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'app/server/commands.js'), 'utf8')
    assert(!/def\s*\(/.test(src), '还留着 def() 命令注册')
    assert(!/ctx\.source === 'qq'/.test(src), '还留着 QQ 侧权限分支')
  })

  await test('S5 触发判定=全等：裸 #fl 命中，带参数与紧贴字符都不命中', async () => {
    assert(matchTrigger('#fl', '#fl') === true, '裸 #fl 没命中')
    assert(matchTrigger('  #fl  ', '#fl') === true, '带空格没命中')
    assert(matchTrigger('#fl status', '#fl') === false, '#fl status 仍命中')
    assert(matchTrigger('#fl info', '#fl') === false, '#fl info 仍命中')
    assert(matchTrigger('#fl eval 1+1', '#fl') === false, '#fl eval 仍命中')
    assert(matchTrigger('#fl\t', '#fl') === true, '尾部制表符应被 trim 掉')
    assert(matchTrigger('#fl。', '#fl') === false, '尾部多余字符仍命中')
    assert(matchTrigger('@123456 #fl', '#fl') === false, '@ 过的 #fl 仍命中')
    assert(matchTrigger('#flush', '#fl') === false, '#flush 误命中')
    assert(matchTrigger('#flight', '#fl') === false, '#flight 误命中')
    assert(matchTrigger('看这个 #fl', '#fl') === false, '句中提到就误触发')
    assert(matchTrigger('', '#fl') === false, '空文本误命中')
  })

  await test('S5b 只有单段纯文本才算触发：混图片/引用/表情都不回', async () => {
    assert(isPureText([1]) === true, '纯文本被判成非文本')
    assert(isPureText([]) === true, '无类型信息应放行')
    assert(isPureText(undefined) === true, '无类型信息应放行')
    assert(isPureText([1, 2]) === false, '#fl + 图片 仍被判纯文本')
    assert(isPureText([2]) === false, '纯图片被判纯文本')
    assert(isPureText([7, 1]) === false, '引用 + 文本 仍被判纯文本')
    assert(isPureText([6, 1]) === false, '表情 + 文本 仍被判纯文本')
  })

  await test('S6 触发判定不接受发送者参数（结构上无法做白名单）', async () => {
    const fn = matchTrigger
    assert(fn.length === 2, '参数个数变了，可能混进了发送者：' + fn.length)
    const src = fs.readFileSync(path.join(ROOT, 'app/server/commands.js'), 'utf8')
    assert(!/admins/.test(src), 'commands.js 里还引用 admins')
  })

  await test('S7 带 @ 一律不触发：@机器人 #fl / @数字#fl / 多个 @ 都不算，只认单发', async () => {
    assert(matchTrigger('@1234567890 #fl', '#fl') === false, '@123456 #fl 仍命中')
    assert(matchTrigger('@1234567890#fl', '#fl') === false, '@123456#fl 仍命中')
    assert(matchTrigger('@1 @2 #fl', '#fl') === false, '多个 @ 仍命中')
    assert(matchTrigger('@昵称 #fl', '#fl') === false, '@昵称 #fl 仍命中')
    assert(matchTrigger('@1234567890 你好 #fl', '#fl') === false, '句中 #fl 仍命中')
    assert(matchTrigger('#fl', '#fl') === true, '单发 #fl 应命中')
  })

  await test('S8 全角 ＃ / 全角字母 也能触发', async () => {
    assert(matchTrigger('＃fl', '#fl') === true, '全角井号没命中')
    assert(matchTrigger('#ｆｌ', '#fl') === true, '全角字母没命中')
    assert(matchTrigger('＃ＦＬ', '#fl') === true, '全角大写没命中')
  })

  await test('S9 normalizeText 只做全角归一与 trim，绝不动 @', async () => {
    assert(normalizeText('@123456 #fl') === '@123456 #fl', '@ 被剥掉了：' + normalizeText('@123456 #fl'))
    assert(normalizeText('  ＃ＦＬ  ') === '#FL', '全角归一/trim 不对：' + normalizeText('  ＃ＦＬ  '))
  })
}

async function inboundSuite () {
  /* 1. 媒体消息不许整条丢弃 */
  await test('B3 图片消息：inbound 计数 +1，文本为 [图片]，rawTypes 带 2', async () => {
    const ms = fakeMsgService({ result: 0 })
    const sb = loadPayload('payload/inbound.js', { __fl_session: fakeSession(ms) })
    await sleep(700)
    assert(sb.__fl_inbound.ready, 'inbound 没挂上监听')
    ms.listener.onRecvMsg([{ chatType: 2, peerUid: '1000000001', senderUid: 'u_x', msgId: '1', msgElements: [{ elementType: 2, picElement: { fileName: 'a.png' } }] }])
    const m = evts(sb, 'msg').pop()
    assert(m, '没有 msg 事件')
    assert(m.text === '[图片]', '占位文本不对：' + JSON.stringify(m.text))
    assert(sb.__fl_inbound.count === 1, 'count 应为 1，实际 ' + sb.__fl_inbound.count)
    assert(Array.isArray(m.rawTypes) && m.rawTypes[0] === 2, 'rawTypes 缺 2：' + JSON.stringify(m.rawTypes))
  })

  /* 2. 字段名：msgElements 优先 */
  await test('B15 字段名：msgElements 存在时用它，shape.field=msgElements', async () => {
    const ms = fakeMsgService({ result: 0 })
    const sb = loadPayload('payload/inbound.js', { __fl_session: fakeSession(ms) })
    await sleep(700)
    ms.listener.onRecvMsg([{ chatType: 1, peerUid: '1000000002', senderUid: 'u_y', msgId: '2', msgElements: [{ elementType: 1, textElement: { content: 'hi' } }] }])
    const m = evts(sb, 'msg').pop()
    assert(m && m.text === 'hi', '文本解析失败：' + JSON.stringify(m))
    assert(sb.__fl_inbound.shape && sb.__fl_inbound.shape.field === 'msgElements', 'shape.field 应为 msgElements')
  })

  /* 3. 字段名：只有 elements 时兜底 */
  await test('B15 字段名：只有 elements 时兜底解析并记录实况', async () => {
    const ms = fakeMsgService({ result: 0 })
    const sb = loadPayload('payload/inbound.js', { __fl_session: fakeSession(ms) })
    await sleep(700)
    ms.listener.onRecvMsg([{ chatType: 2, peerUid: '1000000001', senderUid: 'u_z', msgId: '3', elements: [{ elementType: 1, textElement: { content: '兜底' } }] }])
    const m = evts(sb, 'msg').pop()
    assert(m && m.text === '兜底', 'elements 兜底失败：' + JSON.stringify(m))
    assert(sb.__fl_inbound.shape.field === 'elements', 'shape.field 应为 elements')
  })

  /* 4. 撤回 */
  await test('B4 撤回：(peer, msgList) 形态产出 msg-recall', async () => {
    const ms = fakeMsgService({ result: 0 })
    const sb = loadPayload('payload/inbound.js', { __fl_session: fakeSession(ms) })
    await sleep(700)
    ms.listener.onMsgDelete({ peerUid: '1000000001', chatType: 2 }, [{ msgId: '77', msgSeq: '9' }])
    const r = evts(sb, 'msg-recall').pop()
    assert(r, '没有 msg-recall 事件')
    assert(r.chat.type === 'group' && r.chat.id === '1000000001', 'chat 解析错：' + JSON.stringify(r.chat))
    assert(r.msgId === '77', 'msgId 解析错：' + r.msgId)
    assert(evts(sb, 'msg-delete-shape').length === 1, '没记录撤回回调形状')
  })

  /* 5. __fl_send 只转发 OPS.send */
  await test('B1 __fl_send 转发到 OPS.send，成功报 send-ok', async () => {
    const ms = fakeMsgService({ result: 0 })
    const sent = []
    const sb = loadPayload('payload/inbound.js', {
      __fl_session: fakeSession(ms),
      __fl_ops: { send: (a) => { sent.push(a); return Promise.resolve('已发送') } }
    })
    await sleep(700)
    await sb.__fl_send({ type: 'group', id: '1000000001' }, '测试')
    assert(sent.length === 1 && sent[0].type === 'group' && sent[0].id === '1000000001', '参数没转对：' + JSON.stringify(sent))
    assert(evts(sb, 'send-ok').length === 1, '没发 send-ok')
  })

  await test('B2 __fl_send 失败报 send-fail 并向上抛（不吞异常）', async () => {
    const ms = fakeMsgService({ result: 0 })
    const sb = loadPayload('payload/inbound.js', {
      __fl_session: fakeSession(ms),
      __fl_ops: { send: () => Promise.reject(Object.assign(new Error('发送失败 result=5 · 内核未接受'), { code: 5 })) }
    })
    await sleep(700)
    let threw = false
    try { await sb.__fl_send({ type: 'private', id: '1000000002' }, 'x') } catch { threw = true }
    assert(threw, '失败没往外抛')
    const f = evts(sb, 'send-fail').pop()
    assert(f && /result=5/.test(f.e), 'send-fail 没带原因：' + JSON.stringify(f))
  })

  /* 6. 超时上报 */
  await test('B9 等不到 session 时上报 inbound-timeout（不静默）', async () => {
    const sb = loadPayload('payload/inbound.js', {
      __fl_inbound_max_tries: 1,
      __fl_session: { getMsgService: () => null, getRecentContactService: () => ({ getRecentContactListSync: () => ({}) }) }
    })
    await sleep(1300)
    const t = evts(sb, 'inbound-timeout').pop()
    assert(t, '没有 inbound-timeout 事件')
    assert(t.tries >= 2, 'tries 不对：' + t.tries)
  })
}

async function opsSuite () {
  await test('B2 OPS.send result=0 才算成功', async () => {
    const ms = fakeMsgService({ result: 0 })
    const sb = loadPayload('payload/ops.js', { __fl_session: fakeSession(ms) })
    const r = await sb.__fl_ops.send({ type: 'group', id: '1000000001', text: '测试' })
    /* 回执形状是 {text, message_id}：text 是给人看的一句话，message_id 给面板
       配撤回用 —— 必须是「真的发出去的那个 id」，不是事后回读猜的 */
    const txt = (r && typeof r === 'object') ? r.text : r
    assert(/已发送到 群 1000000001/.test(txt), '返回值不对：' + JSON.stringify(r))
    assert(ms.calls.length === 1 && ms.calls[0].length === 4, 'sendMsg 不是 4 参：' + ms.calls[0].length)
    /* 参数位置必须固定：整包消息塞 arg1、回调塞 arg2 时内核只回 result=5 */
    const [a1, peer, els, attrs] = ms.calls[0]
    assert(a1 === '0', 'arg1 应该是字符串 "0"，实际：' + a1)
    assert(peer.chatType === 2 && peer.peerUid === '1000000001', 'peer 不对：' + JSON.stringify(peer))
    assert(peer.guildId && peer.guildId !== '', 'peer.guildId 没填消息唯一 ID')
    /* message_id 必须为 null：内核生成的 guildId 不是消息 msgId（会话里查无此 id），
       回读最后一条又有缓存延迟会拿到上一条 —— 两条路都不可信，宁可说没有 */
    assert(r.message_id === null, '不该回一个不可信的 message_id：' + JSON.stringify(r.message_id))
    assert(Array.isArray(els) && els[0].textElement.content === '测试', '元素数组不对：' + JSON.stringify(els))
    assert(isMapLike(attrs), 'arg4 不是 Map')
  })

  await test('B2b 生成不出唯一 ID 时照样能发，仍然不回 message_id', async () => {
    const ms = fakeMsgService({ result: 0 })
    ms.generateMsgUniqueId = () => { throw new Error('no msf') }
    const sb = loadPayload('payload/ops.js', { __fl_session: fakeSession(ms) })
    const r = await sb.__fl_ops.send({ type: 'group', id: '1000000001', text: '测试' })
    assert(r && typeof r === 'object' && r.message_id === null,
      '生成失败还回了 id，会被拿去撤错东西：' + JSON.stringify(r))
  })

  await test('B2c 撤回：读不到会话历史时按「无法确认」报，不能说已撤回', async () => {
    const ms = fakeMsgService({ result: 0 })
    const sb = loadPayload('payload/ops.js', { __fl_session: fakeSession(ms) })
    ms.store.msgs = []          /* 空 = 历史接口是空壳，不是「已删除」 */
    let err = ''
    try {
      await sb.__fl_ops.recall({ type: 'group', id: '1000000001', msgId: '7abc' })
    } catch (e) { err = String(e.message || e) }
    assert(/读不到/.test(err), '应该报读不到会话，实际：' + err)
    assert(ms.recallCalls.length === 0, '看不见就别乱撤，不该调 recallMsg')
  })

  await test('B2c2 撤回：历史看得见但没有这个 id，报找不到', async () => {
    const ms = fakeMsgService({ result: 0 })
    const sb = loadPayload('payload/ops.js', { __fl_session: fakeSession(ms) })
    ms.store.msgs = [{ msgId: '7other', elements: [{ elementType: 1, textElement: { content: '别的消息' } }] }]
    let err = ''
    try {
      await sb.__fl_ops.recall({ type: 'group', id: '1000000001', msgId: '7abc' })
    } catch (e) { err = String(e.message || e) }
    assert(/找不到/.test(err), '应该报找不到，实际：' + err)
    assert(ms.recallCalls.length === 0, '不该真的去撤一个不存在的 id')
  })

  await test('B2d 撤回：内核回 result=0 但消息还在，必须报没生效', async () => {
    const ms = fakeMsgService({ result: 0 })
    const sb = loadPayload('payload/ops.js', { __fl_session: fakeSession(ms) })
    /* 正文里带「撤回」二字也得算「还在」：按「含撤回」判提示语会把
       测试消息「FL 撤回测试」误判成已删 → 变成假回执 */
    ms.store.msgs = [{ msgId: '7abc', elements: [{ elementType: 1, textElement: { content: 'FL 撤回测试' } }] }]
    let err = ''
    try {
      await sb.__fl_ops.recall({ type: 'group', id: '1000000001', msgId: '7abc' })
    } catch (e) { err = String(e.message || e) }
    assert(/没生效/.test(err), '应该报没生效，实际：' + err)
    assert(ms.recallCalls.length === 1, '应该真的调过一次 recallMsg')
  })

  await test('B2e 撤回：消息真被删掉了才回「已撤回」', async () => {
    const ms = fakeMsgService({ result: 0 })
    const sb = loadPayload('payload/ops.js', { __fl_session: fakeSession(ms) })
    ms.store.msgs = [
      { msgId: '7abc', elements: [{ elementType: 1, textElement: { content: '测试' } }] },
      { msgId: '7zzz', elements: [{ elementType: 1, textElement: { content: '别人的消息' } }] }
    ]
    /* 第一次回读还在（前置校验通过），撤完再回读只剩别人那条（不是空历史） */
    let n = 0
    ms.getMsgsIncludeSelf = () => Promise.resolve({
      msgList: n++ === 0 ? ms.store.msgs : [ms.store.msgs[1]]
    })
    const r = await sb.__fl_ops.recall({ type: 'group', id: '1000000001', msgId: '7abc' })
    assert(/已撤回/.test(String(r)), '应该回已撤回，实际：' + r)
  })

  await test('B2 OPS.send result=5 报「内核未接受」并失败', async () => {
    const ms = fakeMsgService({ result: 5, errMsg: 'session not ready' })
    const sb = loadPayload('payload/ops.js', { __fl_session: fakeSession(ms) })
    let err = null
    try { await sb.__fl_ops.send({ type: 'group', id: '1000000001', text: 'x' }) } catch (e) { err = e }
    assert(err, 'result=5 竟然当成功')
    assert(/result=5/.test(err.message) && /内核未接受/.test(err.message), '错误文案不对：' + err.message)
    assert(err.code === 5, 'code 没带出来')
  })

  await test('B2 OPS.send 其它 result 码原样回传', async () => {
    const ms = fakeMsgService({ result: 42, errMsg: 'boom' })
    const sb = loadPayload('payload/ops.js', { __fl_session: fakeSession(ms) })
    let err = null
    try { await sb.__fl_ops.send({ type: 'private', id: '1000000002', text: 'x' }) } catch (e) { err = e }
    assert(err && /result=42/.test(err.message), '错误文案不对：' + (err && err.message))
  })

  await test('B16 对象字段不再变成 [object Object]', async () => {
    const ms = fakeMsgService({ result: 0 })
    const sb = loadPayload('payload/ops.js', {
      __fl_session: {
        getRecentContactService: () => ({
          getRecentContactListSync: () => ({
            sortedContactList: [{ peerUid: 'u_1', remark: { a: 1, b: 'x' } }]
          })
        }),
        getMsgService: () => ms
      }
    })
    const txt = await sb.__fl_ops.recentList({})
    assert(!/\[object Object\]/.test(txt), '仍然出现 [object Object]：' + txt)
    assert(/a\\?"\s*:\s*1/.test(txt), '对象没被 JSON 化：' + txt)
  })
}

class FakeSock extends EventEmitter {
  constructor (p, hub) {
    super()
    this.path = p
    this.hub = hub
    this.destroyed = false
    this.writable = true
    this.writeOk = true
    this.written = []
    hub.created.push(this)
    setImmediate(() => { if (!this.destroyed) this.emit('connect') })
  }

  write (t) {
    if (this.destroyed) throw new Error('write after destroy')
    this.written.push(t)
    return this.writeOk
  }

  destroy () {
    this.destroyed = true
    this.writable = false
    /* 真 socket 的 destroy 会异步补一个 close；这里已经 removeAllListeners，不再回调 */
  }
}

function fakeHub () { return { created: [] } }

async function pipeSuite () {
  await test('B7 两条管道都连上才算 connected', async () => {
    const hub = fakeHub()
    const b = new Bridge({ connect: (p) => new FakeSock(p, hub), reconnectMs: 20 })
    b.attach(1234)
    await sleep(30)
    assert(b.status().evtUp && b.status().cmdUp, 'evt/cmd 没都连上：' + JSON.stringify(b.status()))
    assert(b.connected === true, 'connected 应为 true')
    b.detach()
  })

  await test('B7 cmd 断开也会触发成对重连', async () => {
    const hub = fakeHub()
    const b = new Bridge({ connect: (p) => new FakeSock(p, hub), reconnectMs: 20 })
    b.attach(1234)
    await sleep(30)
    const cmdSock = b.cmd
    const before = hub.created.length
    cmdSock.emit('close')                       // 模拟 cmd 侧断开
    assert(b.connected === false, 'cmd 断了 connected 还是 true')
    await sleep(80)
    assert(b.connected === true, '没有重连回来')
    assert(hub.created.length > before, '没有新建 socket')
    b.detach()
  })

  await test('B8 重连 3 次后 socket 数量不增长、旧 socket 已销毁', async () => {
    const hub = fakeHub()
    const b = new Bridge({ connect: (p) => new FakeSock(p, hub), reconnectMs: 10 })
    b.attach(1234)
    await sleep(30)
    for (let i = 0; i < 3; i++) {
      b.evt.emit('close')
      await sleep(40)
      assert(b.connected, `第 ${i + 1} 次重连后没连上`)
      assert(b.socketCount() === 2, `第 ${i + 1} 次重连后活 socket 应为 2，实际 ${b.socketCount()}`)
    }
    const alive = hub.created.filter((s) => !s.destroyed)
    assert(alive.length === 2, `历史 socket 没销毁：还活着 ${alive.length} 个`)
    b.detach()
  })

  await test('B6 write 返回 false 时记背压并排队，drain 后补发', async () => {
    const hub = fakeHub()
    const b = new Bridge({ connect: (p) => new FakeSock(p, hub), reconnectMs: 20 })
    const phases = []
    b.on('status', (s) => phases.push(s.phase))
    b.attach(1234)
    await sleep(30)

    b.cmd.writeOk = false
    assert(b.send({ a: 1 }) === true, '第一次 send 应已交给底层')
    assert(b.backpressure === 1, '没记背压：' + b.backpressure)
    assert(phases.includes('backpressure'), '没发背压状态')

    assert(b.send({ a: 2 }) === true, '背压期间的 send 应进队列')
    assert(b.status().queued === 1, '队列长度不对：' + b.status().queued)

    b.cmd.writeOk = true
    b.cmd.emit('drain')
    assert(b.status().queued === 0, 'drain 后队列没清空：' + b.status().queued)
    assert(b.cmd.written.length === 2, 'drain 后没补发：' + b.cmd.written.length)
    b.detach()
  })

  await test('B6 socket 已 destroy 时 send 直接返回 false', async () => {
    const hub = fakeHub()
    const b = new Bridge({ connect: (p) => new FakeSock(p, hub), reconnectMs: 20 })
    b.attach(1234)
    await sleep(30)
    b.cmd.destroyed = true
    assert(b.send({ a: 1 }) === false, 'destroyed 还能写')
    b.detach()
  })
}

async function labSuite () {
  await test('B11 type 非法（grop）明确报错', async () => {
    const r = await lab.send({ type: 'grop', id: '1000000001', text: 'x' })
    assert(r.ok === false && /group 或 private/.test(r.msg), JSON.stringify(r))
  })

  await test('B11 type 非法时一个 action 都不发', async () => {
    const calls = []
    lab._setCall((a, p) => { calls.push(a); return Promise.resolve({}) })
    await lab.send({ type: 'grop', id: '1000000001', text: 'x' })
    lab._setCall(null)
    assert(calls.length === 0, '居然调用了 ' + calls.join(','))
  })

  await test('B12 编号统一 5~12 位数字（1e5 / abc 都拒绝）', async () => {
    for (const bad of ['1e5', 'abc', '123', '1234567890123', '', null]) {
      const r = await lab.send({ type: 'group', id: bad, text: 'x' })
      assert(r.ok === false, `id=${JSON.stringify(bad)} 竟然通过`)
    }
    const calls = []
    lab._setCall((a, p) => { calls.push(p); return Promise.resolve({}) })
    const good = await lab.send({ type: 'group', id: '1000000001', text: 'x' })
    lab._setCall(null)
    assert(good.ok === true, '合法群号被拒：' + JSON.stringify(good))
    assert(calls[0].group_id === 1000000001, '群号没转数字：' + JSON.stringify(calls[0]))
  })

  await test('B10 services 三项全失败返回 ok:false 并逐项给原因', async () => {
    lab._setCall(() => Promise.reject(new Error('连接被拒绝')))
    const r = await lab.services()
    lab._setCall(null)
    assert(r.ok === false, '全失败还报成功：' + JSON.stringify(r))
    for (const k of ['status', 'version', 'login']) {
      assert(r.data[k] && r.data[k].failed, `${k} 没标 failed`)
    }
    assert(/连接被拒绝/.test(r.msg), '原因没带出来：' + r.msg)
  })

  await test('B10 services 部分失败 ok:true 但失败项标注', async () => {
    let n = 0
    lab._setCall(() => (++n === 1 ? Promise.resolve({ online: true }) : Promise.reject(new Error('超时'))))
    const r = await lab.services()
    lab._setCall(null)
    assert(r.ok === true, '部分失败不该整条失败')
    assert(r.data.status && r.data.status.online === true, '成功项丢了')
    assert(r.data.version.failed && r.data.login.failed, '失败项没标 failed')
  })

  await test('B13 查询缓存有上限（100 个不同群号后 ≤ 64）', async () => {
    lab._setCall(() => Promise.resolve([{ group_id: 1 }]))
    for (let i = 0; i < 100; i++) await lab.groupMembers({ id: String(1000000000 + i) })
    const size = lab.cacheSize()
    lab._setCall(null)
    assert(size <= lab.CACHE_MAX, `缓存没上限：${size} > ${lab.CACHE_MAX}`)
  })

  await test('B14 群公告：标准 action 不存在时回退扩展并标注', async () => {
    const tried = []
    lab._setCall((a) => {
      tried.push(a)
      if (a === 'send_group_notice') return Promise.reject(new Error('action not found'))
      return Promise.resolve({})
    })
    const r = await lab.groupAnnounce({ id: '1000000001', text: '公告' })
    lab._setCall(null)
    assert(r.ok === true, '回退失败：' + JSON.stringify(r))
    assert(r.data.action === '_send_group_notice' && r.data.extension === true, '没标注扩展：' + JSON.stringify(r.data))
    assert(/私有扩展/.test(r.msg), '文案没标扩展：' + r.msg)
    assert(tried.length === 2, '尝试次数不对：' + tried.join(','))
  })
}

async function staticSuite () {
  await test('B5 落盘日志里没有完整令牌', async () => {
    const f = path.join(ROOT, 'app/data/panel.log')
    if (!fs.existsSync(f)) return
    const raw = fs.readFileSync(f, 'utf8')
    const hit = raw.match(/fl_[0-9a-f]{16,}/g) || []
    assert(hit.length === 0, `panel.log 里还有 ${hit.length} 处完整令牌`)
  })

  await test('B16 ops.js 里没有硬编码 DEBUG 开关', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'payload/ops.js'), 'utf8')
    assert(!/var DEBUG\s*=/.test(src), '还留着 var DEBUG')
    assert(/__fl_debug/.test(src), '没有外部开关')
  })

  await test('B1 发送实现只有一份（inbound 不再自带候选变体）', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'payload/inbound.js'), 'utf8')
    assert(!/sendMsg\s*\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'inbound 里还在直接调 sendMsg')
    assert(/__fl_ops/.test(src), 'inbound 没转发到 OPS')
  })
}

/* OIDB 0xED3 编码器（poke 真通道） */

async function oidbSuite () {
  const sb = loadPayload('payload/ops.js', {})
  const O = sb.__fl_oidb

  await test('B20 OIDB 编码器已暴露给探测脚本', () => {
    assert(O && typeof O.envelope === 'function' && typeof O.pokeBody === 'function', 'payload 没有暴露 __fl_oidb')
  })

  await test('B21 群戳信封 = 本机真包（19 字节逐字节一致）', () => {
    const b = O.envelope(0xED3, 1, O.pokeBody({ isGroup: true, targetUin: 2147483653, peerUin: 2147483653 }), 0)
    const want = '08 D3 1D 10 01 22 0C 08 85 80 80 80 08 10 85 80 80 80 08'
    assert(O.hex(b) === want, '实际 ' + O.hex(b))
    assert(b.length === 19, '长度 ' + b.length)
  })

  await test('B22 好友戳信封 = 13 字节，好友 uin 走 field 5（tag 0x28）', () => {
    const b = O.envelope(0xED3, 1, O.pokeBody({ isGroup: false, targetUin: 10000, peerUin: 10000 }), 0)
    assert(O.hex(b) === '08 D3 1D 10 01 22 06 08 90 4E 28 90 4E', '实际 ' + O.hex(b))
  })

  await test('B23 群戳用 field 2（tag 0x10）而不是 field 5', () => {
    const g = O.pokeBody({ isGroup: true, targetUin: 123456, peerUin: 654321 })
    const f = O.pokeBody({ isGroup: false, targetUin: 123456, peerUin: 654321 })
    assert(g.indexOf(0x28) === -1, '群戳不该出现 0x28（field5）')
    assert(f.indexOf(0x10) === -1, '好友戳不该出现 0x10（field2）')
  })

  await test('B24 超过 2^31 的 QQ 号用 % 而非位运算编码（2147483653）', () => {
    const b = O.pokeBody({ isGroup: true, targetUin: 2147483653, peerUin: 2147483651 })
    assert(O.hex(b) === '08 85 80 80 80 08 10 83 80 80 80 08', '实际 ' + O.hex(b))
  })

  await test('B25 reserved=1 才追加 60 01（默认不写，长度才对得上真包）', () => {
    const body = O.pokeBody({ isGroup: true, targetUin: 1, peerUin: 1 })
    const a = O.envelope(0xED3, 1, body, 0)
    const b = O.envelope(0xED3, 1, body, 1)
    assert(b.length === a.length + 2, 'reserved=1 应多 2 字节')
    assert(O.hex(b).endsWith('60 01'), 'reserved=1 应是 60 01 结尾')
  })
}


const t0 = Date.now()
await inboundSuite()
await opsSuite()
await pipeSuite()
await labSuite()
await staticSuite()
await oidbSuite()
await commandSuite()

console.log('\n' + results.join('\n'))
console.log(`\n${'-'.repeat(52)}`)
console.log(`通过 ${pass} · 失败 ${fails.length} · 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
if (fails.length) {
  console.log('\n失败明细：')
  fails.forEach((f) => console.log('  • ' + f))
  process.exit(1)
}
