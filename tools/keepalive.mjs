import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP_DIR = path.join(ROOT, 'app')
const DATA_DIR = path.join(APP_DIR, 'data')

/** 面板主端口从配置读；实际端口可能顺延，见 basePorts() */
function basePort () {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8'))
    const p = Number(cfg.port)
    if (Number.isInteger(p) && p > 0 && p < 65535) return p
  } catch {}
  return 5701
}

/**
 * 面板在「主端口被占」时会自动 +1 顺延（最多 +20），所以探测范围必须覆盖这一段，
 * 否则面板跑在 5702、看门狗探 5701 说没起来，会每隔一分钟多拉起一个实例。
 * 先看 panel.port（面板自己写的真实端口），再扫整段。
 */
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

function probe (port, timeout = 1200) {
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
  for (const p of candidatePorts()) {
    if (await probe(p)) return p
  }
  return 0
}

function log (line) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.appendFileSync(path.join(DATA_DIR, 'keepalive.log'),
      `${new Date().toLocaleString('zh-CN', { hour12: false })}  ${line}\n`)
  } catch {}
}

const live = await findLive()
if (live) {
  log(`面板已在监听 :${live}，本次不动作`)
  process.exit(0)
}

const out = fs.openSync(path.join(DATA_DIR, 'panel.out'), 'a')
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: APP_DIR,
  detached: true,
  stdio: ['ignore', out, out],
  env: Object.assign({}, process.env, { FL_NO_OPEN: '1' }),
  windowsHide: true
})
child.unref()

try {
  fs.writeFileSync(path.join(DATA_DIR, 'panel.pid'), String(child.pid), 'utf8')
} catch {}
log(`面板未在监听，已拉起 pid=${child.pid}`)
process.exit(0)
