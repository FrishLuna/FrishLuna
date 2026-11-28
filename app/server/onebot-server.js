import http from 'node:http'
import https from 'node:https'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import * as kernel from './kernel.js'
import * as bus from './bus.js'
import { toQq, resolve as resolveUid } from './uidmap.js'
import * as msgid from './msgid.js'
import * as qzone from './qzone.js'
import * as media from './media-dl.js'
import * as flash from './flash.js'
import * as approval from './request-approval.js'
import * as extended from './extended.js'

export const events = new EventEmitter() // 'event' → 内核产生的 OneBot 11 事件

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const HEARTBEAT_MS = 30000
/** 监听地址：容器/服务器部署时用 FL_ONEBOT_HOST 覆盖为 0.0.0.0 */
const LISTEN_HOST = process.env.FL_ONEBOT_HOST || '127.0.0.1'

let httpSrv = null // 旧版单端口监听（兼容保留，新的走 listeners）
let httpPort = 0 // 旧版单端口（兼容保留）
let wsClients = new Set() // {sock, buf, alive}
let token = '' // 统一令牌（各连接没单独填时兜底）
let revUrls = [] // 旧版反向 WS 原始行（兼容保留）
let postUrls = [] // 旧版 HTTP 上报原始行（兼容保留）
let postTargets = [] // 解析后的上报目标 [{url, token, qToken}]
let revSocks = new Set() // global WebSocket 实例
/** 反向 WS 连续失败次数（url → n）：只让第一次进「警告」，后续降级避免刷屏 */
const revTries = new Map()
/** HTTP 上报连续失败次数（url → n），降级策略同上 */
const postTries = new Map()
let revTimer = null
let hbTimer = null
let running = false
/* 网络矩阵：每类可挂多个连接 */
let netHttpServers = [] // [{name, port, token, enable}] HTTP API 监听
let netWsServers = [] // [{name, port, token, enable}] 正向 WS 监听
let netWsClients = [] // [{name, url, token, enable}] 反向 WS
let netHttpClients = [] // [{name, url, token, enable}] HTTP 上报
let listeners = [] // [{kind, entry, srv}] 已开的监听

/** 服务端→客户端帧：文本帧不掩码 */
function wsFrame (payload) {
  const body = Buffer.from(payload, 'utf8')
  const len = body.length
  let head
  if (len < 126) {
    head = Buffer.from([0x81, len])
  } else if (len < 65536) {
    head = Buffer.alloc(4)
    head[0] = 0x81; head[1] = 126; head.writeUInt16BE(len, 2)
  } else {
    head = Buffer.alloc(10)
    head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([head, body])
}

/** 服务端控制帧（pong/close）：RFC6455 要求 pong 原样回显 ping 的载荷，控制帧上限 125 字节 */
function wsCtrl (opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '', 'utf8')
  const len = Math.min(body.length, 125)
  return Buffer.concat([Buffer.from([0x80 | opcode, len]), body.subarray(0, len)])
}

/** 从缓冲里尽力解析出完整的客户端帧（客户端必须掩码）。返回 {frames:[{opcode,payload}], rest} */
function wsParse (buf) {
  const frames = []
  let pos = 0
  while (pos + 2 <= buf.length) {
    const fin = (buf[pos] & 0x80) !== 0
    const opcode = buf[pos] & 0x0f
    const masked = (buf[pos + 1] & 0x80) !== 0
    let len = buf[pos + 1] & 0x7f
    let off = 2
    if (len === 126) {
      if (pos + 4 > buf.length) break
      len = buf.readUInt16BE(pos + 2); off = 4
    } else if (len === 127) {
      if (pos + 10 > buf.length) break
      len = Number(buf.readBigUInt64BE(pos + 2)); off = 10
    }
    let mask = null
    if (masked) {
      if (pos + off + 4 > buf.length) break
      mask = buf.subarray(pos + off, pos + off + 4); off += 4
    }
    if (pos + off + len > buf.length) break
    let payload = buf.subarray(pos + off, pos + off + len)
    if (mask) {
      payload = Buffer.from(payload)
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
    }
    frames.push({ fin, opcode, payload })
    pos += off + len
  }
  return { frames, rest: buf.subarray(pos) }
}

/* 内核原样返回的字段名（uid / uin / nick / groupCode）和 OneBot 的（user_id / nickname /
   group_id）对不上，客户端拿到的会是「全部空值」。只读接口统一在这一层改名。 */
function num (v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function qqOf (uid, uin) {
  const direct = num(uin)
  if (direct > 0) return direct
  const mapped = num(toQq(uid))
  return mapped > 0 ? mapped : 0
}

function arrOf (d) {
  if (Array.isArray(d)) return d
  if (d && Array.isArray(d.list)) return d.list
  if (d && Array.isArray(d.data)) return d.data
  return []
}

/* 内核 elements → OneBot 11 段（get_msg / 历史消息共用）。
   elements 可能是数组本体（getMsg 整条 JSON），也可能是 JSON 字符串
   （msgHistory 每条 8KB 截断）。截断导致解析失败时如实标注，不装没事。 */
function elemsToSegments (elements) {
  let els = elements
  if (typeof els === 'string') {
    try { els = JSON.parse(els) } catch { return [{ type: 'text', data: { text: '[消息内容过长，请查看详情]' } }] }
  }
  if (!Array.isArray(els)) return []
  const out = []
  for (const e of els) {
    if (!e) continue
    if (e.textElement) out.push({ type: 'text', data: { text: String(e.textElement.content ?? '') } })
    else if (e.atElement) {
      const at = e.atElement
      const qq = num(at.atUid) || qqOf(at.atNtUid, at.uin ?? at.atUid)
      out.push({ type: 'at', data: { qq: String(qq || 0), uid: String(at.atNtUid ?? ''), display: String(at.displayId ?? '') } })
    } else if (e.faceElement) out.push({ type: 'face', data: { id: String(e.faceElement.faceIndex ?? ''), text: String(e.faceElement.faceText ?? '') } })
    else if (e.picElement) {
      const pic = e.picElement
      out.push({ type: 'image', data: { file: String(pic.fileName ?? pic.fileUuid ?? ''), url: String(pic.originImageUrl ?? ''), file_size: num(pic.fileSize), width: num(pic.picWidth), height: num(pic.picHeight) } })
    } else if (e.videoElement) out.push({ type: 'video', data: { file: String(e.videoElement.fileName ?? ''), file_size: num(e.videoElement.fileSize) } })
    else if (e.pttElement) out.push({ type: 'record', data: { file: String(e.pttElement.fileName ?? ''), file_size: num(e.pttElement.fileSize) } })
    else if (e.fileElement) out.push({ type: 'file', data: { file: String(e.fileElement.fileName ?? ''), file_size: num(e.fileElement.fileSize) } })
    else if (e.replyElement) out.push({ type: 'reply', data: { seq: String(e.replyElement.replayMsgSeq ?? '') } })
    else if (e.arkElement) out.push({ type: 'json', data: { data: String(e.arkElement.bytesData ?? '') } })
    else if (e.grayTipElement) out.push({ type: 'text', data: { text: '[系统提示]' } })
  }
  /* 一条消息明明有元素却一个没识别：如实标注，别让客户端拿到空消息以为发了个寂寞 */
  if (!out.length && Array.isArray(els) && els.length) {
    const kinds = els.map((e) => e && Object.keys(e).filter((k) => k.endsWith('Element'))[0]).filter(Boolean)
    out.push({ type: 'text', data: { text: '[未识别元素 x' + els.length + (kinds.length ? '：' + kinds.join(',') : '') + ']' } })
  }
  return out
}

function segsToRaw (segs) {
  return segs.map((s) => {
    if (s.type === 'text') return s.data?.text ?? ''
    if (s.type === 'at') return '@' + (s.data?.display || s.data?.qq || '')
    if (s.type === 'image') return '[图片]'
    if (s.type === 'face') return '[表情]' + (s.data?.text || '')
    return '[' + s.type + ']'
  }).join('')
}

function shapeRead (action, d, params) {
  switch (action) {
    case 'get_group_list':
      return arrOf(d).map((g) => ({
        group_id: num(g.group_id ?? g.groupCode),
        group_name: String(g.group_name ?? g.groupName ?? ''),
        member_count: num(g.member_count ?? g.memberCount),
        max_member_count: num(g.max_member_count ?? g.memberCount)
      }))
    case 'get_friend_list':
      return arrOf(d).map((f) => ({
        user_id: qqOf(f.uid, f.uin ?? f.user_id),
        nickname: String(f.nickname ?? f.nick ?? ''),
        remark: String(f.remark ?? ''),
        uid: String(f.uid ?? '')
      }))
    case 'get_group_member_list': {
      const gid = num(params && params.group_id)
      return arrOf(d).map((m) => ({
        group_id: gid,
        user_id: qqOf(m.uid, m.qq ?? m.uin),
        nickname: String(m.nick ?? m.nickname ?? m.card ?? ''),
        card: String(m.card ?? ''),
        uid: String(m.uid ?? ''),
        /* 禁言到期时间必须保留：丢掉它，下游筛禁言名单永远是空 */
        shut_up_timestamp: Number(m.shutUpTime ?? m.shut_up_timestamp ?? 0) || 0
      }))
    }
    case 'get_recent_contact':
      return arrOf(d).map((r) => {
        const isGroup = num(r.chatType ?? r.chat_type) !== 1
        return {
          chat_type: isGroup ? 'group' : 'private',
          group_id: isGroup ? num(r.peerUid ?? r.group_id) : 0,
          user_id: isGroup ? 0 : qqOf(r.peerUid, r.peerUid ?? r.user_id),
          peer_name: String(r.peerName ?? r.peer_name ?? ''),
          sender_id: qqOf(r.last_uin, r.sender_id),
          sender_nick: String(r.last_nick ?? r.sender_nick ?? ''),
          last_msg: String(r.last_text ?? r.last_msg ?? ''),
          message_id: String(r.msgId ?? r.message_id ?? ''),
          msg_seq: String(r.msgSeq ?? r.msg_seq ?? ''),
          time: num(r.msgTime ?? r.time)
        }
      })
    /* get_msg：内核回的是整条原始消息 JSON（payload getMsg） */
    case 'get_msg': {
      const m = d && typeof d === 'object' && !Array.isArray(d) ? d : null
      if (!m) return null
      const segs = elemsToSegments(m.elements)
      return {
        message_id: params ? params.message_id : undefined,
        real_id: String(m.msgSeq ?? ''),
        message: segs,
        raw_message: segsToRaw(segs),
        sender: {
          user_id: qqOf(m.senderUid, m.senderUin),
          uid: String(m.senderUid ?? ''),
          nickname: ''
        },
        time: num(m.msgTime),
        recalled: num(m.recallTime) > 0
      }
    }
    /* 历史：getLatestDbMsgs 行（msgId/msgSeq/uid/uin/time/recallTime/elements） */
    case 'get_group_msg_history':
    case 'get_friend_msg_history':
      return arrOf(d).map((m) => {
        const segs = elemsToSegments(m.elements)
        /* 历史行也注册进映射表：客户端拿返回的 message_id 就能直接 delete_msg，不必再带群号 */
        const kid = String(m.msgId ?? '')
        let mid = kid
        try {
          mid = msgid.toOneBotId(kid, {
            peer: String(params.group_id ?? params.user_id ?? ''),
            chatType: params.group_id !== undefined ? 2 : 1,
            account: kernel.getSelfId() ? String(kernel.getSelfId()) : ''
          })
        } catch { /* 映射失败回退内核 id，不阻塞历史返回 */ }
        return {
          message_id: mid,
          real_id: String(m.msgSeq ?? ''),
          message: segs,
          raw_message: segsToRaw(segs),
          sender: {
            user_id: qqOf(m.uid, m.uin),
            uid: String(m.uid ?? ''),
            nickname: ''
          },
          time: num(m.time),
          recalled: num(m.recallTime) > 0
        }
      })
    default:
      return d
  }
}

/** AI 语音收据关联·路径一：等本号在群里发的 record 消息事件，file_uuid 严格相等才认。
 *  超时返回 null（不假成功——语音可能已经进了群，如实说明 message_id 未知）。 */
function waitAiVoiceReceipt (groupId, fileUuid, timeoutMs) {
  return new Promise((resolve) => {
    let timer = null
    const onMsg = (e) => {
      if (!e || e.post_type !== 'message' || e.message_type !== 'group') return
      if (Number(e.group_id) !== Number(groupId)) return
      if (num(e.user_id) !== num(kernel.getSelfId())) return
      const hit = (e.message || []).some((s) =>
        s && s.type === 'record' && String(s.data && s.data.file_uuid || '') === String(fileUuid)
      )
      if (hit) {
        cleanup()
        resolve(e.message_id)
      }
    }
    function cleanup () {
      kernel.events.off('message', onMsg)
      if (timer) clearTimeout(timer)
    }
    kernel.events.on('message', onMsg)
    timer = setTimeout(() => { cleanup(); resolve(null) }, timeoutMs)
  })
}

/** AI 语音收据关联·路径二（兜底）：payload 消息差分只带 text 不带原始元素，实时事件里
 *  没有 record 段，路径一必然落空。改扫群历史（payload msgHistory 原始形态：元素 JSON
 *  内嵌字符串）：0x929B 的 node.info.md5 就是语音文件名（<md5>.amr），找 self 发的、
 *  元素里含该 md5 的最新一条，把内核 msgId 注册进映射表返回 OneBot int id。
 *  扫不到返回 null，绝不按「下一条语音」猜。 */
async function receiptViaHistory (groupId, md5, maxTries, account) {
  for (let i = 0; i < (maxTries || 6); i++) {
    const r = await kernel.call('get_group_msg_history', { group_id: groupId, count: 8 }, 15000)
    if (r.ok) {
      let arr = null
      try { arr = typeof r.ret === 'string' ? JSON.parse(r.ret) : r.ret } catch { arr = null }
      if (Array.isArray(arr)) {
        const mine = arr.filter((m) => num(m.uin) === num(kernel.getSelfId()))
        for (let k = mine.length - 1; k >= 0; k--) {
          const els = typeof mine[k].elements === 'string' ? mine[k].elements : JSON.stringify(mine[k].elements || [])
          if (md5 && String(els).toLowerCase().includes(String(md5).toLowerCase())) {
            /* 映射键按账号前缀隔离：必须带上当前账号，多账号下同名内核 id 才不串 */
            const obId = msgid.toOneBotId(String(mine[k].msgId), { peer: String(groupId), chatType: 2, account: account ? String(account) : '' })
            return { message_id: obId, kernelId: String(mine[k].msgId) }
          }
        }
      }
    }
    await new Promise((res) => setTimeout(res, 1200))
  }
  return null
}

async function handleAction (action, params, echo) {
  /* OneBot 允许用 self_id 指定目标账号：专用分支不走通用 translate，
     这里把整个请求绑定到该账号，避免「指定 B 却操作了 A」 */
  const sid = params && params.self_id
  if (sid !== undefined && sid !== null && String(sid) !== '') {
    return kernel.withAccount(String(sid), () => handleActionInner(action, params, echo))
  }
  return handleActionInner(action, params, echo)
}

async function handleActionInner (action, params, echo) {
  const st = kernel.status()
  const base = (status, retcode, data, message) => ({ status, retcode, data, message, echo })
  /* 开发直通：默认关闭。既要挡别名 fl_eval，也要挡能直达内核调试能力的原始 action，
     否则只封一个对外名字等于没封。确实要临时 eval 时用 FL_DEV_EVAL=1 启动面板 */
  const DEV_ACTIONS = ['fl_eval', 'fl_status', 'dev_eval', 'probe_call', 'kernel_listen']
  if (DEV_ACTIONS.includes(action) && process.env.FL_DEV_EVAL !== '1') {
    return base('failed', 1403, null, '调试通道已关闭（需要时用 FL_DEV_EVAL=1 启动）')
  }
  if (action === 'fl_eval') {
    const r = await kernel.call('dev_eval', { js: String(params.js || '') }, 30000)
    return base(r.ok ? 'ok' : 'failed', r.ok ? 0 : 1500, r.ret ?? null, r.ok ? '' : String(r.err || r.msg || ''))
  }
  if (action === 'fl_status') {
    return base('ok', 0, { connected: !!st.connected, selfId: kernel.getSelfId() }, '')
  }
  if (action === 'get_version_info') {
    return base('ok', 0, { app_name: 'FrishLuna', app_version: '1.0', protocol_version: 'v11', native: false })
  }
  if (action === 'get_login_info') {
    /* 外部客户端（AstrBot 等）连上后第一个请求就是它，用来认本号。
       面板刚重启时内存里的 uin 是空的，这里现问一次内核，别让客户端在启动瞬间全挂。 */
    let uin = kernel.getSelfId()
    let nick = 'FrishLuna'
    if (!uin) {
      const r = await kernel.call('get_login_info', {}, 8000)
      if (r.ok) {
        let j = null
        try { j = typeof r.ret === 'string' ? JSON.parse(r.ret) : r.ret } catch { j = null }
        const u = j && (j.uin || j.user_id)
        if (u) { kernel.setSelfId(u); uin = num(u) }
        if (j && j.nick) nick = String(j.nick)
      }
    }
    if (!uin) return base('failed', 1404, null, '尚未获取到当前登录账号信息（QQ 刚登录完成），请稍后重试')
    return base('ok', 0, { user_id: uin, nickname: nick })
  }
  if (action === 'get_status') {
    return base('ok', 0, { online: st.online, good: st.online, app_name: 'FrishLuna', app_version: '1.0', protocol_version: 'v11' })
  }
  /* 能力自报：图片/语音/视频/文件 都能发（有的客户端先探这个再决定发什么段） */
  if (action === 'can_send_image' || action === 'can_send_record' || action === 'can_send_video' || action === 'can_send_file') {
    return base('ok', 0, { yes: true }, '')
  }
  if (!st.online) {
    // 未就绪时显式失败
    return base('failed', 1404, null, '消息服务未连接，操作未执行（请确认 QQ 已启动）')
  }

  /* 内核没有「单个群 / 单个成员」的读接口，只有整表。这两个 action 用整表过滤实现，
     不然客户端调一次就报「未实现的 action」。 */
  if (action === 'get_group_info') {
    const want = num(params.group_id)
    if (!want) return base('failed', 1400, null, '缺少 group_id')
    const r = await kernel.call('get_group_list', {}, 15000)
    if (!r.ok) return base('failed', r.retcode || 1500, null, r.err)
    let d = null
    try { d = typeof r.ret === 'string' ? JSON.parse(r.ret) : r.ret } catch { d = null }
    const hit = shapeRead('get_group_list', d).find((g) => g.group_id === want)
    if (!hit) return base('failed', 1404, null, `群 ${want} 不在本号群列表里`)
    return base('ok', 0, hit, '')
  }
  if (action === 'get_group_member_info') {
    const gid = num(params.group_id)
    if (!gid) return base('failed', 1400, null, '缺少 group_id')
    const r = await kernel.call('get_group_member_list', { group_id: gid }, 15000)
    if (!r.ok) return base('failed', r.retcode || 1500, null, r.err)
    let d = null
    try { d = typeof r.ret === 'string' ? JSON.parse(r.ret) : r.ret } catch { d = null }
    const all = shapeRead('get_group_member_list', d, { group_id: gid })
    const qq = num(params.user_id)
    const uidHint = String(params.user_id ?? '')
    let uidMapped = ''
    if (qq) {
      const m = resolveUid(qq)
      if (m && m.ok) uidMapped = String(m.uid || '')
    }
    const hit = all.find((x) => (qq && x.user_id === qq) || (uidHint && x.uid === uidHint) || (uidMapped && x.uid === uidMapped))
    if (!hit) return base('failed', 1404, null, `群 ${gid} 里找不到成员 ${params.user_id ?? ''}`)
    return base('ok', 0, hit, '')
  }

  if (action === 'get_stranger_info' || action === 'get_user_info') {
    const qq = num(params.user_id ?? params.qq)
    if (!qq) return base('failed', 1400, null, '缺少 user_id')
    if (qq === kernel.getSelfId()) return base('ok', 0, { user_id: qq, nickname: '', sex: 'unknown', age: 0 }, '')
    const r = await kernel.call('get_friend_list', {}, 15000)
    if (!r.ok) return base('failed', r.retcode || 1500, null, r.err)
    let d = null
    try { d = typeof r.ret === 'string' ? JSON.parse(r.ret) : r.ret } catch { d = null }
    const hit = shapeRead('get_friend_list', d).find((f) => f.user_id === qq)
    if (!hit) return base('failed', 1404, null, `查不到 ${qq} 的资料：对方不是好友且暂无本地缓存`)
    return base('ok', 0, { user_id: qq, nickname: hit.nickname, remark: hit.remark, sex: 'unknown', age: 0 }, '')
  }

  /* 媒体下载闭环（get_image/get_record/get_file/download_file） */

  if (action === 'get_image' || action === 'get_record' || action === 'get_file') {
    const kind = action === 'get_image' ? 'image' : (action === 'get_record' ? 'record' : 'file')
    try {
      const r = await media.getMedia({
        file: params.file,
        url: params.url ?? params.file_url,
        msg_id: params.msg_id ?? params.message_id,
        group_id: params.group_id,
        kind,
        isGroup: params.group_id !== undefined || params.is_group !== false,
        no_local: !!params.no_local
      })
      return base('ok', 0, r, '')
    } catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }
  if (action === 'download_file') {
    try { return base('ok', 0, await media.downloadFile({ url: params.url ?? params.file }), '') }
    catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }

  /* 登录凭证（get_cookies / get_csrf_tokens / get_credentials）
   * 组合逻辑在 qzone.js credentials()（clientKey+pskey+bkn），OneBot 与实验台共用 */
  if (action === 'get_cookies' || action === 'get_csrf_tokens' || action === 'get_credentials') {
    try {
      const c = await qzone.credentials()
      if (action === 'get_cookies') return base('ok', 0, { cookies: c.cookies }, '')
      if (action === 'get_csrf_tokens') return base('ok', 0, { bkn: c.bkn }, '')
      return base('ok', 0, c, '')
    } catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }

  /* 群文件下载直链（0x6D6_2）：file_id 从 get_group_file_list 拿 */
  if (action === 'get_group_file_url') {
    try {
      const r = await flash.groupFileUrl({
        group: params.group_id,
        file_id: params.file_id ?? params.fileId,
        bus_id: params.bus_id ?? params.busId
      })
      return base('ok', 0, r, '')
    } catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }

  /* 群文件重命名（0x6D6_4 纯 OIDB）：内核 renameGroupFile 对旁挂会话恒拒，改走 OIDB 通道 */
  if (action === 'set_group_file_name' || action === 'rename_group_file') {
    try {
      const r = await flash.groupFileRename({
        group: params.group_id,
        file_id: params.file_id ?? params.fileId ?? params.uuid,
        new_name: params.new_name ?? params.name ?? params.file_name,
        folder_id: params.folder_id ?? params.parent_folder
      })
      return base('ok', 0, r, '')
    } catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }

  /* 戳一戳统一入口：带 group_id 戳群成员，否则戳好友 */
  if (action === 'send_poke') {
    const inner = params.group_id !== undefined ? 'group_poke' : 'friend_poke'
    const r = await kernel.call(inner, params)
    if (!r.ok) return base('failed', r.retcode || 1500, null, r.err)
    return base('ok', 0, {}, '')
  }

  /* Qzone 网页 CGI + AI 语音（扩展 action） */

  if (action === 'get_qzone_msg_list') {
    try { return base('ok', 0, await qzone.getMsgList(params), '') } catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }
  if (action === 'get_qzone_msg_detail') {
    try { return base('ok', 0, await qzone.getMsgDetail(params), '') } catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }
  if (action === 'get_qzone_feeds') {
    try { return base('ok', 0, await qzone.getFeeds(params), '') } catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }
  if (action === 'send_qzone_msg' || action === 'publish_qzone_msg') {
    try { return base('ok', 0, await qzone.publish(params), '') } catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }
  if (action === 'delete_qzone_msg') {
    try { return base('ok', 0, await qzone.del(params), '') } catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }
  if (action === 'set_qzone_msg_right') {
    try { return base('ok', 0, await qzone.updateRight(params), '') } catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }
  if (action === 'like_qzone' || action === 'unlike_qzone') {
    try { return base('ok', 0, await qzone.like({ ...params, like: action === 'like_qzone' }), '') } catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }
  if (action === 'comment_qzone') {
    try { return base('ok', 0, await qzone.comment(params), '') } catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }
  if (action === 'set_qzone_ban') {
    try { return base('ok', 0, await qzone.setBlack(params), '') } catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }
  if (action === 'upload_qzone_image') {
    try { return base('ok', 0, await qzone.uploadImage(params), '') } catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }
  if (action === 'get_qzone_cookies') {
    try { return base('ok', 0, await qzone.cookiesDebug(), '') } catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }

  /* 群相册：列表（qun_list_album_v2）+ 传图（HTTP sliceUpload 分片） */
  if (action === 'get_group_album_list') {
    try {
      const r = await qzone.albumList({ group: params.group_id })
      return base('ok', 0, r.album.map((a) => ({ album_id: a.id, album_name: a.name, pic_num: a.picNum, create_time: a.createTime, owner: a.owner, owner_nick: a.ownerNick })), '')
    } catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }
  if (action === 'upload_image_to_qun_album') {
    try {
      const r = await qzone.albumUploadImage({
        group: params.group_id,
        album_id: params.album_id,
        album_name: params.album_name,
        image: params.file ?? params.image
      })
      return base('ok', 0, r, '')
    } catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }

  /* 群文件列表（0x6D8_1）：app 侧 flash.js OIDB 直查（旁挂 session 的列表接口不可用） */
  if (action === 'get_group_file_list') {
    try {
      const flash = await import('./flash.js')
      const r = await flash.groupFileList({
        group: params.group_id,
        folder: params.folder_id ?? params.folder ?? '/',
        start: params.start_index ?? 0,
        count: params.count ?? 50
      })
      return base('ok', 0, r, '')
    } catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }

  /* 群文件上传（0x6D6 → Highway 71 → 0x6D9_4 publish；发送回执只有 fileId） */
  if (action === 'upload_group_file') {
    try {
      const r = await kernel.call('upload_group_file', params, 120000)
      if (!r.ok) throw new Error(r.err || r.msg || '上传失败')
      let j = null
      try { j = typeof r.ret === 'string' ? JSON.parse(r.ret) : r.ret } catch { j = null }
      return base('ok', 0, { file_id: j && j.file_id, text: j && j.text }, '')
    } catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }

  if (action === 'upload_video_to_qun_album') {
    try {
      const r = await qzone.albumUploadVideo({
        group: params.group_id,
        album_id: params.album_id,
        album_name: params.album_name,
        video: params.file ?? params.video
      })
      return base('ok', 0, { id: r.id, cover_photo_id: r.cover_photo_id, duration: r.duration, size: r.size }, '')
    } catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }

  /* 闪传（FlashTransfer / fileset） */

  if (action === 'create_flash_task') {
    try {
      const r = await flash.createFlashTask({ files: params.files ?? params.file, name: params.name })
      return base('ok', 0, { fileset_id: r.filesetId, count: r.count, size: r.size }, '')
    } catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }

  if (action === 'send_flash_msg') {
    try {
      const r = await flash.sendFlashMsg({ fileset_uuid: params.fileset_id ?? params.fileset_uuid, group_id: params.group_id, user_id: params.user_id })
      /* 0x93d7 响应无 message_id（分享 fileset 非传统消息），返回 0 */
      return base('ok', 0, { message_id: 0, fileset_id: r.fileset_uuid }, '')
    } catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }

  if (action === 'get_flash_file_list' || action === 'get_fileset_info') {
    try {
      const r = await flash.getFilesetInfo({ fileset_uuid: params.fileset_id ?? params.fileset_uuid })
      return base('ok', 0, r.files, '')
    } catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }

  if (action === 'get_share_link') {
    try {
      const r = await flash.getFilesetInfo({ fileset_uuid: params.fileset_id ?? params.fileset_uuid })
      const hit = (r.files || []).find((f) => f.share_url)
      if (!hit) return base('failed', 1500, null, 'fileset 里没有分享链接')
      return base('ok', 0, { share_url: hit.share_url }, '')
    } catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }

  if (action === 'download_fileset' || action === 'get_flash_file_url') {
    try {
      const r = await flash.getFlashFileUrl({ fileset_uuid: params.fileset_id ?? params.fileset_uuid, file_index: params.file_index })
      return base('ok', 0, { url: r.url, file_name: r.file_name, file_id: r.file_id }, '')
    } catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }

  if (action === 'get_fileset_id') {
    try {
      const r = await flash.getFilesetIdByCode({ share_code: params.share_code ?? params.code ?? params.url })
      return base('ok', 0, { fileset_id: r.fileset_uuid }, '')
    } catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }

  if (action === 'list_flash_filesets') {
    try {
      const r = await flash.listFilesets()
      return base('ok', 0, r.filesets, '')
    } catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }

  if (action === 'delete_flash_file') {
    try {
      const r = await flash.deleteFlashFile({ fileset_uuid: params.fileset_id ?? params.fileset_uuid })
      return base('ok', 0, r, '')
    } catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }

  if (action === 'rename_flash_file') {
    try {
      const r = await flash.renameFlashFile({ fileset_uuid: params.fileset_id ?? params.fileset_uuid, new_name: params.new_name ?? params.name })
      return base('ok', 0, r, '')
    } catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }

  /* 请求审批（OneBot 11 标准 + 扩展） */

  if (action === 'set_friend_add_request') {
    const approve = params.approve == null ? true : (params.approve === true || params.approve === 'true' || params.approve === 1 || params.approve === '1')
    try {
      const r = await approval.setFriendAddRequest({ flag: params.flag ?? params.uid ?? params.user_id, approve })
      return base('ok', 0, r, '')
    } catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }

  if (action === 'set_group_add_request') {
    const approve = params.approve == null ? true : (params.approve === true || params.approve === 'true' || params.approve === 1 || params.approve === '1')
    try {
      const r = await approval.setGroupAddRequest({
        flag: params.flag, seq: params.seq ?? params.sequence,
        group_id: params.group_id, user_id: params.user_id,
        approve, reason: params.reason ?? ''
      })
      return base('ok', 0, r, '')
    } catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }

  if (action === 'get_group_requests' || action === 'get_group_request_list') {
    try {
      const r = await approval.getGroupRequests()
      return base('ok', 0, r.map((x) => ({
        group_id: x.group_id, group_name: x.group_name,
        user_id: x.target_uin, nickname: x.target_name,
        invitor_id: x.invitor_uin, operator_id: x.operator_uin,
        comment: x.comment, seq: x.seq, event_type: x.event_type,
        state: x.state, filtered: x.filtered, flag: x.flag
      })), '')
    } catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }

  if (action === 'get_ai_characters') {
    const r = await kernel.call('get_ai_characters', params, 30000)
    if (!r.ok) return base('failed', r.retcode || 1500, null, r.err)
    try {
      const d = typeof r.ret === 'string' ? JSON.parse(r.ret) : r.ret
      return base('ok', 0, (d.categories || []).map((c) => ({
        type: c.category,
        characters: (c.voices || []).map((v) => ({
          character_id: v.voiceId,
          character_name: v.voiceDisplayName,
          preview_url: v.voiceExampleUrl
        }))
      })), '')
    } catch (e) { return base('failed', 1500, null, 'AI 语音角色列表解析失败：' + String(e.message || e)) }
  }

  if (action === 'get_ai_record') {
    const r = await kernel.call('get_ai_record', params, 60000)
    if (!r.ok) return base('failed', r.retcode || 1500, null, r.err)
    try {
      const d = typeof r.ret === 'string' ? JSON.parse(r.ret) : r.ret
      /* 节点信息原样给出（fileUuid/fileSize/时长）；下载 URL 需要媒体 rkey，暂不提供 */
      return base('ok', 0, { node: d.node, polls: d.polls, status: d.status }, '')
    } catch (e) { return base('failed', 1500, null, 'AI 语音响应解析失败：' + String(e.message || e)) }
  }

  if (action === 'send_group_ai_record') {
    /* 0x929B 合成完成时服务端自己把语音发进群。回执两步走：
       路径一：实时消息事件里 record 段 file_uuid 严格相等（当前事件缺原始元素，大概率落空）；
       路径二：降级扫群历史，按 node.info.md5 匹配文件名 <md5>.amr，注册映射表拿 int id。 */
    const r = await kernel.call('send_group_ai_record', params, 60000)
    if (!r.ok) return base('failed', r.retcode || 1500, null, r.err)
    let d = null
    try { d = typeof r.ret === 'string' ? JSON.parse(r.ret) : r.ret } catch { d = null }
    const uuid = d && d.node && d.node.fileUuid
    if (!uuid) return base('failed', 1500, null, 'AI 语音已合成，但未能获取到发送凭证')
    const gid = num(params.group_id)
    const md5 = d.node && d.node.info && d.node.info.md5
    let receipt = await waitAiVoiceReceipt(gid, uuid, 2500)
    if (!receipt && md5) receipt = await receiptViaHistory(gid, md5, 0, kernel.getSelfId())
    if (!receipt) {
      return base('failed', 1501, null, `AI 语音已发送进群，但暂未获取到消息确认`)
    }
    return base('ok', 0, { message_id: receipt.message_id, kernel_msg_id: receipt.kernelId || null }, '')
  }

  /* 扩展能力（extended.js） */

  /* 推荐联系人卡片 / 小程序卡片（只取 JSON 不发送） */
  if (action === 'share_peer' || action === 'send_ark_share') {
    try {
      if (params.group_id !== undefined) return base('ok', 0, await extended.groupRecommendArk(params.group_id), '')
      if (params.user_id !== undefined) return base('ok', 0, await extended.buddyRecommendArk(params.user_id, params.phone_number), '')
      return base('failed', 1400, null, '需要 group_id 或 user_id')
    } catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }
  if (action === 'share_group_ex' || action === 'send_group_ark_share') {
    try { return base('ok', 0, await extended.groupRecommendArk(params.group_id), '') }
    catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }
  if (action === 'get_mini_app_ark') {
    try { return base('ok', 0, await extended.miniAppArk(params), '') }
    catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }
  if (action === 'send_tuwen_ark') {
    try { return base('ok', 0, await extended.tuwenArkSend(params), '') }
    catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }

  /* 群扩展查询 */
  if (action === 'get_group_at_all_remain') {
    try { return base('ok', 0, await extended.atAllRemain(params.group_id), '') }
    catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }
  if (action === 'get_group_shut_list') {
    /* 内核没有独立禁言列表命令，按成员表 shutUpTime（绝对到期秒）派生 */
    const gid = num(params.group_id)
    if (!gid) return base('failed', 1400, null, '缺少 group_id')
    const r = await kernel.call('get_group_member_list', { group_id: gid }, 20000)
    if (!r.ok) return base('failed', r.retcode || 1500, null, r.err)
    let d = null
    try { d = typeof r.ret === 'string' ? JSON.parse(r.ret) : r.ret } catch { d = null }
    const all = shapeRead('get_group_member_list', d, { group_id: gid })
    const nowSec = Math.floor(Date.now() / 1000)
    const list = all
      .filter((m) => Number(m.shut_up_timestamp ?? m.shutUpTime ?? 0) > nowSec)
      .map((m) => ({ user_id: m.user_id, nickname: m.nickname, shut_up_time: Number(m.shut_up_timestamp ?? m.shutUpTime) }))
    return base('ok', 0, list, '')
  }
  if (action === 'get_group_honor_info') {
    try { return base('ok', 0, await extended.groupHonorInfo(params.group_id, params.type), '') }
    catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }
  if (action === 'get_group_signed_list') {
    try { return base('ok', 0, await extended.groupSignedList(params.group_id), '') }
    catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }
  if (action === 'send_group_sign' || action === 'set_group_sign') {
    try { return base('ok', 0, await extended.groupSign(params.group_id), '') }
    catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }

  /* 好友 / 资料扩展 */
  if (action === 'delete_friend') {
    try { return base('ok', 0, await extended.deleteFriend(params.user_id, params.block), '') }
    catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }
  if (action === 'set_friend_remark') {
    try { return base('ok', 0, await extended.setFriendRemark(params.user_id, params.remark), '') }
    catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }
  if (action === 'set_input_status') {
    try { return base('ok', 0, await extended.setInputStatus(params.user_id, params.event_type), '') }
    catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }
  if (action === 'get_profile_like') {
    try {
      return base('ok', 0, await extended.profileLike(
        params.user_id ?? kernel.getSelfId(),
        params.start,
        params.count ?? params.limit
      ), '')
    } catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }
  if (action === 'set_online_status') {
    try {
      return base('ok', 0, await extended.setOnlineStatus(params.status, params.ext_status, params.battery_status), '')
    } catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }
  if (action === 'set_diy_online_status') {
    try {
      return base('ok', 0, await extended.setDiyOnlineStatus(params.face_id, params.wording, params.face_type), '')
    } catch (e) { return base('failed', 1500, null, String(e.message || e)) }
  }

  /* 已读标记（内核 msgService 原生接口） */
  if (action === 'mark_group_msg_as_read') {
    const r = await kernel.call('mark_group_read', { group_id: params.group_id }, 10000)
    if (!r.ok) return base('failed', r.retcode || 1500, null, r.err)
    return base('ok', 0, {}, '')
  }
  if (action === 'mark_private_msg_as_read') {
    const r = await kernel.call('mark_private_read', { user_id: params.user_id }, 10000)
    if (!r.ok) return base('failed', r.retcode || 1500, null, r.err)
    return base('ok', 0, {}, '')
  }
  if (action === 'mark_msg_as_read') {
    /* 按 message_id 反查所属会话（群/私自动路由）；只给 target_id 时按群处理 */
    if (params.message_id) {
      let meta = null
      try { meta = msgid.metaOf(params.message_id) } catch {}
      if (meta && meta.peer) {
        const r = meta.chatType === 2
          ? await kernel.call('mark_group_read', { group_id: meta.peer }, 10000)
          : await kernel.call('mark_private_read', { user_id: meta.peer }, 10000)
        if (!r.ok) return base('failed', r.retcode || 1500, null, r.err)
        return base('ok', 0, {}, '')
      }
    }
    if (params.group_id !== undefined) {
      const r = await kernel.call('mark_group_read', { group_id: params.group_id }, 10000)
      if (!r.ok) return base('failed', r.retcode || 1500, null, r.err)
      return base('ok', 0, {}, '')
    }
    return base('failed', 1400, null, '需要 message_id（或 group_id）')
  }
  if (action === '_mark_all_as_read') {
    const r = await kernel.call('mark_read_all', {}, 10000)
    if (!r.ok) return base('failed', r.retcode || 1500, null, r.err)
    return base('ok', 0, {}, '')
  }

  /* 多账号：客户端带 self_id 就路由到那个账号，不带就当前账号 */
  const r = params && params.self_id
    ? await kernel.callOn(params.self_id, action, params)
    : await kernel.call(action, params)
  if (r.ok) {
    let data
    try { data = JSON.parse(r.ret) } catch { data = r.ret }
    if (action === 'get_group_msg_history' || action === 'get_friend_msg_history') {
      /* 历史回 {messages: [...]}，空历史也给空数组不报错 */
      data = { messages: shapeRead(action, data, params) }
    } else if (action === 'get_forward_msg') {
      /* 合并转发内容：payload 回 {resId, nodes:[{uin,name,time,segments,text}]}，
         包成 OneBot 口径 {messages: [...]} */
      const nodes = Array.isArray(data) ? data : (data && data.nodes) || []
      data = { messages: nodes, res_id: data && data.resId }
    } else if (action.startsWith('send_')) {
      // 发送类把 int32 message_id 与 raw 回显都给出去。
      // payload 能带真内核 msgId（getLatestDbMsgs 回读），
      // 顺手注册进映射表，客户端拿 message_id 就能直接 delete_msg。
      data = typeof data === 'object' && data && data.message_id !== undefined ? data : { message_id: undefined, raw: data }
      if (data && data.message_id && /^\d{15,}$/.test(String(data.message_id))) {
        try {
          data.message_id = msgid.toOneBotId(String(data.message_id), {
            peer: String(params.group_id ?? params.user_id ?? ''),
            chatType: params.group_id !== undefined ? 2 : 1
          })
        } catch { /* 映射失败保留原样，不阻塞回执 */ }
      }
    } else {
      data = shapeRead(action, data, params)
    }
    return base('ok', 0, data, '')
  }
  return base('failed', r.retcode || 1500, null, r.err)
}

/** 解析一行 "url [专用令牌]"：令牌跟在空格后，URL 里带的 access_token 优先 */
function parseEntry (line) {
  const s = String(line || '').trim()
  if (!s) return null
  const m = s.match(/^(\S+)(?:\s+(\S+))?$/)
  if (!m) return null
  return { url: m[1], token: m[2] || '' }
}

function postEv (target, body) {
  const url = target.url
  let u
  try { u = new URL(url) } catch { return }
  const isHttps = u.protocol === 'https:'
  const mod = isHttps ? https : http
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  const headers = { 'Content-Type': 'application/json', 'Content-Length': payload.length }
  const t = target.token || target.qToken || token
  if (t) headers.Authorization = 'Bearer ' + t
  const maskUrl = () => url.replace(/access_token=[^&]+/, 'access_token=***')
  const req = mod.request({
    hostname: u.hostname,
    port: Number(u.port) || (isHttps ? 443 : 80),
    path: (u.pathname || '/') + (u.search || ''),
    method: 'POST',
    headers,
    timeout: 5000
  }, (res) => {
    res.resume()
    if (res.statusCode && res.statusCode >= 400) {
      const n = (postTries.get(url) || 0) + 1
      postTries.set(url, n)
      if (n <= 2 || n % 20 === 0) bus.warn('onebot', `事件上报收到 HTTP ${res.statusCode} ${maskUrl()}（第 ${n} 次）`)
    } else postTries.delete(url)
  })
  req.on('timeout', () => { req.destroy(new Error('timeout')) })
  req.on('error', (e) => {
    const n = (postTries.get(url) || 0) + 1
    postTries.set(url, n)
    /* 上报地址暂时没开（外部程序没起）很常见：第 1 次警告，之后每 20 次留一条 */
    if (n === 1 || n % 20 === 0) bus.warn('onebot', `事件上报失败 ${maskUrl()}（第 ${n} 次）: ${e.code || e.message || e}`)
  })
  req.end(payload)
}

function broadcast (ev) {
  const line = JSON.stringify(ev)
  for (const c of wsClients) {
    try { c.sock.write(wsFrame(line)) } catch { /* 写失败由 close 统一清理 */ }
  }
  for (const w of revSocks) {
    try { if (w.readyState === 1) w.send(line) } catch { /* 断线由重连逻辑处理 */ }
  }
  for (const p of netHttpClients) {
    if (p.enable === false) continue
    try { postEv(p, ev) } catch { /* 错误在 postEv 里记日志 */ }
  }
}

/** 恒定时间比较：令牌校验不能走 ===（逐字节短路，长度/前缀可被计时侧信道逐段猜出） */
function tokenEq (a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8')
  const bb = Buffer.from(String(b || ''), 'utf8')
  if (ba.length !== bb.length) {
    /* 长度不等也要跑一次比较，避免长度本身泄露 */
    crypto.timingSafeEqual(ba, ba)
    return false
  }
  return crypto.timingSafeEqual(ba, bb)
}

/** entryToken 有值用 entry，否则用统一令牌；都没设 = 仅回环放行 */
function authOk (req, url, entryToken) {
  const t = entryToken || token
  if (!t) return true
  const h = req.headers.authorization || ''
  if (h.startsWith('Bearer ') && tokenEq(h.slice(7), t)) return true
  if (tokenEq(url.searchParams.get('access_token'), t)) return true
  return false
}

/** 浏览器发起的跨站请求一律拒：本机网页以外来的 Origin 不可能是合法客户端 */
function crossSite (req) {
  const origin = String(req.headers.origin || '').trim()
  if (!origin) return false
  return !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin)
}

function readBody (req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('body 过大')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function upgradeHandler (entry) {
  const handler = function (req, sock, head) {
    const url = new URL(req.url, 'http://localhost')
    if (crossSite(req)) {
      sock.write('HTTP/1.1 403 Forbidden\r\n\r\n'); sock.destroy(); return
    }
    if (!authOk(req, url, entry && entry.token)) {
      sock.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); sock.destroy(); return
    }
  const key = req.headers['sec-websocket-key']
  if (!key) { sock.destroy(); return }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64')
  sock.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  )
  const client = { sock, buf: Buffer.alloc(0) }
  wsClients.add(client)
  sock.on('data', (c) => {
    /* 监听重建时被吊销的连接：即使还有残留数据也不许再发指令 */
    if (client.revoked) { try { sock.destroy() } catch {}; return }
    client.buf = Buffer.concat([client.buf, c])
    const { frames, rest } = wsParse(client.buf)
    client.buf = rest
    for (const f of frames) {
      if (f.opcode === 8) { sock.end(); return } // close
      if (f.opcode === 9) sock.write(wsCtrl(0xA, f.payload)) // ping→pong，回显载荷
      if (f.opcode === 1 || f.opcode === 2) {
        try {
          const req = JSON.parse(f.payload.toString('utf8'))
          handleAction(req.action || '', req.params || {}, req.echo)
            .then((resp) => sock.write(wsFrame(JSON.stringify(resp))))
            .catch((e) => sock.write(wsFrame(JSON.stringify({ status: 'failed', retcode: 1500, data: null, message: String(e.message), echo: req.echo }))))
        } catch { /* 非法 JSON 忽略该帧 */ }
      }
    }
  })
  sock.on('error', () => {})
  sock.on('close', () => wsClients.delete(client))
  // 接入即补一条 lifecycle
  try { sock.write(wsFrame(JSON.stringify(kernel ? lifecycleEv() : {}))) } catch {}
  }
  return handler
}

function lifecycleEv () {
  return { post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect', self_id: kernel.getSelfId(), time: Math.floor(Date.now() / 1000) }
}

/* 反向 WS 客户端（自写 RFC6455，带自定义握手头）
   aiocqhttp（AstrBot 的协议端）校验三个头：
     Authorization: Bearer <token>   —— 令牌放 URL query 它不认
     X-Client-Role: Universal        —— 缺了直接 400
     X-Self-ID: <uin>                —— 当 API 路由键用
   Node 全局 WebSocket 加不了自定义头，所以这里用 net/tls 手写握手与分帧：
   客户端帧必须掩码（wsClientFrame），服务端帧不掩码（wsParse 直接可解）。 */

import net from 'node:net'
import tls from 'node:tls'

function wsClientFrame (opcode, body) {
  const mask = crypto.randomBytes(4)
  const len = body.length
  let head
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, 0x80 | len])
  } else if (len < 65536) {
    head = Buffer.alloc(4)
    head[0] = 0x80 | opcode; head[1] = 0x80 | 126; head.writeUInt16BE(len, 2)
  } else {
    head = Buffer.alloc(10)
    head[0] = 0x80 | opcode; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2)
  }
  const masked = Buffer.from(body)
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4]
  return Buffer.concat([head, mask, masked])
}

function connectReverse (entry) {
  const e = typeof entry === 'string' ? (parseEntry(entry) || { url: entry, token: '' }) : (entry || {})
  const urlStr = e.url || ''
  const entryToken = e.token || ''
  const entryName = e.name || ''
  const label = entryName ? entryName + ' ' : ''
  let dead = false
  let sock = null
  let buf = Buffer.alloc(0)
  let handshaken = false
  let selfIdSent = null
  const maskUrl = () => String(urlStr).replace(/access_token=[^&]+/, 'access_token=***')

  let u
  try { u = new URL(urlStr) } catch { bus.warn('onebot', '反向 WS 地址不合法: ' + label + maskUrl()); return }
  const secure = u.protocol === 'wss:'
  const port = Number(u.port) || (secure ? 443 : 80)
  const reqPath = (u.pathname || '/') + (u.search || '')
  const qToken = u.searchParams.get('access_token') || ''
  /* 优先级：URL 里带的 > 该连接专用令牌 > 统一令牌。
     令牌走 Authorization 头（不落 URL，不留日志明文），URL query 兼容老客户端 */
  const auth = qToken || entryToken || token

  /* revSocks 里放的是一个最小 API 句柄：{ readyState, send(line), selfIdSent, url } */
  const api = {
    readyState: 0,
    selfIdSent: null,
    url: urlStr,
    send: (line) => { if (sock && handshaken) sock.write(wsClientFrame(0x1, Buffer.from(String(line), 'utf8'))) },
    _kick: () => { if (sock) { try { sock.end() } catch {} } }
  }
  revSocks.add(api)

  function cleanup (why) {
    if (dead) return
    dead = true
    api.readyState = 0
    if (sock) { try { sock.destroy() } catch {} sock = null }
    revSocks.delete(api)
    if (running) {
      /* 外部客户端没起来时这里每 5 秒断一次：第一次警告，之后降到「详细」，
         否则控制台全是同一条重连，真正的运行日志被刷没了 */
      const n = (revTries.get(urlStr) || 0) + 1
      revTries.set(urlStr, n)
      /* 前 3 次逐条记，之后每分钟（12 次）留一条心跳式记录：
         既不丢「一直连不上」的事实，也不让同一句话淹掉整屏 */
      if (n <= 3 || n % 12 === 0) {
        const line = `反向 WS 断开${label ? ' ' + label : ''}${why ? '（' + why + '）' : ''} ${maskUrl()}，5 秒后重连` +
          (n > 1 ? `（第 ${n} 次尝试，外部程序启动后会自动连接）` : '')
        if (n === 1) bus.warn('onebot', line)
        else bus.debug('onebot', line)
      }
      setTimeout(() => { if (running) connectReverse(e) }, 5000)
    }
  }

  function handshake () {
    const key = crypto.randomBytes(16).toString('base64')
    const selfId = String(kernel.getSelfId() || 0)
    selfIdSent = selfId
    api.selfIdSent = selfId
    const headers = [
      `GET ${reqPath} HTTP/1.1`,
      `Host: ${u.hostname}:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      'X-Client-Role: Universal',
      `X-Self-ID: ${selfId}`
    ]
    if (auth) headers.push(`Authorization: Bearer ${auth}`)
    sock.write(headers.join('\r\n') + '\r\n\r\n')
  }

  function onData (c) {
    buf = Buffer.concat([buf, c])
    if (!handshaken) {
      const idx = buf.indexOf('\r\n\r\n')
      if (idx < 0) {
        if (buf.length > 65536) cleanup('握手响应过大')
        return
      }
      const head = buf.subarray(0, idx).toString('utf8')
      const status = Number((head.split('\r\n')[0] || '').match(/\s(\d{3})\s/)?.[1] || 0)
      if (status !== 101) {
        cleanup('握手被拒 HTTP ' + status + (status === 401 ? '（令牌不对）' : status === 404 ? '（路径不对，通常应是 /ws）' : ''))
        return
      }
      buf = buf.subarray(idx + 4)
      handshaken = true
      api.readyState = 1
      /* 连上了：连续失败计数归零，下次再断又会重新警告 */
      revTries.delete(urlStr)
      bus.ok('onebot', `反向 WebSocket 已连接 ${label}${maskUrl()}（当前连接数：${revSocks.size}）`)
      drain()
      return
    }
    drain()
  }

  function drain () {
    const { frames, rest } = wsParse(buf)
    buf = rest
    for (const f of frames) {
      if (f.opcode === 8) { cleanup('对端关闭'); return }
      if (f.opcode === 9) { sock.write(wsClientFrame(0xa, f.payload)); continue } // ping→pong
      if (f.opcode === 1 || f.opcode === 2) {
        const line = f.payload.toString('utf8')
        let req
        try { req = JSON.parse(line) } catch { continue }
        if (!req || !req.action) continue
        handleAction(req.action, req.params || {}, req.echo)
          .then((resp) => api.send(JSON.stringify(resp)))
          .catch((e) => api.send(JSON.stringify({ status: 'failed', retcode: 1500, data: null, message: String(e.message), echo: req.echo })))
      }
    }
  }

  try {
    sock = secure ? tls.connect({ host: u.hostname, port, servername: u.hostname }) : net.connect({ host: u.hostname, port })
  } catch (e) {
    bus.warn('onebot', '反向 WS 连接失败 ' + maskUrl() + ': ' + (e && e.message ? e.message : e))
    revSocks.delete(api)
    if (running) setTimeout(() => { if (running) connectReverse(e) }, 5000)
    return
  }
  sock.setNoDelay(true)
  sock.on('data', onData)
  sock.on('error', (e) => {
    if (!dead && e && e.code !== 'ECONNREFUSED' && e.code !== 'ECONNRESET') {
      bus.warn('onebot', '反向 WS 错误: ' + (e.code || e.message || 'unknown'))
    }
    cleanup(e.code || e.message || 'error')
  })
  sock.on('close', () => cleanup('socket closed'))
  handshake()
}

/* 归一化网络矩阵：任何来源（新 obNetwork / 旧字段）都收整成同一形状 */
function normalizeNetwork (n) {
  const a = (v) => (Array.isArray(v) ? v : [])
  const str = (v) => String(v ?? '').trim()
  const server = (e, defName) => ({
    name: str(e.name) || defName,
    port: Number(e.port) || 0,
    token: str(e.token),
    enable: e.enable !== false
  })
  const client = (e, defName) => {
    let qToken = ''
    try { qToken = new URL(str(e.url)).searchParams.get('access_token') || '' } catch {}
    return {
      name: str(e.name) || defName,
      url: str(e.url),
      token: str(e.token),
      qToken,
      enable: e.enable !== false
    }
  }
  return {
    httpServers: a(n.httpServers).map((e) => server(e, 'HTTP 服务')).filter((e) => e.port > 0),
    wsServers: a(n.wsServers).map((e) => server(e, '正向 WS')).filter((e) => e.port > 0),
    wsClients: a(n.wsClients).map((e) => client(e, '反向 WS')).filter((e) => /^wss?:\/\//.test(e.url)),
    httpClients: a(n.httpClients).map((e) => client(e, 'HTTP 上报')).filter((e) => /^https?:\/\//.test(e.url))
  }
}

/* 旧版单端口/列表字段 → 网络矩阵（兼容老配置文件） */
function legacyToNetwork (opts = {}) {
  const net = normalizeNetwork({
    httpServers: [{ name: 'HTTP 服务', port: opts.httpPort, token: opts.token, enable: true }],
    wsClients: (Array.isArray(opts.reverseUrls) ? opts.reverseUrls : []).map(parseEntry).filter(Boolean),
    httpClients: (Array.isArray(opts.postUrls) ? opts.postUrls : []).map(parseEntry).filter(Boolean)
  })
  return { token: String(opts.token || ''), ...net }
}

/* 旧版字段 → 网络矩阵时判断「矩阵是不是真空的」：真空才走旧字段迁移，
   否则用户显式删光所有连接会被旧端口又顶回来 */
function netIsEmpty (net) {
  const n = net || {}
  for (const k of ['httpServers', 'wsServers', 'wsClients', 'httpClients']) {
    if (Array.isArray(n[k]) && n[k].length) return false
  }
  return true
}

function currentNet () {
  return { token, httpServers: netHttpServers, wsServers: netWsServers, wsClients: netWsClients, httpClients: netHttpClients }
}

function applyNet (net) {
  token = net.token
  netHttpServers = net.httpServers
  netWsServers = net.wsServers
  netWsClients = net.wsClients
  netHttpClients = net.httpClients
  /* 旧版兼容变量同步（还有零散引用） */
  const first = netHttpServers[0]
  httpPort = first ? first.port : 5760
  revUrls = netWsClients.map((e) => (e.token ? e.url + ' ' + e.token : e.url))
  postUrls = netHttpClients.map((e) => (e.token ? e.url + ' ' + e.token : e.url))
  postTargets = netHttpClients.filter((e) => e.enable !== false)
}

/* 按当前矩阵重建监听（HTTP 服务 + 正向 WS，绑定 LISTEN_HOST） */
function rebuildListeners () {
  /* 先撤销已升级的正向 WS：server.close() 不会关闭升级后的 socket，
     不主动销毁的话，改了令牌或删了监听条目，旧客户端仍能继续调用 API */
  for (const c of wsClients) { try { c.revoked = true; c.sock.destroy() } catch {} }
  wsClients.clear()
  for (const l of listeners) { try { l.srv.close() } catch {} }
  listeners = []
  /* 每条监听都等 listening/error 落地再算数：端口被占用时不能报「已开启」 */
  const openOne = (kind, entry) => new Promise((resolve) => {
    const srv = http.createServer(kind === 'wsServer'
      ? (req, res) => { res.writeHead(426, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'failed', retcode: 1406, message: '此端口只收 WebSocket 连接' })) }
      : apiRequestHandler(entry))
    srv.on('upgrade', upgradeHandler(entry))
    let settled = false
    const finish = (ok, err) => {
      if (settled) return
      settled = true
      resolve({ kind, name: entry.name, port: entry.port, ok, err: err || '' })
    }
    srv.once('error', (e) => {
      const msg = String((e && (e.code || e.message)) || e)
      bus.warn('onebot', entry.name + '（端口 ' + entry.port + '）监听失败: ' + msg)
      finish(false, msg)
    })
    srv.once('listening', () => {
      bus.ok('onebot', entry.name + ' 已开启 ' + (kind === 'wsServer' ? 'ws' : 'http') + '://' + LISTEN_HOST + ':' + entry.port + (entry.token ? '（有令牌）' : '（未设令牌，仅本机）'))
      finish(true)
    })
    try { srv.listen(entry.port, LISTEN_HOST) } catch (e) { finish(false, String((e && e.code) || e)) }
    listeners.push({ kind, entry, srv })
  })
  const jobs = []
  for (const e of netHttpServers) if (e.enable !== false) jobs.push(openOne('httpServer', e))
  for (const e of netWsServers) if (e.enable !== false) jobs.push(openOne('wsServer', e))
  return Promise.all(jobs)
}

/* 反向 WS：全量重连（断旧连新，每个连接自带 5 秒重连） */
function reconnectClients () {
  const olds = [...revSocks]
  revSocks.clear()
  for (const w of olds) { try { w.close() } catch {} }
  for (const e of netWsClients) if (e.enable !== false) connectReverse(e)
}

/* OneBot API 的 HTTP 请求处理器（按连接的专用令牌鉴权） */
function apiRequestHandler (entry) {
  return async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const fail = (code, retcode, msg) => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'failed', retcode, data: null, message: msg }))
    }
    if (req.method !== 'POST') return fail(405, 1405, '仅支持 POST')
    if (crossSite(req)) return fail(403, 1403, '拒绝跨站请求')
    if (!authOk(req, url, entry && entry.token)) return fail(401, 1403, '鉴权失败')

    /* action 三个来源，按 OneBot 11 的惯例依次兜底：
         1) body.action          —— POST / 带 {"action":"..."}（老写法）
         2) 路径 /<action>        —— POST /get_group_list，绝大多数 SDK 都这么发
         3) ?action=<action>      —— 少数客户端走查询串
       body 允许为空：客户端调 /get_group_list 时通常只发 {} 或什么都不发。 */
    const pathAction = url.pathname.split('/').filter(Boolean).join('/')
    let body = {}
    let raw = ''
    try { raw = await readBody(req) } catch { return fail(400, 1406, 'body 过大') }
    if (raw.trim()) {
      let j
      try { j = JSON.parse(raw) } catch { return fail(400, 1406, 'body 不是合法 JSON') }
      if (!j || typeof j !== 'object' || Array.isArray(j)) return fail(400, 1406, 'body 必须是 JSON 对象')
      body = j
    }
    const action = String(body.action || url.searchParams.get('action') || pathAction || '').trim()
    if (!action) return fail(400, 1400, '缺少 action：路径 /<action> 或 body.action 二选一')

    /* params 三种写法：body.params / body 里的平铺字段 / 查询串 */
    let params = body.params
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      const flat = { ...body }
      delete flat.action
      delete flat.params
      delete flat.echo
      if (Object.keys(flat).length) {
        params = flat
      } else {
        const q = {}
        for (const [k, v] of url.searchParams) if (k !== 'action' && k !== 'access_token') q[k] = v
        params = q
      }
    }

    try {
      const resp = await handleAction(action, params, body.echo)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(resp))
    } catch (e) {
      fail(500, 1500, String(e.message))
    }
  }
}

/**
 * @param {{network?:object, httpPort?:number, token?:string, reverseUrls?:string[], postUrls?:string[]}} opts
 */
export async function start (opts = {}) {
  if (running) return { ok: true, httpPort }
  /* 启动迁移：新矩阵是空的而旧字段有值（老配置升级场景）→ 用旧字段生成矩阵 */
  /* 矩阵分支必须把统一令牌带上：normalizeNetwork 只处理连接条目、不返回 token，
     直接拿它喂 applyNet 会把已配置的统一令牌置空，专用令牌留空的条目就此免鉴权 */
  /* 显式空矩阵（键在、数组空）代表用户主动禁用全部连接，不能再按旧字段迁移回来 */
  const hasNetShape = !!(opts.network && typeof opts.network === 'object' &&
    ['httpServers', 'wsServers', 'wsClients', 'httpClients'].some((k) => k in opts.network))
  const net = (hasNetShape || (opts.network && !netIsEmpty(opts.network)))
    ? { ...normalizeNetwork(opts.network || {}), token: String(opts.token || '') }
    : legacyToNetwork(opts)
  applyNet(net)
  running = true
  const listenResults = await rebuildListeners()
  const listenFailed = listenResults.filter((r) => !r.ok)
  reconnectClients()
  hbTimer = setInterval(() => {
    /* self_id 是 AstrBot 的 API 路由键：连上时 uin 还没探到（发了 0），
       后来探到了就必须换头重连，否则它的 API 调用永远路由不到我们 */
    const cur = String(kernel.getSelfId() || 0)
    for (const w of revSocks) {
      if (w.readyState === 1 && w.selfIdSent !== cur) {
        bus.info('onebot', '当前账号已切换为 ' + cur + '，正在重新连接')
        try { w._kick() } catch {}
      }
    }
    broadcast({ post_type: 'meta_event', meta_event_type: 'heartbeat', self_id: kernel.getSelfId(), time: Math.floor(Date.now() / 1000), interval: HEARTBEAT_MS })
  }, HEARTBEAT_MS)
  /* 内核事件 → OneBot 11 事件（kernel.feedKernelEvent 已转好格式）；
     引用要留住，stop 时摘掉，避免热重启后重复广播 */
  kernel.events.on('message', onKernelMessage)
  kernel.events.on('notice', onKernelNotice)
  kernel.events.on('kernel_warning', (e) => events.emit('kernel_warning', e))
  if (listenFailed.length) {
    return { ok: true, httpPort, failed: listenFailed, warn: listenFailed.map((r) => r.name + '（端口 ' + r.port + '）' + r.err).join('；') }
  }
  return { ok: true, httpPort }
}

function onKernelMessage (e) { broadcast(e); events.emit('event', e) }
function onKernelNotice (e) { broadcast(e); events.emit('event', e) }

export function stop () {
  running = false
  if (hbTimer) { clearInterval(hbTimer); hbTimer = null }
  if (revTimer) { clearInterval(revTimer); revTimer = null }
  for (const c of wsClients) { try { c.sock.destroy() } catch {} }
  wsClients.clear()
  for (const w of revSocks) { try { w.close() } catch {} }
  revSocks.clear()
  kernel.events.off('message', onKernelMessage)
  kernel.events.off('notice', onKernelNotice)
  for (const l of listeners) { try { l.srv.close() } catch {} }
  listeners = []
  if (httpSrv) { try { httpSrv.close() } catch {}; httpSrv = null }
  return { ok: true }
}

/**
 * 热更新：网络矩阵任何改动（端口/地址/令牌/启用）都不用重启面板，直接重建监听与连接。
 */
export async function applyConfig (opts = {}) {
  if (!running) return { ok: false }
  const net = opts.network
    ? { ...normalizeNetwork(opts.network), token: String(opts.token || '') }
    : legacyToNetwork(opts)
  if (JSON.stringify(net) === JSON.stringify(currentNet())) return { ok: true, changed: false }
  applyNet(net)
  const listenResults = await rebuildListeners()
  const listenFailed = listenResults.filter((r) => !r.ok)
  reconnectClients()
  if (listenFailed.length) {
    return { ok: true, changed: true, failed: listenFailed, warn: listenFailed.map((r) => r.name + '（端口 ' + r.port + '）' + r.err).join('；') }
  }
  return { ok: true, changed: true }
}

const maskTok = (u) => String(u || '').replace(/access_token=[^&]+/, 'access_token=***')

export function status () {
  const revConnected = (url) => [...revSocks].some((w) => w.readyState === 1 && w.url === url)
  return {
    running,
    httpPort,
    wsClients: wsClients.size,
    network: {
      httpServers: netHttpServers.map((e) => ({ name: e.name, port: e.port, enabled: e.enable !== false, hasToken: !!(e.token || token) })),
      wsServers: netWsServers.map((e) => ({ name: e.name, port: e.port, enabled: e.enable !== false, hasToken: !!(e.token || token) })),
      wsClients: netWsClients.map((e) => ({ name: e.name, url: maskTok(e.url), enabled: e.enable !== false, connected: revConnected(e.url) })),
      httpClients: netHttpClients.map((e) => ({ name: e.name, url: maskTok(e.url), enabled: e.enable !== false }))
    },
    /* 旧版字段（兼容保留） */
    reverse: netWsClients.map((e) => ({ url: maskTok(e.url), connected: revConnected(e.url) })),
    posts: netHttpClients.map((e) => ({ url: maskTok(e.url) }))
  }
}

/* 自测注入点：把事件广播隔离出来方便回环验证 */
export function _broadcastForTest (ev) {
  broadcast(ev)
}
