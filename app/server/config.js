import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '..', '..')          // FrishLuna/
export const APP_DIR = path.join(ROOT, 'app')
export const DATA_DIR = path.join(APP_DIR, 'data')
export const WEB_DIR = path.join(APP_DIR, 'web')
export const PAYLOAD_DIR = path.join(ROOT, 'payload')
export const INJECTOR_DIR = path.join(ROOT, 'injector')
export const CFG_FILE = path.join(DATA_DIR, 'config.json')

export const DEFAULTS = {
  port: 5701,
  host: '127.0.0.1',
  /** QQ 可执行文件路径。留空则面板只显示「未设置」，需要在设置页手动选择 */
  qqExe: '',
  /** 打开面板时自动确保 QQ 在跑并注入（运行方式恒为「原生客户端 + 旁挂注入」） */
  autoStartQQ: true,
  autoInject: true,
  /** 命令前缀 */
  cmdPrefix: '#fl',
  /**
   * 禁止发送的群号（只拦「发」，收消息照常）。
   * 用来防手滑往不该打扰的群发东西，默认为空，自己按需填。
   */
  blockedGroups: [],
  theme: 'dark',
  /** 内置 OneBot v11 协议端（onebot-server.js）：HTTP/WS 端口、令牌、反向 WS 列表 */
  obServerPort: 5760,
  obServerToken: '',
  obServerReverse: [],
  obServerPost: [],
  /* 网络矩阵：每类可挂多个连接（新配置，旧字段兼容保留） */
  obNetwork: { httpServers: [], wsServers: [], wsClients: [], httpClients: [] }
  /** 访问令牌不在这里：见 data/auth.json（首次启动生成，打印到控制台） */
}

let cache = null

export function ensureDirs () {
  for (const d of [DATA_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }) } catch {}
  }
}

export function load () {
  if (cache) return cache
  ensureDirs()
  let raw = null
  try { raw = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) } catch {}
  cache = Object.assign({}, DEFAULTS, raw || {})
  // blockedGroups 允许写成数字/字符串混排，统一成字符串
  cache.blockedGroups = (cache.blockedGroups || []).map((x) => String(x).trim()).filter(Boolean)
  cache.port = Number(cache.port) || DEFAULTS.port
  return cache
}

export function save (patch) {
  const cur = load()
  const next = Object.assign({}, cur, patch || {})
  next.blockedGroups = (next.blockedGroups || []).map((x) => String(x).trim()).filter(Boolean)
  next.port = Number(next.port) || DEFAULTS.port
  ensureDirs()
  // 原地写：截断后覆盖，不产生额外的临时文件
  let fd
  try {
    fd = fs.openSync(CFG_FILE, 'w')
    fs.writeFileSync(fd, JSON.stringify(next, null, 2), 'utf8')
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd) } catch {}
  }
  cache = next
  return next
}

export function qqDir () {
  const exe = load().qqExe
  return path.dirname(exe)
}
