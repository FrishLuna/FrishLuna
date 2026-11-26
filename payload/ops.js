(function () {
  if (globalThis.__fl_ops) return
  var OPS = {}
  globalThis.__fl_ops = OPS

  function emit (o) { try { __fl_emit(JSON.stringify(o)) } catch (e) {} }

  globalThis.__fl_ops_meta = [
    { group: 'msg', name: 'send', desc: '发文本消息' },
    { group: 'msg', name: 'recall', desc: '撤回消息' },
    { group: 'msg', name: 'emojiLike', desc: '表情回应' },
    { group: 'msg', name: 'getMsgs', desc: '群最近消息' },
    { group: 'msg', name: 'getMsg', desc: '按消息 ID 获取一条' },
    { group: 'msg', name: 'msgHistory', desc: '历史消息' },
    { group: 'msg', name: 'recentList', desc: '最近会话' },
    { group: 'group', name: 'essenceList', desc: '精华列表' },
    { group: 'group', name: 'essenceAdd', desc: '设精华' },
    { group: 'group', name: 'essenceDel', desc: '取消精华' },
    { group: 'group', name: 'groupNotify', desc: '群通知/申请' },
    { group: 'group', name: 'albumMain', desc: '群相册主页' },
    { group: 'touch', name: 'poke', desc: '戳一戳' },
    { group: 'touch', name: 'like', desc: '名片赞' },
    { group: 'group', name: 'groupList', desc: '群列表' },
    { group: 'group', name: 'groupMembers', desc: '群成员' },
    { group: 'group', name: 'groupMute', desc: '单人禁言' },
    { group: 'group', name: 'groupMuteAll', desc: '全员禁言' },
    { group: 'group', name: 'groupKick', desc: '移出群' },
    { group: 'group', name: 'groupSetAdmin', desc: '设/取消管理' },
    { group: 'group', name: 'groupCard', desc: '改群名片' },
    { group: 'group', name: 'groupName', desc: '改群名' },
    { group: 'group', name: 'groupAnnounce', desc: '群公告' },
    { group: 'account', name: 'friendList', desc: '好友列表' },
    { group: 'account', name: 'profileSet', desc: '改昵称/签名' },
    { group: 'account', name: 'selfInfo', desc: '登录账号信息' },
    { group: 'diag', name: 'services', desc: '服务可用性' }
  ]

  function needSession () {
    var s = globalThis.__fl_session
    /* 注入那一刻本体可能还没建 session；每次调用都再解析一次，拿到就用 */
    if (!s && typeof globalThis.__fl_resolve_session === 'function') {
      try { s = globalThis.__fl_resolve_session() } catch (e) {}
    }
    if (!s) {
      throw new Error('QQ 尚未登录完成，请进入主界面后再试')
    }
    return s
  }

  function svc (getter) {
    var s = needSession()
    var f = s[getter]
    if (typeof f !== 'function') throw new Error('session 没有 ' + getter + '()')
    var v = f.call(s)
    if (!v) throw new Error(getter + 'QQ 尚未登录，请在主界面登录完成后重试')
    return v
  }

  function list (x) {
    if (!x) return []
    if (Array.isArray(x)) return x
    if (typeof x.forEach === 'function') {
      var out = []
      try { x.forEach(function (v) { out.push(v) }) } catch (e) {}
      return out
    }
    if (typeof x === 'object') return Object.keys(x).map(function (k) { return x[k] })
    return []
  }

  var MAX_STR = 600

  /** 取值白名单：对象一律 JSON 序列化（String(obj) 会变成 "[object Object]"），并截断 */
  function pick (o, keys) {
    var r = {}
    if (!o) return r
    keys.forEach(function (k) {
      try {
        var v = o[k]
        if (v === undefined || v === null || v === '') return
        if (typeof v === 'object') {
          var s
          try { s = JSON.stringify(v) } catch (e) { s = '[无法序列化]' }
          r[k] = s.length > MAX_STR ? s.slice(0, MAX_STR) + '…' : s
        } else {
          r[k] = v
        }
      } catch (e) {}
    })
    return r
  }

  /** 调试开关：globalThis.__fl_debug（true/false）或注入前 export FL_DEBUG=1，默认关 */
  function debugOn () {
    try {
      if (typeof globalThis.__fl_debug === 'boolean') return globalThis.__fl_debug
      if (typeof process !== 'undefined' && process.env && process.env.FL_DEBUG === '1') return true
    } catch (e) {}
    return false
  }
  function dbg (tag, o) { if (debugOn()) emit({ evt: 'dbg', tag: tag, o: o }) }

  /* 返回值判定
   * 内核接口用「result 码」表达失败，不抛异常：
   *   result === 0   成功
   *   result === 5   内核没接受（参数合法但当前 session 没有可用收发上下文）
   *   其它数字       原样带回
   * 历史上「只要不抛就算成功」是假成功的根源，这里统一判 0。
   * 老接口返回 void/true/无返回对象 —— 没有码可判，按成功算。
   */
  function codeOf (r) {
    if (!r || typeof r !== 'object') return null
    if (typeof r.result === 'number') return { code: r.result, msg: String(r.errMsg || r.message || '') }
    if (typeof r.errCode === 'number') return { code: r.errCode, msg: String(r.errMsg || r.message || '') }
    return null
  }

  function codeError (label, c) {
    var e
    if (c.code === 5) {
      e = new Error(label + '：QQ 拒绝了该操作，请稍后重试' + (c.msg ? ' · ' + c.msg : ''))
    } else {
      e = new Error(label + '：result=' + c.code + (c.msg ? ' · ' + c.msg : ''))
    }
    e.code = c.code
    return e
  }

  function check (label, r) {
    var c = codeOf(r)
    if (!c || c.code === 0) return r
    throw codeError(label, c)
  }

  function msgOf (e) { return e && e.message ? e.message : String(e) }

  /* OIDB 发包（0xED3 戳一戳用）
   * 9.9.36 的 ms.sendNudge 在旁挂 session 上恒回 -1，真戳得走 OIDB 0xED3_1。
   * 字段号逐字节核对：
   *   信封 base : 1 command, 2 subCommand, 3 errorCode, 4 body(bytes), 5 errorMsg, 12 reserved
   *   请求体    : 1 uin, 2 groupUin, 5 friendUin, 6 ext
   * 真包定标：群戳 = 19 字节，好友戳 = 13 字节，
   *   由此反推：默认值（0 / 空串 / ext）一律不写，写多了长度就对不上。
   * body 放 3 号字段会被服务端按 errorCode 解 → 每次都 145。
   */
  function pbVarint (n) {
    var out = []
    var v = Number(n)
    if (!isFinite(v) || v < 0) v = 0
    while (v >= 128) {
      out.push((v % 128) + 128)          /* 用 % 而非 & ：QQ 号常超过 2^31，位运算会溢出 */
      v = Math.floor(v / 128)
    }
    out.push(v)
    return out
  }

  function pbTag (field, wire) { return pbVarint(Number(field) * 8 + Number(wire)) }

  /* varint 字段；值为 0 或空时不写（protobuf 默认值口径，长度才对得上真包） */
  function pbUInt (field, n) {
    var v = Number(n)
    if (n == null || !isFinite(v) || v === 0) return []
    return pbTag(field, 0).concat(pbVarint(v))
  }

  function pbBytes (field, arr) {
    return pbTag(field, 2).concat(pbVarint(arr.length), arr)
  }

  function pbString (field, s) {
    var str = String(s == null ? '' : s)
    if (!str) return []
    var a = []
    for (var i = 0; i < str.length; i++) a.push(str.charCodeAt(i) & 0xff)
    return pbBytes(field, a)
  }

  /** OIDB 信封字节数组（数组，不是 Uint8Array，方便单测逐字节比） */
  function oidbEnvelope (cmd, sub, bodyArr, reserved) {
    var out = pbUInt(1, cmd).concat(pbUInt(2, sub))
    if (bodyArr && bodyArr.length) out = out.concat(pbBytes(4, bodyArr))
    if (reserved) out = out.concat(pbUInt(12, reserved))
    return out
  }

  /** 0xED3 请求体：群聊 {1:目标uin, 2:群号}；私聊 {1:对方uin, 5:对方uin} */
  function oidbPokeBody (o) {
    var b = pbUInt(1, o.targetUin)
    if (o.isGroup) return b.concat(pbUInt(2, o.peerUin))
    return b.concat(pbUInt(5, o.peerUin))
  }

  function hexOf (arr) {
    var s = ''
    for (var i = 0; i < arr.length; i++) {
      var h = (arr[i] & 0xff).toString(16).toUpperCase()
      s += (h.length < 2 ? '0' + h : h) + (i === arr.length - 1 ? '' : ' ')
    }
    return s
  }

  /* 给探测脚本复用：保证「探的包」和「产品发的包」是同一份代码 */
  globalThis.__fl_oidb = {
    envelope: oidbEnvelope,
    pokeBody: oidbPokeBody,
    hex: hexOf,
    build: function (cmdName, cmd, sub, bodyArr, reserved) {
      return { cmd: cmdName, bytes: oidbEnvelope(cmd, sub, bodyArr, reserved), hex: hexOf(oidbEnvelope(cmd, sub, bodyArr, reserved)) }
    },
    send: function (cmdName, cmd, sub, bodyArr, reserved) {
      var ms = svc('getMsgService')
      if (typeof ms.sendSsoCmdReqByContend !== 'function') {
        throw new Error('当前 QQ 版本暂不支持此操作')
      }
      var bytes = Uint8Array.from(oidbEnvelope(cmd, sub, bodyArr, reserved || 0))
      return Promise.resolve(ms.sendSsoCmdReqByContend(cmdName, bytes))
    }
  }

  /**
   * 依次试几种调用形态，返回 Promise（结果文本 / 抛错）。
   * 同步抛错、异步 result!=0、异步 reject 都算这种形态不成立，换下一种。
   * 绝不吞异步失败 —— 假回执的根源就是「发出去了就报成功」。
   * mapper(result) 负责把成功结果转成给用户看的文本。
   */
  /* 内核拒绝码 → 人话（面板直接显示这句，不再甩 "#0 #1" 这种调试腔） */
  var CODE_HINT = {
    '-1': 'QQ 拒绝了该操作，请检查权限或参数',
    '-2': '操作失败：目标群或联系人不存在',
    '-100': '操作失败：参数无效或暂不支持',
    '5': '操作失败：QQ 会话未就绪，请稍后重试',
    '1': 'QQ 消息服务尚未准备好，请稍后重试',
    '116': '目标成员不在该群，或成员标识无效',
    '1281': '参数格式有误，QQ 无法识别该请求',
    '316': '成员标识无效，服务器拒绝了该请求'
  }

  function callVariants (label, fns, mapper) {
    var errs = []
    var codes = []
    var i = 0
    function step () {
      while (i < fns.length) {
        var idx = i++
        var v
        try { v = fns[idx]() } catch (e) { errs.push('#' + idx + ' ' + msgOf(e)); if (typeof e.code === 'number') codes.push(e.code); continue }
        if (v && typeof v.then === 'function') {
          return v.then(function (r) {
            try { check(label, r) } catch (e) {
              errs.push('#' + idx + ' ' + e.message)
              if (typeof e.code === 'number') codes.push(e.code)
              return step()
            }
            return mapper ? mapper(r, idx) : r
          }, function (e) {
            errs.push('#' + idx + ' ' + msgOf(e))
            if (e && typeof e.code === 'number') codes.push(e.code)
            return step()
          })
        }
        try { check(label, v) } catch (e) { errs.push('#' + idx + ' ' + e.message); if (typeof e.code === 'number') codes.push(e.code); continue }
        return Promise.resolve(mapper ? mapper(v, idx) : v)
      }
      var last = codes.length ? codes[codes.length - 1] : null
      var hint = last !== null && CODE_HINT[String(last)]
      var first = String(errs[0] || '').replace(/^#\d+\s+/, '')
      var e = new Error(label + ' 失败：' + (hint || first || 'QQ 未返回任何响应，请稍后重试'))
      e.codes = codes
      e.detail = errs.join(' | ').slice(0, 600)
      throw e
    }
    return step()
  }

  function asText (v) {
    if (v === undefined || v === null) return 'ok'
    if (typeof v === 'string') return v
    try { return JSON.stringify(v) } catch (e) { return String(v) }
  }

  /* 发送是全项目唯一一条写消息的路径（inbound 的 __fl_send 也只转发到这里）。

     sendMsg 契约（argc=4）：
       sendMsg('0', peer, msgElements, new Map())
         arg1  固定字符串 '0'（消息 ID 占位，内核自己分配）
         arg2  peer 对象 { chatType, peerUid, guildId }，guildId 要填本次生成的唯一 ID
         arg3  消息元素数组，不是整包消息对象
         arg4 属性表，必须是 Map 实例（不是普通对象）
       返回值 Promise → { result, errMsg }；成功只有 result === 0。
       整包消息放 arg1、回调放 arg2 时内核只回 result=5（拒绝，无 errMsg）。
  */
  function buildElements (text) {
    return [{
      elementType: 1,
      textElement: { content: text, atType: 0, atUid: '', atTinyId: '', atNtUid: '' }
    }]
  }

  /* 内核自增的消息唯一 ID：填进 body.guildId 随包发出去（内核按它配对回执）。
     注意：它不等于消息的 msgId —— 发完在会话历史里找不到这个值，
     所以只用来组包，不能当 message_id 回给面板。 */
  function genMsgId (ms, chatType) {
    try {
      var msf = needSession().getMSFService()
      var t = msf && msf.getServerTime ? msf.getServerTime() : Date.now()
      var id = ms.generateMsgUniqueId(chatType, t)
      if (id) return String(id)
    } catch (e) { dbg('genMsgId', e && e.message ? e.message : String(e)) }
    var r = '7'
    for (var i = 0; i < 18; i++) r += Math.floor(Math.random() * 10)
    return r
  }

  /* 发过消息就顺便认主：刚发出的消息必然在新翻到的几条里（sendType===1），
     从里面学到本号 uin/uid，回传 host 补 selfId（OneBot 事件与 AstrBot 的路由键）。 */
  function learnSelfAfterSend (ms, peer, chatType) {
    if (selfInfoCache) return
    try {
      var body = { chatType: chatType, peerUid: String(peer), guildId: '' }
      var p = ms.getMsgsIncludeSelf(body, '0', 5, true)
      if (!p || typeof p.then !== 'function') return
      p.then(function (r) {
        var arr = list(r && (r.msgList || r))
        for (var i = 0; i < arr.length; i++) {
          var m = arr[i]
          if (Number(m.sendType) === 1 && m.senderUin) {
            selfInfoCache = { uin: String(m.senderUin), uid: String(m.senderUid || ''), nick: String(m.sendNickName || ''), fromGroup: String(peer) }
            emit({ evt: 'self-info', uin: selfInfoCache.uin, uid: selfInfoCache.uid, nick: selfInfoCache.nick })
            return
          }
        }
      }, function () {}).catch(function () {})
    } catch (e) { /* 认主失败不影响发送 */ }
  }

  OPS.send = function (a) {
    var ms = svc('getMsgService')
    var isGroup = !!(a && a.type === 'group')
    /* 群聊 peerUid 就是群号；私聊 peerUid 必须是内核的 u_ uid，
       host 已经解析好放在 a.peer.peerUid（拿不到才退回 a.id） */
    var peerUid = isGroup ? '' : String((a && a.peer && a.peer.peerUid) || '')
    var peer = String((a && (isGroup ? a.id : (peerUid || a.id))) || '')
    var text = String((a && (a.text != null ? a.text : a.message)) || '')
    if (!peer) throw new Error('缺少目标（群号或好友号）')
    if (!text.trim()) throw new Error('消息内容为空（不能只发空格或换行）')

    var where = (isGroup ? '群 ' : '') + String((a && a.id) || peer)
    var chatType = isGroup ? 2 : 1
    var mid = genMsgId(ms, chatType)
    var body = { chatType: chatType, peerUid: peer, guildId: mid }
    var startAt = Date.now()

    dbg('send', { where: where, len: text.length, mid: mid })

    /* 发送回执的真 id：getLatestDbMsgs 是可用的通道，
       发完 5 秒内在最近 5 条里按「文本全等 + 时间在发送之后」找自己刚发的那条，
       取 msgSeq 最大的一条（同文连发也不会认错）。找不到就如实回 null，
       绝不拿旧消息的 id 冒充。 */
    function resolveSent () {
      return new Promise(function (res) {
        var to = setTimeout(function () { res(null) }, 5000)
        try {
          var p = ms.getLatestDbMsgs(body, 5)
          if (!p || typeof p.then !== 'function') { clearTimeout(to); return res(null) }
          p.then(function (r) {
            clearTimeout(to)
            var arr = list(r && r.msgList)
            var best = null
            for (var i = 0; i < arr.length; i++) {
              var m = arr[i]
              if (Number(m.recallTime || 0) > 0) continue
              var els = m.elements || []
              var txt = ''
              for (var j = 0; j < els.length; j++) {
                if (els[j] && els[j].textElement) txt += String(els[j].textElement.content || '')
              }
              var fresh = Number(m.msgTime || 0) * 1000 >= startAt - 3000
              if (txt.trim() === text.trim() && fresh) {
                if (!best || Number(m.msgSeq || 0) > Number(best.msgSeq || 0)) best = m
              }
            }
            res(best ? String(best.msgId) : null)
          }, function () { clearTimeout(to); res(null) })
        } catch (e) { clearTimeout(to); res(null) }
      })
    }

    function localSend () {
      return new Promise(function (resolve, reject) {
        function done (res) {
          var c = codeOf(res)
          if (!c) return reject(new Error('发送消息未收到响应（' + where + '）'))
          if (c.code === 0) {
            learnSelfAfterSend(ms, peer, chatType)
            /* 老注释作废（getMsgsIncludeSelf 空壳时代）：现在走 resolveSent 拿真 id。
               拿不到仍然 message_id: null —— 宁可不给不给错的。 */
            return resolveSent().then(function (kid) {
              resolve({ text: '已发送到 ' + where, message_id: kid })
            })
          }
          reject(codeError('发送到 ' + where + ' 失败', c))
        }
        var p
        try {
          p = ms.sendMsg('0', body, buildElements(text), new Map())
        } catch (e) {
          return reject(new Error('sendMsg 调用失败: ' + (e && e.message ? e.message : e)))
        }
        if (p && typeof p.then === 'function') {
          p.then(done, function (e) { reject(new Error('sendMsg 异常: ' + (e && e.message ? e.message : e))) })
        } else {
          done(p)
        }
      })
    }

    /* 私聊没有 uid 时本地 sendMsg 一定失败（peerUid 必须是 u_xxx），而 uid
       只有「对方主动发过消息」才学得到 —— 新好友第一次发只能如实报错，
       提示从成员列表选取或让对方先发一条消息。 */
    var noUid = !isGroup && !!(a && a.peer && typeof a.peer === 'object') && !/^u_/.test(peer)
    if (noUid) {
      throw new Error('私聊 ' + (a && a.id) + ' 需要成员标识：可直接从成员列表选取，或让对方先在群里发一条消息')
    }
    return localSend()
  }

  /* 发图片：上传与发送在 media.js 里（富媒体通道），这里只做转发 */
  OPS.sendImage = function (a) {
    var m = globalThis.__fl_media
    if (!m || typeof m.sendImage !== 'function') throw new Error('图片发送组件未就绪，请重新连接 QQ 后重试')
    return m.sendImage(a || {})
  }

  /* 发视频（NTV2 0x11EA/0x11E9 双子文件上传 + commonElem serviceType 48） */
  OPS.sendVideo = function (a) {
    var m = globalThis.__fl_media
    if (!m || typeof m.sendVideo !== 'function') throw new Error('视频发送组件未就绪，请重新连接 QQ 后重试')
    return m.sendVideo(a || {})
  }

  /* 群文件上传（0x6D6_0 申请 → Highway cmdId 71 → 0x6D9_4 publish） */
  OPS.uploadFile = function (a) {
    var m = globalThis.__fl_media
    if (!m || typeof m.uploadFile !== 'function') throw new Error('文件发送组件未就绪，请重新连接 QQ 后重试')
    return m.uploadFile(a || {})
  }

  /* 闪照 NT 原生通道（media.js）：picElement.isFlashPic=true 走内核 sendMsg */
  OPS.sendFlashNT = function (a) {
    var m = globalThis.__fl_media
    if (!m || typeof m.sendFlashNT !== 'function') throw new Error('图片发送组件未就绪，请重新连接 QQ 后重试')
    return m.sendFlashNT(a || {})
  }

  /* 富消息：文字/@/表情/图片/回复 一次发出（同样在 media.js） */
  OPS.sendRich = function (a) {
    var m = globalThis.__fl_media
    if (!m || typeof m.sendRich !== 'function') throw new Error('富文本消息组件未就绪，请重新连接 QQ 后重试')
    return m.sendRich(a || {})
  }

  /* 已读标记（内核 msgService 原生接口）。
     markRead: {type:'group'|'private', id, peerUid?}；markReadAll 无参。 */
  function markTimeout (p, ms) {
    return Promise.race([
      Promise.resolve(p),
      new Promise(function (_, rj) { setTimeout(function () { rj(new Error('标记已读超时')) }, ms || 8000) })
    ])
  }
  OPS.markRead = function (a) {
    var ms = svc('getMsgService')
    a = a || {}
    var isGroup = a.type !== 'private'
    var id = String(a.id || '')
    if (!id) throw new Error('需要目标（群号或好友标识）')
    var peer = isGroup
      ? { chatType: 2, peerUin: id, guildId: '' }
      : { chatType: 1, peerUid: String(a.peerUid || id), guildId: '' }
    return markTimeout(ms.setMsgRead(peer)).then(function (r) {
      if (Number(r && r.result) !== 0) throw new Error('标记已读失败：' + ((r && r.result) ?? '?') + ' ' + ((r && r.errMsg) || ''))
      return '已把会话标记为已读'
    })
  }

  OPS.markReadAll = function () {
    var ms = svc('getMsgService')
    return markTimeout(ms.setAllC2CAndGroupMsgRead()).then(function (r) {
      if (Number(r && r.result) !== 0) throw new Error('标记全部已读失败：' + ((r && r.result) ?? '?') + ' ' + ((r && r.errMsg) || ''))
      return '已把全部会话标记为已读'
    })
  }

  OPS.recall = function (a) {
    var ms = svc('getMsgService')
    var peer = String((a && a.id) || '')
    var msgId = String((a && a.msgId) || '')
    var chatType = (a && a.type === 'group') ? 2 : 1
    if (!peer || !msgId) throw new Error('需要目标 + 消息 ID')
    /* 可用形态：peer 对象 + 消息 ID 数组 */
    var body = { chatType: chatType, peerUid: peer, guildId: '' }
    /* 撤回不能假成功：recallMsg(peer,[msgId]) 真删，
       撤回后回读 recallTime 写入时间戳、subMsgType 变 4。
       仍保留两段校验：撤之前确认 id 真在会话里，撤之后再回读一次，还在就如实说没撤掉。 */
    /* getMsgsIncludeSelf 在这版内核恒回空（空壳），撤回前后校验不能靠它；
       getLatestDbMsgs(peer, n) 是真历史通道，用它，老接口留作兜底。 */
    function readRecent (n) {
      var body2 = { chatType: chatType, peerUid: peer, guildId: '' }
      return new Promise(function (res) {
        try {
          var p = ms.getLatestDbMsgs(body2, n)
          if (!p || typeof p.then !== 'function') return res(null)
          p.then(function (r) {
            var arr = list(r && r.msgList)
            if (arr.length) return res(arr)
            /* 空列表不算数：getLatestDbMsgs 也可能没赶上落库，退老通道再看一次 */
            try {
              var p2 = ms.getMsgsIncludeSelf(body2, '0', n, true)
              if (!p2 || typeof p2.then !== 'function') return res(arr)
              p2.then(function (r2) { res(list(r2 && (r2.msgList || r2)).length ? list(r2.msgList || r2) : arr) }, function () { res(arr) })
            } catch (e) { res(arr) }
          }, function () { res(null) })
        } catch (e) { res(null) }
      })
    }
    function stillThere () {
      return readRecent(30).then(function (arr) {
        if (!arr) return 'unknown'
        /* 空列表不能当「已删除」：读不到跟真删了长得一模一样。空 = 看不见，按 unknown 报。 */
        if (!arr.length) return 'unknown'
        for (var i = 0; i < arr.length; i++) {
          if (String(arr[i].msgId) === msgId) {
            var els = arr[i].elements || []
            /* 已撤回：recallTime 被内核写上时间戳（回读 recallTime 非零、subMsgType 变 4）。
               有它直接判 gone。 */
            if (arr[i].recallTime && Number(arr[i].recallTime) > 0) return 'gone'
            /* 只看「文本还在」会漏掉图片/卡片/文件：那些消息撤回失败时
               textElement 本来就不存在，会被误判成已删 —— 又变成假回执。
               所以只要有任一种实体内容还在，就算没撤掉。 */
            var alive = els.some(function (e) {
              if (!e) return false
              if (e.textElement) {
                var c = String(e.textElement.content || '')
                /* 撤掉后有些版本留一条「xx 撤回了一条消息」的提示，那不是原文。
                   只认这个句式，不能只判「含撤回二字」—— 正文里本来就可能出现
                   「撤回」（测试消息若名字里带「撤回」会被误判成已删）。 */
                return c.length > 0 && !/撤回了一条消息/.test(c)
              }
              return !!(e.picElement || e.videoElement || e.fileElement ||
                        e.arkElement || e.marketFaceElement || e.pttElement)
            })
            return alive ? 'in' : 'gone'
          }
        }
        return 'gone'
      })
    }
    return stillThere().then(function (pre) {
      /* 撤之前就找不到这条：可能是 id 给错了（比如发送时没拿到真 id）、
         或者早被删了 —— 两种情况都不该回「已撤回」。 */
      if (pre === 'unknown') {
        throw new Error('撤回失败：读取聊天记录超时，请在 QQ 客户端手动撤回 ' + msgId + ' 是否存在。请在 QQ 客户端手动撤回')
      }
      if (pre === 'gone') {
        throw new Error('会话里找不到 ID ' + msgId + '（可能不是本账号发送、已被删除，或消息过早），撤回未执行')
      }
      return callVariants('recallMsg', [
        function () { return ms.recallMsg(body, [msgId]) },
        function () { return ms.recallMsg(peer, [msgId]) }
      ], function () { return '已撤回 ' + msgId }).then(function (txt) {
        return new Promise(function (r) { setTimeout(r, 500) }).then(stillThere).then(function (st) {
          if (st === 'in') {
            throw new Error('撤回未生效：消息可能已超时，请在 QQ 客户端手动撤回')
          }
          if (st === 'unknown') {
            throw new Error('撤回状态未知：无法确认消息是否已删除，请在 QQ 客户端查看')
          }
          return txt
        })
      })
    })
  }

  /* 群/好友最近消息：getMsgsIncludeSelf 是可用的读历史通道（selfInfo 就靠它）。
     返回最近 N 条的 msgId + 摘要，撤回/表情回应要用真实内核 msgId 就从这里拿。 */
  OPS.getMsgs = function (a) {
    var ms = svc('getMsgService')
    var isGroup = String((a && a.type) || 'group') !== 'private'
    var peer = String((a && a.id) || '')
    var n = Math.max(1, Math.min(30, Number((a && a.count) || 10)))
    if (!peer) throw new Error('缺少群号 / 好友号')
    var body = { chatType: isGroup ? 2 : 1, peerUid: peer, guildId: '' }
    return new Promise(function (resolve, reject) {
      var p = null
      try { p = ms.getMsgsIncludeSelf(body, '0', n, true) } catch (e) { return reject(new Error('getMsgsIncludeSelf：' + (e && e.message))) }
      if (!p || typeof p.then !== 'function') return reject(new Error('获取聊天记录失败：QQ 暂无响应'))
      p.then(function (r) {
        var arr = list(r && (r.msgList || r))
        if (!arr.length) {
          var keys = ''
          try { keys = r && typeof r === 'object' ? Object.keys(r).join(',') : String(r) } catch (e) {}
          return resolve(JSON.stringify({ empty: true, result: r && r.result, errMsg: r && r.errMsg, keys: keys }))
        }
        var rows = arr.slice(0, n).map(function (m) {
          var els = m.elements || []
          var text = ''
          for (var i = 0; i < els.length; i++) {
            if (els[i] && els[i].textElement) text += String(els[i].textElement.content || '')
          }
          return {
            msgId: String(m.msgId || ''),
            msgSeq: String(m.msgSeq || ''),
            uin: String(m.senderUin || (m.senderUid && m.senderUid) || ''),
            uid: String(m.senderUid || ''),
            text: text.slice(0, 40)
          }
        })
        resolve(JSON.stringify(rows))
      }, function (e) { reject(new Error('获取聊天记录被拒绝：' + ((e && e.message) || e))) })
    })
  }

  /* 按 msgId 精确取一条（OneBot get_msg 的后端）。
     getMsgsByMsgId 必须传数组形态：单字符串恒回空列表。
     回第一条原始消息 JSON（elements 全量），宿主侧转 OneBot 段。 */
  OPS.getMsg = function (a) {
    var ms = svc('getMsgService')
    var isGroup = String((a && a.type) || 'group') !== 'private'
    var peer = String((a && a.id) || '')
    var msgId = String((a && a.msgId) || '')
    if (!peer || !msgId) throw new Error('需要目标和消息 ID')
    var body = { chatType: isGroup ? 2 : 1, peerUid: peer, guildId: '' }
    return new Promise(function (resolve, reject) {
      var p = null
      try { p = ms.getMsgsByMsgId(body, [msgId]) } catch (e) { return reject(new Error('getMsgsByMsgId：' + (e && e.message))) }
      if (!p || typeof p.then !== 'function') return reject(new Error('查询消息失败：QQ 暂无响应'))
      p.then(function (r) {
        var arr = list(r && r.msgList)
        if (!arr.length) return reject(new Error('未找到该消息：消息 ID ' + msgId + ' 消息不存在（可能过早、已被撤回或会话不匹配）'))
        resolve(JSON.stringify(arr[0]).slice(0, 60000))
      }, function (e) { reject(new Error('查询消息被拒绝：' + ((e && e.message) || e))) })
    })
  }

  /* 历史消息（OneBot get_group_msg_history / get_friend_msg_history 的后端）：
     getLatestDbMsgs 可用（真 msgId、真元素、真 uid），每条 elements 上限 8KB。 */
  OPS.msgHistory = function (a) {
    var ms = svc('getMsgService')
    var isGroup = String((a && a.type) || 'group') !== 'private'
    var peer = String((a && a.id) || '')
    var n = Math.max(1, Math.min(50, Number((a && a.count) || 20)))
    if (!peer) throw new Error('缺少群号 / 好友号')
    var body = { chatType: isGroup ? 2 : 1, peerUid: peer, guildId: '' }
    return new Promise(function (resolve, reject) {
      var p = null
      /* getLatestDbMsgs 不含自己发的消息（私聊回读闪照收据必须 includeSelf），
         统一走 getMsgsIncludeSelf(peer, 起始msgId, count, true) 四参形态 */
      try { p = ms.getMsgsIncludeSelf(body, String((a && a.msgId) || '0'), n, true) } catch (e) { return reject(new Error('getMsgsIncludeSelf：' + (e && e.message))) }
      if (!p || typeof p.then !== 'function') return reject(new Error('读取聊天记录失败：QQ 暂无响应'))
      p.then(function (r) {
        var arr = list(r && r.msgList)
        resolve(JSON.stringify(arr.slice(0, n).map(function (m) {
          return {
            msgId: String(m.msgId || ''),
            msgSeq: String(m.msgSeq || ''),
            msgRandom: String(m.msgRandom || ''),
            uid: String(m.senderUid || ''),
            uin: String(m.senderUin || ''),
            time: Number(m.msgTime || 0),
            recallTime: Number(m.recallTime || 0),
            /* 闪照签名位：MsgRecord.subMsgType & 8192（TCQT 防闪照逆向，8192=闪照 2=图片基底，C2C 专属） */
            subMsgType: Number(m.subMsgType || 0),
            sendType: Number(m.sendType || 0),
            chatType: Number(m.chatType || 0),
            elements: JSON.stringify(m.elements || []).slice(0, 8000)
          }
        })))
      }, function (e) { reject(new Error('读取聊天记录被拒绝：' + ((e && e.message) || e))) })
    })
  }

  /* 精华三件套：
     add/remove 参数形态 {groupCode, msgId, msgSeq, msgRandom} 是唯一能过的形态；
     msgSeq/msgRandom 进程内自己用 getMsgsByMsgId 回读补齐，调用方只要给群号 + msgId。 */
  function essenceParam (id, msgId) {
    var ms = svc('getMsgService')
    return new Promise(function (resolve, reject) {
      var p = null
      try { p = ms.getMsgsByMsgId({ chatType: 2, peerUid: id, guildId: '' }, [String(msgId)]) } catch (e) { return reject(new Error('回读消息失败：' + (e && e.message))) }
      p.then(function (r) {
        var m = list(r && r.msgList)[0]
        if (!m) return reject(new Error('msgId ' + msgId + ' 不在群 ' + id + ' 的聊天记录中'))
        resolve({ groupCode: String(id), msgId: String(m.msgId), msgSeq: String(m.msgSeq || ''), msgRandom: String(m.msgRandom || '') })
      }, function (e) { reject(new Error('读取消息被拒绝：' + ((e && e.message) || e))) })
    })
  }
  OPS.essenceAdd = function (a) {
    var gs = svc('getGroupService')
    var id = String((a && a.id) || '')
    var msgId = String((a && a.msgId) || '')
    if (!id || !msgId) throw new Error('需要群号与消息 ID')
    return essenceParam(id, msgId).then(function (param) {
      return new Promise(function (resolve, reject) {
        gs.addGroupEssence(param).then(function (r) {
          if (r && Number(r.errCode) === 0) return resolve('已设精华：群 ' + id + ' msgId ' + msgId)
          reject(new Error('设为精华消息失败：' + (r && r.errCode) + (r && r.result && r.result.wording ? '：' + r.result.wording : '') + '（可能原因：当前账号不是群主/管理员，或消息已过期）'))
        }, function (e) { reject(new Error('addGroupEssence：' + ((e && e.message) || e))) })
      })
    })
  }
  OPS.essenceDel = function (a) {
    var gs = svc('getGroupService')
    var id = String((a && a.id) || '')
    var msgId = String((a && a.msgId) || '')
    if (!id || !msgId) throw new Error('需要群号与消息 ID')
    return essenceParam(id, msgId).then(function (param) {
      return new Promise(function (resolve, reject) {
        gs.removeGroupEssence(param).then(function (r) {
          if (r && Number(r.errCode) === 0) return resolve('已取消精华：群 ' + id + ' msgId ' + msgId)
          reject(new Error('取消精华消息失败：' + (r && r.errCode) + (r && r.result && r.result.wording ? '：' + r.result.wording : '')))
        }, function (e) { reject(new Error('removeGroupEssence：' + ((e && e.message) || e))) })
      })
    })
  }
  OPS.essenceList = function (a) {
    var gs = svc('getGroupService')
    var id = String((a && a.id) || '')
    if (!id) throw new Error('缺少群号')
    return new Promise(function (resolve, reject) {
      gs.getGroupLatestEssenceList(id).then(function (r) {
        resolve(JSON.stringify({
          errCode: r && r.errCode,
          totalCount: r && r.result ? Number(r.result.totalCount) : 0,
          msgs: (r && r.result && Array.isArray(r.result.msgList) ? r.result.msgList : []).slice(0, 50).map(function (m) {
            return {
              msgId: String((m.msg && m.msg.msgId) || ''),
              msgSeq: String((m.msg && m.msg.msgSeq) || ''),
              msgRandom: String((m.msg && m.msg.msgRandom) || ''),
              operatorUid: String(m.operatorUid || ''),
              digestTime: Number(m.digestTime || 0),
              digest: String((m.msg && m.msg.digest) || '').slice(0, 60)
            }
          })
        }))
      }, function (e) { reject(new Error('getGroupLatestEssenceList：' + ((e && e.message) || e))) })
    })
  }

  /* 群通知/申请列表（好友申请、入群申请走这里）：fetchGroupNotify 要带 1 个回调参数。
     目前暂无待处理申请时回空表 —— 通道可用（result 0）。 */
  OPS.groupNotify = function () {
    var gs = svc('getGroupService')
    return new Promise(function (resolve, reject) {
      var p = null
      try { p = gs.fetchGroupNotify(function () { return true }) } catch (e) { return reject(new Error('fetchGroupNotify：' + (e && e.message))) }
      if (!p || typeof p.then !== 'function') return reject(new Error('获取群通知失败：QQ 暂无响应'))
      p.then(function (r) { resolve(JSON.stringify(r).slice(0, 40000)) },
        function (e) { reject(new Error('获取群通知被拒绝：' + ((e && e.message) || e))) })
    })
  }

  /* 群相册主页（getAlbumService 结算）：result 10000=正常，album_num/media_num 有数 */
  OPS.albumMain = function (a) {
    var al = svc('getAlbumService')
    var id = String((a && a.id) || '')
    if (!id) throw new Error('缺少群号')
    return new Promise(function (resolve, reject) {
      var p = null
      try { p = al.getMainPage(id, function () { return true }) } catch (e) { return reject(new Error('getMainPage：' + (e && e.message))) }
      if (!p || typeof p.then !== 'function') return reject(new Error('获取群相册失败：QQ 暂无响应'))
      p.then(function (r) { resolve(JSON.stringify(r).slice(0, 20000)) },
        function (e) { reject(new Error('获取群相册被拒绝：' + ((e && e.message) || e))) })
    })
  }

  OPS.emojiLike = function (a) {
    var ms = svc('getMsgService')
    var peer = String((a && a.id) || '')
    var rawId = String((a && (a.msgSeq || a.msgId)) || '')
    var code = String((a && a.code) || '128077')       // 默认 128077（点赞表情）
    if (!peer || !rawId) throw new Error('需要群号和消息编号')
    /* 内核 setMsgEmojiLikes 第二参要 msgSeq（5 参，
       emojiType 按 emojiId 长度判断：128077 六位 → '2'）。
       传进来的是大数 msgId（≥15 位）就先回读会话换成 seq —— 直接传
       msgId 内核回 result=65017「下游整机关联失败」。 */
    function resolveSeq () {
      if (rawId.length < 15) return Promise.resolve(rawId)
      var body = { chatType: 2, peerUid: peer, guildId: '' }
      return new Promise(function (resolve, reject) {
        var p = null
        try { p = ms.getMsgsIncludeSelf(body, '0', 30, true) } catch (e) { return reject(new Error('回读会话失败：' + (e && e.message))) }
        if (!p || typeof p.then !== 'function') return reject(new Error('读取会话失败：QQ 暂无响应'))
        p.then(function (r) {
          var arr = list(r && (r.msgList || r))
          for (var i = 0; i < arr.length; i++) {
            if (String(arr[i].msgId) === rawId) return resolve(String(arr[i].msgSeq || ''))
          }
          reject(new Error('消息 ' + rawId + ' 未在最近会话中找到该消息'))
        }, function (e) { reject(new Error('回读会话失败：' + ((e && e.message) || e))) })
      })
    }
    return resolveSeq().then(function (seq) {
      return callVariants('setMsgEmojiLikes', [
        function () { return ms.setMsgEmojiLikes({ chatType: 2, peerUid: peer, guildId: '' }, seq, code, code.length > 3 ? '2' : '1', true) },
        function () { return ms.setMsgEmojiLikes({ chatType: 1, peerUid: peer, guildId: '' }, seq, code, code.length > 3 ? '2' : '1', true) },
        function () { return ms.setMsgEmojiLikes(peer, seq, code, code.length > 3 ? '2' : '1', true) }
      ], function () { return '已回应表情 ' + code })
    })
  }


  /* 表情回应查询（只读）：验证贴表情是否真的生效。 */
  OPS.emojiLikesList = function (a) {
    var ms = svc('getMsgService')
    var peer = String((a && a.id) || '')
    var msgSeq = String((a && (a.msgSeq || a.msgId)) || '')
    if (!peer || !msgSeq) throw new Error('需要群号和消息序号')
    function fmt (r) {
      var s = ''
      try { s = JSON.stringify(r).slice(0, 400) } catch (e) {}
      return s || String(r)
    }
    return callVariants('getMsgEmojiLikesList', [
      function () { return ms.getMsgEmojiLikesList({ chatType: 2, peerUid: peer, guildId: '' }, msgSeq, '128077', 2, 0, 1, 20) },
      function () { return ms.getMsgEmojiLikesList({ chatType: 2, peerUid: peer, guildId: '' }, msgSeq, '128077', 2, 1, 20, 0) },
      function () { return ms.getMsgEmojiLikesList({ chatType: 2, peerUid: peer, guildId: '' }, msgSeq, '128077', 2, 1, 20, 1) },
      function () { return ms.getMsgEmojiLikesList({ chatType: 2, peerUid: peer, guildId: '' }, Number(msgSeq), '128077', 2, 1, 20, 1) }
    ], function (r) { return fmt(r) })
  }

  OPS.recentList = function () {
    /* 内核 getRecentContactService 是空壳（errCode=1）。
       改用入站消息桥维护的最近会话缓存（inbound.js 每收到一条消息记一次），
       返回结构化对象数组，面板按字段映射；缓存为空再试内核 API 兜底。 */
    var RC = null
    try { RC = globalThis.__fl_recent } catch (e) {}
    if (RC && RC.q && RC.q.length) {
      return JSON.stringify(RC.q.slice(0, 30).map(function (c) {
        var last = c.last || {}
        return {
          chatType: c.type === 'group' ? 2 : 1,
          peerUid: c.id,
          peerName: c.name || '',
          last_uin: last.uin || '',
          last_nick: last.nick || '',
          last_text: String(last.text || '').slice(0, 60),
          msgSeq: last.msgSeq || '',
          msgId: last.msgId || '',
          msgTime: last.at || 0
        }
      }))
    }
    var rcs = svc('getRecentContactService')
    /* 9.9.36：列表字段是 sortedContactList，失败码叫 errCode（不是 errMsg） */
    return callVariants('getRecentContactListSync', [
      function () { return rcs.getRecentContactListSync() },
      function () { return rcs.getRecentContactListSyncLimit(30) }
    ], function (r) {
      if (!r) throw new Error('暂无最近会话记录，等待群内产生新消息后自动恢复')
      if (r.errCode && r.errCode !== 0) {
        throw new Error('最近会话暂无记录（' + r.errCode + '）：请等待群内有新消息后再试')
      }
      var arr = r.sortedContactList || r.contacts || r.list || []
      return JSON.stringify(arr.slice(0, 30).map(function (c) {
        return pick(c, ['peerUid', 'chatType', 'remark', 'peerName', 'sendTime', 'msgTime'])
      }))
    })
  }

  /* 互动
   * 戳一戳：9.9.36 内核唯一存在的接口是 ms.sendNudge(Contact, int64 type, int64 targetUin)。
   * 矩阵结果（真实群 + 真实成员，成员 uid 从群消息里挖到）：
       type=0 + QQ 号 / uid / 字符串 / guildId '0'  → 一律 result=-1
       type=1/2/3                                    → 一律 result=-100（只认 0）
     结论：不是参数拼错 —— 群对、人对、Contact 形态与收消息时一致，内核照样拒。
     sendNudge 在旁挂 session 上是死通道；官方那条路是 OIDB 0xED3（发包格式未破）。
     所以这里的口径：result=0 才报成功，其它如实报码并说明「不是填错」。 */
  function pokeFailText (codes) {
    var last = codes.length ? codes[codes.length - 1] : 0
    return '戳一戳失败：QQ 拒绝了该请求（' + last + '），客户端里不会出现戳一戳。' +
      '不是群号/QQ 号填错 —— 真实群 + 真实成员同样回 -1。' +
      '当前 QQ 版本限制直接发送戳一戳，' +
      '该功能在此 QQ 版本中暂无法直接调用。' +
      '戳一戳功能需要搭配辅助扩展服务；' +
      '未检测到辅助扩展服务，请开启辅助服务后重试。'
  }

  /* 内核返回的 rsp 是 latin1 字符串（每个字符 = 一个字节），里面才是真正的 OIDB 回执。
     注意：result=0 只代表「传输成功」，OIDB 层可能已经失败 —— 不能只看 result。 */
  function parseOidbRsp (s) {
    if (!s || typeof s !== 'string' || !s.length) return null
    var buf = []
    for (var i = 0; i < s.length; i++) buf.push(s.charCodeAt(i) & 0xff)
    var p = 0
    var fields = {}
    function varint () {
      var v = 0
      var sh = 0
      var b
      do { b = buf[p++]; v += (b & 0x7f) * Math.pow(2, sh); sh += 7 } while (b & 0x80)
      return v
    }
    while (p < buf.length) {
      var tag = varint()
      var f = Math.floor(tag / 8)
      var w = tag & 7
      if (w === 0) { fields[f] = varint() } else if (w === 2) {
        var len = varint()
        var seg = buf.slice(p, p + len)
        p += len
        fields[f] = (f === 5) ? String.fromCharCode.apply(null, seg) : len
      } else break
    }
    return { code: (typeof fields[3] === 'number' ? fields[3] : null), msg: String(fields[5] || '') }
  }

  /* JS 层 OIDB 通道是否已被判定不可用（本进程只探一次，不重复白跑） */
  var oidbDead = false

  /* 0xED3 真戳：OidbSvcTrpcTcp.0xed3_1 + OidbBase 信封。成功返回 'ok'，否则抛错带 code */
  function oidbPoke (isGroup, peer, target) {
    if (oidbDead) { var d = new Error('底层通信服务暂不可用'); d.code = 145; return Promise.reject(d) }
    var ms = svc('getMsgService')
    if (typeof ms.sendSsoCmdReqByContend !== 'function') {
      oidbDead = true
      var n = new Error('当前 QQ 版本缺少底层发包接口')
      n.code = 145
      return Promise.reject(n)
    }
    var uin = Number(target)
    var env = oidbEnvelope(0xED3, 1, oidbPokeBody({ isGroup: isGroup, targetUin: uin, peerUin: isGroup ? Number(peer) : uin }), 0)
    return Promise.resolve(ms.sendSsoCmdReqByContend('OidbSvcTrpcTcp.0xed3_1', Uint8Array.from(env))).then(function (r) {
      var outer = codeOf(r)
      var inner = parseOidbRsp(r && r.rsp)
      var real = (inner && typeof inner.code === 'number' && inner.code !== 0) ? inner.code : (outer ? outer.code : 0)
      if (real === 0) return 'ok'
      if (real === 145 || real === 253) oidbDead = true
      var e = new Error('OIDB ' + real + (inner && inner.msg ? ' · ' + inner.msg.slice(0, 80) : ''))
      e.code = real
      e.oidb = true
      throw e
    })
  }

  /* 戳一戳：原生 hook 通道
   * sendNudge 恒 -1、sendSsoCmdReqByContend 被 OIDB 白名单挡（145 invalid pkg）、
   * sendMsfRequest 是无声 no-op —— JS 层三条路全死。
   * 根因：QQ 的 JS 参数转换器对 Buffer 参数走 napi_coerce_to_string
   * （二进制 → UTF-8 有损，非法序列变 U+FFFD），服务端解不开烂包 → 145。
   * recv 侧响应经 napi_create_string_utf8 回 JS 同样有损。
   * 本项目 native 模块 frishluna-pkt.node（payload/native/pkt.c，build: tools/build-pkt.sh）：
   * send hook 绕过 coerce 用 QQ 自己的 resize 直写原始字节；recv hook 在回执对象上
   * 补一个 napi_create_buffer_copy 的 rspbuffer（字节无损）。hook 本体是
   * 14 字节 detour + trampoline，无第三方二进制。
   * WRAPPER_OFFSETS 是各版本 wrapper.node 上三个函数的实测位置（send/recv/resize），
   * 版本不匹配时 initHook 直接拒绝。 */
  var WRAPPER_OFFSETS = {
    '9.9.36-53644-x64': { send: 'C3EE2F', recv: '24A6355', resize: '77DE00' },
    '9.9.37-54395-x64': { send: 'C5927F', recv: '24CC2B5', resize: '78F800' }
  }

  function qqVerKey () {
    if (typeof process === 'undefined' || !process.mainModule) return null
    var f = String(process.mainModule.filename || '')
    var m = f.match(/versions[\\/]([\d.]+-\d+)/)
    return m ? m[1] + '-x64' : null
  }

  function nodeReq (m) {
    try { if (typeof require === 'function') return require(m) } catch (e) {}
    try { if (typeof globalThis.require === 'function') return globalThis.require(m) } catch (e) {}
    try {
      /* 自检环境（vm 沙箱）里没有 process，裸引用会 ReferenceError */
      if (typeof process !== 'undefined' && process.mainModule && typeof process.mainModule.require === 'function') {
        return process.mainModule.require.bind(process.mainModule)(m)
      }
    } catch (e) {}
    return null
  }

  function nativeHookMod () {
    if (globalThis.__fl_napi2native) return globalThis.__fl_napi2native
    var fs = nodeReq('fs')
    var path = nodeReq('path')
    if (!fs || !path || typeof process === 'undefined' || !process.mainModule) return null
    var dir = (typeof __fl_dir === 'string') ? __fl_dir : ''
    if (!dir) return null
    var mod = path.resolve(dir, 'native', 'frishluna-pkt.node')
    try { if (!fs.existsSync(mod)) return null } catch (e) { return null }
    try {
      globalThis.__fl_napi2native = process.mainModule.require(mod)
      return globalThis.__fl_napi2native
    } catch (e) { return null }
  }

  function ensureNativeHook () {
    /* hook 装没装要以 globalThis 标志为准（payload 热重载不清全局，重复 initHook
       同一地址会有二次 hook 风险） */
    if (globalThis.__fl_hook_installed) return true
    var st = globalThis.__fl_native_hook_state
    if (st) return st.ok
    st = globalThis.__fl_native_hook_state = { ok: false, msg: '' }
    var key = qqVerKey()
    var off = key && WRAPPER_OFFSETS[key]
    if (!off) { st.msg = '当前 QQ 版本暂不支持（' + (key || '') + '）'; return false }
    var m = nativeHookMod()
    if (!m || typeof m.initHook !== 'function') { st.msg = '底层网络扩展模块加载失败'; return false }
    try {
      st.ok = !!m.initHook(off.send, off.recv, off.resize)
      if (!st.ok && typeof m.lastError === 'function') {
        var le = m.lastError()
        st.msg = le ? le : 'initHook 失败'
      } else if (st.ok) {
        st.msg = '底层网络扩展已加载（' + key + ' send=' + off.send + ' recv=' + off.recv + ' resize=' + off.resize + '）'
      } else {
        st.msg = 'initHook 失败'
      }
      if (st.ok) globalThis.__fl_hook_installed = true
    } catch (e) { st.msg = 'initHook 异常：' + e.message }
    return st.ok
  }

  /* 给 media.js 用：发包要拿原始回执字节，必须先装 recv hook */
  OPS.ensureHook = ensureNativeHook
  OPS.hookState = function () {
    return globalThis.__fl_native_hook_state || { ok: !!globalThis.__fl_hook_installed, msg: '未知' }
  }

  /* hook 后的 0xED3 真戳：cmd 用大写。
     回执字节优先 rspbuffer（recv hook 的 napi_create_buffer_copy，无损），
     rsp（utf8 字符串）只作兜底 —— 二进制经 utf8 转字符串是有损的。
     hook 后回执可能迟到甚至不到 —— 8 秒静默按「已发出」如实上报，不装有回执。 */
  function hookedPoke (isGroup, peer, target) {
    var ms = svc('getMsgService')
    if (typeof ms.sendSsoCmdReqByContend !== 'function') {
      throw new Error('当前 QQ 版本缺少底层发包接口')
    }
    var uin = Number(target)
    var env = oidbEnvelope(0xED3, 1, oidbPokeBody({
      isGroup: isGroup,
      targetUin: uin,
      peerUin: isGroup ? Number(peer) : uin
    }), 1)
    var okText = function (extra) {
      return '已戳 ' + target + (isGroup ? '（群 ' + peer + '）' : '') + (extra ? '（' + extra + '）' : '')
    }
    return new Promise(function (resolve, reject) {
      var settled = false
      var timer = setTimeout(function () {
        if (settled) return
        settled = true
        resolve(okText('已发出，回执未到'))
      }, 8000)
      function done (fn) {
        return function (v) {
          if (settled) return
          settled = true
          clearTimeout(timer)
          fn(v)
        }
      }
      try {
        Promise.resolve(ms.sendSsoCmdReqByContend('OidbSvcTrpcTcp.0xED3_1', Uint8Array.from(env)))
          .then(done(function (r) {
            var outer = codeOf(r)
            /* 无损原始回执：recv 只做 memcpy 入队，字节由 takeRsp() 在 JS 线程取回
               （recv 回调里不碰 napi —— 9.9.37 上那样会崩 QQ）。rspbuffer/rsp 仅作兜底。 */
            var raw = null
            try {
              var hm = nativeHookMod()
              if (hm && typeof hm.takeRsp === 'function') {
                var t = hm.takeRsp()
                /* takeRsp 回的是 latin1 字符串（每字符 = 一个字节），还原成 Buffer */
                if (typeof t === 'string' && t.length) raw = Buffer.from(t, 'latin1')
                else if (Buffer.isBuffer(t)) raw = t
              }
            } catch (e0) {}
            if (!raw) raw = (r && (r.rspbuffer || r.rsp)) || null
            var inner = raw ? parseOidbRsp(raw) : null
            var real = (inner && typeof inner.code === 'number' && inner.code !== 0) ? inner.code : (outer ? outer.code : 0)
            if (real === 0) resolve(okText('发送成功'))
            else reject(new Error('服务器返回错误 ' + real + (inner && inner.msg ? '：' + inner.msg.slice(0, 80) : '')))
          }), done(function (e) {
            reject(new Error('底层请求发送失败：' + ((e && e.message) || e)))
          }))
      } catch (e) {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new Error('底层通信服务异常：' + ((e && e.message) || e)))
        }
      }
    })
  }

  OPS.poke = function (a) {
    var isGroup = !!(a && a.type === 'group')
    var peer = String((a && a.id) || '')
    var target = String((a && a.uid) || '')
    if (isGroup && !/^\d{5,12}$/.test(peer)) throw new Error('群号必须是 5~12 位数字')
    if (!/^\d{5,12}$/.test(target)) throw new Error('对方 QQ 号必须是 5~12 位数字：' + target)

    function pokeIt () {
      if (ensureNativeHook()) {
        return hookedPoke(isGroup, peer, target)
      }
      throw new Error('底层扩展不可用（' + (globalThis.__fl_native_hook_state || {}).msg + '）')
    }

    if (!isGroup) return pokeIt()

    /* 群号先过群目录：91 这种不存在的群当场拦截，不给内核「假装成功」的机会。
       目录已有该群 → 直接戳；没有 → 触发一次群列表刷新等 1.5 秒，仍没有就拒绝。 */
    if (dirState.groups[peer]) return pokeIt()
    if (!dirState.gs) ensureDirListener()
    try { if (dirState.gs) dirState.gs.getGroupList(true) } catch (e) {}
    return new Promise(function (resolve, reject) {
      var done2 = false
      function finish () {
        if (done2) return
        done2 = true
        if (dirState.groups[peer]) { resolve(pokeIt()) } else {
          reject(new Error('群 ' + peer + ' 不在你的群列表里：群号不存在，或你已不在该群 —— 已拦截，未发生任何操作'))
        }
      }
      dirState.waiters.push(finish)
      setTimeout(finish, 1500)
    })
  }

  OPS.like = function (a) {
    var pls = svc('getProfileLikeService')
    var uin = String((a && a.uin) || '')
    var uid = String((a && a.uid) || '')
    var target = uin || uid
    var n = Math.max(1, Math.min(20, Number((a && a.count) || 1)))
    if (!target) throw new Error('缺少好友 QQ 号或成员标识')
    /* 9.9.36 点赞：setBuddyProfileLike({ friendUid: uid, times: count, sourceId: 71 })。
       friendUid 是唯一的目标字段名；times/count 两种计数名都试。 */
    return callVariants('setBuddyProfileLike', [
      function () { return pls.setBuddyProfileLike({ friendUid: uid, times: n, sourceId: 71 }) },
      function () { return pls.setBuddyProfileLike({ friendUid: uid, count: n, sourceId: 71 }) },
      function () { return pls.setBuddyProfileLike({ friendUid: uid, times: n }) },
      function () { return pls.setBuddyProfileLike({ friendUid: uid, times: n, sourceId: 71, uin: Number(uin) || 0 }) }
    ], function () { return '已点赞 ' + n + ' 次' })
  }

  OPS.groupList = function () {
    /* 9.9.36 的 getGroupList(true) 在旁挂 session 上常回空，真正带群名的
       列表走 onGroupListUpdate 分片推送（dirState 已积累）。所以先查目录，
       目录有数据就直接用；没有再试同步接口。 */
    var snap = dirSnapshot()
    if (!snap.length) {
      /* 目录还没积累好：挂监听 + 触发刷新，等回填（同 groupDirectory） */
      return OPS.groupDirectory().then(function (json) {
        try {
          var arr = JSON.parse(json)
          if (arr && arr.length) {
            return asText(arr.slice(0, 300).map(function (g) {
              return { groupCode: g.id, groupName: g.name, memberCount: g.members }
            }))
          }
        } catch (e) {}
        return '群列表暂时为空：请等待群消息刷新，或直接手动输入群号'
      })
    }
    return asText(snap.slice(0, 300).map(function (g) {
      return { groupCode: g.id, groupName: g.name, memberCount: g.members }
    }))
  }

  /* 群目录：getGroupList(true) 只回 {result}，真正的群列表（**才有群名**）
     是内核通过 addKernelGroupListener.onGroupListUpdate 分片推回来的。
     所以这里挂一次监听自己累积，groupDirectory 等它回填（最多 2.5 秒）。 */
  var dirState = { groups: {}, gs: null, waiters: [] }

  function dirSnapshot () {
    var out = []
    for (var k in dirState.groups) {
      if (dirState.groups.hasOwnProperty(k)) out.push(dirState.groups[k])
    }
    return out
  }

  function dirMerge (arr) {
    var n = 0
    list(arr).forEach(function (g) {
      if (!g) return
      var id = String(g.groupCode || g.groupUin || '')
      if (!id) return
      dirState.groups[id] = {
        id: id,
        name: String(g.groupName || ''),
        members: Number(g.memberCount || 0) || 0
      }
      n += 1
    })
    return n
  }

  function dirFlush () {
    if (!dirState.waiters.length) return
    var ws = dirState.waiters.slice()
    dirState.waiters.length = 0
    ws.forEach(function (w) { try { w() } catch (e) {} })
  }

  function ensureDirListener () {
    var gs = svc('getGroupService')
    if (dirState.gs === gs) return gs
    dirState.gs = gs
    try {
      gs.addKernelGroupListener({
        onGroupListUpdate: function () {
          var arr = null
          for (var i = 0; i < arguments.length; i++) {
            if (Array.isArray(arguments[i])) { arr = arguments[i]; break }
          }
          if (arr && dirMerge(arr)) dirFlush()
        }
      })
    } catch (e) {
      emit({ evt: 'group-dir-err', msg: String((e && e.message) || e) })
    }
    return gs
  }

  OPS.groupDirectory = function () {
    var gs = ensureDirListener()
    try { gs.getGroupList(true) } catch (e) { emit({ evt: 'group-dir-err', msg: String((e && e.message) || e) }) }

    return new Promise(function (resolve) {
      var done = false
      function finish () {
        if (done) return
        done = true
        var out = dirSnapshot()
        if (!out.length) {
          /* 监听没回数据时退回同步读一次（个别版本这里就有内容） */
          try {
            var r = gs.getGroupList(false)
            var arr = r && (r.groupList || r.list)
            if (arr && arr.length) dirMerge(arr)
          } catch (e) {}
          out = dirSnapshot()
        }
        resolve(JSON.stringify(out))
      }
      dirState.waiters.push(finish)
      setTimeout(finish, 2500)
    })
  }

  OPS.groupMembers = function (a) {
    var gs = svc('getGroupService')
    var code = String((a && a.id) || '')
    if (!code) throw new Error('缺少群号')
    /* 9.9.36：getAllMemberList 需要 2 参且返回 Promise（群里 + 是否强制刷新） */
    return callVariants('getAllMemberList', [
      function () { return gs.getAllMemberList(code, true) },
      function () { return gs.getAllMemberList(code, false) },
      function () { return gs.getAllMemberList(code) }
    ], function (r) {
      /* 9.9.36 回执是 { errCode, errMsg, result:{ ids:[{uid,index},...] } }，
         数据在 result 字段里（和 sendMsg 的 result 码不同名同字，别搞混） */
      if (!r) return '群成员列表获取失败：QQ 未返回数据'
      if (typeof r.errCode === 'number' && r.errCode !== 0) {
        throw new Error('errCode=' + r.errCode + ' ' + (r.errMsg || ''))
      }
      var data = (r.result && typeof r.result === 'object') ? r.result : r
      var raw = data.ids || data.memberList || data.list || null
      /* 详情（昵称/名片/QQ号）内核同步接口一律不给：getMemberInfoCache 回
         MemberInfo not found、getNextMemberList 的 infos 恒空、getGroupMemberCardInfo
         对群里的人常回 Data Not Existed。只能靠 listener 推送攒，攒到就合并进来。 */
      var cache = memberCacheOf(code)
      var rows = list(raw).map(function (m) {
        var uid = String((m && m.uid) || m || '')
        var hit = cache[uid] || {}
        return { uid: uid, qq: String(hit.uin || ''), nick: String(hit.nick || ''), card: String(hit.card || '') }
      }).filter(function (x) { return x.uid })
      if (!rows.length) {
        rows = Object.keys(cache).map(function (uid) {
          return { uid: uid, qq: String(cache[uid].uin || ''), nick: String(cache[uid].nick || ''), card: String(cache[uid].card || '') }
        })
      }
      if (!rows.length) return '成员列表加载中，请稍候再试'
      try {
        var store = globalThis.__fl_uidmap = (globalThis.__fl_uidmap || {})
        rows.forEach(function (x) { if (/^\d{5,12}$/.test(x.qq)) store[x.qq] = x.uid })
      } catch (e) {}
      return asText(rows.map(function (x) { return pick(x, ['qq', 'uid', 'nick', 'card']) }))
    })
  }

  OPS.groupMute = function (a) {
    var gs = svc('getGroupService')
    var code = String((a && a.id) || '')
    var uid = String((a && a.uid) || '')
    var sec = Math.max(0, Number((a && a.seconds) || 0))
    if (!code || !uid) throw new Error('需要群号 + 成员标识（或 QQ 号）')
    /* 9.9.36 签名：setMemberShutUp(群号, [{uid, duration}]) —— 第二参是数组对象，
       传 (群号, uid, 秒) 会报 "needs 2 arguments"。用假 uid 试会走到 OIDB 回 116
       "exist invalid uid"，说明这条路径真发得出去。 */
    function local () {
      return callVariants('setMemberShutUp', [
        function () { return gs.setMemberShutUp(code, [{ uid: uid, duration: sec }]) },
        function () { return gs.setMemberShutUp(code, [{ uid: uid, time: sec }]) }
      ], function () { return sec ? ('已禁言 ' + sec + ' 秒') : '已解除禁言' })
    }
    return local()
  }

  OPS.groupMuteAll = function (a) {
    var gs = svc('getGroupService')
    var code = String((a && a.id) || '')
    var on = !!a.on
    if (!code) throw new Error('缺少群号')
    /* setGroupShutUp(群号, 布尔)，2 参 */
    function local () {
      return callVariants('setGroupShutUp', [
        function () { return gs.setGroupShutUp(code, on) }
      ], function () { return on ? '已开启全员禁言' : '已关闭全员禁言' })
    }
    return local()
  }

  OPS.groupKick = function (a) {
    var gs = svc('getGroupService')
    var code = String((a && a.id) || '')
    var uid = String((a && a.uid) || '')
    if (!code || !uid) throw new Error('需要群号 + 成员标识（或 QQ 号）')
    /* kickMember(群号, [uid…], 是否拒绝再加群, 附言) —— 必须 4 参、第二参是数组。
       假 uid 会回 116 "[oidb] exist invalid uid"，说明请求真的发出去了。 */
    function local () {
      return callVariants('kickMember', [
        function () { return gs.kickMember(code, [uid], !!a.reject, '') }
      ], function () { return '已移出 ' + uid })
    }
    return local()
  }

  OPS.groupSetAdmin = function (a) {
    var gs = svc('getGroupService')
    var code = String((a && a.id) || '')
    var uid = String((a && a.uid) || '')
    var on = !!a.on
    if (!code || !uid) throw new Error('需要群号 + 成员标识（或 QQ 号）')
    /* modifyMemberRole 的角色值（bool 回 5，说明不是布尔）：
       NTQQ 里 1=群主 2=管理员 3=普通成员，逐个试 */
    function local () {
      return callVariants('modifyMemberRole', [
        function () { return gs.modifyMemberRole(code, uid, on ? 2 : 3) },
        function () { return gs.modifyMemberRole(code, uid, on ? 1 : 2) },
        function () { return gs.modifyMemberRole(code, [uid], on ? 2 : 3) }
      ], function () { return on ? '已设为管理员' : '已取消管理员' })
    }
    return local()
  }

  OPS.groupCard = function (a) {
    var gs = svc('getGroupService')
    var code = String((a && a.id) || '')
    var uid = String((a && a.uid) || '')
    var card = String((a && a.card) || '')
    if (!code || !uid) throw new Error('需要群号 + 成员标识（或 QQ 号）')
    /* modifyMemberCardName(群号, uid, 名片)，假 uid 回 116 */
    function local () {
      return callVariants('modifyMemberCardName', [
        function () { return gs.modifyMemberCardName(code, uid, card) }
      ], function () { return '已改名片' })
    }
    return local()
  }

  OPS.groupName = function (a) {
    var gs = svc('getGroupService')
    var code = String((a && a.id) || '')
    var name = String((a && a.name) || '')
    if (!code || !name) throw new Error('需要群号 + 新群名')
    /* modifyGroupName 必须 3 参，只传 (群号, 群名) 会
       assertion (argc == 3) failed。第三参传 0 能正常发包（假群号回 1010）。 */
    return callVariants('modifyGroupName', [
      function () { return gs.modifyGroupName(code, name, 0) },
      function () { return gs.setGroupName(code, name) }
    ], function () { return '已改群名' })
  }

  OPS.groupAnnounce = function (a) {
    var gs = svc('getGroupService')
    var code = String((a && a.id) || '')
    var text = String((a && a.text) || '')
    if (!code || !text) throw new Error('需要群号 + 公告内容')
    /* 真正的方法叫 publishGroupBulletin，必须 3 参（第 3 参 true 才真发）。
       发完查一次公告列表：列表里没有就是没发出去，不许假成功。 */
    function listed (r) {
      var arr = (r && (r.groupBulletinList || r.list || r.infos)) || []
      return arr.some(function (x) {
        var c = String((x && (x.content || x.msg || x.text)) || '')
        return c.indexOf(text.slice(0, 20)) >= 0
      })
    }
    return callVariants('publishGroupBulletin', [
      function () { return gs.publishGroupBulletin(code, text, true) }
    ], function () { return '已发布群公告' }).then(function (txt) {
      return new Promise(function (r) { setTimeout(r, 800) }).then(function () {
        try {
          var r = gs.getGroupBulletinList(code)
          if (r && typeof r.then === 'function') {
            return r.then(function (rr) {
              if (!listed(rr)) throw new Error('公告回执为 ok，但公告列表里查不到刚发的内容（可能是没权限或没发出去），请在群公告页确认')
              return txt
            })
          }
          if (!listed(r)) throw new Error('公告回执为 ok，但公告列表里查不到刚发的内容（可能是没权限或没发出去），请在群公告页确认')
          return txt
        } catch (e) { throw e }
      })
    })
  }

    /* 群成员详情和好友一个路子：同步接口只回 uid，昵称/名片只在推送里。
     getMemberInfoCache 回 "MemberInfo not found"，getNextMemberList 的 infos 恒空，
     getGroupMemberCardInfo 只吃一个参数数组、且对群里的人常回 Data Not Existed。
     所以挂 group listener 收集推送，按群号攒着；读的时候 uid 列表 + 缓存合并。 */
  function ensureGroupMemberCache () {
    var st = globalThis.__fl_member_cache
    if (st && st.hooked) return st
    st = globalThis.__fl_member_cache = { hooked: false, byGroup: {}, at: 0, n: 0, err: '' }
    var gs = null
    try { gs = svc('getGroupService') } catch (e) { st.err = String(e && e.message); return st }

    function put (g, m) {
      if (!g || !m || typeof m !== 'object') return
      var uid = String(m.uid || m.memberUid || '')
      if (!uid) return
      var bag = st.byGroup[g] || (st.byGroup[g] = {})
      var old = bag[uid] || {}
      bag[uid] = {
        uin: String(m.uin || m.memberUin || m.baseUin || old.uin || ''),
        nick: String(m.nick || m.nickname || (m.coreInfo && m.coreInfo.nick) || old.nick || ''),
        card: String(m.cardName || m.card || old.card || '')
      }
      st.at = Date.now()
      st.n++
    }
    /* 推送结构没固定文档：把对象挖一遍，凡是带 uid 且有 QQ号/昵称/名片 的都收下。
       群号从容器上的 groupCode 拿，拿不到就沿用上层的（同一棵子树属于同一个群）。
       只读不写：推送对象是内核给的，不往里改字段。 */
    var seen = []
    function dig (obj, hint, depth) {
      if (!obj || typeof obj !== 'object' || (depth || 0) > 4) return
      if (seen.indexOf(obj) >= 0) return
      seen.push(obj)
      if (Array.isArray(obj)) { obj.forEach(function (x) { dig(x, hint, (depth || 0) + 1) }); return }
      var g = String(obj.groupCode || obj.groupCodeStr || hint || '')
      if (obj.uid && (obj.uin || obj.nick || obj.nickname || obj.cardName || obj.card)) put(g, obj)
      var keys = ['memberList', 'members', 'memberInfoList', 'infos', 'infoMap', 'list', 'changedMembers']
      keys.forEach(function (k) {
        var v = obj[k]
        if (!v || typeof v !== 'object') return
        if (!Array.isArray(v)) {
          Object.keys(v).forEach(function (kk) {
            var x = v[kk]
            if (x && typeof x === 'object' && !x.uid) x = { uid: kk, nick: x.nick, card: x.cardName }
            dig(x, g, (depth || 0) + 1)
          })
        } else dig(v, g, (depth || 0) + 1)
      })
    }
    function take (payload) {
      seen = []
      try { dig(payload, '', 0) } catch (e) {}
    }
    try {
      st.listener = gs.addKernelGroupListener({
        onMemberListChange: take,
        onMemberInfoChange: take,
        onGroupMemberListChange: take,
        onGroupListUpdate: function () {},
        onGroupDetailInfoChange: function () {},
        onGroupAllInfoChange: function () {},
        onGroupDetailInfoListChange: function () {},
        onGroupAllInfoListChange: function () {}
      })
      st.hooked = true
    } catch (e) { st.err = '监听消息失败：' + (e && e.message) }
    return st
  }

  function memberCacheOf (code) {
    var st = ensureGroupMemberCache()
    return (st.byGroup && st.byGroup[String(code)]) || {}
  }

  /* 好友数据只在 listener 推送里是全的。
     9.9.37 的同步接口全部退化成「受理回执」：getBuddyList 只回 {result:0}，
     getBuddyNick/getBuddyRemark 回 {}，getBuddyListV2 直接挂死。
     完整结构（uid+uin+昵称+备注+签名）走 onBuddyListChange 推送，
     调一次 getBuddyList(true) 就会把整张表推过来。缓存一次，之后读缓存。 */
  function ensureBuddyCache () {
    var st = globalThis.__fl_buddy_cache
    if (st && st.hooked) return st
    st = globalThis.__fl_buddy_cache = { hooked: false, cats: null, at: 0, n: 0, err: '' }
    var bs = null
    try { bs = svc('getBuddyService') } catch (e) { st.err = String(e && e.message); return st }
    if (typeof bs.addKernelBuddyListener !== 'function') { st.err = '当前版本不支持好友事件监听'; return st }
    function take (payload) {
      try {
        if (!Array.isArray(payload) || !payload.length) return
        var looksRight = payload.some(function (c) { return c && (c.buddyList || c.buddyUids) })
        if (!looksRight) return
        st.cats = payload
        st.at = Date.now()
        st.n++
      } catch (e) {}
    }
    try {
      st.listener = bs.addKernelBuddyListener({
        onBuddyListChange: take,
        onBuddyListChangedV2: take,
        onBlockChanged: function () {},
        onBuddyReqChange: function () {},
        onSettingChanged: function () {}
      })
      st.hooked = true
    } catch (e) { st.err = '监听消息失败：' + (e && e.message) }
    return st
  }

  /* 两种结构都要吃：
       listener: {categroyName, buddyList:[{uid, uin, coreInfo:{nick,remark}}]}
       FromCache: {categroyName, buddyUids:[uid]} */
  function buddyRows (cats) {
    var rows = []
    ;(cats || []).forEach(function (c) {
      if (!c) return
      var cat = String(c.categroyName || c.categoryName || c.name || '')
      var deep = c.buddyList || c.list || null
      if (Array.isArray(deep) && deep.length) {
        deep.forEach(function (b) {
          if (!b) return
          var core = b.coreInfo || {}
          var uid = String(b.uid || core.uid || '')
          if (!uid) return
          rows.push({
            uid: uid,
            uin: String(b.uin || core.uin || ''),
            nick: String(core.nick || b.nick || ''),
            remark: String(core.remark || b.remark || ''),
            category: cat
          })
        })
        return
      }
      var shallow = c.buddyUids || c.uids || []
      shallow.forEach(function (u) {
        var uid = String(u || '')
        if (uid) rows.push({ uid: uid, uin: '', nick: '', remark: '', category: cat })
      })
    })
    return rows
  }

  OPS.friendList = function () {
    var st = ensureBuddyCache()
    var bs = svc('getBuddyService')

    function fromCacheOnly () {
      var cats = bs.getBuddyListFromCache(0, 500)
      if (!Array.isArray(cats)) throw new Error('好友列表数据解析失败')
      var rows = buddyRows(cats)
      if (!rows.length) throw new Error('好友列表暂无数据')
      return asText(rows)
    }

    /* 有推送缓存直接用 */
    if (st.cats && st.cats.length) {
      var hit = buddyRows(st.cats)
      if (hit.length) return asText(hit)
    }
    /* 没缓存：触发一次推送，最多等 5 秒 */
    try { bs.getBuddyList(true) } catch (e) {}
    return new Promise(function (resolve, reject) {
      var t0 = Date.now()
      var iv = setInterval(function () {
        if (st.cats && st.cats.length) {
          clearInterval(iv)
          var rows = buddyRows(st.cats)
          if (rows.length) return resolve(asText(rows))
        }
        if (Date.now() - t0 > 5000) {
          clearInterval(iv)
          try { resolve(fromCacheOnly()) }
          catch (e) { reject(new Error('好友列表取不到：' + (st.err || e.message))) }
        }
      }, 150)
    })
  }

  OPS.profileSet = function (a) {
    var nick = String((a && a.nick) || '')
    var sign = String((a && a.sign) || '')
    if (!nick && !sign) throw new Error('昵称和签名至少填一个')
    var done = []
    if (nick) done.push('昵称')
    if (sign) done.push('签名')
    /* 正确的方法名：setNickName（改昵称）、setLongNick（改签名），都在
       getProfileService 上 —— 之前试的 setSelfNick / setSelfLongNick 是猜错的
       名字。modifySelfProfile(形状未知的 profile 对象) 留作兜底。 */
    var ps = svc('getProfileService')
    var jobs = []
    if (nick) {
      jobs.push(callVariants('setNickName', [
        function () { return ps.setNickName(nick) },
        function () { return ps.setNickName(nick, 0) }
      ], function () { return '昵称已提交' }))
    }
    if (sign) {
      jobs.push(callVariants('setLongNick', [
        function () { return ps.setLongNick(sign) },
        function () { return ps.setLongNick(sign, 0) }
      ], function () { return '签名已提交' }))
    }
    if (!jobs.length) {
      jobs.push(callVariants('modifySelfProfile', [
        function () { return ps.modifySelfProfile({} ) }
      ], function () { return '资料已提交' }))
    }
    return Promise.all(jobs).then(function () { return '已提交修改：' + done.join('、') })
  }

  /* QQ 号 → 内核 uid。可用转换接口：
     getProfileService().getUidByUin('FriendsServiceImpl', [uin]) 回 Map（uid 按 uin 取）。
     GroupService.getUidByUins 旁挂上回空，requestInfoByAccount 是空壳，
     searchStranger 只回第一页空结果 —— ProfileService 是唯一可用的转换接口。 */

  OPS.findUid = function (a) {
    var uin = String((a && (a.uin || a.id || a.uid)) || '').trim()
    if (!/^\d{5,12}$/.test(uin)) throw new Error('要一个 5~12 位 QQ 号')
    var ps = svc('getProfileService')
    function pickFromMap (m) {
      /* 回执可能是 Map 或普通对象：按 uin 键取 uid */
      var uid = null
      try { uid = m && typeof m.get === 'function' ? m.get(uin) : (m && m[uin]) } catch (e) {}
      if (!/^u_/.test(String(uid || ''))) {
        try { uid = m && typeof m.get === 'function' ? m.get(Number(uin)) : uid } catch (e) {}
      }
      if (!/^u_/.test(String(uid || ''))) throw new Error('未获取到成员标识（' + (function () { try { return JSON.stringify(Array.from ? Array.from(m) : m).slice(0, 200) } catch (e) { return String(m) } })() + '）')
      return uid
    }
    return callVariants('getUidByUin', [
      function () { return ps.getUidByUin('FriendsServiceImpl', [uin]) },
      function () { return ps.getUidByUin('BuddyServiceImpl', [uin]) },
      function () { return ps.getUidByUin('ProfileService', [uin]) }
    ], function (m) {
      var uid = pickFromMap(m)
      /* 查到的映射塞进全局缓存；lab 层回填 server 端 uidmap —— 下次就不用再查 */
      try {
        var store = globalThis.__fl_uidmap = (globalThis.__fl_uidmap || {})
        store[uin] = uid
      } catch (e) {}
      return JSON.stringify({ uin: uin, uid: uid })
    })
  }

  /* 登录账号（self uin）：9.9.36 没有 getLoginService，唯一的可靠来源是
     getMsgsIncludeSelf(peer,'0',20,true) 里 sendType===1 的 senderUin/senderUid。
     peer 取群目录第一个群（本号在哪个群都有历史消息，必然能翻到自己的发言）。
     结果缓存到 globalThis，命中后 kernel probe 不再重复翻历史。 */
  var selfInfoCache = null

  OPS.selfInfo = function () {
    if (selfInfoCache) return Promise.resolve(selfInfoCache)
    return local()

    function local () {
    var s = needSession()
    var ms = svc('getMsgService')
    return new Promise(function (resolve, reject) {
      function run () {
        /* 逐群翻历史：本号在哪个群发过言，哪群就能翻到自己（sendType===1）。
           最多试 40 个群，每次取 50 条，全部落空才算失败。 */
        var codes = dirSnapshot().slice(0, 40).map(function (g) { return g.id })
        if (!codes.length) { reject(new Error('群列表暂无记录，未找到近期发言')); return }
        var i = 0
        function next () {
          if (i >= codes.length) { reject(new Error('试了 ' + codes.length + ' 个群均未找到发言记录（可能近期未在群内发过消息）')); return }
          var code = codes[i++]
          var body = { chatType: 2, peerUid: String(code), guildId: '' }
          var p
          try { p = ms.getMsgsIncludeSelf(body, '0', 50, true) } catch (e) { next(); return }
          if (!p || typeof p.then !== 'function') { next(); return }
          p.then(function (r) {
            var arr = list(r && (r.msgList || r))
            for (var k = 0; k < arr.length; k++) {
              var m = arr[k]
              if (Number(m.sendType) === 1 && m.senderUin) {
                selfInfoCache = { uin: String(m.senderUin), uid: String(m.senderUid || ''), nick: String(m.sendNickName || m.sendMemberName || ''), fromGroup: String(code) }
                return resolve(selfInfoCache)
              }
            }
            next()
          }, function () { next() })
        }
        next()
      }
      /* 群目录没数据就挂监听触发刷新，等 2.5 秒再跑 */
      if (dirSnapshot().length) { run(); return }
      ensureDirListener()
      try { if (dirState.gs) dirState.gs.getGroupList(true) } catch (e) {}
      var done = false
      function go () {
        if (done) return
        done = true
        run()
      }
      dirState.waiters.push(go)
      setTimeout(go, 2500)
    })
    }
  }

  /* 调试用：挂内核 listener，验证内核是否推送受理回执与事件。
     用 Proxy 把任何方法名都接住并计数，这样不用猜回调名。 */
  OPS.kernelListen = function (a) {
    var which = String((a && a.svc) || 'buddy')   // buddy | group | profile
    var bagName = '__fl_listen_' + which
    if (globalThis[bagName]) {
      var old = globalThis[bagName]
      return which + ' 消息监听已启动：收到 ' + old.n + ' 次推送，回调名 ' + JSON.stringify(old.names) +
        (a && a.show ? ' || 最近一次：' + String(old.last || '无').slice(0, 2500) : '')
    }
    var s = needSession()
    var bind = {
      buddy: ['getBuddyService', 'addKernelBuddyListener', 'removeKernelBuddyListener'],
      group: ['getGroupService', 'addKernelGroupListener', 'removeKernelGroupListener'],
      profile: ['getProfileService', 'addKernelProfileListener', 'removeKernelProfileListener']
    }[which]
    if (!bind) throw new Error('svc 只能是 buddy / group / profile')
    var svcObj = s[bind[0]] ? s[bind[0]].call(s) : null
    if (!svcObj || typeof svcObj[bind[1]] !== 'function') throw new Error(bind[0] + '.' + bind[1] + ' 不存在')
    var bag = globalThis[bagName] = { n: 0, names: {}, last: null, keys: [] }
    var handler = {
      get: function (t, k) {
        if (typeof k !== 'string') return undefined
        if (!t[k]) {
          t[k] = function () {
            bag.n++
            bag.names[k] = (bag.names[k] || 0) + 1
            if (bag.keys.length < 30) bag.keys.push(k)
            try { bag.last = k + ' → ' + JSON.stringify(arguments[0]).slice(0, 600) } catch (e) {}
          }
        }
        return t[k]
      }
    }
    var listener = new Proxy({}, handler)
    var r
    try { r = svcObj[bind[1]](listener) } catch (e) { throw new Error(bind[1] + ' 抛错：' + e.message) }
    return which + ' listener 挂上了（返回 ' + JSON.stringify(r) + '），等推送'
  }

  /* 把参数原样传给内核方法，返回结构（截断到 3000 字）。
     只用于确认某个 API 的真实签名和返回形态，不参与产品功能。 */
  OPS.probeCall = function (a) {
    var s = needSession()
    var getter = String((a && a.g) || 'getBuddyService')
    var meth = String((a && a.m) || '')
    var argv = Array.isArray(a && a.args) ? a.args : []
    var svcObj = (getter === '__session') ? s
      : (typeof s[getter] === 'function' ? s[getter].call(s) : s[getter])
    if (!svcObj) throw new Error(getter + ' 返回空')
    if (!meth || typeof svcObj[meth] !== 'function') throw new Error(getter + ' 上没有 ' + meth + '()')
    function dump (v) {
      try {
        var j = typeof v === 'string' ? v : JSON.stringify(v)
        if (j == null) return String(v)
        return j.length > 3000 ? j.slice(0, 3000) + '…' : j
      } catch (e) { return String(v) }
    }
    var r
    try { r = svcObj[meth].apply(svcObj, argv) } catch (e) { throw new Error(meth + ' 抛错：' + e.message) }
    if (r && typeof r.then === 'function') {
      return r.then(function (v) { return meth + '(' + JSON.stringify(argv) + ') → ' + dump(v) },
                    function (e) { return meth + '(' + JSON.stringify(argv) + ') 拒绝 → ' + ((e && e.message) || String(e)) })
    }
    return meth + '(' + JSON.stringify(argv) + ') → ' + dump(r)
  }

  /* 只读探测：枚举某个服务上「名字匹配正则」的方法，用来确认内核到底提供了什么。
     不调用、不改状态，只列名字，用于查找 API。
     g 传 '__session' 时枚举 session 自身（找 getXxxService 一类的 getter）。 */
  OPS.probe = function (a) {
    var s = needSession()
    var getter = String((a && a.g) || 'getMsgService')
    var re = new RegExp(String((a && a.re) || '.'), 'i')
    var v
    if (getter === '__session') v = s
    else if (typeof s[getter] === 'function') v = s[getter].call(s)
    else v = s[getter]
    if (!v) return getter + ' 是空的'
    var names = {}
    var o = v
    while (o && o !== Object.prototype) {
      Object.getOwnPropertyNames(o).forEach(function (k) {
        if (k === 'constructor') return
        if (!re.test(k)) return
        var t = '?'
        try { t = typeof v[k] } catch (e) { t = 'ERR' }
        names[k] = t
      })
      o = Object.getPrototypeOf(o)
    }
    var out = Object.keys(names).sort().map(function (k) { return k + ':' + names[k] })
    return getter + ' 命中 ' + out.length + ' 个\n' + out.join(' ')
  }

  /* 在 QQ 进程内跑一段 JS。只给 /api/lab/invoke 用，面板无入口。 */
  OPS.devEval = function (a) {
    var code = String((a && a.js) || '')
    if (!code) throw new Error('缺少 js')
    function dump (v) {
      if (typeof v === 'string') return v
      try { var j = JSON.stringify(v); return j == null ? String(v) : j } catch (e) { return String(v) }
    }
    var r = (0, eval)(code)
    if (r && typeof r.then === 'function') return Promise.resolve(r).then(dump)
    return dump(r)
  }

  OPS.services = function () {
    var s = globalThis.__fl_session
    if (!s) return 'QQ 服务尚未就绪'
    var rows = []
    var getters = [
      'getMsgService', 'getGroupService', 'getBuddyService', 'getProfileService',
      'getRecentContactService', 'getRichMediaService', 'getMSFService', 'getStorageService'
    ]
    getters.forEach(function (g) {
      var st = '缺'
      try {
        var f = s[g]
        if (typeof f !== 'function') st = '无此方法'
        else if (!f.call(s)) st = 'null'
        else st = '可用'
      } catch (e) { st = 'ERR:' + (e && e.message ? e.message : e) }
      rows.push(g + ' = ' + st)
    })
    try { rows.push('msf = ' + String(s.getMSFService().getMsfStatus())) } catch (e) {}
    return rows.join('\n')
  }

  try { __fl_emit(JSON.stringify({ evt: 'ops-ready', n: globalThis.__fl_ops_meta.length })) } catch (e) {}
})();

/* 群文件系
   9.9.36 旁挂 session 上富媒体服务的可用子集（逐个探针验过）：
     可用：getGroupSpace / batchGetGroupFileCount / createGroupFolder /
           deleteGroupFolder（都回 Promise，result 0 = ok，真建真删）
     有签名没结果：deleteGroupFile(3参) / renameGroupFile(5参) / moveGroupFile(5参)
                   —— 假 uuid 时 Promise 永不结算，没真文件不能验
     旁挂不可用：getGroupFileList / getGroupTransferList（同步只回数字，数据不回）、
                 getGroupFileInfo / searchGroupFileByWord（Promise 挂死不结算）、
                 onlyUploadFile / downloadFileForFileUuid（静默 undefined）
   规矩：挂死的接口一律加超时闸，绝不让实验台被一个 Promise 拖死。 */
;
(function () {
  if (globalThis.__fl_ops && globalThis.__fl_ops.groupSpace) return
  var OPS = globalThis.__fl_ops
  if (!OPS) return

  /* 给可能挂死的 Promise 上闸：到点没回就明确报「内核没回」，不假装成功 */
  function withTimeout (p, label, ms) {
    return Promise.race([
      Promise.resolve(p),
      new Promise(function (_, rej) {
        setTimeout(function () { rej(new Error(label + ' 等待 ' + (ms || 10000) + 'ms 没有收到回复，已停止等待')) }, ms || 10000)
      })
    ])
  }

  function rm () {
    var s = globalThis.__fl_session
    if (!s) throw new Error('QQ 尚未登录完成，请稍后重试')
    var f = s.getRichMediaService
    if (typeof f !== 'function') throw new Error('当前 QQ 版本缺少媒体服务接口')
    var r = f.call(s)
    if (!r) throw new Error('媒体服务未就绪，请等待 QQ 完全登录')
    return r
  }

  function humanSize (n) {
    n = Number(n) || 0
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB'
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB'
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
    return n + ' B'
  }

  /* 群空间：总容量 / 已用 / 剩余 */
  OPS.groupSpace = function (a) {
    var code = String((a && a.id) || '')
    if (!code) throw new Error('需要群号')
    return withTimeout(rm().getGroupSpace(code), '群空间', 10000).then(function (r) {
      var sp = (r && r.groupSpaceResult) || {}
      if (Number(sp.retCode) !== 0 && Number(r && r.result) !== 0) {
        throw new Error('群空间查询失败：' + (sp.retCode ?? (r && r.result)))
      }
      var total = Number(sp.totalSpace) || 0
      var used = Number(sp.usedSpace) || 0
      return '群 ' + code + ' 文件空间：已用 ' + humanSize(used) + ' / 共 ' + humanSize(total) +
        '（剩 ' + humanSize(Math.max(0, total - used)) + '）'
    })
  }

  /* 文件数：batchGetGroupFileCount 支持多群一起查 */
  OPS.groupFileCount = function (a) {
    var codes = (a && a.ids) || (a && a.id ? [a.id] : [])
    if (!codes.length) throw new Error('需要群号（id 或 ids 数组）')
    return withTimeout(rm().batchGetGroupFileCount(codes.map(String)), '文件计数', 10000).then(function (r) {
      if (Number(r && r.result) !== 0) throw new Error('获取群文件数量失败：' + (r && r.result))
      var cs = (r && r.groupCodes) || []
      var ns = (r && r.groupFileCounts) || []
      var rows = []
      for (var i = 0; i < cs.length; i++) rows.push('群 ' + cs[i] + '：' + (ns[i] ?? '?') + ' 个文件')
      return rows.join('\n') || '没有计数'
    })
  }

  /* 建文件夹：真建，回执里必须有 folderId 才算成功 */
  OPS.groupFolderCreate = function (a) {
    var code = String((a && a.id) || '')
    var name = String((a && a.name) || '')
    if (!code || !name) throw new Error('需要群号 + 文件夹名')
    return withTimeout(rm().createGroupFolder(code, name), '建文件夹', 15000).then(function (r) {
      var inner = ((r && r.resultWithGroupItem) || {})
      var res = (inner.result) || {}
      var folder = (inner.groupItem && inner.groupItem.folderInfo) || null
      if (Number(res.retCode) !== 0 || !folder || !folder.folderId) {
        throw new Error('新建文件夹失败：' + (res.retCode ?? (r && r.result)) + ' ' + (res.retMsg || ''))
      }
      return '已在群 ' + code + ' 建立文件夹「' + name + '」（folderId=' + folder.folderId + '）'
    })
  }

  /* 删文件夹：按 folderId 删，真删（回执 retCode 0 = ok） */
  OPS.groupFolderDelete = function (a) {
    var code = String((a && a.id) || '')
    var fid = String((a && (a.folderId || a.fid)) || '')
    if (!code || !fid) throw new Error('需要群号 + folderId')
    return withTimeout(rm().deleteGroupFolder(code, fid), '删文件夹', 15000).then(function (r) {
      var res = ((r && r.groupFileCommonResult) || {})
      if (Number(r && r.result) !== 0 || Number(res.retCode) !== 0) {
        throw new Error('删除文件夹失败：' + (res.retCode ?? (r && r.result)) + ' ' + (res.retMsg || ''))
      }
      return '已删除群 ' + code + ' 的文件夹 ' + fid
    })
  }

  /* 删文件（3 参），假 uuid 时内核不结算 —— 有真 uuid 才可用 */
  OPS.groupFileDelete = function (a) {
    var code = String((a && a.id) || '')
    var uuid = String((a && (a.fileId || a.uuid)) || '')
    var parent = String((a && (a.folderId || '/')) || '/')
    if (!code || !uuid) throw new Error('需要群号 + 文件 ID')
    return withTimeout(rm().deleteGroupFile(code, uuid, parent), '删群文件', 15000).then(function (r) {
      var res = ((r && r.groupFileCommonResult) || {})
      if (Number(r && r.result) !== 0 || Number(res.retCode) !== 0) {
        throw new Error('删除群文件失败：' + (res.retCode ?? (r && r.result)) + ' ' + (res.retMsg || ''))
      }
      return '已删除群 ' + code + ' 的文件 ' + uuid.slice(0, 16) + '…'
    })
  }

  /* 改群文件名（5 参），结果回执同样要求真 uuid */
  OPS.groupFileRename = function (a) {
    var code = String((a && a.id) || '')
    var uuid = String((a && (a.fileId || a.uuid)) || '')
    var name = String((a && (a.name || a.fileName)) || '')
    var parent = String((a && (a.folderId || '/')) || '/')
    if (!code || !uuid || !name) throw new Error('需要群号 + fileId + 新文件名')
    return withTimeout(rm().renameGroupFile(code, uuid, name, parent, '/'), '改文件名', 15000).then(function (r) {
      var res = ((r && r.groupFileCommonResult) || {})
      if (Number(r && r.result) !== 0 || Number(res.retCode) !== 0) {
        throw new Error('重命名群文件失败：' + (res.retCode ?? (r && r.result)) + ' ' + (res.retMsg || ''))
      }
      return '已把 ' + uuid.slice(0, 16) + '… 改名为「' + name + '」'
    })
  }

  /* 移动群文件（5 参） */
  OPS.groupFileMove = function (a) {
    var code = String((a && a.id) || '')
    var uuid = String((a && (a.fileId || a.uuid)) || '')
    var dest = String((a && (a.folderId || '/')) || '/')
    var src = String((a && (a.fromFolderId || '/')) || '/')
    if (!code || !uuid) throw new Error('需要群号 + fileId')
    return withTimeout(rm().moveGroupFile(code, uuid, dest, src, '/'), '移动文件', 15000).then(function (r) {
      var res = ((r && r.groupFileCommonResult) || {})
      if (Number(r && r.result) !== 0 || Number(res.retCode) !== 0) {
        throw new Error('移动群文件失败：' + (res.retCode ?? (r && r.result)) + ' ' + (res.retMsg || ''))
      }
      return '已把 ' + uuid.slice(0, 16) + '… 移到 ' + dest
    })
  }

  /* 登记进实验台功能表 */
  try {
    var META = globalThis.__fl_ops_meta
    if (META && META.push) {
      META.push(
        { group: 'group', name: 'groupSpace', desc: '群文件空间' },
        { group: 'group', name: 'groupFileCount', desc: '群文件数' },
        { group: 'group', name: 'groupFolderCreate', desc: '建群文件夹' },
        { group: 'group', name: 'groupFolderDelete', desc: '删群文件夹' },
        { group: 'group', name: 'groupFileDelete', desc: '删群文件' },
        { group: 'group', name: 'groupFileRename', desc: '改群文件名' },
        { group: 'group', name: 'groupFileMove', desc: '移动群文件' }
      )
      __fl_emit(JSON.stringify({ evt: 'ops-ready', n: META.length }))
    }
  } catch (e) {}
})()
;
