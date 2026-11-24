import * as kernel from './kernel.js'
import * as groups from './groups.js'
import * as uidmap from './uidmap.js'
import * as msgid from './msgid.js'
import { load as loadCfg } from './config.js'
import * as qz from './qzone.js'
import { AsyncLocalStorage } from 'node:async_hooks'

/* 多账号：一次 run() 调用期间「这次操作打给哪个账号」，跟着异步上下文走，
   并发两个账号的调用也不会串。空 = 当前账号。 */
const als = new AsyncLocalStorage()

/* 目标编号（群号 / QQ 号）统一口径：5~12 位纯数字。 */
const QQ_ID_RE = /^\d{5,12}$/
/** 内核成员 uid（u_xxx）：群成员类接口真正认的是它，不是 QQ 号 */
const MEMBER_UID_RE = /^u_[A-Za-z0-9_-]+$/

/** @returns {number} 合法返回数字，非法返回 0 */
function toQqId (x) {
  const s = String(x == null ? '' : x).trim()
  return QQ_ID_RE.test(s) ? Number(s) : 0
}

/**
 * 成员标识：群管理接口（禁言 / 踢人 / 名片 / 管理员）在内核里要的是 uid，
 * 但人只会记得 QQ 号。这里两种都收：u_ 开头原样用，QQ 号查 uidmap。
 * @returns {{uid:string}|{err:string}}
 */
function toMember (x) {
  const s = String(x == null ? '' : x).trim()
  if (MEMBER_UID_RE.test(s)) return { uid: s }
  if (!QQ_ID_RE.test(s)) return { err: '请填写成员 QQ 号或选择群成员' }
  const r = uidmap.resolve(s)
  /* uidmap 里没这条照样放行：交由 payload 层按接口实际要求处理，
     两边都不行时 payload 会带回完整人话错误，不在这里提前拦死。 */
  return { uid: r.ok ? r.uid : s }
}

/**
 * 禁止发送的群号：取 config.blockedGroups（默认空）。
 * 只拦「发」，收消息照常记录。
 */
function isBlocked (id) {
  const list = (loadCfg().blockedGroups || [])
  return list.includes(String(id))
}

async function ok (act, params, pick) {
  try {
    const d = await call(act, params)
    /* payload 的回执照例是一句人话（「已发送到 群 123」）：直接当 msg 用，
       不再套 `${act} 成功`，否则面板还得自己猜这句英文 action 名是啥 */
    const text = (d && typeof d === 'object' && typeof d.text === 'string') ? d.text : ''
    return {
      ok: true,
      msg: text || `${act} 成功`,
      data: pick ? pick(d) : (text ? undefined : d)
    }
  } catch (e) {
    /* payload 的报错自己就是一句人话（「setMemberShutUp 失败：目标 uid 不在这个群里」），
       再套一层 `${act} 失败：` 会变成两个冒号，看着像复读机。 */
    const m = String((e && e.message) || '调用失败')
    return { ok: false, msg: m.includes('失败') ? m : `${act} 失败：${m}`, retcode: e.retcode }
  }
}

/* 单测注入点：默认走内核；测试可替换成假后端（_setCall(null) 恢复默认）。
   kernel.call 的回执是 { ok, ret:string }，这里转回 lab 一贯的「resolve 数据 /
   throw 带 retcode 的错误」，上层 ok()/listOp() 的写法不用改。 */
async function defaultCall (act, params, timeoutMs) {
  const tgt = als.getStore()
  const r = tgt
    ? await kernel.callOn(tgt, act, params || {}, timeoutMs || 15000)
    : await kernel.call(act, params || {}, timeoutMs || 15000)
  if (!r || !r.ok) {
    const e = new Error((r && r.err) || (act + ' 失败'))
    e.retcode = (r && r.retcode) || 0
    throw e
  }
  if (r.ret == null || r.ret === '') return {}
  if (typeof r.ret !== 'string') return r.ret
  const s = r.ret.trim()
  /* 只有长得像 JSON 才解析：否则原样包成 {text}，别把「成员列表为空」这种
     人话塞进 {ret} 里，再让上层误以为拿到了数据 */
  if (/^[[{]/.test(s)) {
    try { return JSON.parse(s) } catch { /* 落到下面按文本处理 */ }
  }
  return { text: s }
}
let callImpl = defaultCall
function call (act, params, timeoutMs) { return callImpl(act, params, timeoutMs) }
export function _setCall (fn) { callImpl = fn || defaultCall }

export async function send ({ type, id, text }) {
  const t = String(text || '')
  /* 只发空格/换行也能过 truthy 检查，会真的往群里发一条空消息。
     判空要看 trim 后的结果，但发送时保留原文，不动用户排版。 */
  if (!t.trim()) return { ok: false, msg: '消息内容为空（不能只发空格或换行）' }
  /* 类型只认这两个值：其余（含拼错的 'grop'）一律拒绝，绝不静默走成私聊 */
  if (type !== 'group' && type !== 'private') {
    return { ok: false, msg: 'type 必须是 group 或 private' }
  }
  const target = toQqId(id)
  if (!target) {
    return { ok: false, msg: type === 'group' ? '群号必须是 5~12 位数字' : '好友 QQ 号必须是 5~12 位数字' }
  }
  /* payload 回的是内核 msgId；面板「撤回」要的是 OneBot int32 id。
     顺手把 peer / chatType 记进 msgid 表 —— recall 就是靠这张表反查会话的，
     不登记就会出现「发完能拿到 id，但撤回说不在映射表里」。 */
  const sendPick = (peer, chatType) => (d) => {
    const kid = d && d.message_id
    if (!kid) return { message_id: null }
    return { message_id: msgid.toOneBotId(String(kid), { peer: String(peer), chatType }) }
  }
  if (type === 'group') {
    if (isBlocked(target)) return { ok: false, msg: '该群已在禁止发送列表中' }
    return ok('send_group_msg', { group_id: target, message: t }, sendPick(target, 2))
  }
  return ok('send_private_msg', { user_id: target, message: t }, sendPick(target, 1))
}

export async function sendImage ({ type = 'group', id, path: file, name, summary, flash, flashExt, flashRes } = {}) {
  const t = (type === 'private') ? 'private' : 'group'
  const target = toQqId(id)
  if (!target) return { ok: false, msg: (t === 'group' ? '群号' : '好友 QQ 号') + '必须是 5~12 位数字' }
  const f = String(file || '').trim()
  if (!f) return { ok: false, msg: '要填本机图片的完整路径' }
  if (t === 'group' && isBlocked(target)) return { ok: false, msg: '该群已在禁止发送列表中' }
  try {
    const d = await call('send_image', t === 'group'
      ? { group_id: target, file: f, name, summary, flash, flashExt, flashRes }
      : { user_id: target, file: f, name, summary, flash, flashExt, flashRes }, 180000)
    return { ok: true, msg: (d && d.text) || '图片已发送', data: d }
  } catch (e) {
    return { ok: false, msg: e.message, retcode: e.retcode }
  }
}

export async function poke ({ type, id, uid: u }) {
  if (type !== 'group' && type !== 'private') {
    return { ok: false, msg: 'type 必须是 group 或 private' }
  }
  const target = toQqId(u)
  if (!target) return { ok: false, msg: '对方 QQ 号必须是 5~12 位数字' }
  /* poke 的失败原因 payload 已经写成完整人话（含「不是填错」的说明），
     这里不再套 "戳一戳失败：" 的前缀，避免一句话两个冒号。 */
  if (type === 'group') {
    const gid = toQqId(id)
    if (!gid) return { ok: false, msg: '群号必须是 5~12 位数字' }
    try {
      const d = await call('group_poke', { group_id: gid, user_id: target })
      return { ok: true, msg: `已戳 ${target}`, data: d }
    } catch (e) {
      return { ok: false, msg: e.message, retcode: e.retcode }
    }
  }
  try {
    const d = await call('friend_poke', { user_id: target })
    return { ok: true, msg: `已戳 ${target}`, data: d }
  } catch (e) {
    return { ok: false, msg: e.message, retcode: e.retcode }
  }
}

export async function recall ({ msgId, id, type = 'group' }) {
  const mid = String(msgId || '').trim()
  if (!mid) return { ok: false, msg: '缺少消息 ID' }
  const peer = String(id || '').trim()
  if (!peer) return { ok: false, msg: '缺少目标群号或好友 QQ 号（撤回消息需要）' }
  return ok('recall_kernel', {
    peer,
    chat_type: type === 'private' ? 'private' : 'group',
    msg_id: mid
  })
}

export async function emojiLike ({ msgId, code, id, seq }) {
  if (!msgId) return { ok: false, msg: '缺少消息 ID' }
  const params = { message_id: /^\d{15,}$/.test(String(msgId)) ? String(msgId) : (Number(msgId) || msgId), emoji_id: String(code || '128077') }
  const isKernelSeq = !!seq || /^\d{15,}$/.test(String(msgId))
  if (isKernelSeq && id) {
    if (/^\d+$/.test(String(id)) && String(id).length >= 5) params.group_id = String(id)
    else params.user_id = String(id)
  }
  if (isKernelSeq) params.kseq = true
  return ok('set_msg_emoji_like', params)
}

export async function like ({ uid: u, count }) {
  /* 目标两种都收：uid（u_ 开头）或 QQ 号。QQ 号查不到 uid 时自动 findUid
     （getProfileService.getUidByUin）并回填 uidmap —— 从没聊过的号也能赞。 */
  const s = String(u == null ? '' : u).trim()
  if (!MEMBER_UID_RE.test(s) && !QQ_ID_RE.test(s)) {
    return { ok: false, msg: '好友请填写 5~12 位 QQ 号' }
  }
  if (!MEMBER_UID_RE.test(s) && !uidmap.resolve(s).ok) {
    const fr = await findUid({ uid: s })
    if (!fr.ok) return { ok: false, msg: '获取成员信息失败，无法点赞：' + fr.msg }
  }
  const n = Math.min(20, Math.max(1, Number(count) || 1))
  return ok('send_like', { user_id: s, times: n })
}

export async function profileSet ({ nick, sign }) {
  const p = {}
  if (nick) p.nickname = String(nick)
  if (sign) p.personal_note = String(sign)
  if (!Object.keys(p).length) return { ok: false, msg: '昵称和签名至少填一个' }
  return ok('set_qq_profile', p)
}

export async function selfInfo () {
  const r = await ok('get_login_info', {}, (d) => d)
  if (r.ok && r.data) {
    const d = r.data
    r.msg = `本号 ${d.uin || '?'}${d.nick ? '（' + d.nick + '）' : ''}${d.fromGroup ? ' · 从群 ' + d.fromGroup + ' 的历史消息里认出' : ''}`
  }
  return r
}

export async function friendList () {
  const r = await listOp('friendList', 'get_friend_list', {}, '好友', normFriend)
  /* 顺手把「QQ ↔ uid」灌进 uidmap：私聊发送、名片赞、群管都要靠它 */
  if (r.ok) {
    try {
      uidmap.seedFromBuddyList(r.list.map((f) => ({ user_id: f.user_id, uid: f.uid })))
    } catch {}
  }
  return r
}

export async function groupList () {
  /* 9.9.36 的 getGroupList(true) 常回空（缓存没建好），真正的群名列表
     走 onGroupListUpdate 分片推送（payload 已积累成群目录）。优先目录。 */
  try {
    const d = await call('get_group_directory', {}, 12000)
    const dir = Array.isArray(d) ? d : (d && (d.items || d.groups || d.dir)) || []
    const items = dir.map(normGroup).filter(Boolean)
    if (items.length) return { ok: true, msg: `群目录（${items.length} 个群）`, list: items }
  } catch { /* 目录失败继续兜底 */ }
  /* 群目录还没积累好时，退回面板持久化的 groups.json（入站消息学的群名） */
  try {
    const local = groups.list()
    if (local.length) {
      return {
        ok: true,
        msg: `群列表（${local.length} 个群，来自本地缓存；正在同步最新列表）`,
        list: local.map(normGroup).filter(Boolean)
      }
    }
  } catch {}
  return listOp('groupList', 'get_group_list', {}, '群', normGroup)
}

export async function recentList () {
  return listOp('recentList', 'get_recent_contact', {}, '最近会话', normRecent)
}

/**
 * 服务状态清单：三项分别查，失败信息逐项保留。
 * 三项全失败 ⇒ ok:false；部分失败 ⇒ ok:true，但 data 里失败的那项标 failed。
 */
export async function services () {
  const names = ['status', 'version', 'login']
  const acts = ['get_status', 'get_version_info', 'get_login_info']
  const settled = await Promise.allSettled(acts.map((a) => call(a, {}, 5000)))

  const data = {}
  const failed = []
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      data[names[i]] = r.value
    } else {
      const why = (r.reason && r.reason.message) || '未知原因'
      data[names[i]] = { failed: true, error: why }
      failed.push(`${names[i]}(${acts[i]}): ${why}`)
    }
  })

  if (failed.length === acts.length) {
    return { ok: false, msg: `无法获取服务状态：${failed.join(' / ')}`, data }
  }
  if (failed.length) {
    return { ok: true, msg: `服务状态清单（${failed.length}/${acts.length} 项失败）`, data }
  }
  return { ok: true, msg: '服务状态清单', data }
}

export async function groupMembers ({ id }) {
  const gid = toQqId(id)
  if (!gid) return { ok: false, msg: '群号必须是 5~12 位数字' }
  /* 成员列表里只有 uid（u_xxx）和序号，没有名字。能反查到 QQ 就一起带上，
     面板的「成员」下拉用它显示，选人后填的是 uid（内核群管接口认这个）。 */
  const r = await listOp('gm:' + gid, 'get_group_member_list', { group_id: gid }, '成员', (m) => {
    const uid = String((m && (m.uid || m.peerUid)) || '')
    if (!uid) return null
    return { uid, qq: uidmap.toQq(uid) || String((m && m.qq) || ''), nick: (m && m.nick) || '', card: (m && m.card) || '' }
  })
  /* payload 侧名片反查若成功，会随回执带 qq+uid 明细 —— 有多少收多少回填 uidmap：
     这是「对方没发过消息也能换 uid」的本地通道（getAllMemberList + 名片接口）。 */
  if (r.ok) {
    const pairs = (r.list || []).filter((m) => m.qq && /^u_/.test(m.uid))
      .map((m) => ({ user_id: m.qq, uid: m.uid }))
    if (pairs.length) uidmap.backfill(pairs)
  }
  if (r.ok && !r.list.some((m) => m.qq)) {
    r.msg += '（暂无该成员昵称与 QQ 号）'
  }
  return r
}

/** 群管类公共前置：群号 + 成员（uid 或 QQ） */
function groupTarget ({ id, uid: u }) {
  const gid = toQqId(id)
  if (!gid) return { err: '群号必须是 5~12 位数字' }
  const m = toMember(u)
  if (m.err) return { err: m.err }
  return { gid, uid: m.uid }
}

export async function groupMute ({ id, uid: u, seconds }) {
  const t = groupTarget({ id, uid: u })
  if (t.err) return { ok: false, msg: t.err }
  const dur = Math.max(0, Number(seconds) || 0)
  return ok('set_group_ban', { group_id: t.gid, user_id: t.uid, duration: dur })
}

export async function groupMuteAll ({ id, on }) {
  const gid = toQqId(id)
  if (!gid) return { ok: false, msg: '群号必须是 5~12 位数字' }
  return ok('set_group_whole_ban', { group_id: gid, enable: !!on })
}

export async function groupKick ({ id, uid: u, reject }) {
  const t = groupTarget({ id, uid: u })
  if (t.err) return { ok: false, msg: t.err }
  return ok('set_group_kick', { group_id: t.gid, user_id: t.uid, reject_add_request: !!reject })
}

export async function groupSetAdmin ({ id, uid: u, on }) {
  const t = groupTarget({ id, uid: u })
  if (t.err) return { ok: false, msg: t.err }
  return ok('set_group_admin', { group_id: t.gid, user_id: t.uid, enable: !!on })
}

export async function groupCard ({ id, uid: u, card }) {
  const t = groupTarget({ id, uid: u })
  if (t.err) return { ok: false, msg: t.err }
  return ok('set_group_card', { group_id: t.gid, user_id: t.uid, card: String(card || '') })
}

export async function groupName ({ id, name }) {
  const gid = toQqId(id)
  if (!gid) return { ok: false, msg: '群号必须是 5~12 位数字' }
  if (!name) return { ok: false, msg: '缺少新群名' }
  return ok('set_group_name', { group_id: gid, group_name: String(name) })
}

/**
 * 群公告：OneBot 11 没有标准 action。
 * 各家实现的命名不一致（有的 send_group_notice，有的只认带下划线的
 * _send_group_notice —— 那是私有扩展）。这里按顺序试，并把实际生效的
 * action 名回给面板，避免悄悄依赖某一家的私有扩展。
 */
const NOTICE_ACTIONS = ['send_group_notice', '_send_group_notice']

export async function groupAnnounce ({ id, text }) {
  const gid = toQqId(id)
  if (!gid) return { ok: false, msg: '群号必须是 5~12 位数字' }
  if (!text) return { ok: false, msg: '缺少公告内容' }

  const errs = []
  for (const act of NOTICE_ACTIONS) {
    try {
      await call(act, { group_id: gid, content: String(text) })
      const ext = act.startsWith('_') ? '（扩展功能）' : ''
      return { ok: true, msg: `公告已发布`, data: { action: act, extension: act.startsWith('_') } }
    } catch (e) {
      errs.push(`${act}: ${e.message}`)
      /* 只有「action 不存在」才值得试下一个；业务错误（没权限等）直接报 */
      if (!/not found|unsupported|未知|不支持|no such/i.test(e.message)) {
        return { ok: false, msg: `${act} 失败：${e.message}`, retcode: e.retcode }
      }
    }
  }
  return { ok: false, msg: `当前 QQ 暂不支持发布群公告：${errs.join(' / ')}` }
}

/* 群文件系（走内核扩展 action，见 payload/ops.js） */
export async function groupSpace ({ id }) {
  const gid = toQqId(id)
  if (!gid) return { ok: false, msg: '群号必须是 5~12 位数字' }
  return ok('get_group_file_space', { group_id: gid })
}

export async function groupFileCount ({ id, ids }) {
  /* 面板一个输入框填多个群（逗号隔开）也能用 */
  const raw = Array.isArray(ids) && ids.length ? ids
    : String(id || '').split(/[,，\s]+/).filter(Boolean)
  const list = raw.map(toQqId).filter(Boolean)
  if (!list.length) return { ok: false, msg: '群号必须是 5~12 位数字（多个用逗号隔开）' }
  return ok('get_group_file_count', list.length > 1 ? { group_ids: list } : { group_id: list[0] })
}

export async function groupFolderCreate ({ id, name }) {
  const gid = toQqId(id)
  if (!gid) return { ok: false, msg: '群号必须是 5~12 位数字' }
  if (!name) return { ok: false, msg: '缺少文件夹名' }
  return ok('create_group_folder', { group_id: gid, name: String(name) })
}

export async function groupFolderDelete ({ id, folderId, fid }) {
  const gid = toQqId(id)
  if (!gid) return { ok: false, msg: '群号必须是 5~12 位数字' }
  const f = String(folderId ?? fid ?? '')
  if (!f) return { ok: false, msg: '缺少 folderId' }
  return ok('delete_group_folder', { group_id: gid, folder_id: f })
}

export async function groupFileDelete ({ id, fileId, uuid, folderId }) {
  const gid = toQqId(id)
  if (!gid) return { ok: false, msg: '群号必须是 5~12 位数字' }
  const f = String(fileId ?? uuid ?? '')
  if (!f) return { ok: false, msg: '缺少群文件 ID' }
  return ok('delete_group_file', { group_id: gid, file_id: f, folder_id: folderId })
}

export async function groupFileRename ({ id, fileId, uuid, name, folderId }) {
  const gid = toQqId(id)
  if (!gid) return { ok: false, msg: '群号必须是 5~12 位数字' }
  const f = String(fileId ?? uuid ?? '')
  if (!f) return { ok: false, msg: '缺少群文件 ID' }
  if (!name) return { ok: false, msg: '缺少新文件名' }
  /* 内核 renameGroupFile 对旁挂会话恒拒（result 非 0），改走 OIDB 0x6D6_4（flash.js） */
  const t0 = Date.now()
  try {
    const mod = await import('./flash.js')
    const r = await mod.groupFileRename({ group: gid, file_id: f, new_name: String(name), folder_id: folderId })
    return { ok: true, op: 'group_file_rename', human: '重命名群文件', msg: '已改名为「' + r.new_name + '」', data: r, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, op: 'group_file_rename', human: '重命名群文件', msg: String(e.message || e), ms: Date.now() - t0 }
  }
}

export async function groupFileMove ({ id, fileId, uuid, folderId, fromFolderId }) {
  const gid = toQqId(id)
  if (!gid) return { ok: false, msg: '群号必须是 5~12 位数字' }
  const f = String(fileId ?? uuid ?? '')
  if (!f) return { ok: false, msg: '缺少群文件 ID' }
  return ok('move_group_file', { group_id: gid, file_id: f, folder_id: folderId, from_folder_id: fromFolderId })
}

/* 查询类 op 的缓存：只用于面板回显，加 LRU 上限避免 gm:<群号> 无限堆积 */
const CACHE_MAX = 64
const cacheMap = new Map()

function cachePut (key, val) {
  if (cacheMap.has(key)) cacheMap.delete(key)
  cacheMap.set(key, val)
  while (cacheMap.size > CACHE_MAX) {
    const oldest = cacheMap.keys().next().value
    cacheMap.delete(oldest)
  }
}

export function cacheSize () { return cacheMap.size }
export { CACHE_MAX }

/* 查询类 op 共用：拿到列表顺便缓存，面板要展示时直接用。
   payload 的返回可能是数组、{list}、或者一句「列表为空」的人话 —— 三种都认。 */
function asList (d) {
  if (Array.isArray(d)) return d
  if (d && Array.isArray(d.list)) return d.list
  if (d && typeof d === 'object' && Array.isArray(d.items)) return d.items
  return null
}

async function listOp (key, act, params, label, mapper) {
  try {
    const d = await call(act, params)
    const arr = asList(d)
    if (!arr) {
      const why = (d && typeof d.text === 'string' && d.text) ||
        `未获取到${label}列表（可能尚未同步完成，稍后再试）`
      return { ok: false, msg: why }
    }
    const list = mapper ? arr.map(mapper).filter(Boolean) : arr
    cachePut(key, list)
    return { ok: true, msg: `${label} ${list.length} 个`, list }
  } catch (e) {
    return { ok: false, msg: `${act} 失败：${e.message}`, retcode: e.retcode }
  }
}

/* 内核原始对象 → 面板口径（统一字段名，前端不用猜） */

function normGroup (g) {
  const id = g && (g.group_id || g.groupCode || g.groupUin || g.id)
  if (!id) return null
  return {
    group_id: String(id),
    group_name: String(g.group_name || g.groupName || g.name || ''),
    member_count: Number(g.member_count || g.memberCount || g.members || 0) || 0
  }
}

function normFriend (b) {
  if (!b) return null
  const qq = String(b.user_id || b.uin || b.qq || '')
  const uid = String(b.uid || '')
  if (!qq && !uid) return null
  return {
    user_id: qq,
    uid,
    nickname: String(b.nick || b.nickname || b.remark || ''),
    remark: String(b.remark || '')
  }
}

function normRecent (c) {
  if (!c) return null
  const isGroup = Number(c.chatType) === 2
  const raw = String(c.peerUid || '')
  if (!raw) return null
  return {
    group_id: isGroup ? raw : undefined,
    user_id: isGroup ? undefined : (uidmap.toQq(raw) || raw),
    nickname: String(c.peerName || c.remark || ''),
    chat_type: isGroup ? '群' : '好友',
    last_uin: String(c.last_uin || ''),
    last_text: String(c.last_text || ''),
    msg_seq: String(c.msgSeq || ''),
    msg_time: Number(c.msgTime || c.sendTime || 0) || 0
  }
}

/* 开发期只读探测：枚举内核服务方法名。只列名字不调用，没有面板入口，
   只有 /api/lab/invoke 能调 —— 找原生 API 时用，找完这功能就不再公开。 */
export async function probe ({ g, re } = {}) {
  const gs = String(g || '').trim()
  if (!/^[A-Za-z_$][\w$]*$/.test(gs)) return { ok: false, msg: '服务 getter 名不合法' }
  const r = await kernel.call('probe', { g: gs, re: String(re || '.') }, 8000)
  if (!r.ok) return { ok: false, msg: '探测失败：' + (r.err || '未知') }
  const v = typeof r.ret === 'string' ? r.ret : JSON.stringify(r.ret)
  return { ok: true, msg: v || '（空返回）' }
}

export async function kernelListen ({ svc, show } = {}) {
  const r = await kernel.call('kernel_listen', { svc: String(svc || 'buddy'), show: !!show }, 15000)
  if (!r.ok) return { ok: false, msg: '监听消息失败：' + (r.err || '未知') }
  return { ok: true, msg: typeof r.ret === 'string' ? r.ret : JSON.stringify(r.ret) }
}

export async function probeCall ({ g, m, args, wait } = {}) {
  const gs = String(g || '').trim()
  if (!/^[A-Za-z_$][\w$]*$/.test(gs)) return { ok: false, msg: '服务 getter 名不合法' }
  const ms = String(m || '').trim()
  if (!/^[A-Za-z_$][\w$]*$/.test(ms)) return { ok: false, msg: '方法名不合法' }
  const argv = Array.isArray(args) ? args : []
  const timeout = Math.min(Math.max(Number(wait) || 12000, 1000), 60000)
  const r = await kernel.call('probe_call', { g: gs, m: ms, args: argv }, timeout)
  if (!r.ok) return { ok: false, msg: '调用失败：' + (r.err || '未知') }
  return { ok: true, msg: typeof r.ret === 'string' ? r.ret : JSON.stringify(r.ret) }
}

/** 表情回应查询（只读）：验证贴表情是否真的生效。 */
export async function emojiLikesList ({ id, msgSeq, msgId } = {}) {
  const gid = toQqId(id)
  if (!gid) return { ok: false, msg: '群号必须是 5~12 位数字' }
  const s = String(msgSeq || msgId || '').trim()
  if (!s) return { ok: false, msg: '缺少消息序号' }
  const d = await call('emoji_likes_list', { group_id: gid, msgSeq: s }, 10000)
  return { ok: true, msg: (d && d.text) || '（空返回）' }
}

/** 最近消息（群/好友）：返回 msgId 明细，供撤回/贴表情取真实内核 msgId。 */
export async function getMsgs ({ type = 'group', id, count } = {}) {
  const gid = toQqId(id)
  if (!gid) return { ok: false, msg: (type === 'group' ? '群号' : '好友号') + '必须是 5~12 位数字' }
  const n = Math.min(30, Math.max(1, Number(count) || 10))
  const act = type === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history'
  const d = await call(act, type === 'group' ? { group_id: gid, count: n } : { user_id: gid, count: n }, 15000)
  /* 内核通道会把 JSON 串直接解析成数组/对象，text 形态只作兜底 */
  let rows = Array.isArray(d) ? d : null
  let raw = d && typeof d === 'object' && !Array.isArray(d) ? d : null
  if (!rows && !raw) { try { rows = JSON.parse(String(d ?? 'null')) } catch { rows = null } }
  if (!rows && raw && typeof raw.text === 'string') {
    try { const j = JSON.parse(raw.text); if (Array.isArray(j)) rows = j } catch { /* 保持 null */ }
  }
  if (raw && raw.empty) return { ok: false, msg: `当前会话暂未读取到消息` }
  if (!Array.isArray(rows) || !rows.length) return { ok: false, msg: raw ? JSON.stringify(raw).slice(0, 300) : '读不到最近消息' }
  /* 回执里 uin + uid 成对出现 —— 白捡的 uidmap 回填来源 */
  const pairs = rows.filter((x) => /^\d{5,12}$/.test(String(x.uin || '')) && /^u_/.test(String(x.uid || '')))
    .map((x) => ({ user_id: x.uin, uid: x.uid }))
  if (pairs.length) uidmap.backfill(pairs)
  return { ok: true, msg: `最近 ${rows.length} 条`, list: rows }
}

/** QQ 号 → 内核 uid：getProfileService.getUidByUin。uidmap 靠对方发消息回填，
 *  从没聊过的号查不到 —— 这里主动查并回填 uidmap（下次点赞/私聊直接命中）。 */
export async function findUid ({ uid } = {}) {
  const s = String(uid == null ? '' : uid).trim()
  if (!QQ_ID_RE.test(s)) return { ok: false, msg: '要一个 5~12 位 QQ 号' }
  const d = await call('find_uid', { uin: s }, 10000)
  /* payload 的 mapper 回 JSON 串，defaultCall 解析后就是对象本身（不走 text） */
  let info = (d && d.uin && d.uid) ? d : null
  if (!info) {
    const raw = (d && d.text) || ''
    try { const j = JSON.parse(raw); if (j && j.uin && j.uid) info = j } catch { info = null }
  }
  if (info && info.uid && info.uin) {
    const n = uidmap.backfill([{ user_id: info.uin, uid: info.uid }])
    return { ok: true, msg: `QQ ${info.uin} → ${info.uid}`, data: info, seeded: n }
  }
  return { ok: true, msg: (d && (d.text || JSON.stringify(d))) || '（空返回）' }
}

/** 开发期探测：在 QQ 进程内跑一段 JS（只给 /api/lab/invoke 用，面板无入口）。 */
export async function devEval ({ js, wait } = {}) {
  const code = String(js || '')
  if (!code) return { ok: false, msg: '缺少 js' }
  const timeout = Math.min(Math.max(Number(wait) || 12000, 1000), 60000)
  const r = await kernel.call('dev_eval', { js: code }, timeout)
  if (!r.ok) return { ok: false, msg: '调用失败：' + (r.err || '未知') }
  return { ok: true, msg: typeof r.ret === 'string' ? r.ret : JSON.stringify(r.ret) }
}

/* 富消息：文字 / @ / 表情 / 图片 / 回复 混排，一次发出。
   segments 原样透传给 payload（media.js 按顺序组包） */
export async function sendRich ({ type = 'group', id, segments } = {}) {
  const t = (type === 'private') ? 'private' : 'group'
  const target = toQqId(id)
  const segs = Array.isArray(segments) ? segments : []
  if (!target) return { ok: false, msg: (t === 'group' ? '群号' : '好友 QQ 号') + '必须是 5~12 位数字' }
  if (!segs.length) return { ok: false, msg: '消息段为空' }
  if (t === 'group' && isBlocked(target)) return { ok: false, msg: '该群已在禁止发送列表中' }
  const map = { text: 'text', at: 'at', face: 'face', image: 'image', reply: 'reply' }
  for (const s of segs) {
    if (!s || !map[s.type]) return { ok: false, msg: `不支持的消息段：${s && s.type}` }
  }
  try {
    const d = await call('send_msg', {
      message_type: t,
      ...(t === 'group' ? { group_id: target } : { user_id: target }),
      message: segs
    }, 180000)
    return { ok: true, msg: (d && d.text) || '已发送', data: d }
  } catch (e) {
    return { ok: false, msg: e.message, retcode: e.retcode }
  }
}

/* get_msg / 历史 / 精华 / 群通知 / 相册 */

export async function msgHistory ({ type = 'group', id, count } = {}) {
  const gid = toQqId(id)
  if (!gid) return { ok: false, msg: '群号 / 好友号必须是 5~12 位数字' }
  const p = Number(count) > 0 ? { count: Math.min(50, Number(count)) } : {}
  return type === 'private'
    ? ok('get_friend_msg_history', { user_id: gid, ...p })
    : ok('get_group_msg_history', { group_id: gid, ...p })
}

/* 精华参数直接收内核 msgId（19 位大数）—— payload 侧自己回读补 seq/random */
export async function essenceSet ({ id, msg_id: mid }) {
  const gid = toQqId(id)
  if (!gid || !mid) return { ok: false, msg: '需要提供群号与消息 ID' }
  return ok('set_essence_msg', { group_id: gid, message_id: String(mid) })
}

export async function essenceDel ({ id, msg_id: mid }) {
  const gid = toQqId(id)
  if (!gid || !mid) return { ok: false, msg: '需要群号与消息 ID' }
  return ok('delete_essence_msg', { group_id: gid, message_id: String(mid) })
}

export async function essenceList ({ id }) {
  const gid = toQqId(id)
  if (!gid) return { ok: false, msg: '群号必须是 5~12 位数字' }
  return ok('get_essence_msg_list', { group_id: gid })
}

export async function groupSystemMsg () {
  return ok('get_group_system_msg', {})
}

export async function albumMain ({ id }) {
  const gid = toQqId(id)
  if (!gid) return { ok: false, msg: '群号必须是 5~12 位数字' }
  return ok('get_group_album_list', { group_id: gid })
}

/* 合并转发：nodes 直接给 [{uin,name,time,segments:[{type,text,...}]}]，
   节点上传走 SsoSendLongMsg 裸包，卡片走 sendMsg+arkElement（payload/longmsg.js） */
export async function forwardSend ({ type = 'group', id, peer_uid: peerUid, nodes, nodes_json: nodesJson } = {}) {
  const gid = toQqId(id)
  if (!gid) return { ok: false, msg: '目标必须是 5~12 位数字' }
  let list = Array.isArray(nodes) ? nodes : null
  if (!list && nodesJson) {
    try { list = JSON.parse(String(nodesJson)) } catch { return { ok: false, msg: '节点 JSON 解析失败' } }
  }
  if (!Array.isArray(list) || !list.length) return { ok: false, msg: '节点为空' }
  return ok('send_forward_msg', { message_type: type === 'private' ? 'private' : 'group', group_id: type !== 'private' ? gid : undefined, user_id: type === 'private' ? gid : undefined, peer_uid: peerUid, messages: list.map(function (n) {
    return { type: 'node', data: { uin: n.uin, name: n.name, time: n.time, seq: n.seq, content: (n.segments || [{ type: 'text', text: String(n.text || '') }]).map(function (s) {
      if (s.type === 'text') return { type: 'text', data: { text: s.text } }
      if (s.type === 'at') return { type: 'at', data: { qq: s.all ? 'all' : s.uin } }
      if (s.type === 'face') return { type: 'face', data: { id: s.id } }
      return { type: 'text', data: { text: '[不支持的元素]' } }
    }) } }
  }) })
}

export async function forwardGet ({ res_id: resId, message_id: mid, type = 'group', id } = {}) {
  if (resId) return ok('get_forward_msg', { res_id: String(resId) })
  if (!mid) return { ok: false, msg: '需要 res_id 或 message_id' }
  const gid = toQqId(id)
  return ok('get_forward_msg', { message_id: mid, type, group_id: gid, user_id: gid })
}

/* Qzone 网页 CGI（app 层直发，cookie 走 payload OIDB clientKey/pskey） */

async function qzoneRun (fn, args, label) {
  try {
    const d = await fn(args)
    return { ok: true, msg: `${label} 成功`, data: d }
  } catch (e) {
    const m = String((e && e.message) || '调用失败')
    return { ok: false, msg: m.includes('失败') ? m : `${label} 失败：${m}` }
  }
}

export function qzoneList (args) {
  return qzoneRun(qz.getMsgList, args, '读说说列表')
}
export function qzoneDetail (args) {
  if (!args || !args.tid) return { ok: false, msg: 'tid 必填' }
  return qzoneRun(qz.getMsgDetail, args, '读说说详情')
}
export function qzoneFeeds (args) {
  return qzoneRun(qz.getFeeds, args, '读好友动态')
}
export function qzonePublish (args) {
  if (!args || !String(args.content || '').trim()) return { ok: false, msg: 'content 必填' }
  return qzoneRun(qz.publish, args, '发说说')
}
export function qzoneDelete (args) {
  if (!args || !args.tid) return { ok: false, msg: 'tid 必填' }
  return qzoneRun(qz.del, args, '删说说')
}
export function qzoneLike (args) {
  if (!args || !args.tid) return { ok: false, msg: 'tid 必填' }
  return qzoneRun(qz.like, args, String(args.like) === 'false' || args.like === false ? '取消赞' : '点赞')
}
export function qzoneComment (args) {
  if (!args || !args.tid || !String(args.content || '').trim()) return { ok: false, msg: 'tid + content 必填' }
  return qzoneRun(qz.comment, args, '评论说说')
}
export function qzoneBlack (args) {
  if (!args || !args.target_uin) return { ok: false, msg: 'target_uin 必填' }
  return qzoneRun(qz.setBlack, args, String(args.ban) === 'false' || args.ban === false ? '空间解拉黑' : '空间拉黑')
}

export function qzoneCookies () {
  return qzoneRun(qz.cookiesDebug, {}, 'Qzone cookie 采集')
}

/* 群相册（HTTP sliceUpload，不碰 Highway） */

export function albumList (args) {
  if (!args || !args.group) return { ok: false, msg: 'group 必填' }
  return qzoneRun(qz.albumList, args, '群相册列表')
}
export function albumUpload (args) {
  if (!args || !args.group) return { ok: false, msg: 'group 必填' }
  if (!String(args.image || '').trim()) return { ok: false, msg: 'image 必填（base64 / data URI / 本地路径 / http URL）' }
  return qzoneRun(qz.albumUploadImage, args, '群相册传图')
}
export function albumVideoUpload (args) {
  if (!args || !args.group) return { ok: false, msg: 'group 必填' }
  if (!String(args.video || '').trim()) return { ok: false, msg: 'video 必填（MP4 base64 / 本地路径）' }
  return qzoneRun(qz.albumUploadVideo, args, '群相册视频上传')
}

/* 闪传（FlashTransfer / fileset，OIDB + sliceupload） */

export async function flashCreate (args) {
  if (!args || !String(args.file || '').trim()) return { ok: false, msg: 'file 必填（本地路径或 base64）' }
  const t0 = Date.now()
  try {
    const mod = await import('./flash.js')
    const r = await mod.createFlashTask({ files: args.file, name: args.name })
    return { ok: true, op: 'create_flash_task', human: `创建闪传任务`, data: r, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, op: 'create_flash_task', human: '创建闪传任务', msg: String(e.message || e), stack: String(e.stack || '').split('\n').slice(0, 12).join('\n'), ms: Date.now() - t0 }
  }
}
export async function flashSend (args) {
  if (!args || !String(args.fileset_uuid || '').trim()) return { ok: false, msg: 'fileset_uuid 必填' }
  if (!String(args.group || args.id || '').trim()) return { ok: false, msg: 'group（群号）必填' }
  const t0 = Date.now()
  try {
    const mod = await import('./flash.js')
    const r = await mod.sendFlashMsg({ fileset_uuid: args.fileset_uuid, group_id: args.group || args.id })
    return { ok: true, op: 'send_flash_msg', human: '发送闪传文件', data: r, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, op: 'send_flash_msg', human: '发送闪传文件', msg: String(e.message || e), ms: Date.now() - t0 }
  }
}
export async function flashInfo (args) {
  if (!args || !String(args.fileset_uuid || '').trim()) return { ok: false, msg: 'fileset_uuid 必填' }
  const t0 = Date.now()
  try {
    const mod = await import('./flash.js')
    const r = await mod.getFilesetInfo({ fileset_uuid: args.fileset_uuid })
    return { ok: true, op: 'get_fileset_info', human: '闪传文件详情', data: r, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, op: 'get_fileset_info', human: '闪传文件详情', msg: String(e.message || e), ms: Date.now() - t0 }
  }
}
export async function flashUrl (args) {
  if (!args || !String(args.fileset_uuid || '').trim()) return { ok: false, msg: 'fileset_uuid 必填' }
  const t0 = Date.now()
  try {
    const mod = await import('./flash.js')
    const r = await mod.getFlashFileUrl({ fileset_uuid: args.fileset_uuid, file_index: args.file_index })
    return { ok: true, op: 'get_flash_file_url', human: '闪传主文件直链', data: r, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, op: 'get_flash_file_url', human: '闪传主文件直链', msg: String(e.message || e), ms: Date.now() - t0 }
  }
}
export async function flashList (args) {
  const t0 = Date.now()
  try {
    const mod = await import('./flash.js')
    const r = await mod.listFilesets({})
    return { ok: true, op: 'list_flash_filesets', human: '闪传任务列表', data: r, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, op: 'list_flash_filesets', human: '闪传任务列表', msg: String(e.message || e), ms: Date.now() - t0 }
  }
}
export async function flashDelete (args) {
  if (!args || !String(args.fileset_uuid || '').trim()) return { ok: false, msg: 'fileset_uuid 必填' }
  const t0 = Date.now()
  try {
    const mod = await import('./flash.js')
    const r = await mod.deleteFlashFile({ fileset_uuid: args.fileset_uuid })
    return { ok: true, op: 'delete_flash_file', human: '删除闪传文件', data: r, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, op: 'delete_flash_file', human: '删除闪传文件', msg: String(e.message || e), ms: Date.now() - t0 }
  }
}

/* 请求审批（好友 0xB5D_44 / 入群 0x10C0+0x10C8） */

export async function requestsList (args) {
  const t0 = Date.now()
  try {
    const mod = await import('./request-approval.js')
    const r = await mod.getGroupRequests()
    return { ok: true, op: 'get_group_requests', human: '入群申请列表', data: r, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, op: 'get_group_requests', human: '入群申请列表', msg: String(e.message || e), ms: Date.now() - t0 }
  }
}
export async function requestGroupSet (args) {
  if (!args || (!String(args.flag || '').trim() && !String(args.seq || '').trim() && !String(args.group || '').trim())) {
    return { ok: false, msg: '缺少申请标识参数' }
  }
  const t0 = Date.now()
  try {
    const mod = await import('./request-approval.js')
    const r = await mod.setGroupAddRequest({
      flag: args.flag, seq: args.seq ?? args.sequence,
      group_id: args.group ?? args.group_id, user_id: args.user ?? args.user_id,
      approve: args.approve == null ? true : !!args.approve,
      reason: args.reason ?? ''
    })
    return { ok: true, op: 'set_group_add_request', human: (args.approve == null || args.approve) ? '同意入群申请' : '拒绝入群申请', data: r, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, op: 'set_group_add_request', human: '处理入群申请', msg: String(e.message || e), ms: Date.now() - t0 }
  }
}
export async function requestFriendSet (args) {
  if (!args || !String(args.flag || '').trim()) return { ok: false, msg: '请提供申请人 QQ 号或标识' }
  const t0 = Date.now()
  try {
    const mod = await import('./request-approval.js')
    const r = await mod.setFriendAddRequest({ flag: args.flag, approve: args.approve == null ? true : !!args.approve })
    return { ok: true, op: 'set_friend_add_request', human: (args.approve == null || args.approve) ? '同意好友申请' : '拒绝好友申请', data: r, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, op: 'set_friend_add_request', human: '处理好友申请', msg: String(e.message || e), ms: Date.now() - t0 }
  }
}

/* AI 语音（OIDB 0x929D/0x929B） */

export function aiCharacters (args) {
  return ok('get_ai_characters', { group_id: toQqId(args && args.id), chat_type: Number(args && args.chat_type) || 1 })
}
export function aiVoice (args) {
  const gid = toQqId(args && args.id)
  if (!gid) return { ok: false, msg: '群号必须是 5~12 位数字' }
  if (!String(args && args.character || '').trim()) return { ok: false, msg: '请选择语音角色' }
  if (!String(args && args.text || '').trim()) return { ok: false, msg: 'text 必填' }
  return ok('get_ai_record', { group_id: gid, character: args.character, text: args.text, chat_type: Number(args.chat_type) || 1 })
}

/* 表：op -> 实现 */
/* 媒体下载（rkey / get_image / get_record / 签名 URL） */

export async function groupFileListOp (args) {
  const t0 = Date.now()
  try {
    const mod = await import('./flash.js')
    const r = await mod.groupFileList({ group: args?.group || args?.id, folder: args?.folder, start: args?.start, count: args?.count })
    return { ok: true, op: 'group_file_list', human: '群文件列表', data: r, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, op: 'group_file_list', human: '群文件列表', msg: String(e.message || e), ms: Date.now() - t0 }
  }
}

/* 群文件下载直链（0x6D6_2）：file_id 从群文件列表拿 */
export async function groupFileUrlOp (args) {
  const t0 = Date.now()
  try {
    const mod = await import('./flash.js')
    const r = await mod.groupFileUrl({ group: args?.group || args?.id, file_id: args?.file_id, bus_id: args?.bus_id })
    return { ok: true, op: 'group_file_url', human: '群文件下载直链', data: r, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, op: 'group_file_url', human: '群文件下载直链', msg: String(e.message || e), ms: Date.now() - t0 }
  }
}

/* 登录凭证（clientKey + p_skey + bkn），get_credentials 同源 */
export async function credentialsOp () {
  const t0 = Date.now()
  try {
    const mod = await import('./qzone.js')
    const c = await mod.credentials()
    return { ok: true, op: 'credentials', human: '登录凭证', data: c, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, op: 'credentials', human: '登录凭证', msg: String(e.message || e), ms: Date.now() - t0 }
  }
}

export async function mediaRkey (args) {
  const t0 = Date.now()
  try {
    const mod = await import('./media-dl.js')
    if (args && args.force) {
      const r = await mod.rkey(true)
      return { ok: true, op: 'media_rkey', human: '刷新下载凭证', data: { got: !!r, len: String(r).length, info: await mod.rkeyInfo() }, ms: Date.now() - t0 }
    }
    const info = await mod.rkeyInfo()
    return { ok: true, op: 'media_rkey', human: '图片/文件下载凭证状态', data: info, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, op: 'media_rkey', human: '下载凭证', msg: String(e.message || e), ms: Date.now() - t0 }
  }
}

export async function mediaGet (args) {
  const kind = String(args?.kind || 'image')
  if (!args || (!String(args.file || '') && !String(args.url || ''))) return { ok: false, msg: '请提供文件路径或下载链接' }
  const t0 = Date.now()
  try {
    const mod = await import('./media-dl.js')
    const r = await mod.getMedia({ file: args.file, url: args.url, msg_id: args.msg_id, group_id: args.group_id, user_id: args.user_id, kind, isGroup: args.is_group !== false })
    return { ok: true, op: 'media_get', human: `下载${kind}到本地`, data: r, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, op: 'media_get', human: `下载${kind}`, msg: String(e.message || e), ms: Date.now() - t0 }
  }
}

/* 发视频 / 传群文件 */
export async function sendVideo ({ type = 'group', id, path: file, name } = {}) {
  const t = type === 'private' ? 'private' : 'group'
  const target = toQqId(id)
  if (!target) return { ok: false, msg: (t === 'group' ? '群号' : '好友 QQ 号') + '必须是 5~12 位数字' }
  const f = String(file || '').trim()
  if (!f) return { ok: false, msg: '要填本机视频的完整路径' }
  if (t === 'group' && isBlocked(target)) return { ok: false, msg: '该群已在禁止发送列表中' }
  try {
    const d = await call('send_video', t === 'group'
      ? { group_id: target, file: f, name }
      : { user_id: target, file: f, name }, 300000)
    return { ok: true, msg: (d && (d.text || d.msg)) || '视频已发送', data: d }
  } catch (e) {
    return { ok: false, msg: e.message, retcode: e.retcode }
  }
}

export async function uploadFile ({ id, path: file, name, folderId } = {}) {
  const target = toQqId(id)
  if (!target) return { ok: false, msg: '群号必须是 5~12 位数字' }
  const f = String(file || '').trim()
  if (!f) return { ok: false, msg: '要填本机文件的完整路径' }
  if (isBlocked(target)) return { ok: false, msg: '该群已在禁止发送列表中' }
  try {
    const d = await call('upload_group_file', { group_id: target, file: f, name, folder_id: folderId }, 300000)
    return { ok: true, msg: (d && (d.text || d.msg)) || '文件已上传到群', data: d }
  } catch (e) {
    return { ok: false, msg: e.message, retcode: e.retcode }
  }
}

const OPS = {
  send, sendImage, sendRich, sendVideo, uploadFile, poke, recall, emojiLike, like, profileSet,
  selfInfo, friendList, groupList, recentList, services, groupMembers,
  groupMute, groupMuteAll, groupKick, groupSetAdmin,
  groupCard, groupName, groupAnnounce,
  groupSpace, groupFileCount, groupFolderCreate, groupFolderDelete,
  groupFileDelete, groupFileRename, groupFileMove,
  msgHistory, essenceSet, essenceDel, essenceList, groupSystemMsg, albumMain,
  forwardSend, forwardGet,
  qzoneList, qzoneDetail, qzoneFeeds, qzonePublish, qzoneDelete, qzoneLike,
  qzoneComment, qzoneBlack, qzoneCookies, aiCharacters, aiVoice,
  albumList, albumUpload, albumVideoUpload,
  flashCreate, flashSend, flashInfo, flashUrl, flashDelete, flashList,
  mediaRkey, mediaGet, groupFileListOp, groupFileUrlOp, credentialsOp,
  requestsList, requestGroupSet, requestFriendSet,
  probe, devEval, probeCall, kernelListen, findUid, getMsgs, emojiLikesList
}

export function has (op) { return Object.prototype.hasOwnProperty.call(OPS, op) }

/** 统一入口：返回 { ok, msg, data?, list? } */
/** ctx.account = uin 或 pid：这次调用打给哪个账号（不改当前账号） */
export async function run (op, args = {}, ctx = {}) {
  const fn = OPS[op]
  if (!fn) return { ok: false, msg: `实验台还没有 ${op} 这一项` }
  const key = ctx && ctx.account ? ctx.account : null
  return als.run(key, () => fn(args || {}))
}

export const OP_NAMES = Object.keys(OPS)
