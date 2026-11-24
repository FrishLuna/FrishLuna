import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import * as kernel from './kernel.js'
import * as uidmap from './uidmap.js'

const FLASH_SLICE_SIZE = 1024 * 1024
const FLASH_MAX_BYTES = 4 * 1024 * 1024 * 1024
const FLASH_INLINE_MAX = 1024 * 1024 * 1024

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

/** varint 字段。force=true 时 0 也上 wire（proton pb_optional 语义）。 */
function pv (out, f, n, force) {
  if (n == null || (!force && Number(n) === 0)) return
  out.push(...tag(f, 0), ...vi(n))
}
/** bytes/message 字段。空 message（如 sliceupload f1 FlashEmpty）用 force=true 显式上 wire。
 *  逐字节 push，不用 spread —— 大分片 spread 会爆调用栈。 */
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
    str (n) { const v = this.f(n); return v != null ? Buffer.from(v).toString('utf8') : '' }
  }
}

let flashSeq = 200
function nextSeq () { return ++flashSeq }

async function oidb (cmd, sub, bodyBuf, uinForm) {
  const r = await kernel.call('oidb_raw', { cmd, sub, body_hex: bodyBuf.toString('hex'), uin_form: !!uinForm }, 20000)
  if (!r.ok) throw new Error(`OIDB 0x${cmd.toString(16)}_${sub} 通道失败：${r.err || r.msg}`)
  const d = typeof r.ret === 'string' ? JSON.parse(r.ret) : r.ret
  if (d.errCode) throw new Error(`OIDB 0x${cmd.toString(16)}_${sub} 服务端拒（${d.errCode}）：${d.errMsg || ''}`)
  return hexToBuf(d.bodyHex)
}

/* ------------------------------------------------------------------ *
 * SHA1：闪传要的是「处理完前 N 片」的中间 state，Node 自带 crypto 只给整包
 * digest，所以这里手写一份，transform 完把 state 原样端出去。
 * ------------------------------------------------------------------ */

const SHA1_INIT = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]

/* 四段轮函数与对应常量（i<20 / <40 / <60 / 其余） */
const SHA1_ROUNDS = [
  { fn: (x, y, z) => (x & y) | (~x & z), k: 0x5a827999 },
  { fn: (x, y, z) => x ^ y ^ z, k: 0x6ed9eba1 },
  { fn: (x, y, z) => (x & y) | (x & z) | (y & z), k: 0x8f1bbcdc },
  { fn: (x, y, z) => x ^ y ^ z, k: 0xca62c1d6 }
]

function rotl32 (value, shift) {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0
}

class Sha1Stream {
  constructor () { this.reset() }

  reset () {
    this.state = SHA1_INIT.slice()
    this.bits = [0, 0]
    this.block = Buffer.alloc(64)
  }

  /* 单块：w[0..15] 直接大端读，16..79 用前四个滚动异或出来 */
  transform (buf, offset) {
    const w = new Array(80)
    for (let i = 0; i < 16; i += 1) w[i] = buf.readUInt32BE(offset + (i << 2))
    for (let i = 16; i < 80; i += 1) {
      const mix = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]
      w[i] = rotl32(mix, 1)
    }

    let h0 = this.state[0]
    let h1 = this.state[1]
    let h2 = this.state[2]
    let h3 = this.state[3]
    let h4 = this.state[4]

    for (let i = 0; i < 80; i += 1) {
      const round = SHA1_ROUNDS[i < 20 ? 0 : i < 40 ? 1 : i < 60 ? 2 : 3]
      const t = (round.fn(h1, h2, h3) + round.k + rotl32(h0, 5) + h4 + w[i]) >>> 0
      h4 = h3
      h3 = h2
      h2 = rotl32(h1, 30)
      h1 = h0
      h0 = t
    }

    const s = this.state
    s[0] = (s[0] + h0) >>> 0
    s[1] = (s[1] + h1) >>> 0
    s[2] = (s[2] + h2) >>> 0
    s[3] = (s[3] + h3) >>> 0
    s[4] = (s[4] + h4) >>> 0
  }

  update (chunk) {
    const len = chunk.length
    let at = (this.bits[0] >>> 3) & 0x3f
    const prev = this.bits[0]
    const grown = (prev + len * 8) >>> 0
    const carried = grown < prev ? 1 : 0
    const whole = len >>> 29
    this.bits[1] = (this.bits[1] + carried + whole) >>> 0
    this.bits[0] = grown

    const room = 64 - at
    if (len < room) {
      chunk.copy(this.block, at)
      return
    }
    chunk.copy(this.block, at, 0, room)
    this.transform(this.block, 0)
    let pos = room
    while (pos + 64 <= len) {
      this.transform(chunk, pos)
      pos += 64
    }
    if (pos < len) chunk.copy(this.block, 0, pos)
  }

  /** 当前 state（20 字节）。小端输出、不 finalize。 */
  hash (littleEndian) {
    const out = Buffer.alloc(20)
    for (let i = 0; i < 5; i += 1) {
      if (littleEndian) out.writeUInt32LE(this.state[i], i * 4)
      else out.writeUInt32BE(this.state[i], i * 4)
    }
    return out
  }
}

/** 逐片累积 SHA1 的中间 state（小端，不 finalize）；最后一片直接给整文件 digest。 */
function sliceStateDigests (bytes, sliceCount, sliceSize) {
  const stream = new Sha1Stream()
  const out = []
  let cursor = 0
  for (let idx = 0; idx < sliceCount; idx += 1) {
    const stop = Math.min(cursor + sliceSize, bytes.length)
    stream.update(bytes.subarray(cursor, stop))
    cursor = stop
    out.push(idx === sliceCount - 1
      ? createHash('sha1').update(bytes).digest()
      : stream.hash(true))
  }
  return out
}

function makeCrcTable () {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let bit = 0; bit < 8; bit += 1) {
      /* 无分支写法：最低位为 1 时异或多项式（-1 是全 1 掩码） */
      c = ((c >>> 1) ^ (0xedb88320 & -(c & 1))) >>> 0
    }
    table[i] = c
  }
  return table
}

const CRC_TABLE = makeCrcTable()

function crc32 (bytes) {
  let acc = 0xffffffff
  for (const byte of bytes) acc = (acc >>> 8) ^ CRC_TABLE[(acc ^ byte) & 0xff]
  return (~acc) >>> 0
}

function pngChunk (type, payload) {
  const size = Buffer.alloc(4)
  size.writeUInt32BE(payload.length)
  const name = Buffer.from(type, 'ascii')
  const check = Buffer.alloc(4)
  check.writeUInt32BE(crc32(Buffer.concat([name, payload])))
  return Buffer.concat([size, name, payload, check])
}

/** 随机纯色 PNG（8bit RGB）。颜色每次随机，SHA1 不同才不会被秒传。 */
function generatePng (width, height) {
  const rgb = []
  for (let chan = 0; chan < 3; chan += 1) rgb.push(Math.floor(Math.random() * 256))
  const stride = width * 3 + 1
  const raw = Buffer.alloc(stride * height)
  for (let row = 0; row < height; row += 1) {
    const base = row * stride
    raw[base] = 0 /* 行过滤 none */
    for (let col = 0; col < width; col += 1) {
      const px = base + 1 + col * 3
      raw[px] = rgb[0]
      raw[px + 1] = rgb[1]
      raw[px + 2] = rgb[2]
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

const IMG_EXT = new Set('jpg jpeg png gif bmp webp heic avif tiff tif ico dib heif'.split(' '))
const AUD_EXT = new Set('mp3 wav aac flac'.split(' '))
const VID_EXT = new Set('mp4 avi mkv mov 3gp mpeg rmvb rm wmv flv asf webm mpg vob m4v f4v'.split(' '))
const ARC_EXT = new Set('zip rar tar bz2 xz tgz gz 7z'.split(' '))

/* 非图片/音视频/压缩包的扩展名 → formatCode（服务端认这张表） */
const FORMAT_CODES = new Map([
  ['doc', 3], ['docx', 3], ['apk', 5],
  ['xls', 6], ['xlsx', 6], ['ppt', 7], ['pptx', 7],
  ['html', 8], ['htm', 8], ['pdf', 9], ['txt', 10], ['psd', 12],
  ['pt', 15], ['pth', 15], ['onnx', 15], ['model', 15], ['mlmodel', 15],
  ['ttf', 16], ['otf', 16], ['ipa', 17], ['key', 18], ['note', 19],
  ['numbers', 20], ['pages', 21], ['sketch', 22], ['dmg', 23], ['pkg', 24], ['exe', 27]
])
function flashApplyTypeCode (ext) {
  if (ext === 'zip') return 6
  if (ARC_EXT.has(ext)) return 2
  return 7
}
function flashFormatCode (ext) {
  if (IMG_EXT.has(ext)) return 26
  if (AUD_EXT.has(ext)) return 1
  if (VID_EXT.has(ext)) return 2
  if (ARC_EXT.has(ext)) return 4
  const fixed = FORMAT_CODES.get(ext)
  return fixed === undefined ? 11 : fixed
}

function fileTypeCode (fileName) {
  const lower = fileName.toLowerCase()
  const dot = lower.lastIndexOf('.')
  const ext = dot < 0 ? '' : lower.slice(dot + 1)
  const codes = {}
  codes.typeCode = flashApplyTypeCode(ext)
  codes.formatCode = flashFormatCode(ext)
  return codes
}

/** sub=103 用的 fileId（客户端侧 protobuf，最后走 base64url）：
 *  f2 SHA1 / f3 大小 / f4 appid / f5 微秒时间戳 / f6 'prod' / f10 TTL 1209600 /
 *  f11 16B 会话号 / f15 3B / f16 'gz'。appid 决定 fileId 落到服务端的哪个槽位：
 *  主文件 14901（0x93d4 f14.f1），png 缩略图 14903，jpg 缩略图 14902（f13.f1）。
 *  f11/f15 纯随机，服务端不校验。 */
function fileIdProto (sha1Buf, fileSize, appid) {
  const app = appid ?? 14901
  const slots = [
    [2, sha1Buf],
    [3, fileSize],
    [4, app],
    [5, Date.now() * 1000],
    [10, 1209600],
    [11, randomBytes(16)],
    [15, randomBytes(3)]
  ]
  const out = []
  for (const [field, value] of slots) {
    if (Buffer.isBuffer(value)) pb(out, field, value)
    else pv(out, field, value, true)
  }
  ps(out, 6, 'prod')
  ps(out, 16, 'gz')
  return Buffer.from(out)
}

function headBlock (sub, f103) {
  const head = []
  const s = []
  pv(s, 1, nextSeq(), true)
  pv(s, 2, sub, true)
  pb(head, 1, Buffer.from(s))
  const cfg = []
  pv(cfg, 101, 2, true)
  pv(cfg, 102, 4, true)
  pv(cfg, 103, f103, true)
  pv(cfg, 200, 5, true)
  pb(head, 2, Buffer.from(cfg))
  const f3 = []
  pv(f3, 1, 1, true)
  pb(head, 3, Buffer.from(f3))
  return Buffer.from(head)
}

function bodyApplyFileset ({ fileName, fileSize, typeCode, uploader }) {
  const fi = []
  ps(fi, 2, fileName)
  ps(fi, 3, fileName)
  pv(fi, 4, 1, true)
  pv(fi, 5, fileSize, true)
  const up = []
  ps(up, 1, uploader.uin)
  ps(up, 2, uploader.nickname)
  ps(up, 3, uploader.uid)
  pb(up, 4, Buffer.alloc(0), true)
  pb(fi, 10, Buffer.from(up))
  pv(fi, 16, 1, true)
  pv(fi, 20, 0, true)
  pv(fi, 21, 0, true)
  const out = []
  pv(out, 1, 1, true)
  pb(out, 2, Buffer.from(fi))
  pv(out, 3, typeCode, true)
  pv(out, 12, 1, true)
  return Buffer.from(out)
}

function bodyCommitFile ({ filesetUuid, entries }) {
  const out = []
  pv(out, 1, 1, true)
  ps(out, 2, filesetUuid)
  ps(out, 3, filesetUuid)
  for (const e of entries) {
    const c = []
    ps(c, 1, filesetUuid)
    ps(c, 2, e.fileUuid)
    pv(c, 3, 0, true)
    pb(c, 4, Buffer.alloc(0), true)
    pv(c, 5, 1, true)
    pv(c, 6, e.fileIndex, true)
    pv(c, 7, e.formatCode, true)
    ps(c, 8, e.fileName)
    ps(c, 9, e.origName)
    pv(c, 10, 0, true)
    pv(c, 11, e.fileSize, true)
    pv(c, 12, 0, true)
    pb(c, 24, Buffer.alloc(0), true)
    pb(out, 4, Buffer.from(c))
  }
  pv(out, 5, 1, true)
  pv(out, 6, 1, true)
  return Buffer.from(out)
}

function filesetWrap ({ filesetUuid, fileUuid, fileIndex, f5, f6, f7 }) {
  const w = []
  ps(w, 1, filesetUuid)
  ps(w, 2, filesetUuid)
  ps(w, 3, fileUuid)
  pv(w, 4, fileIndex, true)
  pv(w, 5, f5, true)
  pv(w, 6, f6, true)
  pv(w, 7, f7, true)
  pb(w, 8, Buffer.alloc(0), true)
  pv(w, 9, 1, true)
  pv(w, 10, 0, true)
  pv(w, 11, 0, true)
  pv(w, 12, 0, true)
  pv(w, 13, 0, true)
  pv(w, 14, 0, true)
  return Buffer.from(w)
}

function fileInfoBlock ({ fileName, fileSize, md5Hex, sha1Hex, f5f1, width, height, f9 }) {
  const fi = []
  pv(fi, 1, fileSize, true)
  ps(fi, 2, md5Hex, true)
  ps(fi, 3, sha1Hex)
  ps(fi, 4, fileName)
  const f5 = []
  pv(f5, 1, f5f1, true)
  pv(f5, 2, 0, true)
  pv(f5, 3, 0, true)
  pv(f5, 4, 0, true)
  pb(fi, 5, Buffer.from(f5))
  pv(fi, 6, width ?? 0, true)
  pv(fi, 7, height ?? 0, true)
  pv(fi, 8, 0, true)
  pv(fi, 9, f9, true)
  return Buffer.from(fi)
}

/** sub=100 prepare：payload @ f2（filesetWrap @ f9） */
function bodyPrepareUpload ({ filesetUuid, fileUuid, fileName, fileSize, sha1Hex, fileIndex, formatCode, thumbType, width, height }) {
  const isThumb = thumbType !== undefined
  const isJpg = thumbType === 'jpg'
  const wrap = []
  pb(wrap, 1, fileInfoBlock({ fileName, fileSize, md5Hex: '', sha1Hex, f5f1: isJpg ? 1 : 0, width, height, f9: isJpg ? 0 : 1 }))
  pv(wrap, 2, 0, true)
  const payload = []
  pb(payload, 1, Buffer.from(wrap))
  pv(payload, 2, 1, true)
  pv(payload, 3, 0, true)
  pv(payload, 4, 0, true)
  pv(payload, 5, 0, true)
  const f6 = []
  const f61 = []
  pv(f61, 1, 0, true)
  pb(f61, 2, Buffer.alloc(0), true)
  pb(f6, 1, Buffer.from(f61))
  const f62 = []
  pb(f62, 3, Buffer.alloc(0), true)
  pb(f6, 2, Buffer.from(f62))
  const f63 = []
  pb(f63, 11, Buffer.alloc(0), true)
  pb(f63, 12, Buffer.alloc(0), true)
  pb(f6, 3, Buffer.from(f63))
  pv(f6, 10, 0, true)
  pb(payload, 6, Buffer.from(f6))
  pv(payload, 7, 0, true)
  pv(payload, 8, 0, true)
  pb(payload, 9, filesetWrap({ filesetUuid, fileUuid, fileIndex, f5: 0, f6: isThumb ? 1 : 0, f7: isThumb ? (isJpg ? 2 : 26) : formatCode }))
  const out = []
  pb(out, 1, headBlock(100, isThumb ? (isJpg ? 24 : 23) : 22))
  pb(out, 2, Buffer.from(payload))
  return Buffer.from(out)
}

/** sub=103 apply-upload：payload @ f12（filesetWrap @ f10），带 fileId */
function bodyApplyUpload ({ filesetUuid, fileUuid, fileName, fileSize, md5Hex, sha1Hex, fileIndex, formatCode, fileIdB64, thumbType, width, height }) {
  const isThumb = thumbType !== undefined
  const isJpg = thumbType === 'jpg'
  const wrap = []
  pb(wrap, 1, fileInfoBlock({ fileName, fileSize, md5Hex, sha1Hex, f5f1: isJpg ? 1 : 0, width, height, f9: isJpg ? 0 : 1 }))
  ps(wrap, 2, fileIdB64)
  pv(wrap, 3, 1, true)
  pv(wrap, 4, Math.floor(Date.now() / 1000), true)
  pv(wrap, 5, 1209600, true)
  pv(wrap, 6, 0, true)
  const payload = []
  pb(payload, 1, Buffer.from(wrap))
  const flag2 = []
  pv(flag2, 1, 2, true)
  pb(payload, 2, Buffer.from(flag2))
  const f3 = []
  pv(f3, 1, 0, true)
  pv(f3, 2, 0, true)
  pv(f3, 3, 0, true)
  pb(f3, 4, Buffer.alloc(0), true)
  pb(payload, 3, Buffer.from(f3))
  pb(payload, 10, filesetWrap({ filesetUuid, fileUuid, fileIndex, f5: isThumb && !isJpg ? 1 : 0, f6: isThumb ? (isJpg ? 1 : 0) : 0, f7: isThumb ? (isJpg ? 2 : 26) : formatCode }))
  const out = []
  pb(out, 1, headBlock(103, isThumb ? (isJpg ? 24 : 23) : 22))
  pb(out, 12, Buffer.from(payload))
  return Buffer.from(out)
}

/** 0x93d4 拉下载元信息 */
function bodyGetDownloadUrl ({ filesetUuid }) {
  const inner = []
  ps(inner, 1, '')
  pv(inner, 2, 1, true)
  pv(inner, 3, 18, true)
  ps(inner, 4, '')
  const i5 = []
  pv(i5, 1, 0, true)
  pb(inner, 5, Buffer.from(i5))
  const i6 = []
  pv(i6, 1, 0, true)
  pv(i6, 2, 0, true)
  pb(inner, 6, Buffer.from(i6))
  const out = []
  ps(out, 1, filesetUuid)
  pb(out, 2, Buffer.from(inner))
  pv(out, 3, 7, true)
  pv(out, 4, 1, true)
  return Buffer.from(out)
}

/** 0x12a9 sub=200 主文件下载直链 */
function bodyGetFlashDownload ({ filesetUuid, fileUuid, fileId, fileName }) {
  const fi = []
  pv(fi, 1, 0, true)
  ps(fi, 4, fileName)
  const f5 = []
  pv(f5, 1, 0, true); pv(f5, 2, 0, true); pv(f5, 3, 0, true); pv(f5, 4, 0, true)
  pb(fi, 5, Buffer.from(f5))
  pv(fi, 6, 0, true); pv(fi, 7, 0, true); pv(fi, 8, 0, true); pv(fi, 9, 0, true)
  const wrap = []
  pb(wrap, 1, Buffer.from(fi))
  ps(wrap, 2, fileId)
  pv(wrap, 3, 0, true); pv(wrap, 4, 0, true); pv(wrap, 5, 0, true); pv(wrap, 6, 0, true)
  const p2 = []
  const param = []
  pv(param, 1, 4294967294, true)
  pv(param, 3, 4294967295, true)
  pv(param, 5, 111, true)
  const p6 = []
  pv(p6, 1, 3403722988, true)
  pb(param, 6, Buffer.from(p6))
  pb(p2, 2, Buffer.from(param))
  const f4 = []
  pv(f4, 1, 0, true)
  pb(p2, 4, Buffer.from(f4))
  const fw = []
  ps(fw, 1, filesetUuid)
  ps(fw, 2, fileUuid)
  pv(fw, 3, 26, true) /* 必须是 26，用 2 报 170019002 */
  ps(fw, 4, fileUuid)
  pb(p2, 10, Buffer.from(fw))
  const payload = []
  pb(payload, 1, Buffer.from(wrap))
  pb(payload, 2, Buffer.from(p2))
  pv(payload, 3, 0, true)
  const out = []
  pb(out, 1, headBlock(200, 22))
  pb(out, 3, Buffer.from(payload))
  return Buffer.from(out)
}

/** 0x93d7 发送 */
function bodySendFlash ({ groupId, targetUid, filesetUuid }) {
  const t = []
  if (groupId) {
    pv(t, 1, 2, true)
    const g = []
    pv(g, 1, groupId, true)
    pb(t, 3, Buffer.from(g))
  } else {
    pv(t, 1, 1, true)
    const u = []
    ps(u, 1, targetUid)
    pb(t, 2, Buffer.from(u))
  }
  const out = []
  pb(out, 1, Buffer.from(t))
  ps(out, 2, filesetUuid)
  return Buffer.from(out)
}

async function selfIdentity () {
  const uin = String(kernel.getSelfId() || '')
  if (!uin) throw new Error('本号 uin 还没探到')
  let uid = ''
  try { uid = uidmap.resolve(uin) || '' } catch {}
  if (!uid) throw new Error('本号 uid 未知（发条消息让 payload 认主后再试）')
  let nick = ''
  try {
    const r = await kernel.call('get_login_info', {}, 8000)
    if (r.ok) { const d = typeof r.ret === 'string' ? JSON.parse(r.ret) : r.ret; nick = d.nick || d.nickname || '' }
  } catch {}
  return { uin, nickname: nick || uin, uid }
}

async function loadSourceFile (src) {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const raw = String(src ?? '')
  let bytes
  let fileName = 'file.bin'
  if (raw.length < 512 && fs.existsSync(raw)) {
    bytes = fs.readFileSync(raw)
    fileName = raw.replace(/\\/g, '/').split('/').pop() || fileName
  } else {
    const i = raw.indexOf(',')
    bytes = Buffer.from((i >= 0 && raw.startsWith('data:')) ? raw.slice(i + 1) : raw, 'base64')
  }
  if (!bytes || !bytes.length) throw new Error('文件内容为空')
  if (bytes.length > FLASH_INLINE_MAX) throw new Error(`内联文件超过 1GiB 上限`)
  const tmpPath = os.tmpdir() + `/fl_flash_${Date.now()}_${Math.random().toString(36).slice(2)}`
  fs.writeFileSync(tmpPath, bytes)
  return { tmpPath, bytes, fileName }
}

const SLICE_UPLOAD_URL = 'https://multimedia.qfile.qq.com/sliceupload'

/** 读回包正文，读不动就当空串（只用于拼错误信息） */
const safeText = (resp) => resp.text().catch(() => '')

/* sliceupload 的固定请求头（抓包口径，值不能改） */
const SLICE_HEADERS = {
  Connection: 'Keep-Alive',
  Accept: '*/*',
  Pragma: 'no-cache',
  'Cache-Control': 'no-cache',
  'X-Retried-Times': '1',
  'User-Agent': 'Mozilla/5.0 (compatible; MSIE 10.0; Windows NT 6.2)'
}

async function sliceuploadFile ({ bytes, rkey, sha1StateV, sliceCount, appid }) {
  for (let i = 0; i < sliceCount; i += 1) {
    const from = i * FLASH_SLICE_SIZE
    const take = Math.min(FLASH_SLICE_SIZE, bytes.length - from)
    const chunk = bytes.subarray(from, from + take)
    const inner = []
    pb(inner, 1, Buffer.alloc(0), true)
    ps(inner, 2, rkey)
    pv(inner, 3, from, true)
    pv(inner, 4, from + take - 1, true)
    pb(inner, 5, createHash('sha1').update(chunk).digest())
    const stv = []
    for (const state of sha1StateV) pb(stv, 1, state)
    pb(inner, 6, Buffer.from(stv))
    pb(inner, 7, chunk)
    const body = []
    pv(body, 1, 0, true)
    pv(body, 2, appid ?? 14901, true)
    pv(body, 3, 2, true)
    pb(body, 107, Buffer.from(inner))
    const wire = Buffer.from(body)
    const resp = await fetch(SLICE_UPLOAD_URL, {
      method: 'POST',
      body: wire,
      headers: SLICE_HEADERS
    })
    if (!resp.ok) {
      const detail = await safeText(resp)
      throw new Error(`sliceupload 第 ${i} 片被拒：HTTP ${resp.status}｜回包=${detail.slice(0, 300)}｜上行长度=${wire.length}｜rkey=${String(rkey).slice(0, 32)}｜首 40 字节=${wire.subarray(0, 40).toString('hex')}`)
    }
    const view = rd(Buffer.from(await resp.arrayBuffer()))
    const state = view.str(5)
    if (state !== 'success') throw new Error(`sliceupload 第 ${i} 片失败：${state || '响应无 status'}`)
  }
}

async function prepareAndApply ({ filesetUuid, fileUuid, fileName, fileSize, md5Hex, sha1Hex, fileIndex, formatCode, thumbType, width, height }) {
  try {
    const rkey = await oidb(0x12a9, 100, bodyPrepareUpload({ filesetUuid, fileUuid, fileName, fileSize, sha1Hex, fileIndex, formatCode, thumbType, width, height }), true)
    let rkeyStr = ''
    if (rkey.length) {
      const d = rd(rkey)
      const w = d.f(2)
      if (w) rkeyStr = rd(w).str(1)
    }
    const fileIdB64 = fileIdProto(hexToBuf(sha1Hex), fileSize, 14901).toString('base64url')
    await oidb(0x12a9, 103, bodyApplyUpload({ filesetUuid, fileUuid, fileName, fileSize, md5Hex, sha1Hex, fileIndex, formatCode, fileIdB64 }), true)
    return rkeyStr
  } catch (e) {
    throw e
  }
}

async function uploadThumbnail ({ filesetUuid, mainFileUuid, thumbType, fileIndex }) {
  const isPng = thumbType === 'png'
  const width = 526 /* QQ 客户端缩略图尺寸，1x1 会被服务端 400 */
  const height = 360
  const thumbBytes = generatePng(width, height)
  const appid = isPng ? 14903 : 14902
  const fileUuid = isPng ? randomUUID() : mainFileUuid
  const md5Hex = createHash('md5').update(thumbBytes).digest('hex')
  const sha1Hex = createHash('sha1').update(thumbBytes).digest('hex')
  const fileName = isPng ? randomUUID().slice(0, 8) + '_one.png' : md5Hex.slice(0, 32) + '.jpg'
  const formatCode = isPng ? 26 : 2
  const rkeyStr = await prepareAndApply({ filesetUuid, fileUuid, fileName, fileSize: thumbBytes.length, md5Hex, sha1Hex, fileIndex, formatCode, thumbType, width, height })
  if (!rkeyStr) return
  const sha1StateV = sliceStateDigests(thumbBytes, 1, thumbBytes.length)
  await sliceuploadFile({ bytes: thumbBytes, rkey: rkeyStr, sha1StateV, sliceCount: 1, appid })
}

/** 路径分隔符统一压成下划线，两端空白去掉 */
const flattenName = (name) => String(name ?? '').replace(/[/\\]/g, '_').trim()

/** 创建闪传任务（单文件为主，files 也兼容数组）。返回 { filesetId, shareUrl? } */
export async function createFlashTask ({ files, name } = {}) {
  const list = (Array.isArray(files) ? files : [files]).map((f) => (typeof f === 'string' ? { file: f } : f)).filter((f) => f && f.file)
  if (!list.length) throw new Error('files 必填（本地路径或 base64）')
  const uploader = await selfIdentity()
  const items = []
  for (const [idx, entry] of list.entries()) {
    const staged = await loadSourceFile(entry.file)
    const wanted = flattenName(entry.name)
    const fileName = wanted || staged.fileName
    const codes = fileTypeCode(fileName)
    items.push({
      tmpPath: staged.tmpPath,
      bytes: staged.bytes,
      fileName,
      fileUuid: randomUUID(),
      fileIndex: idx + 1,
      formatCode: codes.formatCode,
      typeCode: codes.typeCode
    })
    /* 空文件先入列再抛，保证 finally 里能把临时文件清掉 */
    if (staged.bytes.length === 0) throw new Error('create_flash_task: 文件为空')
  }
  try {
    const first = items[0]
    const isMulti = items.length > 1
    let filesetName = String(name ?? '').trim()
    if (!filesetName) filesetName = isMulti ? `${first.fileName}等${items.length}个文件` : first.fileName
    let totalSize = 0
    for (const item of items) totalSize += item.bytes.length
    const applyReq = { fileName: filesetName, fileSize: totalSize, typeCode: first.typeCode, uploader }
    const applyResp = await oidb(0x93cf, 1, bodyApplyFileset(applyReq))
    const ad = rd(applyResp)
    const filesetUuid = ad.str(1)
    if (!filesetUuid) throw new Error('apply fileset 失败：响应没有 filesetUuid')
    await oidb(0x93d0, 1, bodyCommitFile({ filesetUuid, entries: items.map(commitEntry) }))
    await oidb(0x93db, 1, cat(ps2buf(1, filesetUuid), ps2buf(2, '')))
    const prepared = []
    for (const item of items) {
      const params = {
        filesetUuid,
        fileUuid: item.fileUuid,
        fileName: item.fileName,
        fileSize: item.bytes.length,
        md5Hex: createHash('md5').update(item.bytes).digest('hex'),
        sha1Hex: createHash('sha1').update(item.bytes).digest('hex'),
        fileIndex: item.fileIndex,
        formatCode: item.formatCode
      }
      prepared.push({ item, bytes: item.bytes, rkeyStr: await prepareAndApply(params) })
    }
    for (const job of prepared) {
      if (!job.rkeyStr) continue /* 秒传：prepare 没给 rkey，跳过 sliceupload */
      const count = Math.ceil(job.bytes.length / FLASH_SLICE_SIZE)
      const sha1StateV = sliceStateDigests(job.bytes, count, FLASH_SLICE_SIZE)
      await sliceuploadFile({ bytes: job.bytes, rkey: job.rkeyStr, sha1StateV, sliceCount: count })
    }
    await uploadThumbnail({ filesetUuid, mainFileUuid: items[0].fileUuid, thumbType: 'png', fileIndex: items.length + 1 })
    await uploadThumbnail({ filesetUuid, mainFileUuid: items[0].fileUuid, thumbType: 'jpg', fileIndex: items.length + 2 })
    const st = []
    ps(st, 1, filesetUuid)
    pv(st, 2, 6, true)
    await oidb(0x93d1, 1, Buffer.from(st))
    return { filesetId: filesetUuid, count: items.length, size: totalSize }
  } finally {
    const fs = await import('node:fs')
    for (const it of items) { try { fs.unlinkSync(it.tmpPath) } catch {} }
  }
}

/** 0x93d0 的每条 entry：把内存里的文件项压成 wire 结构 */
function commitEntry (item) {
  return {
    fileUuid: item.fileUuid,
    fileName: item.fileName,
    origName: item.fileName,
    fileSize: item.bytes.length,
    formatCode: item.formatCode,
    fileIndex: item.fileIndex
  }
}

function ps2buf (f, s) {
  const out = []
  ps(out, f, s)
  return Buffer.from(out)
}

/** fileset 详情（0x93d3）：文件名/大小/分享链接/下载链接 */
export async function getFilesetInfo ({ fileset_uuid: uuid } = {}) {
  if (!uuid) throw new Error('fileset_uuid 必填')
  const out = []
  ps(out, 1, uuid)
  pv(out, 2, 7, true)
  const resp = await oidb(0x93d3, 1, Buffer.from(out))
  const d = rd(resp)
  const entries = []
  for (const e of d.all(1)) {
    const ed = rd(e)
    const w8 = ed.f(8)
    const w9 = ed.f(9)
    entries.push({
      fileset_uuid: ed.str(1),
      file_name: ed.str(2),
      orig_name: ed.str(3),
      file_size: ed.num(5),
      share_url: w8 ? rd(w8).str(1) : '',
      file_id: w9 ? rd(w9).str(1) : '',
      download_url: w9 ? (() => { const x = rd(w9).f(2); return x ? rd(x).str(2) : '' })() : ''
    })
  }
  return { fileset_uuid: uuid, files: entries }
}

export const getFlashFileList = getFilesetInfo

/** 列出本号全部 fileset（0x93d2） */
export async function listFilesets () {
  const out = []
  pv(out, 1, 3, true)
  ps(out, 2, '')
  pv(out, 3, 10, true)
  const resp = await oidb(0x93d2, 1, Buffer.from(out))
  const d = rd(resp)
  const entries = []
  for (const e of d.all(1)) {
    const ed = rd(e)
    const w8 = ed.f(8)
    entries.push({
      fileset_uuid: ed.str(1),
      file_name: ed.str(2),
      file_size: ed.num(5),
      share_url: w8 ? rd(w8).str(1) : ''
    })
  }
  return { count: entries.length, filesets: entries }
}

/** 主文件下载直链（0x93d4 → 0x12a9 sub=200），fileId 未就绪时按 1s/2s/4s/4s 重试 */
export async function getFlashFileUrl ({ fileset_uuid: uuid, file_index: fileIndex } = {}) {
  if (!uuid) throw new Error('fileset_uuid 必填')
  const delays = [0, 1000, 2000, 4000, 4000]
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt]) await new Promise((r) => setTimeout(r, delays[attempt]))
    const resp = await oidb(0x93d4, 1, bodyGetDownloadUrl({ filesetUuid: uuid }))
    const d = rd(resp)
    const entry = d.f(1)
    if (!entry) continue
    const ed = rd(entry)
    let meta = null
    for (const info of ed.all(3)) {
      const id = rd(info)
      const idx = id.num(6) || 1
      if (Number(fileIndex) && idx !== Number(fileIndex)) continue
      const main = id.f(14)
      meta = {
        fileUuid: id.str(2),
        fileName: id.str(8) || id.str(9),
        fileId: main ? rd(main).str(1) : ''
      }
      break
    }
    if (!meta || !meta.fileId) continue
    const dlReq = { filesetUuid: uuid, fileUuid: meta.fileUuid, fileId: meta.fileId, fileName: meta.fileName }
    const dl = await oidb(0x12a9, 200, bodyGetFlashDownload(dlReq), true)
    const dd = rd(dl)
    const raw = dd.f(3)
    if (!raw || !raw.length) continue
    const text = Buffer.from(raw).toString('latin1')
    const host = /multimedia\.qfile\.qq\.com/.exec(text)
    const path = /\/download\?appid=14901[\x20-\x7e]*/.exec(text)
    const rkey = /rkey=([A-Za-z0-9_-]+)/.exec(text)
    if (!host || !path) continue
    const base = `https://${host[0]}${path[0]}`
    return { url: rkey ? `${base}&${rkey[0]}` : base, file_name: meta.fileName, file_id: meta.fileId }
  }
  throw new Error('拿不到主文件下载直链（0x93d4 无 fileId 或 0x12a9 无响应）')
}

/** 发送闪传文件（0x93d7）。群聊 group_id / 私聊 user_id 二选一。 */
export async function sendFlashMsg ({ fileset_uuid: uuid, group_id: groupId, user_id: userId } = {}) {
  if (!uuid) throw new Error('fileset_uuid 必填')
  if (!groupId && !userId) throw new Error('group_id / user_id 至少填一个')
  const body = bodySendFlash({ groupId: groupId ? Number(groupId) : undefined, targetUid: userId ? (uidmap.resolve(userId) || userId) : undefined, filesetUuid: uuid })
  await oidb(0x93d7, 1, body)
  return { fileset_uuid: uuid, sent: true, message_id: 0 }
}

/** 删除闪传文件（0x9407） */
export async function deleteFlashFile ({ fileset_uuid: uuid } = {}) {
  if (!uuid) throw new Error('fileset_uuid 必填')
  const out = []
  ps(out, 1, uuid)
  ps(out, 2, '')
  pv(out, 3, 7, true)
  await oidb(0x9407, 1, Buffer.from(out))
  return { deleted: uuid }
}

/** 重命名闪传文件（0x9427，envelope 特例 sub=0 + uinForm） */
export async function renameFlashFile ({ fileset_uuid: uuid, new_name: newName } = {}) {
  if (!uuid || !newName) throw new Error('fileset_uuid + new_name 必填')
  const name = []
  ps(name, 1, newName)
  ps(name, 2, newName)
  const flag = []
  pv(flag, 1, 0, true)
  const out = []
  ps(out, 1, uuid)
  pb(out, 2, Buffer.from(name))
  pb(out, 3, Buffer.from(flag))
  await oidb(0x9427, 0, Buffer.from(out), true)
  return { renamed: uuid, new_name: newName }
}

/** 分享码 → fileset_uuid（qfile.qq.com/q/<code> 页面内嵌） */
export async function getFilesetIdByCode ({ share_code: code } = {}) {
  const value = String(code ?? '').trim()
  if (!value) throw new Error('share_code 必填（qfile.qq.com/q/xxx 或裸 code）')
  let url
  if (/^https:\/\/qfile\.qq\.com\/q\/[^/]+$/.test(value)) url = value
  else {
    if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 256) throw new Error('share_code 形态不识别')
    url = `https://qfile.qq.com/q/${encodeURIComponent(value)}`
  }
  const resp = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'manual' })
  const isRedirect = resp.status >= 300 && resp.status < 400
  if (!resp.ok && !isRedirect) throw new Error(`分享页 HTTP ${resp.status}`)
  const html = await resp.text()
  /* 页面把 fileset_id 以 JSON 片段嵌进去（引号可能被转义）；键后面不远处就是 UUID，
   * 所以先把候选的「十六进制-连字符」串都捞出来，再按 UUID 的段长筛。 */
  const anchor = html.indexOf('fileset_id')
  const near = anchor < 0 ? '' : html.slice(anchor, anchor + 160)
  const runs = near.match(/[0-9a-f]{8,}(?:-[0-9a-f]+)+/gi) || []
  const segmentLengths = [8, 4, 4, 4, 12]
  const uuid = runs.find((run) => {
    const seg = run.split('-')
    return seg.length === segmentLengths.length && seg.every((part, i) => part.length === segmentLengths[i])
  })
  if (!uuid) throw new Error('分享页里没提取到 fileset_id（页面结构可能变了）')
  return { fileset_uuid: uuid }
}

/* 群文件列表（0x6D8_1，uinForm）：
 * 群文件分页列表：body={2:listReq{1:groupUin,2:appId=7,
 * 3:targetDirectory,5:fileCount,9:sortBy,13:startIndex,17:2,18:0}}；
 * resp list{1:retCode,2:retMsg,4:isEnd,5:repeated item{1:type(1=文件夹/2=文件),
 * 2:folderInfo{3:folderName,8:totalFileCount},3:fileInfo{1:fileId,2:fileName,
 * 3:fileSize,14:uploaderName,15:uploaderUin}}} */
export async function groupFileList ({ group, folder = '/', start = 0, count = 50 } = {}) {
  const g = Number(group)
  if (!(g > 0)) throw new Error('group（群号）必填')
  const listReq = []
  pv(listReq, 1, g); pv(listReq, 2, 7)
  pb(listReq, 3, Buffer.from(String(folder || '/')))
  pv(listReq, 5, Number(count) || 50); pv(listReq, 9, 1)
  pv(listReq, 13, Number(start) || 0); pv(listReq, 17, 2); pv(listReq, 18, 0)
  const body = []
  pb(body, 2, Buffer.from(listReq))
  const buf = await oidb(0x6d8, 1, Buffer.from(body), true)
  /* oidb() 返回的已是 OIDB envelope f4 剥壳后的内容 = OidbGroupFileViewResp 本体 */
  const view = rd(buf)
  const listBuf = view.f(2)
  if (!listBuf) return { items: [], is_end: true }
  const list = rd(listBuf)
  const retCode = list.num(1)
  if (retCode) throw new Error('群文件列表被拒（' + retCode + '）' + list.str(2))
  const items = []
  for (const itBuf of list.all(5)) {
    const d = rd(itBuf)
    /* item type 值不可信（f1=1 也可能就是文件，与部分公开实现的注解相反）——
       按内容判别：f3= fileInfo → 文件；f2= folderInfo → 文件夹 */
    if (d.f(3)) {
      const f = rd(d.f(3))
      items.push({
        type: 'file',
        file_id: f.str(1),
        file_name: f.str(2),
        size: f.num(3),
        uploaded_time: f.num(6),
        expire_time: f.num(7),
        downloaded_times: f.num(9),
        uploader_name: f.str(14),
        uploader_uin: f.num(15)
      })
    } else if (d.f(2)) {
      const fo = rd(d.f(2))
      items.push({
        type: 'folder',
        folder_id: fo.str(1),
        folder_name: fo.str(3),
        total_file_count: fo.num(8),
        creator_uin: fo.num(6),
        creator_name: fo.str(7)
      })
    }
  }
  return { items, is_end: !!list.num(4) }
}

/* 群文件下载直链（0x6D6_2）：
 *   请求 download(f3) = {1: 群号(u64), 2: appId=7, 3: busId(默认 102), 4: fileId 字符串}；
 *   响应 download(f3) = {1: retCode, 2/3: 错误文案, 5: downloadDns, 6: downloadUrl 字节}，
 *   downloadUrl 是十六进制下载密钥（大写），拼 https://<dns>/ftn_handler/<HEX>/?fname=<fileId>。
 * 注意 0x6D6 与群文件上传（0x6D6_0 预检 + Highway）共用命令号，sub 区分。 */
export async function groupFileUrl ({ group, file_id: fileId, bus_id: busId = 102 } = {}) {
  const g = Number(group)
  if (!(g > 0)) throw new Error('group（群号）必填')
  if (!fileId) throw new Error('file_id 必填（从群文件列表获取）')
  const req = []
  pv(req, 1, g)
  pv(req, 2, 7)
  pv(req, 3, Number(busId) || 102)
  ps(req, 4, String(fileId))
  const body = []
  pb(body, 3, Buffer.from(req))
  const buf = await oidb(0x6d6, 2, Buffer.from(body), true)
  /* oidb() 已剥 OIDB envelope f4 壳，直接是 OidbGroupFileResp */
  const resp = rd(buf)
  const dlBuf = resp.f(3)
  if (!dlBuf) throw new Error('群文件链接响应缺 download 体')
  const dl = rd(dlBuf)
  const retCode = dl.num(1)
  if (retCode) throw new Error('群文件链接被拒（' + retCode + '）' + dl.str(2) + dl.str(3))
  const dns = dl.str(5) || dl.str(4)
  const keyBuf = dl.f(6)
  if (!dns || !keyBuf || !keyBuf.length) throw new Error('响应缺下载域名或下载密钥（file_id 可能已过期，重新取列表）')
  const hex = Buffer.from(keyBuf).toString('hex').toUpperCase()
  return {
    url: `https://${dns}/ftn_handler/${hex}/?fname=${encodeURIComponent(String(fileId))}`,
    file_id: String(fileId),
    file_name: dl.str(11)
  }
}

/* 群文件重命名（0x6D6_4 纯 OIDB）：
 *   rename 槽位在 OidbGroupFileReq 信封 f5 = {1: 群号, 3: busId=102, 4: fileId, 5: 当前父目录, 6: 新文件名}；
 *   响应 f5 = {1: retCode, 2/3: 文案}。
 * 注意：内核 nodeIKernelGroupFileService.renameGroupFile 对旁挂会话恒拒（result 非 0），
 * 必须走 OIDB。 */
export async function groupFileRename ({ group, file_id: fileId, new_name: newName, folder_id: folderId = '/' } = {}) {
  const g = Number(group)
  if (!(g > 0)) throw new Error('group（群号）必填')
  if (!fileId) throw new Error('file_id 必填（从群文件列表获取）')
  const name = String(newName || '').trim()
  if (!name) throw new Error('new_name（新文件名）必填')
  const req = []
  pv(req, 1, g)
  pv(req, 3, 102)
  ps(req, 4, String(fileId))
  ps(req, 5, String(folderId || '/'))
  ps(req, 6, name)
  const body = []
  pb(body, 5, Buffer.from(req))
  const buf = await oidb(0x6d6, 4, Buffer.from(body), true)
  const resp = rd(buf)
  const rnBuf = resp.f(5)
  if (!rnBuf) throw new Error('重命名响应缺 rename 体')
  const rn = rd(rnBuf)
  const retCode = rn.num(1)
  if (retCode) throw new Error('重命名被拒（' + retCode + '）' + rn.str(2) + rn.str(3))
  return { file_id: String(fileId), old_name: '', new_name: name }
}

function bytesStr (v) {
  if (v == null) return ''
  if (typeof v === 'string') return v
  return Buffer.from(v).toString('utf8')
}

/* 导出 pb 编解码与 OIDB 助手，供 media-dl.js 等模块复用（口径与 proton 一致） */
export { vi, tag, pv, pb, ps, rd, hexToBuf, cat, oidb }
