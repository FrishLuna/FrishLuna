import * as store from './store.js'

const LIMIT = 4096

/** 双向 LRU：正向 id→msgId，反向 msgId→id */
let fwd = new Map()
let rev = new Map()
/** OneBot id → { peer, chatType }：撤回/表情回应要知道「这条消息在哪个会话」 */
let meta = new Map()
let counter = 0
let restored = false

function lruTouch (m, k, v) {
  if (m.has(k)) m.delete(k)
  m.set(k, v)
  while (m.size > LIMIT) {
    const first = m.keys().next().value
    m.delete(first)
  }
}

/** 一次性把库里的映射灌回内存（懒执行，避免模块加载期就开库） */
function restore () {
  if (restored) return
  restored = true
  try {
    counter = store.maxMsgIdId()
    for (const r of store.recentMsgIds(LIMIT).reverse()) {
      const id = Number(r.id)
      const kid = String(r.kernelId || '')
      if (!id || !kid) continue
      lruTouch(fwd, id, kid)
      lruTouch(rev, kid, id)
      meta.set(kid, { peer: String(r.peer || ''), chatType: Number(r.chatType) || 1 })
    }
  } catch { /* 库不可用就纯内存跑 */ }
}

/**
 * 内核 msgId（字符串）→ OneBot int32。
 * @param {string|number} kernelMsgId
 * @param {{peer?:string, chatType?:number, account?:string}} [info] 会话信息（撤回/贴表情要用）
 * @returns {number}
 */
export function toOneBotId (kernelMsgId, info) {
  restore()
  const key = String(kernelMsgId)
  if (info && (info.peer || info.chatType)) {
    meta.set(key, { peer: String(info.peer || ''), chatType: Number(info.chatType) || 1 })
    while (meta.size > LIMIT) meta.delete(meta.keys().next().value)
  }
  if (rev.has(key)) {
    const id = rev.get(key)
    lruTouch(fwd, id, key)
    lruTouch(rev, key, id)
    return id
  }
  /* 号由库分配（自增主键），保证重启后不回退、不撞号；库不可用时退回内存计数器 */
  const dbId = store.putMsgId(key, info && info.peer, info && info.chatType, info && info.account)
  let id = Number(dbId) || 0
  if (!id) {
    counter += 1
    if (counter > 2147483647) counter = 1 // int32 上限回绕：仅当单进程发满 21 亿条
    id = counter
  } else if (id > counter) {
    counter = id
  }
  lruTouch(fwd, id, key)
  lruTouch(rev, key, id)
  return id
}

/**
 * OneBot id → 内核 msgId；不在表内（含重启后且库里也没有）返回 null。
 * @returns {string | null}
 */
export function toKernelId (onebotId) {
  restore()
  const key = Number(onebotId)
  if (!Number.isInteger(key)) return null
  const v = fwd.get(key)
  if (v === undefined) return null
  lruTouch(fwd, key, v)
  lruTouch(rev, v, key)
  return v
}

/** 当前占用条数（自测用） */
export function size () {
  restore()
  return fwd.size
}

/**
 * 这条 OneBot 消息 id 属于哪个会话（撤回/贴表情时补上 peer）。
 * @returns {{peer:string, chatType:number} | null}
 */
export function metaOf (onebotId) {
  const kid = toKernelId(onebotId)
  if (kid === null) return null
  return meta.get(kid) || null
}

/** 清空内存表（重启语义；仅测试与重置时用，不删库） */
export function reset () {
  fwd = new Map()
  rev = new Map()
  meta = new Map()
  counter = 0
  restored = false
}
