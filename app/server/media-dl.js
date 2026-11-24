import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import * as kernel from './kernel.js'
import { pv, pb, ps, rd, hexToBuf, cat, oidb } from './flash.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MEDIA_DIR = path.join(__dirname, '..', 'data', 'media')

const RKEY = {
  cache: new Map(),          // type -> { value, expiresAt }
  lastAttempt: 0,
  inflight: null,
  lastErr: ''
}
const SKEW = 60             // 提前 60s 视为过期
const COOLDOWN_OK = 30      // 有可用 rkey 时的刷新冷却
const COOLDOWN_EMPTY = 10   // 没有 rkey 时的积极重试
const TIMEOUT_MS = 5000

const T_PRIVATE_IMG = 10
const T_GROUP_IMG = 20
const T_FALLBACK = 2

function findInCache (primary) {
  const now = Math.floor(Date.now() / 1000)
  const tryFind = (t) => {
    const c = RKEY.cache.get(t)
    if (!c || !c.value) return null
    if (c.expiresAt && now + SKEW >= c.expiresAt) return null
    return c.value
  }
  return tryFind(primary) ?? tryFind(T_FALLBACK)
}

function updateCache (buf) {
  const top = rd(buf)
  const f4 = top.f(4)
  if (!f4) throw new Error('rkey 响应没有 f4(downloadRkey)')
  const inner = rd(f4)
  const now = Math.floor(Date.now() / 1000)
  const out = []
  for (const raw of inner.all(1)) {
    const e = rd(raw)
    const value = e.str(1)
    const type = e.num(5)
    const ttl = e.num(2) || 3600
    const createTime = e.num(4) || now
    if (!value || !type) continue
    RKEY.cache.set(type, { value, expiresAt: createTime + ttl })
    out.push({ type, ttl, len: value.length })
  }
  if (!out.length) throw new Error('rkey 响应里一条可用 rkey 都没有')
  return out
}

async function runRefresh () {
  /* 请求体（字段号）：
     1: reqHead{ 1: common{1:requestId=1, 2:command=202}, 2: scene{101:2,102:1,200:0}, 3: client{1:2} }
     4: downloadRkey{ 1: repeated [10,20,2] } */
  try {
    /* flash.js 的 pv/pb 是原地写、不返回值，必须先建数组再逐字段写 */
    const common = []; pv(common, 1, 1); pv(common, 2, 202)
    const scene = []; pv(scene, 101, 2); pv(scene, 102, 1); pv(scene, 200, 0, true)
    const client = []; pv(client, 1, 2)
    const reqHead = []; pb(reqHead, 1, Buffer.from(common)); pb(reqHead, 2, Buffer.from(scene)); pb(reqHead, 3, Buffer.from(client))
    const dlrk = []; pv(dlrk, 1, T_PRIVATE_IMG); pv(dlrk, 1, T_GROUP_IMG); pv(dlrk, 1, T_FALLBACK)
    const body = []; pb(body, 1, Buffer.from(reqHead)); pb(body, 4, Buffer.from(dlrk))
    const buf = await oidb(0x9067, 202, Buffer.from(body), true)
    const out = updateCache(buf)
    RKEY.lastErr = ''
    return out
  } catch (e) {
    RKEY.lastErr = String(e.message || e)
    throw e
  }
}

async function ensureFresh () {
  if (!RKEY.inflight) {
    const now = Math.floor(Date.now() / 1000)
    const hasUsable = findInCache(T_GROUP_IMG) || findInCache(T_PRIVATE_IMG)
    const cooldown = hasUsable ? COOLDOWN_OK : COOLDOWN_EMPTY
    if (now - RKEY.lastAttempt < cooldown) return
    RKEY.lastAttempt = now
    RKEY.inflight = runRefresh()
      .catch(() => {})
      .finally(() => { RKEY.inflight = null })
  }
  await Promise.race([RKEY.inflight, new Promise((r) => setTimeout(r, TIMEOUT_MS))])
}

export async function rkey (force = false) {
  if (force) {
    RKEY.cache.clear()
    RKEY.lastAttempt = 0
  }
  const cached = findInCache(T_GROUP_IMG) || findInCache(T_PRIVATE_IMG)
  if (!cached) await ensureFresh()
  const got = findInCache(T_GROUP_IMG) || findInCache(T_PRIVATE_IMG)
  if (!got) throw new Error('rkey 拉不到（0x9067_202 无可用响应）')
  return got
}

export async function rkeyInfo () {
  const out = { lastErr: RKEY.lastErr || '', ntv2Err: NTV2_LAST || '' }
  for (const [t, c] of RKEY.cache) out['type' + t] = { len: c.value.length, expiresAt: c.expiresAt, left: Math.max(0, c.expiresAt - Math.floor(Date.now() / 1000)) }
  return out
}

const APPID_TYPE = { 1406: T_PRIVATE_IMG, 1407: T_GROUP_IMG }

function stripPrefix (rkey) {
  for (const p of ['&rkey=', '?rkey=']) if (rkey.startsWith(p)) return rkey.slice(p.length)
  return rkey
}

function urlNeedsRkey (url) {
  if (!url || url.includes('rkey=')) return false
  if (url.includes('gchat.qpic.cn')) return false
  return url.includes('/download') || url.includes('.nt.qq.com.cn')
}

function primaryTypeFor (url, kind, isGroup) {
  const m = url && url.match(/[?&]appid=(\d+)/)
  if (m && APPID_TYPE[m[1]]) return APPID_TYPE[m[1]]
  if (kind === 'video') return isGroup ? 22 : 12
  if (kind === 'record') return isGroup ? 24 : 14
  return isGroup ? T_GROUP_IMG : T_PRIVATE_IMG
}

/** 签名一条媒体 URL。kind: image|video|record；isGroup 决定默认 rkey 类型。 */
export async function signUrl (rawUrl, { kind = 'image', isGroup = true } = {}) {
  let url = String(rawUrl || '')
  if (!url) throw new Error('URL 为空')
  if (url.startsWith('/')) url = 'https://multimedia.nt.qq.com.cn' + url
  if (!urlNeedsRkey(url)) return url
  let rkeyVal = findInCache(primaryTypeFor(url, kind, isGroup))
  if (!rkeyVal) {
    await ensureFresh()
    rkeyVal = findInCache(primaryTypeFor(url, kind, isGroup))
  }
  if (!rkeyVal) return url   /* 签不了就给裸链，让调用方拿到 CDN 明确报错 */
  const sep = url.includes('?') ? '&rkey=' : '?rkey='
  return url + sep + encodeURIComponent(stripPrefix(rkeyVal))
}

function extOf (url, fallback) {
  const m = String(url || '').match(/\.(jpe?g|png|gif|webp|bmp|mp4|amr|slk|mp3|sil|wav)(?:[?&]|$)/i)
  return m ? m[1].toLowerCase() : fallback
}

/* 魔数嗅探：URL 没带扩展名时从文件头认类型 */
function sniffExt (buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpg'
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'png'
  if (buf.length > 6 && buf.toString('ascii', 0, 3) === 'GIF') return 'gif'
  if (buf.length > 12 && buf.toString('ascii', 4, 8) === 'ftyp') return 'mp4'
  if (buf.length > 6 && buf.toString('ascii', 0, 6) === '#!AMR') return 'amr'
  if (buf.length > 5 && buf.toString('ascii', 0, 5) === '#!SIL') return 'sil'
  return ''
}

/** 下载到本地。url 已签名或无需签名；name 可选（缺省按内容 md5 命名）。 */
export async function downloadTo (signedUrl, { name, ext } = {}) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true })
  let lastErr = null
  for (let attempt = 0; attempt < 2; attempt++) {
    let res
    try {
      res = await fetch(signedUrl, { signal: AbortSignal.timeout(60000) })
    } catch (e) {
      lastErr = new Error('HTTP 请求失败：' + (e.message || e))
      continue
    }
    /* invalid rkey → 强刷一次重签（自愈逻辑） */
    if (!res.ok && attempt === 0) {
      const text = await res.text().catch(() => '')
      if (/invalid rkey|retcode.*-5503010/i.test(text) || res.status === 403 || res.status === 404) {
        await rkey(true)
        signedUrl = await signUrl(signedUrl.split('&rkey=')[0].split('?rkey=')[0], { kind: ext === 'mp4' ? 'video' : (ext === 'amr' || ext === 'slk' ? 'record' : 'image'), isGroup: true })
        continue
      }
      throw new Error(`CDN HTTP ${res.status}：${text.slice(0, 200)}`)
    }
    if (!res.ok) throw new Error(`CDN HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length) throw new Error('CDN 返回空 body')
    const ext2 = ext || extOf(signedUrl, '') || sniffExt(buf) || 'bin'
    const fname = (name ? String(name).replace(/[\\/:*?"<>|]/g, '_') : createHash('md5').update(buf).digest('hex')) + '.' + ext2
    const fp = path.join(MEDIA_DIR, fname)
    fs.writeFileSync(fp, buf)
    return { path: fp, size: buf.length }
  }
  throw lastErr || new Error('下载失败')
}

/* NTV2 下载四命令（语音 0x126E/0x126D、视频 0x11EA/0x11E9，sub=200）
 * RPC：get-group-ptt-url / get-private-ptt-url / get-group-video-url；
 * 请求 scene 差异（requestType/businessType/sceneType + group/c2c），
 * 响应 f3{1: rKeyParam, 3: info{1: domain, 2: urlPath}} → https://domain+urlPath+rKeyParam */
const NTV2_CMD = { record: { group: 0x126e, private: 0x126d }, video: { group: 0x11ea, private: 0x11e9 } }
let NTV2_LAST = ''

async function ntv2DownloadUrl ({ kind, isGroup, groupUin, selfUid, node }) {
  const cmd = (NTV2_CMD[kind] || NTV2_CMD.record)[isGroup ? 'group' : 'private']
  const reqType = kind === 'video' ? 2 : 1
  const bizType = kind === 'video' ? 2 : 3
  const sceneType = isGroup ? 2 : 1

  const common = []; pv(common, 1, 1); pv(common, 2, 200)
  const scene = []; pv(scene, 101, reqType); pv(scene, 102, bizType); pv(scene, 200, sceneType)
  if (isGroup) { const g = []; pv(g, 1, Number(groupUin) || 0); pb(scene, 202, Buffer.from(g)) }
  else { const c = []; pv(c, 1, 2); ps(c, 2, String(selfUid || '')); pb(scene, 201, Buffer.from(c)) }
  const client = []; pv(client, 1, 2)
  const reqHead = []; pb(reqHead, 1, Buffer.from(common)); pb(reqHead, 2, Buffer.from(scene)); pb(reqHead, 3, Buffer.from(client))

  /* node：info{fileSize/fileHash/fileName/type} + fileUuid + storeId（pttElement.storeID=1） */
  const info = node.info || {}
  const typeBlk = []
  if (info.voiceFormat != null) pv(typeBlk, 4, Number(info.voiceFormat))
  if (info.videoFormat != null) pv(typeBlk, 3, Number(info.videoFormat))
  const infobuf = []
  pv(infobuf, 1, Number(info.fileSize) || 0)
  ps(infobuf, 2, String(info.fileHash || ''))
  ps(infobuf, 4, String(info.fileName || ''))
  pb(infobuf, 5, Buffer.from(typeBlk))
  const nodebuf = []
  pb(nodebuf, 1, Buffer.from(infobuf))
  ps(nodebuf, 2, String(node.fileUuid || ''))
  pv(nodebuf, 3, Number(node.storeId) || 0)
  const dl = []
  pv(dl, 1, 0); pv(dl, 2, 0)
  const dlbuf = []
  pb(dlbuf, 1, Buffer.from(nodebuf))
  pb(dlbuf, 2, Buffer.from(dl))
  const body = []
  pb(body, 1, Buffer.from(reqHead))
  pb(body, 3, Buffer.from(dlbuf))

  const buf = await oidb(cmd, 200, Buffer.from(body), true)
  const top = rd(buf)
  const f3 = top.f(3)
  if (!f3) throw new Error(`NTV2 0x${cmd.toString(16)}_200 响应没有 f3(download)`)
  const d = rd(f3)
  const rkeyParam = d.str(1)
  const infoBlk = d.f(3)
  if (!infoBlk) throw new Error(`NTV2 0x${cmd.toString(16)}_200 响应没有 info`)
  const i = rd(infoBlk)
  const domain = i.str(1)
  const urlPath = i.str(2)
  if (!domain || !urlPath) throw new Error(`NTV2 0x${cmd.toString(16)}_200 响应缺 domain/urlPath`)
  return { url: 'https://' + domain + urlPath + rkeyParam, cmd }
}

/** 从元素元信息构造 NTV2 下载直链（语音/视频专用）。 */
export async function ntv2UrlFor (meta, { kind, isGroup, groupUin, selfUid }) {
  return ntv2DownloadUrl({
    kind, isGroup, groupUin, selfUid,
    node: {
      info: {
        fileSize: meta.size || 0,
        fileHash: meta.md5 || '',
        fileName: meta.name || '',
        voiceFormat: meta.formatType,
        videoFormat: meta.videoFormat
      },
      fileUuid: meta.fileUuid || '',
      storeId: meta.storeID != null ? meta.storeID : 1
    }
  })
}

/** 从元素字段里挖出可下载的 URL/path + 元信息（pic/ptt/video/file 通吃）。
 *  语音/视频元素没有 url 字段，靠 NTV2 四命令现取直链。 */
export function extractMedia (elements, kind) {
  if (typeof elements === 'string') {
    try { elements = JSON.parse(elements) } catch { return null }
  }
  if (!Array.isArray(elements)) return null
  for (const e of elements || []) {
    if (!e) continue
    if (kind === 'image' && e.picElement) {
      const p = e.picElement
      return { url: p.originImageUrl || p.picUrl || '', fileUuid: p.fileUuid || '', sourcePath: p.sourcePath || '', md5: p.md5HexStr || '', name: p.fileName || '', size: Number(p.fileSize) || 0, storeID: 1 }
    }
    if (kind === 'record' && e.pttElement) {
      const p = e.pttElement
      return { url: p.url || '', fileUuid: p.fileUuid || '', sourcePath: p.sourcePath || p.filePath || '', md5: p.md5HexStr || p.fileMd5 || '', name: p.fileName || '', size: Number(p.fileSize) || 0, formatType: p.formatType, storeID: p.storeID }
    }
    if (kind === 'video' && e.videoElement) {
      const p = e.videoElement
      return { url: p.url || p.originImageUrl || '', fileUuid: p.fileUuid || '', sourcePath: p.sourcePath || p.filePath || '', md5: p.md5HexStr || p.fileMd5 || '', name: p.fileName || '', size: Number(p.fileSize) || 0, videoFormat: p.videoFormat, storeID: p.storeID }
    }
    if (kind === 'file' && e.fileElement) {
      const p = e.fileElement
      return { url: p.url || '', fileUuid: p.fileUuid || '', sourcePath: p.sourcePath || p.filePath || '', md5: p.fileMd5 || p.md5HexStr || '', name: p.fileName || '', size: Number(p.fileSize) || 0, fileId: String(p.fileId ?? p.fileUuid ?? '') }
    }
  }
  return null
}

/** get_image / get_record / get_file 主入口。
 *  src: { file, url, msg_id?, group_id?, kind, isGroup? }
 *  file/url 传 originImageUrl 相对路径或完整 URL；msg_id 用于反查元素（语音/视频必需）。 */
export async function getMedia ({ file, url, msg_id, group_id, user_id, kind = 'image', isGroup = true, no_local = false } = {}) {
  let raw = String(url || file || '')
  let meta = { url: raw, sourcePath: '', md5: '', name: '', size: 0 }
  /* file 是 md5/文件名形态时，从 get_msg 里反查元素 */
  if (raw && !/^https?:/.test(raw) && !raw.startsWith('/download')) {
    if (!msg_id) throw new Error('file 参数不是 URL/path 形态（' + raw.slice(0, 60) + '），请改传消息里 image/record 段的 url 字段，或同时传 msg_id')
    const g = await kernel.call('get_msg', { message_id: String(msg_id), group_id, user_id: user_id }, 15000)
    if (!g.ok) throw new Error('get_msg 失败：' + (g.err || g.msg))
    const gm = typeof g.ret === 'string' ? JSON.parse(g.ret) : g.ret
    const els = (gm && (gm.elements || gm.message)) || []
    const m = extractMedia(typeof els === 'string' ? JSON.parse(els) : els, kind)
    if (!m) throw new Error('消息里没有 ' + kind + ' 元素')
    meta = m
    /* 语音/视频：URL 优先级 = 元素自带 url > NTV2 四命令现取直链 > fileUuid 拼 appid（图片同族才有效） */
    if (meta.url) {
      raw = meta.url
    } else if (kind === 'record' || kind === 'video') {
      try {
        const ntv = await ntv2UrlFor(meta, { kind, isGroup, groupUin: group_id, selfUid: '' })
        meta.signedUrl = ntv.url
        raw = ntv.url
        NTV2_LAST = ''
      } catch (e) {
        NTV2_LAST = String(e.message || e)
        if (!meta.fileUuid) throw new Error('NTV2 取直链失败：' + NTV2_LAST)
        raw = '/download?appid=' + (isGroup ? 1407 : 1406) + '&fileid=' + encodeURIComponent(meta.fileUuid)
      }
      meta.ntv2 = true
    } else {
      raw = m.url || (m.fileUuid ? '/download?appid=' + (isGroup ? 1407 : 1406) + '&fileid=' + encodeURIComponent(m.fileUuid) : '') || m.sourcePath
    }
  }
  if (!raw) throw new Error('没有可下载的 URL（元素缺 url 且无 fileUuid 可拼）')

  /* 双路：QQ 本地已落盘的直接拷（零网络开销）；no_local=true 强制走 CDN */
  if (!no_local && meta.sourcePath && fs.existsSync(meta.sourcePath)) {
    fs.mkdirSync(MEDIA_DIR, { recursive: true })
    const fname = (meta.md5 || path.basename(meta.sourcePath, path.extname(meta.sourcePath))) + path.extname(meta.sourcePath) || 'media.bin'
    const fp = path.join(MEDIA_DIR, fname)
    fs.copyFileSync(meta.sourcePath, fp)
    const signed = raw.startsWith('/download') ? await signUrl(raw, { kind, isGroup }) : (urlNeedsRkey(raw) ? await signUrl(raw, { kind, isGroup }) : raw)
    return { file: fp, url: signed, file_size: fs.statSync(fp).size, via: 'local' }
  }

  const signed = await signUrl(raw, { kind, isGroup })
  const ext = kind === 'record' && /\.amr$/i.test(meta.name || '') ? 'amr'
    : (kind === 'video' ? 'mp4' : undefined)
  const d = await downloadTo(signed, { name: meta.md5 || undefined, ext })
  return { file: d.path, url: signed, file_size: d.size, via: 'cdn', md5: meta.md5, file_name: meta.name }
}

/** download_file（OneBot）：下载任意签名 URL 到 data/media。 */
export async function downloadFile ({ url } = {}) {
  if (!url) throw new Error('缺 url')
  const signed = urlNeedsRkey(url) ? await signUrl(url, {}) : url
  const d = await downloadTo(signed, {})
  return { file: d.path, file_size: d.size, url: signed }
}
