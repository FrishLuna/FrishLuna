import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './config.js'

export const envPath = path.join(ROOT, '.env')

const KEY_SALT = 'FL_AUTH_SALT'
const KEY_HASH = 'FL_AUTH_HASH'
const KEY_FIRST = 'FL_AUTH_FIRST'
const KEY_LEGACY_SEALED = 'FL_AUTH_SEALED'
const HEADER = '# FrishLuna 访问令牌 —— 盐 / scrypt 哈希，无明文、无副本。删掉本段即重置令牌'

const SALT_BYTES = 16
const HASH_BYTES = 64
const SCRYPT = { N: 16384, r: 8, p: 1 }

/* .env 读写（保留文件里其他键） */

function readLines () {
  try { return fs.readFileSync(envPath, 'utf8').split(/\r?\n/) } catch { return [] }
}

function parseEnv () {
  const out = {}
  for (const line of readLines()) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const i = s.indexOf('=')
    if (i <= 0) continue
    out[s.slice(0, i).trim()] = s.slice(i + 1).trim()
  }
  return out
}

function keyOf (line) {
  const s = line.trim()
  if (!s || s.startsWith('#')) return ''
  const i = s.indexOf('=')
  return i > 0 ? s.slice(0, i).trim() : ''
}

function writeEnv (patch) {
  const drop = new Set(Object.keys(patch))
  const keep = readLines().filter((line) => {
    if (line.trim() === HEADER) return false
    const k = keyOf(line)
    if (!k) return true
    return !drop.has(k)
  })
  while (keep.length && keep[keep.length - 1].trim() === '') keep.pop()
  const block = [HEADER, ...Object.keys(patch).map((k) => `${k}=${patch[k]}`)]
  const text = [...keep, ...(keep.length ? [''] : []), ...block, ''].join('\n')
  fs.writeFileSync(envPath, text, 'utf8')
}

function scrypt (secret, saltBuf, len) {
  return crypto.scryptSync(String(secret), saltBuf, len, SCRYPT)
}

/** 派生长度跟着已有哈希走：旧版 32 字节、新版 64 字节都能验，不用强制重设 */
function expectedLen (hashHex) {
  const n = Math.floor(String(hashHex || '').length / 2)
  return n > 0 && n <= 128 ? n : HASH_BYTES
}

export function exists () {
  const env = parseEnv()
  return !!(env[KEY_SALT] && env[KEY_HASH])
}

/** 写入一个令牌：新盐 + 哈希；firstRun 传了才改写首次运行标记 */
export function saveToken (plain, opts = {}) {
  const saltHex = crypto.randomBytes(SALT_BYTES).toString('hex')
  const hash = scrypt(plain, Buffer.from(saltHex, 'hex'), HASH_BYTES).toString('hex')
  const patch = { [KEY_SALT]: saltHex, [KEY_HASH]: hash }
  if (opts.firstRun !== undefined) patch[KEY_FIRST] = opts.firstRun ? '1' : '0'
  writeEnv(patch)
}

/** 是否还停在「首次运行」状态：初始令牌只能用于设置自己的令牌 */
export function isFirstRun () {
  return parseEnv()[KEY_FIRST] === '1'
}

export function clearFirstRun () {
  writeEnv({ [KEY_FIRST]: '0' })
}

/** 用 .env 里的盐 + 哈希校验候选令牌（本层唯一的校验入口，没有明文快路径） */
export function verifyHash (candidate) {
  const env = parseEnv()
  const salt = env[KEY_SALT]
  const hash = env[KEY_HASH]
  if (!salt || !hash || !candidate) return false
  try {
    const want = Buffer.from(hash, 'hex')
    if (!want.length) return false
    const got = scrypt(candidate, Buffer.from(salt, 'hex'), expectedLen(hash))
    if (got.length !== want.length) return false
    return crypto.timingSafeEqual(got, want)
  } catch { return false }
}

/** 迁移：旧版留下的 AES 密封副本没有用了，删掉（避免「可逆副本」留在盘上） */
export function dropLegacySealed () {
  const lines = readLines()
  const hasKey = lines.some((line) => keyOf(line) === KEY_LEGACY_SEALED)
  const hasOldHead = lines.some((line) => /密封副本/.test(line) && line.trim().startsWith('#'))
  if (!hasKey && !hasOldHead) return false
  const kept = lines
    .filter((line) => keyOf(line) !== KEY_LEGACY_SEALED)
    .map((line) => (line.trim().startsWith('#') && /密封副本/.test(line) ? HEADER : line))
  fs.writeFileSync(envPath, kept.join('\n'), 'utf8')
  return true
}

export function describe () {
  return {
    file: envPath,
    salted: true,
    algo: 'scrypt(N=16384,r=8,p=1,64B)',
    reversible: false
  }
}
