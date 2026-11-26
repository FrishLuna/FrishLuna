import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import util from 'node:util'
import { spawn } from 'node:child_process'
import { load, save, WEB_DIR, CFG_FILE, ROOT, DATA_DIR } from './config.js'
import * as bus from './bus.js'
import * as qq from './qq.js'
import * as auth from './auth.js'
import * as obServer from './onebot-server.js'
import { rememberBuddy } from './request-approval.js'
import * as kernel from './kernel.js'
import * as marshal from './marshal.js'
import * as lab from './lab.js'
import * as human from './humanize.js'
import * as store from './store.js'
import { bridge, pool } from './accounts.js'
import { execute, matchTrigger, isPureText, VERSION } from './commands.js'
import * as uidmap from './uidmap.js'
import * as groups from './groups.js'
import { toWatchNotice } from './protocol/onebot11.js'

const STARTED_AT = Date.now()
const runtime = {
  env: null,
  hb: null,
  state: null,
  lastEval: null,
  lastOp: null,
  login: null,
  session: null,
  msf: null,
  account: null
}

/* 多账号：非当前账号的运行态事件（env/hb/state）不覆盖面板上的那一份，
   但消息事件、日志事件照常处理 —— 每个账号的消息都要能进 OneBot / 命令。 */
function fromCurrent (ev) {
  const cur = bridge.pid
  if (!cur || !ev || !ev.__pid) return true
  return Number(ev.__pid) === Number(cur)
}

/* 高频噪音事件不进库（心跳每秒都有，存了没价值；调试类的也有专门的日志流）。
   watch 的原始事件不存 —— 它每来一次成员信息推送就是一条，真正有价值的是
   归一化后派发出去的 notice:* / request:*，那些由 onWatchEvent 自己落库。 */
const NOISY_EVENTS = new Set([
  'hb', 'pong', 'state', 'cmd-queued', 'rt',
  'watch', 'watch-first', 'watch-ready', 'watch-load-err',
  'eval-ok', 'op-chunk', 'op-ok', 'op-err',
  'send-cb', 'send-called', 'send-ok', 'send-skip',
  'inbound-shape', 'inbound-probe', 'attached',
  'startup-hook', 'startup-hook-giveup', 'startup-hook-done'
])

bridge.on('event', (ev) => {
  const t = ev && ev.evt
  if (t && !NOISY_EVENTS.has(t)) {
    try { store.saveEvent(ev.__pid || 0, t, ev) } catch {}
  }
  switch (t) {
    case 'env':
      if (!fromCurrent(ev)) break
      runtime.env = ev
      bus.info('payload', '已连接 QQ，消息服务就绪')
      break
    case 'hb':
      if (!fromCurrent(ev)) break
      runtime.hb = { n: ev.n, up: ev.up, hits: ev.hits, at: Date.now() }
      break
    case 'rt': {
      const text = String(ev.m || '')
      const level = /FATAL|ERR|error|失败/i.test(text) ? 'error'
        : /READY|ok|成功|登录成功/i.test(text) ? 'ok'
          : 'info'
      bus.log(level, 'runtime', text.replace(/^\[[\d:.]+\]\s*/, ''))
      break
    }
    case 'state':
      if (!fromCurrent(ev)) break
      runtime.state = ev.data || ev
      break
    case 'client':
      bus.info('payload', '运行方式 QQ 客户端')
      break
    case 'attached':
      bus.info('payload', String(ev.note || 'QQ 客户端照常运行'))
      break
    case 'inbound-ready':
      bus.ok('inbound', '消息监听已就绪，发送 #fl 查看运行状态')
      break
    case 'inbound-err':
      bus.warn('inbound', String(ev.e))
      break
    case 'inbound-timeout':
      /* 等了 100 秒也没拿到 session：面板要看得见，不能留空白 */
      bus.error('inbound', `消息服务未就绪：已等待 ${Math.round(ev.tries / 2)} 秒，请检查 QQ 是否正常运行${ev.lastErr ? ' · ' + ev.lastErr : ''}`)
      break
    case 'inbound-shape':
      /* 首条真实消息的字段实况（msgElements 还是 elements），只报一次 */
      bus.info('inbound', `首条消息字段：${ev.field}（${(ev.keys || []).join(',')}）`)
      break
    case 'msg-delete-shape':
      bus.info('inbound', `撤回回调参数形状：${(ev.shape || []).join(' | ')}`)
      break
    case 'msg-recall': {
      const isGroup = ev.chat && ev.chat.type === 'group'
      const gid = isGroup ? String(ev.chat.id) : ''
      /* 对外形状对齐 OneBot 11 的 notice：群聊是 group_recall，私聊是 friend_recall */
      bus.broadcast('qqnotice', {
        post_type: 'notice',
        notice_type: isGroup ? 'group_recall' : 'friend_recall',
        group_id: gid ? Number(gid) : undefined,
        user_id: undefined,
        message_id: Number(ev.msgId) || ev.msgId,
        raw: ev,
        time: Math.floor((ev.at || Date.now()) / 1000)
      })
      bus.warn('qq', `撤回 ${isGroup ? '群 ' + gid : '私聊'} 消息 ${ev.msgId}`)
      break
    }
    case 'pong':
      bus.debug('payload', 'pong')
      break
    case 'cmd-queued':
      /* payload 的收货回执，每条命令都有，不进日志 */
      break
    case 'send-cb':
      bus.debug('send', `回调 ${ev.a} / ${ev.b}`)
      break
    case 'send-called':
      bus.debug('send', `已调用变体 ${ev.variant} -> ${ev.ret}`)
      break
    case 'send-ok':
      bus.ok('lab', '消息已发送')
      break
    case 'send-fail':
      bus.error('lab', `发送失败：${ev.e || '?'}`)
      break
    case 'send-skip':
      bus.warn('lab', `发送被跳过: ${ev.why || '?'}`)
      break
    case 'kop-ok':
    case 'kop-err':
      /* 1C 封送回执：只被 marshal.op 的 pending 表消费，不进面板日志（量大） */
      marshal.onEvent(ev)
      break
    case 'msg': {
      /* 内置协议端链路：payload 入站事件 → kernel → OneBot WS 广播。
         与面板命令链路是两个独立消费者，互不影响。 */
      /* 本体自己发出去的消息（payload 标 ev.self）只喂面板命令链路，
         不进 OneBot 广播 —— 下游协议端会把它当成「收到的消息」再回一次，直接成环。 */
      if (!ev.self) feedKernelFromPayload(ev)
      /* 面板命令链路：入站只有 payload 这一条来源，无条件处理 */
      onInbound(ev)
      break
    }
    case 'ops-ready':
      bus.ok('lab', `实验台功能表就绪（${ev.n} 项）`)
      break
    case 'self-info':
      /* 本号认主（payload 发过消息后从消息记录里学到的）：补 selfId + uidmap */
      if (ev.uin) {
        if (ev.__pid) pool.setIdentity(ev.__pid, ev.uin, ev.nick)
        if (fromCurrent(ev)) kernel.setSelfId(Number(ev.uin) || 0)
        if (ev.uid) uidmap.backfill([{ uin: ev.uin, uid: ev.uid }])
        bus.ok('qq', `已识别当前账号：${ev.uin}${ev.nick ? '（' + ev.nick + '）' : ''}`)
      }
      break
    case 'ops-load-err':
      bus.warn('lab', '实验台功能表加载失败: ' + ev.e)
      break
    case 'op-ok':
      /* 只接管 sendOp（下发即回）那份回执；kernel.call 的同步回执已经由
         /api/lab/invoke 自己 await，不能再记一次 —— 否则同一次调用会在
         日志流里出现两条，其中一条还是内核原始 JSON */
      if (pendingOp && pendingOp.name === String(ev.name)) {
        finishOp(String(ev.name), true, String(ev.ret || ''))
      }
      break
    case 'op-err':
      if (pendingOp && pendingOp.name === String(ev.name)) {
        finishOp(String(ev.name), false, String(ev.err || ''))
      }
      /* 非 sendOp 的回执：错误已经随 kernel.call 返回给调用方，由那边记账 */
      break
    case 'eval-ok': {
      const ret = String(ev.ret == null ? '' : ev.ret)
      // eval 兜底通道回来的 op 结果（两个前缀长度不同，用正则切）
      const m = /^(OPSUCCESS|OPFAIL)\|([\s\S]*)$/.exec(ret)
      if (pendingOp && m) {
        finishOp(pendingOp.name, m[1] === 'OPSUCCESS', m[2])
        break
      }
      runtime.lastEval = { at: Date.now(), ok: true, ret: ev.ret }
      bus.ok('eval', ret.slice(0, 400))
      break
    }
    case 'cmd-err': {
      const err = String(ev.err || '')
      if (pendingOp && /__fl_ops/.test(err)) {
        finishOp(pendingOp.name, false, err)
        break
      }
      runtime.lastEval = { at: Date.now(), ok: false, ret: ev.err }
      bus.error('eval', err)
      break
    }
    case 'cmd-bad':
      bus.error('eval', '命令解析失败: ' + ev.err)
      break
    case 'reload-ok':
      bus.ok('payload', '消息服务已重新连接')
      break
    case 'hook-installed':
      bus.info('payload', '消息服务已准备就绪')
      break
    case 'env-captured':
      bus.ok('payload', '已成功连接到 QQ')
      break

    case 'watch-ready': {
      const att = ev.attached || {}
      const okList = Object.keys(att).filter((k) => att[k] === 'ok')
      const bad = Object.keys(att).filter((k) => att[k] !== 'ok')
      bus.ok('watch', `服务监听已就绪（${okList.length} 项${bad.length ? '，失败 ' + bad.length : ''}）`)
      if (bad.length) bus.debug('watch', '未挂上的：' + bad.map((k) => k + '=' + att[k]).join(', '))
      break
    }
    case 'watch-first':
      /* 第一次见到某个内核回调名：记一条，方便后续补映射规则 */
      bus.debug('watch', `新回调 ${ev.name}（${ev.argc} 参）`)
      break
    case 'watch-err':
      bus.warn('watch', ev.e || '消息服务异常')
      break
    case 'watch':
      onWatchEvent(ev)
      break
    case 'watch-load-err':
      bus.warn('watch', '消息监听服务加载失败: ' + (ev.e || '?'))
      break
    default:
      if (t) bus.debug('payload', JSON.stringify(ev).slice(0, 600))
  }
  bus.broadcast('state', getState())
})

bridge.on('status', (s) => {
  if (s.phase === 'ready') bus.ok('pipe', '消息服务已连接')
  else if (s.phase === 'evt-closed') bus.warn('pipe', '消息服务已断开，正在重连…')
  else if (s.phase === 'cmd-closed') bus.warn('pipe', '消息服务已断开，正在重连…')
  else if (s.phase === 'evt-error') bus.warn('pipe', `消息服务异常：${s.error}`)
  else if (s.phase === 'backpressure') bus.warn('pipe', `发送排队中（积压 ${s.queued}${s.dropped ? '，已丢 ' + s.dropped : ''}）`)
  bus.broadcast('state', getState())
})

let pendingOp = null
const OP_TIMEOUT_MS = 3000

function finishOp (name, ok, ret) {
  if (pendingOp && pendingOp.name === name) {
    clearTimeout(pendingOp.timer)
    pendingOp = null
  }
  runtime.lastOp = { at: Date.now(), name, ok, ret: String(ret || '') }
  /* 日志给人看：结果按 humanize 压成一句，不再往控制台灌 JSON */
  const line = human.oneLine(name, ok ? { ok: true, ret } : { ok: false, error: ret })
  bus.log(ok ? 'ok' : 'error', 'lab', `${human.opLabel(name)} ${ok ? '成功' : '失败'}：${line}`)
  bus.broadcast('op', Object.assign({}, runtime.lastOp, { lines: human.fmtResult(name, ok ? { ret } : { error: ret }) }))
}

/**
 * 下发一个 op。新 payload 走 {cmd:'op'}；
 * 老 payload 的轮询闭包不认 op（reload 换不掉 setInterval）→ 3 秒无响应就改 eval 重发。
 */
function sendOp (name, args) {
  if (pendingOp) { try { clearTimeout(pendingOp.timer) } catch {} }
  pendingOp = { name, args, timer: null }
  const wrote = bridge.send({ cmd: 'op', name, args })
  pendingOp.timer = setTimeout(() => {
    if (!pendingOp || pendingOp.name !== name) return
    bus.warn('lab', `${name}: 未收到响应，正在使用备选服务重试`)
    const enc = encodeURIComponent(JSON.stringify(args || {}))
    const js = '(function(){try{var a=JSON.parse(decodeURIComponent(' + JSON.stringify(enc) + '));' +
      'var f=globalThis.__fl_ops&&globalThis.__fl_ops[' + JSON.stringify(name) + '];' +
      'if(typeof f!=="function")throw new Error("功能未注册或 ops.js 未加载");' +
      'return "OPSUCCESS|"+String(f(a))}catch(e){return "OPFAIL|"+(e&&e.message?e.message:e)}})()'
    bridge.send({ cmd: 'eval', js })
    pendingOp.timer = setTimeout(() => {
      if (!pendingOp || pendingOp.name !== name) return
      finishOp(name, false, '未收到 QQ 响应，请尝试重启 QQ 后重试')
    }, 4000)
  }, OP_TIMEOUT_MS)
  return wrote
}

/** 回话：群回群、私聊回私聊，走内核调用链（lab.send → kernel.call → payload ops.js），blockedGroups 也在里面拦 */
async function replyTo (ev, text) {
  const isGroup = ev.chat && ev.chat.type === 'group'
  const id = String((ev.chat && ev.chat.id) || '')
  if (!id) return
  /* 防自激：后端会上报本体账号自己发的消息，若回复内容本身命中前缀，
     它会被当成新的一条触发再回一次，形成回环。这里直接丢弃。 */
  if (matchTrigger(String(text == null ? '' : text))) {
    bus.warn('cmd', '检测到循环回复，已自动跳过')
    return
  }
  const r = await lab.run('send', {
    type: isGroup ? 'group' : 'private',
    id,
    text: String(text == null ? '' : text).slice(0, 1500)
  })
  if (!r || !r.ok) bus.warn('cmd', `回复失败：${(r && r.msg) || '未知原因'}`)
}

/* 同一人、同一会话内的回复冷却。0 = 完全关闭（冷却语义与 SnowLuma 一致：
 * 小于等于 0 即禁用）。想再开就把毫秒数填回来，比如 2000。 */
const FL_COOLDOWN_MS = 0
const flLast = new Map()

/**
 * payload 入站事件（inbound.js 的简化形状）→ kernel.feedKernelEvent 期望的
 * 内核消息列表。这里不猜内核原始对象（native 对象不保证 JSON 可序列化），
 * 用 inbound 已经提取好的字段拼一个「文本单段」伪内核消息：
 * 群消息不依赖 uidmap（user_id 允许 null），私聊必须能反查到 QQ 号才有事件。
 */
function feedKernelFromPayload (ev) {
  try {
    const isGroup = !!(ev.chat && ev.chat.type === 'group')
    const text = String(ev.text || '')
    const pseudo = {
      chatType: isGroup ? 2 : 1,
      peerUid: String((ev.chat && ev.chat.id) || ''),
      senderUid: String(ev.senderUid || ev.uin || ''),
      sendMemberName: String(ev.nick || ''),
      sendNickName: String(ev.nick || ''),
      msgId: String(ev.msgId || ''),
      msgSeq: String(ev.msgSeq || ''),
      msgTime: Number(ev.at) || Date.now(),
      msgElements: text
        ? [{ elementType: 1, textElement: { content: text, atType: 0, atUid: '', atTinyId: '', atNtUid: '' } }]
        : []
    }
    kernel.feedKernelEvent({ evt: 'msg', list: [pseudo] })
  } catch (e) {
    bus.warn('kernel', '消息处理失败: ' + (e && e.message ? e.message : e))
  }
}

function qqOfUid (uid) {
  if (!uid) return 0
  const q = uidmap.toQq(String(uid))
  return Number(q) || 0
}

/** 归一化事件 → OneBot notice：派发 + 落库，返回派发出去的那条（没映射就 null） */
function emitWatchNotice (w) {
  const e = toWatchNotice({ ...w, selfId: kernel.getSelfId() })
  if (!e) return null
  kernel.pushNotice(e)
  try {
    store.saveEvent(String(kernel.getSelfId() || ''), 'notice:' + (e.notice_type || e.request_type || '?'), e)
  } catch {}
  return e
}

function onWatchEvent (ev) {
  const kind = String(ev.kind || '')
  const group = String(ev.group || '')
  const f = (ev && ev.fields) || {}

  /* 0) 系统消息：好友申请 / 入群申请 / 群通知的原始通道（protobuf 已解成树） */
  if (kind === 'sysmsg') {
    const tree = (ev && ev.tree) || {}
    try { store.saveEvent(String(kernel.getSelfId() || ''), 'sysmsg', { bytes: ev.bytes, tree }) } catch {}
    /* 只打一层摘要：完整树在 /api/events 里查，不往日志里灌 */
    const brief = Object.keys(tree).slice(0, 8).map((k) => {
      const v = tree[k]
      return k + ':' + (typeof v === 'object' ? '{…}' : String(v).slice(0, 24))
    }).join(' ')
    bus.debug('watch', `系统消息 ${ev.bytes}B${ev.cut ? '(截断)' : ''} → ${brief}`)
    if (ev.err) bus.warn('watch', '系统消息解码失败: ' + ev.err)
    return
  }

  /* 1) 成员进出：payload 侧已在本进程里做差，这里拿到的就是差分结果 */
  if (kind === 'member-baseline') {
    bus.debug('watch', `群 ${group} 成员基线已建立（${ev.total || 0} 人），之后有进出才报`)
    return
  }
  if (kind === 'member-bulk') {
    bus.info('watch', `群 ${group} 成员名单大变动（+${ev.added || 0}/-${ev.removed || 0}，共 ${ev.total || 0} 人），不逐条派发`)
    return
  }
  if (kind === 'member-diff') {
    for (const uid of (ev.added || [])) {
      const n = emitWatchNotice({ kind: 'group_increase', group, user: qqOfUid(uid), at: ev.at })
      bus.ok('watch', `群 ${group} 有人加入：${(n && n.user_id) || uid}`)
    }
    for (const uid of (ev.removed || [])) {
      const n = emitWatchNotice({ kind: 'group_decrease', group, user: qqOfUid(uid), at: ev.at })
      bus.warn('watch', `群 ${group} 有人离开：${(n && n.user_id) || uid}`)
    }
    return
  }

  /* 2) 名片 / 角色：能挖到字段才派发，挖不到只记账（不编造空名片） */
  if (kind === 'member-card' || kind === 'member-role') {
    const user = qqOfUid((ev.uids || [])[0])
    if (!user) { bus.debug('watch', `成员资料变动，无法获取对应 QQ 号（${ev.name}）`); return }
    const n = emitWatchNotice(
      kind === 'member-card'
        ? { kind: 'group_card', group, user, card_new: f.card || '', at: ev.at }
        : { kind: 'group_admin', group, user, sub_type: String(f.role) === '2' ? 'unset' : 'set', at: ev.at }
    )
    if (n) bus.info('watch', kind === 'member-card'
      ? `群 ${group} 名片变更：${user} → ${f.card || '(空)'}`
      : `群 ${group} 管理员变更：${user}`)
    return
  }

  /* 3) 群文件 / 精华 / 申请：字段齐才派发 */
  if (kind === 'group-file') {
    const user = qqOfUid((ev.uids || [])[0])
    if (!f.fileName && !f.fileId) { bus.debug('watch', `群文件变动，未能获取文件名（${ev.name}）`); return }
    const n = emitWatchNotice({ kind: 'group_upload', group, user, fileId: f.fileId, name: f.fileName, size: f.fileSize, at: ev.at })
    if (n) bus.info('watch', `群 ${group} 文件变动：${f.fileName || f.fileId}`)
    return
  }
  if (kind === 'group-essence') {
    const user = qqOfUid((ev.uids || [])[0])
    const n = emitWatchNotice({ kind: 'essence', group, user, operator: qqOfUid(f.operator), message_id: f.msgId, at: ev.at })
    if (n) bus.info('watch', `群 ${group} 精华变动`)
    return
  }
  if (kind === 'friend-request' || kind === 'group-request') {
    const uid0 = String((ev.uids || [])[0] || '')
    const user = qqOfUid(uid0)
    /* 记下 (QQ号 → uid)：对方还不是好友时 0xB5D 审批只能靠这个缓存解析 uid */
    if (kind === 'friend-request') { try { rememberBuddy(user, uid0) } catch {} }
    const n = emitWatchNotice({ kind: kind === 'friend-request' ? 'friend_request' : 'group_request', group, user, comment: f.comment, at: ev.at })
    if (n) bus.warn('watch', `${kind === 'friend-request' ? '好友' : '入群'}申请：${user || '?'} ${f.comment || ''}`)
    return
  }

  /* 4) 其余（群资料 / 群列表 / 好友列表 / 资料变更）：只记账，不伪造事件 */
  bus.debug('watch', `事件 ${kind}（${ev.name}）${group ? ' 群 ' + group : ''}`)
}

async function onInbound (ev) {
  const cfg = load()
  const prefix = cfg.cmdPrefix || '#fl'
  const text = String(ev.text || '')
  const who = String(ev.uin || ev.senderUid || '?')
  /* 显示名：群名片/昵称 → uidmap 反查的 QQ 号 → 原始 uid（内核只给 u_ 内部号时的兜底） */
  const shown = String(ev.nick || '').trim() ||
    (uidmap.toQq(String(ev.senderUid || '')) || who)
  const isGroup = !!(ev.chat && ev.chat.type === 'group')
  const where = isGroup ? `群 ${ev.chat.id}` : `私聊 ${who}`
  /* 群消息顺手记下「群号 ↔ 群名」，给实验台的群号下拉用（内核群列表常为空） */
  if (isGroup) groups.learn(ev.chat.id, ev.peerName)
  /* 本体账号：selfId 由 host 在拿到登录态时注入；未注入时恒为 0，此处只会判成「非本体」 */
  /* 本体账号：payload 直接标 self（sendType===1）；selfId 由 host 在拿到登录态时注入，
     未注入时恒为 0，只能靠 payload 那一侧认。 */
  const isSelf = ev.self === true || (String(kernel.getSelfId() || '') === who && who !== '?')
  bus.info('qq', `← ${where} ${shown}${isSelf ? ' [本体]' : ''}: ${text.slice(0, 140)}`)

  /* 任意群、任意人：只判前缀（判定函数里没有发送者参数，无法做白名单）。
     判定口径：整条消息必须就是前缀本身，且只含一段纯文本。
     带参数（`#fl status`）、带图片/引用/表情的混合消息，一律当普通聊天静默忽略：
     不触发、不回话、不记日志。 */
  if (!isPureText(ev.rawTypes) || !matchTrigger(text, prefix)) return

  if (FL_COOLDOWN_MS > 0) {
    const key = `${isGroup ? ev.chat.id : 'p' + who}:${who}`
    const last = flLast.get(key) || 0
    if (Date.now() - last < FL_COOLDOWN_MS) return
    flLast.set(key, Date.now())
    if (flLast.size > 500) flLast.clear()    // 只是冷却表，整体清空不影响正确性
  }

  const r = await execute(text, { source: 'qq', uin: who, uid: String(ev.senderUid || '') })
  bus.log(r.ok ? 'ok' : 'warn', 'cmd', `› ${text}\n${r.text}`.slice(0, 3000))
  await replyTo(ev, r.text)
}

/** 向某个账号要一次登录信息，回填 uin/昵称（失败不重试，下次 ready 再来） */
const identityTrying = new Set()
async function resolveIdentity (pid) {
  if (!pid || identityTrying.has(Number(pid))) return
  identityTrying.add(Number(pid))
  try {
    const r = await kernel.callOn(pid, 'get_login_info', {}, 12000)
    if (!r.ok) return
    let info = null
    try { info = typeof r.ret === 'string' ? JSON.parse(r.ret) : r.ret } catch {}
    const uin = Number(info && (info.uin || info.user_id)) || 0
    if (!uin) return
    pool.setIdentity(pid, uin, (info && (info.nick || info.nickname)) || '')
    if (pool.pid === Number(pid)) kernel.setSelfId(uin)
    bus.ok('account', `账号就绪：${uin}${info && info.nick ? '（' + info.nick + '）' : ''} · pid=${pid}`)
  } finally {
    identityTrying.delete(Number(pid))
  }
}

pool.on('account-new', (a) => bus.info('account', `检测到 QQ 已启动（PID: ${a.pid}），正在连接…`))
pool.on('account-ready', (a) => { resolveIdentity(a.pid) })
pool.on('account-gone', (a) => bus.warn('account', `账号下线 pid=${a.pid}${a.uin ? '（' + a.uin + '）' : ''}`))
pool.on('active', (a) => { if (a) bus.debug('account', `当前账号 ${a.uin || a.pid}`) })

function getState () {
  const cfg = load()
  const st = bridge.status()
  return {
    version: VERSION,
    now: Date.now(),
    uptime: Math.floor((Date.now() - STARTED_AT) / 1000),
    panel: { host: cfg.host, port: ACTUAL_PORT, url: `http://${cfg.host}:${ACTUAL_PORT}` },
    cfgFile: CFG_FILE,
    payload: st,
    runtime: {
      env: runtime.env,
      hb: runtime.hb,
      state: runtime.state,
      lastEval: runtime.lastEval
    },
    qq: qq.getProbe(),
    kernel: kernel.status(),
    lab: { ops: lab.OP_NAMES },
    config: publicConfig(cfg),
    clients: bus.clientCount()
  }
}

function publicConfig (cfg) {
  return {
    port: cfg.port,
    host: cfg.host,
    qqExe: cfg.qqExe,
    autoStartQQ: cfg.autoStartQQ,
    autoInject: cfg.autoInject,
    cmdPrefix: cfg.cmdPrefix,
    blockedGroups: cfg.blockedGroups,
    theme: cfg.theme,
    obServerPort: cfg.obServerPort,
    obServerToken: cfg.obServerToken,
    obServerReverse: cfg.obServerReverse,
    obServerPost: cfg.obServerPost,
    obNetwork: cfg.obNetwork
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
}

function serveStatic (req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0])
  if (rel === '/' || rel === '') rel = '/index.html'
  /* 首次运行还没设置令牌：面板页一律先送回登录页，走完设置再进来 */
  if (rel === '/index.html' && auth.isBootstrap()) {
    res.writeHead(302, { Location: '/login.html' })
    return res.end()
  }
  const abs = path.join(WEB_DIR, rel)
  if (!abs.startsWith(WEB_DIR)) { res.writeHead(403); return res.end('forbidden') }
  fs.readFile(abs, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('not found') }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    })
    res.end(data)
  })
}

function readBody (req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { req.destroy(); return resolve(null) }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch { resolve({ __raw: raw }) }
    })
    req.on('error', () => resolve(null))
  })
}

function json (res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

let probing = false
let lastPsProbe = 0       // 上次用 PowerShell 查进程的时间（限流，避免定时弹黑窗）
let lastKnownPid = 0      // 上次确认过的 QQ 主进程 pid
const PS_PROBE_GAP = 30000
async function probe () {
  if (probing) return
  probing = true
  try {
    /* 多账号：管道名是唯一可信来源 —— 每个注入成功的 QQ 进程都有自己的
       frishluna.<pid>.evt/.cmd。先全部接上，再处理「有进程但没管道 = 还没注入」。 */
    const pipePids = qq.pidsFromPipes()
    pool.scan()
    for (const p of pipePids) pool.ensure(p)

    /* 只给当前账号定时要运行态（其它账号不需要 UI 刷新，少发一条是一条） */
    if (bridge.connected) bridge.send({ cmd: 'state' })

    /* 没有管道的 QQ 主进程：限流 30 秒用 PowerShell 看一次，可信才自动注入 */
    let stale = []
    if (Date.now() - lastPsProbe >= PS_PROBE_GAP) {
      lastPsProbe = Date.now()
      const mains = await qq.listMainPids()
      stale = mains.filter((p) => !pipePids.includes(p))
      lastKnownPid = mains.length ? mains[mains.length - 1] : 0
      if (stale.length && load().autoInject) {
        for (const p of stale) {
          bus.warn('qq', `QQ 已启动（PID: ${p}），正在自动连接`)
          await qq.inject(p, 'auto')
          pool.ensure(p)
        }
      }
    }

    const pipes = pipePids.map((p) => qq.pipesFor(p)).flat()
    qq.setProbe({ running: !!(pipePids.length || stale.length), pid: pipePids[pipePids.length - 1] || 0, pids: pipePids, pipes, at: Date.now() })

    if (!pool.list().length) {
      runtime.env = null
      runtime.hb = null
    }
    bus.broadcast('state', getState())
  } catch (e) {
    bus.debug('probe', e.message)
  } finally {
    probing = false
  }
}

let ACTUAL_PORT = 5701
/* 群号下拉的缓存：群列表变动很慢，60 秒内不重复问内核 */
const groupsCache = { at: 0, items: [] }
/* 登录失败计数：连错 5 次锁 30 秒 */
let loginFails = 0
let loginLockUntil = 0

function createServer () {
  return http.createServer(async (req, res) => {
    const url = req.url || '/'
    const p = url.split('?')[0]
    const method = req.method || 'GET'

    // 只允许本机
    const remote = req.socket.remoteAddress || ''
    const localOk = /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(remote)
    if (!localOk) { res.writeHead(403); return res.end('local only') }

    // 鉴权：除 /api/auth/* 外全部 API 需要访问令牌
    if (p.startsWith('/api/') && !p.startsWith('/api/auth/')) {
      /* /api/stream 例外：EventSource 带不了授权头，允许用一次性的短时票据换连接 */
      let ok = false
      if (p === '/api/stream') {
        let ticket = ''
        try { ticket = new URL(url, 'http://127.0.0.1').searchParams.get('ticket') || '' } catch {}
        ok = ticket ? auth.consumeStreamTicket(ticket) : auth.authed(req, url)
      } else {
        ok = auth.authed(req, url)
      }
      if (!ok) return json(res, 401, { ok: false, error: 'unauthorized' })
      /* 首次运行还没设置令牌：除了 auth 接口，一律挡住，逼回设置流程 */
      if (auth.isBootstrap()) return json(res, 428, { ok: false, error: 'setup-required' })
    }

    // 访问令牌
    if (p === '/api/auth/status' && method === 'GET') {
      return json(res, 200, {
        required: true,
        authed: auth.authed(req, url),
        bootstrap: auth.isBootstrap()
      })
    }
    if (p === '/api/auth/login' && method === 'POST') {
      /* 连错 5 次锁 30 秒：本机也有别的进程，挡一下暴力猜令牌 */
      const now = Date.now()
      if (now < loginLockUntil) {
        return json(res, 429, { ok: false, msg: `尝试太频繁，${Math.ceil((loginLockUntil - now) / 1000)} 秒后再试` })
      }
      const body = await readBody(req)
      const r = auth.login(body && body.token)
      if (!r.ok) {
        loginFails += 1
        if (loginFails >= 5) { loginLockUntil = Date.now() + 30 * 1000; loginFails = 0 }
        bus.warn('auth', '令牌验证失败（来自浏览器）')
        return json(res, 401, r)
      }
      loginFails = 0
      if (r.setupRequired) {
        bus.ok('auth', '初始令牌验证通过，进入令牌设置')
        return json(res, 200, r)
      }
      bus.ok('auth', '面板解锁成功')
      return json(res, 200, r)
    }
    if (p === '/api/auth/setup' && method === 'POST') {
      const body = await readBody(req)
      const r = auth.setup(body && body.ticket, body && body.token)
      if (!r.ok) return json(res, 400, r)
      bus.ok('auth', '访问令牌已设置（只存盐+哈希，不回显）')
      return json(res, 200, { ok: true, token: r.token, strength: r.strength })
    }
    if (p === '/api/stream/ticket' && method === 'POST') {
      /* 换一次性票据：30 秒有效、只能用一次，EventSource 的 URL 里就不必写真令牌 */
      return json(res, 200, { ok: true, ticket: auth.issueStreamTicket() })
    }

    if (p === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      })
      res.write(': connected\n\n')
      bus.addClient(res)
      res.write(`event: state\ndata: ${JSON.stringify(getState())}\n\n`)
      for (const rec of bus.recent(150)) res.write(`event: log\ndata: ${JSON.stringify(rec)}\n\n`)
      req.on('close', () => bus.removeClient(res))
      return
    }

    if (p === '/api/state' && method === 'GET') return json(res, 200, getState())
    if (p === '/api/logs' && method === 'GET') {
      const n = Number(new URL(url, 'http://x').searchParams.get('n')) || 300
      return json(res, 200, bus.recent(Math.min(2000, n)))
    }
    if (p === '/api/logs/clear' && method === 'POST') {
      await readBody(req)
      bus.clear()
      return json(res, 200, { ok: true, msg: '日志已清空' })
    }
    if (p === '/api/commands' && method === 'GET') {
      /* 子命令已移除：前缀只产出状态卡 */
      return json(res, 200, { prefix: load().cmdPrefix, commands: [], note: '只回状态卡，无子命令' })
    }

    if (p === '/api/cmd' && method === 'POST') {
      const body = await readBody(req)
      const text = body && (body.text || body.cmd)
      if (!text) return json(res, 400, { ok: false, text: '缺少 text' })
      const r = await execute(text, { source: 'web' })
      if (r.ok) bus.log('ok', 'cmd', `› ${text}\n${r.text}`.slice(0, 4000))
      return json(res, 200, r)
    }

    if (p === '/api/eval' && method === 'POST') {
      const body = await readBody(req)
      if (!body || !body.js) return json(res, 400, { ok: false, text: '缺少 js' })
      if (!bridge.connected) return json(res, 200, { ok: false, text: 'QQ 未连接：请检查 QQ 是否正常运行' })
      bridge.send({ cmd: 'eval', js: String(body.js) })
      return json(res, 200, { ok: true, text: '已下发指令' })
    }

    /* 让 payload 重新 eval bridge.js / ops.js / inbound.js（改完 payload 不用重启 QQ） */
    if (p === '/api/payload/reload' && method === 'POST') {
      await readBody(req)
      if (!bridge.connected) return json(res, 200, { ok: false, msg: '未连接：QQ 没有运行，或还没有连接上' })
      const sent = bridge.send({ cmd: 'reload' })
      bus.info('payload', '已请求重新连接 QQ')
      return json(res, 200, { ok: sent, msg: sent ? '已请求重载，结果见控制台日志' : '连接不可用，请稍后重试' })
    }

    if (p === '/api/payload/ping' && method === 'POST') {
      await readBody(req)
      if (!bridge.connected) return json(res, 200, { ok: false, msg: 'QQ 未连接：请检查 QQ 是否正常运行' })
      const sent = bridge.send({ cmd: 'ping' })
      return json(res, 200, { ok: sent, msg: sent ? '已发送 ping，往返见日志' : '向 QQ 发送数据失败' })
    }

    /* 群号下拉：结构化群列表（内核 + 本机学到的群名） */
    if (p === '/api/groups' && method === 'GET') {
      const force = /[?&]force=1/.test(url)
      const stale = Date.now() - groupsCache.at > 60000
      let remote = groupsCache.items
      let note = ''

      if (force || !remote.length || stale) {
        if (!bridge.connected) {
          note = '消息服务未连接：请确认 QQ 是否已打开并登录'
        } else {
          const r = await kernel.call('get_group_directory', {}, 20000)
          if (r.ok) {
            try {
              const l = JSON.parse(r.ret)
              if (Array.isArray(l)) {
                remote = l
                groupsCache.items = l
                groupsCache.at = Date.now()
              }
            } catch { note = '群列表格式异常' }
          } else {
            note = r.err || '取群列表失败'
          }
        }
      }

      /* 内核的群列表经常是空的（这个 session 没有群缓存），
         所以再用「从真实消息里学到的群名」补齐 */
      const list = groups.merge(remote)
      if (!list.length && !note) note = '还没有群可显示：等群里来一条消息，或直接填群号'
      return json(res, 200, { ok: true, groups: list, count: list.length, msg: note })
    }

    /* 实验台：发消息 */
    if (p === '/api/lab/send' && method === 'POST') {
      const body = await readBody(req)
      const text = String((body && body.text) || '').trim()
      /* kind 只认 group / private：拼错一个字母就会把本该进群的消息发到某个 QQ 号上，这里显式拒绝 */
      const kind = String((body && body.kind) || '')
      const id = String((body && body.id) || '').trim()
      if (kind !== 'group' && kind !== 'private') {
        return json(res, 400, { ok: false, msg: 'type 必须是 group 或 private' })
      }
      if (!text) return json(res, 400, { ok: false, msg: '消息内容为空' })
      if (!id) return json(res, 400, { ok: false, msg: kind === 'group' ? '缺少群号' : '缺少好友 QQ 号' })

      const where = `${kind === 'group' ? '群' : '好友'} ${id}`
      if (!bridge.connected) {
        bus.warn('lab', `发送失败：尚未连接到 QQ（目标 ${where}）`)
        return json(res, 200, { ok: false, msg: '服务未就绪：QQ 未运行或尚未连接' })
      }
      /* sendOp 下发即回的 ok 只代表「管道写入成功」，不代表消息发出；
         这里和 /api/lab/invoke 一样直接 await 真实结果。 */
      const t0 = Date.now()
      const r = await lab.run('send', { type: kind, id, text: text.slice(0, 3000) })
      const ms = Date.now() - t0
      const lines = human.fmtResult('send', r)
      bus.log(r.ok ? 'ok' : 'warn', 'lab',
        `→ ${where}: ${text.slice(0, 120)} ${r.ok ? '成功' : '失败'}（${ms}ms）`)
      return json(res, 200, {
        ok: !!r.ok,
        msg: r.msg || (r.ok ? '已发送' : '发送失败'),
        data: r.data,
        lines,
        ms
      })
    }

    /* 1C 封送层：C 侧 kop 直调（rva 传签名，地址由 C 侧每轮现算） */
    if (p === '/api/marshal/op' && method === 'POST') {
      const body = await readBody(req)
      const opName = String((body && body.op) || '').trim()
      if (!opName) return json(res, 400, { ok: false, msg: '缺少 op' })
      const t0 = Date.now()
      const ev = await marshal.op(body, Number(body.timeoutMs) || 20000)
      return json(res, 200, { ok: ev.evt === 'kop-ok', ms: Date.now() - t0, reply: ev })
    }

    if (p === '/api/marshal/status' && method === 'GET') {
      return json(res, 200, { ok: true, ...marshal.status(), bridge: bridge.status() })
    }

    /* 持久化：库状态 / 历史消息 */
    if (p === '/api/store/status' && method === 'GET') {
      return json(res, 200, { ok: true, ...store.status() })
    }
    if ((p === '/api/messages' || p === '/api/messages/history') && method === 'GET') {
      const q = new URL(req.url, 'http://x').searchParams
      const sel = {
        account: q.get('account') || '',
        peer: q.get('peer') || '',
        chatType: Number(q.get('chat_type')) || 0,
        q: q.get('q') || '',
        before: Number(q.get('before')) || 0
      }
      const list = store.queryMessages({ ...sel, limit: Number(q.get('limit')) || 50 })
      const total = typeof store.countMessages === 'function' ? store.countMessages(sel) : list.length
      return json(res, 200, { ok: true, count: list.length, total, list })
    }
    if (p === '/api/messages/peers' && method === 'GET') {
      const q = new URL(req.url, 'http://x').searchParams
      return json(res, 200, { ok: true, list: store.recentPeers(Number(q.get('limit')) || 30) })
    }
    /* 事件流水：Notice / Request / Meta 都落在这张表里。
       kinds 默认只给通知/申请/系统消息 —— 普通消息在「消息记录」页看 */
    if (p === '/api/events' && method === 'GET') {
      const q = new URL(req.url, 'http://x').searchParams
      const kindsRaw = q.get('kinds')
      const kinds = kindsRaw ? kindsRaw.split(',').map((s) => s.trim()).filter(Boolean) : ['notice', 'request', 'sysmsg']
      const list = store.queryEvents({
        type: q.get('type') || '',
        kinds,
        account: q.get('account') || '',
        limit: Number(q.get('limit')) || 100,
        before: Number(q.get('before')) || 0
      })
      const types = typeof store.eventTypes === 'function' ? store.eventTypes() : []
      return json(res, 200, { ok: true, count: list.length, list, types })
    }

    /* 多账号：列账号 / 切账号。一个 QQ 进程 = 一个账号，各自独立的管道、身份、uid 映射与发送出口。 */
    if (p === '/api/accounts' && method === 'GET') {
      return json(res, 200, { ok: true, list: pool.list(), active: pool.currentJson() })
    }
    if (p === '/api/accounts/select' && method === 'POST') {
      const b = await readBody(req)
      const key = (b && (b.key ?? b.uin ?? b.pid)) ?? ''
      const r = pool.select(key)
      if (r.ok) bus.ok('account', `切换账号：${r.account.uin || r.account.pid}`)
      return json(res, 200, r)
    }

    /* 实验台：通用功能（戳一戳 / 撤回 / 群管理 / 查询…）。直接 await lab.run 拿
       {ok,msg,list,data}，再经 humanize 压成行数组一起回给面板。 */
    if (p === '/api/lab/invoke' && method === 'POST') {
      const body = await readBody(req)
      const op = String((body && body.op) || '').trim()
      const args = (body && body.args && typeof body.args === 'object') ? body.args : {}
      if (!op) return json(res, 400, { ok: false, msg: '缺少 op' })
      if (!lab.has(op)) return json(res, 400, { ok: false, msg: `实验台还没有 ${op} 这一项` })

      /* 多账号：带上 account（uin 或 pid）就只把这一次调用发给那个账号，
         不动面板上的「当前账号」—— 切账号有专门的接口。 */
      const wantAcct = body && body.account
      if (wantAcct && !pool.byKey(wantAcct)) {
        return json(res, 200, { ok: false, msg: `没有这个账号：${wantAcct}` })
      }

      const liveAcct = wantAcct ? pool.byKey(wantAcct) : pool.current()
      if (!liveAcct || !liveAcct.bridge.connected) {
        bus.warn('lab', `${human.opLabel(op)} 失败：后端未就绪`)
        return json(res, 200, { ok: false, msg: '服务未就绪：QQ 未运行或尚未连接' })
      }

      const brief = human.fmtArgs(op, args)
      const t0 = Date.now()
      let r
      try {
        r = await lab.run(op, args, { account: wantAcct || null })
      } catch (e) {
        r = { ok: false, msg: String((e && e.message) || e) }
      }
      const ms = Date.now() - t0
      const lines = human.fmtResult(op, r)
      bus.log(r.ok ? 'ok' : 'warn', 'lab',
        `${human.opLabel(op)}${brief ? ' · ' + brief : ''} ${r.ok ? '成功' : '失败'}（${ms}ms）：${lines[0] || ''}`)
      return json(res, 200, {
        ok: !!r.ok,
        msg: r.msg || (r.ok ? '完成' : '失败'),
        list: r.list,
        data: r.data,
        lines,
        ms
      })
    }

    /* 好友列表（实验台「好友」下拉） */
    if (p === '/api/friends' && method === 'GET') {
      const r = await lab.run('friendList', {})
      const list = (r.list || []).map((f) => ({
        id: f.user_id || f.uid,
        qq: f.user_id || '',
        uid: f.uid || '',
        name: f.remark || f.nickname || ''
      }))
      if (!r.ok && !list.length) bus.debug('lab', '好友列表取不到：' + (r.msg || ''))
      return json(res, 200, { ok: !!r.ok, friends: list, count: list.length, msg: r.ok ? '' : (r.msg || '') })
    }

    /* 群成员（实验台「成员」下拉，选人填 uid） */
    if (p === '/api/lab/members' && method === 'GET') {
      const q = new URL(req.url, 'http://x').searchParams
      const gid = String(q.get('id') || '').trim()
      if (!gid) return json(res, 200, { ok: false, members: [], msg: '先填群号' })
      const r = await lab.run('groupMembers', { id: gid })
      const list = (r.list || []).map((m) => ({
        id: m.uid,
        uid: m.uid,
        qq: m.qq || '',
        name: m.qq ? 'QQ ' + m.qq : ''
      }))
      return json(res, 200, { ok: !!r.ok, members: list, count: list.length, msg: r.ok ? '' : (r.msg || '') })
    }

    /* 调试：内部状态全量导出 */
    if (p === '/api/debug/dump' && method === 'GET') {
      return json(res, 200, {
        version: VERSION,
        now: Date.now(),
        bridge: bridge.status(),
        bridgePaths: bridge.pid ? { evt: bridge.evtPath, cmd: bridge.cmdPath } : null,
        runtime: {
          env: runtime.env,
          hb: runtime.hb,
          state: runtime.state,
          lastEval: runtime.lastEval
        },
        qq: qq.getProbe(),
        kernel: kernel.status(),
        process: {
          pid: process.pid,
          node: process.versions.node,
          platform: process.platform,
          uptime: process.uptime(),
          memory: process.memoryUsage().rss
        },
        config: publicConfig(load())
      })
    }

    /* 仅本机：构造一条入站消息，真实走一遍 #fl 判定与回复（不经过 OneBot 事件） */
    if (p === '/api/debug/inbound' && method === 'POST') {
      const ra = String(req.socket.remoteAddress || '')
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ra)) {
        return json(res, 403, { ok: false, msg: '只允许本机调用' })
      }
      const body = await readBody(req)
      const gid = String((body && body.group) || '')
      const uin = String((body && body.uin) || '10000')
      await onInbound({
        text: String((body && body.text) || ''),
        uin,
        senderUid: uin,
        chat: gid ? { type: 'group', id: gid } : { type: 'private', id: uin }
      })
      return json(res, 200, { ok: true, msg: '已按入站消息处理' })
    }

    if (p.startsWith('/api/qq/') && method === 'POST') {
      const action = p.slice('/api/qq/'.length)
      await readBody(req)
      if (action === 'start') return json(res, 200, await qq.launch())
      if (action === 'stop') return json(res, 200, await qq.kill())
      if (action === 'restart') return json(res, 200, await qq.restart())
      if (action === 'inject') {
        const pid = await qq.mainPid()
        if (!pid) return json(res, 200, { ok: false, msg: 'QQ 没在跑' })
        return json(res, 200, await qq.inject(pid, 'manual'))
      }
      return json(res, 404, { ok: false, msg: 'unknown action' })
    }

    if (p === '/api/config') {
      if (method === 'GET') {
        return json(res, 200, publicConfig(load()))
      }
      if (method === 'POST') {
        const body = await readBody(req)
        if (!body) return json(res, 400, { ok: false })
        const patch = {}
        for (const k of ['port', 'qqExe', 'autoStartQQ', 'autoInject', 'cmdPrefix', 'blockedGroups', 'theme', 'host',
          'obServerPort', 'obServerToken', 'obServerReverse', 'obServerPost', 'obNetwork']) {
          if (k in body) patch[k] = body[k]
        }
        if ('obServerToken' in patch) patch.obServerToken = String(patch.obServerToken || '').trim()
        if ('obServerReverse' in patch) {
          patch.obServerReverse = (Array.isArray(patch.obServerReverse) ? patch.obServerReverse : String(patch.obServerReverse || '').split(/[\r\n,]+/))
            .map((u) => String(u).trim())
            .filter((u) => /^wss?:\/\//.test(u.split(/\s+/)[0]))
        }
        if ('obServerPost' in patch) {
          patch.obServerPost = (Array.isArray(patch.obServerPost) ? patch.obServerPost : String(patch.obServerPost || '').split(/[\r\n,]+/))
            .map((u) => String(u).trim())
            .filter((u) => /^https?:\/\//.test(u.split(/\s+/)[0]))
        }
        if ('obNetwork' in patch) {
          const n = patch.obNetwork && typeof patch.obNetwork === 'object' ? patch.obNetwork : {}
          const norm = (list, kind) => (Array.isArray(list) ? list : []).map((e) => {
            const o = e && typeof e === 'object' ? e : {}
            const out = { name: String(o.name || '').slice(0, 40), token: String(o.token || '').trim(), enable: o.enable !== false }
            if (kind === 'server') { out.port = Number(o.port) || 0; if (!(out.port > 0 && out.port < 65536)) return null }
            else { out.url = String(o.url || '').trim(); if (!/^(wss?|https?):\/\//.test(out.url)) return null }
            return out
          }).filter(Boolean)
          patch.obNetwork = {
            httpServers: norm(n.httpServers, 'server'),
            wsServers: norm(n.wsServers, 'server'),
            wsClients: norm(n.wsClients, 'client'),
            httpClients: norm(n.httpClients, 'client')
          }
        }
        const next = save(patch)
        bus.ok('config', '配置已保存')
        /* 协议端相关改动热应用，外部客户端（AstrBot 等）不用等面板重启。
           注意：热更新失败时配置确实已落盘，所以要报 ok:true + warn，不能假装没发生。 */
        let obWarn = ''
        if ('obServerPort' in patch || 'obServerToken' in patch || 'obServerReverse' in patch || 'obServerPost' in patch || 'obNetwork' in patch) {
          try {
            await obServer.applyConfig({ httpPort: next.obServerPort, token: next.obServerToken, reverseUrls: next.obServerReverse, postUrls: next.obServerPost, network: next.obNetwork })
          } catch (e) {
            obWarn = String((e && e.message) || e)
            bus.warn('onebot', '对接服务重载失败: ' + obWarn)
          }
        }
        return json(res, 200, {
          ok: true,
          config: publicConfig(next),
          restartNeeded: patch.port && Number(patch.port) !== ACTUAL_PORT,
          warn: !!obWarn,
          msg: obWarn
            ? '配置已保存，但对接服务重新加载失败（重启面板后生效）：' + obWarn
            : '配置已保存'
        })
      }
    }

    serveStatic(req, res, p)
  })
}

function openBrowser (url) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
  } catch {}
}

const LOG_FILE = path.join(DATA_DIR, 'panel.log')

/* 日志文件里一律不留完整令牌：控制台（横幅）可以有，落盘的必须是掩码。
   三道网：① 本进程发出过的明文精确替换（最可靠）
          ② 旧版 fl_ 前缀 / 符号串 / 16 位大小写混合串（历史日志残留）
          ③ token= / Bearer 后面的 8 位新令牌（长度变短后不能再用"16 位"启发式） */
const LEGACY_TOKEN_RE = /(fl_[0-9a-f]{16,}|(?=[a-z0-9?!*^]{16}(?![a-z0-9?!*^]))(?=[a-z0-9]*[?!*^])[a-z0-9?!*^]{16})/g
const MIXED_TOKEN_RE = /\b(?=[A-Za-z0-9]{16}\b)(?=[A-Za-z0-9]*[A-Z])(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{16}\b/g
/* 8 位太短，不能在全日志里做启发式（payload1 / QQNT9.9 都会中招），
   只认「紧跟在 token= 或 Bearer 空格后面」这一种上下文 */
const SHORT_TOKEN_RE = /((?:token=|x-fl-token:\s*|Bearer\s+))([A-Za-z0-9!@#$%^&*()\-_+=\[\]{};:,.?/~]{6,64})/gi

function maskTokens (s) {
  let out = String(s)
  /* 没有可查的「当前令牌」：只把本进程刚发出过的明文（初始/设置/重置）替换掉，
     其余靠下面两条正则兜。 */
  /* 8 位的令牌如果也留首尾各 4 位，等于把整串印出来；按长度自适应只留 2+2 */
  for (const cur of auth.secrets()) {
    const keep = cur.length > 20 ? 4 : 2
    out = out.split(cur).join(`${cur.slice(0, keep)}…${cur.slice(-keep)}`)
  }
  return out
    .replace(LEGACY_TOKEN_RE, (m) => `${m.slice(0, 4)}…${m.slice(-4)}`)
    .replace(MIXED_TOKEN_RE, (m) => `${m.slice(0, 4)}…${m.slice(-4)}`)
    .replace(SHORT_TOKEN_RE, (m, pre, tok) => `${pre}${tok.slice(0, 2)}…${tok.slice(-2)}`)
}

/** 历史日志里已经落过盘的完整令牌，启动时统一改成掩码 */
function scrubLogTokens (file) {
  try {
    if (!fs.existsSync(file)) return false
    const raw = fs.readFileSync(file, 'utf8')
    const masked = maskTokens(raw)
    if (masked === raw) return false
    fs.writeFileSync(file, masked, 'utf8')
    return true
  } catch { return false }
}

function installTee () {
  try {
    // 单个日志超过 4MB 就轮转一份，避免无限长大
    try {
      if (fs.statSync(LOG_FILE).size > 4 * 1024 * 1024) {
        try { fs.unlinkSync(path.join(DATA_DIR, 'panel.1.log')) } catch {}
        fs.renameSync(LOG_FILE, path.join(DATA_DIR, 'panel.1.log'))
      }
    } catch {}
    for (const f of [LOG_FILE, path.join(DATA_DIR, 'panel.1.log')]) {
      if (scrubLogTokens(f)) console.log(`  已把 ${path.basename(f)} 里的完整令牌改成掩码`)
    }
    const stream = fs.createWriteStream(LOG_FILE, { flags: 'a' })
    const wrap = (orig) => (...args) => {
      const line = args.map((a) => (typeof a === 'string' ? a : util.inspect(a))).join(' ')
      try { stream.write(maskTokens(line) + '\n') } catch {}
      orig(line)
    }
    console.log = wrap(console.log.bind(console))
    console.error = wrap(console.error.bind(console))
  } catch {}
}

function printBanner (url, cfg, boot) {
  const bar = '─'.repeat(60)
  /* 只有「本次启动刚生成初始令牌」才有明文可印。已设置过的令牌只存了盐+哈希，
     任何情况下都取不回来 —— 这是有意的，代价就是忘了只能重置。 */
  const onTty = !!process.stdout.isTTY
  const shown = boot
    ? (onTty ? boot : '已生成（输出被重定向，无法打印）')
    : '已设置（仅存盐+哈希，不可回显）'
  const out = [
    '',
    `  ${bar}`,
    `   FrishLuna v${VERSION}   ·   ${new Date().toLocaleString('zh-CN')}`,
    `  ${bar}`,
    `   面板    ${url}`,
    `   令牌    ${shown}`,
    `   日志    ${LOG_FILE}`,
    `   配置    ${CFG_FILE}`,
    `   方式    原生 QQ 客户端`,
    `  ${bar}`,
    boot && onTty
      ? '   初始令牌只打印这一次：登录后立刻设置你自己的令牌，它即刻作废'
      : boot
        ? (process.platform === 'win32'
          ? '   初始令牌已生成但输出被重定向：双击 app/前台运行.cmd 重看一次'
          : '   初始令牌已生成但输出被重定向：用 app/start.sh 前台启动重看一次')
        : '   令牌不可回显：忘了就删掉 .env 里 FL_AUTH_* 那几行再重启，会重新生成初始令牌',
    ''
  ].join('\n')
  console.log(out)
}

async function main () {
  installTee()
  const cfg = load()

  const server = createServer()
  let port = cfg.port
  const maxPort = cfg.port + 20

  const tryListen = (p) => new Promise((resolve) => {
    const onErr = (e) => {
      server.removeListener('listening', onOk)
      resolve(e.code === 'EADDRINUSE' ? 'busy' : 'err')
    }
    const onOk = () => {
      server.removeListener('error', onErr)
      resolve('ok')
    }
    server.once('error', onErr)
    server.once('listening', onOk)
    server.listen(p, cfg.host)
  })

  let r = 'busy'
  while (port <= maxPort) {
    r = await tryListen(port)
    if (r === 'ok') break
    bus.warn('app', `端口 ${port} 被占用，试 ${port + 1}`)
    port++
  }
  if (r !== 'ok') {
    console.error('没有可用端口，退出')
    process.exit(1)
  }
  ACTUAL_PORT = port

  const url = `http://${cfg.host}:${port}`
  try { fs.writeFileSync(path.join(DATA_DIR, 'panel.pid'), String(process.pid), 'utf8') } catch {}
  /* 端口可能因为被占用而顺延（5701 被占就试 5702…）。把真实端口落盘，
     启动器 / 看门狗只认这个文件，避免「面板跑在 5702，探 5701 说没起来」这种误判。 */
  try { fs.writeFileSync(path.join(DATA_DIR, 'panel.port'), String(port), 'utf8') } catch {}

  auth.ensureStore()
  printBanner(url, cfg, auth.bootPlain())

  bus.ok('app', `面板已启动 ${url}`)
  bus.info('app', '访问令牌 已设置（仅存盐+哈希，不可回显）')
  bus.info('app', '运行方式 原生 QQ 客户端')

  setInterval(() => bus.heartbeat(), 15000)
  setInterval(probe, 5000)

  /* 持久化：启动时报一次库状态，之后每小时裁一次旧数据 */
  {
    const st = store.status()
    if (st.ok) bus.ok('store', `本地数据库就绪：已缓存 ${st.counts.messages} 条消息`)
    else bus.warn('store', '本地存储不可用（仍可正常收发，但不会保存记录）：' + (st.msg || '未知'))
    store.prune()
    setInterval(() => store.prune(), 3600000).unref?.()
  }

  probe()
  /* selfId 认主轮询：内核 uin 没探到之前定时试一次（探到就自动停）。
     间隔从 5 秒放宽到 30 秒：旁挂 session 永远拿不到 selfId，5 秒一次等于
     每 5 秒往 payload 灌一次 selfInfo（一整套内核调用），会把 QQ 主进程的
     空闲 CPU 顶到 40%，进而拖垮 UI 输入转发。30 秒对「登录后认主」够用。 */
  setInterval(() => { if (!kernel.getSelfId()) kernel.probe().catch(() => {}) }, 30000)

  // 内置 OneBot v11 协议端：内核事件 → HTTP/WS 推送
  kernel.setBlockedGroups(cfg.blockedGroups)
  try {
    const ob = await obServer.start({
      httpPort: cfg.obServerPort || 5760,
      token: cfg.obServerToken || '',
      reverseUrls: Array.isArray(cfg.obServerReverse) ? cfg.obServerReverse : [],
      postUrls: Array.isArray(cfg.obServerPost) ? cfg.obServerPost : [],
      network: cfg.obNetwork
    })
    bus.ok('onebot', '机器人对接服务已就绪（网络连接按下方矩阵逐个开启）' + (cfg.obServerToken ? '' : '（未设统一令牌，仅回环）'))
  } catch (e) {
    bus.warn('onebot', '机器人对接服务启动失败: ' + (e && e.message ? e.message : e))
  }

  /* 面板 SSE 的消息流改挂内核：入站命令链路已由 payload 的 msg 事件直调
     onInbound，这里只负责把同一批事件推给前端，绝不重复执行命令。 */
  kernel.events.on('message', (row) => bus.broadcast('qqmsg', row))
  kernel.events.on('notice', (ev) => bus.broadcast('qqnotice', ev))

  if (cfg.autoStartQQ) {
    const pid = await qq.mainPid()
    const injected = pid && qq.pipesFor(pid).length >= 2
    if (!pid) {
      bus.info('app', '自动启动 QQ…')
      qq.launch()
    } else if (injected) {
      bus.info('app', 'QQ 已在运行并已连接')
    }
    // QQ 在跑但没注入的情况交给 probe 的 autoInject，避免双份注入
  }

  if (!process.env.FL_NO_OPEN) openBrowser(url)

  const shutdown = () => {
    bus.warn('app', '收到退出信号，关闭面板')
    try { for (const a of pool.list()) pool.detachPid(a.pid) } catch {}
    /* 端口文件先撤，免得启动器以为面板还活着 */
    try { fs.unlinkSync(path.join(DATA_DIR, 'panel.port')) } catch {}
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 800)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

/* 进程被意外带走时（未捕获异常 / 未处理的 Promise），先把堆栈写进日志再退，
   否则日志里只剩「突然没下文」，看门狗再拉起也查不出原因。 */
process.on('uncaughtException', (e) => {
  try { bus.error('app', '未捕获异常：' + (e && e.stack ? e.stack : e)) } catch { console.error(e) }
  try { fs.unlinkSync(path.join(DATA_DIR, 'panel.port')) } catch {}
  setTimeout(() => process.exit(1), 120)
})
process.on('unhandledRejection', (e) => {
  try { bus.error('app', '未处理的 Promise 拒绝：' + (e && e.stack ? e.stack : e)) } catch { console.error(e) }
})

main().catch((e) => {
  console.error('启动失败:', e)
  process.exit(1)
})
