/**
 * 平台差异集中在这里：Windows 走命名管道，Linux 走 unix domain socket。
 * 面板其余代码不再直接出现平台判断。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ROOT } from './config.js'

const execFileP = promisify(execFile)

/* FL_PLATFORM 只给自测用：在 Windows 上模拟 Linux 路径，验证 socket 传输 */
const FORCED = (process.env.FL_PLATFORM || '').toLowerCase()
export const PLATFORM = FORCED === 'linux' || FORCED === 'windows'
  ? FORCED
  : (process.platform === 'win32' ? 'windows' : (process.platform === 'linux' ? 'linux' : process.platform))
export const IS_WIN = PLATFORM === 'windows'
export const IS_LINUX = PLATFORM === 'linux'

/** 目录名里带平台，发布包与运行目录一眼能分清 */
export const PLATFORM_TAG = IS_WIN ? 'windows-x64' : (IS_LINUX ? 'linux-x64' : PLATFORM)

const PIPE_PREFIX = 'frishluna.'
const SOCK_PREFIX = 'frishluna-'

/** Linux 下两个 socket 的存放目录：优先 XDG_RUNTIME_DIR（0700、随会话清理） */
export function runtimeDir () {
  if (!IS_LINUX) return ''
  const custom = process.env.FL_RUNTIME_DIR
  if (custom) return custom
  const xdg = process.env.XDG_RUNTIME_DIR
  if (xdg && fs.existsSync(xdg)) return path.join(xdg, 'frishluna')
  return path.join(os.tmpdir(), `frishluna-${process.getuid ? process.getuid() : 0}`)
}

/** which: 'evt' 上行事件 / 'cmd' 下行命令 */
export function pipePath (pid, which) {
  if (IS_LINUX) return path.join(runtimeDir(), `${SOCK_PREFIX}${pid}.${which}.sock`)
  return `\\\\.\\pipe\\frishluna.${pid}.${which}`
}

/**
 * 已存在的桥接端点名（Windows 是管道名，Linux 是 socket 文件名）。
 * 用来判断「这个 QQ 进程注入完了没有」，不启动任何子进程。
 */
export function listBridgeEntries () {
  try {
    if (IS_LINUX) {
      return fs.readdirSync(runtimeDir())
        .filter((n) => n.startsWith(SOCK_PREFIX) && n.endsWith('.evt.sock'))
    }
    return fs.readdirSync('\\\\.\\pipe\\').filter((n) => String(n).startsWith(PIPE_PREFIX))
  } catch {
    return []
  }
}

/** 从端点名解析出已注入的 pid */
export function pidsFromBridge () {
  const out = new Set()
  for (const n of listBridgeEntries()) {
    const m = IS_LINUX ? /^frishluna-(\d+)\.evt\.sock$/.exec(n) : /^frishluna\.(\d+)\./.exec(n)
    if (m) out.add(Number(m[1]))
  }
  return [...out]
}

/** 某个 pid 的端点是否齐了（两条都在才算通） */
export function bridgesFor (pid) {
  const entries = listBridgeEntries()
  return IS_LINUX
    ? entries.filter((n) => n.startsWith(`${SOCK_PREFIX}${pid}.`))
    : entries.filter((n) => String(n).includes('.' + pid + '.'))
}

/** 建 socket 目录（0700：同机其他用户看不到也连不上） */
export function ensureRuntimeDir () {
  if (!IS_LINUX) return
  const d = runtimeDir()
  try {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 })
    fs.chmodSync(d, 0o700)
  } catch {}
}

/** 进程内载荷：Windows 是 dll，Linux 是 so */
export function payloadLib () {
  return IS_LINUX
    ? path.join(ROOT, 'payload', 'libfrishluna-payload.so')
    : path.join(ROOT, 'payload', 'frishluna-payload.dll')
}

/** 注入脚本 */
export function injectorScript () {
  return IS_LINUX
    ? path.join(ROOT, 'injector', 'linux', 'inject.py')
    : path.join(ROOT, 'injector', 'inject.py')
}

/** 没有配置 QQ 路径时的候选位置 */
export function qqExeCandidates () {
  if (IS_LINUX) {
    const list = [
      '/opt/QQ/qq',
      '/usr/bin/qq',
      '/usr/local/bin/qq',
      '/opt/linuxqq/qq',
      '/snap/bin/qq'
    ]
    try {
      const home = os.homedir()
      list.push(path.join(home, 'Applications/QQ.AppImage'))
    } catch {}
    return list.filter((p) => { try { return fs.existsSync(p) } catch { return false } })
  }
  const list = [
    'C:\\Program Files\\Tencent\\QQNT\\QQ.exe',
    'C:\\Program Files (x86)\\Tencent\\QQNT\\QQ.exe'
  ]
  return list.filter((p) => { try { return fs.existsSync(p) } catch { return false } })
}

/* ---------------- 进程发现 ---------------- */

function readProcCmdline (pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    return raw.split('\u0000').filter((s) => s.length > 0)
  } catch {
    return null
  }
}

const LINUX_QQ_NAMES = new Set(['qq', 'linuxqq', 'QQ', 'qqapp'])

/** QQ 主进程（排除 --type=renderer / gpu / utility 这些子进程） */
export async function listMainPids () {
  if (IS_LINUX) {
    const out = []
    let names = []
    try { names = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)) } catch { return [] }
    for (const n of names) {
      const argv = readProcCmdline(n)
      if (!argv || !argv.length) continue
      const exe = path.basename(argv[0])
      const isQQ = LINUX_QQ_NAMES.has(exe) || /(^|\/)qq$/i.test(argv[0]) || /qq\.appimage$/i.test(exe)
      if (!isQQ) continue
      /* 子进程（渲染器 / GPU / 工具进程）都带 --type=，只留主进程 */
      if (argv.some((a) => a.startsWith('--type='))) continue
      out.push(Number(n))
    }
    return out.sort((a, b) => a - b)
  }
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

/** 结束单个 QQ 进程（按 pid，不按名字：同机多开时不会误杀别人） */
export function killPid (pid, { graceMs = 1200 } = {}) {
  return new Promise((resolve) => {
    if (!pid) return resolve(true)
    if (IS_LINUX) {
      try { process.kill(pid, 'SIGTERM') } catch { return resolve(true) }
      const t0 = Date.now()
      const tick = setInterval(() => {
        let alive = true
        try { process.kill(pid, 0) } catch { alive = false }
        if (!alive) { clearInterval(tick); resolve(true); return }
        if (Date.now() - t0 > graceMs) {
          try { process.kill(pid, 'SIGKILL') } catch {}
          clearInterval(tick)
          resolve(true)
        }
      }, 150)
      return
    }
    const c = execFile('taskkill', ['/PID', String(pid), '/F', '/T'], { windowsHide: true }, () => resolve(true))
    c.on('error', () => resolve(true))
  })
}

/* ---------------- 帧格式 ---------------- */

/**
 * 下行命令的帧：Windows 是裸 JSON（一条一次 ReadFile），
 * Linux 流式 socket 必须有边界，所以加 4 字节小端长度前缀（与上行同格式）。
 */
export function encodeCmd (text) {
  if (!IS_LINUX) return Buffer.from(text, 'utf8')
  const body = Buffer.from(text, 'utf8')
  const head = Buffer.allocUnsafe(4)
  head.writeUInt32LE(body.length, 0)
  return Buffer.concat([head, body])
}

/** 平台标识，给状态页与日志用 */
export function describe () {
  return {
    platform: PLATFORM,
    os: `${os.type()} ${os.release()}`,
    tag: PLATFORM_TAG,
    runtimeDir: IS_LINUX ? runtimeDir() : '',
    payload: payloadLib()
  }
}
