import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_FILE = path.join(__dirname, '..', 'data', 'frishluna.db')

let db = null
let ready = false
let failed = null
const stmts = {}

function load () {
  if (ready || failed) return ready
  try {
    if (!fs.existsSync(path.dirname(DB_FILE))) fs.mkdirSync(path.dirname(DB_FILE), { recursive: true })
    /* node:sqlite 在 Node 22 会打一条实验特性告警到 stderr，这里静音（功能不受影响） */
    const orig = process.emitWarning
    process.emitWarning = () => {}
    let mod
    try { mod = require('node:sqlite') } finally { process.emitWarning = orig }
    db = new mod.DatabaseSync(DB_FILE)
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS uidmap (
        qq TEXT PRIMARY KEY, uid TEXT NOT NULL, ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS uidmap_uid ON uidmap(uid);
      CREATE TABLE IF NOT EXISTS msgids (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kernel_id TEXT NOT NULL, peer TEXT, chat_type INTEGER, account TEXT, ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS msgids_kernel ON msgids(kernel_id);
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account TEXT NOT NULL, message_id INTEGER, kernel_id TEXT NOT NULL,
        chat_type INTEGER, peer TEXT, sender_uin TEXT, sender_nick TEXT,
        time INTEGER, text TEXT, raw TEXT, ts INTEGER NOT NULL,
        UNIQUE(account, kernel_id)
      );
      CREATE INDEX IF NOT EXISTS messages_peer ON messages(account, peer, time DESC);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account TEXT, type TEXT, at INTEGER NOT NULL, payload TEXT
      );
      CREATE INDEX IF NOT EXISTS events_at ON events(at DESC);
    `)
    ready = true
  } catch (e) {
    failed = e && e.message ? e.message : String(e)
    ready = false
  }
  return ready
}

export function isReady () { return load() }

/** 首用即建表；返回一句人话状态（面板诊断用） */
export function status () {
  const ok = load()
  if (!ok) return { ok: false, file: DB_FILE, msg: 'sqlite 不可用：' + (failed || '未知') }
  try {
    const s = {}
    for (const [k, sql] of [
      ['uidmap', 'SELECT COUNT(*) AS n FROM uidmap'],
      ['msgids', 'SELECT COUNT(*) AS n FROM msgids'],
      ['messages', 'SELECT COUNT(*) AS n FROM messages'],
      ['events', 'SELECT COUNT(*) AS n FROM events']
    ]) s[k] = Number(db.prepare(sql).get().n) || 0
    s.file = DB_FILE
    return { ok: true, counts: s }
  } catch (e) {
    return { ok: false, file: DB_FILE, msg: e.message }
  }
}

export function putUid (qq, uid) {
  if (!load()) return false
  try {
    db.prepare('INSERT INTO uidmap(qq, uid, ts) VALUES(?,?,?) ON CONFLICT(qq) DO UPDATE SET uid=excluded.uid, ts=excluded.ts')
      .run(String(qq), String(uid), Date.now())
    return true
  } catch { return false }
}

export function allUids () {
  if (!load()) return []
  try { return db.prepare('SELECT qq, uid FROM uidmap').all() } catch { return [] }
}

/** 记一条 message_id 映射；返回库里分配的自增 id（重启后也不复用） */
export function putMsgId (kernelId, peer, chatType, account) {
  if (!load()) return 0
  try {
    const r = db.prepare('INSERT INTO msgids(kernel_id, peer, chat_type, account, ts) VALUES(?,?,?,?,?)')
      .run(String(kernelId), String(peer || ''), Number(chatType) || 1, String(account || ''), Date.now())
    return Number(r.lastInsertRowid) || 0
  } catch { return 0 }
}

export function maxMsgIdId () {
  if (!load()) return 0
  try { return Number(db.prepare('SELECT IFNULL(MAX(id),0) AS n FROM msgids').get().n) || 0 } catch { return 0 }
}

export function recentMsgIds (limit = 4096) {
  if (!load()) return []
  try {
    return db.prepare('SELECT id, kernel_id AS kernelId, peer, chat_type AS chatType, account FROM msgids ORDER BY id DESC LIMIT ?')
      .all(Math.max(1, Math.min(20000, Number(limit) || 4096)))
  } catch { return [] }
}

/** 按内核 msgId 反查最近一次登记的会话与账号（撤回/取消息兜底定位用） */
export function findMsgIdMeta (kernelId) {
  if (!load()) return null
  try {
    const r = db.prepare('SELECT peer, chat_type AS chatType, account FROM msgids WHERE kernel_id = ? ORDER BY id DESC LIMIT 1')
      .get(String(kernelId || ''))
    return r ? { peer: String(r.peer || ''), chatType: Number(r.chatType) || 1, account: String(r.account || '') } : null
  } catch { return null }
}

export function saveMessage (m) {
  if (!load()) return false
  try {
    db.prepare(`INSERT INTO messages(account, message_id, kernel_id, chat_type, peer, sender_uin, sender_nick, time, text, raw, ts)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(account, kernel_id) DO UPDATE SET message_id=excluded.message_id, text=excluded.text`)
      .run(String(m.account || ''), Number(m.messageId) || 0, String(m.kernelId || ''), Number(m.chatType) || 1,
        String(m.peer || ''), String(m.senderUin || ''), String(m.senderNick || ''),
        Number(m.time) || Date.now(), String(m.text || ''), m.raw ? JSON.stringify(m.raw) : '', Date.now())
    return true
  } catch { return false }
}

/** 历史消息检索：可按账号 / 会话 / 类型 / 关键字 / 时间游标翻页 */
export function queryMessages ({ account, peer, chatType, q, limit = 50, before = 0 } = {}) {
  if (!load()) return []
  try {
    const cond = []
    const args = []
    if (account) { cond.push('account = ?'); args.push(String(account)) }
    if (peer) { cond.push('peer = ?'); args.push(String(peer)) }
    if (chatType) { cond.push('chat_type = ?'); args.push(Number(chatType)) }
    if (before) { cond.push('time < ?'); args.push(Number(before)) }
    const kw = String(q || '').trim()
    if (kw) {
      cond.push('(text LIKE ? OR sender_nick LIKE ? OR peer LIKE ? OR sender_uin LIKE ?)')
      const like = '%' + kw.replace(/[%_]/g, (c) => '\\' + c) + '%'
      args.push(like, like, like, like)
    }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : ''
    args.push(Math.max(1, Math.min(500, Number(limit) || 50)))
    return db.prepare(`SELECT message_id AS messageId, kernel_id AS kernelId, chat_type AS chatType, peer,
      sender_uin AS senderUin, sender_nick AS senderNick, time, text FROM messages ${where} ORDER BY time DESC, id DESC LIMIT ?`)
      .all(...args)
  } catch { return [] }
}

/** 同一套条件的总数（面板显示「共 N 条」用，不受 limit 影响） */
export function countMessages ({ account, peer, chatType, q, before = 0 } = {}) {
  if (!load()) return 0
  try {
    const cond = []
    const args = []
    if (account) { cond.push('account = ?'); args.push(String(account)) }
    if (peer) { cond.push('peer = ?'); args.push(String(peer)) }
    if (chatType) { cond.push('chat_type = ?'); args.push(Number(chatType)) }
    if (before) { cond.push('time < ?'); args.push(Number(before)) }
    const kw = String(q || '').trim()
    if (kw) {
      cond.push('(text LIKE ? OR sender_nick LIKE ? OR peer LIKE ? OR sender_uin LIKE ?)')
      const like = '%' + kw.replace(/[%_]/g, (c) => '\\' + c) + '%'
      args.push(like, like, like, like)
    }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : ''
    return Number(db.prepare(`SELECT COUNT(*) AS n FROM messages ${where}`).get(...args).n) || 0
  } catch { return 0 }
}

/** 每个会话最后一条消息（面板「最近会话」列表用） */
export function recentPeers (limit = 30) {
  if (!load()) return []
  try {
    return db.prepare(`SELECT m.peer, m.chat_type AS chatType, m.text, m.time, m.sender_nick AS senderNick,
        (SELECT COUNT(*) FROM messages x WHERE x.peer = m.peer AND x.chat_type = m.chat_type) AS n
      FROM messages m
      WHERE m.id = (SELECT id FROM messages y WHERE y.peer = m.peer AND y.chat_type = m.chat_type ORDER BY y.time DESC, y.id DESC LIMIT 1)
      ORDER BY m.time DESC LIMIT ?`).all(Math.max(1, Math.min(200, Number(limit) || 30)))
  } catch { return [] }
}

export function saveEvent (account, type, payload) {
  if (!load()) return false
  try {
    db.prepare('INSERT INTO events(account, type, at, payload) VALUES(?,?,?,?)')
      .run(String(account || ''), String(type || ''), Date.now(),
        payload ? JSON.stringify(payload).slice(0, 4000) : '')
    return true
  } catch { return false }
}

/** 事件流水查询（面板「事件」页 / 排障用）
 *  kinds：按前缀多选（如 ['notice','request','sysmsg']），传了就只看这几类 */
export function queryEvents ({ type, kinds, account, limit = 100, before = 0 } = {}) {
  if (!load()) return []
  try {
    const cond = []
    const args = []
    if (type) { cond.push('type LIKE ?'); args.push('%' + String(type) + '%') }
    if (Array.isArray(kinds) && kinds.length) {
      cond.push('(' + kinds.map(() => 'type LIKE ? || \'%\'').join(' OR ') + ')')
      kinds.forEach((k) => args.push(String(k)))
    }
    if (account) { cond.push('account = ?'); args.push(String(account)) }
    if (before) { cond.push('at < ?'); args.push(Number(before)) }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : ''
    args.push(Math.max(1, Math.min(500, Number(limit) || 100)))
    return db.prepare(`SELECT id, account, type, at, payload FROM events ${where} ORDER BY at DESC, id DESC LIMIT ?`).all(...args)
  } catch { return [] }
}

/** 事件类型汇总（每种类型最近一次什么时候来的、共几条） */
export function eventTypes () {
  if (!load()) return []
  try {
    return db.prepare(`SELECT type, COUNT(*) AS n, MAX(at) AS last FROM events GROUP BY type ORDER BY last DESC LIMIT 100`).all()
  } catch { return [] }
}

/** 保最近 30 天 + 各表留足上限，避免库无限长 */
export function prune ({ days = 30, keepMessages = 50000, keepEvents = 20000, keepMsgIds = 20000 } = {}) {
  if (!load()) return { ok: false }
  const cutoff = Date.now() - days * 86400000
  try {
    db.prepare('DELETE FROM messages WHERE ts < ?').run(cutoff)
    db.prepare('DELETE FROM events WHERE at < ?').run(cutoff)
    db.prepare('DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT ?)').run(keepMessages)
    db.prepare('DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT ?)').run(keepEvents)
    db.prepare('DELETE FROM msgids WHERE id NOT IN (SELECT id FROM msgids ORDER BY id DESC LIMIT ?)').run(keepMsgIds)
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    return { ok: true }
  } catch (e) {
    return { ok: false, msg: e.message }
  }
}

export const file = DB_FILE
