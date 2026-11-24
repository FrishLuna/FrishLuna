#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/* 用 fileURLToPath 而不是 new URL().pathname：路径里有中文目录时
   pathname 会返回 %E6%96%87 这种百分号编码，readdir 直接读不到东西。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 永不扫描的目录：依赖、工具链、本机私有备份 */
const SKIP_DIRS = new Set(['node_modules', 'toolchain', 'vendor', 'dist', '_private', '.git', '.shots', '.browser-check', 'probe', '.archive'])
/** 二进制后缀：跳过文本匹配（仍然会被体积规则检查） */
const BIN_EXT = new Set(['.dll', '.exe', '.lib', '.pdb', '.node', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.zip', '.7z', '.mp4', '.woff', '.woff2', '.ttf'])

/** 文档与示例里约定俗成的假号码，报出来只会淹掉真命中 */
const SAMPLE_NUMBERS = new Set(['123456789', '1234567890', '1000000000', '1000000001', '1000000002', '1000000003', '1000000004', '10000000000',
  /* 连号/降序等一眼可判的构造值：selftest 里用作 group_id / uin 断言，不是真号 */
  '987654321', '777777777', '999999999'])

const RULES = [
  {
    id: 'token',
    label: '凭据/令牌',
    /* 不用 i 标志：下面要用 [A-Z] / [a-z] 区分大小写，带上 i 就分不出来了 */
    re: /(fl_[0-9a-f]{6,}|[Bb]earer\s+[A-Za-z0-9._-]{16,}|[0-9a-f]{40,}|(?=[a-z0-9?!*^]{16}(?![a-z0-9?!*^]))(?=[a-z0-9]*[?!*^])[a-z0-9?!*^]{16}|\b(?=[A-Za-z0-9]{16}\b)(?=[A-Za-z0-9]*[A-Z])(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{16}\b)/g,
    /* 40 位十六进制多半是 git 提交号：出现在 URL、或前后一行提到「提交/commit/GPL」就放过；
       测试文件里的定长十六进制是合成向量，不是凭据；
       16 字符 API 名（如 writeBigUInt64BE）会被大小写启发式误伤，点号调用/带括号调用的放过 */
    skip: (raw, ctx, rel) => /[0-9a-f]{40,}/i.test(raw) &&
      (/https?:\/\//.test(ctx) || /(提交|commit|revision|sha|GPL)/i.test(ctx) || /\.test\.(ts|mjs|js)$/.test(rel)) ||
      (/^[A-Za-z][A-Za-z0-9]*$/.test(raw) && (ctx.includes('.' + raw) || ctx.includes(raw + '(')))
  },
  {
    id: 'path',
    label: '本机绝对路径',
    /* C:\Users\xxx、D:\<任意目录>、/home/<user>/ —— 会暴露盘符结构与用户名 */
    re: /\b[A-Za-z]:\\(?:Users\\[^\\\s"'`]+|[^\\\s"'`]{2,40}\\)|\/home\/[a-z0-9_-]{2,}\//gi,
    /* 已脱敏的占位符（<用户>、…、xxxx、***）不是泄漏，别再报一次 */
    skip: (raw) => /<[^>]*>|\.{3,}|x{3,}|\*{2,}/.test(raw)
  },
  {
    id: 'qq',
    label: '疑似 QQ 号/群号',
    /* 只认「带上下文」的数字：前后 12 字符内出现群/好友/uin/peer/QQ/target 才报 */
    re: /(?:(?:群|好友|账号|uin|peer|qq|QQ|target|group_id|user_id)[^\n]{0,12}?\b(\d{6,12})\b)|(?:\b(\d{6,12})\b[^\n]{0,12}?(?:群|好友|账号|uin|peer))/g,
    group: 1
  },
  {
    id: 'talk',
    label: '对话残留（注释里的沟通痕迹）',
    re: /(用户(要求|说|让|反馈|提出|指定|点名)|老板|甲方|按你说的|你说要|别搞|搞坏|上次说|上一轮|任务书|提示词|我确认|11\.11|11月11)/g
  },
  {
    id: 'nick',
    label: '群名/昵称痕迹',
    /* 日志式行：「群 xxx 昵称: 内容」 */
    re: /群\s*\d{6,12}\s+[^\s:：]{1,20}[:：]/g
  }
]

function mask (s) {
  const t = String(s)
  if (t.length <= 6) return t[0] + '***'
  return t.slice(0, 3) + '***' + t.slice(-2)
}

function listFiles (dir, acc = []) {
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return acc }
  for (const e of ents) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      listFiles(path.join(dir, e.name), acc)
    } else if (e.isFile()) {
      acc.push(path.join(dir, e.name))
    }
  }
  return acc
}

function stagedFiles () {
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], { cwd: ROOT, encoding: 'utf8' })
  return out.split('\n').map((s) => s.trim()).filter(Boolean).map((p) => path.join(ROOT, p))
}

const onlyStaged = process.argv.includes('--staged')
const files = onlyStaged ? stagedFiles() : listFiles(ROOT)

/* 这些路径是「本机运行时」：本来就该被 .gitignore 挡掉，命中只作提示，不计入失败。
   它们仍然会被整包压缩带走，所以发布时要么用 git，要么先手工删掉。 */
const PRIVATE_PREFIXES = ['app/data/', 'data/', '_private/']

const hits = []
const notes = []
let scanned = 0

for (const f of files) {
  const ext = path.extname(f).toLowerCase()
  const rel = path.relative(ROOT, f).replace(/\\/g, '/')
  if (rel === 'tools/privacy-scan.mjs') continue       // 规则表自己不算命中
  if (rel === '.env') continue                         // 令牌存储（盐+哈希+密文），已在 .gitignore，本身就该有密文
  if (BIN_EXT.has(ext)) continue

  let st
  try { st = fs.statSync(f) } catch { continue }
  if (st.size > 2 * 1024 * 1024) {
    hits.push({ file: rel, line: 0, rule: 'size', text: `${(st.size / 1048576).toFixed(1)} MB，确认是否需要发布` })
    continue
  }

  let text
  try { text = fs.readFileSync(f, 'utf8') } catch { continue }
  if (text.includes('\u0000')) continue               // 二进制伪装的文本，跳过
  scanned++

  const lines = text.split(/\r?\n/)
  for (const rule of RULES) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      rule.re.lastIndex = 0
      let m
      while ((m = rule.re.exec(line)) !== null) {
        const raw = rule.group ? m[rule.group] : m[0]
        if (!raw) continue
        if (SAMPLE_NUMBERS.has(raw)) continue
        if (rule.skip && rule.skip(raw, lines.slice(Math.max(0, i - 1), i + 2).join(' '), rel)) continue
        const isPrivate = PRIVATE_PREFIXES.some((p) => rel.startsWith(p))
        const item = { file: rel, line: i + 1, rule: rule.id, label: rule.label, text: mask(raw) }
        if (isPrivate) notes.push(item); else hits.push(item)
        if (rule.re.lastIndex === m.index) rule.re.lastIndex++   // 零宽匹配保护
      }
    }
  }
}

const byRule = hits.reduce((a, h) => { a[h.rule] = (a[h.rule] || 0) + 1; return a }, {})

if (notes.length) {
  console.log(`本机运行时文件里有 ${notes.length} 处敏感值（已在 .gitignore，不会进 git，但别整包压缩上传）：`)
  for (const n of notes.slice(0, 20)) console.log(`  ${n.file}:${n.line}  [${n.rule}]  ${n.text}`)
  console.log('')
}

if (!hits.length) {
  console.log(`干净：扫描 ${scanned} 个文本文件，0 命中。`)
  process.exit(0)
}

console.log(`扫描 ${scanned} 个文本文件，命中 ${hits.length} 处：`)
for (const [k, v] of Object.entries(byRule)) console.log(`  · ${k.padEnd(6)} ${v}`)
console.log('')
for (const h of hits.slice(0, 200)) {
  console.log(`${h.file}:${h.line}  [${h.rule}]  ${h.text}`)
}
if (hits.length > 200) console.log(`… 另有 ${hits.length - 200} 处未列出`)
console.log('')
console.log('处理建议：凭据/路径改成占位符，QQ 号换成 1000000001 这类示例值，日志移出仓库。')
process.exit(1)
