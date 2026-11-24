import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP_DIR = path.join(ROOT, 'app')
const DATA_DIR = path.join(APP_DIR, 'data')

function basePort () {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8'))
    const p = Number(cfg.port)
    if (Number.isInteger(p) && p > 0 && p < 65535) return p
  } catch {}
  return 5701
}

function candidatePorts () {
  const base = basePort()
  const out = []
  try {
    const p = Number(fs.readFileSync(path.join(DATA_DIR, 'panel.port'), 'utf8').trim())
    if (Number.isInteger(p) && p > 0) out.push(p)
  } catch {}
  for (let p = base; p <= base + 20; p++) if (!out.includes(p)) out.push(p)
  return out
}

function probe (port, timeout = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port })
    let done = false
    const finish = (up) => {
      if (done) return
      done = true
      try { sock.destroy() } catch {}
      resolve(up)
    }
    sock.setTimeout(timeout)
    sock.once('connect', () => finish(true))
    sock.once('error', () => finish(false))
    sock.once('timeout', () => finish(false))
  })
}

async function findLive () {
  for (const p of candidatePorts()) if (await probe(p)) return p
  return 0
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function openBrowser (port) {
  /* 默认不弹浏览器（弹窗打断人在做的事，会真心烦）；显式 FL_OPEN=1 才弹 */
  const url = `http://127.0.0.1:${port}/`
  if (process.env.FL_OPEN !== '1') return url
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
    }
  } catch {}
  return url
}

const live = await findLive()
if (live) {
  const url = openBrowser(live)
  console.log(`面板已在运行：${url}`)
  process.exit(0)
}

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
const out = fs.openSync(path.join(DATA_DIR, 'panel.out'), 'a')
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: APP_DIR,
  detached: true,
  stdio: ['ignore', out, out],
  env: Object.assign({}, process.env, { FL_NO_OPEN: '1' }),
  windowsHide: true
})
child.unref()

try { fs.writeFileSync(path.join(DATA_DIR, 'panel.pid'), String(child.pid), 'utf8') } catch {}

const deadline = Date.now() + 25000
let up = 0
while (Date.now() < deadline) {
  await wait(350)
  up = await findLive()
  if (up) break
}

if (!up) {
  console.error('面板在 25 秒内没有开始监听，详见 app\\data\\panel.out')
  process.exit(1)
}

const url = openBrowser(up)
console.log(`面板已启动：${url}（pid=${child.pid}）`)
process.exit(0)
