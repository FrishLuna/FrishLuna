(function () {
  if (globalThis.__fl_inbound) return
  var IB = globalThis.__fl_inbound = {
    v: 3,
    ready: false,
    count: 0,
    dropped: 0,
    dup: 0,
    errs: [],
    shape: null,          /* 首条消息的字段实况，只记一次 */
    deleteShape: null     /* 撤回回调的实参形状，只记一次 */
  }

  function emit (o) { try { __fl_emit(JSON.stringify(o)) } catch (e) {} }
  function err (where, e) {
    var m = where + ': ' + (e && e.message ? e.message : String(e))
    IB.errs.push(m)
    if (IB.errs.length > 20) IB.errs.shift()
    emit({ evt: 'inbound-err', e: m })
  }

  /* 200 × 500ms = 100 秒；单测可用 globalThis.__fl_inbound_max_tries 调小 */
  var MAX_TRIES = (typeof globalThis.__fl_inbound_max_tries === 'number' && globalThis.__fl_inbound_max_tries > 0)
    ? globalThis.__fl_inbound_max_tries
    : 1800
  var tries = 0
  var warned = false
  /* 不设「放弃」：扫码登录可能比 100 秒慢得多，早放弃会让收消息能力永久丢失。
     等太久只打一条警告，轮询继续（每 500ms 一次，开销可忽略）。 */
  var timer = setInterval(function () {
    tries++
    var s = globalThis.__fl_session
    if (!s) {
      if (!warned && tries > MAX_TRIES) { warned = true; err('wait', 'session 迟迟未出现，继续等待（不放弃）') }
      return
    }

    var ms = null
    try { ms = s.getMsgService() } catch (e) { }
    if (!ms) {
      if (!warned && tries > MAX_TRIES) { warned = true; err('wait', '消息服务迟迟未就绪，继续等待（不放弃）') }
      return
    }

    /* 探针只作诊断、不拦路：getRecentContactListSync
       在 9.9.36 恒返回 errMsg/errCode（「查询死」），拿它当 attach 门槛
       会让 ready 永远 false。ms 非 null 就直接挂监听；空壳挂了收不到
       也无害（count 恒 0，状态可见），不再用 100 秒轮询烧机会。 */
    if (!IB.probed) {
      IB.probed = true
      var probe = null
      try { probe = s.getRecentContactService().getRecentContactListSync() } catch (e) {}
      emit({
        evt: 'inbound-probe',
        probe: probe ? String(probe.errMsg || probe.errCode || 'ok') : 'null',
        msType: typeof ms
      })
    }

    clearInterval(timer)
    attach(ms)
  }, 500)

  function giveUp (lastErr) {
    var msg = '等了 ' + Math.round(MAX_TRIES / 2) + ' 秒仍没拿到可用 msg service：' + (lastErr || '未知原因')
    err('wait', msg)
    emit({ evt: 'inbound-timeout', tries: tries, lastErr: String(lastErr || '') })
  }

  function attach (ms) {
    if (IB.ready) return
    /* 重载防护：上一代监听器先摘（支持就摘干净），摘不掉也要让它闭嘴 ——
       只认「当代」IB，旧闭包收到回调直接丢弃，避免一条消息报两次 */
    var prev = globalThis.__fl_inbound_listener
    if (prev) {
      try { ms.removeKernelMsgListener(prev) } catch (e) {}
    }
    var listener = {
      onRecvMsg: function (msgList) { onList(msgList) },
      onRecvMsgSvrWithMsgArgs: function (msgList) { onList(msgList) },
      /* 本体自己发出去的消息不会走 onRecvMsg（内核只投递收到的），
         但本地消息列表更新里带着它 —— 在这里补一次。 */
      onMsgInfoListUpdate: function (arg) { onSelfList(arg) },
      onMsgDelete: function () { onDelete(arguments) }
    }
    globalThis.__fl_inbound_listener = listener
    try {
      ms.addKernelMsgListener(listener)
      IB.ready = true
      emit({ evt: 'inbound-ready' })
    } catch (e) { err('addKernelMsgListener', e) }
  }

  function toArray (x) {
    if (!x) return []
    if (Array.isArray(x)) return x
    if (typeof x.forEach === 'function' && typeof x.get === 'function') {
      var out = []
      try { x.forEach(function (v) { out.push(v) }) } catch (e) {}
      return out
    }
    if (typeof x === 'object') {
      var o = []
      Object.keys(x).forEach(function (k) { o.push(x[k]) })
      return o
    }
    return []
  }

  /* 元素类型号（NTQQ ElementType）：1 文本 2 图片 3 文件 4 语音 5 视频 6 表情 7 回复
     8 群文件 9 红包 10 ark 卡片 11 合并转发 14 markdown */
  var TYPE_NAME = {
    1: 'text', 2: 'image', 3: 'file', 4: 'record', 5: 'video', 6: 'face',
    7: 'reply', 8: 'file', 9: 'redbag', 10: 'ark', 11: 'forward', 14: 'markdown'
  }

  /* 占位文本：一条消息就算全是媒体也要能上报，不许整条丢掉 */
  function describeEl (el) {
    if (!el) return null
    var t = (typeof el.elementType === 'number') ? el.elementType : null
    var r = { type: t, kind: TYPE_NAME[t] || 'unknown', text: '' }

    if (el.textElement && typeof el.textElement.content === 'string') {
      r.text = el.textElement.content
    } else if (el.atElement) {
      var u = String(el.atElement.atNtUid || el.atElement.uid || el.atElement.atUid || '')
      r.text = (u === 'all' || el.atElement.atType === 2) ? '@全体成员' : '@' + u
    } else if (el.faceElement) {
      r.text = '[表情]'
    } else if (el.marketFaceElement) {
      r.text = '[表情]'
    } else if (el.picElement) {
      r.text = '[图片]'
    } else if (el.videoElement) {
      r.text = '[视频]'
    } else if (el.pttElement) {
      r.text = '[语音]'
    } else if (el.fileElement) {
      r.text = '[文件]'
    } else if (el.arkElement) {
      r.text = '[卡片]'
    } else if (el.multiMsgElement) {
      r.text = '[聊天记录]'
    } else if (el.markdownElement) {
      r.text = '[卡片]'
    } else if (el.replyElement) {
      r.text = ''                      /* 引用本身没有内容，只记类型 */
    } else {
      r.text = '[元素:' + (t === null ? '?' : t) + ']'
    }
    return r
  }

  /* 消息体字段名：发送侧构造用 msgElements，收侧有的版本叫 elements。
     两处统一在 msgElements 优先、elements 兜底；首条消息把实况记一次，方便回看。 */
  function elementsOf (m) {
    var a = toArray(m && m.msgElements)
    if (a.length) return { els: a, field: 'msgElements' }
    var b = toArray(m && m.elements)
    if (b.length) return { els: b, field: 'elements' }
    return { els: [], field: 'none' }
  }

  function noteShapeOnce (tag, args) {
    var shape = []
    for (var i = 0; i < args.length && i < 4; i++) {
      var a = args[i]
      if (a === null || a === undefined) { shape.push(String(a)); continue }
      if (Array.isArray(a)) { shape.push('array(' + a.length + ')'); continue }
      if (typeof a === 'object') {
        var ks = []
        try { ks = Object.keys(a) } catch (e) {}
        shape.push('object{' + ks.slice(0, 10).join(',') + '}')
      } else shape.push(typeof a)
    }
    emit({ evt: 'msg-delete-shape', tag: tag, shape: shape })
  }

  /* 去重：onRecvMsg 与 onRecvMsgSvrWithMsgArgs 都接到 onList，内核对同一条
     消息可能回调两次。按 msgId 去重，保证「一条真实消息只上报一次」。 */
  var seen = {}
  var seenN = 0
  function isDup (mid) {
    if (!mid) return false
    if (seen[mid]) return true
    if (seenN >= 512) { seen = {}; seenN = 0 }
    seen[mid] = true
    seenN++
    return false
  }

  /* 本体消息补挂：本地消息列表更新（onMsgInfoListUpdate）会把「自己刚发出去」
     的那条也带过来，sendType === 1 就是这个标记（0 = 别人发的，实机对照过）。
     两条限制防止误伤：
       1) 只认 sendType === 1，别人发的仍旧只走 onRecvMsg，不会重复上报；
       2) 只认 120 秒内的新消息 —— 翻历史、登录补数据也会触发这个回调，
          不加时间窗会把陈年旧消息当成刚发的再处理一遍。 */
  var SELF_ECHO_WINDOW_MS = 120000
  function msgTimeMs (m) {
    var t = Number(m && m.msgTime) || 0
    if (!t) return 0
    return t > 1e12 ? t : t * 1000          /* 秒 / 毫秒两种都吃 */
  }

  function onSelfList (arg) {
    if (globalThis.__fl_inbound !== IB) return
    var arr = toArray(arg)
    if (!arr.length) return
    var pick = []
    var now = Date.now()
    for (var i = 0; i < arr.length; i++) {
      var m = arr[i]
      if (!m) continue
      if (Number(m.sendType) !== 1) continue
      var mid = String(m.msgId || '')
      if (mid && seen[mid]) continue
      var t = msgTimeMs(m)
      if (t && now - t > SELF_ECHO_WINDOW_MS) continue
      pick.push(m)
    }
    if (!pick.length) return
    IB.selfN = (IB.selfN || 0) + pick.length
    onList(pick)
  }

  function onList (msgList) {
    if (globalThis.__fl_inbound !== IB) return   /* 过代监听器：已被重载取代，静默 */
    var arr = toArray(msgList)
    for (var i = 0; i < arr.length; i++) {
      var m = arr[i]
      try {
        if (!m) continue
        var mid = String(m.msgId || '')
        if (isDup(mid)) { IB.dup++; continue }
        var chatType = Number(m.chatType)
        var peer = String(m.peerUid || '')
        var sender = String(m.senderUid || '')

        var eo = elementsOf(m)
        if (!IB.shape) {
          var keys = []
          try { keys = Object.keys(m) } catch (e) {}
          IB.shape = { field: eo.field, keys: keys.slice(0, 30) }
          emit({ evt: 'inbound-shape', field: eo.field, keys: IB.shape.keys })
        }

    var parts = []
    var rawTypes = []
    eo.els.forEach(function (el) {
      var d = describeEl(el)
      if (!d) return
      if (d.type !== null) rawTypes.push(d.type)
      else if (d.kind !== 'unknown') rawTypes.push(d.kind)
      if (d.text) parts.push(d.text)
    })


        IB.count++      /* 每条都计数，媒体消息不再被静默丢弃 */

        /* 最近会话缓存：内核 recentContact service 是空壳，recentList
           从这里读（每会话只留最新一条，最多 30 个）。 */
        try {
          var RC = globalThis.__fl_recent = globalThis.__fl_recent || { q: [] }
          var rtype = chatType === 2 ? 'group' : 'private'
          RC.q = RC.q.filter(function (x) { return !(x && x.type === rtype && x.id === peer) })
          RC.q.unshift({
            type: rtype,
            id: peer,
            name: String(m.peerName || m.chatName || ''),
            last: {
              uin: sender,
              nick: String(m.sendMemberName || m.sendNickName || ''),
              text: parts.join(''),
              msgId: mid,
              msgSeq: String(m.msgSeq || ''),
              at: Date.now()
            }
          })
          if (RC.q.length > 30) RC.q.length = 30
        } catch (e) { /* 缓存失败不影响消息转发 */ }

        emit({
          evt: 'msg',
          chat: { type: chatType === 2 ? 'group' : 'private', id: peer },
          peerName: String(m.peerName || m.chatName || ''),
          /* 本体自发的消息带 senderUin（真 QQ 号），收到的群消息一般只有 uid —— 有就用 */
          uin: (Number(m.senderUin) || 0) ? String(m.senderUin) : sender,
          senderUid: sender,
          nick: String(m.sendMemberName || m.sendNickName || ''),
          text: parts.join('').slice(0, 1000),
          rawTypes: rawTypes.slice(0, 32),
          msgId: String(m.msgId || ''),
          msgSeq: String(m.msgSeq || ''),
          self: Number(m.sendType) === 1,
          at: Date.now()
        })
      } catch (e) { err('parse', e) }
    }
  }

  /* 撤回
   * kernel 的 onMsgDelete 在不同版本里参数个数不一样（(peer, msgList) / (msgList)），
   * 这里不猜死：把实参形状记一次，再按「哪个位置是数组」自己找消息。
   */
  function onDelete (args) {
    if (globalThis.__fl_inbound !== IB) return
    try {
      if (!IB.deleteShape) {
        noteShapeOnce('delete', args)
        IB.deleteShape = true
      }
      var list = null
      var peer = null
      for (var i = 0; i < args.length && i < 4; i++) {
        var a = args[i]
        if (!a) continue
        if (Array.isArray(a)) { if (!list) list = a; continue }
        if (typeof a === 'object') {
          /* 有可能是单条 msg，也有可能是 peer */
          if (a.msgId !== undefined || a.msgSeq !== undefined) {
            if (!list) list = [a]
          } else if (a.peerUid !== undefined || a.chatType !== undefined) {
            peer = a
          }
        }
      }
      if (!list || !list.length) return
      list.forEach(function (m) {
        if (!m) return
        var chat = {
          type: Number((peer && peer.chatType) || m.chatType) === 2 ? 'group' : 'private',
          id: String((peer && peer.peerUid) || m.peerUid || '')
        }
        emit({
          evt: 'msg-recall',
          chat: chat,
          msgId: String(m.msgId || ''),
          msgSeq: String(m.msgSeq || ''),
          at: Date.now()
        })
      })
    } catch (e) { err('msgDelete', e) }
  }

  /* 发送
   * 唯一实现是 ops.js 的 OPS.send（4 参 sendMsg + result===0 判成功）。
   * 这里只做形状转换和结果回传，不再有任何「变体猜测」。
   */
  globalThis.__fl_send = function (to, text) {
    var OPS = globalThis.__fl_ops
    var type = (to && to.type === 'group') ? 'group' : 'private'
    var id = String((to && to.id) || '')
    if (!OPS || typeof OPS.send !== 'function') {
      var e0 = new Error('ops.js 未加载，没有发送通道')
      err('send', e0)
      return Promise.reject(e0)
    }
    var p
    try {
      p = OPS.send({ type: type, id: id, text: String(text == null ? '' : text) })
    } catch (e) {
      err('send', e)
      return Promise.reject(e)
    }
    return Promise.resolve(p).then(function (r) {
      emit({ evt: 'send-ok', to: type + ':' + id })
      return r
    }, function (e) {
      var m = (e && e.message) ? e.message : String(e)
      err('send', m)
      emit({ evt: 'send-fail', to: type + ':' + id, e: m, code: (e && e.code) })
      throw e
    })
  }
})();
