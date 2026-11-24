import * as kernel from './kernel.js'

/* protobuf 编解码（口径同 flash.js） */
function vi (n) {
  let v = typeof n === 'bigint' ? n : Number(n)
  if (v < 0n || (typeof v === 'number' && (!isFinite(v) || v < 0))) v = 0n
  if (typeof v === 'number') v = BigInt(Math.floor(v))
  const out = []
  while (v >= 128n) { out.push(Number(v % 128n) + 128); v >>= 7n }
  out.push(Number(v))
  return out
}
function tag (f, w) { return vi(f * 8 + w) }

function pv (out, f, n, force) {
  if (n == null || n === '' || (!force && Number(n) === 0)) return out
  out.push(...tag(f, 0), ...vi(n))
  return out
}
function pb (out, f, bytes, force) {
  if (bytes == null) return out
  if (bytes.length === 0 && !force) return out
  const t = tag(f, 2)
  for (let i = 0; i < t.length; i++) out.push(t[i])
  const len = vi(bytes.length)
  for (let i = 0; i < len.length; i++) out.push(len[i])
  for (let i = 0; i < bytes.length; i++) out.push(bytes[i])
  return out
}
function ps (out, f, s, force) {
  if (s == null || (s === '' && !force)) return out
  return pb(out, f, Buffer.from(String(s), 'utf8'), true)
}
function cat (...arrs) {
  return Buffer.concat(arrs.filter(Boolean).map(a => (a instanceof Buffer ? a : Buffer.from(a))))
}

function rd (buf) {
  const fields = new Map()
  let p = 0
  const u8 = buf instanceof Buffer ? buf : Buffer.from(buf || [])
  function varint () {
    let v = 0n
    let sh = 0n
    for (;;) {
      if (p >= u8.length) throw new Error('protobuf 截断')
      const b = u8[p++]
      v |= BigInt(b & 0x7f) << sh
      sh += 7n
      if (!(b & 0x80)) break
    }
    return v
  }
  while (p < u8.length) {
    const t = varint()
    const f = Number(t >> 3n)
    const w = Number(t & 7n)
    if (f === 0) break
    if (!fields.has(f)) fields.set(f, [])
    if (w === 0) { fields.get(f).push(varint()) } else if (w === 2) {
      const len = Number(varint())
      if (p + len > u8.length) throw new Error('protobuf 字段截断')
      fields.get(f).push(u8.subarray(p, p + len))
      p += len
    } else if (w === 5) { p += 4 } else if (w === 1) { p += 8 } else break
  }
  return {
    f (n) { const a = fields.get(n); return a && a.length ? a[a.length - 1] : null },
    all (n) { return fields.get(n) || [] },
    num (n) { const v = this.f(n); return v != null ? Number(v) : 0 },
    str (n) { const v = this.f(n); return v != null ? Buffer.from(v).toString('utf8') : '' }
  }
}

async function oidb (cmd, sub, bodyBuf, uinForm) {
  const r = await kernel.call('oidb_raw', { cmd, sub, body_hex: bodyBuf.toString('hex'), uin_form: !!uinForm }, 20000)
  if (!r.ok) throw new Error(`OIDB 0x${cmd.toString(16)}_${sub} 通道失败：${r.err || r.msg}`)
  const d = typeof r.ret === 'string' ? JSON.parse(r.ret) : r.ret
  if (d.errCode) throw new Error(`OIDB 0x${cmd.toString(16)}_${sub} 服务端拒（${d.errCode}）：${d.errMsg || ''}`)
  return Buffer.from(String(d.bodyHex || ''), 'hex')
}

/* 0x10C0 的通知类型 → 0x10C8 的操作类型（协议固定口径，照客户端抄的）：
 * 列表类型 7 是「加群申请」，绝不能原样回填成操作类型 7。
 * 部分列表回包直接带操作类型（如 22），下面列出的值原样放行。 */
function operationFor (notifyType) {
  switch (notifyType) {
    case 0: return 0
    case 1: return 2
    case 2: return 10
    case 3: return 11
    case 4: return 12
    case 5: return 22
    case 6: return 35
    case 7: return 1
    case 8: return 3
    case 9: return 6
    case 10: return 7
    case 11: return 13
    case 12: return 15
    case 13: return 16
    case 14: return 17
    case 15: return 19
    case 16: return 8
    case 17: return 100
    default: return null
  }
}

/* 已经是操作类型的取值集合（等于上面映射的右侧） */
const KNOWN_OPERATIONS = new Set([0, 1, 2, 3, 6, 7, 8, 10, 11, 12, 13, 15, 16, 17, 19, 22, 35, 100])

function opTypeOf (notifyType) {
  const mapped = operationFor(notifyType)
  if (mapped !== null) return mapped
  return KNOWN_OPERATIONS.has(notifyType) ? notifyType : 0
}

function decodeUser (d) {
  if (!d) return { uin: 0, name: '' }
  return { uin: d.num(1), name: d.str(2) }
}

function decodeRequest (d, filtered) {
  const g = d.f(4) ? rd(d.f(4)) : null
  const seq = d.f(1) != null ? BigInt(d.f(1)) : 0n
  const notifyType = d.num(2)
  return {
    seq,
    notify_type: notifyType,
    event_type: opTypeOf(notifyType),
    state: d.num(3),
    group_id: g ? g.num(1) : 0,
    group_name: g ? g.str(2) : '',
    target: decodeUser(d.f(5) ? rd(d.f(5)) : null),
    invitor: decodeUser(d.f(6) ? rd(d.f(6)) : null),
    operator: decodeUser(d.f(7) ? rd(d.f(7)) : null),
    comment: d.str(10),
    operate_trans_info: d.f(14) ? Buffer.from(d.f(14)).toString('hex') : '',
    filtered: !!filtered,
    flag: `flgrp:${seq}:${g ? g.num(1) : 0}:${opTypeOf(notifyType)}:${filtered ? 1 : 0}`
  }
}

function toPlain (r) {
  return {
    ...r,
    seq: String(r.seq),
    target_uin: r.target.uin, target_name: r.target.name,
    invitor_uin: r.invitor.uin, invitor_name: r.invitor.name,
    operator_uin: r.operator.uin, operator_name: r.operator.name
  }
}

export async function getGroupRequests () {
  const out = []
  for (const filtered of [false, true]) {
    /* f1 = 拉取条数（QQ 原生 50），f2 = 游标 0 起新一屏 */
    const body = cat(pv([], 1, 50, true))
    const rsp = await oidb(0x10C0, filtered ? 2 : 1, body, true)
    const d = rd(rsp)
    for (const raw of d.all(1)) out.push(decodeRequest(rd(raw), filtered))
  }
  return out.map(toPlain)
}

async function applyGroupRequest (req, approve, reason) {
  if (!req.seq || !req.group_id) throw new Error('申请记录缺 seq/group_id，无法处理')
  const msg = String(reason ?? '').length > 0 ? String(reason) : ' '
  const inner = cat(
    pv([], 1, req.seq, true),      /* 1: sequence u64 */
    pv([], 2, req.event_type || 0, true), /* 2: eventType（操作类型） */
    pv([], 3, req.group_id, true), /* 3: groupUin */
    ps([], 4, msg, true),          /* 4: message（空串拒收，空格=原生空理由） */
    req.operate_trans_info ? pb([], 7, Buffer.from(req.operate_trans_info, 'hex')) : null
  )
  const body = cat(
    pv([], 1, approve ? 1 : 2, true), /* 1: accept 1=同意 2=拒绝 */
    pb([], 2, inner, true)
  )
  await oidb(0x10C8, req.filtered ? 2 : 1, body, true)
}

function parseFlag (flag) {
  const s = String(flag || '')
  if (/^flgrp:\d+:\d+:\d+:[01]$/.test(s)) {
    const [seq, gid, et, fl] = s.split(':').slice(1)
    return { seq: BigInt(seq), group_id: Number(gid), event_type: Number(et), filtered: fl === '1' }
  }
  if (/^\d+$/.test(s)) return { seq: BigInt(s) }
  return null
}

export async function setGroupAddRequest ({ flag, seq, group_id, user_id, approve = true, reason = '' } = {}) {
  const fromFlag = parseFlag(flag)
  if (fromFlag && fromFlag.event_type != null) {
    /* 规范 flag 信息齐全 → 先按 flag 直发 0x10C8（不带 operateTransInfo）。
       失败不急抛：记录原始错误，回退收件箱匹配（带 operateTransInfo 再试一次），
       两边都失败才把原始错误报出来 —— 有些回执路径「无回执但 errMsg 带业务原因」，
       不能靠错误文本判形态。 */
    let flagErr = null
    try {
      await applyGroupRequest({ ...fromFlag, operate_trans_info: '' }, approve, reason)
      return { handled: true, source: 'flag', seq: String(fromFlag.seq), group_id: fromFlag.group_id }
    } catch (e) { flagErr = e }
    try {
      const list = await getGroupRequests()
      const hit = list.find((r) => String(r.seq) === String(fromFlag.seq) &&
        (!fromFlag.group_id || r.group_id === fromFlag.group_id) && r.event_type > 0)
      if (hit) {
        await applyGroupRequest(hit, approve, reason)
        return { handled: true, source: 'inbox', seq: hit.seq, group_id: hit.group_id, user_id: hit.target.uin, comment: hit.comment }
      }
    } catch { /* 回退失败：抛原始 flag 直发错误 */ }
    throw flagErr
  }
  const list = await getGroupRequests()
  let hit = null
  if (fromFlag) {
    hit = list.find((r) => String(r.seq) === String(fromFlag.seq) &&
      (!fromFlag.group_id || r.group_id === fromFlag.group_id) && r.event_type > 0)
  } else if (seq) {
    hit = list.find((r) => String(r.seq) === String(seq) && (!group_id || r.group_id === Number(group_id)))
  } else if (group_id) {
    hit = list.find((r) => r.group_id === Number(group_id) &&
      (!user_id || r.target.uin === Number(user_id)))
  }
  if (!hit) throw new Error('没在 0x10C0 收件箱里找到匹配的入群申请（可能已处理/过期，或群内邀请卡不进收件箱）')
  await applyGroupRequest(hit, approve, reason)
  return { handled: true, source: 'inbox', seq: hit.seq, group_id: hit.group_id, user_id: hit.target.uin, comment: hit.comment }
}

/* QQ 号 → uid 缓存：好友申请事件（watch friend-request）天然带 (uin, uid) 对。
   对方还不是好友时 find_uid 解析不到 uid，事件缓存就是唯一来源。 */
const buddyUidCache = new Map()
export function rememberBuddy (uin, uid) {
  const q = String(uin ?? '').trim()
  const u = String(uid ?? '').trim()
  if (/^\d+$/.test(q) && /^u_/.test(u)) buddyUidCache.set(q, u)
  return buddyUidCache.size
}

export async function setFriendAddRequest ({ flag, approve = true } = {}) {
  let uid = String(flag ?? '').trim()
  if (!uid) throw new Error('缺 flag（好友申请 flag = 对方 uid 或 QQ 号）')
  if (/^\d+$/.test(uid)) {
    /* 1) 事件缓存（最快、对非好友也有效） */
    const cached = buddyUidCache.get(uid)
    if (cached) {
      uid = cached
    } else {
      /* 2) 内核 find_uid 兜底（已是好友时才查得到） */
      const r = await kernel.call('find_uid', { uin: uid }, 15000)
      if (!r.ok) throw new Error('find_uid 失败：' + (r.err || r.msg))
      let d = null
      try { d = typeof r.ret === 'string' ? JSON.parse(r.ret) : r.ret } catch { d = null }
      uid = String((d && (d.uid ?? d)) || '').trim()
    }
  }
  if (!/^u_/.test(uid)) throw new Error('解析不出对方 uid（flag 应为 u_ 开头的 uid 或纯数字 QQ 号；纯数字需该号曾发过申请事件）：' + uid)
  /* 1: accept 3=同意 5=拒绝；2: targetUid */
  const body = cat(pv([], 1, approve ? 3 : 5, true), ps([], 2, uid, true))
  await oidb(0xB5D, 44, body, false)
  return { handled: true, uid }
}

export function info () {
  return {
    module: 'request-approval.js',
    oidb: 'Buffer 通道（oidbRaw 复用）',
    cmds: ['0x10C0_1/2 入群申请列表', '0x10C8_1/2 处理入群申请', '0xB5D_44 处理好友申请']
  }
}
