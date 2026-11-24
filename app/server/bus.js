const MAX_LINES = 2000

const lines = []
const clients = new Set()
let seq = 0

function nowHMS () {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'ok']

/**
 * @param {'debug'|'info'|'warn'|'error'|'ok'} level
 * @param {string} scope  例如 qq / pipe / cmd / boot
 * @param {string} text
 * @param {object} [extra]
 */
export function log (level, scope, text, extra) {
  const rec = {
    id: ++seq,
    t: nowHMS(),
    ts: Date.now(),
    level: LOG_LEVELS.includes(level) ? level : 'info',
    scope: String(scope || 'app'),
    text: String(text == null ? '' : text),
    extra: extra || null
  }
  lines.push(rec)
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES)
  broadcast('log', rec)
  // 控制台同步输出（前台窗口能看到；debug 不刷屏）
  if (rec.level !== 'debug' && process.env.FL_QUIET !== '1') {
    const tag = rec.level === 'ok' ? ' OK ' : rec.level === 'warn' ? 'WARN' : rec.level === 'error' ? 'ERR ' : '    '
    console.log(`${rec.t} ${tag} ${rec.scope}: ${rec.text}`)
  }
  return rec
}

export const info = (s, t, e) => log('info', s, t, e)
export const ok = (s, t, e) => log('ok', s, t, e)
export const warn = (s, t, e) => log('warn', s, t, e)
export const error = (s, t, e) => log('error', s, t, e)
export const debug = (s, t, e) => log('debug', s, t, e)

export function recent (n = 300) {
  return lines.slice(Math.max(0, lines.length - n))
}

export function clear () {
  lines.length = 0
  broadcast('clear', {})
}

export function addClient (res) {
  clients.add(res)
}

export function removeClient (res) {
  clients.delete(res)
}

export function clientCount () {
  return clients.size
}

/** 推一条结构化事件给面板（不走日志缓冲） */
export function broadcast (event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of clients) {
    try { res.write(payload) } catch { clients.delete(res) }
  }
}

export function heartbeat () {
  for (const res of clients) {
    try { res.write(': ping\n\n') } catch { clients.delete(res) }
  }
}
