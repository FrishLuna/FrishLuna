
const UNSUPPORTED_PLACEHOLDER = {
  picElement: 'image',
  videoElement: 'video',
  fileElement: 'file',
  pttElement: 'record',
  markdownElement: 'markdown',
  arkElement: 'json',
  multiForwardMsgElement: 'forward',
  calendarElement: 'calendar',
  marketFaceElement: 'mface',
  walletElement: 'wallet',
  grayTipElement: 'gray_tip',
  structLongMsgElement: 'long_msg',
  faceElement: 'face',
  replyElement: 'reply'
}

/** 内核单个 element → OneBot 11 段。认不出的给 [未知类型:x] 占位，绝不丢段。 */
function kernelElementToSegment (el) {
  if (!el || typeof el !== 'object') return null
  if (el.textElement && typeof el.textElement.content === 'string') {
    const t = el.textElement
    if (Number(t.atType) > 0) {
      const target = Number(t.atType) === 1 ? (t.atNtUid || t.atUid || '') : 'all'
      return { type: 'at', data: { qq: Number(t.atType) === 2 ? 'all' : target } }
    }
    return { type: 'text', data: { text: t.content } }
  }
  if (el.picElement) {
    const p = el.picElement
    return { type: 'image', data: { file: p.url || p.sourcePath || p.md5HexStr || '', url: p.url || '' } }
  }
  if (el.faceElement) {
    const f = el.faceElement
    return { type: 'face', data: { id: String(f.faceIndex ?? f.faceId ?? '') } }
  }
  if (el.pttElement) {
    const p = el.pttElement
    return { type: 'record', data: { file: p.url || '', file_uuid: p.fileUuid || undefined, md5: p.md5HexStr || undefined } }
  }
  if (el.videoElement) return { type: 'video', data: { file: el.videoElement.url || '' } }
  if (el.fileElement) {
    const f = el.fileElement
    return { type: 'file', data: { file_id: String(f.fileId ?? ''), name: f.fileName || '' } }
  }
  if (el.arkElement) return { type: 'json', data: { data: el.arkElement.toJson || '' } }
  // 兜底：报类型名，不静默丢
  const kind = UNSUPPORTED_PLACEHOLDER[Object.keys(el).find((k) => k.endsWith('Element')) || ''] || 'unknown'
  return { type: 'text', data: { text: `[${kind}]` } }
}

/**
 * 内核消息对象 → OneBot 11 message 事件。
 * @param {object} msg 内核推送的单条消息（msgId/peerUid/chatType/senderUid/elements…）
 * @param {object} deps { toOneBotId(kernelMsgId)->int32, toQq(uid)->qq|null, selfId:number }
 * @returns {object|null} OneBot 11 事件；peer 解析不了返回 null（调用方记日志）
 */
export function toMessageEvent (msg, deps) {
  if (!msg) return null
  const elements = msg.msgElements || msg.elements || []
  const message = elements.map(kernelElementToSegment).filter(Boolean)
  const raw = message.map((s) => s.type === 'text' ? s.data.text
    : s.type === 'at' ? `@${s.data.qq}` : `[${s.type}]`).join('')
  const isGroup = Number(msg.chatType) === 2
  /* 入站自带真 QQ 号就直接用，别依赖 uidmap 是否已经学到这条映射 */
  const userQq = Number(msg.senderUin) > 0
    ? Number(msg.senderUin)
    : (deps.toQq ? deps.toQq(msg.senderUid) : null)
  if (!isGroup && userQq === null) return null // 私聊必须能反查到 QQ 号，否则事件无主
  return {
    post_type: 'message',
    message_type: isGroup ? 'group' : 'private',
    self_id: deps.selfId,
    time: Math.floor((Number(msg.msgTime) || 0) / 1000) || Math.floor(Date.now() / 1000),
    message_id: deps.toOneBotId(msg.msgId, {
      peer: String(isGroup ? (msg.peerUid || '') : (msg.senderUid || '')),
      chatType: isGroup ? 2 : 1
    }),
    user_id: userQq,
    group_id: isGroup ? Number(msg.peerUid) : undefined,
    message,
    raw_message: raw,
    font: 0,
    sender: {
      user_id: userQq,
      nickname: msg.sendMemberName || msg.sendNickName || '',
      card: isGroup ? (msg.sendMemberName || '') : undefined,
      role: msg.role === undefined ? undefined : (Number(msg.role) >= 3 ? 'admin' : Number(msg.role) === 2 ? 'owner' : 'member')
    }
  }
}

/** 内核撤回 → notice.group_recall。msgList 内取 msgId（取不到返回 null）。 */
export function toRecallEvent (args, deps) {
  const list = Array.isArray(args) ? args
    : Array.isArray(args?.msgList) ? args.msgList
      : Array.isArray(args?.[0]?.msgList) ? args[0].msgList : []
  const first = list[0]
  if (!first || !first.msgId) return null
  const isGroup = Number(first.chatType) === 2
  return {
    post_type: 'notice',
    notice_type: isGroup ? 'group_recall' : 'friend_recall',
    self_id: deps.selfId,
    time: Math.floor(Date.now() / 1000),
    group_id: isGroup ? Number(first.peerUid) : undefined,
    user_id: deps.toQq ? deps.toQq(first.operatorUid || first.senderUid) : null,
    message_id: deps.toOneBotId(first.msgId)
  }
}

/** 戳一戳 → notice.notify.poke */
export function toPokeEvent (n, deps) {
  if (!n) return null
  return {
    post_type: 'notice',
    notice_type: 'notify',
    sub_type: 'poke',
    self_id: deps.selfId,
    time: Math.floor(Date.now() / 1000),
    group_id: n.group_id,
    user_id: n.operator_id ?? n.user_id,
    target_id: n.target_id
  }
}

/**
 * 事件观察层（watch.js）归一化结果 → OneBot 11 notice / request。
 * @param {object} w { kind, group, user, operator, sub_type, card_new, card_old, file, comment, flag, at }
 * @returns {object|null} 不认识的 kind 返回 null（绝不瞎猜成别的事件）
 */
export function toWatchNotice (w) {
  if (!w || !w.kind) return null
  const t = Math.floor((Number(w.at) || Date.now()) / 1000)
  const gid = Number(w.group) || 0
  const uid = Number(w.user) || 0
  const op = Number(w.operator) || 0
  const head = { self_id: Number(w.selfId) || 0, time: t }
  switch (w.kind) {
    case 'group_increase':
      return { post_type: 'notice', notice_type: 'group_increase', ...head, sub_type: w.sub_type || 'approve', group_id: gid, user_id: uid, operator_id: op || uid }
    case 'group_decrease':
      return { post_type: 'notice', notice_type: 'group_decrease', ...head, sub_type: w.sub_type || 'leave', group_id: gid, user_id: uid, operator_id: op || uid }
    case 'group_admin':
      return { post_type: 'notice', notice_type: 'group_admin', ...head, sub_type: w.sub_type || 'set', group_id: gid, user_id: uid }
    case 'group_card':
      return { post_type: 'notice', notice_type: 'group_card', ...head, group_id: gid, user_id: uid, card_new: String(w.card_new || ''), card_old: String(w.card_old || '') }
    case 'group_upload':
      return {
        post_type: 'notice',
        notice_type: 'group_upload',
        ...head,
        group_id: gid,
        user_id: uid,
        file: {
          id: String(w.fileId || ''),
          name: String(w.name || ''),
          size: Number(w.size) || 0,
          busid: Number(w.busid) || 0
        }
      }
    case 'essence':
      return { post_type: 'notice', notice_type: 'essence', ...head, sub_type: w.sub_type || 'add', group_id: gid, sender_id: uid, operator_id: op, message_id: w.message_id ?? 0 }
    case 'friend_request':
      return { post_type: 'request', request_type: 'friend', ...head, user_id: uid, comment: String(w.comment || ''), flag: String(w.flag || '') }
    case 'group_request':
      return { post_type: 'request', request_type: 'group', ...head, sub_type: w.sub_type || 'add', group_id: gid, user_id: uid, comment: String(w.comment || ''), flag: String(w.flag || '') }
    default:
      return null
  }
}

export function toLifecycleEvent (selfId) {
  return { post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect', self_id: selfId, time: Math.floor(Date.now() / 1000) }
}

export function toHeartbeatEvent (selfId, intervalMs) {
  return { post_type: 'meta_event', meta_event_type: 'heartbeat', self_id: selfId, time: Math.floor(Date.now() / 1000), interval: intervalMs }
}

/**
 * OneBot message 段数组（或纯字符串）→ 内核 msgElements。
 * 只支持已验证可行的部分；不支持的显式抛错，绝不静默降级成纯文本。
 * @throws {Error} 段类型不支持或缺参
 */
export function toKernelElements (message) {
  const segs = typeof message === 'string' ? [{ type: 'text', data: { text: message } }]
    : Array.isArray(message) ? message : []
  if (!segs.length) throw new Error('消息内容为空')
  const out = []
  for (const seg of segs) {
    const d = seg && seg.data ? seg.data : {}
    switch (seg && seg.type) {
      case 'text':
        if (!d.text) throw new Error('text 段内容为空')
        out.push({ elementType: 1, textElement: { content: String(d.text), atType: 0, atUid: '', atTinyId: '', atNtUid: '' } })
        break
      case 'at': {
        if (String(d.qq) === 'all') {
          out.push({ elementType: 1, textElement: { content: '@全体成员', atType: 2, atUid: '', atTinyId: '', atNtUid: '' } })
        } else {
          if (!/^\d{5,12}$/.test(String(d.qq))) throw new Error('at 段的 qq 必须是 5~12 位纯数字')
          out.push({ elementType: 1, textElement: { content: '@' + d.qq, atType: 1, atUid: '', atTinyId: '', atNtUid: String(d.qq) } })
        }
        break
      }
      case 'face':
        out.push({ elementType: 6, faceElement: { faceIndex: Number(d.id) || 0, faceType: 1, faceText: '', faceId: Number(d.id) || 0 } })
        break
      default:
        throw new Error(`暂不支持的段类型：${(seg && seg.type) || '空'}（内核媒体上传通道未验证，不支持伪装成文本发送）`)
    }
  }
  return out
}

/** 辅助：从段数组抽纯文本（供日志/回显，不参与发送） */
export function segmentsText (message) {
  const segs = typeof message === 'string' ? [{ type: 'text', data: { text: message } }] : (message || [])
  return segs.map((s) => s && s.type === 'text' ? String(s.data?.text || '') : `[${s?.type || '?'}]`).join('')
}
