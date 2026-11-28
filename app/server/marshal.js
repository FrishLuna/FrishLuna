/* 多账号后每个账号自建 Bridge：必须走 accounts 的门面，
   不能再用 pipe.js 里那个没人 attach 的单例（connected 永远 false） */
import { bridge } from './accounts.js'

let seq = 0
const pending = new Map()

/** bridge 'event' 分流入口：返回 true 表示这条回执被消费 */
export function onEvent (ev) {
  if (!ev || (ev.evt !== 'kop-ok' && ev.evt !== 'kop-err')) return false
  const p = pending.get(Number(ev.seq))
  if (!p) return false
  pending.delete(Number(ev.seq))
  clearTimeout(p.timer)
  p.resolve(ev)
  return true
}

/**
 * 发一条封送请求。
 * @param {object} body {op:'probe|find|validate|peek|call|gate', rva?, vt?, inst?, slot?, args?, sret?, kind?, rtti?}
 * @param {number} [timeoutMs=20000] probe 要扫全地址空间，给足时间
 */
export function op (body, timeoutMs = 20000) {
  if (!bridge.connected) return Promise.resolve({ evt: 'kop-err', why: '通道未连接（QQ 未运行或未注入）' })
  seq += 1
  const my = seq
  /* 受保护字段放最后：body 里的 cmd/seq 不能覆盖服务端分配的序号 */
  const req = { ...body, cmd: 'kop', seq: my }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(my)
      resolve({ evt: 'kop-err', seq: my, why: `kop 回执超时（${timeoutMs}ms）` })
    }, timeoutMs)
    pending.set(my, { resolve, timer })
    const ok = bridge.send(req)
    if (!ok) {
      pending.delete(my)
      clearTimeout(timer)
      resolve({ evt: 'kop-err', seq: my, why: 'cmd 管道写入失败' })
    }
  })
}

export function status () {
  return { pending: pending.size, seq }
}
