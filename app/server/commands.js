import { load } from './config.js'

export const VERSION = '0.1.1'

function fmtUptime (sec) {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  if (d) return `${d}天 ${h}小时 ${m}分钟`
  if (h) return `${h}小时 ${m}分钟`
  if (m) return `${m}分钟 ${s}秒`
  return `${s}秒`
}

/** 平台串：process.platform-process.arch，如 win32-x64 */
function platformText () {
  return `${process.platform}-${process.arch}`
}

/** 状态卡：四行固定格式，群聊与面板共用同一份文本 */
export function statusText () {
  return [
    'FrishLuna 状态',
    `版本: ${VERSION}`,
    `平台: ${platformText()}`,
    `运行时长: ${fmtUptime(process.uptime())}`
  ].join('\n')
}

/** 当前配置的前缀（设置页可改） */
export function prefixText () {
  return load().cmdPrefix || '#fl'
}

/**
 * 把一条群消息规范成「可判定的文本」：
 *   - 全角 ＃ 与全角字母统一成半角
 *   - 只 trim，**不剥 @**：`@机器人 #fl` 在文本里就是 `@123456 #fl`，
 *     与 `#fl` 不全等，因此不触发（@ 了就不算）。
 */
export function normalizeText (text) {
  let t = String(text == null ? '' : text)
  t = t.replace(/\uFF03/g, '#')                       // ＃
  t = t.replace(/[\uFF21-\uFF3A\uFF41-\uFF5A]/g, (c) => {
    const code = c.charCodeAt(0) - 0xFEE0
    return String.fromCharCode(code)
  })
  return t.trim()
}

/**
 * 这条消息要不要回状态卡。
 * 只吃文本，不吃发送者 —— 没有 uin 参数，也就没有白名单可判。
 *
 * normalize 之后【全等】才算命中。
 * 因此 `#fl status` / `#fl info` / `#fl help` 这类带参数的写法一律不响应，
 * 也不存在"参数被忽略但仍回卡"的中间态。
 */
export function matchTrigger (text, prefix) {
  const t = normalizeText(text).toLowerCase()
  const p = String(prefix || prefixText()).trim().toLowerCase()
  if (!p) return false
  return t === p
}

/**
 * 消息是不是「单段纯文本」。`message.length !== 1` 就直接 false：
 *   - `#fl` + 图片 / 语音 / 卡片 / 引用 都不算触发
 *   - 没有类型信息（面板调用、旧事件）时按纯文本处理
 *   - `unknown` 放行：内核里 at 元素常常没有 elementType，但它的文本是 `@123456`，
 *     现在 normalizeText 不剥 @，所以 `@机器人 #fl` 依然不会命中（判定留在文本层面）。
 * @param {Array<number|string>|undefined} rawTypes inbound 上报的元素类型号
 */
export function isPureText (rawTypes) {
  if (!Array.isArray(rawTypes) || rawTypes.length === 0) return true
  return rawTypes.every((t) => t === 1 || t === 'text' || t === 'unknown')
}

/**
 * 执行一次触发。
 * 只有「整条就是前缀」才回卡；其余一律 ok:false 且文本为空 —— 静默，
 * 不给「你参数写错了」这类提示，也不回退成"忽略参数照回"。
 * @param {string} raw
 * @param {{source?:'web'|'qq', uin?:string, uid?:string}} [ctx]
 */
export async function execute (raw, ctx) {
  void ctx
  if (!matchTrigger(raw, prefixText())) return { ok: false, text: '' }
  return { ok: true, text: statusText() }
}

/** /api/commands 用：子命令已全部移除 */
export function listCommands () {
  return []
}
