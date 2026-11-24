import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { load, qqDir, INJECTOR_DIR, ROOT } from './config.js'
import * as bus from './bus.js'

const execFileP = promisify(execFile)
const PIPE_PREFIX = 'frishluna.'

let launching = false
let lastLaunchAt = 0

/* ESM 命名空间对象是 frozen 的，不能往上挂字段；用模块内变量存探针结果 */
let lastProbe = { running: false, pid: 0, pipes: [], at: 0 }
export function getProbe () { return lastProbe }
export function setProbe (p) { lastProbe = p }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 列出现有 frishluna.* 命名管道，用来判断注入是否完成 */
export function listPipes () {
  try {
    return fs.readdirSync('\\\\.\\pipe\\').filter((n) => String(n).startsWith(PIPE_PREFIX))
  } catch {
    return []
  }
}

export function pipesFor (pid) {
  return listPipes().filter((n) => String(n).includes('.' + pid + '.'))
}

/** 从管道名直接解析已注入的 pid，不启动任何子进程（零黑窗） */
export function pidsFromPipes () {
  const out = new Set()
  for (const n of listPipes()) {
    const m = /^frishluna\.(\d+)\./.exec(String(n))
    if (m) out.add(Number(m[1]))
  }
  return [...out]
}

/** 进程存活检测，零子进程（Windows 上 EPERM 也表示存在） */
export function isAlive (pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch (e) { return e && e.code === 'EPERM' }
}

/** QQ 主进程（排除 --type=renderer/gpu/utility 这些子进程） */
export async function listMainPids () {
  const ps = [
    'Get-CimInstance Win32_Process -Filter "Name=\'QQ.exe\'"',
    '| Where-Object { $_.CommandLine -notmatch "--type=" }',
    '| Select-Object -ExpandProperty ProcessId'
  ].join(' ')
  try {
    const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000
    })
    return String(stdout).split(/\s+/).filter((x) => /^\d+$/.test(x)).map(Number)
  } catch {
    return []
  }
}

export async function mainPid () {
  const pids = await listMainPids()
  return pids.length ? pids[pids.length - 1] : 0
}

export async function isRunning () {
  return (await listMainPids()).length > 0
}

/** 等某个 pid 的管道出现 */
export async function waitPipes (pid, timeoutMs = 40000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (pipesFor(pid).length >= 2) return true
    await sleep(400)
  }
  return false
}

function capture (child, tag) {
  const onData = (buf) => {
    String(buf).split(/\r?\n/).forEach((line) => {
      const s = line.trim()
      if (!s) return
      // 注入脚本的中文输出直接转进面板日志
      if (/^\[!!\]|错误|失败|FAIL/i.test(s)) bus.error(tag, s)
      else if (/^\[ok\]|成功|success/i.test(s)) bus.ok(tag, s)
      else bus.info(tag, s)
    })
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)
}

function runPython (args, tag) {
  return new Promise((resolve) => {
    const cfg = load()
    const py = process.env.FRISH_PYTHON || 'python'
    bus.info(tag, `$ ${py} ${args.map((a) => path.basename(a)).join(' ')}`)
    const child = spawn(py, args, {
      cwd: INJECTOR_DIR,
      windowsHide: true,
      env: Object.assign({}, process.env, {
        PYTHONIOENCODING: 'utf-8',
        FL_QQ_EXE: cfg.qqExe
      })
    })
    let out = ''
    child.stdout?.on('data', (b) => { out += String(b) })
    child.stderr?.on('data', (b) => { out += String(b) })
    capture(child, tag)
    child.on('error', (e) => {
      bus.error(tag, '无法启动 Python: ' + e.message + '（需要系统 PATH 里有 python）')
      resolve({ code: -1, out })
    })
    child.on('close', (code) => resolve({ code: code ?? -1, out }))
  })
}

/** 向已存在的进程注入指定 dll（默认注入 FrishLuna 自己的 payload） */
export async function inject (pid, tag = 'inject', dllPath) {
  if (!pid) return { ok: false, msg: '没有目标 pid' }
  const dll = dllPath || path.join(ROOT, 'payload', 'frishluna-payload.dll')
  if (!fs.existsSync(dll)) {
    bus.error(tag, '找不到 dll: ' + dll)
    return { ok: false, msg: 'dll 缺失' }
  }
  bus.info(tag, '正在连接 QQ…')
  const r = await runPython([path.join(INJECTOR_DIR, 'inject.py'), '--pid', String(pid), '--dll', dll], tag)
  const okp = await waitPipes(pid, 15000)
  if (okp) bus.ok(tag, '连接成功')
  else bus.error(tag, '连接未成功，详见上方日志')
  return { ok: okp, pid, code: r.code }
}

/** 正常启动原生 QQ（客户端完整可用）后注入 */
async function launchClient () {
  const cfg = load()
  if (!fs.existsSync(cfg.qqExe)) {
    bus.error('qq', 'QQ 路径不存在: ' + cfg.qqExe)
    return { ok: false, msg: 'QQ 路径不存在' }
  }
  bus.info('qq', '启动原生 QQ 客户端…')
  const child = spawn(cfg.qqExe, [], { cwd: qqDir(), detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()

  // 等主进程出现
  let pid = 0
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    pid = await mainPid()
    if (pid) break
  }
  if (!pid) {
    bus.error('qq', '等不到 QQ 主进程')
    return { ok: false, msg: 'QQ 没起来' }
  }
  bus.ok('qq', `QQ 主进程 pid=${pid}，等它完成登录再注入…`)
  await sleep(7000)                     // 让 QQ 自己登录、建窗口，避免注入过早
  return inject(pid, 'qq')
}

export async function launch () {
  if (launching) return { ok: false, msg: '正在启动中，请稍候' }
  if (Date.now() - lastLaunchAt < 4000) return { ok: false, msg: '操作太频繁' }
  launching = true
  lastLaunchAt = Date.now()
  try {
    /* 多账号：机器上可能同时开着好几个 QQ（每个账号一个进程），
       已注入的跳过，没注入的逐个注入。 */
    const running = await listMainPids()
    if (running.length) {
      const injected = pidsFromPipes()
      const todo = running.filter((p) => !injected.includes(p))
      if (!todo.length) {
        bus.ok('qq', `QQ 已在运行且已注入（${running.length} 个进程）`)
        return { ok: true, msg: `已注入 ${running.length} 个 QQ 进程` }
      }
      let okCount = 0
      for (const p of todo) {
        bus.info('qq', `QQ 已在运行（pid ${p}），直接注入`)
        const r = await inject(p, 'qq')
        if (r.ok) okCount++
      }
      return { ok: okCount > 0, msg: `注入 ${okCount}/${todo.length} 个进程` }
    }
    return await launchClient()
  } finally {
    launching = false
  }
}

export async function kill () {
  const pids = await listMainPids()
  if (!pids.length) {
    bus.warn('qq', 'QQ 没有在运行')
    return { ok: true, msg: '本来就没运行' }
  }
  bus.warn('qq', `结束 QQ 进程树（${pids.length} 个：${pids.join(', ')}）…`)
  for (const pid of pids) {
    await new Promise((resolve) => {
      /* 按 pid 结束，不用 /IM QQ.exe：后者会连带杀掉机器上其它 QQ 实例，
         日志里报的 pid 也会和实际被杀的对象对不上。 */
      const c = spawn('taskkill', ['/PID', String(pid), '/F', '/T'], { windowsHide: true })
      c.on('close', resolve)
      c.on('error', resolve)
    })
  }
  await sleep(1200)
  const still = await isRunning()
  if (still) bus.error('qq', '仍有 QQ 进程残留')
  else bus.ok('qq', 'QQ 已关闭')
  return { ok: !still }
}

export async function restart () {
  await kill()
  await sleep(800)
  return launch()
}
