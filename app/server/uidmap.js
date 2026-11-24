import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as store from './store.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORE = path.join(__dirname, '..', 'data', 'uidmap.json')

/** qq(number 字符串) → uid；uid → qq */
let qq2uid = new Map()
let uid2qq = new Map()
let dirty = false

function load () {
  try {
    const j = JSON.parse(fs.readFileSync(STORE, 'utf8'))
    for (const [qq, uid] of Object.entries(j.qq2uid || {})) {
      if (/^\d{5,12}$/.test(qq) && typeof uid === 'string' && uid.startsWith('u_')) {
        qq2uid.set(qq, uid)
        uid2qq.set(uid, qq)
      }
    }
  } catch { /* 首次运行无文件，空表启动 */ }
  /* JSON 是老的落盘方式，库是新的。两边取并集：库里的补进来，
     JSON 里多的（老版本升级上来）稍后 put 时会写进库。 */
  try {
    for (const r of store.allUids()) {
      const qq = String(r.qq)
      const uid = String(r.uid)
      if (!qq2uid.has(qq) && /^\d{5,12}$/.test(qq) && uid.startsWith('u_')) {
        qq2uid.set(qq, uid)
        uid2qq.set(uid, qq)
        dirty = true
      }
    }
  } catch { /* 库不可用就只吃 JSON */ }
}
load()

function put (qq, uid) {
  const q = String(qq)
  const u = String(uid)
  if (!/^\d{5,12}$/.test(q)) return false
  if (!/^u_[A-Za-z0-9_-]+$/.test(u)) return false
  const old = qq2uid.get(q)
  if (old === u) return true
  if (old) uid2qq.delete(old)
  qq2uid.set(q, u)
  uid2qq.set(u, q)
  dirty = true
  try { store.putUid(q, u) } catch { /* 落库失败还有 JSON 兜底 */ }
  return true
}

/** 原子写：先写临时文件再 rename，避免半截 JSON */
function flush () {
  if (!dirty) return
  try {
    const tmp = STORE + '.tmp'
    fs.mkdirSync(path.dirname(STORE), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify({ qq2uid: Object.fromEntries(qq2uid) }, null, 1), 'utf8')
    fs.renameSync(tmp, STORE)
    dirty = false
  } catch { /* 落盘失败只影响下次启动的冷缓存，不影响本次运行 */ }
}

/**
 * 从「好友列表」全量建表。列表项需含 user_id(QQ号) 与 uid 字段（内核推送/查询产物）。
 * @param {Array<{user_id?:number|string, uid?:string, qq?:number|string}>} list
 */
export function seedFromBuddyList (list) {
  let n = 0
  for (const it of Array.isArray(list) ? list : []) {
    const qq = it && (it.user_id ?? it.qq)
    const uid = it && it.uid
    if (qq !== undefined && uid && put(qq, uid)) n++
  }
  flush()
  return n
}

/** 从群成员/最近会话/来信增量回填。字段名按内核实际形状逐个试。 */
export function backfill (list) {
  let n = 0
  for (const it of Array.isArray(list) ? list : []) {
    if (!it) continue
    const qq = it.user_id ?? it.qq ?? it.uin
    const uid = it.uid ?? it.peerUid ?? it.senderUid
    // peerUid 在群消息语境是群号，这里只认 u_ 开头，数字自动忽略
    if (qq !== undefined && uid && /^u_/.test(String(uid)) && put(qq, uid)) n++
  }
  if (n) flush()
  return n
}

/**
 * QQ 号 → uid。查不到显式失败，绝不返回数字。
 * @returns {{ok:true, uid:string} | {ok:false, msg:string}}
 */
export function resolve (qq) {
  const q = String(qq)
  if (!/^\d{5,12}$/.test(q)) return { ok: false, msg: `QQ 号不合法：${q.slice(0, 3)}***（须 5~12 位纯数字）` }
  const uid = qq2uid.get(q)
  if (uid) return { ok: true, uid }
  return { ok: false, msg: `找不到 QQ 号 ${q.slice(0, 3)}*** 的 uid（表内 ${qq2uid.size} 条；可先让它发一条消息或经好友列表回填）` }
}

/** uid → QQ 号；查不到返回 null */
export function toQq (uid) {
  return uid2qq.get(String(uid)) || null
}

/** 表规模（自测/诊断） */
export function size () {
  return qq2uid.size
}

/** 清空内存表（测试用；不影响已落盘文件） */
export function resetMem () {
  qq2uid = new Map()
  uid2qq = new Map()
  dirty = false
}
