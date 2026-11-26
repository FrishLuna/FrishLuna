(function () {
  var API = {}

  function nodeReq (m) {
    try { if (typeof require === 'function') return require(m) } catch (e) {}
    try { if (typeof process !== 'undefined' && process.mainModule && typeof process.mainModule.require === 'function') return process.mainModule.require(m) } catch (e) {}
    return null
  }

  var fs = nodeReq('fs')
  var http = nodeReq('http')
  var crypto = nodeReq('crypto')

  function varint (n) {
    var out = []
    var v = Math.floor(Number(n) || 0)
    if (v < 0) v = 0
    while (v >= 128) { out.push((v % 128) + 128); v = Math.floor(v / 128) }
    out.push(v)
    return out
  }
  function tag (f, w) { return varint(f * 8 + w) }
  function fUInt (f, n) {
    var v = Math.floor(Number(n) || 0)
    if (!v) return []
    return tag(f, 0).concat(varint(v))
  }
  function toArr (a) {
    if (!a) return []
    if (Array.isArray(a)) return a
    var out = []
    for (var i = 0; i < a.length; i++) out.push(a[i])
    return out
  }
  function fBytes (f, arr) {
    if (!arr || !arr.length) return []
    var body = toArr(arr)
    return tag(f, 2).concat(varint(body.length), body)
  }
  function fStr (f, s) {
    var str = String(s == null ? '' : s)
    if (!str) return []
    var b = Buffer.from(str, 'utf8')
    var a = []
    for (var i = 0; i < b.length; i++) a.push(b[i])
    return fBytes(f, a)
  }
  function cat () {
    var out = []
    for (var i = 0; i < arguments.length; i++) out = out.concat(arguments[i] || [])
    return out
  }

  function readVarint (b, i) {
    var v = 0
    var shift = 0
    var byte
    do {
      if (i >= b.length) throw new Error('protobuf 截断')
      byte = b[i++]
      v += (byte & 0x7f) * Math.pow(2, shift)
      shift += 7
    } while (byte & 0x80)
    return [v, i]
  }

  /** 解成 { 字段号: [值...] }，wire 2 的值是 Buffer 切片 */
  function decode (buf) {
    var out = {}
    var i = 0
    while (i < buf.length) {
      var r = readVarint(buf, i)
      var key = r[0]
      i = r[1]
      var field = Math.floor(key / 8)
      var wire = key & 7
      var val
      if (wire === 0) {
        var r2 = readVarint(buf, i)
        val = r2[0]
        i = r2[1]
      } else if (wire === 2) {
        var r3 = readVarint(buf, i)
        var len = r3[0]
        i = r3[1]
        val = buf.subarray(i, i + len)
        i += len
      } else if (wire === 5) { val = buf.readUInt32LE(i); i += 4 } else if (wire === 1) {
        val = Number(buf.readBigUInt64LE(i)); i += 8
      } else { break }
      if (!out[field]) out[field] = []
      out[field].push(val)
    }
    return out
  }
  function first (obj, f) { return obj && obj[f] && obj[f].length ? obj[f][0] : null }
  function utf8 (buf) { return buf ? Buffer.from(buf).toString('utf8') : '' }

  function imageSize (b) {
    if (!b || b.length < 16) return { w: 0, h: 0, format: 1000 }
    if (b[0] === 0x89 && b[1] === 0x50) {
      return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), format: 1001 }
    }
    if (b[0] === 0x47 && b[1] === 0x49) {
      return { w: b.readUInt16LE(6), h: b.readUInt16LE(8), format: 2000 }
    }
    if (b[0] === 0x42 && b[1] === 0x4d) {
      return { w: b.readInt32LE(18), h: Math.abs(b.readInt32LE(22)), format: 1005 }
    }
    if (b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') {
      return { w: 0, h: 0, format: 1002 }
    }
    var i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xFF) { i++; continue }
      var m = b[i + 1]
      if (m >= 0xC0 && m <= 0xC3) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7), format: 1000 }
      if (m === 0xD8 || m === 0xD9) { i += 2; continue }
      var len = b.readUInt16BE(i + 2)
      if (len <= 0) break
      i += 2 + len
    }
    return { w: 0, h: 0, format: 1000 }
  }

  function ms () {
    var s = globalThis.__fl_session
    if (!s) throw new Error('QQ 尚未登录完成，请稍后重试')
    return s.getMsgService()
  }

  function takeRaw () {
    var hm = globalThis.__fl_napi2native
    if (!hm && typeof process !== 'undefined' && process.mainModule) {
      try {
        var p = nodeReq('path')
        var dir = typeof __fl_dir === 'string' ? __fl_dir : ''
        if (p && dir) hm = process.mainModule.require(p.resolve(dir, 'native', 'frishluna-pkt.node'))
      } catch (e) {}
    }
    if (!hm || typeof hm.takeRsp !== 'function') return null
    var t = hm.takeRsp()
    if (typeof t === 'string' && t.length) return Buffer.from(t, 'latin1')
    if (Buffer.isBuffer(t) && t.length) return t
    return null
  }

  /** 发一条 OIDB / SSO，等回执并取原始响应字节。
   *  opts.buffer：强制用 Buffer 传参（Buffer 走内核参数转换不烂字节，Uint8Array 会被
   *  coerce 成字符串 → 145 invalid pkg）。opts.allowNoRaw：拿不到原始回执时不炸。 */
  function sso (cmdName, body, opts) {
    var m = ms()
    if (typeof m.sendSsoCmdReqByContend !== 'function') throw new Error('当前 QQ 版本暂不支持此发送方式')
    /* 要拿原始回执字节就必须装 recv hook；没装时回执被 QQ 自己吞掉，
       内核只回 2001002「cs return ok, but response empty!」 */
    var raw = takeRaw()
    if (!raw) {
      var ops = globalThis.__fl_ops
      if (ops && typeof ops.ensureHook === 'function') {
        try { ops.ensureHook() } catch (e) {}
      }
    }
    var arr = ((opts && opts.buffer) || globalThis.__fl_sso_buffer === true)
      ? Buffer.from(body)
      : Uint8Array.from(body)
    return Promise.resolve(m.sendSsoCmdReqByContend(cmdName, arr)).then(function (r) {
      var code = 0
      if (r && typeof r === 'object') {
        if (typeof r.result === 'number') code = r.result
        else if (typeof r.code === 'number') code = r.code
      }
      var raw = takeRaw()
      if (!raw) {
        if (code !== 0) throw new Error('发送失败（' + code + '）' + ((r && r.errMsg) || ''))
        if (opts && opts.allowNoRaw) return r
        throw new Error('没有拿到响应数据')
      }
      return raw
    })
  }

  function applyUpload (o) {
    var isGroup = o.type === 'group'
    var summary = o.summary || '[图片]'
    var fileInfo = cat(
      fUInt(1, o.size),
      fStr(2, o.md5Hex),
      fStr(3, o.sha1Hex),
      fStr(4, o.fileName),
      fBytes(5, cat(fUInt(1, 1), fUInt(2, o.format || 1000))),
      fUInt(6, o.width),
      fUInt(7, o.height),
      fUInt(9, 1)
    )
    var uploadInfo = cat(fBytes(1, fileInfo), fUInt(2, 0))
    var o2 = o.picOpts || {}
    var picExt = picExtBiz(summary, isGroup, { subType: o2.subType || 0, f3: o2.extF3 || 0, f4: o2.extF4 || 0, resSubType: o2.resSubType || 0 })
    var common = cat(fUInt(1, 1), fUInt(2, 100))
    var scene = cat(
      fUInt(101, 2), fUInt(102, 1), fUInt(200, isGroup ? 2 : 1),
      isGroup
        ? fBytes(202, fUInt(1, Number(o.id)))
        : fBytes(201, cat(fUInt(1, 2), fStr(2, String(o.peerUid))))
    )
    var client = fUInt(1, 2)
    var reqHead = cat(fBytes(1, common), fBytes(2, scene), fBytes(3, client))
    var rand = []
    for (var i = 0; i < 8; i++) rand.push(Math.floor(Math.random() * 256))
    rand[0] &= 0x7f
    var upload = cat(fBytes(1, uploadInfo), fBytes(4, rand), fUInt(5, isGroup ? 2 : 1), fBytes(6, fBytes(1, picExt)))
    var body = cat(fBytes(1, reqHead), fBytes(2, upload))

    var cmdName = isGroup ? 'OidbSvcTrpcTcp.0x11c4_100' : 'OidbSvcTrpcTcp.0x11c5_100'
    return sso(cmdName, cat(fUInt(1, isGroup ? 0x11C4 : 0x11C5), fUInt(2, 100), fBytes(4, body)), { buffer: true }).then(function (rsp) {
      var env = decode(rsp)
      var payload = first(env, 4)
      if (!payload) throw new Error('上传申请没有返回数据体')
      var root = decode(payload)
      var head = first(root, 1) ? decode(first(root, 1)) : {}
      var retCode = Number(first(head, 2) || 0)
      var msg = utf8(first(head, 3))
      if (retCode) throw new Error('上传申请被拒绝（' + retCode + '）' + msg)
      var up = first(root, 2) ? decode(first(root, 2)) : null
      if (!up) throw new Error('上传申请返回体缺 upload 段')
      var out = {
        uKey: utf8(first(up, 1)),
        ipv4s: (up[3] || []).map(function (b) {
          var d = decode(b)
          return { ip: Number(first(d, 1) || 0), port: Number(first(d, 2) || 0) }
        }),
        msgInfoBodies: [],
        fileUuid: '',
        originUrl: '',
        subFiles: (up[10] || []).map(function (b) {
          var d = decode(b)
          return { subType: Number(first(d, 1) || 0), uKey: utf8(first(d, 2)), ipv4s: (d[4] || []).map(function (x) {
            var dd = decode(x)
            return { ip: Number(first(dd, 1) || 0), port: Number(first(dd, 2) || 0) }
          }) }
        })
      }
      var msgInfo = first(up, 6) ? decode(first(up, 6)) : null
      if (msgInfo) {
        out.msgInfoBodies = (msgInfo[1] || []).slice()
        var body0 = out.msgInfoBodies.length ? decode(out.msgInfoBodies[0]) : null
        if (body0) {
          var idx = first(body0, 1) ? decode(first(body0, 1)) : null
          if (idx) out.fileUuid = utf8(first(idx, 2))
          var pic = first(body0, 2) ? decode(first(body0, 2)) : null
          if (pic) out.originUrl = utf8(first(pic, 1))
        }
      }
      /* f8 CompatQMsg：服务端给的「老协议 NotOnlineImage」现成字节（老协议兼容通道）。
         闪照要用它里面的老 resId —— NTV2 fileUuid 客户端解析不了。 */
      var compat = first(up, 8)
      if (compat) out.compatQMsg = Buffer.from(compat)
      /* 诊断快照：上传申请到底回了什么（面板不显示，出问题时用 devEval 读） */
      try {
        function shallow (b) {
          try { var d = decode(b); var o = {}; for (var k in d) o[k] = (d[k].length && Buffer.isBuffer(d[k][0])) ? ('pb:' + d[k].length + 'B') : String(utf8(d[k][0]) || d[k][0]).slice(0, 80); return o } catch (e) { return 'raw:' + b.toString('hex').slice(0, 80) }
        }
        var extra = {}
        ;[2, 4, 7, 8, 11, 14, 15].forEach(function (k) { if (up[k]) extra[k] = up[k].map(shallow) })
        globalThis.__fl_last_apply = {
          uKey: out.uKey ? out.uKey.slice(0, 24) : '',
          uuid: out.fileUuid ? out.fileUuid.slice(0, 24) : '',
          compatLen: out.compatQMsg ? out.compatQMsg.length : 0,
          compatHex: out.compatQMsg ? out.compatQMsg.toString('hex') : '',
          ipv4s: out.ipv4s.length,
          bodies: out.msgInfoBodies.length,
          subFiles: out.subFiles.map(function (x) { return x.subType + ':' + (x.uKey ? x.uKey.slice(0, 12) : '-') }),
          fields: Object.keys(up).map(function (k) { return k + ':' + (up[k] && up[k].length) }),
          extra: extra
        }
      } catch (e) {}
      return out
    })
  }

  function highwaySession () {
    var httpConn = cat(
      fUInt(1, 0), fUInt(2, 0), fUInt(3, 16), fUInt(4, 1), fUInt(6, 3),
      fUInt(7, 1), fUInt(7, 5), fUInt(7, 10), fUInt(7, 21),
      fUInt(9, 2), fUInt(10, 9), fUInt(11, 8), fStr(15, '1.0.1')
    )
    return sso('HttpConn.0x6ff_501', fBytes(0x501, httpConn), { buffer: true }).then(function (rsp) {
      var env = decode(rsp)
      var inner = first(env, 0x501)
      if (!inner) throw new Error('上传会话没有返回数据')
      var d = decode(inner)
      var sig = first(d, 1)
      var key = first(d, 2)
      if (!sig || !sig.length) throw new Error('上传会话缺 sig')
      var servers = []
      ;(d[3] || []).forEach(function (siBuf) {
        var si = decode(siBuf)
        if (Number(first(si, 1) || 0) !== 1) return
        ;(si[2] || []).forEach(function (aBuf) {
          var a = decode(aBuf)
          var ip = Number(first(a, 2) || 0)
          var port = Number(first(a, 3) || 0)
          if (!ip || !port) return
          servers.push({ ip: ip, port: port })
        })
      })
      if (!servers.length) throw new Error('上传会话没有可用服务器')
      return { sig: Buffer.from(sig), key: key ? Buffer.from(key) : null, servers: servers }
    })
  }

  var APP_ID = 1600001604
  var BLOCK = 1024 * 1024
  var COMMAND = 'PicUp.DataUp'

  function ipStr (v) {
    return (v & 0xff) + '.' + ((v >> 8) & 0xff) + '.' + ((v >> 16) & 0xff) + '.' + ((v >>> 24) & 0xff)
  }

  function highwayHead (o) {
    var base = cat(
      fUInt(1, 1), fStr(2, o.uin), fStr(3, COMMAND), fUInt(4, o.seq || 0), fUInt(5, o.retry || 0),
      fUInt(6, APP_ID), fUInt(7, o.dataFlag == null ? 16 : o.dataFlag), fUInt(8, o.cmdId)
    )
    var seg = cat(
      fUInt(1, 0),
      fUInt(2, o.fileSize),
      fUInt(3, o.offset),
      fUInt(4, o.length),
      fUInt(5, 0),
      fBytes(6, o.ticket),
      fUInt(7, 0),
      fBytes(8, o.chunkMd5),
      fBytes(9, o.fileMd5),
      fUInt(10, 0),
      fUInt(13, 0)
    )
    var login = cat(fUInt(1, 8), fUInt(3, APP_ID))
    return cat(fBytes(1, base), fBytes(2, seg), fBytes(3, o.extend), fUInt(4, 0), fBytes(5, login))
  }

  function packFrame (head, body) {
    var buf = Buffer.alloc(9 + head.length + body.length + 1)
    buf[0] = 0x28
    buf.writeUInt32BE(head.length, 1)
    buf.writeUInt32BE(body.length, 5)
    Buffer.from(head).copy(buf, 9)
    Buffer.from(body).copy(buf, 9 + head.length)
    buf[buf.length - 1] = 0x29
    return buf
  }

  function httpPost (server, uin, frame) {
    return new Promise(function (resolve, reject) {
      var req = http.request({
        host: ipStr(server.ip),
        port: server.port,
        method: 'POST',
        path: '/cgi-bin/httpconn?htcmd=0x6FF0087&uin=' + uin,
        headers: {
          Host: ipStr(server.ip),
          Connection: 'keep-alive',
          'Accept-Encoding': 'identity',
          'User-Agent': 'Mozilla/5.0 (compatible; MSIE 10.0; Windows NT 6.2)',
          'Content-Length': frame.length
        },
        timeout: 30000
      }, function (res) {
        var chunks = []
        res.on('data', function (d) { chunks.push(d) })
        res.on('end', function () { resolve(Buffer.concat(chunks)) })
      })
      req.on('timeout', function () { req.destroy(new Error('上传超时')) })
      req.on('error', reject)
      req.write(frame)
      req.end()
    })
  }

  function parseHighwayRsp (buf) {
    if (!buf || buf.length < 10) throw new Error('上传响应为空')
    if (buf[0] !== 0x28) throw new Error('上传响应格式不对：' + buf.slice(0, 8).toString('hex'))
    var headLen = buf.readUInt32BE(1)
    var head = buf.subarray(9, 9 + headLen)
    var d = decode(head)
    var errCode = Number(first(d, 3) || 0)
    var seg = first(d, 2) ? decode(first(d, 2)) : {}
    return { errCode: errCode, segRet: Number(first(seg, 5) || 0), headHex: head.toString('hex').slice(0, 400) }
  }

  function putAll (session, o, hooks) {
    var servers = session.servers
    var idx = 0
    var offset = 0
    var md5 = Buffer.from(o.md5Hex, 'hex')
    var out = { puts: 0 }
    var ticketRetry = 0

    function nextChunk () {
      if (offset >= o.bytes.length) return Promise.resolve(out)
      var len = Math.min(BLOCK, o.bytes.length - offset)
      var chunk = o.bytes.subarray(offset, offset + len)
      var chunkMd5 = crypto.createHash('md5').update(chunk).digest()
      var head = highwayHead({
        uin: String(o.uin),
        cmdId: o.cmdId,
        fileSize: o.bytes.length,
        offset: offset,
        length: len,
        chunkMd5: chunkMd5,
        fileMd5: md5,
        seq: 0,
        ticket: o.ticket || session.sig,
        extend: o.extend,
        retry: 0
      })
      var frame = packFrame(head, chunk)
      /* 67 = 票据校验失败：0x6FF_501 的回执偶尔会被 QQ 自己那条同名请求抢走，
         拿到一个长度正常但内容作废的 sig。重取会话再发一次即可，不用惊动调用方。 */
      function onReject (r) {
        if (r.errCode === 67 && !o.ticket && hooks && typeof hooks.refresh === 'function' && ticketRetry < 2) {
          ticketRetry++
          return Promise.resolve(hooks.refresh()).then(function (s) {
            session.sig = s.sig
            session.key = s.key
            if (s.servers && s.servers.length) servers = session.servers = s.servers
            return nextChunk()
          })
        }
        throw new Error('上传被拒绝，错误码：' + r.errCode + '（分片偏移 ' + offset + '，段返回 ' + r.segRet + '，头部 ' + r.headHex + '）')
      }
      return httpPost(servers[idx % servers.length], o.uin, frame).then(function (rsp) {
        var r = parseHighwayRsp(rsp)
        if (r.errCode) return onReject(r)
        out.puts++
        offset += len
        return nextChunk()
      }, function (e) {
        /* 边缘节点偶发断连：换一台 + 重发同一分片（重传同一偏移是幂等的） */
        idx++
        if (idx > servers.length * 2) throw new Error('上传连接失败：' + ((e && e.message) || e))
        return httpPost(servers[idx % servers.length], o.uin, frame).then(function (rsp) {
          var r = parseHighwayRsp(rsp)
          if (r.errCode) return onReject(r)
          out.puts++
          offset += len
          return nextChunk()
        })
      })
    }
    return nextChunk()
  }

  /* NTV2RichMediaHighwayExt：1=fileUuid 2=uKey 5=network 6=msgInfoBody 10=blockSize 11=hash */
  function buildExtend (apply, sha1Buf, opt) {
    opt = opt || {}
    var parts = [fStr(1, opt.fileUuid == null ? apply.fileUuid : opt.fileUuid)]
    if (!opt.noUKey) parts.push(fStr(2, apply.uKey))
    if (!opt.noNetwork && apply.ipv4s.length) {
      parts.push(fBytes(5, cat.apply(null, apply.ipv4s.map(function (x) {
        return fBytes(1, cat(fBytes(1, cat(fUInt(1, 1), fStr(2, ipStr(x.ip)))), fUInt(2, x.port)))
      }))))
    }
    if (!opt.noMsgInfo) apply.msgInfoBodies.forEach(function (b) { parts.push(fBytes(6, b)) })
    parts.push(fUInt(10, BLOCK), fBytes(11, fBytes(1, Array.from(sha1Buf))))
    return cat.apply(null, parts)
  }

  /* 内核的 sendMsg 对 elementType=2 一律要走它自己的富媒体通道，
     那条通道对旁挂会话永远回 rich media transfer failed（元素字段怎么改都没用）。
     所以图片消息改成自己组 MessageSvc.PbSendMsg 发，和上传链路同一套 SSO 通道。 */

  function randomU32 () {
    if (crypto) return crypto.randomBytes(4).readUInt32BE(0)
    return Math.floor(Math.random() * 0xffffffff)
  }

  /** ExtBizInfo.Pic 共用构造（上传申请 line-215 与发消息 picMsgInfo 同构）。
   *  f1=subType(疑似) f2=summary f3=? f4=?，f12/f11=pbReserve。 */
  function picExtBiz (summary, isGroup, o) {
    o = o || {}
    var parts = [fUInt(1, o.subType || 0), fStr(2, summary)]
    if (o.f3) parts.push(fUInt(3, o.f3))
    if (o.f4) parts.push(fUInt(4, o.f4))
    var res = cat(fUInt(1, o.resSubType || 0), fStr(isGroup ? 9 : 8, summary))
    parts.push(fBytes(isGroup ? 12 : 11, res))
    return cat.apply(null, parts)
  }

  function picMsgInfo (apply, summary, isGroup, o) {
    o = o || {}
    var pic = picExtBiz(summary, isGroup, o)
    var parts = []
    apply.msgInfoBodies.forEach(function (b) { parts.push(fBytes(1, b)) })
    parts.push(fBytes(2, fBytes(1, pic)))
    return cat.apply(null, parts)
  }

  function commonElem (msgInfo, isGroup, bizType) {
    /* Elem.commonElem(53) { 1: serviceType=48, 2: pbElem, 3: businessType }
       群 20 / 私 10 是接收端配对用的场景标签，给错会被服务端挡（result=79）。
       视频：群 21 / 私 11。 */
    return fBytes(53, cat(fUInt(1, 48), fBytes(2, msgInfo), fUInt(3, bizType != null ? bizType : (isGroup ? 20 : 10))))
  }

  /* 闪照（flash pic）
     闪照和普通图是两个通道——
     普通图 commonElem serviceType=48 + MsgElemInfoServtype48(msgInfoBodies)；
     闪照 commonElem serviceType=3 + MsgElemInfoServtype3{1:群 flashTroopPic(CustomFace), 2:私 flashC2cPic(NotOnlineImage)}，
     引用已上传资源（md5/filePath/resId），pbReserve=[0x78,0x06]=field15=6。
     NT 接收端按 subMsgType&8192 判闪照（TCQT 防闪照），文件本体靠 resId/md5 秒下。 */
  var FLASH_PB_RESERVE = [0x78, 0x06]
  var FLASH_GENERAL_FLAGS_RESERVE = [0x78, 0x00, 0x90, 0x01, 0x01, 0xF8, 0x01, 0x00, 0xA0, 0x02, 0x00, 0xC8, 0x02, 0x00]

  function flashPicElem (apply, ctx, isGroup) {
    var md5Buf = Buffer.from(ctx.md5Hex, 'hex')
    /* filePath 与 resId 同值，都填上传返回的 friendImageId（即 resId），
       不是 md5 文件名 —— filePath 填错会导致接收端看不到闪照 */
    var fid = String(apply.fileUuid || '') || (ctx.md5Hex.toUpperCase() + (dimExt(ctx.format) || '.jpg'))
    if (isGroup) {
      /* CustomFace：{2: filePath, 13: picMd5, 34: pbReserve} */
      var cf = cat(fStr(2, fid), fBytes(13, md5Buf), fBytes(34, FLASH_PB_RESERVE))
      return fBytes(53, cat(fUInt(1, 3), fBytes(2, cat(fBytes(1, cf))), fUInt(3, 0)))
    }
    /* NotOnlineImage：{1: filePath, 7: picMd5, 10: resId, 20: oldPicMd5=false, 29: pbReserve} */
    var noi = cat(fStr(1, fid), fBytes(7, md5Buf), fStr(10, fid), fUInt(20, 0), fBytes(29, FLASH_PB_RESERVE))
    return fBytes(53, cat(fUInt(1, 3), fBytes(2, cat(fBytes(2, noi))), fUInt(3, 0)))
  }

  /* 服务端 CompatQMsg（上传响应 f8）= 老协议 NotOnlineImage(C2C)/CustomFace(群) 现成字节，
     里面的 resId 是 NTV2COMPAT.xxx 兼容格式 —— 接收端（含手机端闪照解析）认这个。
     手造 resId=NTV2 fileUuid 的闪照接收端不识别（闪照不生效）；
     CompatQMsg 才是正解（与普通图片的 compat 通道一致）。 */
  function flashCompatElems (apply, isGroup) {
    var compat = apply.compatQMsg
    if (!compat) return null
    return [
      fBytes(isGroup ? 8 : 4, compat),                                  /* 老协议图片元素本体 */
      flashTextElem(),
      fBytes(53, cat(fUInt(1, 3), fBytes(2, isGroup ? fBytes(1, compat) : fBytes(2, compat)), fUInt(3, 0))),
      flashGeneralFlagsElem()
    ]
  }

  function flashTextElem () {
    /* 兜底文案（新版 QQ 识别闪照后不显示，老客户端显示这句）；
       同时也是诊断信号：接收端若直接看到这句字 = 闪照 elem 未被识别 */
    return fBytes(1, fStr(1, '[闪照]请使用新版手机QQ查看闪照。'))
  }

  function flashGeneralFlagsElem () {
    /* Elem.generalFlags(37) { 19: pbReserve=DOUTU 位 } —— 闪照元素必带 */
    return fBytes(37, fBytes(19, FLASH_GENERAL_FLAGS_RESERVE))
  }

  function dimExt (format) {
    if (format === 2000) return '.gif'
    if (format === 1001) return '.png'
    if (format === 1005) return '.bmp'
    if (format === 1002) return '.webp'
    return '.jpg'
  }

  function sendMsgProto (o) {
    var routing = o.isGroup
      ? fBytes(2, fUInt(1, Number(o.groupCode)))
      : fBytes(1, cat(fUInt(1, Number(o.uin) || 0), o.uid ? fStr(2, o.uid) : []))
    var content = o.isGroup
      ? fUInt(1, 1)
      : cat(fUInt(1, 1), fUInt(3, 11))
    var random = o.random != null ? o.random : randomU32()
    /* msgBody.elem 是 repeated —— 每个元素必须单独一个 field 2，
       拼成一坨塞进一个 field 2 只会让服务端只认第一个（混排会丢图和 @） */
    var elems = o.elems || (o.elem ? [o.elem] : [])
    var bodyParts = elems.map(function (e) { return fBytes(2, e) })
    var body = cat(
      fBytes(1, routing),
      fBytes(2, content),
      fBytes(3, fBytes(1, cat.apply(null, bodyParts))),
      fUInt(4, o.clientSeq || 0),
      fUInt(5, random),
      fUInt(8, 0),
      fUInt(9, 0),
      fUInt(14, 0)
    )
    var elemLen = elems.reduce(function (n, e) { return n + e.length }, 0)
    if (o.dryRun) return Promise.resolve({ random: random, bodyLen: body.length, elemLen: elemLen })
    return sso('MessageSvc.PbSendMsg', body, { allowNoRaw: true, buffer: true }).then(function (rsp) {
      var d = null
      try { d = Buffer.isBuffer(rsp) || rsp instanceof Uint8Array ? decode(rsp) : null } catch (e) {}
      var result = d ? Number(first(d, 1) || 0) : Number((rsp && rsp.result) || 0)
      var errMsg = d ? utf8(first(d, 2)) : String((rsp && rsp.errMsg) || '')
      if (result) throw new Error('服务器拒绝接收（' + result + '）' + errMsg)
      return {
        random: random,
        groupSeq: d ? Number(first(d, 11) || 0) : 0,
        privateSeq: d ? Number(first(d, 14) || 0) : 0,
        time: d ? Number(first(d, 3) || 0) : 0,
        raw: !!d
      }
    })
  }

  function selfUin () {
    var ops = globalThis.__fl_ops
    if (!ops || typeof ops.selfInfo !== 'function') return Promise.resolve(0)
    return Promise.resolve(ops.selfInfo()).then(function (x) { return Number((x && x.uin) || 0) }, function () { return 0 })
  }

  /* 私聊发图必须带 uid（QQ 号 → u_xxx），自己查一次并缓存 */
  function peerUidFor (uin) {
    var key = String(uin || '')
    if (!key) return Promise.resolve('')
    var map = globalThis.__fl_uidmap || {}
    if (/^u_/.test(String(map[key] || ''))) return Promise.resolve(map[key])
    var ops = globalThis.__fl_ops
    if (!ops || typeof ops.findUid !== 'function') return Promise.resolve('')
    return Promise.resolve(ops.findUid({ uin: key })).then(function (s) {
      var o = null
      try { o = typeof s === 'string' ? JSON.parse(s) : s } catch (e) {}
      return (o && /^u_/.test(String(o.uid || ''))) ? o.uid : ''
    }, function () { return '' })
  }

  /** 走完整条上传链路（申请 + 会话 + 直传）。doSend=false 时只上传不发消息，用于排障。 */
  function doImage (a, doSend) {
    if (!fs || !crypto || !http) return Promise.reject(new Error('运行环境缺少文件/网络模块'))
    var path = String((a && a.path) || '')
    if (!path) return Promise.reject(new Error('缺少图片路径'))
    if (!fs.existsSync(path)) return Promise.reject(new Error('图片不存在：' + path))

    /* 私聊缺 uid 时先补上再递归一次（这一步之后就没有异步前置了） */
    if (a.type !== 'group' && !a.peerUid) {
      return peerUidFor(a.id).then(function (uid) {
        if (!uid) throw new Error('私聊 ' + a.id + ' 未获取到成员标识：请让对方在群里发一条消息')
        var a2 = {}
        for (var k in a) if (Object.prototype.hasOwnProperty.call(a, k)) a2[k] = a[k]
        a2.peerUid = uid
        return doImage(a2, doSend)
      })
    }

    var bytes = fs.readFileSync(path)
    if (!bytes.length) return Promise.reject(new Error('图片是空文件'))
    if (bytes.length > 30 * 1024 * 1024) return Promise.reject(new Error('图片体积超过 30MB 限制，请压缩后重试'))

    var isGroup = a.type === 'group'
    var size = bytes.length
    var md5Hex = crypto.createHash('md5').update(bytes).digest('hex')
    var sha1Buf = crypto.createHash('sha1').update(bytes).digest()
    var dim = imageSize(bytes)
    var name = String(a.name || nodeReq('path').basename(path) || (md5Hex + '.jpg'))

    var ctx = {
      type: a.type,
      id: a.id,
      peerUid: a.peerUid || '',
      size: size,
      md5Hex: md5Hex,
      sha1Hex: sha1Buf.toString('hex'),
      fileName: name,
      width: dim.w,
      height: dim.h,
      format: dim.format,
      summary: a.summary || '[图片]',
      /* 闪照矩阵实验位：flash=两处 subType；extF4/extF3=ExtBizInfo.Pic f4/f3；resSub=pbReserve.f1 */
      picOpts: {
        subType: (a.flashExt || a.flash) ? 1 : 0,
        resSubType: (a.flashRes || a.flash) ? 1 : 0,
        extF3: a.extF3 ? 1 : 0,
        extF4: a.extF4 ? 1 : 0
      },
      bytes: bytes
    }

    return applyUpload(ctx).then(function (apply) {
      if (!apply.uKey && !apply.fileUuid) throw new Error('获取上传凭据失败')
      if (!apply.uKey) return apply            /* 服务端已有同 md5 资源，直接引用 */
      return Promise.all([selfUin(), highwaySession()]).then(function (r) {
        var self = r[0]
        var session = r[1]
        if (!self) throw new Error('尚未识别当前账号，请刷新面板或在 QQ 发送一条消息')
        var cmdId = isGroup ? 1004 : 1003
        var extend = buildExtend(apply, sha1Buf)
        if (a && a.noExtend === true) extend = []
        var putOpts = {
          uin: self,
          cmdId: cmdId,
          bytes: bytes,
          md5Hex: md5Hex,
          extend: extend,
          dataFlag: a && a.dataFlag != null ? a.dataFlag : 16
        }
        if (a && a.ticket === 'ukey') putOpts.ticket = Buffer.from(apply.uKey, 'utf8')
        if (a && a.ticket === 'key') putOpts.ticket = session.key
        return putAll(session, putOpts, { refresh: highwaySession }).then(function (put) {
          apply.puts = put.puts
          apply.extendHex = Buffer.from(extend).toString('hex')
          return apply
        })
      })
    }).then(function (apply) {
      if (!doSend) {
        return {
          text: '上传完成（未发消息）：' + Math.round(size / 1024) + ' KB，分片 ' + (apply.puts || 0),
          fileUuid: apply.fileUuid
        }
      }
      var chatType = isGroup ? 2 : 1
      var peer = isGroup ? String(a.id) : String(a.peerUid || '')
      if (!peer) throw new Error('私聊发送需要先获取对方成员标识（请让对方发一条消息）')
      /* flash=1 → serviceType=3 闪照通道 + generalFlags DOUTU 位。
         有 CompatQMsg（服务端老协议字节）就优先用它 —— 手造 resId 接收端解析不了 */
      var elem, elems
      if (a && a.flash) {
        elems = flashCompatElems(apply, isGroup) || [flashPicElem(apply, ctx, isGroup), flashTextElem(), flashGeneralFlagsElem()]
      } else {
        elem = commonElem(picMsgInfo(apply, ctx.summary, isGroup, ctx.picOpts), isGroup)
        elems = [elem]
      }
      var payload = {
        isGroup: isGroup,
        groupCode: a.id,
        uin: a.uin || (isGroup ? 0 : a.id),
        uid: isGroup ? '' : String(a.peerUid || ''),
        elems: elems,
        clientSeq: Number(a.clientSeq || 0)
      }
      if (a && a.dryRun) { payload.dryRun = true; return Promise.resolve(payload).then(function (p) { return sendMsgProto(p) }).then(function (s) { return { text: '组包长度：PbSendMsg ' + s.bodyLen + 'B（elem ' + s.elemLen + 'B）', bodyLen: s.bodyLen, elemLen: s.elemLen, fileUuid: apply.fileUuid } }) }
      return sendMsgProto(payload).then(function (r) {
        return {
          text: '已发送图片到 ' + (isGroup ? '群 ' : '') + (a.id || peer) + '（' + Math.round(size / 1024) + ' KB'
            + (apply.puts ? '，上传 ' + apply.puts + ' 片' : '，秒传') + '）',
          fileUuid: apply.fileUuid,
          puts: apply.puts || 0,
          fastUpload: !apply.puts,
          seq: r.groupSeq || r.privateSeq,
          random: r.random
        }
      })
    })
  }

  API.sendImage = function (a) { return doImage(a, true) }
  API.debugUpload = function (a) { return doImage(a, false) }

  /* 视频（NTV2 0x11EA/0x11E9，双子文件：主视频+缩略图）
   * 口径逐字段核对：
   *   - cmdId：主视频 群1005/私1001，缩略图 群1006/私1002；subFileType 主 0/缩 100
   *   - extBizInfo.video{fromScene,toScene,bytesPbReserve:[0x80,0x01,0x00]}
   *     （缺 fromScene/toScene 私聊会被服务器 result=79 拒）
   *   - compatQmsgSceneType 恒 2（老客户端兼容包按群场景生成，c2c 给 1 会「视频已过期」）
   *   - 发送：commonElem{serviceType:48, businessType 群21/私11, pbElem=响应 f6 原样}
   *   - 群视频 width/height/time 必须真值（0 会让接收端渲染「文件已过期」）→ mp4 box 解析
   *   - 缩略图：1x1 JPEG 常量兜底（没有 ffmpeg 抽帧能力，够触发接收端封面位）
   */

  var THUMB_JPEG = Buffer.from(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAQAAAAAA' +
    'AAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/a' +
    'AAwDAQACEQMRAD8AmAA//9k=', 'base64')

  /** 最小 mp4 探测：mvhd 取时长、tkhd 取宽高。解析失败给保守默认（时长 5s）。 */
  function probeMp4 (b) {
    var out = { duration: 0, width: 0, height: 0 }
    try {
      function walk (start, end, cb) {
        var p = start
        while (p + 8 <= end) {
          var sz = b.readUInt32BE(p)
          var name = b.toString('ascii', p + 4, p + 8)
          if (sz === 1) sz = Number(b.readBigUInt64BE(p + 8))
          if (sz < 8) break
          cb(name, p, Math.min(p + sz, end))
          p += sz
        }
      }
      walk(0, b.length, function (n1, s1, e1) {
        if (n1 !== 'moov') return
        walk(s1 + 8, e1, function (n2, s2, e2) {
          if (n2 === 'mvhd') {
            var ver = b[s2 + 8]
            if (ver === 0) {
              var ts0 = b.readUInt32BE(s2 + 8 + 12)
              var du0 = b.readUInt32BE(s2 + 8 + 16)
              if (ts0) out.duration = Math.round(du0 / ts0)
            } else {
              var ts1 = Number(b.readBigUInt64BE(s2 + 8 + 20))
              var du1 = Number(b.readBigUInt64BE(s2 + 8 + 28))
              if (ts1) out.duration = Math.round(du1 / ts1)
            }
          } else if (n2 === 'trak') {
            walk(s2 + 8, e2, function (n3, s3, e3) {
              if (n3 !== 'tkhd') return
              var ver3 = b[s3 + 8]
              var wOff = s3 + 8 + (ver3 === 0 ? 76 : 84)
              if (wOff + 8 <= e3) {
                out.width = Math.round(b.readUInt32BE(wOff) / 65536)
                out.height = Math.round(b.readUInt32BE(wOff + 4) / 65536)
              }
            })
          }
        })
      })
    } catch (e) {}
    if (!(out.duration > 0)) out.duration = 5
    if (!(out.width > 0)) { out.width = 640; out.height = out.height > 0 ? out.height : 360 }
    return out
  }

  function videoExtBiz () {
    /* extBizInfo 必须带 pic{bizType,textSummary}
       和 ptt 空段，只发 video 段会被 OIDB 拒（Service Failure） */
    return fBytes(6, cat(
      fBytes(1, cat(fUInt(1, 0), fStr(2, 'Nya~'))),
      fBytes(2, cat(fUInt(1, 0), fUInt(2, 0), fBytes(3, [0x80, 0x01, 0x00]))),
      fBytes(3, cat(fBytes(12, []), fBytes(11, []), fBytes(13, [])))
    ))
  }

  /** doVideo：上传主视频+缩略图，再 PbSendMsg 发 video 元素 */
  function doVideo (a, doSend) {
    if (!fs || !crypto || !http) return Promise.reject(new Error('运行环境缺少文件/网络模块'))
    var path = String((a && a.path) || '')
    if (!path) return Promise.reject(new Error('缺少视频路径'))
    if (!fs.existsSync(path)) return Promise.reject(new Error('视频不存在：' + path))

    if (a.type !== 'group' && !a.peerUid) {
      return peerUidFor(a.id).then(function (uid) {
        if (!uid) throw new Error('私聊 ' + a.id + ' 未获取到成员标识：请让对方在群里发一条消息')
        var a2 = {}
        for (var k in a) if (Object.prototype.hasOwnProperty.call(a, k)) a2[k] = a[k]
        a2.peerUid = uid
        return doVideo(a2, doSend)
      })
    }

    var bytes = fs.readFileSync(path)
    if (!bytes.length) return Promise.reject(new Error('视频是空文件'))
    if (bytes.length > 1024 * 1024 * 1024) return Promise.reject(new Error('视频体积超过 1GB，建议使用群文件发送'))

    var isGroup = a.type === 'group'
    var size = bytes.length
    var md5Hex = crypto.createHash('md5').update(bytes).digest('hex')
    var sha1Hex = crypto.createHash('sha1').update(bytes).digest('hex')
    var thumb = THUMB_JPEG
    var thumbMd5Hex = crypto.createHash('md5').update(thumb).digest('hex')
    var thumbSha1Hex = crypto.createHash('sha1').update(thumb).digest('hex')
    var meta = probeMp4(bytes)
    var name = String(a.name || nodeReq('path').basename(path) || (md5Hex + '.mp4'))

    /* 1) 上传申请（双子文件） */
    var common = cat(fUInt(1, 1), fUInt(2, 100))
    var scene = cat(
      fUInt(101, 2), fUInt(102, 2), fUInt(200, isGroup ? 2 : 1),
      isGroup
        ? fBytes(202, fUInt(1, Number(a.id)))
        : fBytes(201, cat(fUInt(1, 2), fStr(2, String(a.peerUid))))
    )
    var client = fUInt(1, 2)
    var reqHead = cat(fBytes(1, common), fBytes(2, scene), fBytes(3, client))
    var rand = []
    for (var i = 0; i < 8; i++) rand.push(Math.floor(Math.random() * 256))
    rand[0] &= 0x7f

    var infoMain = cat(
      fUInt(1, size), fStr(2, md5Hex), fStr(3, sha1Hex), fStr(4, /\.mp4$/i.test(name) ? name : name + '.mp4'),
      fBytes(5, fUInt(1, 2)),
      fUInt(6, isGroup ? meta.width : 0), fUInt(7, isGroup ? meta.height : 0),
      fUInt(8, meta.duration), fUInt(9, 0)
    )
    var infoThumb = cat(
      fUInt(1, thumb.length), fStr(2, thumbMd5Hex), fStr(3, thumbSha1Hex), fStr(4, 'thumb.jpg'),
      fBytes(5, fUInt(1, 1)),
      fUInt(6, 1), fUInt(7, 1), fUInt(8, 0), fUInt(9, 0)
    )
    var upload = cat(
      fBytes(1, cat(fBytes(1, infoMain), fUInt(2, 0))),
      fBytes(1, cat(fBytes(1, infoThumb), fUInt(2, 100))),
      fBytes(4, rand),
      fUInt(5, 2),
      videoExtBiz()
    )
    var body = cat(fBytes(1, reqHead), fBytes(2, upload))
    var cmdName = isGroup ? 'OidbSvcTrpcTcp.0x11ea_100' : 'OidbSvcTrpcTcp.0x11e9_100'

    return sso(cmdName, cat(fUInt(1, isGroup ? 0x11EA : 0x11E9), fUInt(2, 100), fBytes(4, body)), { buffer: true }).then(function (rsp) {
      var env = decode(rsp)
      var payload0 = first(env, 4)
      if (!payload0) throw new Error('视频上传申请没有返回数据体')
      var root = decode(payload0)
      var head = first(root, 1) ? decode(first(root, 1)) : {}
      var retCode = Number(first(head, 2) || 0)
      if (retCode) throw new Error('视频上传申请被拒绝（' + retCode + '）' + utf8(first(head, 3)))
      var up = first(root, 2) ? decode(first(root, 2)) : null
      if (!up) throw new Error('视频上传返回体缺 upload 段')

      var uKey = utf8(first(up, 1))
      var ipv4s = (up[3] || []).map(function (bb) {
        var d = decode(bb)
        return { ip: Number(first(d, 1) || 0), port: Number(first(d, 2) || 0) }
      })
      var msgInfoRaw = first(up, 6)
      if (!msgInfoRaw) throw new Error('视频上传响应缺 msgInfo(f6)')
      var msgInfo = decode(msgInfoRaw) /* f6 是嵌套 bytes：NTV2UploadRespMsgInfo{msgInfoBody repeated<1>} */
      var bodies = (msgInfo[1] || []).slice()
      if (bodies.length < 2) throw new Error('视频上传响应 msgInfoBody 少于 2（主/缩）')
      var uuids = bodies.map(function (bb) {
        var d = decode(bb)
        var idx = first(d, 1) ? decode(first(d, 1)) : null
        return idx ? utf8(first(idx, 2)) : ''
      })
      var subFiles = (up[10] || []).map(function (bb) {
        var d = decode(bb)
        return { subType: Number(first(d, 1) || 0), uKey: utf8(first(d, 2)) }
      })
      var thumbUKey = ''
      subFiles.forEach(function (x) { if (x.subType === 100 && x.uKey) thumbUKey = x.uKey })
      if (!thumbUKey && subFiles.length) thumbUKey = subFiles[0].uKey

      function netPart () {
        if (!ipv4s.length) return null
        return fBytes(5, cat.apply(null, ipv4s.map(function (x) {
          return fBytes(1, cat(fBytes(1, cat(fUInt(1, 1), fStr(2, ipStr(x.ip)))), fUInt(2, x.port)))
        })))
      }
      function videoExtend (uKey2, uuid2, sha1Buf) {
        var parts = [fStr(1, uuid2), fStr(2, uKey2)]
        var n = netPart()
        if (n) parts.push(n)
        bodies.forEach(function (bb) { parts.push(fBytes(6, bb)) })
        parts.push(fUInt(10, BLOCK), fBytes(11, fBytes(1, Array.from(sha1Buf))))
        return cat.apply(null, parts)
      }

      return Promise.all([selfUin(), highwaySession()]).then(function (r) {
        var self = r[0]
        var session = r[1]
        if (!self) throw new Error('尚未识别当前账号，请刷新面板或在 QQ 发送一条消息')
        var puts = [
          putAll(session, {
            uin: self, cmdId: isGroup ? 1005 : 1001,
            bytes: bytes, md5Hex: md5Hex,
            extend: videoExtend(uKey, uuids[0], crypto.createHash('sha1').update(bytes).digest())
          }, { refresh: highwaySession }),
          putAll(session, {
            uin: self, cmdId: isGroup ? 1006 : 1002,
            bytes: thumb, md5Hex: thumbMd5Hex,
            extend: videoExtend(thumbUKey || uKey, uuids[1], crypto.createHash('sha1').update(thumb).digest())
          }, { refresh: highwaySession })
        ]
        return Promise.all(puts).then(function (pr) {
          return { up: up, msgInfoRaw: msgInfoRaw, puts: (pr[0] && pr[0].puts || 0) + (pr[1] && pr[1].puts || 0) }
        })
      })
    }).then(function (done) {
      if (!doSend) {
        return { text: '视频上传完成（未发消息）：' + Math.round(size / 1024 / 1024) + ' MB，分片 ' + done.puts, fileUuid: uuidOf(done.msgInfoRaw) }
      }
      var peer = isGroup ? String(a.id) : String(a.peerUid || '')
      var elem = fBytes(53, cat(fUInt(1, 48), fBytes(2, Buffer.from(done.msgInfoRaw)), fUInt(3, isGroup ? 21 : 11)))
      var payload = {
        isGroup: isGroup,
        groupCode: a.id,
        uin: a.uin || (isGroup ? 0 : a.id),
        uid: isGroup ? '' : String(a.peerUid || ''),
        elems: [elem],
        clientSeq: Number(a.clientSeq || 0)
      }
      return sendMsgProto(payload).then(function (r) {
        return {
          text: '已发送视频到 ' + (isGroup ? '群 ' : '') + (a.id || peer) + '（' + (size / 1024 / 1024).toFixed(1) + ' MB，' + meta.duration + 's' + (done.puts ? '，上传 ' + done.puts + ' 片' : '，秒传') + '）',
          seq: r.groupSeq || r.privateSeq,
          random: r.random
        }
      })
      function uuidOf (raw) {
        try {
          var d = decode(raw)
          var b0 = (d[1] || [])[0]
          if (!b0) return ''
          var dd = decode(b0)
          var idx = first(dd, 1) ? decode(first(dd, 1)) : null
          return idx ? utf8(first(idx, 2)) : ''
        } catch (e) { return '' }
      }
    })
  }

  API.sendVideo = function (a) { return doVideo(a, true) }
  API.debugVideo = function (a) { return doVideo(a, false) }

  /* 群文件上传（0x6D6_0 申请 → Highway cmdId 71 直传 → 0x6D9_4 publish）
   * 三段式口径（对照公开实现 V2）：
   *   - 0x6D6_0 只预检 + 拿 fileId/fileKey/checkKey；boolFileExist=true 可秒传（跳过 PUT）
   *   - 气泡消息不是 PbSendMsg 的 transElem(24)（服务端拒 result=79），必须 0x6D9_4 publish
   *   - Highway ext 是 FileUploadExt（f1=100, f2=1, f100=entry, f200=0），entry 里
   *     busiBuff(f100)/fileEntry(f200)/clientInfo(f300)/fileNameInfo(f400)/host(f500)，
   *     host 配置是 repeated f200（QQ 的 proto 字段号全是 100 系，别按常规小号猜） */
  function doFile (a) {
    if (!fs || !crypto) return Promise.reject(new Error('运行环境缺少文件模块'))
    var path = String((a && a.path) || '')
    if (!path) return Promise.reject(new Error('缺少文件路径'))
    if (!fs.existsSync(path)) return Promise.reject(new Error('文件不存在：' + path))
    if (a.type !== 'group') return Promise.reject(new Error('目前仅支持群文件发送，暂不支持私聊发送文件'))
    var bytes = fs.readFileSync(path)
    if (!bytes.length) return Promise.reject(new Error('文件是空文件'))
    if (bytes.length > 4 * 1024 * 1024 * 1024) return Promise.reject(new Error('文件大小超过 4GB 上限'))
    var isGroup = true
    var groupUin = Number(a.id)
    var size = bytes.length
    var md5Buf = crypto.createHash('md5').update(bytes).digest()
    var md5Hex = md5Buf.toString('hex')
    var sha1Buf = crypto.createHash('sha1').update(bytes).digest()
    var name = String(a.name || nodeReq('path').basename(path) || (md5Hex + '.bin'))
    var folder = String(a.folder || '/')

    /* 1) 0x6D6_0 预检（uinForm） */
    var fileReq = cat(
      fUInt(1, groupUin), fUInt(2, 4), fUInt(3, 102), fUInt(4, 6),
      fStr(5, folder), fStr(6, name), fStr(7, '/' + name),
      fUInt(8, size), fBytes(9, Array.from(sha1Buf)), fBytes(10, []), fBytes(11, Array.from(md5Buf)),
      fUInt(15, 1)
    )
    var env = cat(fUInt(1, 0x6D6), fUInt(2, 0), fBytes(4, fBytes(1, fileReq)), fUInt(12, 1))
    return sso('OidbSvcTrpcTcp.0x6d6_0', env, { buffer: true }).then(function (rsp) {
      var e = decode(rsp)
      var payload0 = first(e, 4)
      if (!payload0) throw new Error('群文件申请没有返回数据体')
      var root = decode(payload0)
      var up = first(root, 1) ? decode(first(root, 1)) : null
      if (!up) throw new Error('群文件返回体缺 upload 段')
      var retCode = Number(first(up, 1) || 0)
      if (retCode) throw new Error('群文件上传被拒绝（' + retCode + '）' + utf8(first(up, 2)))
      var fileId = utf8(first(up, 7))
      if (!fileId) throw new Error('群文件响应缺 fileId')
      var exist = Number(first(up, 10) || 0)
      if (!exist) {
        var host = utf8(first(up, 4)) || utf8(first(up, 5)) || ''
        var port = Number(first(up, 14) || 0)
        var checkKey = first(up, 8) || []
        var fileKey = first(up, 9) || []
        if (!host || !port) throw new Error('群文件上传地址缺失（fileId=' + fileId + '）')
        var fileEntry = cat(
          fUInt(100, size), fBytes(200, Array.from(md5Buf)), fBytes(300, Array.from(checkKey)),
          fBytes(400, Array.from(md5Buf)), fStr(600, fileId), fBytes(700, Array.from(fileKey))
        )
        var clientInfo = cat(fUInt(100, 3), fStr(200, '100'), fUInt(300, 3), fStr(400, '1.1.1'), fUInt(600, 4))
        var hostCfg = cat(
          fBytes(200, cat(fBytes(1, cat(fUInt(1, 1), fStr(2, host))), fUInt(2, port)))
        )
        return Promise.all([selfUin(), highwaySession()]).then(function (r) {
          var self = r[0]
          var session = r[1]
          if (!self) throw new Error('尚未识别当前账号')
          var busiBuff = cat(fUInt(1, 102), fUInt(100, Number(self)), fUInt(200, groupUin), fUInt(400, groupUin))
          var ext = cat(
            fUInt(1, 100), fUInt(2, 1),
            fBytes(100, cat(fBytes(100, busiBuff), fBytes(200, fileEntry), fBytes(300, clientInfo), fBytes(400, fStr(100, name)), fBytes(500, hostCfg)))
          )
          return putAll(session, {
            uin: String(self), cmdId: 71,
            bytes: bytes, md5Hex: md5Hex, extend: ext
          }, { refresh: highwaySession }).then(function (pr) {
            return { fileId: fileId, puts: (pr && pr.puts) || 0 }
          })
        })
      }
      return { fileId: fileId, puts: 0, instant: true }
    }).then(function (done) {
      /* 3) 0x6D9_4 publish：服务端把文件落进群聊（bytes 已在服务器也必须走这步） */
      var info = cat(fUInt(1, 102), fStr(2, done.fileId), fUInt(3, Math.floor(Math.random() * 0x7fffffff)), fUInt(5, 1))
      var body5 = cat(fUInt(1, groupUin), fUInt(2, 2), fBytes(3, info))
      var env2 = cat(fUInt(1, 0x6D9), fUInt(2, 4), fBytes(4, fBytes(5, body5)))
      return sso('OidbSvcTrpcTcp.0x6d9_4', env2, { buffer: true, allowNoRaw: false }).then(function () {
        return {
          text: '群文件已上传：' + name + '（' + (size / 1024).toFixed(1) + ' KB，fileId=' + done.fileId + (done.instant ? '，秒传' : '，上传 ' + done.puts + ' 片') + '）',
          file_id: done.fileId
        }
      })
    })
  }

  API.uploadFile = function (a) { return doFile(a) }

  /* 段类型：text / at / face / image / reply。图片段先各自上传（申请+直传），
     其余段是纯组包，最后按原顺序拼进 msgBody.elem 一次发出。 */

  function md5hex (b) { return crypto.createHash('md5').update(b).digest('hex') }
  function sha1buf (b) { return crypto.createHash('sha1').update(b).digest() }

  /** 传一张图，返回 apply（含 msgInfoBodies）；已存在则秒传 */
  function prepareImage (o) {
    var bytes = o.bytes
    var dim = imageSize(bytes)
    var ctx = {
      type: o.isGroup ? 'group' : 'private',
      id: o.id,
      peerUid: o.peerUid || '',
      size: bytes.length,
      md5Hex: md5hex(bytes),
      sha1Hex: sha1buf(bytes).toString('hex'),
      fileName: o.name,
      width: dim.w,
      height: dim.h,
      format: dim.format,
      summary: o.summary || '[图片]'
    }
    return applyUpload(ctx).then(function (apply) {
      if (!apply.uKey) return apply
      return Promise.all([selfUin(), highwaySession()]).then(function (r) {
        var self = r[0]
        var session = r[1]
        if (!self) throw new Error('尚未识别当前账号，请刷新面板或在 QQ 发送一条消息')
        return putAll(session, {
          uin: self,
          cmdId: o.isGroup ? 1004 : 1003,
          bytes: bytes,
          md5Hex: ctx.md5Hex,
          extend: buildExtend(apply, sha1buf(bytes))
        }, { refresh: highwaySession }).then(function (put) {
          apply.puts = put.puts
          return apply
        })
      })
    })
  }

  function textEl (t) { return fBytes(1, fStr(1, String(t))) }

  /** @人：TextElem{str, pbReserve: {3:type 4:uin 5:0 9:uid}}，type 1=全体 2=单人 */
  function atEl (o) {
    var all = o.all === true || String(o.uin) === 'all' || Number(o.uin) === 0
    var uin = all ? 0 : Number(o.uin) || 0
    var uid = all ? 'all' : String(o.uid || '')
    var extra = cat(fUInt(3, all ? 1 : 2), fUInt(4, uin), fUInt(5, 0), fStr(9, uid))
    var text = o.text || (all ? '@全体成员 ' : '@' + (o.name || uin) + ' ')
    return fBytes(1, cat(fStr(1, text), fBytes(12, extra)))
  }

  function faceEl (id) { return fBytes(2, fUInt(1, Number(id) || 0)) }

  /** 回复：Elem.srcMsg{1: origSeqs, 2: senderUin, 3: time} */
  function replyEl (o) {
    var parts = [fUInt(1, Number(o.seq) || 0)]
    if (Number(o.uin)) parts.push(fUInt(2, Number(o.uin)))
    if (Number(o.time)) parts.push(fUInt(3, Number(o.time)))
    return fBytes(45, cat.apply(null, parts))
  }

  /** uid 补全：@ 要真 uid 服务端才会真的提醒到人 */
  function ensureUid (uin) {
    var key = String(uin || '')
    var map = globalThis.__fl_uidmap || {}
    if (/^u_/.test(String(map[key] || ''))) return Promise.resolve(map[key])
    return peerUidFor(key)
  }

  API.sendRich = function (a) {
    a = a || {}
    if (!fs || !crypto || !http) return Promise.reject(new Error('运行环境缺少文件/网络模块'))
    var segs = Array.isArray(a.segments) ? a.segments : []
    if (!segs.length) return Promise.reject(new Error('消息段为空'))
    var isGroup = a.type === 'group'
    var ready = isGroup
      ? Promise.resolve({ isGroup: true, id: String(a.id), peerUid: '' })
      : (a.peerUid ? Promise.resolve({ isGroup: false, id: String(a.id), peerUid: String(a.peerUid) })
        : peerUidFor(a.id).then(function (uid) {
          if (!uid) throw new Error('私聊 ' + a.id + ' 未获取到成员标识：请让对方先发一条消息')
          return { isGroup: false, id: String(a.id), peerUid: uid }
        }))
    return ready.then(function (peer) {
      /* 顺序：传图 → 补 @ 的 uid → 组包（分开做，免得边组边改） */
      var applies = []
      var applyCount = 0
      var chain = Promise.resolve()
      segs.forEach(function (s, i) {
        if (!s || s.type !== 'image') return
        chain = chain.then(function () {
          var p = String(s.path || s.file || '')
          if (!p || !fs.existsSync(p)) throw new Error('图片不存在：' + p)
          var bytes = fs.readFileSync(p)
          if (!bytes.length) throw new Error('图片是空文件')
          if (bytes.length > 30 * 1024 * 1024) throw new Error('图片体积超过 30MB 限制，请压缩后重试')
          return prepareImage({
            bytes: bytes,
            name: String(s.name || nodeReq('path').basename(p)),
            summary: s.summary || '[图片]',
            isGroup: peer.isGroup,
            id: peer.id,
            peerUid: peer.peerUid
          }).then(function (ap) { applies[i] = ap; applyCount++; return ap })
        })
      })
      return chain.then(function () { return fillAtUids(segs, peer) }).then(function () {
        var elems = []
        segs.forEach(function (s, i) {
          if (!s) return
          if (s.type === 'text') { if (String(s.text || '').length) elems.push(textEl(s.text)) }
          else if (s.type === 'at') { elems.push(atEl(s)) }
          else if (s.type === 'face') { elems.push(faceEl(s.id || s.face)) }
          else if (s.type === 'reply') { elems.push(replyEl(s)) }
          else if (s.type === 'image') {
            var ap = applies[i]
            if (!ap) throw new Error('第 ' + (i + 1) + ' 段图片没有上传结果')
            elems.push(commonElem(picMsgInfo(ap, s.summary || '[图片]', peer.isGroup, {
              subType: (s.flashExt || s.flash) ? 1 : 0,
              resSubType: (s.flashRes || s.flash) ? 1 : 0,
              extF3: s.extF3 ? 1 : 0,
              extF4: s.extF4 ? 1 : 0
            }), peer.isGroup))
          }
        })
        if (!elems.length) throw new Error('消息段全是空的')
        var msg = {
          isGroup: peer.isGroup,
          groupCode: peer.id,
          uin: a.uin || (peer.isGroup ? 0 : peer.id),
          uid: peer.isGroup ? '' : peer.peerUid,
          elem: cat.apply(null, elems),
          elems: elems,
          clientSeq: Number(a.clientSeq || 0)
        }
        return sendMsgProto(msg)
      }).then(function (r) {
        return {
          text: '已发送到 ' + (peer.isGroup ? '群 ' : '') + peer.id + '（' + segs.length + ' 段'
            + (applyCount ? '，' + applyCount + ' 张图' : '') + '）',
          seq: r.groupSeq || r.privateSeq,
          random: r.random,
          segments: segs.length
        }
      })
    })
  }

  /* @ 段缺 uid 时补查（服务端要靠 uid 才真的提醒到人）。群成员 uid 也能从
     uidmap 拿；查不到就退回只带 uin 的形式，至少显示是对的。 */
  function fillAtUids (segs, peer) {
    var need = segs.filter(function (s) {
      return s && s.type === 'at' && String(s.uin) !== 'all' && !s.uid
    })
    if (!need.length) return Promise.resolve()
    /* 群成员表拿一次就够：uid 和显示名都能补上（没名字时 @ 会显示成 QQ 号） */
    var roster = null
    function members () {
      if (roster) return Promise.resolve(roster)
      var ops = globalThis.__fl_ops
      if (!peer || !peer.isGroup || !ops || typeof ops.groupMembers !== 'function') return Promise.resolve([])
      return Promise.resolve(ops.groupMembers({ id: peer.id })).then(function (res) {
        var list = []
        try { list = (typeof res === 'string' ? JSON.parse(res) : res) || [] } catch (e) {}
        roster = list.list || list || []
        return roster
      }, function () { roster = []; return roster })
    }
    return Promise.all(need.map(function (s) {
      return ensureUid(s.uin).then(function (uid) {
        if (uid) s.uid = uid
        return members().then(function (list) {
          var hit = list.find(function (m) { return String(m.qq) === String(s.uin) })
          if (!hit) return
          if (!s.uid && hit.uid) s.uid = hit.uid
          if (!s.name) s.name = hit.card || hit.name || hit.nick || ''
        })
      }, function () {})
    })).then(function () {})
  }

  /* 排障：纯文本走 PbSendMsg（隔离「命令本身有毒」还是「媒体元素有毒」） */
  API.debugSendText = function (o) {
    o = o || {}
    var isGroup = o.type !== 'private'
    var textElem = fBytes(1, fStr(1, String(o.text == null ? '发送功能测试' : o.text)))
    return sendMsgProto({
      isGroup: isGroup,
      groupCode: o.id,
      uin: o.uin || o.id,
      uid: o.uid || '',
      elem: textElem
    }).then(function (r) {
      return { text: '测试文本已发送（' + r.raw + '）', seq: r.groupSeq || r.privateSeq, random: r.random }
    })
  }
  /* 排障：走内核 sendMsg 发图片（对照实验：PbSendMsg 通道被内核白名单挡在外面，
     这里看内核自己的富媒体管线到底卡哪个字段） */
  API.debugKernelSend = function (o) {
    o = o || {}
    var isGroup = o.type !== 'private'
    var peer = isGroup ? String(o.id) : String(o.peerUid || '')
    if (!peer) return Promise.reject(new Error('缺少目标'))
    var chatType = isGroup ? 2 : 1
    var m = ms()
    var mid = ''
    try { mid = String(m.generateMsgUniqueId(chatType, globalThis.__fl_session.getMSFService().getServerTime())) } catch (e) { mid = '7' + Date.now() }
    var b = o.bytes || Buffer.from('89504e470d0a1a0a', 'hex')
    var dim = imageSize(b)
    var el = {
      elementType: 2,
      elementId: '',
      elementGroupId: 0,
      extBufForUI: {},
      picElement: {
        picSubType: 0,
        fileName: o.fileName || 'debug.png',
        fileSize: String(b.length),
        picWidth: dim.w,
        picHeight: dim.h,
        original: true,
        md5HexStr: o.md5 || '',
        sourcePath: o.sourcePath || '',
        thumbPath: {},
        transferStatus: 0,
        progress: 0,
        picType: 0,
        invalidState: 0,
        fileUuid: '',
        fileSubId: '',
        thumbFileSize: 0,
        summary: '[图片]',
        originImageMd5: '',
        originImageUrl: null,
        storeID: 0,
        emojiFrom: 0,
        isInApplicationDataPath: null,
        bytesReserveInfo: ''
      }
    }
    if (o.patch && typeof o.patch === 'object') {
      for (var k in o.patch) if (Object.prototype.hasOwnProperty.call(o.patch, k)) el.picElement[k] = o.patch[k]
    }
    var p = m.sendMsg('0', { chatType: chatType, peerUid: peer, guildId: String(mid) }, [el], new Map())
    return Promise.resolve(p).then(function (r) {
      var code = (r && typeof r === 'object') ? (r.result != null ? r.result : r.code) : 0
      if (code) throw new Error('消息发送失败（' + code + '）' + ((r && r.errMsg) || ''))
      return { text: '消息已发出', element: el.picElement }
    })
  }

  /* 闪照（NT 原生通道）：picElement.isFlashPic=true 走内核 sendMsg，
     QQ 客户端自己上传组包（CQCode flash → isFlashPic: true），
     modern QQ 的闪照不走旧协议 serviceType=3（那路 resId 是 NT blob，客户端解析不了，
     表现为闪照不生效），
     picElement 只要 5 个必填字段，别的内核自己填，
     塞多了（fileSize 传 String 之类）反而 rich media transfer failed。 */
  API.sendFlashNT = function (o) {
    o = o || {}
    var isGroup = o.type !== 'private'
    var peer = isGroup ? String(o.id) : String(o.peerUid || '')
    var p = String(o.path || '')
    if (!peer) return Promise.reject(new Error('缺少目标'))
    if (!p) return Promise.reject(new Error('缺少本地图片路径'))
    var dim = imageSize(fs.readFileSync(p))
    var chatType = isGroup ? 2 : 1
    var m = ms()
    var mid = ''
    try { mid = String(m.generateMsgUniqueId(chatType, globalThis.__fl_session.getMSFService().getServerTime())) } catch (e) { mid = '7' + Date.now() }
    var el = {
      elementType: 2,
      picElement: {
        picWidth: dim.w,
        picHeight: dim.h,
        sourcePath: p,
        picSubType: 0,
        summary: '',
        isFlashPic: true
      }
    }
    var pr = m.sendMsg('0', { chatType: chatType, peerUid: peer, guildId: String(mid) }, [el], new Map())
    return Promise.resolve(pr).then(function (r) {
      var code = (r && typeof r === 'object') ? (r.result != null ? r.result : r.code) : 0
      if (code) throw new Error('消息发送失败（' + code + '）' + ((r && r.errMsg) || ''))
      return { text: '闪照已发出', element: el.picElement }
    })
  }

  API.imageSize = imageSize
  /* 诊断口：单独跑一次上传申请，看服务端回了什么（面板无入口） */
  API.debugApply = applyUpload
  API._node = { fs: fs, crypto: crypto, http: http }
  /* 内部件：只给排障脚本用，面板不碰 */
  API._in = {
    apply: applyUpload, session: highwaySession, put: putAll,
    head: highwayHead, frame: packFrame, post: httpPost, rsp: parseHighwayRsp,
    extend: buildExtend, ipStr: ipStr, fUInt: fUInt, fStr: fStr, fBytes: fBytes, cat: cat
  }
  globalThis.__fl_media = API
})();
