import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './config.js'

const FILE = path.join(DATA_DIR, 'groups.json')
const MAX = 500

/** id → { id, name, members, at } */
const map = new Map()
let writeTimer = null
let dirty = false

function loadFile () {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    const arr = Array.isArray(j) ? j : (j && Array.isArray(j.groups) ? j.groups : [])
    for (const g of arr) {
      const id = String((g && g.id) || '').trim()
      if (!id) continue
      map.set(id, {
        id,
        name: String((g && g.name) || ''),
        members: Number((g && g.members) || 0) || 0,
        at: Number((g && g.at) || 0) || 0
      })
    }
  } catch {}
}
loadFile()

function flush () {
  writeTimer = null
  if (!dirty) return
  dirty = false
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
    const arr = Array.from(map.values()).sort((a, b) => b.at - a.at).slice(0, MAX)
    fs.writeFileSync(FILE, JSON.stringify(arr, null, 1), 'utf8')
  } catch {}
}

function schedule () {
  dirty = true
  if (writeTimer) return
  writeTimer = setTimeout(flush, 1500)
  if (writeTimer.unref) writeTimer.unref()
}

/**
 * 从一条真实群消息里学群名。
 * 名字为空时只记群号（有总比没有强），已有名字不覆盖成空。
 */
export function learn (id, name, members) {
  const gid = String(id || '').trim()
  if (!gid) return null
  const nm = String(name || '').trim()
  const cur = map.get(gid) || { id: gid, name: '', members: 0, at: 0 }
  if (nm) cur.name = nm
  const m = Number(members) || 0
  if (m) cur.members = m
  cur.at = Date.now()
  map.set(gid, cur)
  if (map.size > MAX) {
    /* 超出上限就按最后活跃时间淘汰最旧的一批，避免文件无限长 */
    const keep = Array.from(map.values()).sort((a, b) => b.at - a.at).slice(0, MAX)
    map.clear()
    for (const g of keep) map.set(g.id, g)
  }
  schedule()
  return cur
}

/** 当前目录（按最近活跃排序） */
export function list () {
  return Array.from(map.values()).sort((a, b) => b.at - a.at).map((g) => ({
    id: g.id, name: g.name, members: g.members
  }))
}

/**
 * 内存目录 + 内核列表合并：内核字段优先（人数/名字），本地的只做补全。
 * @param {Array<{id:string,name:string,members:number}>} remote
 */
export function merge (remote) {
  const arr = Array.isArray(remote) ? remote : []
  for (const g of arr) {
    const id = String((g && g.id) || '').trim()
    if (!id) continue
    learn(id, (g && g.name) || '', (g && g.members) || 0)
  }
  /* 有名字的排前面，其次按最近活跃；前端会再按输入过滤 */
  return list().sort((a, b) => (b.name ? 1 : 0) - (a.name ? 1 : 0))
}

/** 测试/诊断用 */
export function size () {
  return map.size
}
