import * as kernel from './kernel.js'
import * as uidmap from './uidmap.js'

/* protobuf 编解码（与 flash.js 同口径） */
function vi (n) {
  let v = Number(n)
  if (!isFinite(v) || v < 0) v = 0
  v = Math.floor(v)
  const out = []
  while (v >= 128) { out.push((v % 128) + 128); v = Math.floor(v / 128) }
  out.push(v)
  return out
}
function tag (f, w) { return vi(f * 8 + w) }
function pv (out, f, n, force) {
  if (n == null || (!force && Number(n) === 0)) return
  out.push(...tag(f, 0), ...vi(n))
}
function pb (out, f, bytes, force) {
  if (bytes == null) return
  if (bytes.length === 0 && !force) return
  const t = tag(f, 2)
  for (let i = 0; i < t.length; i++) out.push(t[i])
  const len = vi(bytes.length)
  for (let i = 0; i < len.length; i++) out.push(len[i])
  for (let i = 0; i < bytes.length; i++) out.push(bytes[i])
}
function ps (out, f, s, force) {
  if (s == null || (s === '' && !force)) return
  pb(out, f, Buffer.from(String(s), 'utf8'), true)
}
function pm (out, f, build) { const inner = build(); pb(out, f, Buffer.from(inner), true) }
function hexToBuf (h) { return Buffer.from(String(h || ''), 'hex') }
function cat (...arrs) { return Buffer.concat(arrs.filter(Boolean)) }

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
    str (n) { const v = this.f(n); return v != null ? Buffer.from(v).toString('utf8') : '' },
    msg (n) { const v = this.f(n); return v != null ? rd(v) : null }
  }
}

async function oidb (cmd, sub, bodyBuf, uinForm, wireName) {
  const r = await kernel.call('oidb_raw', {
    cmd, sub,
    body_hex: bodyBuf.toString('hex'),
    uin_form: !!uinForm,
    wire_name: wireName || ''
  }, 20000)
  if (!r.ok) throw new Error(`OIDB 0x${cmd.toString(16)}_${sub} 通道失败：${r.err || r.msg}`)
  const d = typeof r.ret === 'string' ? JSON.parse(r.ret) : r.ret
  if (d.errCode) throw new Error(`OIDB 0x${cmd.toString(16)}_${sub} 服务端拒（${d.errCode}）：${d.errMsg || ''}`)
  return hexToBuf(d.bodyHex)
}

async function ssoRaw (cmdName, bodyBuf) {
  const r = await kernel.call('sso_raw', { cmd: cmdName, body_hex: bodyBuf.toString('hex') }, 20000)
  if (!r.ok) throw new Error(`${cmdName} 通道失败：${r.err || r.msg}`)
  const d = typeof r.ret === 'string' ? JSON.parse(r.ret) : r.ret
  return hexToBuf(d.rawHex)
}

async function selfUin () {
  let uin = String(kernel.getSelfId() || '')
  if (!uin) {
    /* 面板刚重启时内存里的 uin 是空的：主动问一次内核并登记 */
    try {
      const r = await kernel.call('get_login_info', {}, 8000)
      if (r.ok) {
        let j = null
        try { j = typeof r.ret === 'string' ? JSON.parse(r.ret) : r.ret } catch { j = null }
        const u = j && (j.uin || j.user_id)
        if (u) { kernel.setSelfId(u); uin = String(u) }
      }
    } catch {}
  }
  if (!uin) throw new Error('本号 uin 还没探到（QQ 刚启动时请稍候）')
  return uin
}

/** 好友 uid 解析：先翻好友表（uid 权威），再落 uidmap（消息反查） */
async function resolveUid (qq) {
  const s = String(qq ?? '').trim()
  if (!s) throw new Error('缺少 user_id')
  try {
    const r = await kernel.call('get_friend_list', {}, 15000)
    if (r.ok) {
      let d = null
      try { d = typeof r.ret === 'string' ? JSON.parse(r.ret) : r.ret } catch { d = null }
      const list = Array.isArray(d) ? d : (d && (d.list || d.friends || d.data)) || []
      /* 内核有时只回 uid 不回 QQ 号，这时用 uid 反解出 QQ 号再比 */
      const hit = list.find((f) => {
        const direct = f.uin ?? f.user_id
        if (direct && String(direct) === s) return true
        const decoded = uidmap.toQq(String(f.uid ?? ''))
        return !!decoded && String(decoded) === s
      })
      if (hit && hit.uid) return String(hit.uid)
    }
  } catch {}
  try { const u = uidmap.resolve(s); if (u) return String(u) } catch {}
  throw new Error(`${s} 的成员标识（uid）未知的：请确认对方是好友，或让对方先发一条消息`)
}

/** 群推荐卡片（0x8b7_5，uinForm）：服务端把群名片拼成 ark JSON 返回 */
export async function groupRecommendArk (groupId) {
  const g = Number(groupId)
  if (!g) throw new Error('缺少 group_id')
  const b = cat(
    (() => { const o = []; pv(o, 1, 1); return Buffer.from(o) })(),
    (() => { const o = []; pv(o, 2, g); return Buffer.from(o) })(),
    (() => { const o = []; pv(o, 5, 1); return Buffer.from(o) })()
  )
  const body = await oidb(0x8b7, 5, b, true)
  const e = rd(body)
  const err = e.num(1)
  const ark = e.str(5)
  if (err && !ark) throw new Error(`群推荐卡片被服务端拒（${err}）`)
  if (!ark) throw new Error('服务端没返回卡片内容')
  return { ark }
}

/** 好友推荐卡片（0x12b6_0）：uin + 客户端固定 jump_url，服务端拼 ark JSON 返回 */
export async function buddyRecommendArk (userId, phoneNumber) {
  const u = Number(userId)
  if (!u) throw new Error('缺少 user_id')
  const jump = `mqqapi://card/show_pslcard?src_type=internal&source=sharecard&version=1&uin=${u}`
  const b = cat(
    (() => { const o = []; pv(o, 1, u); return Buffer.from(o) })(),
    (() => { const o = []; ps(o, 2, String(phoneNumber || '-') || '-'); return Buffer.from(o) })(),
    (() => { const o = []; ps(o, 3, jump); return Buffer.from(o) })()
  )
  const body = await oidb(0x12b6, 0, b, false)
  const ark = rd(body).str(1)
  if (!ark) throw new Error('服务端没返回卡片内容')
  return { ark }
}

/** 图文卡直发（0xdc2_34）：服务端直接把卡发进目标会话，本端无气泡无 message_id */
export async function tuwenArkSend ({ group_id, groupId, user_id, userId, title, desc, summary, jumpUrl, jump_url, previewUrl, preview_url }) {
  const g = groupId ?? group_id
  const u = userId ?? user_id
  const peerType = (g !== undefined && g !== null && g !== '') ? 1 : 0
  const targetId = Number(peerType ? g : u)
  if (!targetId) throw new Error('缺少 group_id 或 user_id')
  /* 图文卡走 OIDB 直发，绕过通用 translate 的名单检查，这里必须自己补一道 */
  if (peerType && kernel.isBlockedGroup(g)) throw new Error(`群 ${g} 已在禁止发送名单中，消息未发送`)
  const jump = jumpUrl || jump_url
  const preview = previewUrl || preview_url || ''
  if (!title || !desc || !jump) throw new Error('图文卡需要 title / desc / jump_url')
  const APPID = 100446242
  const content = cat(
    (() => { const o = []; pv(o, 1, 1); return Buffer.from(o) })(),
    (() => { const o = []; ps(o, 10, title); return Buffer.from(o) })(),
    (() => { const o = []; ps(o, 11, desc); return Buffer.from(o) })(),
    (() => { const o = []; ps(o, 12, String(summary || '[分享]')); return Buffer.from(o) })(),
    (() => { const o = []; ps(o, 13, jump); return Buffer.from(o) })(),
    (() => { const o = []; ps(o, 14, String(preview || '')); return Buffer.from(o) })()
  )
  const appInfo = cat(
    (() => { const o = []; pv(o, 1, APPID); return Buffer.from(o) })(),
    (() => { const o = []; pv(o, 2, 1); return Buffer.from(o) })(),
    (() => { const o = []; pv(o, 3, 0, true); return Buffer.from(o) })(),
    (() => { const o = []; pm(o, 5, () => { const i = []; pv(i, 1, 1); return i }); return Buffer.from(o) })(),
    (() => { const o = []; pv(o, 11, targetId); return Buffer.from(o) })(),
    (() => { const o = []; pb(o, 12, content); return Buffer.from(o) })()
  )
  const meta = cat(
    (() => { const o = []; pv(o, 1, peerType, true); return Buffer.from(o) })(),
    (() => { const o = []; pv(o, 2, targetId); return Buffer.from(o) })()
  )
  const b = cat(
    (() => { const o = []; pb(o, 1, appInfo); return Buffer.from(o) })(),
    (() => { const o = []; pb(o, 2, meta); return Buffer.from(o) })()
  )
  await oidb(0xdc2, 34, b, false)
  return { sent: true, target: targetId, peer_type: peerType }
}

/* 小程序卡片的两套预设：appid 与图标都是服务端认应用用的，值不能改 */
const MINI_APPS = {
  bili: {
    appid: '1109937557',
    icon: 'http://miniapp.gtimg.cn/public/appicon/51f90239b78a2e4994c11215f4c4ba15_200.jpg'
  },
  weibo: {
    appid: '1109224783',
    icon: 'http://miniapp.gtimg.cn/public/appicon/35bbb44dc68e65194cfacfb206b8f1f7_200.jpg'
  }
}

/* 客户端自带的小程序 SDK 版本串，AdaptShareInfo 要它 */
const MINI_SDK_VERSION = 'V1_PC_MINISDK_99.99.99_1_APP_A'

/** 单个字符串字段 → 独立 Buffer（方便 cat 拼接） */
function strField (field, value) {
  const out = []
  ps(out, field, String(value ?? ''))
  return Buffer.from(out)
}

/** 小程序卡片（LightAppSvc.mini_app_share.AdaptShareInfo）：参数交给服务端拼 ark JSON */
export async function miniAppArk ({ type, title, desc, pic_url, picUrl, jump_url, jumpUrl }) {
  const kind = String(type || 'bili')
  const preset = MINI_APPS[kind]
  if (!preset) throw new Error(`不支持的小程序类型：${kind}（只有 bili / weibo）`)

  const body = cat(
    strField(2, preset.appid),
    strField(3, title || ''),
    strField(4, desc || ''),
    strField(9, picUrl || pic_url || ''),
    strField(11, jumpUrl || jump_url || ''),
    strField(12, preset.icon)
  )

  const sdk = []
  ps(sdk, 2, MINI_SDK_VERSION)
  const content = []
  pb(content, 4, body)
  const req = cat(Buffer.from(sdk), Buffer.from(content))

  const raw = await ssoRaw('LightAppSvc.mini_app_share.AdaptShareInfo', req)
  const resp = rd(raw)
  const jsonStr = resp.msg(4) ? resp.msg(4).str(2) : ''
  if (!jsonStr) throw new Error(`小程序卡片服务端没返回内容（status=${resp.num(2)} ${resp.str(3)}）`)
  let card = {}
  try { card = JSON.parse(jsonStr) } catch { throw new Error('服务端返回的不是合法 JSON 卡片') }

  const data = {}
  data.ver = card.ver
  data.prompt = card.prompt
  data.config = card.config
  data.app = card.appName
  data.view = card.appView
  data.miniappShareOrigin = 3
  data.miniappOpenRefer = '10002'
  data.meta = card.metaData
  return { data }
}

/** 全员禁言余量（0x8A7_0）：basic 三元组 1/2/1 是服务端校验写死的 */
export async function atAllRemain (groupId) {
  const g = Number(groupId)
  if (!g) throw new Error('缺少 group_id')
  const uin = Number(await selfUin())
  const b = cat(
    (() => { const o = []; pv(o, 1, 1); return Buffer.from(o) })(),
    (() => { const o = []; pv(o, 2, 2); return Buffer.from(o) })(),
    (() => { const o = []; pv(o, 3, 1); return Buffer.from(o) })(),
    (() => { const o = []; pv(o, 4, uin); return Buffer.from(o) })(),
    (() => { const o = []; pv(o, 5, g); return Buffer.from(o) })(),
    (() => { const o = []; pv(o, 12, 0, true); return Buffer.from(o) })()
  )
  const body = await oidb(0x8a7, 0, b, false)
  const e = rd(body)
  return {
    can_at_all: e.num(6) !== 0,
    remain_at_all_count_for_uin: e.num(2),
    remain_at_all_count_for_group: e.num(3)
  }
}

/** 群打卡（0xEB7_1）：wire 名大写是硬要求，必须原样发 */
export async function groupSign (groupId) {
  const g = Number(groupId)
  if (!g) throw new Error('缺少 group_id')
  const uin = await selfUin()
  const b = cat(
    (() => { const o = []; pm(o, 2, () => {
      const i = []
      ps(i, 1, uin)
      ps(i, 2, String(g))
      ps(i, 3, '9.0.90')
      return i
    }); return Buffer.from(o) })()
  )
  await oidb(0xeb7, 1, b, false, 'OidbSvcTrpcTcp.0xEB7_1')
  return { group_id: g, signed: true }
}

/* qun.qq.com web 侧（荣誉榜 / 打卡名单）：pskey + bkn，与 Qzone 同套路 */

function bknOf (pskey) {
  let acc = 5381
  for (let i = 0; i < pskey.length; i++) acc = (acc + (acc << 5) + pskey.charCodeAt(i)) & 0x7fffffff
  return acc
}

async function qunCookie () {
  const r = await kernel.call('get_pskey', { domains: ['qun.qq.com'] }, 20000)
  if (!r.ok) throw new Error(`pskey 通道失败：${r.err || r.msg}`)
  const d = typeof r.ret === 'string' ? JSON.parse(r.ret) : r.ret
  /* payload 回 {items:[{domain,pskey,expireTime}]} */
  const hit = (d && d.items || []).find((x) => x.domain === 'qun.qq.com')
  const pskey = hit && hit.pskey
  if (!pskey) throw new Error('拿不到 qun.qq.com 的 pskey（QQ 刚登录时请稍候重试）')
  const uin = await selfUin()
  const cookie = `uin=o${uin}; p_uin=o${uin}; p_skey=${pskey}`
  return { cookie, bkn: bknOf(pskey), uin }
}

function honorParse (html, type) {
  const m = /window\.__INITIAL_STATE__=(.*?);/.exec(html)
  if (!m || !m[1]) return []
  let j
  try { j = JSON.parse(m[1].trim()) } catch { return [] }
  const list = type === 1 ? j.talkativeList : j.actorList
  return Array.isArray(list) ? list : []
}

function honorRow (x) {
  return {
    user_id: x.uin ?? null,
    nickname: x.name ?? '',
    avatar: x.avatar ?? '',
    description: x.desc ?? ''
  }
}

/** 群荣誉榜：qun.qq.com/interactive/honorlist 页面内嵌 state 抓取 */
export async function groupHonorInfo (groupId, type) {
  const g = String(Number(groupId) || '')
  if (!g || g === '0') throw new Error('缺少 group_id')
  const t = String(type || 'all')
  const { cookie } = await qunCookie()
  const out = { group_id: Number(g), current_talkative: null, talkative_list: [], performer_list: [], legend_list: [], emotion_list: [] }
  const fetchType = async (n) => {
    const res = await fetch(`https://qun.qq.com/interactive/honorlist?gc=${g}&type=${n}`, {
      headers: { Cookie: cookie }
    })
    if (!res.ok) throw new Error(`荣誉榜请求失败：HTTP ${res.status}`)
    return honorParse(await res.text(), n)
  }
  if (t === 'talkative' || t === 'all') {
    const list = await fetchType(1)
    if (list.length) { out.current_talkative = honorRow(list[0]); out.talkative_list = list.map(honorRow) }
  }
  if (t === 'performer' || t === 'all') out.performer_list = (await fetchType(2)).map(honorRow)
  if (t === 'legend' || t === 'all') out.legend_list = (await fetchType(3)).map(honorRow)
  if (t === 'emotion' || t === 'all') out.emotion_list = (await fetchType(6)).map(honorRow)
  return out
}

function yyyymmdd (d = new Date()) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

/** 群今日打卡名单：qun.qq.com trpc 接口；rank 服务端是 1,3,5… 歪刻度，需按 (r-1)/2+1 去偏 */
export async function groupSignedList (groupId) {
  const g = String(Number(groupId) || '')
  if (!g || g === '0') throw new Error('缺少 group_id')
  const { cookie, bkn, uin } = await qunCookie()
  const res = await fetch(`https://qun.qq.com/v2/signin/trpc/GetDaySignedList?g_tk=${bkn}`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ dayYmd: yyyymmdd(), offset: 0, limit: 100, uid: uin, groupId: g })
  })
  if (!res.ok) throw new Error(`打卡名单请求失败：HTTP ${res.status}`)
  const data = await res.json().catch(() => null)
  const infos = data && data.response && data.response.page && data.response.page[0] && data.response.page[0].infos
  if (!infos) throw new Error('拿不到打卡名单（多半是 cookie 过期或群今日无人打卡）')
  return infos.map((x) => ({
    user_id: Number(x.uid),
    nick: String(x.uidGroupNick || ''),
    time: Number(x.signedTimeStamp),
    rank: (Number(x.signInRank) - 1) / 2 + 1
  }))
}

/* 在线状态（trpc.qq_new_tech.status_svc.StatusService.SetStatus） */

async function setStatus (req) {
  const raw = await ssoRaw('trpc.qq_new_tech.status_svc.StatusService.SetStatus', req)
  const e = rd(raw)
  if (e.num(1)) throw new Error(`设置在线状态失败：${e.num(1)} ${e.str(2)}`)
  return true
}

/** 在线状态：status 1=在线 2=离开 3=隐身 4=忙碌 5=勿扰 6=Q我吧 等 */
export async function setOnlineStatus (status, extStatus, batteryStatus) {
  const s = Number(status)
  if (Number.isNaN(s)) throw new Error('缺少 status')
  const b = cat(
    (() => { const o = []; pv(o, 1, s, true); return Buffer.from(o) })(),
    (() => { const o = []; pv(o, 2, Number(extStatus) || 0); return Buffer.from(o) })(),
    Number(batteryStatus) > 0
      ? (() => { const o = []; pv(o, 3, Number(batteryStatus)); return Buffer.from(o) })()
      : null
  )
  await setStatus(Buffer.from(b))
  return { status: s }
}

/** 自定义在线状态：status=10 / extStatus=2000 是 QQ 定义的「有自定义状态」常量 */
export async function setDiyOnlineStatus (faceId, wording, faceType) {
  const b = cat(
    (() => { const o = []; pv(o, 1, 10, true); return Buffer.from(o) })(),
    (() => { const o = []; pv(o, 2, 2000, true); return Buffer.from(o) })(),
    (() => { const o = []; pv(o, 3, 0, true); return Buffer.from(o) })(),
    (() => { const o = []; pm(o, 4, () => {
      const i = []
      pv(i, 1, Number(faceId) || 0)
      ps(i, 2, String(wording || ''))
      pv(i, 3, Number(faceType) || 1)
      return i
    }); return Buffer.from(o) })()
  )
  await setStatus(Buffer.from(b))
  return { face_id: Number(faceId) || 0, wording: String(wording || '') }
}


/** 删好友（0x126B_0）：field2 套娃是服务端识别码，130/109/8/8/50 必须原样 */
export async function deleteFriend (userId, block) {
  const uid = await resolveUid(userId)
  const b = cat(
    (() => { const o = []; pm(o, 1, () => {
      const i = []
      ps(i, 1, uid)
      pm(i, 2, () => {
        const j = []
        pv(j, 1, 130)
        pv(j, 2, 109)
        pm(j, 3, () => { const k = []; pv(k, 1, 8); pv(k, 2, 8); pv(k, 3, 50); return k })
        return j
      })
      pv(i, 3, block ? 1 : 0, true)
      pv(i, 4, 1)
      return i
    }); return Buffer.from(o) })()
  )
  await oidb(0x126b, 0, b, false)
  return { user_id: Number(userId), uid, blocked: !!block }
}

/** 好友备注（0x912E_0）：scene=0 必须显式上 wire（StrangerRemarkSetWorker 口径） */
export async function setFriendRemark (userId, remark) {
  const uid = await resolveUid(userId)
  const r = String(remark ?? '')
  const b = cat(
    (() => { const o = []; pm(o, 1, () => {
      const i = []
      pm(i, 1, () => { const j = []; ps(j, 7, uid); return j })
      ps(i, 2, r)
      return i
    }); return Buffer.from(o) })(),
    (() => { const o = []; pv(o, 2, 0, true); return Buffer.from(o) })()
  )
  const body = await oidb(0x912e, 0, b, false)
  const e = rd(body)
  const err = e.msg(3)
  if (err && err.num(2)) throw new Error(`设置备注失败：${err.num(2)} ${err.str(3)}`)
  return { user_id: Number(userId), uid, remark: r }
}

/** 正在输入（0xCD4_1）：eventType 1=输入中 0=取消；只支持好友单聊 */
export async function setInputStatus (userId, eventType) {
  const uid = await resolveUid(userId)
  const b = cat(
    (() => { const o = []; pm(o, 1, () => {
      const i = []
      ps(i, 1, uid)
      pv(i, 2, 0)
      pv(i, 3, Number(eventType) || 0)
      return i
    }); return Buffer.from(o) })()
  )
  await oidb(0xcd4, 1, b, false)
  return { user_id: Number(userId), event_type: Number(eventType) || 0 }
}

/** 资料赞详情（0x7ED_12 他人 / 0x7ED_13 本号）：返回累计/今日赞与最近点赞人。
 *  field1 是 repeated string（uid 单元素）。 */
export async function profileLike (userId, start, limit) {
  const uin = await selfUin()
  const isSelf = String(userId ?? '') === uin
  const uid = await resolveUid(userId)
  const uidBuf = Buffer.from(uid, 'utf8')
  const b = cat(
    (() => { const o = []; pb(o, 1, uidBuf, true); return Buffer.from(o) })(),
    (() => { const o = []; pv(o, 2, 1); return Buffer.from(o) })(),
    (() => { const o = []; pv(o, 3, 1); return Buffer.from(o) })(),
    (() => { const o = []; pv(o, 4, 0, true); return Buffer.from(o) })(),
    (() => { const o = []; pv(o, 101, 1); return Buffer.from(o) })(),
    (() => { const o = []; pv(o, 102, Number(start) || 0); return Buffer.from(o) })(),
    (() => { const o = []; pv(o, 103, Number(limit) || 10); return Buffer.from(o) })()
  )
  const body = await oidb(0x7ed, isSelf ? 13 : 12, b, false)
  const e = rd(body)
  const info = e.msg(1)
  if (!info) throw new Error('服务端没返回资料赞数据')
  const mapUser = (u) => ({
    uid: u.str(1),
    src: u.num(2),
    count: u.num(4),
    gift_count: u.num(5),
    nick: u.str(101),
    gender: u.num(102),
    age: u.num(103)
  })
  const fav = info.msg(3)
  const vote = info.msg(4)
  return {
    uid,
    is_self: isSelf,
    time: info.num(2),
    favorite_info: {
      total_count: fav ? fav.num(1) : 0,
      last_time: fav ? fav.num(2) : 0,
      today_count: fav ? fav.num(3) : 0,
      user_list: fav ? fav.all(4).map((x) => mapUser(rd(x))) : []
    },
    vote_info: {
      total_count: vote ? vote.num(1) : 0,
      new_count: vote ? vote.num(2) : 0,
      new_nearby_count: vote ? vote.num(3) : 0,
      last_time: vote ? vote.num(4) : 0,
      user_list: vote ? vote.all(5).map((x) => mapUser(rd(x))) : []
    }
  }
}
