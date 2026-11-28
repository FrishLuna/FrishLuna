(function () {
  if (globalThis.__fl_longmsg) return
  globalThis.__fl_longmsg = true

  var OPS = globalThis.__fl_ops
  if (!OPS) return

  function nodeReq (m) {
    try { if (typeof require === 'function') return require(m) } catch (e) {}
    try { if (typeof globalThis.require === 'function') return globalThis.require(m) } catch (e) {}
    try {
      if (typeof process !== 'undefined' && process.mainModule && typeof process.mainModule.require === 'function') {
        return process.mainModule.require.bind(process.mainModule)(m)
      }
    } catch (e) {}
    return null
  }

  var zlib = null
  try { zlib = nodeReq('zlib') } catch (e) {}

  function needSession () {
    var s = globalThis.__fl_session
    if (!s && typeof globalThis.__fl_resolve_session === 'function') {
      try { s = globalThis.__fl_resolve_session() } catch (e) {}
    }
    if (!s) throw new Error('QQ 尚未登录完成，请稍后重试')
    return s
  }

  function needHook () {
    if (globalThis.__fl_hook_installed) return true
    if (typeof OPS.ensureHook === 'function' && OPS.ensureHook()) return true
    var st = typeof OPS.hookState === 'function' ? OPS.hookState() : null
    throw new Error('底层通信服务未就绪，暂无法发送该请求' + (st && st.msg ? '：' + st.msg : ''))
  }

  /* protobuf 写入
   * 字节数组（普通 Array）而非 Uint8Array：拼接方便，最后一次性 Uint8Array.from。
   * 注意 QQ 号常超 2^31，varint 必须用 % / floor，不能位运算。 */

  function vi (n) {
    var out = []
    var v = Number(n)
    if (!isFinite(v) || v < 0) v = 0
    v = Math.floor(v)
    while (v >= 128) {
      out.push((v % 128) + 128)
      v = Math.floor(v / 128)
    }
    out.push(v)
    return out
  }

  function tagOf (f, w) { return vi(Number(f) * 8 + Number(w)) }

  /* varint 字段：0 不写（protobuf 默认值口径） */
  function pbU (f, n) {
    if (n == null) return []
    var v = Number(n)
    if (!isFinite(v) || v === 0) return []
    return tagOf(f, 0).concat(vi(v))
  }

  function toBytes (x) {
    if (!x) return []
    if (Array.isArray(x)) return x
    var out = []
    for (var i = 0; i < x.length; i++) out.push(x[i] & 0xff)
    return out
  }

  /* 长度前缀消息 / bytes */
  function pbB (f, arr) {
    var a = toBytes(arr)
    return tagOf(f, 2).concat(vi(a.length), a)
  }

  /* UTF-8 字符串（中文字段必须走这个，不能 charCodeAt & 0xff） */
  function pbS (f, str) {
    if (str == null || str === '') return []
    var buf
    if (typeof Buffer !== 'undefined') buf = Buffer.from(String(str), 'utf8')
    else {
      var enc = new TextEncoder().encode(String(str))
      buf = Array.prototype.slice.call(enc)
    }
    return pbB(f, buf)
  }

  function cat () {
    var out = []
    for (var i = 0; i < arguments.length; i++) {
      var a = arguments[i]
      if (!a) continue
      for (var j = 0; j < a.length; j++) out.push(a[j])
    }
    return out
  }

  /* protobuf 读取
   * 只做「树形解一层」的通用解码：varint / length-delimited，够解 trpc 回执。 */

  function rd (bytes) {
    var buf = toBytes(bytes)
    var p = 0
    var fields = {}
    function varint () {
      var v = 0
      var sh = 0
      var b
      do {
        if (p >= buf.length) throw new Error('protobuf 截断')
        b = buf[p++]
        v += (b & 0x7f) * Math.pow(2, sh)
        sh += 7
      } while (b & 0x80)
      return v
    }
    while (p < buf.length) {
      var t = varint()
      var f = Math.floor(t / 8)
      var w = t & 7
      if (f === 0) break
      if (w === 0) {
        if (!fields[f]) fields[f] = []
        fields[f].push(varint())
      } else if (w === 2) {
        var len = varint()
        if (p + len > buf.length) throw new Error('protobuf 字段截断')
        var seg = buf.slice(p, p + len)
        p += len
        if (!fields[f]) fields[f] = []
        fields[f].push(seg)
      } else if (w === 5) { p += 4 } else if (w === 1) { p += 8 } else break
    }
    return fields
  }

  function one (fields, f) { var a = fields[f]; return a && a.length ? a[a.length - 1] : null }
  function firstNum (fields, f) { var v = one(fields, f); return typeof v === 'number' ? v : 0 }
  function bytesToStr (arr) {
    if (!arr) return ''
    if (typeof Buffer !== 'undefined') return Buffer.from(arr).toString('utf8')
    return String.fromCharCode.apply(null, arr)
  }

  var CMD_SEND = 'trpc.group.long_msg_interface.MsgService.SsoSendLongMsg'
  var CMD_RECV = 'trpc.group.long_msg_interface.MsgService.SsoRecvLongMsg'

  function hookTakeRsp () {
    try {
      var m = globalThis.__fl_napi2native
      if (m && typeof m.takeRsp === 'function') {
        var t = m.takeRsp()
        if (typeof t === 'string' && t.length) {
          var out = []
          for (var i = 0; i < t.length; i++) out.push(t.charCodeAt(i) & 0xff)
          return out
        }
        if (t && typeof t.length === 'number' && t.length) return toBytes(t)
      }
    } catch (e) {}
    return null
  }

  /**
   * 发一条裸 SSO 包，回执走 takeRsp（无损）。
   * resolve { result, errMsg, raw }，raw 是字节数组（可能为 null：回执迟到）。
   */
  function sendRaw (cmd, bytes) {
    needHook()
    var ms = needSession().getMsgService()
    if (!ms || typeof ms.sendSsoCmdReqByContend !== 'function') {
      throw new Error('当前 QQ 版本缺少底层发包接口')
    }
    var arr = Uint8Array.from(bytes)
    return new Promise(function (resolve, reject) {
      var settled = false
      var timer = setTimeout(function () {
        if (settled) return
        settled = true
        resolve({ result: 0, errMsg: '回执未到（8s 静默）', raw: null, late: true })
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
        Promise.resolve(ms.sendSsoCmdReqByContend(cmd, arr)).then(done(function (r) {
          var raw = hookTakeRsp()
          if (!raw) {
            var s = r && (r.rspbuffer || r.rsp)
            if (typeof s === 'string' && s.length) {
              raw = []
              for (var i = 0; i < s.length; i++) raw.push(s.charCodeAt(i) & 0xff)
            } else if (s && typeof s.length === 'number') raw = toBytes(s)
          }
          resolve({
            result: Number((r && r.result) != null ? r.result : 0),
            errMsg: String((r && r.errMsg) || ''),
            raw: raw
          })
        }), done(function (e) {
          reject(new Error('底层请求发送失败：' + ((e && e.message) || e)))
        }))
      } catch (e) {
        if (!settled) { settled = true; clearTimeout(timer); reject(e) }
      }
    })
  }

  /* Elem{ text{ str } }；pbReserve 用于 @ */
  function elemText (str, reserve) {
    var t = pbS(1, str)
    if (reserve && reserve.length) t = cat(t, pbB(6, reserve))
    return pbB(1, t)
  }

  /* Elem{ face{ index } } */
  function elemFace (id) { return pbB(2, pbU(1, id)) }

  /* MentionExtraSend{ 3:type, 4:uin, 5:field5, 9:uid } */
  function mentionReserve (isAll, uin, uid) {
    return cat(
      pbU(3, isAll ? 1 : 2),
      pbU(4, isAll ? 0 : uin),
      pbU(5, 0),
      pbS(9, isAll ? 'all' : (uid || ''))
    )
  }

  function elemAt (seg, selfUid) {
    var isAll = seg.uid === 'all' || Number(seg.uin) === 0
    var reserve = mentionReserve(isAll, Number(seg.uin) || 0, seg.uid)
    var text = seg.text || (isAll ? '@全体成员 ' : '@' + (seg.name || seg.uin || '') + ' ')
    return elemText(text, reserve)
  }

  /* 单个节点 → PushMsgBody */
  function buildPushBody (node, selfUid) {
    var now = Math.floor(Date.now() / 1000)
    var fromUin = Number(node.uin) > 0 ? Number(node.uin) : Number(selfUin())
    var nickname = String(node.name || '').trim() || String(fromUin)
    var time = Number(node.time) > 0 ? Number(node.time) : now

    var head = cat(
      pbU(1, fromUin),
      pbS(6, selfUid),
      pbB(7, pbS(5, nickname))
    )

    var rnd = Math.floor(Math.random() * 2147483647)
    var seq = Math.floor(Math.random() * 9000000) + 1000000
    var ch = cat(
      pbU(1, 9),          /* msgType */
      pbU(2, 4),          /* subType */
      pbU(3, 0),          /* c2cCmd */
      pbU(4, rnd),        /* msgId */
      pbU(5, seq),        /* sequence */
      pbU(6, time)        /* timestamp */
    )

    var elems = []
    var segs = node.segments && node.segments.length ? node.segments : [{ type: 'text', text: String(node.text || '') }]
    for (var i = 0; i < segs.length; i++) {
      var sg = segs[i]
      if (sg.type === 'text') elems = cat(elems, elemText(String(sg.text || '')))
      else if (sg.type === 'face') elems = cat(elems, elemFace(Number(sg.id) || 0))
      else if (sg.type === 'at') elems = cat(elems, elemAt(sg, selfUid))
      else elems = cat(elems, elemText('[不支持的元素]'))
    }
    if (!elems.length) elems = elemText('')

    var body = pbB(1, pbB(2, elems))   /* MessageBody{ richText{ elems } } */
    return cat(pbB(1, head), pbB(2, ch), pbB(3, body))
  }

  function selfUin () {
    var info = globalThis.__fl_self || null
    return (info && info.uin) || 0
  }

  function buildLongMsgResult (nodes, selfUid) {
    var bodies = []
    for (var i = 0; i < nodes.length; i++) bodies = cat(bodies, pbB(1, buildPushBody(nodes[i], selfUid)))
    var action = cat(
      pbS(1, 'MultiMsg'),
      pbB(2, bodies)
    )
    return pbB(2, action)   /* LongMsgResult{ 2: repeated action } */
  }

  function gzipBytes (arr) {
    if (!zlib || typeof zlib.gzipSync !== 'function') throw new Error('缺少压缩组件，无法打包长消息')
    var buf = zlib.gzipSync(Buffer.from(arr))
    return Array.prototype.slice.call(buf)
  }

  function gunzipBytes (arr) {
    if (!zlib || typeof zlib.gunzipSync !== 'function') throw new Error('缺少解压组件，无法解析长消息')
    return Array.prototype.slice.call(zlib.gunzipSync(Buffer.from(arr)))
  }

  function findOwnUid () {
    var info = globalThis.__fl_self || null
    if (info && info.uid) return Promise.resolve(String(info.uid))
    return Promise.resolve(OPS.selfInfo()).then(function (d) {
      globalThis.__fl_self = d
      if (!d || !d.uid) throw new Error('未能获取自身标识，无法生成长消息')
      return String(d.uid)
    })
  }

  /**
   * 上传合并转发内容，回 resId。
   * args: { type: 'group'|'private', peer: '群号或对方QQ', nodes: [{uin,name,time,text|segments}] }
   */
  OPS.forwardUpload = function (args) {
    var a = args || {}
    var isGroup = a.type !== 'private'
    var peer = String(a.peer || '')
    var nodes = a.nodes || []
    if (!/^\d{5,12}$/.test(peer)) throw new Error('目标必须是 5~12 位数字：' + peer)
    if (!nodes.length) throw new Error('转发节点为空')

    return findOwnUid().then(function (selfUid) {
      var longMsg = buildLongMsgResult(nodes, selfUid)
      var payload = gzipBytes(longMsg)
      var info = cat(
        pbU(1, isGroup ? 3 : 1),
        pbB(2, pbS(2, isGroup ? peer : selfUid)),
        pbU(3, isGroup ? Number(peer) : 0),
        pbB(4, payload)
      )
      var req = cat(
        pbB(2, info),
        pbB(15, cat(pbU(1, 4), pbU(2, 1), pbU(3, 7), pbU(4, 0)))
      )
      return sendRaw(CMD_SEND, req).then(function (r) {
        if (!r.raw || !r.raw.length) {
          throw new Error('上传回执未到：' + (r.errMsg || '无回执'))
        }
        var top = rd(r.raw)
        var result = one(top, 2)
        var resId = ''
        var code = 0
        if (result) {
          var rf = rd(result)
          resId = bytesToStr(one(rf, 3))
          code = firstNum(rf, 1)
        }
        if (!resId) {
          var e = new Error('长消息上传失败：' + (code || r.result) + ' resId 为空' + (r.errMsg ? ' (' + r.errMsg + ')' : ''))
          e.raw = r.raw
          throw e
        }
        return { resId: resId, bytes: longMsg.length, gz: payload.length }
      })
    })
  }

  /**
   * 按 resId 拉回合并转发内容。
   * 回 { resId, nodes: [{uin,name,time,segments}] }
   */
  OPS.forwardFetch = function (args) {
    var a = args || {}
    var resId = String(a.resId || a.res_id || '')
    if (!resId) throw new Error('resId 为空')
    return findOwnUid().then(function (selfUid) {
      var info = cat(
        pbB(1, pbS(2, selfUid)),
        pbS(2, resId),
        pbU(3, 1)
      )
      var req = cat(
        pbB(1, info),
        pbB(15, cat(pbU(1, 2), pbU(2, 0), pbU(3, 0), pbU(4, 0)))
      )
      return sendRaw(CMD_RECV, req).then(function (r) {
        if (!r.raw || !r.raw.length) throw new Error('拉取回执未到：' + (r.errMsg || '无回执'))
        var top = rd(r.raw)
        var result = one(top, 1)
        if (!result) throw new Error('回执没有 result 字段')
        var rf = rd(result)
        var rid = bytesToStr(one(rf, 3))
        var payload = one(rf, 4)
        if (!payload || !payload.length) {
          var errCode = firstNum(rf, 1)
          throw new Error('转发内容获取失败（' + errCode + '）')
        }
        var longMsg = gunzipBytes(payload)
        return { resId: rid || resId, nodes: decodeLongMsg(longMsg) }
      })
    })
  }

  function decodeLongMsg (bytes) {
    var top = rd(bytes)
    var actions = top[2] || []
    var out = []
    for (var i = 0; i < actions.length; i++) {
      var act = rd(actions[i])
      var name = bytesToStr(one(act, 1))
      if (name !== 'MultiMsg') continue
      var data = one(act, 2)
      if (!data) continue
      var bodies = rd(data)[1] || []
      for (var j = 0; j < bodies.length; j++) {
        var n = decodePushBody(bodies[j])
        if (n) out.push(n)
      }
    }
    return out
  }

  function decodePushBody (bytes) {
    var pb = rd(bytes)
    var head = one(pb, 1) ? rd(one(pb, 1)) : {}
    var ch = one(pb, 2) ? rd(one(pb, 2)) : {}
    var body = one(pb, 3) ? rd(one(pb, 3)) : {}
    var rt = one(body, 1) ? rd(one(body, 1)) : {}
    var elems = rt[2] || []
    var segs = []
    for (var i = 0; i < elems.length; i++) segs.push(decodeElem(elems[i]))
    var fwd = one(head, 7) ? rd(one(head, 7)) : {}
    var nm = bytesToStr(one(fwd, 5))
    /* 服务器回执的 friendName 常被改写为空 —— 用 uin 兜底，别让卡片显示空白 */
    if (!nm) nm = firstNum(head, 1) ? String(firstNum(head, 1)) : ''
    return {
      uin: firstNum(head, 1),
      name: nm,
      time: firstNum(ch, 6),
      segments: segs,
      text: segs.map(function (s) { return s.type === 'text' ? s.text : (s.type === 'face' ? '[表情]' : '[' + s.type + ']') }).join('')
    }
  }

  function decodeElem (bytes) {
    var e = rd(bytes)
    if (e[1]) {
      var t = rd(e[1][0])
      return { type: 'text', text: bytesToStr(one(t, 1)) }
    }
    if (e[2]) {
      var f = rd(e[2][0])
      return { type: 'face', id: firstNum(f, 1) }
    }
    if (e[4]) return { type: 'image' }
    if (e[8]) return { type: 'xml' }
    if (e[13]) return { type: 'reply' }
    if (e[14]) return { type: 'json' }
    if (e[15]) return { type: 'common' }
    return { type: 'unknown' }
  }

  /**
   * 取合并转发内容：直接给 resId，或给 msgId（+ 会话定位 type/peer，自己发的卡片
   * 从 arkElement 里解 resid）。
   * args: { resId?, msgId?, type?, peer? }
   */
  OPS.forwardGet = function (args) {
    var a = args || {}
    if (a.resId || a.res_id) return OPS.forwardFetch({ resId: String(a.resId || a.res_id) })
    var msgId = String(a.msgId || '')
    if (!msgId) throw new Error('需要 resId 或 msgId')
    var isGroup = String(a.type || 'group') !== 'private'
    var peer = String(a.peer || '')
    if (!peer) throw new Error('按 msgId 取内容需要 peer（群号/好友号）')
    var ms = needSession().getMsgService()
    var body = { chatType: isGroup ? 2 : 1, peerUid: peer, guildId: '' }
    return Promise.resolve(ms.getMsgsByMsgId(body, [msgId])).then(function (r) {
      var arr = (r && r.msgList) || []
      if (!arr.length) throw new Error('未找到指定消息：' + msgId)
      var els = arr[0].elements || []
      var resid = null
      for (var i = 0; i < els.length; i++) {
        var e = els[i]
        if (e && e.arkElement && e.arkElement.bytesData) {
          try { resid = JSON.parse(String(e.arkElement.bytesData)).meta.detail.resid || null } catch (err) {}
          if (resid) break
        }
        if (e && e.multiForwardMsgElement && e.multiForwardMsgElement.resId) {
          resid = String(e.multiForwardMsgElement.resId)
          break
        }
      }
      if (!resid) throw new Error('该消息不是合并转发卡片（找不到 resid）')
      return OPS.forwardFetch({ resId: resid })
    })
  }

  OPS.forwardInfo = function () {
    return {
      cmds: { send: CMD_SEND, recv: CMD_RECV },
      hook: globalThis.__fl_hook_installed ? 'installed' : 'missing',
      zlib: !!zlib
    }
  }

  /* 卡片发送（sendMsg + arkElement）
   *
   * 约束：
   *   - sendSsoCmdReqByContend('MessageSvc.PbSendMsg') 静默无回调；contend 路径只兼容
   *     trpc.* / OidbSvc.* 前缀（Heartbeat.Alive 同形态直接把 QQ 送崩，勿再试）
   *   - 内核 forward 家族（forwardMsg / multiForwardMsg / multiForwardMsgWithComment /
   *     elementType 16 multiForwardMsgElement / elementType 9 arkElement）一律 result=5
   *   - elementType：Ark=10、MultiForward=16
   * 生路：sendMsg + { elementType: 10, arkElement: { bytesData: multimsg ark JSON } }
   *   resid 指向 SsoSendLongMsg 上传的内容；点开卡片由 QQ 走 SsoRecvLongMsg 拉节点
   *   （与 forwardFetch 同一通道）。
   */

  function uuid () {
    var c = nodeReq('crypto')
    if (c && typeof c.randomUUID === 'function') return c.randomUUID()
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (ch) {
      var r = Math.random() * 16 | 0
      var v = ch === 'x' ? r : (r & 0x3 | 0x8)
      return v.toString(16)
    })
  }

  /* multimsg ark 卡片（com.tencent.multimsg 结构） */
  function buildArkJson (resId, uniseq, source, summary, prompt, news, tSum) {
    return JSON.stringify({
      app: 'com.tencent.multimsg',
      config: { autosize: 1, forward: 1, round: 1, type: 'normal', width: 300 },
      desc: prompt,
      extra: JSON.stringify({ filename: uniseq, tsum: tSum }),
      meta: {
        detail: {
          news: news,
          resid: resId,
          source: source,
          summary: summary,
          uniseq: uniseq
        }
      },
      prompt: prompt,
      ver: '0.0.0.5',
      view: 'contact'
    })
  }

  function nodeSummary (nodes) {
    var tSum = nodes.length
    var nicks = []
    var seen = {}
    var news = []
    for (var i = 0; i < nodes.length; i++) {
      var nm = String(nodes[i].name || '').trim()
      if (nm && !seen[nm] && nicks.length < 4) { seen[nm] = 1; nicks.push(nm) }
      if (news.length < 4) {
        var preview = ''
        var segs = nodes[i].segments || []
        for (var j = 0; j < segs.length; j++) {
          var sg = segs[j]
          if (sg.type === 'text' && sg.text) { preview = String(sg.text).slice(0, 30); break }
          if (sg.type === 'image') { preview = '[图片]'; break }
          if (sg.type === 'face') { preview = '[表情]'; break }
        }
        news.push({ text: (nm || String(nodes[i].uin || 'QQ用户')) + (preview ? ': ' + preview : '') })
      }
    }
    var source = nicks.length ? nicks.join('和') + '的聊天记录' : '聊天记录'
    return { tSum: tSum, source: source, summary: '查看' + tSum + '条转发消息', prompt: '[聊天记录]', news: news }
  }

  /* 发卡片：sendMsg + arkElement(10)。发完在最近 DB 消息里按 uniseq 找回自己的 msgId。
     o.json 直接给卡片 JSON 时走通用卡片通道（B1：send_msg json 段 / 图文卡），
     否则按 multimsg 模板组包。 */
  function arkSend (o) {
    var s = needSession()
    var ms = s.getMsgService()
    var uniseq = uuid()
    var ark = o.json || buildArkJson(o.resId, uniseq, o.source, o.summary, o.prompt, o.news, o.tSum)
    var genMid = function () {
      try {
        var msf = s.getMSFService()
        var t = msf && msf.getServerTime ? msf.getServerTime() : Date.now()
        return String(ms.generateMsgUniqueId(o.isGroup ? 2 : 1, t))
      } catch (e) { return '7' + Date.now() }
    }
    var peer = { chatType: o.isGroup ? 2 : 1, peerUid: String(o.peer), guildId: genMid() }
    /* 通用通道允许混排：{json:...} 走卡片，{text:...} 走文本；缺省整条一张卡 */
    var items = (Array.isArray(o.elements) && o.elements.length)
      ? o.elements
      : [{ json: ark }]
    var els = items.map(function (it) {
      if (it && it.json != null) return { elementType: 10, arkElement: { bytesData: String(it.json) } }
      return { elementType: 1, textElement: { content: String(it && it.text || '') } }
    })
    /* 回执匹配基线：QQ 会重新序列化 ark JSON（键序会变），字符串包含匹配不可靠，
       通用卡片改成发送前后 diff——发之前先记一遍现有消息 id，发之后挑新出现的 ark 消息。
       基线查询必须限时：它卡在 sendMsg 之前，旁挂调用一旦永久 pending 消息就永远发不出去。 */
    var beforeIds = null
    var baselineFailed = false
    var prep = o.generic
      ? Promise.race([
        Promise.resolve(ms.getLatestDbMsgs({ chatType: peer.chatType, peerUid: peer.peerUid, guildId: '' }, 10)),
        new Promise(function (_, rej) { setTimeout(function () { rej(new Error('基线快照超时')) }, 6000) })
      ]).then(function (r) {
        beforeIds = {}
        var arr = (r && r.msgList) || []
        for (var i = 0; i < arr.length; i++) beforeIds[String(arr[i].msgId)] = 1
        return null
      }).catch(function () { baselineFailed = true; return null })
      : Promise.resolve(null)
    return prep.then(function () {
      return Promise.resolve(ms.sendMsg('0', peer, els, new Map())).then(function (v) {
      var result = v && v.result != null ? Number(v.result) : -1
      if (result !== 0) {
        var e = new Error('卡片消息发送失败：' + result + (v && v.errMsg ? ' · ' + v.errMsg : ''))
        e.code = result
        throw e
      }
      /* 回执拿 message_id：multimsg 卡按 uniseq 子串找；通用卡片走发送前后 diff */
      return new Promise(function (res) {
        var needle = o.generic ? null : uniseq
        var to = setTimeout(function () { res({ msgId: null, uniseq: uniseq }) }, 6000)
        try {
          var p = ms.getLatestDbMsgs({ chatType: peer.chatType, peerUid: peer.peerUid, guildId: '' }, 10)
          Promise.resolve(p).then(function (r) {
            clearTimeout(to)
            var arr = (r && r.msgList) || []
            var found = null
            /* 只认本号在这条会话里新发出的卡片：别人或并发请求发的卡片不能当成本次回执，
               基线没建成时宁可返回未知，也不猜一个可能属于别人的 msgId */
            var me = selfUin()
            if (!baselineFailed && beforeIds) {
              for (var i = 0; i < arr.length; i++) {
                var m = arr[i]
                if (beforeIds[String(m.msgId)]) continue
                var mine = Number(m.sendType) === 1 || (me > 0 && Number(m.senderUin) === Number(me))
                if (!mine) continue
                if (m.peerUid && peer.peerUid && String(m.peerUid) !== String(peer.peerUid)) continue
                var els2 = m.elements || []
                for (var k = 0; k < els2.length; k++) {
                  if (els2[k] && els2[k].arkElement && (!needle || String(els2[k].arkElement.bytesData || '').indexOf(needle) >= 0)) {
                    found = m
                    break
                  }
                }
                if (found) break
              }
            }
            res({ msgId: found ? String(found.msgId) : null, uniseq: uniseq })
          }, function () { clearTimeout(to); res({ msgId: null, uniseq: uniseq }) })
        } catch (e) { clearTimeout(to); res({ msgId: null, uniseq: uniseq }) }
      })
      })
    })
  }

  /**
   * 完整合并转发：上传内容 + 发卡片。
   * args: { type, peer, nodes, peerUid? }
   * 私聊必须给 peerUid（对方的 u_ uid）。
   */
  OPS.forwardSend = function (args) {
    var a = args || {}
    var isGroup = a.type !== 'private'
    var peer = String(a.peer || '')
    var nodes = a.nodes || []
    if (!/^\d{5,12}$/.test(peer)) throw new Error('目标必须是 5~12 位数字：' + peer)
    if (!nodes.length) throw new Error('转发节点为空')
    if (!isGroup && !a.peerUid) throw new Error('私聊合并转发需要提供对方的成员标识')

    return OPS.forwardUpload({ type: isGroup ? 'group' : 'private', peer: peer, nodes: nodes }).then(function (up) {
      var meta = nodeSummary(nodes)
      return arkSend({
        isGroup: isGroup,
        peer: isGroup ? peer : (a.peerUid || peer),
        resId: up.resId,
        source: meta.source,
        summary: meta.summary,
        prompt: meta.prompt,
        news: meta.news,
        tSum: meta.tSum
      }).then(function (sent) {
        return {
          resId: up.resId,
          msgId: sent.msgId,
          /* OneBot 层认 message_id 字段名（send_* 分支自动注册进 int32 映射表） */
          message_id: sent.msgId,
          uniseq: sent.uniseq,
          count: nodes.length
        }
      })
    })
  }

  /**
   * 通用 JSON 卡片发送（send_msg json 段的通道底座）。
   * args: { type, peer, json, peerUid? } 或 elements: [{json}|{text}] 混排
   * 私聊必须给 peerUid。走与合并转发同一条 ms.sendMsg + arkElement(10) 生路。
   */
  OPS.arkSendRaw = function (args) {
    var a = args || {}
    var isGroup = a.type !== 'private'
    var peer = String(a.peer || '')
    if (!/^\d{5,12}$/.test(peer)) throw new Error('目标必须是 5~12 位数字：' + peer)
    var els
    if (a.json != null) {
      els = [{ json: String(a.json) }]
    } else if (Array.isArray(a.elements) && a.elements.length) {
      els = a.elements
    } else {
      throw new Error('卡片内容为空：需要 json 或 elements')
    }
    return arkSend({
      isGroup: isGroup,
      peer: isGroup ? peer : (a.peerUid || peer),
      generic: true,
      elements: els
    }).then(function (sent) {
      return {
        msgId: sent.msgId,
        message_id: sent.msgId,
        uniseq: sent.uniseq
      }
    })
  }

  /**
   * 把已有的合并转发（只知 resId 与节点摘要）原样发出去，不重新上传。
   * args: { type, peer, resId, count, source, news, peerUid? }
   */
  OPS.forwardResend = function (args) {
    var a = args || {}
    var isGroup = a.type !== 'private'
    var peer = String(a.peer || '')
    var resId = String(a.resId || '')
    if (!/^\d{5,12}$/.test(peer)) throw new Error('目标必须是 5~12 位数字：' + peer)
    if (!resId) throw new Error('resId 为空')
    if (!isGroup && !a.peerUid) throw new Error('私聊合并转发需要提供对方的成员标识')
    var count = Number(a.count) || 1
    var source = a.source || '聊天记录'
    var news = Array.isArray(a.news) ? a.news : []
    return arkSend({
      isGroup: isGroup,
      peer: isGroup ? peer : (a.peerUid || peer),
      resId: resId,
      source: source,
      summary: '查看' + count + '条转发消息',
      prompt: '[聊天记录]',
      news: news,
      tSum: count
    }).then(function (sent) {
      return { resId: resId, msgId: sent.msgId, message_id: sent.msgId, uniseq: sent.uniseq }
    })
  }
})()
