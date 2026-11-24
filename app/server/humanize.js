/** op → 中文名（日志里用） */
const OP_LABEL = {
  send: '发消息',
  recall: '撤回',
  emojiLike: '表情回应',
  poke: '戳一戳',
  like: '名片赞',
  groupList: '群列表',
  groupMembers: '群成员',
  recentList: '最近会话',
  friendList: '好友列表',
  groupMute: '禁言',
  groupMuteAll: '全员禁言',
  groupKick: '移出成员',
  groupSetAdmin: '设管理员',
  groupCard: '改群名片',
  groupName: '改群名',
  groupAnnounce: '群公告',
  profileSet: '改昵称/签名',
  selfInfo: '本号信息',
  services: '服务可用性',
  qzoneList: '读说说列表',
  qzoneDetail: '读说说详情',
  qzoneFeeds: '读好友动态',
  qzonePublish: '发说说',
  qzoneDelete: '删说说',
  qzoneLike: '空间点赞',
  qzoneComment: '评论说说',
  qzoneBlack: '空间拉黑',
  qzoneCookies: '空间 cookie 诊断',
  aiCharacters: 'AI 语音角色',
  aiVoice: 'AI 语音合成',
  albumList: '读群相册列表',
  albumUpload: '群相册传图'
}

const clip = (s, n = 40) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

/** op 的中文名 */
export function opLabel (op) {
  return OP_LABEL[op] || String(op || '')
}

const ARG_FMT = {
  send: (a) => [
    a.type === 'group' ? `群 ${a.id}` : `好友 ${a.id}`,
    `内容 ${String(a.text || '').length} 字${a.text ? '：' + clip(a.text, 30) : ''}`
  ],
  poke: (a) => [
    a.type === 'group' ? `群 ${a.id}` : '私聊',
    `戳 ${a.uid}`
  ],
  recall: (a) => [`消息 ${a.msgId}`],
  emojiLike: (a) => [`消息 ${a.msgId}`, `表情 ${a.code || 128077}`],
  like: (a) => [`好友 ${a.uid}`, `${Number(a.count) || 1} 次`],
  groupMembers: (a) => [`群 ${a.id}`],
  groupMute: (a) => [
    `群 ${a.id}`, `成员 ${a.uid}`,
    Number(a.seconds) > 0 ? `禁言 ${Number(a.seconds)} 秒` : '解除禁言'
  ],
  groupMuteAll: (a) => [`群 ${a.id}`, a.on ? '开启全员禁言' : '关闭全员禁言'],
  groupKick: (a) => [`群 ${a.id}`, `移出 ${a.uid}`, a.reject ? '并拒绝再加群' : ''],
  groupSetAdmin: (a) => [`群 ${a.id}`, a.on ? `设为管理员 ${a.uid}` : `取消管理员 ${a.uid}`],
  groupCard: (a) => [`群 ${a.id}`, `成员 ${a.uid}`, `新名片 ${a.card ? clip(a.card, 20) : '（清空）'}`],
  groupName: (a) => [`群 ${a.id}`, `新群名 ${clip(a.name, 20)}`],
  groupAnnounce: (a) => [`群 ${a.id}`, `公告 ${String(a.text || '').length} 字：${clip(a.text, 30)}`],
  profileSet: (a) => [a.nick ? `昵称 ${clip(a.nick, 20)}` : '', a.sign ? `签名 ${clip(a.sign, 20)}` : '']
}

/** 调用参数 → 一句中文（日志「调用 戳一戳 · 群 91 · 戳 3516」） */
export function fmtArgs (op, args) {
  const a = args || {}
  const fn = ARG_FMT[op]
  const parts = fn ? fn(a) : Object.keys(a).map((k) => `${k}=${clip(a[k], 24)}`)
  return parts.filter((x) => x !== '').join(' · ')
}

const FIELD_LABEL = {
  uin: 'QQ', uid: 'UID', nick: '昵称', fromGroup: '来源群',
  online: '在线', good: '状态正常', version: '版本', app_name: '程序',
  group_id: '群号', group_name: '群名', member_count: '人数',
  user_id: 'QQ', card: '名片', nickname: '昵称', remark: '备注',
  message_id: '消息 ID', qq: 'QQ', name: '名称', count: '数量',
  index: '序号', chat_type: '类型', send_time: '时间',
  status: '服务状态', login: '登录账号', protocol: '协议'
}

const MAX_ITEMS = 12

/** 列表项 → 一行人话（群：群名 + 群号 + 人数；好友：昵称 + QQ；成员：uid 尾号） */
function itemLine (it) {
  if (it == null) return ''
  if (typeof it !== 'object') return `· ${clip(it, 80)}`
  const gid = String(it.group_id || it.groupCode || it.chat_id || '')
  const qq = String(it.user_id || it.uin || it.qq || '')
  const uid = String(it.uid || '')
  const name = String(it.group_name || it.groupName || it.peerName || it.card || it.cardName ||
    it.nickname || it.nick || it.remark || '')
  const count = Number(it.member_count || it.memberCount || 0)
  if (gid) return `· ${clip(name || '群 ' + gid, 30)}  ${gid}${count ? ' · ' + count + ' 人' : ''}`
  if (qq) return `· ${clip(name || 'QQ ' + qq, 30)}  ${qq}`
  if (uid || it.index !== undefined) {
    return `· ${name ? clip(name, 30) + '  ' : ''}${uid ? 'uid …' + uid.slice(-10) : ''}` +
      (it.index !== undefined ? '  #' + it.index : '')
  }
  return `· ${clip(name || JSON.stringify(it), 80)}`
}

function objLines (o, depth = 0) {
  const out = []
  const indent = '  '.repeat(depth)
  for (const k of Object.keys(o || {})) {
    const v = o[k]
    if (v == null || v === '') continue
    const label = FIELD_LABEL[k] || k
    if (typeof v === 'object') {
      /* payload 有时把一段多行文本塞进 {text}，展开成人话 */
      if (typeof v.text === 'string' && v.text.trim()) {
        out.push(`${indent}${label}：`)
        v.text.split('\n').slice(0, 12).forEach((l) => out.push(`${indent}  ${clip(l, 120)}`))
      } else if (v.failed) {
        out.push(`${indent}${label}：不可用（${clip(v.error || '未知原因', 60)}）`)
      } else if (depth < 1) {
        out.push(...objLines(v, depth + 1).map((l) => `${indent}${label} · ${l.trim()}`))
      }
      continue
    }
    out.push(`${indent}${label}：${clip(v, 60)}`)
    if (out.length > 18) break
  }
  return out.slice(0, 18)
}

function rawLines (raw) {
  const s = String(raw == null ? '' : raw).trim()
  if (!s) return []
  if (/^[[{]/.test(s)) {
    try {
      const j = JSON.parse(s)
      if (Array.isArray(j)) {
        if (!j.length) return ['（空列表）']
        return [`共 ${j.length} 条`].concat(j.slice(0, MAX_ITEMS).map(itemLine).filter(Boolean))
      }
      return objLines(j)
    } catch { /* 不是完整 JSON，按文本处理 */ }
  }
  return s.split('\n').slice(0, 14).map((x) => clip(x, 200))
}

/**
 * 调用结果 → 行数组（面板「执行日志流」逐行显示）
 * @param {string} op
 * @param {{ok?:boolean,msg?:string,list?:any[],data?:any,ret?:string,error?:string}} r
 */
export function fmtResult (op, r) {
  if (!r) return ['没有返回']
  const out = []
  if (r.msg) out.push(String(r.msg))

  if (Array.isArray(r.list)) {
    const n = r.list.length
    /* msg 里已经写了数量（「群目录（105 个群）」）就不再重复一行 */
    if (!(r.msg && String(r.msg).includes(String(n)))) out.push(`共 ${n} 个`)
    r.list.slice(0, MAX_ITEMS).forEach((it) => {
      const line = itemLine(it)
      if (line) out.push(line)
    })
    if (n > MAX_ITEMS) out.push(`… 还有 ${n - MAX_ITEMS} 个`)
  } else if (r.data != null) {
    if (typeof r.data === 'object') out.push(...objLines(r.data))
    else out.push(clip(r.data, 200))
  }

  if (r.ret != null && String(r.ret) !== '') {
    /* ret 是内核原始回执：能整理就整理，整理不出东西才原样带回 */
    const extra = rawLines(r.ret).filter((l) => !out.includes(l))
    if (extra.length) out.push(...extra)
  }
  if (r.error) out.push('错误：' + clip(r.error, 200))
  return out.length ? out : ['（没有内容）']
}

/** 一行版结果（写进控制台日志用）：成功取首行，失败取错误 */
export function oneLine (op, r) {
  const lines = fmtResult(op, r)
  const first = lines.find((l) => l && !/^共 \d+ 个/.test(l)) || lines[0] || ''
  return clip(first, 160)
}
