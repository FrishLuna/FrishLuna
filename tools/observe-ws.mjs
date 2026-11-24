const url = process.argv[2] || 'ws://127.0.0.1:5760'
const token = process.argv[3] || ''
const ws = new WebSocket(url + '?access_token=' + encodeURIComponent(token))

const seen = new Map() // message_id -> 收到次数
let msgN = 0
let dupN = 0
const t0 = Date.now()

ws.addEventListener('open', () => console.log('[open]', url, new Date().toISOString()))
ws.addEventListener('message', (m) => {
  let ev
  try { ev = JSON.parse(typeof m.data === 'string' ? m.data : '') } catch { return }
  if (!ev || typeof ev !== 'object') return
  if (ev.post_type === 'message') {
    msgN++
    const c = (seen.get(ev.message_id) || 0) + 1
    seen.set(ev.message_id, c)
    if (c > 1) dupN++
    console.log(
      `[msg #${msgN}${c > 1 ? ' ⚠️DUP x' + c : ''}] type=${ev.message_type}` +
      ` group=${ev.group_id ?? '-'} user=${ev.user_id ?? '-'} id=${ev.message_id}` +
      ` raw=${String(ev.raw_message || '').slice(0, 80)}`
    )
  } else if (ev.post_type === 'meta_event' && ev.meta_event_type === 'heartbeat') {
    // 心跳不刷屏；每 5 次报一次存活
    if ((ev.interval && msgN === 0 && Date.now() - t0 > 30000) === false) return
  } else {
    console.log('[evt]', JSON.stringify(ev).slice(0, 220))
  }
})
ws.addEventListener('close', () => console.log('[close]'))
ws.addEventListener('error', (e) => console.log('[error]', (e && e.message) || String(e)))

// 每 30 秒报一次汇总
setInterval(() => {
  console.log(`[stat] +${Math.round((Date.now() - t0) / 1000)}s 事件=${msgN} 去重命中=${dupN} 唯一message_id=${seen.size}`)
}, 30000)
setInterval(() => {}, 1 << 30) // keep-alive
