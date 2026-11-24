import https from 'node:https'
import http from 'node:http'
import * as kernel from './kernel.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

/* ------------------------------------------------------------------ *
 * 底层小工具
 * ------------------------------------------------------------------ */

/** 组装查询串/表单：[[键, 值], …]；值为 null/undefined 的项直接跳过。
 *  用数组而不是对象字面量，是为了条件项能就地 push 进来。 */
function formOf (pairs) {
  const sp = new URLSearchParams()
  for (const [key, val] of pairs) {
    if (val === undefined || val === null) continue
    sp.append(key, String(val))
  }
  return sp
}

function cookieToStr (jar) {
  const parts = []
  for (const key of Object.keys(jar)) parts.push(key + '=' + jar[key])
  return parts.join('; ')
}

/** bkn = djb2(5381) 取低 31 位，网页端 g_tk 口径。p_skey 优先，缺了退回 skey。 */
function bknOf (jar) {
  const key = jar.p_skey || jar.skey || ''
  let h = 5381
  for (const ch of key) h += (h << 5) + ch.charCodeAt(0)
  return String(h & 2147483647)
}

/** 本号 uin：先问内核缓存，空了再打 get_login_info。 */
async function selfUin () {
  const cached = kernel.getSelfId()
  if (cached) return String(cached)
  const resp = await kernel.call('get_login_info', {}, 8000)
  if (resp.ok) {
    let info = resp.ret
    if (typeof info === 'string') {
      try { info = JSON.parse(info) } catch { info = null }
    }
    const found = info && (info.uin || info.user_id)
    if (found) {
      kernel.setSelfId(found)
      return String(found)
    }
  }
  throw new Error('本号 uin 还没探到（QQ 刚登录或还没发过消息）')
}

async function kernelJson (action, params, timeout = 15000) {
  const resp = await kernel.call(action, params, timeout)
  if (!resp.ok) throw new Error(resp.err || `${action} 调用失败`)
  try {
    return typeof resp.ret === 'string' ? JSON.parse(resp.ret) : resp.ret
  } catch {
    throw new Error(`${action} 返回解析失败：${String(resp.ret).slice(0, 120)}`)
  }
}

/** 跟着 3xx 一路收 Set-Cookie；任何一跳出错都当正常收尾（关键票据第一跳就下发）。 */
function jumpCookies (url, depth = 0, jar = {}) {
  return new Promise((done) => {
    const target = new URL(url)
    const mod = target.protocol === 'https:' ? https : http
    const req = mod.get(target, { headers: { 'User-Agent': UA } }, (res) => {
      for (const raw of (res.headers['set-cookie'] || [])) {
        const head = raw.split(';')[0]
        const eq = head.indexOf('=')
        if (eq > 0) jar[head.slice(0, eq)] = head.slice(eq + 1)
      }
      const next = res.headers.location
      res.resume()
      if (next && depth < 6) done(jumpCookies(new URL(next, target).toString(), depth + 1, jar))
      else done(jar)
    })
    req.on('error', () => done(jar))
    req.setTimeout(10000, () => { req.destroy(); done(jar) })
  })
}

/** cookie 三件套（uin + skey + p_skey）缓存 10 分钟；clientKey 本身 30 分钟有效。 */
let jarCache = { jar: null, bkn: '', at: 0, uin: '' }

async function qzoneAuth () {
  const uin = await selfUin()
  const usable = jarCache.jar && jarCache.uin === uin && jarCache.jar.p_skey &&
    (Date.now() - jarCache.at) < 10 * 60 * 1000
  if (usable) return { jar: jarCache.jar, bkn: jarCache.bkn, uin }

  const ck = await kernelJson('get_client_key', {})
  const jump = formOf([
    ['ptlang', '1033'],
    ['clientuin', uin],
    ['clientkey', ck.clientKey],
    ['u1', `https://qzone.qq.com/${uin}/infocenter`],
    ['keyindex', ck.keyIndex || '19']
  ])
  const jar = await jumpCookies('https://ssl.ptlogin2.qq.com/jump?' + jump)
  if (!jar.p_skey) {
    /* ptlogin2 偶尔 p_skey_forbid，改走 OIDB 0x102A_0 兜底 */
    const pk = await kernelJson('get_pskey', { domains: ['qzone.qq.com'] })
    const hit = (pk.items || []).find((it) => it.domain === 'qzone.qq.com' && it.pskey)
    if (hit) jar.p_skey = hit.pskey
  }
  if (!jar.uin) jar.uin = uin
  if (!jar.p_skey && !jar.skey) throw new Error('Qzone cookie 采集失败：jump 与 pskey 兜底都没有拿到凭据')
  const bkn = bknOf(jar)
  jarCache = { jar, bkn, at: Date.now(), uin }
  return { jar, bkn, uin }
}

function httpText (url, method = 'GET', body = '', headers = {}, timeoutMs = 20000) {
  return new Promise((ok, fail) => {
    const target = new URL(url)
    const payload = (body && method !== 'GET') ? Buffer.from(body, 'utf8') : null
    const mod = target.protocol === 'https:' ? https : http
    const req = mod.request(target, {
      method,
      headers: {
        'User-Agent': UA,
        ...(payload ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': payload.length } : {}),
        ...headers
      }
    }, (res) => {
      const chunks = []
      let size = 0
      res.on('data', (chunk) => {
        size += chunk.length
        if (size > 64 * 1024 * 1024) { req.destroy(); fail(new Error('Qzone 响应超过 64MB，中止')); return }
        chunks.push(chunk)
      })
      res.on('end', () => ok(Buffer.concat(chunks).toString('utf8')))
      res.on('error', fail)
    })
    req.on('error', fail)
    req.setTimeout(timeoutMs, () => { req.destroy(); fail(new Error('Qzone 请求超时：' + target.host)) })
    if (payload) req.write(payload)
    req.end()
  })
}

/* GET / POST 的语义化包装，省得每处都写全 5 个参数 */
const httpGet = (url, headers) => httpText(url, 'GET', '', headers)
const httpPost = (url, body, headers) => httpText(url, 'POST', body, headers)

/** 表单 POST 三连：发请求 → 解壳 → 校验业务码，收口成一句 */
async function postForm (url, form, where, cookie) {
  const reply = parseQzoneJson(await httpPost(url, form.toString(), { Cookie: cookie }))
  assertCode(reply, where)
  return reply
}

const postMultipart = (url, cookie, form) => fetch(url, {
  method: 'POST',
  body: form,
  headers: { Cookie: cookie }
})

/** Qzone CGI 的三种外壳都吃：裸 JSON、`_Callback({...})`、`back({...});` */
function parseQzoneJson (text) {
  const raw = String(text).trim()
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first !== -1 && last > first) {
    try { return JSON.parse(raw.slice(first, last + 1)) } catch { /* 往下试 back() 形态 */ }
  }
  const mark = raw.lastIndexOf('back(')
  if (mark !== -1) {
    const close = raw.indexOf(');', mark)
    if (close !== -1) {
      const call = raw.slice(mark + 5, close)
      const b0 = call.indexOf('{')
      const b1 = call.lastIndexOf('}')
      if (b0 !== -1 && b1 > b0) return JSON.parse(call.slice(b0, b1 + 1))
    }
  }
  throw new Error('Qzone 响应解析失败（非 JSON/JSONP）: ' + raw.slice(0, 200))
}

function assertCode (reply, where) {
  for (const field of ['code', 'subcode']) {
    const got = reply[field]
    if (typeof got !== 'number' || got === 0) continue
    const tail = reply.message ?? reply.msg ?? ''
    throw new Error(`Qzone ${where} 失败：${field}=${got} ${tail}`.trim())
  }
}

function pickPicUrl (pic) {
  return [pic.url3, pic.url2, pic.url1, pic.smallurl].find((u) => !!u) || ''
}

/** 依次取第一个非 null/undefined 的键；全空就落回 fallback */
function firstOf (obj, keys, fallback) {
  for (const key of keys) {
    const got = obj[key]
    if (got !== undefined && got !== null) return got
  }
  return fallback
}

/** base64 粗校验：只允许标准字符表，且 '=' 只能出现在末尾、最多两个 */
function isBase64ish (s) {
  if (s.length === 0) return false
  let end = s.length
  while (end > 0 && s[end - 1] === '=') end -= 1
  if (end === 0) return false
  const core = s.slice(0, end)
  if (/[^A-Za-z0-9+/]/.test(core)) return false
  return end >= s.length - 2
}

const nowSec = () => Math.trunc(Date.now() / 1000)

/* ------------------------------------------------------------------ *
 * 说说列表 / 详情
 * ------------------------------------------------------------------ */

export async function getMsgList ({ target_uin: targetUin, pos = 0, num = 20 } = {}) {
  const { jar, bkn, uin } = await qzoneAuth()
  const host = (targetUin && Number(targetUin) > 0) ? String(targetUin) : uin
  const cookie = cookieToStr(jar)
  const base = formOf([
    ['uin', host],
    ['ftype', '0'],
    ['sort', '0'],
    ['pos', String(pos)],
    ['num', String(num)],
    ['replynum', '100'],
    ['g_tk', bkn],
    ['code_version', '1'],
    ['format', 'jsonp'],
    ['callback', '_preloadCallback'],
    ['need_private_comment', '1']
  ])
  let text = await httpGet('https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_msglist_v6?' + base, { Cookie: cookie })
  let reply = parseQzoneJson(text)
  /* -10000 是「使用人数过多」的老网关限流，换 user.qzone 路由重来一次 */
  if (reply.code === -10000) {
    const retry = formOf([
      ['uin', host],
      ['ftype', '0'],
      ['sort', '0'],
      ['pos', String(pos)],
      ['num', String(num)],
      ['g_tk', bkn],
      ['code_version', '1'],
      ['format', 'json']
    ])
    text = await httpGet('https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6?' + retry, {
      Cookie: cookie,
      Referer: `https://user.qzone.qq.com/${host}`
    })
    reply = parseQzoneJson(text)
  }
  assertCode(reply, '说说列表')
  const list = reply.msglist
  if (!Array.isArray(list)) {
    throw new Error(`无法获取空间说说列表（响应结构异常，多半是 cookie 失效）: ${text.slice(0, 200)}`)
  }
  const rows = []
  for (const post of list) {
    const pics = Array.isArray(post.pic) ? post.pic : []
    const row = {}
    row.tid = String(post.tid ?? '')
    row.content = post.content ?? ''
    row.time = Number(post.created_time ?? 0)
    row.comment_num = Number(post.cmtnum ?? 0)
    row.is_private = Number(post.secret ?? 0) !== 0
    row.images = pics.map(pickPicUrl).filter(Boolean)
    rows.push(row)
  }
  const out = {}
  out.total = Number(reply.total ?? list.length)
  out.msglist = rows
  return out
}

async function fetchMsgDetail (jar, bkn, host, tid, page) {
  const pairs = [
    ['tid', tid],
    ['uin', host],
    ['t1_source', '1'],
    ['not_trunc_con', '1'],
    ['need_right', '1'],
    ['not_adapt_outpic', '1'],
    ['g_tk', bkn]
  ]
  if (page) pairs.push(['pos', String(page.pos)], ['num', String(page.num)])
  const text = await httpGet('https://h5.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msgdetail_v6?' + formOf(pairs), { Cookie: cookieToStr(jar) })
  const detail = parseQzoneJson(text)
  let code = detail.subcode ?? detail.code ?? -1
  if (detail.code !== undefined && detail.code !== 0) code = detail.code
  if (code !== 0) {
    const tail = detail.message ?? detail.msg ?? ''
    throw new Error(`Qzone 说说详情失败：code=${code} ${tail}`.trim())
  }
  return detail
}

function mapComment (raw, field) {
  if (!raw || typeof raw !== 'object') throw new Error(`说说详情 ${field} 结构异常`)
  const id = String(raw.tid ?? '')
  if (!id) throw new Error(`说说详情 ${field}.tid 缺失`)
  const out = {}
  out.comment_id = id
  out.uin = Number(raw.uin) || 0
  out.name = String(raw.name ?? '')
  out.time = Number(raw.create_time) || 0
  out.content = String(raw.content ?? '')
  return out
}

export async function getMsgDetail ({ tid, target_uin: targetUin, pos = 0, num = 20 } = {}) {
  if (!tid) throw new Error('tid 必填')
  const { jar, bkn, uin } = await qzoneAuth()
  const host = (targetUin !== undefined && Number(targetUin) > 0) ? String(targetUin) : uin
  const data = await fetchMsgDetail(jar, bkn, host, tid, { pos, num })
  if (String(data.tid ?? '') !== tid) throw new Error('说说详情 tid 与请求不一致')
  const threads = []
  const list = Array.isArray(data.commentlist) ? data.commentlist : []
  list.forEach((cmt, i) => {
    const subs = Array.isArray(cmt.list_3) ? cmt.list_3 : []
    const thread = mapComment(cmt, `commentlist[${i}]`)
    thread.replies = subs.map((rep, j) => mapComment(rep, `list_3[${j}]`))
    threads.push(thread)
  })
  const out = {}
  out.tid = tid
  out.content = String(data.content ?? '')
  out.comment_num = Number(data.cmtnum) || 0
  out.comments = threads
  return out
}

/* ------------------------------------------------------------------ *
 * 好友动态：JS 对象字面量解析（绝不 eval）
 * ------------------------------------------------------------------ */

/** 把 feeds 返回的 JS 字面量读成纯数据：容忍裸键、单引号串、\xNN/\uNNNN、
 *  undefined 空洞；__proto__ 一律丢弃防原型污染。 */
function parseJsLiteral (source) {
  const SPACE = new Set([' ', '\t', '\n', '\r', '\f', '\v'])
  const WORD = new Set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$')
  const STOP = new Set([',', '}', ']', ':', ' ', '\t', '\n', '\r'])
  const ESCAPES = new Map([['n', '\n'], ['t', '\t'], ['r', '\r'], ['b', '\b'], ['f', '\f'], ['v', '\v'], ['0', '\0']])

  let at = 0
  const total = source.length
  const here = () => source[at]
  const skipSpace = () => { while (at < total && SPACE.has(source[at])) at += 1 }

  const hexChar = (size) => {
    const part = source.substr(at + 2, size)
    at += 2 + size
    return String.fromCharCode(Number.parseInt(part, 16))
  }

  function readString (quote) {
    at += 1
    let acc = ''
    while (at < total) {
      const ch = source[at]
      if (ch === '\\') {
        const next = source[at + 1]
        if (next === 'x') { acc += hexChar(2); continue }
        if (next === 'u') { acc += hexChar(4); continue }
        acc += ESCAPES.get(next) ?? (next ?? '')
        at += 2
        continue
      }
      if (ch === quote) { at += 1; return acc }
      acc += ch
      at += 1
    }
    throw new Error('feeds 字面量字符串未闭合')
  }

  function readKey () {
    skipSpace()
    const quote = here()
    if (quote === '"' || quote === "'") return readString(quote)
    let word = ''
    while (at < total && WORD.has(source[at])) { word += source[at]; at += 1 }
    if (!word) throw new Error('feeds 字面量缺键名')
    return word
  }

  function readScalar () {
    let word = ''
    while (at < total && !STOP.has(source[at])) { word += source[at]; at += 1 }
    switch (word) {
      case 'true': return true
      case 'false': return false
      case 'null': return null
      case 'undefined': return undefined
      case '': break
      default: {
        const maybe = Number(word)
        if (!Number.isNaN(maybe)) return maybe
      }
    }
    throw new Error('feeds 字面量非法 token: ' + word.slice(0, 20))
  }

  function readValue () {
    skipSpace()
    const ch = here()
    if (ch === '{') return readObject()
    if (ch === '[') return readArray()
    if (ch === '"' || ch === "'") return readString(ch)
    if (ch === undefined) throw new Error('feeds 字面量意外结束')
    return readScalar()
  }

  function readObject () {
    at += 1
    const obj = {}
    skipSpace()
    while (here() !== '}') {
      const key = readKey()
      skipSpace()
      if (here() !== ':') throw new Error('feeds 字面量缺冒号')
      at += 1
      const val = readValue()
      if (key !== '__proto__') obj[key] = val
      skipSpace()
      const sep = here()
      if (sep === '}') break
      if (sep !== ',') throw new Error('feeds 字面量缺逗号/右括号')
      at += 1
      skipSpace()
    }
    if (here() !== '}') throw new Error('feeds 字面量对象未闭合')
    at += 1
    return obj
  }

  function readArray () {
    at += 1
    const arr = []
    skipSpace()
    while (here() !== ']') {
      arr.push(readValue())
      skipSpace()
      const sep = here()
      if (sep === ']') break
      if (sep !== ',') throw new Error('feeds 数组缺逗号/右括号')
      at += 1
      skipSpace()
    }
    if (here() !== ']') throw new Error('feeds 数组未闭合')
    at += 1
    return arr
  }

  return readValue()
}

function parseQzoneCallback (text) {
  const brace = text.indexOf('{')
  if (brace === -1) throw new Error('feeds 响应解析失败（无对象体）')
  const value = parseJsLiteral(text.slice(brace))
  if (typeof value !== 'object' || value === null) throw new Error('feeds 响应解析失败（非对象）')
  return value
}

export async function getFeeds ({ page_num: pageNum = 1, count = 10 } = {}) {
  const { jar, bkn, uin } = await qzoneAuth()
  const pairs = [
    ['uin', uin],
    ['scope', '0'],
    ['view', '1'],
    ['filter', 'all'],
    ['flag', '1'],
    ['applist', 'all'],
    ['pagenum', String(pageNum)],
    ['count', String(count)],
    ['aisortEndTime', '0'],
    ['aisortOffset', '0'],
    ['aisortBeginTime', '0'],
    ['begintime', '0'],
    ['g_tk', bkn],
    ['useutf8', '1'],
    ['callback', '_preloadCallback'],
    ['format', 'jsonp'],
    ['outputhtmlfeed', '1']
  ]
  const text = await httpGet('https://h5.qzone.qq.com/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds3_html_more?' + formOf(pairs), { Cookie: cookieToStr(jar) })
  const reply = parseQzoneCallback(text)
  assertCode(reply, '好友动态')
  const bucket = reply.data || {}
  const feeds = []
  for (const raw of (bucket.data || [])) {
    if (!raw) continue
    const item = {}
    item.uin = Number(raw.uin) || 0
    item.nickname = raw.nickname ?? ''
    item.time = Number(raw.abstime) || 0
    item.appid = Number(raw.appid) || 0
    item.key = String(raw.key ?? raw.feedskey ?? '')
    item.html = raw.html ?? ''
    feeds.push(item)
  }
  return { feeds, has_more: Number(bucket.hasmore) !== 0 }
}

/* ------------------------------------------------------------------ *
 * 发 / 删 / 赞 / 评 / 拉黑
 * ------------------------------------------------------------------ */

const UGC_RIGHTS = new Set([1, 4, 16, 64, 128])

function normalizeUgcRight (ugcRight) {
  const want = Number(ugcRight) || 1
  if (UGC_RIGHTS.has(want)) return want
  throw new Error('ugc_right 只能是 1/4/16/64/128')
}

function normalizeTargetUins (targetUins) {
  const text = String(targetUins ?? '').trim()
  if (text.length === 0) return ''
  const uniq = []
  const seen = new Set()
  text.split('|').forEach((chunk) => {
    const one = chunk.trim()
    if (!one) return
    if (!/^[0-9]+$/.test(one)) throw new Error('target_uins 必须是 | 分隔的 QQ 号')
    if (seen.has(one)) return
    seen.add(one)
    uniq.push(one)
  })
  return uniq.join('|')
}

/** 富文本两参数必须同进同出。strict 时再校验 rich_type 是正整数（发说说要，评论不要求）。 */
function richPair (richType, richval, strict) {
  const flagged = richType !== undefined && richType !== null && String(richType) !== ''
  const filled = richval !== undefined && String(richval).trim().length > 0
  if (flagged !== filled) throw new Error('rich_type 和 richval 必须成对给')
  if (flagged && strict) {
    const numeric = Number(richType)
    if (!Number.isInteger(numeric) || numeric < 1) throw new Error('rich_type 必须是正整数')
  }
  return { on: flagged, type: flagged ? String(richType) : '', text: filled ? String(richval) : '' }
}

/** ugc_right=16/128 是白名单可见，必须带目标 uin 列表 */
function visibleTargets (right, targetUins) {
  if (right !== 16 && right !== 128) return ''
  const list = normalizeTargetUins(targetUins)
  if (!list) throw new Error('ugc_right=16/128 时 target_uins 必填')
  return list
}

export async function publish ({ content, rich_type: richType, richval, ugc_right: ugcRight = 1, target_uins: targetUins } = {}) {
  if (!content) throw new Error('content 必填')
  const rich = richPair(richType, richval, true)
  const right = normalizeUgcRight(ugcRight)
  const targets = visibleTargets(right, targetUins)
  const { jar, bkn, uin } = await qzoneAuth()
  const pairs = [
    ['con', content],
    ['syn_tweet_verson', '1'],
    ['paramstr', '1'],
    ['pic_template', ''],
    ['richtype', rich.type],
    ['richval', rich.text],
    ['special_url', ''],
    ['subrichtype', ''],
    ['feedversion', '1'],
    ['ver', '1'],
    ['ugc_right', String(right)],
    ['to_sign', '0'],
    ['who', '1'],
    ['hostuin', uin],
    ['code_version', '1'],
    ['format', 'json'],
    ['qzreferrer', `https://user.qzone.qq.com/${uin}`]
  ]
  if (targets) pairs.push(['allow_uins', targets])
  const reply = await postForm(`https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=${bkn}`, formOf(pairs), '发说说', cookieToStr(jar))
  const tid = reply.t1_tid ?? reply.tid
  if (!tid) throw new Error('发说说失败：响应缺 tid（多半被风控拒绝）')
  const out = {}
  out.tid = String(tid)
  out.time = Number(reply.t1_time ?? reply.now ?? 0)
  return out
}

export async function del ({ tid } = {}) {
  if (!tid) throw new Error('tid 必填')
  const { jar, bkn, uin } = await qzoneAuth()
  const body = formOf([
    ['hostuin', uin],
    ['tid', tid],
    ['t1_source', '1'],
    ['code_version', '1'],
    ['format', 'fs'],
    ['qzreferrer', `https://user.qzone.qq.com/${uin}`]
  ])
  await postForm(`https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_delete_v6?g_tk=${bkn}`, body, '删说说', cookieToStr(jar))
  return { tid: String(tid) }
}

export async function like ({ tid, target_uin: targetUin, like = true, abstime = 0 } = {}) {
  if (!tid) throw new Error('tid 必填')
  const { jar, bkn, uin } = await qzoneAuth()
  const owner = (targetUin && Number(targetUin) > 0) ? String(targetUin) : uin
  const cgi = like ? 'internal_dolike_app' : 'internal_unlike_app'
  const unikey = `http://user.qzone.qq.com/${owner}/mood/${tid}`
  const body = formOf([
    ['qzreferrer', `https://user.qzone.qq.com/${uin}`],
    ['opuin', uin],
    ['unikey', unikey],
    ['curkey', unikey],
    ['appid', '311'],
    ['typeid', '0'],
    ['abstime', String(abstime)],
    ['fid', tid],
    ['from', '1'],
    ['active', '0'],
    ['fupdate', '1'],
    ['format', 'json']
  ])
  await postForm(`https://h5.qzone.qq.com/proxy/domain/w.qzone.qq.com/cgi-bin/likes/${cgi}?g_tk=${bkn}`, body, like ? '点赞' : '取消赞', cookieToStr(jar))
  return { tid, like: !!like, target_uin: Number(owner) }
}

export async function comment ({ tid, content, target_uin: targetUin, rich_type: richType, richval } = {}) {
  if (!tid) throw new Error('tid 必填')
  if (!content) throw new Error('content 必填')
  const rich = richPair(richType, richval)
  const { jar, bkn, uin } = await qzoneAuth()
  const host = (targetUin && Number(targetUin) > 0) ? String(targetUin) : uin
  const body = formOf([
    ['qzreferrer', `https://user.qzone.qq.com/${uin}`],
    ['inCharset', 'utf-8'],
    ['outCharset', 'utf-8'],
    ['hostUin', host],
    ['format', 'json'],
    ['ref', 'feeds'],
    ['topicId', `${host}_${tid}__1`],
    ['feedsType', '100'],
    ['private', '0'],
    ['paramstr', '1'],
    ['richtype', rich.type],
    ['richval', rich.text],
    ['isSignIn', ''],
    ['uin', uin],
    ['content', content],
    ['plat', 'qzone'],
    ['source', 'ic'],
    ['platformid', '52']
  ])
  const reply = await postForm(`https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds?g_tk=${bkn}`, body, '评论说说', cookieToStr(jar))
  const cid = reply.commentid ?? reply.commentId
  const out = {}
  out.comment_id = cid === undefined ? '' : String(cid)
  out.tid = tid
  out.target_uin = Number(host)
  return out
}

export async function setBlack ({ target_uin: targetUin, ban = true } = {}) {
  const who = String(targetUin ?? '').trim()
  if (!/^\d{5,12}$/.test(who)) throw new Error('target_uin 必须是 QQ 号')
  const { jar, bkn, uin } = await qzoneAuth()
  const body = formOf([
    ['uin', uin],
    ['act_uin', who],
    ['action', ban ? '1' : '2'],
    ['fupdate', '1'],
    ['qzreferrer', `https://user.qzone.qq.com/${uin}/main`]
  ])
  const text = await httpPost(`https://h5.qzone.qq.com/proxy/domain/w.qzone.qq.com/cgi-bin/right/cgi_black_action_new?g_tk=${bkn}`, body.toString(), { Cookie: cookieToStr(jar) })
  const reply = parseQzoneJson(text.replace(/(\{\s*)name\s*:/, '$1"name":'))
  assertCode(reply, ban ? '空间拉黑' : '空间解拉黑')
  return { target_uin: Number(who), ban: !!ban }
}

/* ------------------------------------------------------------------ *
 * 说说配图上传
 * ------------------------------------------------------------------ */

export async function uploadImage ({ image } = {}) {
  let b64 = String(image ?? '').trim()
  if (!b64) throw new Error('image 必填（base64 或 data URI）')
  if (b64.slice(0, 5).toLowerCase() === 'data:') {
    const comma = b64.indexOf(',')
    if (comma === -1) throw new Error('data URI 缺 base64 载荷')
    b64 = b64.slice(comma + 1)
  }
  const compact = b64.split(' ').join('+').replace(/\r|\n|\t/g, '')
  if (!isBase64ish(compact)) throw new Error('image 不是合法 base64')
  const { jar, bkn, uin } = await qzoneAuth()
  /* 三路上传地址：备份机 + 老 IP 机 + 直连，服务端按顺序挑可用的 */
  const mirror = 'http://upbak.photo.qzone.qq.com/cgi-bin/upload/cgi_upload_image'
  const legacy = 'http://119.147.64.75/cgi-bin/upload/cgi_upload_image'
  const direct = 'https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image'
  const backUrls = [mirror, legacy].join(',') + '&url=' + direct + '?g_tk=' + bkn
  const body = formOf([
    ['filename', 'filename'],
    ['uin', uin],
    ['skey', jar.skey || ''],
    ['zzpaneluin', uin],
    ['p_uin', uin],
    ['p_skey', jar.p_skey || ''],
    ['uploadtype', '1'],
    ['albumtype', '7'],
    ['exttype', '0'],
    ['refer', 'shuoshuo'],
    ['output_type', 'jsonhtml'],
    ['charset', 'utf-8'],
    ['output_charset', 'utf-8'],
    ['upload_hd', '1'],
    ['hd_width', '2048'],
    ['hd_height', '10000'],
    ['hd_quality', '96'],
    ['backUrls', backUrls],
    ['base64', '1'],
    ['jsonhtml_callback', 'callback'],
    ['picfile', compact],
    ['qzreferrer', `https://user.qzone.qq.com/${uin}/main`]
  ])
  const reply = await postForm(`https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image?g_tk=${bkn}`, body, '上传空间图片', cookieToStr(jar))
  const pic = reply.data
  if (!pic || !pic.albumid || !pic.lloc || !pic.url) throw new Error('上传图片失败：响应缺必要字段')
  const height = Number(pic.height) || 0
  const width = Number(pic.width) || 0
  const type = Number(pic.type) || 0
  const out = {}
  out.richval = `,${pic.albumid},${pic.lloc},${pic.lloc},${type},${height},${width},,${height},${width}`
  out.url = pic.url
  out.albumid = String(pic.albumid)
  out.lloc = String(pic.lloc)
  out.type = type
  out.width = width
  out.height = height
  return out
}

/** 从图片的各档 URL 里抠 bo 参数（服务端认这个做去重键） */
function boOf (pic) {
  for (const key of ['smallurl', 'url1', 'url2', 'url3']) {
    const link = pic[key]
    if (!link) continue
    const at = link.search(/[?&]bo=/)
    if (at < 0) continue
    const tail = link.slice(at + 4)
    const cut = tail.search(/[&#]/)
    if (cut === 0) continue
    return decodeURIComponent(cut < 0 ? tail : tail.slice(0, cut))
  }
  return ''
}

export async function updateRight ({ tid, ugc_right: ugcRight, target_uins: targetUins } = {}) {
  if (!tid) throw new Error('tid 必填')
  const right = normalizeUgcRight(ugcRight)
  const targets = visibleTargets(right, targetUins)
  const { jar, bkn, uin } = await qzoneAuth()
  /* emotion_cgi_update 是整条重提交：图片、正文、富文本都得从 msgdetail 原样搬回去 */
  const detail = await fetchMsgDetail(jar, bkn, uin, tid)
  const pics = Array.isArray(detail.pic) ? detail.pic : []
  const richvals = []
  const boList = []
  for (const pic of pics) {
    const id = String(pic.pic_id ?? '')
    if (!id) continue
    const seg = id.split(',')
    const album = seg[1] ?? ''
    const lloc = seg[2] ?? ''
    if (!album || !lloc) throw new Error('说说图片信息不可用，无法安全重建更新载荷')
    const kind = String(firstOf(pic, ['pictype', 'type'], 22))
    const h = String(firstOf(pic, ['height', 'b_height'], 0))
    const w = String(firstOf(pic, ['width', 'b_width'], 0))
    richvals.push(`,${album},${lloc},${lloc},${kind},${h},${w},,0,0`)
    const bo = boOf(pic)
    if (bo) boList.push(bo)
  }
  let richtype
  if (detail.richtype === undefined) richtype = pics.length === 0 ? '' : 1
  else richtype = Number(detail.richtype)
  if (richvals.length === 0 && Number(richtype) === 1) {
    throw new Error('带图说说缺图片信息，无法重建更新载荷')
  }
  let content = detail.content ?? ''
  const fragments = []
  for (const piece of (Array.isArray(detail.conlist) ? detail.conlist : [])) {
    if (piece && typeof piece.con === 'string') fragments.push(piece.con)
  }
  if (fragments.length > 0) content = fragments.join('').trim()
  let subrichtype = firstOf(detail, ['t1_subtype', 'subrichtype'], undefined)
  if (subrichtype === undefined) subrichtype = richvals.length === 0 ? '' : 1
  const boGroup = boList.join(',')
  const picBo = boGroup ? boGroup + '\t' + boGroup : ''
  const richval = richvals.length === 0 ? (detail.richval ?? '') : richvals.join('\t')
  const toSign = String(Number(detail.to_sign ?? 0))
  const pairs = [
    ['tid', tid],
    ['con', content],
    ['syn_tweet_verson', '1'],
    ['paramstr', '1'],
    ['pic_template', detail.pic_template ?? ''],
    ['richtype', String(richtype)],
    ['richval', richval],
    ['special_url', detail.special_url ?? ''],
    ['subrichtype', String(subrichtype)],
    ['pic_bo', picBo],
    ['feedversion', String(detail.feedversion ?? 1)],
    ['ver', String(detail.ver ?? 1)],
    ['ugc_right', String(right)],
    ['to_sign', toSign],
    ['ugcright_id', String(detail.ugcright_id ?? tid)],
    ['hostuin', uin],
    ['code_version', String(detail.code_version ?? 1)],
    ['format', 'fs'],
    ['qzreferrer', `https://user.qzone.qq.com/${uin}`]
  ]
  if (targets) pairs.push(['allow_uins', targets])
  const reply = await postForm(`https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_update?g_tk=${bkn}`, formOf(pairs), '改说说权限', cookieToStr(jar))
  return { tid, ugc_right: Number(reply.ugc_right ?? right) }
}

/* ------------------------------------------------------------------ *
 * 群相册
 * ------------------------------------------------------------------ */

const ALBUM_SLICE = 16384 /* 服务端强制 16KB 分片，别改 */

const BLANK_RUN = /\s+/g

/** 图片输入归一化：base64 / data URI / 本地路径 / http(s) URL → { bytes, name } */
async function loadAlbumImage (image) {
  const raw = String(image ?? '').trim()
  if (!raw) throw new Error('image 必填（base64 / data URI / 本地路径 / http URL）')
  let bytes = null
  let name = 'album_' + Date.now() + '.png'
  if (raw.slice(0, 5).toLowerCase() === 'data:') {
    const cut = raw.indexOf(',')
    if (cut < 0) throw new Error('data URI 缺 base64 载荷')
    bytes = Buffer.from(raw.slice(cut + 1).replace(BLANK_RUN, ''), 'base64')
    const m = /^data:image\/(\w+)/.exec(raw)
    if (m && m[1] !== 'png') name = 'album_' + Date.now() + '.' + m[1]
  } else if (/^https?:\/\//i.test(raw)) {
    const res = await fetch(raw)
    if (!res.ok) throw new Error(`下载图片失败 HTTP ${res.status}`)
    bytes = Buffer.from(await res.arrayBuffer())
    const m = /\/([^/?#]+)\.(jpe?g|png|gif|webp|bmp)(?:[?#]|$)/i.exec(raw)
    if (m) name = m[1] + '.' + m[2].toLowerCase()
  } else if (/^base64:/i.test(raw)) {
    bytes = Buffer.from(raw.slice(7).replace(BLANK_RUN, ''), 'base64')
  } else {
    const fs = await import('node:fs')
    const compact = raw.replace(BLANK_RUN, '')
    /* 顺序要紧：先按路径读，ENOENT 才当裸 base64 */
    try {
      bytes = fs.readFileSync(raw)
      name = raw.replace(/\\/g, '/').split('/').pop() || name
    } catch (e) {
      if (compact.length < 16 || !isBase64ish(compact)) {
        throw new Error(`image 既不是可读文件也不是合法 base64：${e.message.slice(0, 80)}`)
      }
      bytes = Buffer.from(compact, 'base64')
    }
  }
  if (!bytes || !bytes.length) throw new Error('image 内容为空')
  if (!isKnownImageHead(bytes)) throw new Error('群相册上传仅支持 JPEG/PNG/GIF/WebP/BMP 图片')
  return { bytes, name }
}

/* 各图片格式的起始魔数 + 最短长度 */
const IMAGE_HEADS = [
  { size: 2, sig: [0xff, 0xd8] }, /* JPEG SOI */
  { size: 8, sig: [0x89, 0x50, 0x4e, 0x47] }, /* PNG */
  { size: 6, sig: [0x47, 0x49, 0x46, 0x38] }, /* GIF8 */
  { size: 2, sig: [0x42, 0x4d] } /* BM */
]

function isKnownImageHead (buf) {
  const known = IMAGE_HEADS.some(({ size, sig }) =>
    buf.length >= size && sig.every((byte, i) => buf[i] === byte))
  if (known) return true
  if (buf.length < 12) return false
  /* RIFF....WEBP */
  return buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
}

function albumCookie (jar, uin) {
  return `p_uin=o${uin}; p_skey=${jar.p_skey || ''}; skey=${jar.skey || ''}; uin=o${uin}`
}

export async function albumList ({ group } = {}) {
  const gid = String(group ?? '').trim()
  if (!/^\d{5,12}$/.test(gid)) throw new Error('group 必须是群号')
  const { jar, bkn, uin } = await qzoneAuth()
  const qs = formOf([
    ['random', '7570'],
    ['g_tk', bkn],
    ['format', 'json'],
    ['inCharset', 'utf-8'],
    ['outCharset', 'utf-8'],
    ['qua', 'V1_IPH_SQ_6.2.0_0_HDBM_T'],
    ['cmd', 'qunGetAlbumList'],
    ['qunId', gid],
    ['qunid', gid],
    ['start', '0'],
    ['num', '1000'],
    ['uin', uin],
    ['getMemberRole', '0']
  ])
  const text = await httpGet('https://h5.qzone.qq.com/proxy/domain/u.photo.qzone.qq.com/cgi-bin/upp/qun_list_album_v2?' + qs, { Cookie: cookieToStr(jar) })
  const data = parseQzoneJson(text)
  assertCode(data, '群相册列表')
  const list = (data.data && data.data.album) || []
  const album = list.map((a) => ({
    id: String(a.id ?? ''),
    name: String(a.title ?? ''),
    picNum: Number(a.photocnt ?? 0),
    createTime: String(a.createtime ?? ''),
    owner: String(a.createuin ?? ''),
    ownerNick: String(a.createnickname ?? ''),
    desc: String(a.desc ?? '')
  }))
  return { group: gid, count: album.length, album }
}

/** 建会话请求的公共骨架：token/env/model/session 各版本都一样 */
function controlReq ({ uin, jar, appid, checksum, checkType, fileLen, refer, bizReq, cmd }) {
  return {
    uin,
    token: { type: 4, data: jar.p_skey || '', appid: 5 },
    appid,
    checksum,
    check_type: checkType,
    file_len: fileLen,
    env: { deviceInfo: 'h5', refer },
    model: 0,
    biz_req: bizReq,
    session: '',
    asy_upload: 0,
    cmd
  }
}

/** 普通图片上传的 biz_req（相册图 / 视频封面共用，差别在外层补的字段） */
function picBizReq ({ title, albumId, albumName, group, batchId, uploadType, uploadTime, mapParams }) {
  return {
    sAlbumID: albumId,
    sAlbumName: albumName,
    sPicTitle: title,
    sPicDesc: '',
    iUploadTime: uploadTime,
    iBatchID: batchId,
    iAlbumTypeID: 0,
    iBitmap: 0,
    iDistinctUse: 0,
    iNeedFeeds: 1,
    iPicHight: 0,
    iPicWidth: 0,
    iUpPicType: 0,
    iUploadType: uploadType,
    iWaterType: 0,
    mapExt: { userid: group, appid: 'qun' },
    sPicPath: '',
    stExtendInfo: { mapParams }
  }
}

/** 视频封面的 biz_req：比普通图多一批 exif / 混排字段 */
function coverBizReq ({ title, albumId, albumName, group, batchId, uploadTime, vid }) {
  const biz = picBizReq({
    title,
    albumId,
    albumName,
    group,
    batchId,
    uploadType: 2,
    uploadTime,
    mapParams: { vid, photo_num: '0', video_num: '1' }
  })
  biz.mutliPicInfo = { iCurUpload: 0, iBatUploadNum: 1, iFailNum: 0, iSuccNum: 0 }
  biz.stExternalMapExt = { is_client_upload_cover: '1', is_pic_video_mix_feeds: '1' }
  biz.sExif_CameraMaker = ''
  biz.sExif_CameraModel = ''
  biz.sExif_Time = ''
  biz.sExif_LatitudeRef = ''
  biz.sExif_Latitude = ''
  biz.sExif_LongitudeRef = ''
  biz.sExif_Longitude = ''
  return biz
}

/** 视频主体的 biz_req（FileUploadVideo 专用字段） */
function videoBizReq ({ title, group, uploadTime, playTime }) {
  return {
    iAlbumTypeID: 0,
    iBitmap: 0,
    iBatchID: 0,
    iDistinctUse: 0,
    iFlag: 0,
    iIsFormatF20: 0,
    iIsNew: 111,
    iIsOriginalVideo: 0,
    iPicHight: 0,
    iPicWidth: 0,
    iPlayTime: playTime,
    iUpPicType: 0,
    iUploadType: 3,
    iUploadTime: uploadTime,
    iWaterType: 0,
    sAlbumID: '',
    sAlbumName: '',
    sCoverUrl: '',
    sDesc: '',
    sPicDesc: '',
    sPicPath: '',
    sPicTitle: title,
    sTitle: title,
    extend_info: { domainid: '5', qun_id: group, video_num: '1', photo_num: '0', video_type: '3' }
  }
}

/** 建上传会话（FileBatchControl）：返回服务端下发的 session 与分片大小 */
async function openUploadSession ({ checksum, cookie, bkn, req: control }) {
  const res = await fetch(`https://h5.qzone.qq.com/webapp/json/sliceUpload/FileBatchControl/${checksum}?g_tk=${bkn}`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ control_req: [control] })
  })
  const json = await res.json().catch(() => null)
  if (!json || json.ret !== 0 || !json.data || !json.data.session) {
    throw new Error(`建上传会话失败：${(json && json.msg) || ('HTTP ' + res.status)}`)
  }
  const sliceSize = json.data.slice_size > 0 ? json.data.slice_size : ALBUM_SLICE
  return { session: json.data.session, sliceSize }
}

/** 拼一片 multipart：文件部分夹在 offset 之后，其余字段沿用客户端顺序 */
function sliceForm ({ uin, appid, session, offset, end, seq, blob, checkType, sliceSize, uploadType }) {
  const form = new FormData()
  for (const [k, v] of [['uin', uin], ['appid', appid], ['session', session], ['offset', String(offset)]]) form.append(k, v)
  const part = new Blob([blob], { type: 'application/octet-stream' })
  form.append('data', part, 'blob')
  const rest = [
    ['checksum', ''],
    ['check_type', String(checkType)],
    ['retry', '0'],
    ['seq', String(seq)],
    ['end', String(end)],
    ['cmd', 'FileUpload'],
    ['slice_size', String(sliceSize)]
  ]
  if (uploadType !== undefined && uploadType !== null) rest.push(['biz_req.iUploadType', String(uploadType)])
  for (const [k, v] of rest) form.append(k, v)
  return form
}

const sliceApi = (uploadCmd, bkn, seq, offset, end, total) =>
  `https://h5.qzone.qq.com/webapp/json/sliceUpload/${uploadCmd}?seq=${seq}&retry=0&offset=${offset}&end=${end}&total=${total}&type=form&g_tk=${bkn}`

/** 上传图片到群相册：FileBatchControl 建 session → 16KB 分片 FileUpload（全走 HTTP，不碰 Highway） */
export async function albumUploadImage ({ group, album_id: albumId, album_name: albumName, image } = {}) {
  const gid = String(group ?? '').trim()
  if (!/^\d{5,12}$/.test(gid)) throw new Error('group 必须是群号')
  if (!String(albumId ?? '').trim()) throw new Error('album_id 必填（先用 albumList 查）')
  const { bytes, name } = await loadAlbumImage(image)
  const { createHash } = await import('node:crypto')
  const md5 = createHash('md5').update(bytes).digest('hex')
  const { jar, bkn, uin } = await qzoneAuth()
  const cookie = albumCookie(jar, uin)
  const ts = nowSec()

  const { session } = await openUploadSession({
    checksum: md5,
    cookie,
    bkn,
    req: controlReq({
      uin,
      jar,
      appid: 'qun',
      checksum: md5,
      checkType: 0,
      fileLen: bytes.length,
      refer: 'qzone',
      bizReq: picBizReq({
        title: name,
        albumId: String(albumId),
        albumName: String(albumName ?? ''),
        group: gid,
        batchId: ts,
        uploadType: 0,
        uploadTime: ts,
        mapParams: { photo_num: '1', batch_num: '1', video_num: '0' }
      }),
      cmd: 'FileUpload'
    })
  })

  let seq = 0
  let offset = 0
  while (offset < bytes.length) {
    const chunk = bytes.subarray(offset, Math.min(offset + ALBUM_SLICE, bytes.length))
    const end = offset + chunk.length
    const api = sliceApi('FileUpload', bkn, seq, offset, end, bytes.length)
    const form = sliceForm({ uin, appid: 'qun', session, offset, end, seq, blob: chunk, checkType: 0, sliceSize: ALBUM_SLICE, uploadType: 0 })
    const res = await postMultipart(api, cookie, form)
    if (!res.ok) throw new Error(`分片 ${seq} 上传 HTTP ${res.status}`)
    const j = await res.json().catch(() => null)
    if (!j || j.ret !== 0) throw new Error(`分片 ${seq} 上传失败：${(j && j.msg) || '无响应体'}`)
    offset = end
    seq++
  }
  return { group: gid, album_id: String(albumId), md5, size: bytes.length, slices: seq, session }
}

/* 群相册视频封面需要本地 ffmpeg：默认走 PATH，可用 FL_FFMPEG / FL_FFPROBE 指定完整路径 */
const FFMPEG = process.env.FL_FFMPEG || 'ffmpeg'
const FFPROBE = process.env.FL_FFPROBE || 'ffprobe'

const basename = (p) => String(p).split(/[/\\]/).pop()

async function ffBin (p, what) {
  if (p.indexOf('/') < 0 && p.indexOf('\\') < 0) return p   /* 裸命令名交给 PATH 解析 */
  const fs = await import('node:fs')
  if (!fs.existsSync(p)) throw new Error(`未找到 ${what}（${p}）：群相册视频上传需要本地 ffmpeg，可用 FL_FFMPEG / FL_FFPROBE 指定路径`)
  return p
}

/** execFile 的 promise 版。binary=true 时按 Buffer 收 stdout——
 *  封面是 JPEG，按 utf8 解码会毁字节，服务端校验不过就不落盘。 */
async function ffRun (exe, args, opts) {
  const { execFile } = await import('node:child_process')
  const o = opts || {}
  return new Promise((ok, fail) => {
    execFile(exe, args, {
      maxBuffer: o.maxBuffer || 32 * 1024 * 1024,
      timeout: 60000,
      encoding: o.binary ? 'buffer' : 'utf8'
    }, (err, stdout, stderr) => {
      if (err) {
        const miss = err && err.code === 'ENOENT' ? '（找不到可执行文件，请安装 ffmpeg 或用 FL_FFMPEG / FL_FFPROBE 指定路径）' : ''
        return fail(new Error(`${basename(exe)} 失败${miss}：${String(stderr || err.message).slice(0, 200)}`))
      }
      ok(stdout)
    })
  })
}

/** 抽时长（秒，浮点）+ 首帧 JPEG 封面 */
async function probeVideo (filePath) {
  await ffBin(FFPROBE, 'ffprobe'); await ffBin(FFMPEG, 'ffmpeg')
  const durOut = await ffRun(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath])
  const duration = parseFloat(String(durOut).trim())
  if (!(duration > 0)) throw new Error('ffprobe 未取得视频时长')
  const cover = await ffRun(FFMPEG, ['-v', 'error', '-i', filePath, '-frames:v', '1', '-q:v', '2', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'], { binary: true })
  if (!Buffer.isBuffer(cover) || !cover.length) throw new Error('ffmpeg 无法从视频提取封面')
  return { duration, cover }
}

/** 通用分片上传（图片/视频共用）：FileBatchControl 建会话 → 逐片 multipart → 收 biz（vid/photoId） */
async function albumSliceUpload ({ checksum, cookie, bkn, uin, filePath, fileSize, controlReq: req, appid, checkType, uploadCmd, formUploadType, formSliceSize }) {
  const fs = await import('node:fs')
  const { session, sliceSize } = await openUploadSession({ checksum, cookie, bkn, req })
  const biz = {}
  let seq = 0
  let offset = 0
  while (offset < fileSize) {
    const chunk = Buffer.alloc(Math.min(sliceSize, fileSize - offset))
    const fd = fs.openSync(filePath, 'r')
    let got
    try { got = fs.readSync(fd, chunk, 0, chunk.length, offset) } finally { fs.closeSync(fd) }
    const data = got === chunk.length ? chunk : chunk.subarray(0, got)
    const end = offset + data.length
    const form = sliceForm({
      uin,
      appid,
      session,
      offset,
      end,
      seq,
      blob: data,
      checkType,
      sliceSize: formSliceSize || data.length,
      uploadType: formUploadType
    })
    const api = sliceApi(uploadCmd, bkn, seq, offset, end, fileSize)
    /* -709「服务器开小差了」是瞬态错误，同一片最多重试 3 次 */
    let j = null
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await postMultipart(api, cookie, form)
      if (!res.ok) throw new Error(`分片 ${seq} 上传 HTTP ${res.status}`)
      j = await res.json().catch(() => null)
      if (j && j.ret === 0) break
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1500))
    }
    if (!j || j.ret !== 0) throw new Error(`分片 ${seq} 上传失败（重试 3 次）：${(j && j.msg) || '无响应体'}`)
    if (j.data && j.data.biz) {
      const b = j.data.biz
      if (b.sVid) biz.vid = b.sVid
      if (b.sPhotoID) biz.photoId = b.sPhotoID
      if (b.sBURL) biz.photoUrl = b.sBURL
      biz._rawLast = JSON.stringify(b).slice(0, 300)
    }
    offset = end
    seq++
  }
  if (!(fileSize > 0 && offset === fileSize)) throw new Error('分片上传不完整')
  return { session, slices: seq, biz }
}

const ALBUM_VIDEO_MAX = 1536 * 1024 * 1024

/**
 * 上传视频到群相册：
 * 1) 校验 ISO BMFF 头（MP4 等）；2) ffmpeg 抽时长 + 首帧 JPEG 封面；
 * 3) 视频分片（appid video_qun，check_type 1 SHA1，cmd FileUploadVideo）→ vid；
 * 4) 封面分片（appid qun，iBatchID=视频时间戳，mapParams 带 vid）→ photoId。
 */
export async function albumUploadVideo ({ group, album_id: albumId, album_name: albumName, video } = {}) {
  const gid = String(group ?? '').trim()
  if (!/^\d{5,12}$/.test(gid)) throw new Error('group 必须是群号')
  if (!String(albumId ?? '').trim()) throw new Error('album_id 必填（先用 albumList 查）')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const { createHash } = await import('node:crypto')

  /* 视频来源：短字符串且文件存在 → 当路径读；否则按 base64 解 */
  let buf
  let name = 'video.mp4'
  const raw = String(video ?? '')
  if (raw.length < 512 && fs.existsSync(raw)) {
    buf = fs.readFileSync(raw)
    name = raw.replace(/\\/g, '/').split('/').pop() || name
  } else {
    const comma = raw.indexOf(',')
    buf = Buffer.from((comma >= 0 && raw.startsWith('data:')) ? raw.slice(comma + 1) : raw, 'base64')
  }
  if (!buf || !buf.length) throw new Error('视频内容为空')
  if (buf.length > ALBUM_VIDEO_MAX) throw new Error(`视频超过上限（${Math.round(ALBUM_VIDEO_MAX / 1048576)}MB）`)

  /* 头校验：像图片的直接拒；不是 ISO BMFF 也拒 */
  const head = buf.subarray(0, 16)
  const tag2 = head.subarray(0, 2).toString('latin1')
  const looksImage = tag2 === '\xff\xd8' || tag2 === '\x89P' || tag2 === 'GI' ||
    tag2 === 'BM' || (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' &&
      head.subarray(8, 12).toString('latin1') === 'WEBP')
  if (looksImage) throw new Error('传的是图片——群相册视频请用 upload_image_to_qun_album 或换视频文件')
  const isBmff = head.length >= 8 && head.subarray(4, 8).toString('latin1') === 'ftyp'
  if (!isBmff) throw new Error('群相册视频上传仅支持 MP4 等 ISO BMFF 视频')

  const tmpVideo = os.tmpdir() + `/fl_album_video_${Date.now()}.mp4`
  fs.writeFileSync(tmpVideo, buf)
  let tmpCover = null
  try {
    const { duration, cover } = await probeVideo(tmpVideo)
    const sha1 = createHash('sha1').update(buf).digest('hex')
    const { jar, bkn, uin } = await qzoneAuth()
    const cookie = albumCookie(jar, uin)
    const ts = nowSec()
    const playTime = Math.round(duration * 1000)

    const videoUp = await albumSliceUpload({
      checksum: sha1,
      cookie,
      bkn,
      uin,
      filePath: tmpVideo,
      fileSize: buf.length,
      appid: 'video_qun',
      checkType: 1,
      uploadCmd: 'FileUploadVideo',
      controlReq: controlReq({
        uin,
        jar,
        appid: 'video_qun',
        checksum: sha1,
        checkType: 1,
        fileLen: buf.length,
        refer: 'qzone',
        bizReq: videoBizReq({ title: name, group: gid, uploadTime: ts, playTime }),
        cmd: 'FileUploadVideo'
      })
    })
    if (!videoUp.biz.vid) throw new Error('视频上传未返回 vid')

    /* 封面单独走一次 FileUpload 挂在 vid 上；biz 全空优先怀疑封面字节被文本解码毁了 */
    const coverName = name.replace(/\.[a-z0-9]+$/i, '') + '.jpg'
    tmpCover = os.tmpdir() + `/fl_album_cover_${Date.now()}.jpg`
    fs.writeFileSync(tmpCover, cover)
    const coverMd5 = createHash('md5').update(cover).digest('hex')
    const coverSize = cover.length
    const coverUp = await albumSliceUpload({
      checksum: coverMd5,
      cookie,
      bkn,
      uin,
      filePath: tmpCover,
      fileSize: coverSize,
      appid: 'qun',
      checkType: 0,
      uploadCmd: 'FileUpload',
      controlReq: controlReq({
        uin,
        jar,
        appid: 'qun',
        checksum: coverMd5,
        checkType: 0,
        fileLen: coverSize,
        refer: 'huodong',
        bizReq: coverBizReq({
          title: coverName,
          albumId: String(albumId),
          albumName: String(albumName ?? ''),
          group: gid,
          batchId: ts,
          uploadTime: nowSec(),
          vid: videoUp.biz.vid
        }),
        cmd: ''
      })
    })
    if (!coverUp.biz.photoId) throw new Error('视频封面上传未返回 photoId（检查封面 JPEG 是否被二进制安全地写出）')

    return {
      group: gid,
      album_id: String(albumId),
      id: videoUp.biz.vid,
      cover_photo_id: coverUp.biz.photoId,
      cover_url: coverUp.biz.photoUrl || '',
      size: buf.length,
      duration,
      slices: videoUp.slices + coverUp.slices
    }
  } finally {
    try { fs.unlinkSync(tmpVideo) } catch {}
    if (tmpCover) { try { fs.unlinkSync(tmpCover) } catch {} }
  }
}

/* ------------------------------------------------------------------ *
 * 凭证 / 调试
 * ------------------------------------------------------------------ */

export async function cookiesDebug () {
  const { jar, bkn, uin } = await qzoneAuth()
  return {
    uin,
    keys: Object.keys(jar),
    p_skey_len: (jar.p_skey || '').length,
    skey_len: (jar.skey || '').length,
    bkn
  }
}

/* 登录凭证组合（get_cookies / get_credentials / 实验台共用）：
 * clientKey（0x102A_1）+ pskey（0x102A_0，取 qzone.qq.com 那条）→ bkn 本地 djb2(5381)。
 * cookies 只拼框架常用键；完整网页 cookie 走 qzoneAuth 那套。 */
export async function credentials () {
  const ck = await kernelJson('get_client_key', {}, 15000)
  const clientKey = String((ck && ck.clientKey) || '')
  const pk = await kernelJson('get_pskey', { domains: ['qzone.qq.com'] }, 15000)
  const items = (pk && (pk.items || pk.list)) || []
  const hit = items.find((x) => x.domain === 'qzone.qq.com') || items[0]
  const pskey = String((hit && hit.pskey) || '')
  if (!pskey) throw new Error('未能取得 p_skey（登录态可能刚失效，稍后再试）')
  let h = 5381
  for (let i = 0; i < pskey.length; i += 1) h += (h << 5) + pskey.charCodeAt(i)
  const bkn = String(h & 2147483647)
  const uin = String(kernel.getSelfId() || await selfUin())
  const cookies = `uin=o${uin}; p_uin=o${uin}; p_skey=${pskey}; clientkey=${clientKey}`
  return { cookies, bkn, psy_key: pskey, client_key: clientKey, uin }
}
