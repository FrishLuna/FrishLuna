(function () {
  if (globalThis.__fl_watch && globalThis.__fl_watch.v >= 3) return

  var W = globalThis.__fl_watch = {
    v: 3,
    on: false,
    t0: Date.now(),
    /* 回调名 → { n: 次数, shape: 首次实参摘要, at: 首次时间 } */
    names: {},
    /* 归一生效过的事件计数：kind → n */
    kinds: {},
    /* 最近归一生效的事件（环形，面板诊断用） */
    recent: [],
    /* 挂载结果：service 名 → 'ok' | 'no-add' | 'throw:xxx' */
    attached: {},
    errs: []
  }

  var RING = 60

  function emit (o) { try { __fl_emit(JSON.stringify(o)) } catch (e) {} }
  function err (where, e) {
    var m = where + ': ' + (e && e.message ? e.message : String(e))
    W.errs.push(m)
    if (W.errs.length > 20) W.errs.shift()
    emit({ evt: 'watch-err', e: m })
  }

  /* 候选回调名
     原生侧可能用 Object.keys(listener) 决定调哪些，所以 ownKeys 必须给全，
     否则「猜不到的名字」永远收不到。给多了无害：不会被调的那些只是死键。 */
  var CAND = [
    /* 群：成员 / 资料 / 文件 / 精华 / 申请 */
    'onMemberListChange', 'onGroupMemberListChange', 'onGroupMemberListUpdate',
    'onMemberInfoChange', 'onMemberCardChange', 'onMemberRoleChange', 'onMemberMuteChange',
    'onMemberJoin', 'onMemberLeave', 'onMemberKick', 'onGroupMemberAdd', 'onGroupMemberDelete',
    'onGroupListUpdate', 'onGroupDetailInfoChange', 'onGroupBulletinChange',
    'onGroupFileChange', 'onGroupFileListChange', 'onGroupFileUpload', 'onGroupFileDelete',
    'onGroupEssenceChange', 'onGroupEssenceChange', 'onEssenceChange',
    'onGroupRequestChange', 'onGroupJoinRequest', 'onGroupInviteRequest', 'onGroupApplyChange',
    'onGroupAdminChange', 'onGroupNameChange', 'onGroupShutUpChange',
    /* 好友 / 资料 */
    'onBuddyListChange', 'onBuddyListChangedV2', 'onBuddyReqChange', 'onFriendRequest',
    'onFriendAdd', 'onFriendDelete', 'onBuddyInfoChange',
    'onProfileChange', 'onSelfProfileChange', 'onProfileInfoChange',
    /* 消息（只计数，不重复派发：inbound.js 已经挂了同一条链） */
    'onRecvMsg', 'onRecvMsgSvrWithMsgArgs', 'onMsgInfoListUpdate', 'onMsgDelete',
    /* 其他 */
    'onFileAssistantChange', 'onCollectionChange', 'onRobotChange',
    'onGroupAlbumChange', 'onGroupNoticeChange', 'onGroupTransferChange'
  ]

  /* 归一化规则
     kind 约定（host 侧映射 OneBot notice）：
       group-member-list  成员列表变了（只给位置，具体谁进谁出由 host 调用户）
       member-card        群名片变
       member-role        群角色变
       group-file         群文件变动
       group-essence      精华消息变动
       friend-request     好友申请
       group-request      入群申请
       group-detail       群资料变动
       group-list         群列表变动
       buddy-list         好友列表变动
       profile            资料变动
       touch              已知会变但结构未明的（带 raw 给 host 诊断）
  */
  var RULES = [
    [/^onMemberListChange$|^onGroupMemberList(Change|Update)$/, 'group-member-list'],
    [/^onMemberInfoChange$/, 'member-info'],
    [/Card/i, 'member-card'],
    [/Role|Admin/i, 'member-role'],
    [/Mute|ShutUp/i, 'member-mute'],
    [/GroupFile|Transfer/i, 'group-file'],
    [/Essence/i, 'group-essence'],
    [/GroupRequest|JoinRequest|InviteRequest|ApplyChange/i, 'group-request'],
    [/BuddyReq|FriendRequest|FriendAdd|FriendDelete/i, 'friend-request'],
    [/GroupDetail|Bulletin|Notice|GroupName/i, 'group-detail'],
    [/GroupList/i, 'group-list'],
    [/BuddyList|BuddyInfo/i, 'buddy-list'],
    [/Profile/i, 'profile'],
    [/MemberJoin|MemberLeave|MemberKick|GroupMemberAdd|GroupMemberDelete/i, 'member-change']
  ]
  /* 这些只计数，不派发事件（消息走 inbound.js，避免重复） */
  var QUIET = /^on(RecvMsg|RecvMsgSvrWithMsgArgs|MsgInfoListUpdate|MsgDelete)$/

  function ruleOf (name) {
    for (var i = 0; i < RULES.length; i++) if (RULES[i][0].test(name)) return RULES[i][1]
    return null
  }

  function json (x, cap) {
    try {
      var s = JSON.stringify(x)
      if (!s) return String(x)
      return s.length > cap ? s.slice(0, cap) + '…' : s
    } catch (e) { return '[unjson]' }
  }

  /* 从任意实参里挖群号：先看有没有现成的 groupCode / groupUin 字段，
     再退而看形如 5~12 位数字的字符串 */
  function digGroup (args) {
    for (var i = 0; i < args.length; i++) {
      var a = args[i]
      if (a === null || a === undefined) continue
      if (typeof a === 'string' && /^\d{5,12}$/.test(a)) return a
      if (typeof a === 'object') {
        var keys = ['groupCode', 'groupUin', 'group_id', 'groupId', 'peerUid', 'sceneId']
        for (var k = 0; k < keys.length; k++) {
          var v = a[keys[k]]
          if (v !== undefined && v !== null && /^\d{5,12}$/.test(String(v).replace(/_.*$/, ''))) {
            return String(v).replace(/_.*$/, '')
          }
        }
      }
    }
    return ''
  }

  /* 挖 uid 列表（成员变动事件里常常只有 uid，没有 QQ 号）。
     这份列表只在本进程内比对用，绝不整份传给 host —— 1866 人的群一次就是几十 KB。 */
  var UID_CAP = 4000
  function digUids (args) {
    var out = []
    function push (v) {
      var s = String(v || '')
      if (/^u_[\w-]{6,}$/.test(s) && out.indexOf(s) < 0) out.push(s)
    }
    function walk (o, depth) {
      if (!o || depth > 3 || out.length >= UID_CAP) return
      if (typeof o === 'string') return
      if (Array.isArray(o)) { for (var i = 0; i < o.length && i < UID_CAP; i++) walk(o[i], depth + 1); return }
      if (typeof o !== 'object') return
      var keys = Object.keys(o)
      for (var i = 0; i < keys.length && i < 40; i++) {
        var k = keys[i]
        var v = o[k]
        if (/uid/i.test(k) && typeof v === 'string') push(v)
        else if (v && typeof v === 'object') walk(v, depth + 1)
      }
    }
    for (var i = 0; i < args.length; i++) walk(args[i], 0)
    return out
  }

  /* 成员名单：本地留存 + 做差
     内核只推「当前名单」，不告诉你谁进谁出。名单留在本进程里比，只把差集发出去：
     省带宽，也避免 host 侧拿被截断的名单误判成一堆退群。 */
  var MEMBER = {}
  var MEMBER_GROUPS_MAX = 60
  /* 诊断出口：面板/探针能看到「基线里有几个群、每个群多少人」 */
  W._member = MEMBER

  function handleMemberList (args, at) {
    var group = digGroup(args)
    var uids = digUids(args)
    if (!group || !uids.length) return false
    var cur = {}
    for (var i = 0; i < uids.length; i++) cur[uids[i]] = 1
    var prev = MEMBER[group]

    if (!prev) {
      /* 第一次见到这个群：只建基线，不产生事件（否则等于把全群报成新成员） */
      emit({ evt: 'watch', kind: 'member-baseline', group: group, total: uids.length, at: at })
    } else {
      var added = []
      var removed = []
      for (var a in cur) if (!prev.u[a]) added.push(a)
      for (var r in prev.u) if (!cur[r]) removed.push(r)
      if (added.length || removed.length) {
        if (added.length + removed.length <= 80) {
          emit({
            evt: 'watch',
            kind: 'member-diff',
            group: group,
            added: added.slice(0, 40),
            removed: removed.slice(0, 40),
            total: uids.length,
            at: at
          })
          W.kinds['member-diff'] = (W.kinds['member-diff'] || 0) + 1
          W.recent.push({ kind: 'member-diff', group: group, at: at, n: added.length + removed.length })
          if (W.recent.length > RING) W.recent.shift()
        } else {
          /* 一次差太多 = 名单整体刷新（或进群/退群风暴），不逐条派发，只上报数量 */
          emit({ evt: 'watch', kind: 'member-bulk', group: group, added: added.length, removed: removed.length, total: uids.length, at: at })
        }
      }
    }
    MEMBER[group] = { u: cur, t: at }
    var gs = Object.keys(MEMBER)
    if (gs.length > MEMBER_GROUPS_MAX) delete MEMBER[gs[0]]
    return true
  }

  /* 从实参里挖「可能是业务字段」的值。
     名字按内核常见命名猜，挖到什么给什么，挖不到就不带这个键 ——
     host 只信这里给的东西，绝不去解析被截断的 JSON 字符串。 */
  var FIELD_KEYS = {
    card: /^(cardName|card|memberCard|newCard|groupCard)$/i,
    role: /^(role|memberRole|adminFlag|isAdmin|memberRoleType)$/i,
    nick: /^(nick|nickName|memberName|remark)$/i,
    fileName: /^(fileName|name|file_name)$/i,
    fileSize: /^(fileSize|size|file_size)$/i,
    fileId: /^(fileId|fileUuid|fileID|file_id)$/i,
    comment: /^(comment|applyMsg|reqMsg|message|verifyInfo|applyMessage)$/i,
    msgId: /^(msgId|messageId|msgSeq)$/i,
    operator: /^(operatorUid|adminUid|opUid|inviterUid)$/i
  }

  function digFields (args) {
    var out = {}
    function walk (o, depth) {
      if (!o || depth > 3) return
      if (Array.isArray(o)) { for (var i = 0; i < o.length && i < 30; i++) walk(o[i], depth + 1); return }
      if (typeof o !== 'object') return
      var keys = Object.keys(o)
      for (var i = 0; i < keys.length && i < 40; i++) {
        var k = keys[i]
        var v = o[k]
        for (var f in FIELD_KEYS) {
          if (!Object.prototype.hasOwnProperty.call(FIELD_KEYS, f)) continue
          if (out[f] !== undefined) continue
          if (!FIELD_KEYS[f].test(k)) continue
          if (typeof v === 'string' || typeof v === 'number') out[f] = v
        }
        if (v && typeof v === 'object') walk(v, depth + 1)
      }
    }
    for (var i = 0; i < args.length; i++) walk(args[i], 0)
    return out
  }

  /* sysmsg：内核把系统消息当裸 protobuf 字节数组推过来
     onRecvSysMsg(argc=1) 的唯一实参是 Int8Array（有符号字节，-111 就是 0x91）。
     好友申请 / 入群申请 / 群通知 全走这条通道，但字段号没有任何文档。
     这里做一次「通用」解码：不猜语义，只把 wire 结构摊平成树 ——
     真正的样本一到，按字段号补映射就行，不用再抓一次。 */
  function toBytes (x) {
    if (!x) return null
    if (typeof Uint8Array !== 'undefined' && x instanceof Uint8Array) return x
    if (Array.isArray(x)) {
      var b = new Uint8Array(x.length)
      for (var i = 0; i < x.length; i++) b[i] = x[i] & 0xff
      return b
    }
    if (x.buffer && typeof x.length === 'number') {
      try { return new Uint8Array(x.buffer, x.byteOffset || 0, x.length) } catch (e) { return null }
    }
    return null
  }

  function utf8 (b) {
    var s = ''
    try { s = decodeURIComponent(escape(String.fromCharCode.apply(null, b))) } catch (e) {
      for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i])
    }
    return s
  }

  /* 可打印判断：sysmsg 里字符串字段不少，能当人话读的就别当嵌套消息解析 */
  function printable (s) {
    if (!s || !s.length) return false
    var bad = 0
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i)
      if (c === 9 || c === 10 || c === 13) continue
      if (c < 32 || c === 0xfffd) bad++
    }
    return bad / s.length < 0.15
  }

  function pbDecode (buf, depth, budget) {
    var out = {}
    var i = 0
    function varint () {
      var v = 0
      var shift = 0
      while (i < buf.length) {
        var b = buf[i++]
        v += (b & 0x7f) * Math.pow(2, shift)
        shift += 7
        if (!(b & 0x80)) break
        if (shift > 63) break
      }
      return v
    }
    while (i < buf.length && budget.n > 0) {
      var tag = varint()
      if (!tag) break
      var field = Math.floor(tag / 8)
      var wire = tag & 7
      budget.n--
      if (wire === 0) {
        out[field] = varint()
      } else if (wire === 1) {
        i += 8
        out[field] = '[fixed64]'
      } else if (wire === 5) {
        i += 4
        out[field] = '[fixed32]'
      } else if (wire === 2) {
        var len = varint()
        if (len < 0 || i + len > buf.length) break
        var slice = buf.subarray(i, i + len)
        i += len
        var txt = utf8(slice)
        if (printable(txt) && txt.length >= 2) out[field] = txt
        else if (depth < 6) out[field] = pbDecode(slice, depth + 1, budget)
        else out[field] = '[bytes ' + len + ']'
      } else {
        break   /* 3/4 组已废弃，遇到就停：宁可少解，不许解错 */
      }
    }
    return out
  }

  function decodeSysMsg (args) {
    var bytes = null
    for (var i = 0; i < args.length; i++) {
      bytes = toBytes(args[i])
      if (bytes && bytes.length) break
    }
    if (!bytes || !bytes.length) return null
    var budget = { n: 400 }
    var tree = {}
    try { tree = pbDecode(bytes, 0, budget) } catch (e) { return { bytes: bytes.length, err: String(e && e.message) } }
    return { bytes: bytes.length, tree: tree, cut: budget.n <= 0 }
  }

  function dispatch (name, args) {
    var t = Date.now()
    var rec = W.names[name]
    if (!rec) {
      rec = W.names[name] = { n: 0, at: t, argc: args.length, shape: [] }
      for (var i = 0; i < args.length && i < 3; i++) rec.shape.push(json(args[i], 500))
      /* 第一次见到这个回调名：上报一次（host 记日志，方便后续补规则） */
      emit({ evt: 'watch-first', name: name, argc: args.length, shape: rec.shape })
    }
    rec.n++

    if (QUIET.test(name)) return

    /* 系统消息（申请/通知）：裸 protobuf，解成树再送出 */
    if (name === 'onRecvSysMsg') {
      var d = decodeSysMsg(args)
      if (!d) return
      W.kinds.sysmsg = (W.kinds.sysmsg || 0) + 1
      W.recent.push({ kind: 'sysmsg', at: t, n: d.bytes })
      if (W.recent.length > RING) W.recent.shift()
      emit({ evt: 'watch', kind: 'sysmsg', at: t, bytes: d.bytes, tree: d.tree, cut: d.cut, err: d.err })
      return
    }

    var kind = ruleOf(name)
    if (!kind) return

    /* 成员名单走本地做差，不把整份名单发给 host */
    if (kind === 'group-member-list') {
      try { handleMemberList(args, t) } catch (e) { err('member-list', e) }
      return
    }

    var uids = digUids(args)
    var ev = {
      evt: 'watch',
      kind: kind,
      name: name,
      group: digGroup(args),
      uids: uids,
      trunc: uids.length >= UID_CAP,
      argc: args.length,
      at: t
    }
    /* 只带最多 2 个实参的短摘要，避免把整份成员列表塞进管道 */
    ev.sample = []
    for (var j = 0; j < args.length && j < 2; j++) ev.sample.push(json(args[j], 400))
    ev.fields = digFields(args)

    W.kinds[kind] = (W.kinds[kind] || 0) + 1
    W.recent.push({ kind: kind, name: name, group: ev.group, at: t })
    if (W.recent.length > RING) W.recent.shift()
    emit(ev)
  }

  function listenerFor (label) {
    return new Proxy({}, {
      get: function (t, k) {
        if (typeof k === 'symbol') return undefined
        if (k === 'then' || k === 'toJSON' || k === 'inspect') return undefined
        return function () {
          try { dispatch(String(k), Array.prototype.slice.call(arguments)) } catch (e) { err(label + '/' + String(k), e) }
        }
      },
      has: function (t, k) {
        if (typeof k === 'symbol') return false
        return true
      },
      ownKeys: function () { return CAND },
      getOwnPropertyDescriptor: function (t, k) {
        return { enumerable: true, configurable: true, value: true, writable: true }
      }
    })
  }

  var TARGETS = [
    ['getGroupService', 'addKernelGroupListener', 'removeKernelGroupListener'],
    ['getBuddyService', 'addKernelBuddyListener', 'removeKernelBuddyListener'],
    ['getMsgService', 'addKernelMsgListener', 'removeKernelMsgListener'],
    ['getProfileService', 'addKernelProfileListener', 'removeKernelProfileListener'],
    ['getFileAssistantService', 'addKernelFileAssistantListener', 'removeKernelFileAssistantListener'],
    ['getCollectionService', 'addKernelCollectionListener', 'removeKernelCollectionListener'],
    ['getRobotService', 'addKernelRobotListener', 'removeKernelRobotListener']
  ]

  W.start = function () {
    var s = globalThis.__fl_session
    if (!s) return 'NO_SESSION'
    if (W.on) return 'ALREADY'
    var ok = 0
    for (var i = 0; i < TARGETS.length; i++) {
      var g = TARGETS[i][0]
      var add = TARGETS[i][1]
      var del = TARGETS[i][2]
      try {
        var svc = null
        try { svc = s[g]() } catch (e) { W.attached[g] = 'get-throw:' + (e && e.message); continue }
        if (!svc) { W.attached[g] = 'null'; continue }
        if (typeof svc[add] !== 'function') { W.attached[g] = 'no-add'; continue }
        var h = svc[add](listenerFor(g))
        W.attached[g] = 'ok'
        W.handles = W.handles || []
        W.handles.push({ svc: svc, del: del, handle: h })
        ok++
      } catch (e) {
        W.attached[g] = 'throw:' + (e && e.message ? e.message : String(e))
        err('attach/' + g, e)
      }
    }
    W.on = ok > 0
    emit({ evt: 'watch-ready', ok: ok, attached: W.attached })
    return 'ok=' + ok
  }

  W.stop = function () {
    var hs = W.handles || []
    for (var i = 0; i < hs.length; i++) {
      try {
        if (typeof hs[i].svc[hs[i].del] === 'function') hs[i].svc[hs[i].del](hs[i].handle)
      } catch (e) {}
    }
    W.handles = []
    W.on = false
    return 'stopped'
  }

  W.status = function () {
    return JSON.stringify({
      on: W.on,
      up: Math.round((Date.now() - W.t0) / 1000),
      attached: W.attached,
      names: W.names,
      kinds: W.kinds,
      recent: W.recent.slice(-10)
    })
  }

  /* 自动挂：session 有了就试着挂，但服务可能还没初始化完（getXxxService 返回 null）。
     原来只要 session 在就只试一次、失败就永久放弃 —— QQ 启动早期服务未就绪时，
     收消息能力会整个丢掉。这里改成失败继续等，最多等 5 分钟。 */
  var tries = 0
  var timer = setInterval(function () {
    if (!globalThis.__fl_watch || globalThis.__fl_watch !== W) { clearInterval(timer); return }
    if (W.on) { clearInterval(timer); return }
    if (!globalThis.__fl_session) {
      if (++tries > 150) clearInterval(timer)
      return
    }
    try {
      var r = W.start()
      if (r === 'ok=0' || r === 'NO_SESSION') { if (++tries > 150) clearInterval(timer); return }
    } catch (e) { err('start', e); if (++tries > 150) clearInterval(timer); return }
    clearInterval(timer)
  }, 2000)
  globalThis.__fl_watch_timer = timer
})()
