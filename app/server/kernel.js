import { EventEmitter } from 'node:events'
/* 多账号：bridge 是 accounts.js 里的门面，send/status 作用在「当前账号」上，
   要指名账号用 callOn(uid|pid, ...)。 */
import { bridge } from './accounts.js'
import * as msgid from './msgid.js'
import * as uidmap from './uidmap.js'
import * as store from './store.js'
import { toMessageEvent, toRecallEvent } from './protocol/onebot11.js'

export const events = new EventEmitter()

/** seq 自增，禁随机数 */
let seq = 0
/** seq → {resolve, reject, timer, chunks} */
const pending = new Map()

let transport = null // { send(obj), connected: boolean } — 自测注入点
let selfId = 0 // 登录 uin，由 status 通道填充
let started = false

export function _setTransport (t) {
  transport = t
}

function tx () {
  return transport || bridge
}

function onOpEvent (ev) {
  if (ev.evt === 'op-ok' || ev.evt === 'op-chunk' || ev.evt === 'op-err') {
    const p = pending.get(ev.seq)
    if (!p) return // 无主回执（可能是旧面板/lab 直发），丢弃但不报错
    /* 多账号：回执可能来自另一个 QQ 进程。seq 全局唯一所以本来不会撞，
       但两个账号同时有同名 op 时按 seq 对账更保险的是连 pid 一起核。 */
    if (ev.__pid && p.pid && Number(ev.__pid) !== Number(p.pid)) return
    if (ev.evt === 'op-chunk') {
      p.chunks[ev.idx] = ev.part
      p.got = (p.got || 0) + 1
      if (p.got === ev.total) {
        const full = Array.from({ length: ev.total }, (_, i) => p.chunks[i]).join('')
        pending.delete(ev.seq)
        clearTimeout(p.timer)
        p.resolve({ ok: true, ret: full, name: ev.name })
      }
      return
    }
    pending.delete(ev.seq)
    clearTimeout(p.timer)
    if (ev.evt === 'op-ok') p.resolve({ ok: true, ret: ev.ret, name: ev.name })
    else p.resolve({ ok: false, err: ev.err, name: ev.name })
  }
}

function start () {
  if (started) return
  started = true
  tx().on?.('event', onOpEvent)
  // 自测注入的假传输必须自己派发 'event' 事件，否则走 addEventListener 兜底
  if (typeof tx().addEventListener === 'function') {
    tx().addEventListener('event', (e) => onOpEvent(typeof e.detail === 'object' ? e.detail : e))
  }
}

function blockedHit (params) {
  const gid = params?.group_id
  return Array.isArray(blockedGroups) && blockedGroups.includes(Number(gid) || gid)
}

let blockedGroups = []
export function setBlockedGroups (list) {
  blockedGroups = (Array.isArray(list) ? list : []).map(Number).filter(Number.isInteger)
}
export function getBlockedGroups () {
  return blockedGroups.slice()
}

/* action → op 翻译表。
   口径铁律：translate 输出的 args 必须用 payload/ops.js 的原生字段名
   （id / uid / seconds / on / reject / card / name / text / count），
   不是 OneBot 的 group_id / user_id —— 否则 payload 读不到 id/uid 会报缺参数。 */

/** 会话 peer：群聊直接用群号；私聊必须把 QQ 号解析成 u_ uid */
function buildPeer (params) {
  const isGroup = params.message_type === 'group' || params.group_id !== undefined
  if (isGroup) return { chatType: 2, peerUid: String(params.group_id) }
  const r = uidmap.resolve(params.user_id)
  /* 查不到 uid 也不拦：peerUid 留空由 payload 层给出明确报错
     （提示从成员列表选取，或让对方先发一条消息 —— uid 只有对方先发过消息才学得到）。 */
  return { chatType: 1, peerUid: r.ok ? r.uid : '' }
}

/** 群成员 uid：接受 u_xxx（成员列表里选的）或 QQ 号（查 uidmap）
 *  uidmap 查不到时**原样返回 QQ 号**：交由 payload 层按各接口的实际要求处理。
 *  这里提前拦死会让「按 QQ 号操作」完全失去机会——旁挂 session 根本拿不到 uid↔QQ 映射。 */
function toMemberUid (x) {
  const s = String(x == null ? '' : x).trim()
  if (/^u_[A-Za-z0-9_-]+$/.test(s)) return s
  const r = uidmap.resolve(s)
  return r.ok ? r.uid : s
}

/** 撤回 / 贴表情：从消息 id 反查它属于哪个会话（payload 需要 peer） */
function peerOfMessage (onebotId) {
  const kid = msgid.toKernelId(onebotId)
  if (kid === null) {
    throw new Error(`找不到该消息记录（面板重启后旧消息 ID 已失效）`)
  }
  const m = msgid.metaOf(onebotId)
  if (!m || !m.peer) throw new Error(`找不到该消息所属会话（面板重启前的消息无法直接定位）`)
  return { kid, peer: m.peer, type: m.chatType === 2 ? 'group' : 'private' }
}

function translate (action, params) {
  const p = params || {}
  switch (action) {
    case 'send_msg':
    case 'send_private_msg':
    case 'send_group_msg': {
      if (blockedHit(p)) throw new Error(`群 ${p.group_id} 已在禁止发送名单中，消息未发送`)
      const isGroup = p.message_type === 'group' || p.group_id !== undefined
      const peer = buildPeer(p)
      /* OneBot 消息段数组（含图片/@/表情/回复）走富消息通道；
         纯文本仍走老的 send —— 那条链路最稳，不为了统一去动它。 */
      if (Array.isArray(p.message)) {
        const segs = []
        const arkEls = []
        for (const s of p.message) {
          if (typeof s === 'string') { segs.push({ type: 'text', text: s }); continue }
          const t = s && s.type
          /* 两种形状都收：OneBot 的 {type,data:{...}} 和实验台的 {type,...扁平} */
          const d = (s && s.data && typeof s.data === 'object') ? s.data : (s || {})
          if (t === 'text') segs.push({ type: 'text', text: String(d.text ?? '') })
          else if (t === 'at') {
            const qq = String(d.qq ?? d.uin ?? '')
            if (qq === 'all') segs.push({ type: 'at', all: true })
            else segs.push({ type: 'at', uin: Number(qq) || 0, name: d.name })
          } else if (t === 'face') segs.push({ type: 'face', id: Number(d.id) || 0 })
          else if (t === 'image') segs.push({ type: 'image', path: String(d.file ?? d.path ?? ''), summary: d.summary })
          else if (t === 'reply') segs.push({ type: 'reply', seq: Number(d.seq) || 0, uin: Number(d.qq) || 0 })
          /* json 段（卡片）。和 text 可以混排，和图片/@等不能（卡片走 ms.sendMsg
             通道，不支持富媒体段）；卡片内容必须是合法 JSON 对象或字符串 */
          else if (t === 'json') {
            let j = d.data ?? d.json ?? d.text ?? ''
            if (typeof j === 'object') j = JSON.stringify(j)
            const str = String(j)
            try { JSON.parse(str) } catch { throw new Error('json 段内容不是合法 JSON，卡片未发送') }
            arkEls.push(str)
          }
          else throw new Error(`不支持的消息段：${t}`)
        }
        if (arkEls.length) {
          if (segs.some((s) => s.type !== 'text')) {
            throw new Error('json 卡片只能和文字混排，不能和图片/@/表情等同发')
          }
          return {
            name: 'arkSendRaw',
            args: {
              type: isGroup ? 'group' : 'private',
              peer: p.group_id ?? p.user_id,
              peerUid: isGroup ? '' : (peer.peerUid || ''),
              elements: [
                ...segs.filter((s) => s.type === 'text' && s.text).map((s) => ({ text: s.text })),
                ...arkEls.map((j) => ({ json: j }))
              ]
            }
          }
        }
        if (!segs.every((s) => s.type === 'text')) {
          return {
            name: 'sendRich',
            args: {
              type: isGroup ? 'group' : 'private',
              id: p.group_id ?? p.user_id,
              peerUid: isGroup ? '' : (peer.peerUid || ''),
              segments: segs
            }
          }
        }
      }
      return {
        name: 'send',
        args: {
          type: isGroup ? 'group' : 'private',
          id: p.group_id ?? p.user_id,
          /* OneBot 标准字段是 message，lab 层传的也是 message，两个都收 */
          text: p.text ?? (Array.isArray(p.message)
            ? p.message.map((s) => (typeof s === 'string' ? s : String((s && s.data && s.data.text) ?? ''))).join('')
            : p.message),
          message: p.message,
          peer // 私聊要用 u_ uid 当 peerUid，见 buildPeer
        }
      }
    }
    /* 发视频：NTV2 0x11EA/0x11E9 双子文件上传 + commonElem(serviceType 48, biz 21/11) */
    case 'send_video':
      if (blockedHit(p)) throw new Error(`群 ${p.group_id} 已在禁止发送名单中，消息未发送`)
      return {
        name: 'sendVideo',
        args: {
          type: (p.message_type === 'group' || p.group_id !== undefined) ? 'group' : 'private',
          id: p.group_id ?? p.user_id,
          path: String(p.file ?? p.path ?? ''),
          name: p.name ? String(p.name) : '',
          peerUid: (p.message_type === 'group' || p.group_id !== undefined) ? '' : (buildPeer(p).peerUid || '')
        }
      }
    /* 群文件上传：0x6D6_0 申请 → Highway cmdId 71 直传 → 0x6D9_4 publish（三段式） */
    case 'upload_group_file':
      if (blockedHit(p)) throw new Error(`群 ${p.group_id} 已在禁止发送名单中，消息未发送`)
      return {
        name: 'uploadFile',
        args: {
          type: 'group',
          id: p.group_id,
          path: String(p.file ?? p.path ?? ''),
          name: p.name ? String(p.name) : '',
          folder: String(p.folder ?? '/')
        }
      }
    /* 发图片：内核自己那套上传接口对旁挂会话不可用，payload 走富媒体通道。
       flash=1 → NT 原生通道（picElement.isFlashPic=true 走内核 sendMsg，QQ 自己上传组包）；
       旧 serviceType=3 通道会出「闪电图标+碎裂+无限充能」，不可用 */
    case 'send_image':
      if (blockedHit(p)) throw new Error(`群 ${p.group_id} 已在禁止发送名单中，消息未发送`)
      if (p.flash ?? p.flash_pic) {
        return {
          name: 'sendFlashNT',
          args: {
            type: (p.message_type === 'group' || p.group_id !== undefined) ? 'group' : 'private',
            id: p.group_id ?? p.user_id,
            path: String(p.file ?? p.path ?? ''),
            peerUid: (p.message_type === 'group' || p.group_id !== undefined) ? '' : (buildPeer(p).peerUid || '')
          }
        }
      }
      return {
        name: 'sendImage',
        args: {
          type: (p.message_type === 'group' || p.group_id !== undefined) ? 'group' : 'private',
          id: p.group_id ?? p.user_id,
          path: String(p.file ?? p.path ?? ''),
          name: p.name ? String(p.name) : '',
          peerUid: (p.message_type === 'group' || p.group_id !== undefined) ? '' : (buildPeer(p).peerUid || ''),
          summary: p.summary ? String(p.summary) : '',
          flash: !!(p.flash ?? p.flash_pic),
          flashExt: !!(p.flash_ext ?? p.flash),
          flashRes: !!(p.flash_res ?? p.flash),
          extF3: !!(p.ext_f3 ?? p.flash_ext_f3),
          extF4: !!(p.ext_f4 ?? p.flash_ext_f4)
        }
      }
    case 'delete_msg': {
      /* 常规路径：映射表里的 int32 id。补充路径：客户端拿 get_group_msg_history
         返回的 19 位内核 msgId 来撤（不在映射表内），此时要求 params 里带
         group_id / user_id 定位会话 —— 大数不能盲撤，没有会话就明确拒绝。 */
      const kid = msgid.toKernelId(p.message_id)
      if (kid !== null) {
        const m = peerOfMessage(p.message_id)
        return { name: 'recall', args: { type: m.type, id: m.peer, msgId: m.kid } }
      }
      const raw = String(p.message_id ?? '')
      if (/^\d{15,}$/.test(raw) && (p.group_id || p.user_id)) {
        return { name: 'recall', args: { type: p.group_id !== undefined ? 'group' : 'private', id: String(p.group_id ?? p.user_id), msgId: raw } }
      }
      throw new Error(`找不到该消息 ID；如查询历史消息，请同时指定群号或好友 QQ 号`)
    }
    case 'get_msg': {
      /* 补充路径先行：直接给 19 位内核 msgId + 会话（发送侧回执只有 seq/random，没进映射表） */
      const raw = String(p.message_id ?? '')
      if (/^\d{15,}$/.test(raw) && (p.group_id || p.user_id)) {
        return { name: 'getMsg', args: { type: p.group_id !== undefined ? 'group' : 'private', id: String(p.group_id ?? p.user_id), msgId: raw } }
      }
      const m = peerOfMessage(p.message_id)
      return { name: 'getMsg', args: { type: m.type, id: m.peer, msgId: m.kid } }
    }
    case 'get_login_info':
      return { name: 'selfInfo', args: {} }
    case 'get_status':
      return { name: 'services', args: {} }
    /* 实验台撤回：直接给内核 msgId + 会话（不走 OneBot message_id 映射表，
       19 位 msgId 一旦过 Number 就丢精度，…140147 会变成 …141000） */
    case 'recall_kernel':
      return { name: 'recall', args: {
        type: p.chat_type === 'group' ? 'group' : 'private',
        id: String(p.peer ?? ''),
        msgId: String(p.msg_id ?? '')
      } }
    /* 开发期只读探测：枚举服务方法名。没有面板入口，只有 /api/lab/invoke 能调 */
    case 'probe':
      return { name: 'probe', args: { g: p.g, re: p.re } }
    /* 开发期：在 QQ 进程内跑 JS（挖方法签名/源码），面板无入口 */
    case 'dev_eval':
      return { name: 'devEval', args: { js: String(p.js ?? '') } }
    /* 开发期：挂内核 listener 看推送 */
    case 'kernel_listen':
      return { name: 'kernelListen', args: { svc: p.svc, show: !!p.show } }
    /* 开发期实调：验证内核方法真实签名与返回形态 */
    case 'probe_call':
      return { name: 'probeCall', args: { g: p.g, m: p.m, args: p.args } }
    /* QQ 号 → 内核 uid：requestInfoByAccount，点赞等必须真 uid 的功能兜底用 */
    case 'find_uid':
      return { name: 'findUid', args: { uin: String(p.uin ?? p.user_id ?? p.uid ?? '') } }
    /* 最近消息（群/好友）：getLatestDbMsgs 真历史通道。getMsgsIncludeSelf 也能用
       （peer, 起始msgId|'0', count, includeSelf），参数传错只会拿到空结果 */
    case 'get_group_msg_history':
      return { name: 'msgHistory', args: { type: 'group', id: String(p.group_id ?? ''), count: p.count } }
    case 'get_friend_msg_history': {
      /* C2C 历史 peerUid 必须是 u_ uid（传 QQ 号 getLatestDbMsgs 恒空数组），
         有聊过记录的 uidmap 里都有 */
      const r = uidmap.resolve(String(p.user_id ?? ''))
      return { name: 'msgHistory', args: { type: 'private', id: r.ok ? r.uid : String(p.user_id ?? ''), count: p.count } }
    }
    /* 精华：payload 自己用 getMsgsByMsgId 补 msgSeq/msgRandom，调用方给 群号+msgId */
    case 'set_essence_msg':
      return { name: 'essenceAdd', args: { id: String(p.group_id ?? ''), msgId: String(p.message_id ?? '') } }
    case 'delete_essence_msg':
      return { name: 'essenceDel', args: { id: String(p.group_id ?? ''), msgId: String(p.message_id ?? '') } }
    case 'get_essence_msg_list':
      return { name: 'essenceList', args: { id: String(p.group_id ?? '') } }
    case 'get_group_system_msg':
      return { name: 'groupNotify', args: {} }
    case 'get_group_album_list':
      return { name: 'albumMain', args: { id: String(p.group_id ?? '') } }
    /* 合并转发：节点上传走 SsoSendLongMsg 裸包，卡片走 sendMsg+arkElement
       （见 payload/longmsg.js 头注释）。内核 forward 家族对本 session 恒 result=5，不可用 */
    case 'send_group_forward_msg':
    case 'send_private_forward_msg':
    case 'send_forward_msg': {
      if (blockedHit(p)) throw new Error(`群 ${p.group_id} 已在禁止发送名单中，消息未发送`)
      const isGroup = p.message_type === 'group' || p.group_id !== undefined
      const rawNodes = Array.isArray(p.messages) ? p.messages : []
      if (!rawNodes.length) throw new Error('合并转发内容不能为空')
      const peerObj = isGroup ? null : buildPeer(p)
      const nodes = rawNodes.map((n) => {
        const d = (n && n.data && typeof n.data === 'object') ? n.data : (n || {})
        const segs = []
        const content = d.content ?? d.message ?? (typeof d === 'string' ? d : '')
        if (typeof content === 'string') {
          segs.push({ type: 'text', text: content })
        } else if (Array.isArray(content)) {
          for (const s of content) {
            if (typeof s === 'string') { segs.push({ type: 'text', text: s }); continue }
            const t = s && s.type
            const dd = (s && s.data && typeof s.data === 'object') ? s.data : (s || {})
            if (t === 'text') segs.push({ type: 'text', text: String(dd.text ?? '') })
            else if (t === 'at') {
              const qq = String(dd.qq ?? dd.uin ?? '')
              if (qq === 'all') segs.push({ type: 'at', all: true })
              else segs.push({ type: 'at', uin: Number(qq) || 0, name: dd.name })
            } else if (t === 'face') segs.push({ type: 'face', id: Number(dd.id) || 0 })
            else segs.push({ type: 'text', text: `[${t} 元素暂不支持出现在转发节点里]` })
          }
        }
        return {
          uin: Number(d.uin ?? d.user_id) || 0,
          name: String(d.name ?? d.nickname ?? ''),
          time: Number(d.time) || undefined,
          segments: segs
        }
      })
      return {
        name: 'forwardSend',
        args: {
          type: isGroup ? 'group' : 'private',
          peer: isGroup ? String(p.group_id ?? '') : String(p.user_id ?? ''),
          peerUid: isGroup ? '' : (peerObj.peerUid || ''),
          nodes
        }
      }
    }
    case 'get_forward_msg': {
      const rid = p.res_id ?? p.forward_id
      if (rid) return { name: 'forwardGet', args: { resId: String(rid) } }
      const kid = msgid.toKernelId(p.message_id)
      if (!kid) throw new Error(`找不到该转发消息记录（只能查询当前运行期间发送的卡片）`)
      const meta = msgid.metaOf(p.message_id) || {}
      return {
        name: 'forwardGet',
        args: {
          msgId: kid,
          type: Number(meta.chatType) === 1 ? 'private' : 'group',
          peer: String(meta.peer || (p.group_id ?? p.user_id ?? ''))
        }
      }
    }
    case 'emoji_likes_list':
      return { name: 'emojiLikesList', args: { id: String(p.group_id ?? ''), msgSeq: String(p.msgSeq ?? '') } }
    /* OIDB 通道（payload/qzone.js，Buffer 口径）：OIDB 145 不可用的根因是
       Uint8Array 被 napi coerce 成字符串，改传 Buffer 即可用 */
    case 'get_client_key':
      return { name: 'oidbClientKey', args: {} }
    case 'get_pskey':
      return { name: 'oidbPskey', args: { domains: Array.isArray(p.domains) && p.domains.length ? p.domains.map(String) : ['qzone.qq.com'] } }
    /* AI 语音（OIDB 0x929D/0x929B；0x929B 合成完成时服务端
       自己把语音发进群，客户端只做收据关联，见 onebot-server send_group_ai_record） */
    case 'get_ai_characters':
      return { name: 'aiVoiceList', args: { group: String(p.group_id ?? ''), chatType: Number(p.chat_type) || 1 } }
    case 'oidb_raw':
      /* 通用 OIDB 通道：app 侧拼包（flash.js），payload 只收发（qzone.js oidbRaw） */
      return { name: 'oidbRaw', args: { cmd: Number(p.cmd), sub: Number(p.sub) || 0, bodyHex: String(p.body_hex ?? p.bodyHex ?? ''), uinForm: !!p.uin_form, wireName: String(p.wire_name ?? '') } }
    case 'sso_raw':
      /* 通用裸包通道（LightAppSvc / trpc 等非 OIDB 信封命令） */
      return { name: 'ssoRaw', args: { cmd: String(p.cmd ?? ''), bodyHex: String(p.body_hex ?? p.bodyHex ?? '') } }
    /* 已读标记（内核 msgService.setMsgRead） */
    case 'mark_group_read':
      return { name: 'markRead', args: { type: 'group', id: String(p.group_id ?? '') } }
    case 'mark_private_read':
      return { name: 'markRead', args: { type: 'private', id: String(p.user_id ?? ''), peerUid: (buildPeer(p).peerUid || String(p.user_id ?? '')) } }
    case 'mark_read_all':
      return { name: 'markReadAll', args: {} }
    case 'get_ai_record':
    case 'send_group_ai_record':
      if (blockedHit(p)) throw new Error(`群 ${p.group_id} 在禁止发送名单内`)
      return { name: 'aiVoice', args: { group: String(p.group_id ?? ''), voiceId: String(p.character ?? p.voice_id ?? ''), text: String(p.text ?? ''), chatType: Number(p.chat_type) || 1, maxPolls: Number(p.max_polls) || 30 } }
    case 'get_friend_list':
      return { name: 'friendList', args: {} }
    case 'get_group_list':
      return { name: 'groupList', args: {} }
    case 'get_group_directory':
      /* 结构化群列表（面板群号下拉用），payload 回 JSON 串 */
      return { name: 'groupDirectory', args: {} }
    case 'get_group_member_list':
      return { name: 'groupMembers', args: { id: String(p.group_id ?? '') } }
    case 'get_recent_contact':
      return { name: 'recentList', args: {} }
    case 'set_group_ban':
      if (blockedHit(p)) throw new Error(`群 ${p.group_id} 在禁止发送名单内`)
      return { name: 'groupMute', args: { id: p.group_id, uid: toMemberUid(p.user_id), seconds: p.duration } }
    case 'set_group_whole_ban':
      if (blockedHit(p)) throw new Error(`群 ${p.group_id} 在禁止发送名单内`)
      return { name: 'groupMuteAll', args: { id: p.group_id, on: !!p.enable } }
    case 'set_group_kick':
      if (blockedHit(p)) throw new Error(`群 ${p.group_id} 在禁止发送名单内`)
      return { name: 'groupKick', args: { id: p.group_id, uid: toMemberUid(p.user_id), reject: !!p.reject_add_request } }
    case 'set_group_admin':
      if (blockedHit(p)) throw new Error(`群 ${p.group_id} 在禁止发送名单内`)
      return { name: 'groupSetAdmin', args: { id: p.group_id, uid: toMemberUid(p.user_id), on: !!p.enable } }
    case 'set_group_card':
      if (blockedHit(p)) throw new Error(`群 ${p.group_id} 在禁止发送名单内`)
      return { name: 'groupCard', args: { id: p.group_id, uid: toMemberUid(p.user_id), card: String(p.card ?? '') } }
    case 'set_group_name':
      if (blockedHit(p)) throw new Error(`群 ${p.group_id} 在禁止发送名单内`)
      return { name: 'groupName', args: { id: p.group_id, name: p.group_name ?? p.name } }
    case 'send_group_notice':
      if (blockedHit(p)) throw new Error(`群 ${p.group_id} 在禁止发送名单内`)
      return { name: 'groupAnnounce', args: { id: p.group_id, text: p.content ?? p.text } }
    /* 群文件系（旁挂可用子集，见 docs/report-p5-heavy-actions.md） */
    case 'get_group_file_space':
      return { name: 'groupSpace', args: { id: String(p.group_id ?? '') } }
    case 'get_group_file_count':
      return {
        name: 'groupFileCount',
        args: Array.isArray(p.group_ids) && p.group_ids.length
          ? { ids: p.group_ids.map(String) }
          : { id: String(p.group_id ?? '') }
      }
    case 'create_group_folder':
      if (blockedHit(p)) throw new Error(`群 ${p.group_id} 在禁止发送名单内`)
      return { name: 'groupFolderCreate', args: { id: p.group_id, name: p.name ?? p.folder_name } }
    case 'delete_group_folder':
      if (blockedHit(p)) throw new Error(`群 ${p.group_id} 在禁止发送名单内`)
      return { name: 'groupFolderDelete', args: { id: p.group_id, folderId: p.folder_id ?? p.fid } }
    case 'delete_group_file':
      if (blockedHit(p)) throw new Error(`群 ${p.group_id} 在禁止发送名单内`)
      return { name: 'groupFileDelete', args: { id: p.group_id, fileId: p.file_id ?? p.fileId ?? p.uuid, folderId: p.folder_id } }
    case 'set_group_file_name':
    case 'rename_group_file': /* 注意：内核 renameGroupFile 对旁挂会话恒拒，
        正常路径是 OneBot 层/实验台直走 flash.groupFileRename（OIDB 0x6D6_4），这里是最后的兜底 */
      if (blockedHit(p)) throw new Error(`群 ${p.group_id} 在禁止发送名单内`)
      return { name: 'groupFileRename', args: { id: p.group_id, fileId: p.file_id ?? p.fileId ?? p.uuid, name: p.name ?? p.new_name ?? p.file_name, folderId: p.folder_id } }
    case 'move_group_file':
      if (blockedHit(p)) throw new Error(`群 ${p.group_id} 在禁止发送名单内`)
      return { name: 'groupFileMove', args: { id: p.group_id, fileId: p.file_id ?? p.fileId ?? p.uuid, folderId: p.folder_id, fromFolderId: p.from_folder_id } }
    case 'friend_poke':
      /* 原生 MSF 戳一戳只要目标 QQ 号（OIDB uin 字段），不再需要 findUid 查 peerUid */
      return { name: 'poke', args: { type: 'private', uid: String(p.user_id) } }
    case 'group_poke':
      if (blockedHit(p)) throw new Error(`群 ${p.group_id} 在禁止发送名单内`)
      return { name: 'poke', args: { type: 'group', id: p.group_id, uid: String(p.user_id) } }
    case 'send_like': {
      /* QQ 号与 uid 都带上，由 payload 层按接口字段名自行取用
         （uidmap 有记录时只传 uid 会把 QQ 号丢掉）。 */
      const raw = String(p.user_id ?? '')
      const r = uidmap.resolve(raw)
      return { name: 'like', args: { uid: r.ok ? r.uid : raw, uin: raw, count: p.times } }
    }
    case 'set_qq_profile':
      return {
        name: 'profileSet',
        args: { nick: p.nickname ?? p.nick, sign: p.personal_sign ?? p.personal_note ?? p.sign }
      }
    case 'set_msg_emoji_like': {
      const rawId = String(p.message_id ?? '')
      /* 先看是不是内核原生的 seq/msgId（getMsgs 读历史拿到的）：
         msgid 表里是 int32，Number 化大数必丢精度，不能先查表。
         kseq 标记 = 实验台明确说这是内核侧编号。 */
      if (/^\d{15,}$/.test(rawId) || p.kseq) {
        return {
          name: 'emojiLike',
          args: { id: String(p.group_id ?? p.user_id ?? ''), msgId: rawId, code: String(p.emoji_id ?? p.reaction_id ?? 128077) }
        }
      }
      const m = peerOfMessage(p.message_id)
      return {
        name: 'emojiLike',
        args: { id: m.peer, msgId: m.kid, code: String(p.emoji_id ?? p.reaction_id ?? 128077) }
      }
    }
    case 'get_version_info':
      return null // 静态信息，不进内核
    default:
      throw new Error(`暂不支持该功能：${action}`)
  }
}

/**
 * @param {string} action OneBot 11 action
 * @param {object} params
 * @param {number} [timeoutMs=15000]
 * @returns {Promise<{ok:true, ret:string, name:string} | {ok:false, err:string, retcode:number}>}
 */
/* 私聊发送只认 uid（u_xxx），光给 QQ 号 payload 会直接拒。
 * 发之前如果 uid 表里没有这个号，就用好友列表补一次，省得用户还要先让对方发消息。 */
function needsPeerUid (action, p) {
  if (!p) return false
  const priv = action === 'send_private_msg' ||
    (action === 'send_msg' && p.group_id === undefined && p.user_id !== undefined)
  if (!priv) return false
  const u = String(p.user_id ?? p.qq ?? '')
  return !!u && !/^u_/.test(u) && !uidmap.resolve(u).ok
}

async function seedFriendUidTable (timeoutMs) {
  try {
    const r = await callOn(null, 'get_friend_list', {}, timeoutMs)
    if (!r || !r.ok) return
    let d = r.ret
    if (typeof d === 'string') { try { d = JSON.parse(d) } catch { return } }
    const arr = Array.isArray(d) ? d : (d && (d.list || d.friends || d.data)) || []
    uidmap.seedFromBuddyList(arr.map((f) => ({
      user_id: f.user_id ?? f.uin ?? (f.uid ? uidmap.toQq(f.uid) : undefined),
      uid: f.uid
    })))
  } catch { /* 补表失败就让后续按原逻辑报错，别把真实原因盖掉 */ }
}

export async function call (action, params = {}, timeoutMs = 15000) {
  return callOn(null, action, params, timeoutMs)
}

/**
 * 指名账号调用。key 可以是最号 uin 或进程 pid，空 = 当前账号。
 * @param {string|number|null} key
 * @param {string} action
 * @param {object} params
 * @param {number} [timeoutMs=15000]
 */
export async function callOn (key, action, params = {}, timeoutMs = 15000) {
  start()
  if (needsPeerUid(action, params)) await seedFriendUidTable(timeoutMs)
  let t
  try {
    t = translate(action, params)
  } catch (e) {
    return { ok: false, err: e.message, retcode: 1400 } // 参数/翻译层错误
  }
  if (t === null) {
    if (action === 'get_version_info') {
      return { ok: true, ret: JSON.stringify({ app_name: 'FrishLuna', protocol: 'OneBot v11' }), name: action }
    }
    return { ok: false, err: '未实现', retcode: 1404 }
  }
  const acct = key ? bridge.byKey(key) : bridge.current()
  if (!acct || !acct.bridge.connected) {
    return {
      ok: false,
      err: key ? `账号 ${key} 未连接（请确认 QQ 已正常启动）` : '消息服务未连接（请确认 QQ 已正常启动并登录）',
      retcode: 1404
    }
  }
  seq += 1
  const my = seq
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(my)
      resolve({ ok: false, err: `QQ 响应超时（${timeoutMs}ms）：${action}`, retcode: 1401 })
    }, timeoutMs)
    pending.set(my, { resolve, timer, chunks: {}, got: 0, pid: acct.pid })
    try {
      acct.bridge.send({ cmd: 'op', name: t.name, args: t.args, seq: my })
    } catch (e) {
      pending.delete(my)
      clearTimeout(timer)
      resolve({ ok: false, err: '消息连接发送失败：' + e.message, retcode: 1402 })
    }
  })
}

/** 是否连接 */
export function status () {
  const online = !!(tx().connected)
  return {
    online,
    uin: selfId,
    endpoint: { from: '内置', pid: tx().pid ?? null },
    msgidSize: msgid.size(),
    uidmapSize: uidmap.size(),
    blockedGroups: getBlockedGroups()
  }
}

/** 管道回环探活；顺带补 selfId（OneBot 事件与外部客户端都靠它识别本号） */
export async function probe () {
  const t0 = Date.now()
  if (!tx().connected) return { ok: false, online: false, ms: 0 }
  const r = await call('get_login_info', {}, 8000)
  if (r.ok && !selfId) {
    try {
      const info = typeof r.ret === 'string' ? JSON.parse(r.ret) : r.ret
      const uin = info && (info.uin || info.user_id)
      if (uin) setSelfId(uin)
    } catch {}
  }
  return { ok: r.ok, online: true, ms: Date.now() - t0, err: r.ok ? undefined : r.err }
}

function deps (ev) {
  /* 多账号：事件自带 __selfId（accounts.js 打上去的），没有才退回全局 */
  const sid = Number((ev && ev.__selfId) || selfId) || 0
  return { toOneBotId: msgid.toOneBotId, toQq: (u) => uidmap.toQq(u), selfId: sid }
}

/** host 侧把内核原始消息喂进来（index.js 接 inbound/payload 事件后调它） */
export function feedKernelEvent (ev) {
  if (!ev || typeof ev !== 'object') return
  if (ev.evt === 'msg' && Array.isArray(ev.list)) {
    const d = deps(ev)
    for (const m of ev.list) {
      const e = toMessageEvent(m, d)
      if (!e) continue
      /* 入站消息落库：重启后面板还能查历史，撤回也能按 id 找到会话 */
      try {
        store.saveMessage({
          account: String(d.selfId || (ev.__pid || '')),
          kernelId: String(m.msgId || ''),
          messageId: e.message_id,
          chatType: e.message_type === 'group' ? 2 : 1,
          peer: String(e.group_id || e.user_id || ''),
          senderUin: String(e.user_id || ''),
          senderNick: String((e.sender && e.sender.nickname) || ''),
          time: (Number(e.time) || 0) * 1000 || Date.now(),
          text: String(e.raw_message || '')
        })
      } catch { /* 存不了不影响事件派发 */ }
      events.emit('message', e)
    }
  } else if (ev.evt === 'msg-recall') {
    const e = toRecallEvent(ev.args ?? ev.raw, deps(ev))
    if (e) events.emit('notice', e)
  } else if (ev.evt === 'poke') {
    const e = toPokeEvent(ev, deps(ev))
    if (e) events.emit('notice', e)
  } else if (ev.evt === 'inbound-timeout') {
    events.emit('kernel_warning', { kind: 'inbound-timeout', tries: ev.tries, lastErr: ev.lastErr })
  }
}

/** 收到内核原始消息里的 uid 增量回填 uidmap */
export function feedUidCandidate (list) {
  if (Array.isArray(list)) uidmap.backfill(list)
}

/** 事件观察层（watch.js）产出的 notice 直接派发到 OneBot 订阅方 */
export function pushNotice (e) {
  if (e && e.post_type) events.emit('notice', e)
}

/** uin 由 host 在拿到登录态时注入 */
export function setSelfId (uin) {
  selfId = Number(uin) || 0
}
export function getSelfId () {
  return selfId
}

/* 重置（配置变更时） */
export function reset () {
  msgid.reset()
}

/* 启动：协议端是内置的，这里只挂事件 */
export async function boot () {
  start()
  return { ok: true, mode: 'builtin' }
}
