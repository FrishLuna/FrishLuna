import net from 'node:net'

const pid = process.argv[2]
const name = process.argv[3]
const args = process.argv[4] ? JSON.parse(process.argv[4]) : {}
if (!pid || !name) { console.error('用法: node tools/op-once.mjs <pid> <opName> [jsonArgs]'); process.exit(1) }

const seq = Date.now() % 100000
const evtPath = `\\\\.\\pipe\\frishluna.${pid}.evt`
const cmdPath = `\\\\.\\pipe\\frishluna.${pid}.cmd`

const evt = net.connect(evtPath)
let buf = Buffer.alloc(0)

evt.on('connect', () => {
  const cmd = net.connect(cmdPath)
  cmd.on('connect', () => {
    cmd.write(JSON.stringify({ cmd: 'op', name, args, seq }))
    setTimeout(() => cmd.end(), 200)
  })
  cmd.on('error', (e) => { console.error('cmd-error:', e.message); process.exit(1) })
})

evt.on('data', (d) => {
  buf = Buffer.concat([buf, d])
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0)
    if (buf.length < 4 + len) break
    const txt = buf.slice(4, 4 + len).toString('utf8')
    buf = buf.slice(4 + len)
    let o = null
    try { o = JSON.parse(txt) } catch { continue }
    if (o.seq !== seq) continue
    if (o.evt === 'op-ok') { console.log(o.ret); process.exit(0) }
    if (o.evt === 'op-err') { console.error('ERR: ' + o.err); process.exit(3) }
    if (o.evt === 'op-chunk') { chunks[o.idx] = o.part; if (Object.keys(chunks).length === o.total) { console.log(chunks.join('')); process.exit(0) } }
  }
})
const chunks = {}
evt.on('error', (e) => { console.error('evt-error:', e.message); process.exit(1) })
setTimeout(() => { console.error('timeout waiting reply'); process.exit(2) }, 20000)
