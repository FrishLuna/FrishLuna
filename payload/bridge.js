(function () {
  if (globalThis.__fl10) return;
  globalThis.__fl10 = { v: '0.10', t: Date.now() };

  /* reload 会重新 eval 本文件：上一实例挂的定时器必须先掐掉，
     否则每重载一次就多一条 500ms 轮询（startup 钩子在注入过早时恒重试） */
  ;['__fl_hs_timer', '__fl_rs_timer', '__fl_ib_timer', '__fl_poll_timer', '__fl_hb_timer'].forEach(function (k) {
    try { if (globalThis[k]) { clearInterval(globalThis[k]); globalThis[k] = null; } } catch (e) {}
  });

  function emit(o) { try { __fl_emit(JSON.stringify(o)); } catch (e) {} }
  function safe(fn, def) {
    try { var v = fn(); return v === undefined ? (def === undefined ? null : def) : v; }
    catch (e) { return 'ERR:' + (e && e.message ? e.message : String(e)); }
  }

  var req = null, reqFrom = 'none';
  if (typeof require === 'function') { req = require; reqFrom = 'local'; }
  else if (typeof globalThis.require === 'function') { req = globalThis.require; reqFrom = 'global'; }
  else if (process && process.mainModule && typeof process.mainModule.require === 'function') {
    req = process.mainModule.require.bind(process.mainModule); reqFrom = 'mainModule';
  }

  emit({
    evt: 'env', v: '0.10',
    pid: safe(function () { return process.pid; }),
    type: safe(function () { return process.type || 'browser'; }),
    reqFrom: reqFrom,
    node: safe(function () { return process.versions.node; }),
    resPath: safe(function () { return process.resourcesPath; }),
    dir: safe(function () { return __fl_dir; })
  });

  var wrap = globalThis.__fl_wrap || null;
  if (!wrap && req) {
    wrap = safe(function () { return req(process.resourcesPath + '\\app\\wrapper.node'); });
    if (typeof wrap === 'string') { emit({ evt: 'wrap-err', e: wrap.slice(0, 200) }); wrap = null; }
  }
  if (wrap) globalThis.__fl_wrap = wrap;

  /* 只做「记录 + 原样转发」，不改语义；命中后把活对象挂在 globalThis.__fl_live */
  if (wrap && !globalThis.__fl_grab) {
    globalThis.__fl_grab = { hits: 0, sess: [], errs: [] };

    function note(where, extra) {
      var g = globalThis.__fl_grab;
      g.hits++;
      if (g.hits <= 40) emit(Object.assign({ evt: 'grab', where: where, n: g.hits }, extra || {}));
    }
    function describeArgs(args) {
      try {
        var out = [];
        for (var i = 0; i < args.length && i < 6; i++) {
          var a = args[i];
          if (a === null || a === undefined) { out.push(a); continue; }
          var t = typeof a;
          if (t !== 'object') { out.push(t === 'function' ? '[fn]' : a); continue; }
          var own = [];
          try { own = Object.getOwnPropertyNames(a); } catch (e) {}
          var o = {};
          own.slice(0, 16).forEach(function (k) {
            if (k === 'constructor') return;
            try {
              var v = a[k];
              o[k] = (v === null || v === undefined) ? v
                : (typeof v === 'object' ? (Array.isArray(v) ? '[arr:' + v.length + ']' : '[obj]')
                  : (typeof v === 'function' ? '[fn]' : String(v).slice(0, 80)));
            } catch (e) { o[k] = '[err]'; }
          });
          out.push(o);
        }
        return out;
      } catch (e) { return ['[args-err]']; }
    }

    /* 透明包装工具：不改 this 绑定，不改返回值 */
    function wrapFn(holder, name, where, onHit) {
      try {
        if (!holder || typeof holder[name] !== 'function') return false;
        var orig = holder[name];
        if (orig.__flWrapped) return true;
        var w = function () {
          try { onHit(this, arguments); } catch (e) {}
          return orig.apply(this, arguments);
        };
        w.__flWrapped = true;
        w.__flOrig = orig;
        /* 保持原函数的 prototype 链（有些调用方会 new） */
        try { w.prototype = orig.prototype; } catch (e) {}
        holder[name] = w;
        return true;
      } catch (e) {
        try { globalThis.__fl_grab.errs.push(where + ':' + (e && e.message)); } catch (x) {}
        return false;
      }
    }

    var S = wrap.NodeIQQNTWrapperSession;
    var SU = wrap.NodeIQQNTStartupSessionWrapper;

    /* 1) 静态工厂：本体拿到哪个 session，我们就跟到哪个（一层包装同时记参数+返回值） */
    try {
      if (S && typeof S.getNTWrapperSession === 'function' && !S.getNTWrapperSession.__flRet) {
        var origGet = S.getNTWrapperSession;
        var g2 = function () {
          var r = origGet.apply(this, arguments);
          try { note('getNTWrapperSession', { args: describeArgs(arguments) }); } catch (e) {}
          try {
            if (r && typeof r === 'object') {
              var g = globalThis.__fl_grab;
              g.sess.push(r);
              if (!globalThis.__fl_live) globalThis.__fl_live = r;
              note('getNTWrapperSession:ret', {
                sid: safe(function () { return r.getSessionId(); }),
                msg: !!safe(function () { return r.getMsgService(); }),
                total: g.sess.length
              });
            }
          } catch (e) {}
          return r;
        };
        g2.__flWrapped = true; g2.__flOrig = origGet; g2.__flRet = true;
        try { g2.prototype = origGet.prototype; } catch (e) {}
        S.getNTWrapperSession = g2;
      }
    } catch (e) {}

    /* 2) 实例 init：抓活的 this 和真 config（最关键的一钩） */
    if (S && S.prototype) {
      wrapFn(S.prototype, 'init', 'session.init', function (self, args) {
        try {
          var g = globalThis.__fl_grab;
          g.live = self;
          globalThis.__fl_live = self;
          globalThis.__fl_live_cfg = args && args[0];
          note('session.init:this', {
            sid: safe(function () { return self.getSessionId && self.getSessionId(); }),
            args: describeArgs(args)
          });
          /* init 之后立刻挂消息监听，赶在最早时机 */
          if (typeof globalThis.__fl_onLive === 'function') {
            try { globalThis.__fl_onLive(self); } catch (e) {}
          }
        } catch (e) {}
      });
    }

    /* 3) startupSession：本体若走 create + start，也记下来 */
    if (SU) {
      ['create', 'createWithModuleList'].forEach(function (m) {
        wrapFn(SU, m, 'startup.' + m, function (self, args) {
          note('startup.' + m, { args: describeArgs(args) });
        });
      });
      if (SU.prototype) {
        wrapFn(SU.prototype, 'start', 'startup.start', function (self, args) {
          try {
            if (!globalThis.__fl_startup) globalThis.__fl_startup = self;
            note('startup.start:this', {});
          } catch (e) {}
        });
      }
    }

    emit({
      evt: 'grab-installed',
      getNT: safe(function () { return !!(S && S.getNTWrapperSession); }),
      init: safe(function () { return !!(S && S.prototype && S.prototype.init); }),
      startup: safe(function () { return !!SU; })
    });
  }

  /* 运行方式（只有一种：旁挂原生客户端）
   * 不 init engine / login / session —— QQ 本体照常登录、UI 完整可用。
   * 我们只提供通道 + 状态 + 注入式调用，绝不干扰客户端。
   * 若将来进程里出现可用的 session（例如换实现），inbound 会自动挂上。
   */
  var dir0 = (typeof __fl_dir === 'string' ? __fl_dir : '')
  globalThis.__fl_client = 'native'
  emit({ evt: 'client', client: 'native', dir: dir0 })

  /* [CATCH] C 钩子送来的本体实例
   * payload.c 持久 hook（napi_get_cb_info + trampoline）把本体每次「新 data」
   * 的 wrapper 方法调用的 this 送进来 —— 那就是本体现役的 session/service。
   * 铁律：这个函数绝不能抛异常（C 侧没清 pending exception，抛了 QQ 直接崩）。
   */
  globalThis.__fl_catches = []
  globalThis.__fl_catch = function (obj) {
    globalThis.__fl_catch_n = (globalThis.__fl_catch_n || 0) + 1   /* fire 诊断计数 */
    try {
      if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return
      var sid = null
      try { sid = String(obj.getSessionId()) } catch (e) { sid = null }
      if (!sid) return                       /* service 等非 session 实例，不记录 */
      var msf = -1
      try { msf = obj.getMSFService().getMsfStatus() } catch (e) { msf = -1 }
      var known = false
      for (var i = 0; i < globalThis.__fl_catches.length; i++)
        if (globalThis.__fl_catches[i].sid === sid) { known = true; break }
      if (!known && globalThis.__fl_catches.length < 40)
        globalThis.__fl_catches.push({ sid: sid, msf: String(msf), t: Date.now() })
      /* 空壳 session 的 msf 恒为 1；非 1 说明内核真挂上了 MSF —— 这就是本体活 session */
      if (msf !== 1 && msf !== -1 && globalThis.__fl_session !== obj) {
        globalThis.__fl_session = obj
        emit({ evt: 'session-got', id: sid, via: 'catch-hook', msf: String(msf) })
      }
    } catch (e) {}
  }

  /* [SESSION] 取本体正在用的那个 session
   * nt_1 是 kernel 的全局单例对象，宿主未登录时拿到的是空壳（服务全 null），
   * 登录成功后同一个对象会自动挂满服务。
   * 所以缓存空壳没关系，但对外必须以 getMsgService() 是否为 null 判「可用」。
   * 拿到之后 msg / group / buddy 等内核服务全部可用，收发消息不需要自己登录，
   * 也不用挂起注入 —— 客户端照常运行，这里只是共用同一个 session 读/调。
   *
   * 铁律：这个 session 归 QQ 本体所有，我们只读不建、绝不 close()/init()/logout()，
   *       否则会把 QQ 自己的客户端踢掉线。
   */
  function resolveSession () {
    if (globalThis.__fl_session) return globalThis.__fl_session
    var W = globalThis.__fl_wrap
    /* 早期注入（挂起）时 wrapper.node 可能还没被主进程 require，这里懒加载补上 */
    if (!W && req) {
      var t = safe(function () { return req(process.resourcesPath + '\\app\\wrapper.node') })
      if (t && typeof t === 'object') { globalThis.__fl_wrap = W = t }
    }
    if (!W || !W.NodeIQQNTWrapperSession) return null
    var S = W.NodeIQQNTWrapperSession
    /* 优先用「本体 startup」里的真实 session id（'nt' -> 'nt_2'）；
       拿不到时退回 nt_1..nt_4 —— 那几个通常只是空壳，仅用于诊断。 */
    var ids = []
    try {
      var st = globalThis.__fl_startup
      if (st) {
        var l = st.getSessionIdList()
        l.forEach(function (v, k) { if (String(k) !== 'gpro' && v) ids.push(String(v)) })
      }
    } catch (e) {}
    if (!ids.length) ids = ['nt_1', 'nt_2', 'nt_3', 'nt_4']
    for (var i = 0; i < ids.length; i++) {
      var s = null
      try { s = S.getNTWrapperSession(ids[i]) } catch (e) {
        // 未创建的 id 会直接抛，属正常，不刷日志
        continue
      }
      if (!s || typeof s !== 'object') continue
      var sid = ids[i]
      try { sid = String(s.getSessionId()) || ids[i] } catch (e) {}
      globalThis.__fl_session = s
      emit({ evt: 'session-got', id: sid, via: 'getNTWrapperSession' })
      return s
    }
    return null
  }
  globalThis.__fl_resolve_session = resolveSession

  /* [STARTUP-HOOK] 截住本体自己的 startup 实例
   * getSessionIdList() 返回 Map<类型, 真实sessionId>，例如 'nt' -> 'nt_2'。
   * 但这个 Map 只有「本体那个 startup 实例」里才是真数据 —— 自己调
   * NodeIQQNTStartupSessionWrapper.create() 建出来的是空实例，还会额外占用一个 id。
   * 所以必须在 QQ 启动前给 create 包一层，本体建 startup 时把实例记下来，
   * 之后用它 getSessionIdList() 拿真实 id，再 getNTWrapperSession(id) 就是活 session。
   */
  function hookStartup () {
    var W = globalThis.__fl_wrap
    if (!W && req) {
      var t = safe(function () { return req(process.resourcesPath + '\\app\\wrapper.node') })
      if (t && typeof t === 'object') { globalThis.__fl_wrap = W = t }
    }
    if (!W || !W.NodeIQQNTStartupSessionWrapper) return false
    var C = W.NodeIQQNTStartupSessionWrapper
    if (C.__fl_startup_hooked) return true
    var orig = C.create
    if (typeof orig !== 'function') return false
    var wrapped = function () {
      var inst = orig.apply(this, arguments)
      try {
        globalThis.__fl_startup = inst
        var ids = ''
        try {
          var l = inst.getSessionIdList()
          var arr = []
          l.forEach(function (v, k) { arr.push(String(k) + '=' + String(v)) })
          ids = arr.join(',')
        } catch (e) { ids = 'ERR' }
        emit({ evt: 'startup-got', ids: ids })
        /* 拿到本体 startup 后立刻解出真 session，不用等 3s 轮询 */
        try {
          var l2 = inst.getSessionIdList()
          var real = []
          l2.forEach(function (v) { if (v && String(v).indexOf('gpro') !== 0) real.push(String(v)) })
          for (var i = 0; i < real.length; i++) {
            var s = W.NodeIQQNTWrapperSession.getNTWrapperSession(real[i])
            if (s && typeof s === 'object') {
              globalThis.__fl_session = s
              emit({ evt: 'session-got', id: real[i], via: 'startup' })
              break
            }
          }
        } catch (e) {}
      } catch (e) {}
      return inst
    }
    var ok = false
    try { C.create = wrapped; ok = C.create === wrapped } catch (e) {}
    if (!ok) { try { Object.defineProperty(C, 'create', { value: wrapped, writable: true, configurable: true }); ok = C.create === wrapped } catch (e) {} }
    if (ok) C.__fl_startup_hooked = true
    emit({ evt: 'startup-hook', ok: ok })
    return ok
  }
  globalThis.__fl_hook_startup = hookStartup
  if (!hookStartup()) {
    /* 早期注入时 wrapper 可能还没就绪：每 500ms 重试最多 60 次（30 秒），
       必须抢在 QQ 自己 create startup 之前挂上。
       boot 注入下先等事件循环转起来（2 秒）再开始碰 wrapper.node。 */
    var hsN = 0
    var hsTimer = null
    setTimeout(function () {
      if (hookStartup() || hsN >= 60) { if (hsTimer) clearInterval(hsTimer); return }
      hsTimer = globalThis.__fl_hs_timer = setInterval(function () {
        hsN++
        if (hookStartup() || hsN >= 60) {
          clearInterval(hsTimer)
          if (hsN >= 60) emit({ evt: 'startup-hook-giveup', tries: hsN })
        }
      }, 500)
    }, 2000)
  }

  /* 注入时先试一次；没拿到就 3s 一次重试（本体可能还在建 session）。
     boot 注入时 QQ 内核还没 init，绝不能在 run_script 栈内直接调 wrapper ——
     至少等事件循环转起来（2 秒）再开始碰内核。 */
  var rsTimer = null
  setTimeout(function () {
    if (!resolveSession()) {
      rsTimer = globalThis.__fl_rs_timer = setInterval(function () {
        if (resolveSession()) { clearInterval(rsTimer); rsTimer = null }
      }, 3000)
    }
  }, 2000)

  /* 运行时状态汇总（host 定时拉） */
  function collectState () {
    var B = globalThis.__fl_boot || {}
    var s = globalThis.__fl_session
    var out = { client: 'native', phase: B.phase || 'idle', login: B.login || null }
    if (s) {
      try { out.session = { id: String(s.getSessionId()) } } catch (e) {}
      /* ready = 内核真的把服务挂上了（登录完成后才为 true）。
         空壳 session（QQ 未登录时拿到）服务全 null，绝不能对外装作可用。 */
      var ready = false
      try { ready = !!(s.getMsgService && s.getMsgService()) } catch (e) { ready = false }
      if (out.session) out.session.ready = ready
      if (B.sessionInit !== undefined) out.session = out.session || {}
      if (out.session) out.session.init = B.sessionInit
      try { out.msf = s.getMSFService().getMsfStatus() } catch (e) {}
    }
    try { out.grab = globalThis.__fl_grab ? globalThis.__fl_grab.hits : 0 } catch (e) {}
    try { out.inbound = globalThis.__fl_inbound ? globalThis.__fl_inbound.count : 0 } catch (e) {}
    try { out.catches = globalThis.__fl_catches } catch (e) {}
    try { out.catch_n = globalThis.__fl_catch_n } catch (e) {}
    return out
  }
  globalThis.__fl_collect = collectState

  /* 有 session 才挂消息入口；旁挂模式永远等不到也没关系（2s 一次纯读变量） */
  emit({ evt: 'attached', note: '原生客户端照常运行，payload 旁挂' })

  /* 实验台功能表（ops.js）：注册 __fl_ops，供 host 的 /api/lab/invoke 调用 */
  try {
    if (dir0 && req) (0, eval)(req('fs').readFileSync(dir0 + 'ops.js', 'utf8'))
    else emit({ evt: 'ops-skip', why: 'no fs' })
  } catch (e) {
    emit({ evt: 'ops-load-err', e: String(e && e.message ? e.message : e) })
  }

  /* 富媒体（media.js）：图片上传与发送，ops 里的 sendImage 转发到这里 */
  try {
    if (dir0 && req) (0, eval)(req('fs').readFileSync(dir0 + 'media.js', 'utf8'))
  } catch (e) {
    emit({ evt: 'media-load-err', e: String(e && e.message ? e.message : e) })
  }

  /* 合并转发（longmsg.js）：自带 protobuf/裸包收发，注册 OPS.forwardUpload/forwardFetch */
  try {
    if (dir0 && req) (0, eval)(req('fs').readFileSync(dir0 + 'longmsg.js', 'utf8'))
  } catch (e) {
    emit({ evt: 'longmsg-load-err', e: String(e && e.message ? e.message : e) })
  }

  /* Qzone 凭据 + AI 语音（qzone.js）：OIDB Buffer 通道，注册 OPS.oidbClientKey/oidbPskey/aiVoiceList/aiVoice */
  try {
    if (dir0 && req) (0, eval)(req('fs').readFileSync(dir0 + 'qzone.js', 'utf8'))
  } catch (e) {
    emit({ evt: 'qzone-load-err', e: String(e && e.message ? e.message : e) })
  }

  var ibTimer = globalThis.__fl_ib_timer = setInterval(function () {
    if (!globalThis.__fl_session) return
    clearInterval(ibTimer)
    try {
      if (dir0 && req) (0, eval)(req('fs').readFileSync(dir0 + 'inbound.js', 'utf8'))
      else emit({ evt: 'inbound-skip', why: 'no fs' })
    } catch (e) {
      emit({ evt: 'inbound-load-err', e: String(e && e.message ? e.message : e) })
    }
    /* 非消息事件观察层：成员/文件/精华/申请等推送 */
    try {
      if (dir0 && req) (0, eval)(req('fs').readFileSync(dir0 + 'watch.js', 'utf8'))
    } catch (e) {
      emit({ evt: 'watch-load-err', e: String(e && e.message ? e.message : e) })
    }
  }, 2000)

  /* state 缓存：前端有多个组件各自轮询 /api/state（1~2 秒一次），
     collectState 每次要调 5~6 个内核接口（getSessionId / getMsgService /
     getMSFService.getMsfStatus …），每个调用都要过 napi_get_cb_info 钩子。
     这条热路径会让 QQ 主进程常驻 40% 左右 CPU，最终把主进程拖到「点击事件
     转发不到渲染进程」—— 现象是窗口能点活但界面完全不响应。
     1.2 秒内复用同一份结果。 */
  var stateCache = { t: 0, s: '' }

  function handle(c) {
    var o;
    try { o = JSON.parse(c); } catch (e) { emit({ evt: 'cmd-bad', err: String(e) }); return; }
    if (!o || !o.cmd) return;
    try {
      if (o.cmd === 'eval') {
        var r = (0, eval)(o.js);
        emit({ evt: 'eval-ok', ret: String(r).slice(0, 12000) });
      } else if (o.cmd === 'reload') {
        if (!req) { emit({ evt: 'reload-no-fs' }); return; }
        var fs = req('fs');
        var p = o.path || ((safe(function () { return __fl_dir; }) || '') + 'bridge.js');
        var src = fs.readFileSync(p, 'utf8');
        /* 旧轮询闭包指向旧 handle，必须停掉重建，否则新命令分支不生效 */
        if (globalThis.__fl_poll_timer) {
          try { clearInterval(globalThis.__fl_poll_timer); clearTimeout(globalThis.__fl_poll_timer); } catch (e) {}
          globalThis.__fl_poll_timer = null;
        }
        globalThis.__fl10 = null;
        /* ops.js 头部有 `if (globalThis.__fl_ops) return`，不清掉就永远不会重载 */
        globalThis.__fl_ops = null;
        globalThis.__fl_ops_meta = null;
        /* 好友表靠 listener 推送攒的，重载后旧 listener 仍指向旧闭包，缓存必须一起作废，
           否则会一直读那份不刷新的死数据 */
        globalThis.__fl_buddy_cache = null;
        /* 群成员详情同样来自 listener 推送，一起作废 */
        globalThis.__fl_member_cache = null;
        /* inbound.js 同理；旧的监听器跟着旧闭包一起作废，重载后重新挂 */
        globalThis.__fl_inbound = null;
        /* watch.js（非消息事件观察层）也一样：旧 Proxy 监听器必须摘掉再重挂 */
        try { if (globalThis.__fl_watch && globalThis.__fl_watch.stop) globalThis.__fl_watch.stop(); } catch (e) {}
        globalThis.__fl_watch = null;
        /* longmsg.js 头部同样有「装过就 return」，不清掉重载后不会重新挂 OPS.forward* */
        globalThis.__fl_longmsg = null;
        /* qzone.js 头部也有同样的守卫 —— 漏清它会导致重载后
           oidbRaw/pskey/AI 语音在新建的 __fl_ops 表上消失（申请审批因此挂掉） */
        globalThis.__fl_qzone = null;
        /* eval 必须兜住异常：上面已经把命令通道掐掉了，
           这里一旦抛，通道就再也回不来（worker 会一直 recv，JS 永远不取）。
           失败时把 __fl10 复位并再试一次，仍失败就退化成「只有 native 通道」，
           至少能 ping/pong，不至于让面板彻底失联。 */
        try {
          (0, eval)(src);
        } catch (e) {
          globalThis.__fl10 = null;
          emit({ evt: 'reload-err', e: String(e && e.message ? e.message : e) });
          try { (0, eval)(fs.readFileSync((safe(function () { return __fl_dir; }) || '') + 'bridge.js', 'utf8')); } catch (e2) {
            emit({ evt: 'reload-fatal', e: String(e2 && e2.message ? e2.message : e2) });
          }
        }
        if (globalThis.__fl_session) { try { (0, eval)(req('fs').readFileSync((safe(function () { return __fl_dir; }) || '') + 'inbound.js', 'utf8')); } catch (e) {} }
        if (globalThis.__fl_session) { try { (0, eval)(req('fs').readFileSync((safe(function () { return __fl_dir; }) || '') + 'watch.js', 'utf8')); } catch (e) {} }
        emit({ evt: 'reload-ok', bytes: src.length });
      } else if (o.cmd === 'hb') {
        emit({ evt: 'hb', manual: true });
      } else if (o.cmd === 'state') {
        var nowS = Date.now()
        if (nowS - stateCache.t >= 1200 || !stateCache.s) {
          stateCache.s = JSON.stringify(collectState())
          stateCache.t = nowS
        }
        var cached = null
        try { cached = JSON.parse(stateCache.s) } catch (e) { cached = collectState() }
        emit({ evt: 'state', data: cached });
      } else if (o.cmd === 'ping') {
        emit({ evt: 'pong', at: Date.now() });
      } else if (o.cmd === 'op') {
        /* 实验台/内核层：调用 ops.js 注册的功能。
           回执必须原样带回 o.seq，host 按 seq 配对（同名 op 并发时会串台）。
           evt 管道按 [uint32 len][json] 成帧、无大小上限，所以结果不截断：
           超过 4096 字节拆成多条 op-chunk（同 seq、带 idx/total），host 侧拼回。 */
        var ops = globalThis.__fl_ops
        var fn = (ops && typeof ops[o.name] === 'function') ? ops[o.name] : null;
        if (!fn) { emit({ evt: 'op-err', name: String(o.name), seq: o.seq, err: '功能未注册：' + String(o.name) }); return }
        Promise.resolve()
          .then(function () { return fn(o.args || {}) })
          .then(function (v) {
            var txt = (v === undefined || v === null) ? 'ok' : (typeof v === 'string' ? v : JSON.stringify(v))
            var CH = 4096
            if (txt.length <= CH) {
              emit({ evt: 'op-ok', name: String(o.name), seq: o.seq, ret: txt });
            } else {
              var total = Math.ceil(txt.length / CH);
              for (var i = 0; i < total; i++) {
                emit({ evt: 'op-chunk', name: String(o.name), seq: o.seq, idx: i, total: total, part: txt.slice(i * CH, (i + 1) * CH) });
              }
            }
          }, function (e) {
            emit({ evt: 'op-err', name: String(o.name), seq: o.seq, err: String(e && e.message ? e.message : e) })
          })
      } else if (o.cmd === 'send') {
        /* host 执行完 #fl 命令后，把回复丢回来发出去。
           成功口径来自 OPS.send（result===0），这里只负责把结果/异常回传，
           绝不在调用瞬间就报 send-ok。 */
        if (typeof globalThis.__fl_send === 'function') {
          Promise.resolve()
            .then(function () { return globalThis.__fl_send(o.to, o.text); })
            .then(function (r) {
              emit({ evt: 'send-ok', to: o.to, ret: String(r === undefined ? 'ok' : r).slice(0, 400) });
            }, function (e) {
              emit({ evt: 'send-fail', to: o.to, e: String(e && e.message ? e.message : e).slice(0, 400) });
            });
        } else {
          emit({ evt: 'send-skip', why: 'no inbound channel' });
        }
      }
    } catch (e) { emit({ evt: 'cmd-err', err: String(e && e.message ? e.message : e) }); }
  }

  /* 命令入口挂到 globalThis：轮询定时器永远调用「最新一代」的 handle，
     reload 后无论旧定时器死活，新 IIFE 都会重建定时器，命令通道不会断 */
  globalThis.__fl_handle_cmd = handle

  if (typeof __fl_poll === 'function') {
    if (globalThis.__fl_poll_timer) {
      try { clearInterval(globalThis.__fl_poll_timer); clearTimeout(globalThis.__fl_poll_timer); } catch (e) {}
      globalThis.__fl_poll_timer = null;
    }
    /* 递归 setTimeout 自续期，而不是 setInterval。
       reload 会先掐掉旧 timer、再 eval 本文件重建；只要中间任何一步
       抛异常，命令通道就永久死掉 —— native 侧一直 recv 命令，
       JS 再也不 __fl_poll，面板所有 op 都变成 15s 超时。
       改成「每次回调第一件事就是把自己重新排上」，单次异常不会让通道断。 */
    var pollTick = function () {
      try {
        globalThis.__fl_poll_timer = setTimeout(pollTick, 300);
        var c = null;
        try { c = __fl_poll(); } catch (e) { return; }
        if (c !== undefined && c !== null && c !== '') {
          try { (globalThis.__fl_handle_cmd || handle)(c); } catch (e) {
            emit({ evt: 'cmd-err', err: String(e && e.message ? e.message : e) });
          }
        }
      } catch (e) {}
    };
    globalThis.__fl_poll_timer = setTimeout(pollTick, 300);
  }

  if (globalThis.__fl_hb_timer) {
    try { clearInterval(globalThis.__fl_hb_timer); } catch (e) {}
    globalThis.__fl_hb_timer = null;
  }
  {
    var n = 0;
    globalThis.__fl_hb_timer = setInterval(function () {
      n += 1;
      emit({ evt: 'hb', n: n, up: Math.round((Date.now() - globalThis.__fl10.t) / 1000), hits: safe(function () { return globalThis.__fl_grab.hits; }) });
      if (n > 720) clearInterval(globalThis.__fl_hb_timer);
    }, 15000);
  }
})();
