(function () {
  if (globalThis.__fl_qzone) return
  globalThis.__fl_qzone = true

  var OPS = globalThis.__fl_ops
  if (!OPS) return

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
    throw new Error('底层通信服务未就绪，暂无法发送该请求')
  }

  /* protobuf 写入（同 longmsg.js 口径） */

  function vi (n) {
    var out = []
    var v = Number(n)
    if (!isFinite(v) || v < 0) v = 0
    v = Math.floor(v)
    while (v >= 128) { out.push((v % 128) + 128); v = Math.floor(v / 128) }
    out.push(v)
    return out
  }
  function tagOf (f, w) { return vi(Number(f) * 8 + Number(w)) }
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
  function pbB (f, arr) {
    var a = toBytes(arr)
    return tagOf(f, 2).concat(vi(a.length), a)
  }
  function pbS (f, str) {
    if (str == null || str === '') return []
    var buf
    if (typeof Buffer !== 'undefined') buf = Buffer.from(String(str), 'utf8')
    else buf = Array.prototype.slice.call(new TextEncoder().encode(String(str)))
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

  /* protobuf 读取 */

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
  function all (fields, f) { return fields[f] || [] }
  function num (fields, f) { var v = one(fields, f); return typeof v === 'number' ? v : 0 }
  function str (fields, f) {
    var v = one(fields, f)
    if (!v) return ''
    if (typeof Buffer !== 'undefined') return Buffer.from(v).toString('utf8')
    return String.fromCharCode.apply(null, v)
  }

  /* 裸包收发（Buffer 通道，同 media.js sso()） */

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

  function sendRaw (cmdName, bytes) {
    needHook()
    var ms = needSession().getMsgService()
    if (!ms || typeof ms.sendSsoCmdReqByContend !== 'function') {
      throw new Error('当前 QQ 版本缺少底层发包接口')
    }
    /* OIDB 必须 Buffer：Uint8Array 会被 coerce 成字符串 → 145 */
    var buf = Buffer.from(bytes)
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
        Promise.resolve(ms.sendSsoCmdReqByContend(cmdName, buf)).then(done(function (r) {
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

  /* OidbBase 信封 */

  function oidbEnv (cmd, sub, body) {
    /* 与 media.js applyUpload 一致：{1:cmd, 2:sub, 4:body}；0 值不写 */
    return cat(pbU(1, cmd), pbU(2, sub), pbB(4, body))
  }

  function oidbCmdName (cmd, sub) {
    return 'OidbSvcTrpcTcp.0x' + cmd.toString(16) + '_' + sub
  }

  /* 发一条 OIDB：成功 resolve body 字段（可能为 null），信封 errorCode≠0 时 reject */
  function oidbCall (cmd, sub, body) {
    return sendRaw(oidbCmdName(cmd, sub), oidbEnv(cmd, sub, body)).then(function (r) {
      if (!r.raw) throw new Error('OIDB 0x' + cmd.toString(16) + '_' + sub + ' 无回执：' + (r.errMsg || ''))
      if (r.result && r.result !== 0) throw new Error('数据发送失败（' + r.result + '）' + r.errMsg)
      var env = rd(r.raw)
      var errCode = num(env, 3)
      if (errCode) throw new Error('OIDB 0x' + cmd.toString(16) + '_' + sub + ' 服务器拒绝请求（' + errCode + '）：' + str(env, 5))
      return one(env, 4)
    })
  }

  /* 0x102A：clientKey / pskey */

  OPS.oidbClientKey = function () {
    return oidbCall(0x102A, 1, []).then(function (body) {
      if (!body) throw new Error('clientKey 响应没有数据体')
      var d = rd(body)
      var key = str(d, 3)
      if (!key) throw new Error('clientKey 为空')
      return { clientKey: key, keyIndex: String(num(d, 2) || 19), expireTime: num(d, 4) }
    })
  }

  OPS.oidbPskey = function (args) {
    var domains = (args && args.domains) || ['qzone.qq.com']
    if (!Array.isArray(domains) || !domains.length) throw new Error('domains 必须是非空数组')
    var body = []
    for (var i = 0; i < domains.length; i++) body = cat(body, pbS(1, String(domains[i])))
    return oidbCall(0x102A, 0, body).then(function (out) {
      if (!out) throw new Error('pskey 响应没有数据体')
      var d = rd(out)
      var items = []
      var list = all(d, 1)
      for (var j = 0; j < list.length; j++) {
        var it = rd(list[j])
        items.push({ domain: str(it, 1), pskey: str(it, 2), expireTime: num(it, 3) })
      }
      return { items: items }
    })
  }

  /* 0x929D：AI 语音角色列表 */

  OPS.aiVoiceList = function (args) {
    var a = args || {}
    var group = Number(a.group)
    if (!/^\d{5,12}$/.test(String(a.group || ''))) throw new Error('group 必须是群号')
    var chatType = Number(a.chatType) || 1 /* 1=聊天 2=唱歌 */
    var body = cat(pbU(1, group), pbU(2, chatType))
    return oidbCall(0x929D, 0, body).then(function (out) {
      if (!out) throw new Error('AI 语音列表响应没有数据体')
      var d = rd(out)
      var categories = []
      var list = all(d, 1)
      for (var i = 0; i < list.length; i++) {
        var cd = rd(list[i])
        var voices = []
        var vl = all(cd, 2)
        for (var j = 0; j < vl.length; j++) {
          var vd = rd(vl[j])
          voices.push({
            voiceId: str(vd, 1),
            voiceDisplayName: str(vd, 2),
            voiceExampleUrl: str(vd, 3)
          })
        }
        categories.push({ category: str(cd, 1), voices: voices })
      }
      return { chatType: chatType, categories: categories }
    })
  }

  /* 0x929B：合成 AI 语音（轮询到节点出现） */

  function sleep (ms) {
    return new Promise(function (res) { setTimeout(res, ms) })
  }

  function parseVoiceNode (out) {
    if (!out) return null
    var d = rd(out)
    var msgInfo = one(d, 4)
    if (!msgInfo) return null
    var mi = rd(msgInfo)
    var bodies = all(mi, 1)
    if (!bodies.length) return null
    var b0 = rd(bodies[0])
    var idxRaw = one(b0, 1)
    if (!idxRaw) return null
    var ix = rd(idxRaw)
    var node = {
      fileUuid: str(ix, 2),
      storeId: num(ix, 3),
      uploadTime: num(ix, 4),
      ttl: num(ix, 5),
      subType: num(ix, 6),
      info: null
    }
    var infoRaw = one(ix, 1)
    if (infoRaw) {
      var inf = rd(infoRaw)
      node.info = {
        fileSize: num(inf, 1),
        fileName: str(inf, 4),
        md5: str(inf, 2),
        time: num(inf, 8),
        type: null
      }
      var tRaw = one(inf, 5)
      if (tRaw) {
        var td = rd(tRaw)
        node.info.type = { type: num(td, 1), voiceFormat: num(td, 4) }
      }
    }
    return node
  }

  OPS.aiVoice = function (args) {
    var a = args || {}
    if (!/^\d{5,12}$/.test(String(a.group || ''))) throw new Error('group 必须是群号')
    var voiceId = String(a.voiceId || a.character || '')
    if (!voiceId) throw new Error('voiceId 必填')
    var text = String(a.text || '')
    if (!text) throw new Error('text 必填')
    var chatType = Number(a.chatType) || 1
    var maxPolls = Number(a.maxPolls) || 30
    var group = Number(a.group)
    /* 随机 32 位 sessionId，服务端用它去重同一次合成的多次轮询 */
    var sessionId = Math.floor(Math.random() * 0xffffffff) >>> 0
    var body = cat(
      pbU(1, group),
      pbS(2, voiceId),
      pbS(3, text),
      pbU(4, chatType),
      pbB(5, pbU(1, sessionId))
    )
    var lastStatus = -1
    var polls = 0
    function attempt () {
      return oidbCall(0x929B, 0, body).then(function (out) {
        polls++
        var d = out ? rd(out) : {}
        lastStatus = num(d, 1)
        var node = parseVoiceNode(out)
        if (node) return { polls: polls, status: lastStatus, node: node }
        if (polls >= maxPolls) {
          throw new Error('AI 语音合成 ' + maxPolls + ' 次轮询后仍未完成（statusCode=' + lastStatus + '）')
        }
        return sleep(400).then(attempt)
      })
    }
    return attempt()
  }

  /* 通用 OIDB 通道（闪传等 app 侧拼包协议用）
   * args: { cmd, sub, bodyHex, uinForm } → 信封 {1:cmd,2:sub,4:body[,12:1]}，
   * 返回 { bodyHex, errCode, errMsg }。body 由 app 侧构造（flash.js 有带
   * 显式零值的 pb 编码器），payload 只负责收发与信封拆包。 */
  function hexToBuffer (h) {
    var out = []
    var s = String(h || '')
    for (var i = 0; i + 1 < s.length; i += 2) out.push(parseInt(s.substr(i, 2), 16))
    return out
  }
  function bytesToHex (a) {
    var s = ''
    var b = toBytes(a)
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16)
    return s
  }
  OPS.oidbRaw = function (args) {
    var a = args || {}
    var cmd = Number(a.cmd)
    var sub = Number(a.sub) || 0
    if (!(cmd > 0)) throw new Error('cmd 必须是正整数')
    var body = hexToBuffer(a.bodyHex)
    var env = cat(pbU(1, cmd), pbU(2, sub), pbB(4, body))
    if (a.uinForm) env = cat(env, pbU(12, 1))
    /* 群打卡 0xEB7 的服务端兼容大写 wire 名 */
    var name = a.wireName
      ? String(a.wireName)
      : 'OidbSvcTrpcTcp.0x' + cmd.toString(16) + '_' + sub
    return sendRaw(name, env).then(function (r) {
      if (!r.raw) throw new Error('OIDB ' + name + ' 无回执：' + (r.errMsg || ''))
      if (r.result && r.result !== 0) throw new Error('数据发送失败（' + r.result + '）' + r.errMsg)
      var e = rd(r.raw)
      return { bodyHex: bytesToHex(one(e, 4) || []), errCode: num(e, 3), errMsg: str(e, 5) }
    })
  }

  /* 通用裸包通道：任意 SSO cmd 直发（LightAppSvc.mini_app_share、trpc.SetStatus 等
     非 OIDB 信封的命令用）。请求/响应都是十六进制，app 侧自己组包解包。 */
  OPS.ssoRaw = function (args) {
    var a = args || {}
    var cmd = String(a.cmd || '')
    if (!cmd) throw new Error('cmd 不能为空')
    return sendRaw(cmd, hexToBuffer(a.bodyHex)).then(function (r) {
      if (r.result && r.result !== 0) throw new Error('数据发送失败（' + r.result + '）' + (r.errMsg || ''))
      if (!r.raw) throw new Error('无回执：' + (r.errMsg || ''))
      return { rawHex: bytesToHex(r.raw), errMsg: r.errMsg || '' }
    })
  }

  OPS.qzoneInfo = function () {
    return {
      module: 'qzone.js',
      oidb: 'QQ 空间数据连接',
      cmds: ['0x102A_1 clientKey', '0x102A_0 pskey', '0x929D_0 voiceList', '0x929B_0 voice', '内部数据连接']
    }
  }
})()
