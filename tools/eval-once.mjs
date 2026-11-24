import net from 'node:net'
import fs from 'node:fs'

const pid = process.argv[2]
const jsFile = process.argv[3]
if (!pid || !jsFile) { console.error('用法: node tools/eval-once.mjs <pid> <js文件或代码>'); process.exit(1) }
let code = jsFile
if (fs.existsSync(jsFile)) code = fs.readFileSync(jsFile, 'utf8')

const seq = Date.now() % 100000
const evtPath = `\\\\.\\pipe\\frishluna.${pid}.evt`
const cmdPath = `\\\\.\\pipe\\frishluna.${pid}.cmd`

let buf = Buffer.alloc(0)
const evt = net.connect(evtPath)

evt.on('connect', () => {
  const cmd = net.connect(cmdPath)
  cmd.on('connect', () => {
    cmd.write(JSON.stringify({ cmd: 'eval', js: code, seq }))
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
    if (process.env.FL_VERBOSE) console.error('[frame]', JSON.stringify(o).slice(0, 200))
    if (o.seq !== seq) continue
    if (o.evt === 'eval-ok') { console.log(o.ret); process.exit(0) }
    if (o.evt === 'eval-err') { console.error('ERR: ' + (o.err || o.msg)); process.exit(3) }
  }
})
evt.on('error', (e) => { console.error('evt-error:', e.message); process.exit(1) })
setTimeout(() => { console.error('timeout waiting reply'); process.exit(2) }, 25000)
