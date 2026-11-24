(() => {
  'use strict'

  const $ = (s, r = document) => r.querySelector(s)
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s))

  const MAX_LINES = 800
  const PREF_KEY = 'fl-prefs'
  const TOKEN_KEY = 'fl-token'
  const store = {
    logs: [],
    filterLevel: 'all',
    filterText: '',
    autoScroll: true,
    paused: false,
    state: null,
    prefix: '#fl',
    labKind: 'group',
    labHistory: [],
    labTab: 'read',
    opAutoScroll: true
  }

  function readPrefs () {
    try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {} } catch { return {} }
  }

  function savePrefs (patch) {
    const p = Object.assign(readPrefs(), patch)
    localStorage.setItem(PREF_KEY, JSON.stringify(p))
    return p
  }

  function hexRgb (hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim())
    if (!m) return null
    const n = parseInt(m[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }

  function shiftHue (hex, deg) {
    const rgb = hexRgb(hex)
    if (!rgb) return hex
    const [r, g, b] = rgb.map((x) => x / 255)
    const max = Math.max(r, g, b), min = Math.min(r, g, b)
    let h = 0
    const l = (max + min) / 2
    const d = max - min
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
    if (d !== 0) {
      if (max === r) h = ((g - b) / d) % 6
      else if (max === g) h = (b - r) / d + 2
      else h = (r - g) / d + 4
      h *= 60
    }
    h = (h + deg + 360) % 360
    const c = (1 - Math.abs(2 * l - 1)) * s
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
    const m = l - c / 2
    let [R, G, B] = [0, 0, 0]
    const hh = h / 60
    if (hh < 1) [R, G, B] = [c, x, 0]
    else if (hh < 2) [R, G, B] = [x, c, 0]
    else if (hh < 3) [R, G, B] = [0, c, x]
    else if (hh < 4) [R, G, B] = [0, x, c]
    else if (hh < 5) [R, G, B] = [x, 0, c]
    else [R, G, B] = [c, 0, x]
    const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')
    return '#' + to(R) + to(G) + to(B)
  }

  function resolveTheme (t) {
    if (t === 'light') return 'light'
    if (t === 'system') {
      return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
    }
    return 'dark'
  }

  function applyPrefs (p) {
    p = p || readPrefs()
    document.documentElement.dataset.theme = resolveTheme(p.theme)
    $('#theme-btn .theme-label').textContent = resolveTheme(p.theme) === 'dark' ? '浅色' : '深色'
    if (p.accent) {
      const rgb = hexRgb(p.accent)
      if (rgb) {
        const r = document.documentElement.style
        r.setProperty('--accent', p.accent)
        r.setProperty('--accent-soft', `rgba(${rgb.join(',')}, .12)`)
        r.setProperty('--accent-line', `rgba(${rgb.join(',')}, .35)`)
        r.setProperty('--accent-2', shiftHue(p.accent, -36))
      }
    }
    document.body.classList.toggle('no-anim', p.animations === false)
    if (p.termFont) {
      document.documentElement.style.setProperty('--term-font', p.termFont + 'px')
    }
  }

  function initTheme () {
    const p = readPrefs()
    const saved = p.theme || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    document.documentElement.dataset.theme = resolveTheme(saved)
    $('#theme-btn').addEventListener('click', () => {
      const next = resolveTheme(readPrefs().theme || 'dark') === 'dark' ? 'light' : 'dark'
      savePrefs({ theme: next })
      applyPrefs(savePrefs({}))
      syncPrefsUI()
    })
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if ((readPrefs().theme) === 'system') applyPrefs()
    })
  }

  /* 只认 sessionStorage：关浏览器即失效；旧版留在 localStorage 的令牌一律清掉 */
  function token () {
    return sessionStorage.getItem(TOKEN_KEY) || ''
  }

  function logout () {
    try { localStorage.removeItem(TOKEN_KEY) } catch {}
    sessionStorage.removeItem(TOKEN_KEY)
    location.href = '/login.html'
  }

  async function post (url, body) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-fl-token': token() },
        body: JSON.stringify(body || {})
      })
      if (res.status === 401) { logout(); return { ok: false, text: '令牌已失效' } }
      if (res.status === 428) { location.href = '/login.html'; return { ok: false, text: '需要先设置访问令牌' } }
      return await res.json()
    } catch (e) {
      return { ok: false, text: '请求失败: ' + e.message }
    }
  }

  async function getJSON (url) {
    try {
      const sep = url.includes('?') ? '&' : '?'
      const res = await fetch(url + sep + 'token=' + encodeURIComponent(token()))
      if (res.status === 401) { logout(); return null }
      if (res.status === 428) { location.href = '/login.html'; return null }
      return await res.json()
    } catch (e) {
      return null
    }
  }

  const PAGE_META = {
    overview: ['概览', 'FrishLuna 本地控制面板'],
    lab: ['实验台', '只读查询 · 操作执行'],
    messages: ['消息', '历史消息与最近会话'],
    console: ['控制台', '实时运行日志'],
    debug: ['诊断', '运行状态与故障信息'],
    settings: ['运行设置', '进程、启动与命令权限'],
    prefs: ['面板设置', '外观、个性化与安全']
  }

  function goto (page) {
    if (!document.querySelector(`.page[data-page="${page}"]`)) page = 'overview'
    $$('.nav-btn[data-page]').forEach((b) => b.classList.toggle('active', b.dataset.page === page))
    $$('.page').forEach((p) => p.classList.toggle('active', p.dataset.page === page))
    const meta = PAGE_META[page] || PAGE_META.overview
    $('#page-title').textContent = meta[0]
    $('#page-sub').textContent = meta[1]
    if (page === 'console') setTimeout(() => { const b = $('#term-body'); if (b) b.scrollTop = b.scrollHeight }, 60)
    if (page === 'debug') refreshDebug()
    if (page === 'messages') { loadMsgPeers(); loadMessages(false) }
    if (page === 'prefs') syncPrefsUI()
  }

  function initNav () {
    $$('.nav-btn[data-page]').forEach((b) => {
      b.addEventListener('click', () => goto(b.dataset.page))
    })
    $$('[data-goto]').forEach((b) => b.addEventListener('click', () => goto(b.dataset.goto)))
    $('#btn-logout').addEventListener('click', logout)
  }

  function toast (text, kind = 'info', ms = 3200) {
    const el = document.createElement('div')
    el.className = 'toast ' + kind
    el.textContent = text
    $('#toasts').appendChild(el)
    setTimeout(() => {
      el.classList.add('out')
      setTimeout(() => el.remove(), 220)
    }, ms)
  }

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  /* 日志来源对用户显示的短名：内部通道名不上界面 */
  const SCOPE_LABEL = {
    app: '面板', panel: '面板', auth: '登录', qq: 'QQ', qqmsg: 'QQ', runtime: 'QQ',
    cmd: '命令', lab: '功能', send: '发送', inbound: '接收',
    payload: '连接', pipe: '连接', kernel: '服务', marshal: '服务', onebot: '协议',
    eval: '执行', probe: '检测', config: '配置', boot: '启动'
  }
  const scopeName = (s) => SCOPE_LABEL[s] || s || ''

  function levelPass (lv) {
    if (store.filterLevel === 'all') return true
    return lv === store.filterLevel
  }

  function textPass (rec) {
    if (!store.filterText) return true
    const q = store.filterText.toLowerCase()
    return (rec.text || '').toLowerCase().includes(q) || (rec.scope || '').toLowerCase().includes(q)
  }

  function lineHtml (rec) {
    return `<div class="ln" data-lv="${esc(rec.level)}"><span class="c-t">${esc(rec.t)}</span>` +
      `<span class="c-lv">${esc(rec.level)}</span><span class="c-s">${esc(scopeName(rec.scope))}</span>` +
      `<span class="c-m">${esc(rec.text)}</span></div>`
  }

  function appendLog (rec, force) {
    store.logs.push(rec)
    if (store.logs.length > MAX_LINES * 2) store.logs.splice(0, store.logs.length - MAX_LINES * 2)
    updateLogCount()
    // 暂停时只入库不渲染（resume 后一次性补齐）
    if (store.paused) return
    if (!force && (!levelPass(rec.level) || !textPass(rec))) return
    const body = $('#term-body')
    body.insertAdjacentHTML('beforeend', lineHtml(rec))
    while (body.childElementCount > MAX_LINES) body.removeChild(body.firstElementChild)
    if (store.autoScroll) body.scrollTop = body.scrollHeight
    renderMiniLog()
    renderLabFeed(rec)
  }

  function updateLogCount () {
    const el = $('#log-count')
    if (el) el.textContent = store.logs.length + ' 行'
  }

  function redrawLogs () {
    const body = $('#term-body')
    const rows = store.logs.filter((r) => levelPass(r.level) && textPass(r)).slice(-MAX_LINES)
    body.innerHTML = rows.map(lineHtml).join('')
    if (store.autoScroll) body.scrollTop = body.scrollHeight
    updateLogCount()
  }

  function renderMiniLog () {
    const rows = store.logs.filter((r) => r.level !== 'debug').slice(-8).reverse()
    const ul = $('#mini-log')
    if (!rows.length) { ul.innerHTML = '<li class="empty">还没有事件</li>'; return }
    ul.innerHTML = rows.map((r) =>
      `<li data-lv="${esc(r.level)}"><span class="t">${esc(r.t)}</span>` +
      `<span class="s">${esc(scopeName(r.scope))}</span><span class="m">${esc(r.text)}</span></li>`
    ).join('')
  }

  function renderLabFeed (rec) {
    if (!['qq', 'qqmsg', 'lab', 'send'].includes(rec.scope)) return
    const feed = $('#lab-feed')
    if (!feed) return
    if (feed.querySelector('.empty')) feed.innerHTML = ''
    feed.insertAdjacentHTML('beforeend',
      `<div class="fl" data-lv="${esc(rec.level)}"><span class="t">${esc(rec.t)}</span>` +
      `<span class="s">${esc(scopeName(rec.scope))}</span><span class="m">${esc(rec.text)}</span></div>`)
    while (feed.childElementCount > 60) feed.removeChild(feed.firstElementChild)
    feed.scrollTop = feed.scrollHeight
  }

  function initConsole () {
    $$('#filters .fchip').forEach((b) => {
      b.addEventListener('click', () => {
        store.filterLevel = b.dataset.lv
        $$('#filters .fchip').forEach((x) => x.classList.toggle('active', x === b))
        redrawLogs()
      })
    })
    $('#log-search').addEventListener('input', (e) => {
      store.filterText = e.target.value.trim()
      redrawLogs()
    })
    $('#auto-scroll').addEventListener('change', (e) => {
      store.autoScroll = e.target.checked
      if (store.autoScroll) {
        const body = $('#term-body')
        body.scrollTop = body.scrollHeight
      }
    })
    $('#btn-clear').addEventListener('click', async () => {
      store.logs = []
      $('#term-body').innerHTML = ''
      updateLogCount()
      try { await post('/api/logs/clear', {}) } catch {}
    })

    $('#btn-pause').addEventListener('click', () => {
      store.paused = !store.paused
      $('#btn-pause').classList.toggle('active', store.paused)
      $('#btn-pause').title = store.paused ? '继续刷新' : '暂停刷新（日志仍在后台记录）'
      if (!store.paused) redrawLogs()
    })

    $('#btn-export').addEventListener('click', () => {
      if (!store.logs.length) { toast('还没有日志', 'warn'); return }
      const txt = store.logs
        .map((r) => `${r.t} ${String(r.level || 'info').toUpperCase().padEnd(5)} ${r.scope}: ${r.text}`)
        .join('\n')
      const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' })
      const a = document.createElement('a')
      const d = new Date()
      const p2 = (n) => String(n).padStart(2, '0')
      a.href = URL.createObjectURL(blob)
      a.download = `frishluna-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.log`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(a.href), 2000)
      toast('日志已导出', 'ok')
    })
  }

  function pushSys (text, lv = 'info') {
    const rec = { t: nowHMS(), level: lv, scope: 'panel', text, sys: true }
    store.logs.push(rec)
    const body = $('#term-body')
    body.insertAdjacentHTML('beforeend', `<div class="ln sys" data-lv="${lv}"><span class="c-t">${rec.t}</span><span class="c-lv"></span><span class="c-s">panel</span><span class="c-m">${esc(text)}</span></div>`)
    while (body.childElementCount > MAX_LINES) body.removeChild(body.firstElementChild)
    body.scrollTop = body.scrollHeight
  }

  const nowHMS = () => {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }

  const DROPDOWN_LIMIT = 300

  function attachDropdown (input, cfg) {
    if (!input || input.dataset.dd === '1') return
    input.dataset.dd = '1'

    const pop = document.createElement('div')
    pop.className = 'gpick'
    pop.hidden = true
    document.body.appendChild(pop)

    let items = []
    let rows = []
    let note = ''
    let active = -1
    let query = ''
    let seq = 0
    let suppress = false

    function place () {
      const r = input.getBoundingClientRect()
      const w = Math.max(r.width, cfg.width || 300)
      pop.style.minWidth = Math.round(w) + 'px'
      pop.style.maxWidth = Math.round(Math.max(w, (cfg.width || 300) + 80)) + 'px'
      pop.style.left = Math.round(Math.max(8, Math.min(r.left, window.innerWidth - w - 12))) + 'px'
      pop.style.top = Math.round(r.bottom + 6) + 'px'
      const h = pop.offsetHeight || 240
      if (r.bottom + 6 + h > window.innerHeight - 8) {
        pop.style.top = Math.round(Math.max(8, r.top - 6 - h)) + 'px'
      }
    }

    function close () {
      pop.hidden = true
      active = -1
      input.setAttribute('aria-expanded', 'false')
    }

    function highlight () {
      pop.querySelectorAll('.gpick-row').forEach((el) => el.classList.remove('active'))
      const cur = pop.querySelector(`.gpick-row[data-i="${active}"]`)
      if (cur) { cur.classList.add('active'); cur.scrollIntoView({ block: 'nearest' }) }
    }

    function paint () {
      const q = query.trim().toLowerCase()
      rows = (q ? items.filter((it) => cfg.match(it, q)) : items.slice()).slice(0, DROPDOWN_LIMIT)
      if (!rows.length) active = -1

      if (!rows.length) {
        const tip = note || (q ? '没有匹配项' : (cfg.empty || '暂无可选项，直接手填也行'))
        pop.innerHTML = `<div class="gpick-empty">${esc(tip)}</div>`
      } else {
        pop.innerHTML = rows.map((it, i) => cfg.row(it, i, i === active)).join('')
      }
      pop.hidden = false
      input.setAttribute('aria-expanded', 'true')
      place()
    }

    async function open (force) {
      if (suppress) return
      const mine = ++seq
      query = ''
      pop.innerHTML = '<div class="gpick-empty">正在读取…</div>'
      pop.hidden = false
      place()
      const got = await Promise.resolve()
        .then(() => cfg.load(force))
        .catch((e) => ({ items: [], note: '读取失败：' + (e && e.message ? e.message : e) }))
      if (mine !== seq) return
      items = Array.isArray(got) ? got : (got && got.items) || []
      note = (got && got.note) || ''
      if (pop.hidden) return
      paint()
    }

    function choose (i) {
      const it = rows[i]
      if (!it) return
      suppress = true
      input.value = String(cfg.value(it))
      input.dispatchEvent(new Event('input', { bubbles: true }))
      close()
      input.blur()
      setTimeout(() => { suppress = false }, 0)
    }

    input.setAttribute('autocomplete', 'off')
    input.setAttribute('aria-expanded', 'false')
    input.addEventListener('focus', () => open(false))
    input.addEventListener('click', () => { if (pop.hidden) open(false) })
    input.addEventListener('input', () => {
      query = input.value
      if (items.length) paint()
    })
    input.addEventListener('blur', () => {
      setTimeout(() => { if (!pop.dataset.hold) close() }, 120)
    })

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { close(); return }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (pop.hidden) { open(false); e.preventDefault(); return }
        if (!rows.length) return
        e.preventDefault()
        active = e.key === 'ArrowDown'
          ? Math.min(rows.length - 1, active + 1)
          : Math.max(0, active - 1)
        highlight()
        return
      }
      if (e.key === 'Enter' && !pop.hidden && active >= 0) {
        e.preventDefault()
        choose(active)
      }
    })

    pop.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      pop.dataset.hold = '1'
      const row = e.target.closest('.gpick-row')
      if (row) choose(Number(row.dataset.i))
    })
    pop.addEventListener('pointerup', () => { delete pop.dataset.hold })
    pop.addEventListener('error', (e) => {
      const img = e.target
      if (img && img.tagName === 'IMG') img.parentElement.classList.add('fallback')
    }, true)

    document.addEventListener('pointerdown', (e) => {
      if (pop.hidden) return
      if (e.target === input || pop.contains(e.target)) return
      close()
    })
    window.addEventListener('resize', () => { if (!pop.hidden) place() })
    window.addEventListener('scroll', () => { if (!pop.hidden) place() }, true)
  }

  function avatarBox (url, initial) {
    return `<span class="gpick-ava" data-initial="${esc(initial)}">
      <img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">
    </span>`
  }

  const groupDir = { at: 0, items: [], loading: null, msg: '' }

  function loadGroupDir (force) {
    if (!force && groupDir.items.length && Date.now() - groupDir.at < 60000) return Promise.resolve(groupDir.items)
    if (groupDir.loading) return groupDir.loading
    groupDir.loading = getJSON('/api/groups' + (force ? '?force=1' : ''))
      .then((r) => {
        const list = r && Array.isArray(r.groups) ? r.groups : []
        if (list.length) {
          groupDir.items = list
          groupDir.at = Date.now()
          groupDir.msg = ''
        } else {
          groupDir.msg = (r && r.msg) || '还没读到群列表：等群里来条消息，或直接填群号'
        }
        return groupDir.items
      })
      .catch(() => { groupDir.msg = '读取群列表失败'; return groupDir.items })
      .then((v) => { groupDir.loading = null; return v })
    return groupDir.loading
  }

  function groupAvatarUrl (id) {
    return 'https://p.qlogo.cn/gh/' + encodeURIComponent(id) + '/' + encodeURIComponent(id) + '/100'
  }

  function attachGroupPicker (input) {
    attachDropdown(input, {
      width: 320,
      load: async (force) => {
        const list = await loadGroupDir(force)
        return { items: list, note: groupDir.msg }
      },
      match: (g, q) => String(g.id).includes(q) || String(g.name || '').toLowerCase().includes(q),
      row: (g, i, on) => {
        const named = !!String(g.name || '').trim()
        const name = named ? g.name : '群 ' + g.id
        return `<button type="button" class="gpick-row${on ? ' active' : ''}" data-i="${i}">
          ${avatarBox(groupAvatarUrl(g.id), named ? name.slice(0, 1) : '群')}
          <span class="gpick-name">${esc(name)}</span>
          ${named ? `<span class="gpick-id">${esc(String(g.id))}</span>` : ''}
        </button>`
      },
      value: (g) => String(g.id)
    })
  }

  const friendDir = { at: 0, items: [], loading: null, msg: '' }

  function loadFriendDir (force) {
    if (!force && friendDir.items.length && Date.now() - friendDir.at < 60000) return Promise.resolve(friendDir.items)
    if (friendDir.loading) return friendDir.loading
    friendDir.loading = getJSON('/api/friends' + (force ? '?force=1' : ''))
      .then((r) => {
        const list = r && Array.isArray(r.friends) ? r.friends : []
        if (list.length) {
          friendDir.items = list
          friendDir.at = Date.now()
          friendDir.msg = ''
        } else {
          friendDir.msg = (r && r.msg) || '还没读到好友列表：好友数据稍后完成同步，也可以直接填 QQ 号'
        }
        return friendDir.items
      })
      .catch(() => { friendDir.msg = '读取好友失败'; return friendDir.items })
      .then((v) => { friendDir.loading = null; return v })
    return friendDir.loading
  }

  const friendAvatarUrl = (qq) => 'https://q1.qlogo.cn/g?b=qq&nk=' + encodeURIComponent(qq) + '&s=100'

  function attachFriendPicker (input) {
    attachDropdown(input, {
      width: 320,
      empty: '直接填好友 QQ 号也行',
      load: async (force) => {
        const list = await loadFriendDir(force)
        return { items: list, note: friendDir.msg }
      },
      match: (f, q) => String(f.qq || f.id).includes(q) || String(f.name || '').toLowerCase().includes(q),
      row: (f, i, on) => {
        const qq = String(f.qq || f.id)
        const named = !!String(f.name || '').trim()
        return `<button type="button" class="gpick-row${on ? ' active' : ''}" data-i="${i}">
          ${avatarBox(friendAvatarUrl(qq), named ? f.name.slice(0, 1) : '友')}
          <span class="gpick-name">${esc(named ? f.name : 'QQ ' + qq)}</span>
          ${named ? `<span class="gpick-id">${esc(qq)}</span>` : ''}
        </button>`
      },
      value: (f) => String(f.qq || f.id || '')
    })
  }

  /* 群成员的值是内核 uid，群管接口认这个 */
  const memberDir = new Map() // gid → { at, items, msg }

  function loadMemberDir (gid, force) {
    const hit = memberDir.get(gid)
    if (!force && hit && hit.items.length && Date.now() - hit.at < 60000) return Promise.resolve(hit)
    const p = getJSON('/api/lab/members?id=' + encodeURIComponent(gid))
      .then((r) => {
        const items = r && Array.isArray(r.members) ? r.members : []
        const rec = { at: Date.now(), items, msg: (r && r.msg) || '' }
        if (items.length) memberDir.set(gid, rec)
        return rec
      })
      .catch(() => ({ at: Date.now(), items: [], msg: '读取群成员失败' }))
    return p
  }

  function attachMemberPicker (input, groupIdFn) {
    attachDropdown(input, {
      width: 320,
      empty: '直接填成员 QQ 号或成员标识也行',
      load: async (force) => {
        const gid = String(groupIdFn() || '').trim()
        if (!gid) return { items: [], note: '先在上面填群号（或点群号下拉选一个群）' }
        const rec = await loadMemberDir(gid, force)
        return { items: rec.items, note: rec.msg }
      },
      match: (m, q) => String(m.id).toLowerCase().includes(q) ||
        String(m.qq || '').includes(q) || String(m.name || '').toLowerCase().includes(q),
      row: (m, i, on) => {
        const uid = String(m.uid || m.id)
        const tail = uid.replace(/^u_/, '')
        return `<button type="button" class="gpick-row${on ? ' active' : ''}" data-i="${i}">
          ${avatarBox(m.qq ? friendAvatarUrl(m.qq) : '', m.qq ? m.qq.slice(-2) : tail.slice(-2))}
          <span class="gpick-name">${esc(m.qq ? 'QQ ' + m.qq : '成员 ' + tail.slice(-8))}</span>
          <span class="gpick-id">${esc(tail.slice(0, 10))}</span>
        </button>`
      },
      value: (m) => String(m.uid || m.id || '')
    })
  }

  /* QQ 的表情回应 ID 就是 Unicode 码位（128077 = 👍），所以这里按码位列常用表情 */
  const EMOJI_LIST = [
    [128077, '👍', '赞'], [128078, '👎', '踩'], [128079, '👏', '鼓掌'],
    [128591, '🙏', '拜托'], [128293, '🔥', '火'], [10084, '❤️', '爱心'],
    [128514, '😂', '笑哭'], [129315, '🤣', '笑翻'], [128512, '😀', '开心'],
    [128513, '😁', '露齿笑'], [128521, '😉', '眨眼'], [128525, '😍', '花痴'],
    [128536, '😘', '飞吻'], [128563, '😳', '脸红'], [129321, '🤩', '星星眼'],
    [129300, '🤔', '思考'], [128064, '👀', '围观'], [127881, '🎉', '庆祝'],
    [128640, '🚀', '火箭'], [10024, '✨', '闪光'], [127775, '🌟', '星星'],
    [128161, '💡', '灵感'], [128170, '💪', '加油'], [129303, '🤗', '拥抱'],
    [128588, '🙌', '举手'], [9989, '✅', '对'], [10060, '❌', '错'],
    [128546, '😢', '流泪'], [128532, '😔', '失落'], [128548, '😠', '生气'],
    [128555, '😫', '累'], [128517, '😅', '汗'], [128274, '🔒', '锁']
  ].map((x) => ({ id: x[0], ch: x[1], name: x[2] }))

  function attachEmojiPicker (input) {
    attachDropdown(input, {
      width: 280,
      empty: '直接填表情 ID 也行',
      load: async () => EMOJI_LIST,
      match: (e, q) => String(e.id).includes(q) || String(e.name).includes(q) || e.ch === q,
      row: (e, i, on) => `<button type="button" class="gpick-row${on ? ' active' : ''}" data-i="${i}">
        <span class="gpick-emo">${e.ch}</span>
        <span class="gpick-name">${esc(e.name)}</span>
        <span class="gpick-id">${esc(String(e.id))}</span>
      </button>`,
      value: (e) => String(e.id)
    })
  }

  /* 每一项：name 函数名（下拉里显示的），desc 中文简介，op 后端 op 名。
     params 参数表 kind:
       kind   群聊/好友 切换条
       group  群号（带群下拉）
       friend 好友（带好友下拉，值是 QQ 号）
       member 群成员（带成员下拉，值是内核 uid；跟随上面的群号）
       qq / text / num  纯输入
       textarea  多行内容（Ctrl+Enter 执行）
       emoji  表情 ID（带表情下拉）
       onoff  开/关 下拉
     req 必填；when 指定该参数只在 kind 切到某值时显示（如群号只在群聊出现）；
     hint 输入框下面的灰字提示；send=true 表示是发消息（成功/失败都写进发送记录）。

     ⚠ 同一功能里可以有两条同 key 的参数，用 when 区分群聊/好友 ——
       renderFnParams 只会渲染当前 kind 那一条，runFn 也只读那一条。 */
  const FN_CATALOG = {
    read: [
      { name: 'group_list', desc: '本号已加入的群', op: 'groupList', params: [] },
      { name: 'group_member_list', desc: '群成员列表', op: 'groupMembers', params: [
        { key: 'id', label: '群号', kind: 'group', req: true }
      ] },
      { name: 'friend_list', desc: '好友列表', op: 'friendList', params: [] },
      { name: 'msg_recent_list', desc: '最近会话列表', op: 'recentList', params: [] },
      { name: 'msg_history', desc: '历史消息', op: 'msgHistory', params: [
        { key: 'type', label: '目标类型', kind: 'kind', def: 'group' },
        { key: 'id', label: '群号', kind: 'group', when: 'group', req: true },
        { key: 'id', label: '好友 QQ 号', kind: 'friend', when: 'private', req: true },
        { key: 'count', label: '条数（默认 20，上限 50）', kind: 'text' }
      ] },
      { name: 'essence_list', desc: '群精华列表', op: 'essenceList', params: [
        { key: 'id', label: '群号', kind: 'group', req: true }
      ] },
      { name: 'group_system_msg', desc: '群通知 / 加群申请', op: 'groupSystemMsg', params: [] },
      { name: 'album_main', desc: '群相册主页', op: 'albumMain', params: [
        { key: 'id', label: '群号', kind: 'group', req: true }
      ] },
      { name: 'album_list', desc: '群相册列表（查看相册 ID）', op: 'albumList', params: [
        { key: 'group', label: '群号', kind: 'group', req: true }
      ] },
      { name: 'album_upload', desc: '群相册传图（支持本地路径/网址/Base64）', op: 'albumUpload', params: [
        { key: 'group', label: '群号', kind: 'group', req: true },
        { key: 'album_id', label: '相册 ID（从相册列表获取）', kind: 'text', req: true },
        { key: 'album_name', label: '相册名', kind: 'text' },
        { key: 'image', label: '图片（base64 / data URI / 本地路径 / http URL）', kind: 'text', req: true }
      ] },
      { name: 'self_info', desc: '本号 QQ 号 / 昵称', op: 'selfInfo', params: [] },
      { name: 'svc_status', desc: 'QQ 服务可用性', op: 'services', params: [] },
      { name: 'qzone_msg_list', desc: 'Qzone 说说列表（自己或指定 QQ）', op: 'qzoneList', params: [
        { key: 'target_uin', label: '对方 QQ 号（空 = 自己的空间）', kind: 'text' },
        { key: 'pos', label: '起始偏移', kind: 'text', def: '0' },
        { key: 'num', label: '本页条数（默认 20）', kind: 'text', def: '20' }
      ] },
      { name: 'qzone_msg_detail', desc: 'Qzone 说说详情 + 评论页', op: 'qzoneDetail', params: [
        { key: 'tid', label: '说说 tid', kind: 'text', req: true },
        { key: 'target_uin', label: '对方 QQ 号（空 = 自己的空间）', kind: 'text' }
      ] },
      { name: 'qzone_feeds', desc: 'Qzone 好友动态（首页）', op: 'qzoneFeeds', params: [
        { key: 'page_num', label: '页码（1 起）', kind: 'text', def: '1' },
        { key: 'count', label: '本页条数（默认 10）', kind: 'text', def: '10' }
      ] },
      { name: 'qzone_cookies', desc: 'Qzone 访问状态诊断', op: 'qzoneCookies', params: [] },
      { name: 'ai_characters', desc: 'AI 语音角色列表', op: 'aiCharacters', params: [
        { key: 'id', label: '群号', kind: 'group', req: true },
        { key: 'chat_type', label: '1=聊天 2=唱歌', kind: 'text', def: '1' }
      ] },
      { name: 'media_rkey', desc: '图片/文件下载凭证状态', op: 'mediaRkey', params: [
        { key: 'force', label: '强制刷新', kind: 'onoff', def: 'false' }
      ] },
      { name: 'media_download', desc: '按消息下载媒体到本机', op: 'mediaGet', params: [
        { key: 'kind', label: '类型（image / record / video / file）', kind: 'text', def: 'image' },
        { key: 'msg_id', label: '消息 ID', kind: 'text', req: true },
        { key: 'group_id', label: '群号（群聊消息时填）', kind: 'group' },
        { key: 'user_id', label: '好友 QQ 号（私聊消息时填）', kind: 'friend' },
        { key: 'file', label: '文件名（可选）', kind: 'text' }
      ] },
      { name: 'group_file_list', desc: '群文件列表（拿文件 id）', op: 'groupFileListOp', params: [
        { key: 'group', label: '群号', kind: 'group', req: true }
      ] },
      { name: 'group_file_url', desc: '群文件下载直链（file_id 从群文件列表获取）', op: 'groupFileUrlOp', params: [
        { key: 'group', label: '群号', kind: 'group', req: true },
        { key: 'file_id', label: '文件 id', kind: 'text', req: true }
      ] },
      { name: 'credentials', desc: '登录凭证（p_skey / bkn / clientKey）', op: 'credentialsOp', params: [] },
      { name: 'emoji_likes_list', desc: '查看消息的表情回应', op: 'emojiLikesList', params: [
        { key: 'id', label: '群号', kind: 'group', req: true },
        { key: 'msgSeq', label: '消息 Seq（msg_recent 拿）', kind: 'text', req: true }
      ] },
      { name: 'flash_list', desc: '闪传任务列表', op: 'flashList', params: [] },
      { name: 'flash_info', desc: '闪传任务详情', op: 'flashInfo', params: [
        { key: 'fileset_uuid', label: '任务 ID', kind: 'text', req: true }
      ] },
      { name: 'flash_url', desc: '闪传文件下载直链', op: 'flashUrl', params: [
        { key: 'fileset_uuid', label: '任务 ID', kind: 'text', req: true },
        { key: 'file_index', label: '文件序号（默认 0）', kind: 'num' }
      ] },
      { name: 'requests_list', desc: '入群申请列表', op: 'requestsList', params: [] }
    ],
    op: [
      { name: 'msg_send_text', desc: '发送文本消息', op: 'send', send: true, params: [
        { key: 'type', label: '目标类型', kind: 'kind', def: 'group' },
        { key: 'id', label: '群号', kind: 'group', when: 'group', req: true },
        { key: 'id', label: '好友 QQ 号', kind: 'friend', when: 'private', req: true,
          hint: '私聊对象必须是好友（若发送失败，可先在 QQ 里与对方互发一条消息）' },
        { key: 'text', label: '消息内容', kind: 'textarea', req: true }
      ] },
      { name: 'msg_send_image', desc: '发送图片（本机路径）', op: 'sendImage', send: true, params: [
        { key: 'type', label: '目标类型', kind: 'kind', def: 'group' },
        { key: 'id', label: '群号', kind: 'group', when: 'group', req: true },
        { key: 'id', label: '好友 QQ 号', kind: 'friend', when: 'private', req: true,
          hint: '私聊若发送失败，可让对方先发一条消息' },
        { key: 'path', label: '图片完整路径', kind: 'text', req: true,
          hint: '本机绝对路径，如 D:\\图片\\a.png。支持常见图片格式，单张 30MB 以内' }
      ] },
      { name: 'msg_send_rich', desc: '发送富消息（文字/@/表情/图片/回复 混排）', op: 'sendRich', send: true, params: [
        { key: 'type', label: '目标类型', kind: 'kind', def: 'group' },
        { key: 'id', label: '群号', kind: 'group', when: 'group', req: true },
        { key: 'id', label: '好友 QQ 号', kind: 'friend', when: 'private', req: true },
        { key: 'segments', label: '消息段（JSON 数组）', kind: 'json', req: true,
          hint: '按顺序拼成一条消息。例：[{"type":"text","text":"看这个 "},{"type":"at","uin":123456},{"type":"image","path":"D:\\\\图片\\\\a.png"},{"type":"face","id":14}]；回复用 {"type":"reply","seq":<消息seq>}' }
      ] },
      { name: 'msg_recall', desc: '撤回指定消息', op: 'recall', params: [
        { key: 'id', label: '群号', kind: 'group', req: true,
          hint: '消息所在群；撤回要靠它定位会话' },
        { key: 'msgId', label: '消息 ID', kind: 'text', req: true,
          hint: '填入要撤回的消息 ID（从最近消息中复制）' }
      ] },
      { name: 'msg_emoji_like', desc: '给消息贴表情回应', op: 'emojiLike', params: [
        { key: 'msgId', label: '消息 ID / Seq', kind: 'text', req: true,
          hint: '从群最近消息中获取消息序号，并在目标里填群号' },
        { key: 'code', label: '表情（点开选）', kind: 'emoji', def: '128077' }
      ] },
      { name: 'msg_recent', desc: '读取群最近消息', op: 'getMsgs', params: [
        { key: 'id', label: '群号', kind: 'group', req: true },
        { key: 'count', label: '条数', kind: 'num', def: 10 }
      ] },
      { name: 'uid_lookup', desc: '查询成员标识（按 QQ 号）', op: 'findUid', params: [
        { key: 'uid', label: 'QQ 号', kind: 'qq', req: true,
          hint: '将 QQ 号转换为成员标识；点赞或私聊时系统会自动查询' }
      ] },
      { name: 'poke_send', desc: '戳一戳', op: 'poke', params: [
        { key: 'type', label: '类型', kind: 'kind', def: 'group' },
        { key: 'id', label: '群号', kind: 'group', when: 'group', req: true },
        { key: 'uid', label: '对方 QQ 号', kind: 'qq', when: 'group', req: true,
          hint: '填对方 QQ 号，且对方必须在该群' },
        { key: 'uid', label: '好友 QQ 号', kind: 'friend', when: 'private', req: true }
      ] },
      { name: 'buddy_like', desc: '给好友点名片赞', op: 'like', params: [
        { key: 'uid', label: '好友', kind: 'friend', req: true,
          hint: '填对方 QQ 号。对方必须是好友，非好友将无法点赞' },
        { key: 'count', label: '次数', kind: 'num', def: 1, hint: '每天上限 20 次' }
      ] },
      { name: 'group_mute_member', desc: '禁言 / 解除成员', op: 'groupMute', params: [
        { key: 'id', label: '群号', kind: 'group', req: true },
        { key: 'uid', label: '成员', kind: 'member', req: true, hint: '点开从群成员里选，也可直接填 QQ 号' },
        { key: 'seconds', label: '时长（秒）', kind: 'num', def: 600, hint: '0 = 解除禁言' }
      ] },
      { name: 'group_mute_all', desc: '全员禁言开关', op: 'groupMuteAll', params: [
        { key: 'id', label: '群号', kind: 'group', req: true },
        { key: 'on', label: '开关', kind: 'onoff', def: 'true' }
      ] },
      { name: 'group_kick_member', desc: '移出成员', op: 'groupKick', params: [
        { key: 'id', label: '群号', kind: 'group', req: true },
        { key: 'uid', label: '成员', kind: 'member', req: true, hint: '点开从群成员里选，也可直接填 QQ 号' },
        { key: 'reject', label: '同时拒绝再加群', kind: 'onoff', def: 'false' }
      ] },
      { name: 'group_set_admin', desc: '设 / 取消管理员', op: 'groupSetAdmin', params: [
        { key: 'id', label: '群号', kind: 'group', req: true },
        { key: 'uid', label: '成员', kind: 'member', req: true, hint: '点开从群成员里选，也可直接填 QQ 号' },
        { key: 'on', label: '设为管理员？', kind: 'onoff', def: 'true' }
      ] },
      { name: 'group_set_card', desc: '改群名片', op: 'groupCard', params: [
        { key: 'id', label: '群号', kind: 'group', req: true },
        { key: 'uid', label: '成员', kind: 'member', req: true, hint: '点开从群成员里选，也可直接填 QQ 号' },
        { key: 'card', label: '新名片', kind: 'text', hint: '留空 = 清空名片' }
      ] },
      { name: 'group_set_name', desc: '改群名', op: 'groupName', params: [
        { key: 'id', label: '群号', kind: 'group', req: true },
        { key: 'name', label: '新群名', kind: 'text', req: true }
      ] },
      { name: 'group_announce', desc: '发群公告', op: 'groupAnnounce', params: [
        { key: 'id', label: '群号', kind: 'group', req: true },
        { key: 'text', label: '公告内容', kind: 'textarea', req: true }
      ] },
      { name: 'essence_set', desc: '设为群精华（消息 ID 可从历史消息获取）', op: 'essenceSet', params: [
        { key: 'id', label: '群号', kind: 'group', req: true },
        { key: 'msg_id', label: '消息 ID', kind: 'text', req: true }
      ] },
      { name: 'forward_send', desc: '发送合并转发消息', op: 'forwardSend', send: true, params: [
        { key: 'type', label: '目标类型', kind: 'kind', def: 'group' },
        { key: 'id', label: '群号', kind: 'group', when: 'group', req: true },
        { key: 'id', label: '好友 QQ 号', kind: 'friend', when: 'private', req: true },
        { key: 'nodes_json', label: '节点 JSON（[{uin,name,text}]）', kind: 'textarea', req: true,
          hint: '例：[{"uin":123456,"name":"某人","text":"节点内容"}]' }
      ] },
      { name: 'forward_get', desc: '获取合并转发内容', op: 'forwardGet', params: [
        { key: 'res_id', label: 'resId（有则优先）', kind: 'text' },
        { key: 'message_id', label: 'OneBot message_id', kind: 'text' },
        { key: 'type', label: '目标类型（按 msgId 查时必填）', kind: 'kind', def: 'group' },
        { key: 'id', label: '群号（按 msgId 查时必填）', kind: 'group' }
      ] },
      { name: 'send_qzone_msg', desc: '发布 Qzone 说说', op: 'qzonePublish', send: true, params: [
        { key: 'content', label: '说说内容', kind: 'textarea', req: true },
        { key: 'rich_type', label: 'richType（带图=1，空=纯文字）', kind: 'text' },
        { key: 'richval', label: 'richval（上传图片接口回的）', kind: 'text' },
        { key: 'ugc_right', label: '可见权限 1/4/16/64/128', kind: 'text', def: '1' },
        { key: 'target_uins', label: '16/128 时的名单（| 分隔）', kind: 'text' }
      ] },
      { name: 'delete_qzone_msg', desc: '删 Qzone 说说（只能删自己的）', op: 'qzoneDelete', send: true, params: [
        { key: 'tid', label: '说说 tid', kind: 'text', req: true }
      ] },
      { name: 'like_qzone', desc: 'Qzone 说说点赞 / 取消赞', op: 'qzoneLike', send: true, params: [
        { key: 'tid', label: '说说 tid', kind: 'text', req: true },
        { key: 'target_uin', label: '说说主人 QQ 号（空 = 自己）', kind: 'text' },
        { key: 'like', label: 'true=赞 false=取消', kind: 'text', def: 'true' }
      ] },
      { name: 'comment_qzone', desc: '评论 Qzone 说说', op: 'qzoneComment', send: true, params: [
        { key: 'tid', label: '说说 tid', kind: 'text', req: true },
        { key: 'content', label: '评论内容', kind: 'textarea', req: true },
        { key: 'target_uin', label: '说说主人 QQ 号（空 = 自己）', kind: 'text' }
      ] },
      { name: 'ai_record', desc: '发送 AI 语音到群', op: 'aiVoice', send: true, params: [
        { key: 'id', label: '群号', kind: 'group', req: true },
        { key: 'character', label: '角色 ID（从角色列表获取）', kind: 'text', req: true },
        { key: 'text', label: '要念的文本', kind: 'textarea', req: true },
        { key: 'chat_type', label: '1=聊天 2=唱歌', kind: 'text', def: '1' }
      ] },
      { name: 'essence_del', desc: '取消群精华', op: 'essenceDel', params: [
        { key: 'id', label: '群号', kind: 'group', req: true },
        { key: 'msg_id', label: '消息 ID', kind: 'text', req: true }
      ] },
      { name: 'group_file_space', desc: '查群文件空间（已用/总量）', op: 'groupSpace', params: [
        { key: 'id', label: '群号', kind: 'group', req: true }
      ] },
      { name: 'group_file_count', desc: '查群文件个数（支持多群）', op: 'groupFileCount', params: [
        { key: 'id', label: '群号（多个用英文逗号隔开）', kind: 'group', req: true }
      ] },
      { name: 'group_folder_create', desc: '新建群文件夹', op: 'groupFolderCreate', params: [
        { key: 'id', label: '群号', kind: 'group', req: true },
        { key: 'name', label: '文件夹名', kind: 'text', req: true }
      ] },
      { name: 'group_folder_delete', desc: '删除群文件夹', op: 'groupFolderDelete', params: [
        { key: 'id', label: '群号', kind: 'group', req: true },
        { key: 'folderId', label: 'folderId', kind: 'text', req: true,
          hint: '填入新建文件夹返回的 ID，形如 /f1330…' }
      ] },
      { name: 'group_file_delete', desc: '删除群文件', op: 'groupFileDelete', params: [
        { key: 'id', label: '群号', kind: 'group', req: true },
        { key: 'fileId', label: '文件 ID', kind: 'text', req: true }
      ] },
      { name: 'group_file_rename', desc: '重命名群文件', op: 'groupFileRename', params: [
        { key: 'id', label: '群号', kind: 'group', req: true },
        { key: 'fileId', label: '文件 ID', kind: 'text', req: true },
        { key: 'name', label: '新文件名', kind: 'text', req: true }
      ] },
      { name: 'group_file_move', desc: '移动群文件', op: 'groupFileMove', params: [
        { key: 'id', label: '群号', kind: 'group', req: true },
        { key: 'fileId', label: '文件 ID', kind: 'text', req: true },
        { key: 'folderId', label: '目标文件夹', kind: 'text', hint: '留空 = 根目录' }
      ] },
      { name: 'profile_set_nick', desc: '改本号昵称 / 签名', op: 'profileSet', params: [
        { key: 'nick', label: '昵称', kind: 'text', hint: '留空不改' },
        { key: 'sign', label: '签名', kind: 'text', hint: '留空不改' }
      ] },
      { name: 'msg_send_video', desc: '发送视频（本机路径）', op: 'sendVideo', send: true, params: [
        { key: 'type', label: '目标类型', kind: 'kind', def: 'group' },
        { key: 'id', label: '群号', kind: 'group', when: 'group', req: true },
        { key: 'id', label: '好友 QQ 号', kind: 'friend', when: 'private', req: true },
        { key: 'path', label: '视频完整路径', kind: 'text', req: true,
          hint: '本机绝对路径，如 D:\\视频\\a.mp4（mp4 格式）' }
      ] },
      { name: 'group_file_upload', desc: '上传文件到群', op: 'uploadFile', send: true, params: [
        { key: 'id', label: '群号', kind: 'group', req: true },
        { key: 'path', label: '文件完整路径', kind: 'text', req: true,
          hint: '本机绝对路径，任意格式都可以' },
        { key: 'name', label: '显示文件名（可选）', kind: 'text' }
      ] }
    ]
  }
  /* 分类标签：靠前优先命中；没命中的 op 落「其他」（fnGroupOf 兜底） */
  const FN_GROUPS = [
    ['msg', '消息', /^msg_/],
    ['qzone', '空间', /^(qzone_|send_qzone|delete_qzone|like_qzone|comment_qzone)/],
    ['ai', 'AI 语音', /^ai_/],
    ['essence', '精华', /^essence_/],
    ['forward', '转发', /^forward_/],
    ['gfile', '群文件', /^group_(file|folder)_|group_file_upload/],
    ['gadm', '群管理', /^group_/],
    ['request', '审批', /^request_/],
    ['flash', '闪传', /^flash_/],
    ['media', '媒体/相册', /^(media_|album_)/],
    ['acct', '账号', /^(self_|profile_|buddy_|uid_)/],
    ['diag', '查询/诊断', /^(svc_|poke_|recent|friend_list|group_list|group_member|emoji_)/]
  ]
  function fnGroupOf (f) {
    for (const g of FN_GROUPS) if (g[2].test(f.name)) return g
    return ['other', '其他', /^$/]
  }

  function renderFnCats (tab) {
    const bar = document.getElementById('fn-cats-' + tab)
    if (!bar) return
    const list = FN_CATALOG[tab] || []
    const counts = {}
    list.forEach((f) => { const k = fnGroupOf(f)[0]; counts[k] = (counts[k] || 0) + 1 })
    const cur = store.fnCat && store.fnCat[tab]
    bar.innerHTML = '<button type="button" class="fchip' + (!cur ? ' active' : '') + '" data-cat="">全部 ' + list.length + '</button>' +
      FN_GROUPS.filter((g) => counts[g[0]]).map((g) =>
        '<button type="button" class="fchip' + (cur === g[0] ? ' active' : '') + '" data-cat="' + g[0] + '">' + g[1] + ' ' + counts[g[0]] + '</button>'
      ).join('')
    bar.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        store.fnCat = store.fnCat || {}
        store.fnCat[tab] = b.dataset.cat || ''
        renderFnCats(tab)
        const input = document.getElementById('fn-' + tab)
        if (input) input.dispatchEvent(new Event('input'))
      })
    })
  }

  /** 功能选择下拉：函数名 + 淡色中文描述 + 类别标签，可搜索 */
  function attachFnPicker (tab) {
    const input = document.getElementById('fn-' + tab)
    if (!input) return
    renderFnCats(tab)
    const pickList = () => {
      const cat = store.fnCat && store.fnCat[tab]
      const all = FN_CATALOG[tab] || []
      return cat ? all.filter((f) => fnGroupOf(f)[0] === cat) : all
    }
    attachDropdown(input, {
      width: 460,
      empty: '这个栏目还没有功能',
      load: pickList,
      match: (f, q) => f.name.indexOf(q) >= 0 || f.desc.toLowerCase().indexOf(q) >= 0,
      row: (f, i, on) => '<button type="button" class="gpick-row' + (on ? ' active' : '') + '" data-i="' + i + '">' +
        '<span class="gpick-tag">' + esc(fnGroupOf(f)[1]) + '</span>' +
        '<span class="gpick-name fn-name">' + esc(f.name) + '</span>' +
        '<span class="gpick-id fn-desc">' + esc(f.desc) + '</span>' +
        '</button>',
      value: (f) => f.name
    })
    input.addEventListener('input', () => {
      /* 手打功能名只认精确匹配，不匹配就清掉选择，避免参数区和执行目标错位 */
      const fn = (FN_CATALOG[tab] || []).find((f) => f.name === input.value.trim()) || null
      if (fn !== store.fnPick[tab]) {
        store.fnPick[tab] = fn
        renderFnParams(tab)
      }
    })
  }

  function pushLabHistory (kind, id, text, ok) {
    store.labHistory.unshift({
      t: nowHMS(), at: Date.now(),
      kind: kind === 'group' ? 'group' : 'private',
      id, text: String(text || '').slice(0, 200), ok
    })
    store.labHistory = store.labHistory.slice(0, 50)
    localStorage.setItem('fl-lab-history', JSON.stringify(store.labHistory))
    renderLabHistory()
  }

  const OP_LOG_MAX = 40

  function opStream () {
    return document.getElementById('op-stream')
  }

  function opLogPush (title, brief) {
    const box = opStream()
    if (!box) return null
    const empty = box.querySelector('.empty')
    if (empty) empty.remove()
    const el = document.createElement('div')
    el.className = 'oplog'
    el.dataset.lv = 'pending'
    el.innerHTML = '<div class="oplog-head"><span class="t">' + nowHMS() + '</span>' +
      '<span class="fn">' + esc(title) + '</span>' +
      '<span class="args">' + esc(brief || '') + '</span>' +
      '<span class="st">执行中…</span></div>' +
      '<div class="oplog-body"></div>'
    box.appendChild(el)
    while (box.childElementCount > OP_LOG_MAX) box.removeChild(box.firstElementChild)
    box.scrollTop = box.scrollHeight
    return el
  }

  function opLogFill (el, ok, msg, lines, ms) {
    if (!el) return
    el.dataset.lv = ok ? 'ok' : 'err'
    const st = el.querySelector('.st')
    if (st) st.textContent = (ok ? '成功' : '失败') + (ms ? ' · ' + ms + 'ms' : '')
    const body = el.querySelector('.oplog-body')
    if (!body) return
    const rows = (lines && lines.length ? lines : [msg || '']).filter((x) => x !== '')
    body.innerHTML = rows.map((l) =>
      '<div class="oplog-line">' + esc(l) + '</div>').join('')
    const box = opStream()
    if (box && store.opAutoScroll !== false) box.scrollTop = box.scrollHeight
  }

  function setOpState (text, ok) {
    const st = $('#op-state')
    if (st) {
      st.textContent = text
      st.className = 'hint' + (ok === true ? ' ok-tx' : ok === false ? ' err-tx' : '')
    }
  }

  /** 参数摘要（日志抬头上那行小字） */
  function argBrief (fn, args) {
    const parts = []
    const seen = new Set()
    for (const p of fn.params) {
      /* poke 这类功能群聊/好友两条参数用同一个 key，不跳过就会把同一个值印两遍 */
      if (!(p.key in args) || seen.has(p.key)) continue
      seen.add(p.key)
      const v = args[p.key]
      if (v === '' || v == null) continue
      if (p.kind === 'kind') { parts.push(v === 'group' ? '群聊' : '好友'); continue }
      if (p.kind === 'textarea') { parts.push('内容 ' + String(v).length + ' 字'); continue }
      if (p.kind === 'json') { parts.push('参数 ' + String(v).length + ' 字节'); continue }
      if (p.kind === 'onoff') { parts.push(p.label + (v === true || v === 'true' ? ' 开' : ' 关')); continue }
      const s = String(v)
      parts.push(s.length > 26 ? s.slice(0, 26) + '…' : s)
    }
    return parts.join(' · ')
  }

  async function runFn (tab) {
    const fn = store.fnPick && store.fnPick[tab]
    const msgEl = document.getElementById('fn-' + tab + '-msg')
    if (!fn) {
      if (msgEl) { msgEl.textContent = '先在上方选一个功能'; msgEl.className = 'hint err' }
      return
    }
    const kindVal = store.fnKind[tab] || 'group'
    const args = {}
    for (const p of fn.params) {
      if (p.kind === 'kind') { args[p.key] = kindVal; continue }
      if (p.when && p.when !== kindVal) continue
      const el = fnEl(tab, p.key)
      let v
      if (p.kind === 'onoff') v = el ? el.value === 'true' : String(p.def) === 'true'
      else if (p.kind === 'num') v = el ? (Number(el.value) || 0) : (Number(p.def) || 0)
      else v = el ? el.value.trim() : String(p.def == null ? '' : p.def)
      if (p.kind === 'json') {
        try { v = JSON.parse(v) } catch (e) {
          const t = p.label + ' 不是合法 JSON：' + e.message
          if (msgEl) { msgEl.textContent = t; msgEl.className = 'hint err' }
          toast(t, 'error')
          return
        }
      }
      if (p.req && !v) {
        const t = fn.name + ' 参数不全：' + p.label
        if (msgEl) { msgEl.textContent = t; msgEl.className = 'hint err' }
        toast('请先填 ' + p.label, 'warn')
        if (el) el.focus()
        return
      }
      if (v !== '' || p.def != null) args[p.key] = v
    }

    if (msgEl) { msgEl.textContent = '请求中…'; msgEl.className = 'hint' }
    const entry = opLogPush(fn.name, argBrief(fn, args))
    setOpState(fn.name + ' 执行中…')
    const t0 = Date.now()
    const r = await post('/api/lab/invoke', { op: fn.op, args })
    const ms = (r && r.ms) || (Date.now() - t0)
    const ok = !!(r && r.ok)
    const text = (r && r.msg) || (ok ? '完成' : '调用失败')
    const lines = (r && Array.isArray(r.lines) && r.lines.length) ? r.lines : [text]

    opLogFill(entry, ok, text, lines, ms)
    setOpState(fn.name + (ok ? ' 成功' : ' 失败') + ' · ' + nowHMS(), ok)
    if (msgEl) { msgEl.textContent = ok ? '成功' : text; msgEl.className = 'hint' + (ok ? ' ok' : ' err') }
    if (!ok) toast(text, 'error')

    if (fn.send) {
      pushLabHistory(args.type, args.id, args.text, ok)
      if (ok) {
        const ta = fnEl(tab, 'text')
        if (ta) ta.value = ''
      }
    }
  }

  function initLab () {
    store.fnPick = { read: null, op: null }
    store.fnKind = { read: 'group', op: 'group' }
    store.fnCat = { read: '', op: '' }

    attachFnPicker('read')
    attachFnPicker('op')
    renderFnParams('read')
    renderFnParams('op')
    const rBtn = document.getElementById('fn-read-run')
    const oBtn = document.getElementById('fn-op-run')
    if (rBtn) rBtn.addEventListener('click', () => runFn('read'))
    if (oBtn) oBtn.addEventListener('click', () => runFn('op'))

    const wipe = $('#lab-wipe')
    if (wipe) {
      wipe.addEventListener('click', () => {
        store.labHistory = []
        localStorage.removeItem('fl-lab-history')
        renderLabHistory()
        toast('发送记录已清空', 'ok')
      })
    }

    const wipeLog = $('#op-wipe')
    if (wipeLog) {
      wipeLog.addEventListener('click', () => {
        const box = opStream()
        if (box) box.innerHTML = '<div class="empty">执行记录已清空，下一次调用的参数和结果会重新显示在这里。</div>'
        setOpState('还没有调用')
      })
    }
    try { store.labHistory = JSON.parse(localStorage.getItem('fl-lab-history')) || [] } catch {}
    renderLabHistory()

    $$('#lab-tabs button').forEach((b) => {
      b.addEventListener('click', () => {
        const tab = b.dataset.tab
        store.labTab = tab
        $$('#lab-tabs button').forEach((x) => x.classList.toggle('active', x === b))
        $$('.lab-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === tab))
      })
    })
    /* ?ltab=op 要在监听器就位后再切（上面 click 太早了） */
    const lt = new URLSearchParams(location.search).get('ltab')
    if (lt === 'op' || lt === 'read') {
      const b = document.querySelector(`#lab-tabs button[data-tab="${lt}"]`)
      if (b) b.click()
    }
  }

  function renderLabHistory () {
    const ul = $('#lab-list')
    if (!store.labHistory.length) { ul.innerHTML = '<li class="empty">还没有发送记录</li>'; return }
    ul.innerHTML = store.labHistory.map((h) =>
      `<li class="${h.ok ? 'ok-tx' : 'fail'}"><span class="t">${esc(h.t)}</span>` +
      `<span class="to">${h.kind === 'group' ? '群' : '好友'} ${esc(h.id)}</span>` +
      `<span class="tx" title="${esc(h.text)}">${esc(h.text)}</span></li>`
    ).join('')
  }

  function fmtAgo (ts) {
    if (!ts) return '—'
    const s = Math.round((Date.now() - ts) / 1000)
    if (s < 5) return '刚刚'
    if (s < 90) return s + ' 秒前'
    if (s < 5400) return Math.round(s / 60) + ' 分钟前'
    return Math.round(s / 3600) + ' 小时前'
  }

  const MSG = { ct: 0, peer: '', q: '', items: [], total: 0, loading: false, done: false }

  function msgTime (ts) {
    const d = new Date(Number(ts) || Date.now())
    const p = (n) => String(n).padStart(2, '0')
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }

  function renderMsgList () {
    const box = $('#msg-list')
    if (!box) return
    if (!MSG.items.length) {
      const filtered = !!(MSG.q || MSG.peer || MSG.ct)
      box.innerHTML = '<li class="empty">' +
        (filtered ? '没有匹配的消息，换个条件试试' : '还没有消息记录 —— 收到新消息后会自动记录') + '</li>'
      return
    }
    const frag = document.createDocumentFragment()
    MSG.items.forEach((m) => {
      const li = document.createElement('li')
      li.className = 'msg-item'
      const isGroup = Number(m.chatType) === 2
      const who = m.senderNick || m.senderUin || '—'
      li.innerHTML =
        `<span class="tm">${msgTime(m.time)}</span>` +
        `<span class="ct">${isGroup ? '群' : '私'}</span>` +
        `<span class="peer" title="${esc(m.peer)}">${esc(m.peer)}</span>` +
        `<span class="who" title="${esc(who)}">${esc(who)}</span>` +
        `<span class="tx" title="${esc(m.text)}">${esc(m.text)}</span>` +
        `<span class="id" title="点击复制 message_id">#${esc(m.messageId)}</span>`
      const idEl = li.querySelector('.id')
      if (idEl) {
        idEl.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(String(m.messageId))
            toast('已复制 message_id=' + m.messageId, 'ok')
          } catch { toast('复制失败，请手动选中', 'error') }
        })
      }
      frag.appendChild(li)
    })
    box.innerHTML = ''
    box.appendChild(frag)
  }

  function msgStat () {
    const n = MSG.items.length
    const el = $('#msg-stat')
    if (el) el.textContent = n ? `共 ${MSG.total} 条 · 已显示 ${n}` : '—'
    const more = $('#msg-more')
    const hint = $('#msg-more-hint')
    if (more) more.disabled = MSG.done || n < 80
    if (hint) hint.textContent = MSG.done && n ? '没有更早的了' : ''
  }

  async function loadMessages (append) {
    if (MSG.loading) return
    MSG.loading = true
    try {
      const qs = new URLSearchParams({ limit: '80' })
      if (MSG.ct) qs.set('chat_type', String(MSG.ct))
      if (MSG.peer) qs.set('peer', MSG.peer)
      if (MSG.q) qs.set('q', MSG.q)
      if (append && MSG.items.length) qs.set('before', String(MSG.items[MSG.items.length - 1].time))
      const r = await getJSON('/api/messages?' + qs.toString())
      if (!r || !r.ok) {
        const box = $('#msg-list')
        if (box) box.innerHTML = '<li class="empty">读不到历史消息：' + esc((r && (r.msg || r.error)) || '接口没响应') + '</li>'
        return
      }
      const list = Array.isArray(r.list) ? r.list : []
      if (append) {
        const seen = new Set(MSG.items.map((m) => m.kernelId))
        list.forEach((m) => { if (!seen.has(m.kernelId)) MSG.items.push(m) })
        MSG.done = list.length < 80
      } else {
        MSG.items = list
        MSG.done = list.length < 80
      }
      MSG.total = Number(r.total) || MSG.items.length
      renderMsgList()
      msgStat()
    } finally {
      MSG.loading = false
    }
  }

  async function loadMsgPeers () {
    const sel = $('#msg-peer')
    if (!sel) return
    const r = await getJSON('/api/messages/peers?limit=40')
    const list = (r && Array.isArray(r.list)) ? r.list : []
    const keep = sel.value
    sel.innerHTML = '<option value="">全部会话</option>' + list.map((p) => {
      const label = (Number(p.chatType) === 2 ? '群 ' + p.peer : '私 ' + p.peer) +
        (p.senderNick ? '（' + p.senderNick + '）' : '') + ' · ' + (p.n || 0) + ' 条'
      return `<option value="${esc(p.peer)}">${esc(label)}</option>`
    }).join('')
    if (keep) sel.value = keep
  }

  function initMessages () {
    const tabs = $('#msg-tabs')
    if (tabs) {
      tabs.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-mtab]')
        if (!b) return
        const which = b.dataset.mtab
        $$('#msg-tabs button').forEach((x) => x.classList.toggle('active', x === b))
        $$('[data-mpane]').forEach((p) => p.classList.toggle('active', p.dataset.mpane === which))
        const hint = $('#msg-tab-hint')
        if (hint) hint.textContent = which === 'event' ? '通知、申请与系统消息自动保存记录' : '收到的消息记录，可搜可翻页'
        if (which === 'event') loadEvents()
        else loadMessages(false)
      })
    }
    /* ?mtab=event 直接落到事件页签（无头截图 / 分享链接用） */
    if (new URLSearchParams(location.search).get('mtab') === 'event') {
      const b = $('#msg-tabs button[data-mtab="event"]')
      if (b) b.click()
    }
    const bar = $('#msg-type')
    if (bar) {
      bar.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-ct]')
        if (!b) return
        $$('#msg-type button').forEach((x) => x.classList.toggle('active', x === b))
        MSG.ct = Number(b.dataset.ct) || 0
        loadMessages(false)
      })
    }
    const sel = $('#msg-peer')
    if (sel) sel.addEventListener('change', () => { MSG.peer = sel.value; loadMessages(false) })
    const kw = $('#msg-q')
    if (kw) {
      let tm = 0
      kw.addEventListener('input', () => {
        clearTimeout(tm)
        tm = setTimeout(() => { MSG.q = kw.value.trim(); loadMessages(false) }, 320)
      })
    }
    const rf = $('#msg-refresh')
    if (rf) rf.addEventListener('click', async () => { await loadMsgPeers(); await loadMessages(false) })
    const more = $('#msg-more')
    if (more) more.addEventListener('click', () => loadMessages(true))
  }

  const EV = { type: '', q: '', items: [] }

  function evSummary (row) {
    let p = null
    try { p = JSON.parse(row.payload || '{}') } catch { p = null }
    if (!p) return String(row.payload || '').slice(0, 120)
    if (p.notice_type) {
      const bits = [p.notice_type]
      if (p.sub_type) bits.push(p.sub_type)
      if (p.group_id) bits.push('群 ' + p.group_id)
      if (p.user_id) bits.push('QQ ' + p.user_id)
      if (p.notice_type === 'group_card') bits.push('名片：' + (p.card_new || '(空)'))
      if (p.notice_type === 'group_upload' && p.file) bits.push(p.file.name || '')
      return bits.join(' · ')
    }
    if (p.request_type) {
      const bits = [p.request_type + ' 申请']
      if (p.group_id) bits.push('群 ' + p.group_id)
      if (p.user_id) bits.push('QQ ' + p.user_id)
      if (p.comment) bits.push('附言：' + p.comment)
      return bits.join(' · ')
    }
    if (p.evt === 'msg' || p.chat) return (p.nick ? p.nick + '：' : '') + String(p.text || '')
    if (p.tree) {
      const keys = Object.keys(p.tree).slice(0, 6).map((k) => k + '=' + (typeof p.tree[k] === 'object' ? '{…}' : String(p.tree[k]).slice(0, 14)))
      return '系统消息 ' + (p.bytes || 0) + 'B · ' + keys.join(' ')
    }
    if (p.kind) return p.kind + (p.group ? ' · 群 ' + p.group : '')
    return JSON.stringify(p).slice(0, 120)
  }

  function renderEvents () {
    const box = $('#ev-list')
    if (!box) return
    if (!EV.items.length) {
      box.innerHTML = '<li class="empty">还没有事件 —— 收到通知/申请后会出现在这里</li>'
      return
    }
    box.innerHTML = EV.items.map((r) => {
      const t = new Date(Number(r.at) || Date.now())
      const p = (n) => String(n).padStart(2, '0')
      const stamp = `${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`
      const kind = String(r.type || '')
      const cls = /notice/.test(kind) ? 'notice' : /sysmsg/.test(kind) ? 'sys' : /request/.test(kind) ? 'req' : 'msg'
      return `<li class="msg-item ev-${cls}">
        <span class="tm">${stamp}</span>
        <span class="ct">${esc(kind)}</span>
        <span class="tx" title="${esc(evSummary(r))}">${esc(evSummary(r))}</span>
      </li>`
    }).join('')
  }

  async function loadEvents () {
    const qs = new URLSearchParams({ limit: '150' })
    const kw = (EV.q || '').trim()
    if (kw) qs.set('type', kw)
    const r = await getJSON('/api/events?' + qs.toString())
    if (!r || !r.ok) {
      const box = $('#ev-list')
      if (box) box.innerHTML = '<li class="empty">读不到事件：' + esc((r && (r.msg || r.error)) || '接口没响应') + '</li>'
      return
    }
    EV.items = Array.isArray(r.list) ? r.list : []
    renderEvents()
    const stat = $('#ev-stat')
    if (stat) stat.textContent = EV.items.length ? `最近 ${EV.items.length} 条` : '—'
    /* 类型快捷筛选：只放最有信息量的几类 */
    const types = (Array.isArray(r.types) ? r.types : []).filter((x) => /notice|request|sysmsg/.test(String(x.type || ''))).slice(0, 8)
    const bar = $('#ev-types')
    if (bar) {
      bar.innerHTML = '<button class="fchip' + (EV.type ? '' : ' active') + '" data-et="">全部</button>' +
        types.map((x) => `<button class="fchip${EV.type === x.type ? ' active' : ''}" data-et="${esc(x.type)}">${esc(x.type)} ${x.n}</button>`).join('')
    }
  }

  function initEvents () {
    const bar = $('#ev-types')
    if (bar) {
      bar.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-et]')
        if (!b) return
        EV.type = b.dataset.et || ''
        loadEvents()
      })
    }
    const rf = $('#ev-refresh')
    if (rf) rf.addEventListener('click', () => loadEvents())
    const q = $('#ev-q')
    if (q) {
      let tm = 0
      q.addEventListener('input', () => {
        clearTimeout(tm)
        tm = setTimeout(() => { EV.q = q.value.trim(); loadEvents() }, 320)
      })
    }
  }

  async function refreshDebug () {
    const d = await getJSON('/api/debug/dump')
    if (!d) return
    store.dump = d
    const b = d.bridge || {}
    const el = (sel, v) => { const n = $(sel); if (n) n.textContent = v }
    el('#d-conn', b.connected ? '已连接' : '未连接')
    el('#d-last', fmtAgo(b.lastEventAt))
    el('#d-frames', String(b.frames ?? '—'))
    el('#d-rss', d.process && d.process.memory
      ? (d.process.memory / 1048576).toFixed(1) + ' MB' : '—')
  }

  function initDebug () {
    const rb = $('#dbg-refresh')
    if (rb) rb.addEventListener('click', refreshDebug)
    const cb = $('#dbg-copy')
    if (cb) {
      cb.addEventListener('click', async () => {
        try {
          const d = store.dump || {}
          const b = d.bridge || {}
          const s = store.state || {}
          const info = {
            版本: s.version || '—',
            运行时长: fmtUptime(s.uptime),
            消息服务: b.connected ? '已连接' : '未连接',
            已处理事件: b.frames ?? 0,
            最近活动: b.lastEventAt ? new Date(b.lastEventAt).toLocaleString('zh-CN') : '—',
            平台: (d.process && d.process.platform) || '—',
            内存: d.process && d.process.memory ? (d.process.memory / 1048576).toFixed(1) + ' MB' : '—'
          }
          await navigator.clipboard.writeText(JSON.stringify(info, null, 2))
          toast('已复制诊断信息', 'ok')
        } catch {
          toast('复制失败，请手动截图本页', 'error')
        }
      })
    }
  }

  const SWATCH_PRESETS = ['#7aa2ff', '#a78bfa', '#ff7ab8', '#4fd1a5', '#ff9f6e', '#59d1e8', '#f5c542']

  function syncPrefsUI () {
    const p = readPrefs()
    $$('#pref-theme button').forEach((b) => b.classList.toggle('active', (b.dataset.v) === (p.theme || 'dark')))
    $$('#pref-swatches .swatch:not(.custom)').forEach((b) => {
      b.classList.toggle('active', (b.dataset.c || '').toLowerCase() === (p.accent || '').toLowerCase())
    })
    $('#pref-anim').checked = p.animations !== false
    $('#pref-font').value = p.termFont || 12.5
    $('#pref-font-val').textContent = (p.termFont || 12.5) + 'px'
    if (p.accent) $('#pref-accent-custom').value = p.accent
    if (store.tokenFile && $('#tk-file')) $('#tk-file').textContent = store.tokenFile
  }

  /* 令牌强度标签：服务端 reset/setup 会把 strength 带回来，这里只负责显示 */
  const TK_LEVEL_DESC = {
    low: '字母 + 数字',
    medium: '大写 + 小写 + 数字',
    high: '大写 + 小写 + 数字 + 符号'
  }

  function renderTokenStrength (st) {
    const el = $('#tk-strength')
    if (!el) return
    if (!st || !st.level || !st.label) {
      el.hidden = true
      el.textContent = ''
      return
    }
    el.hidden = false
    el.dataset.level = st.level
    el.textContent = `强度 ${st.label} · ${TK_LEVEL_DESC[st.level] || ''}`
  }

  function initPrefs () {
    $$('#pref-theme button').forEach((b) => {
      b.addEventListener('click', () => {
        applyPrefs(savePrefs({ theme: b.dataset.v }))
        syncPrefsUI()
      })
    })
    $$('#pref-swatches .swatch:not(.custom)').forEach((b) => {
      b.addEventListener('click', () => {
        applyPrefs(savePrefs({ accent: b.dataset.c }))
        syncPrefsUI()
      })
    })
    $('#pref-accent-custom').addEventListener('input', (e) => {
      applyPrefs(savePrefs({ accent: e.target.value }))
      syncPrefsUI()
    })
    $('#pref-anim').addEventListener('change', (e) => {
      applyPrefs(savePrefs({ animations: e.target.checked }))
    })
    $('#pref-font').addEventListener('input', (e) => {
      const v = Number(e.target.value)
      $('#pref-font-val').textContent = v + 'px'
      document.documentElement.style.setProperty('--term-font', v + 'px')
      savePrefs({ termFont: v })
    })

    $('#tk-copy').addEventListener('click', async () => {
      const t = token()
      if (!t) { toast('手上没有令牌，去登录页重新输入', 'error'); return }
      try { await navigator.clipboard.writeText(t); toast('完整令牌已复制', 'ok') } catch { toast('复制失败', 'error') }
    })
    $('#tk-reset').addEventListener('click', async () => {
      if (!confirm('重置后旧令牌立刻失效，所有浏览器都要用新令牌重新进入。继续？')) return
      const r = await post('/api/auth/token/reset', {})
      if (!r || !r.ok) { toast('重置失败', 'error'); return }
      sessionStorage.setItem(TOKEN_KEY, r.token)
      $('#tk-reveal').hidden = false
      $('#tk-value').textContent = r.token
      renderTokenStrength(r.strength)
      syncPrefsUI()
      toast('令牌已重置', 'ok')
    })
    $('#tk-logout').addEventListener('click', () => {
      logout()
    })
  }

  function fmtUptime (sec) {
    sec = Number(sec) || 0
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    const s = sec % 60
    if (h) return `${h}时${m}分`
    if (m) return `${m}分${s}秒`
    return `${s}秒`
  }

  function setChip (id, state, value) {
    const el = $(id)
    if (!el) return
    el.dataset.state = state
    const v = el.querySelector('.chip-v')
    if (v && value != null) v.textContent = value
  }

  function renderAccounts (p) {
    const box = $('#chip-acct')
    const sel = $('#v-acct')
    if (!box || !sel) return
    const list = Array.isArray(p.accounts) ? p.accounts : []
    const label = (a) => (a.uin ? String(a.uin) : 'pid ' + a.pid) + (a.nick ? ' · ' + a.nick : '')
    const sig = list.map((a) => a.pid + ':' + (a.uin || '') + ':' + (a.nick || '') + ':' + (a.connected ? 1 : 0)).join('|')
    if (sel.dataset.sig !== sig) {
      sel.dataset.sig = sig
      sel.innerHTML = list.length
        ? list.map((a) => `<option value="${a.pid}">${esc(label(a))}${a.connected ? '' : '（未连上）'}</option>`).join('')
        : '<option value="">无账号</option>'
    }
    const cur = list.find((a) => a.pid === p.pid) || list.find((a) => a.uin && a.uin === p.uin) || list[0]
    if (cur) sel.value = String(cur.pid)
    box.dataset.state = cur && cur.connected ? 'on' : 'off'
    box.title = list.length > 1
      ? `当前账号 ${cur ? label(cur) : '无'}（共 ${list.length} 个，点这里切换）`
      : (cur ? `当前账号 ${label(cur)}` : '没有已连接的账号')
  }

  document.addEventListener('change', async (e) => {
    if (!e.target || e.target.id !== 'v-acct') return
    const key = String(e.target.value || '')
    if (!key) return
    const r = await post('/api/accounts/select', { key })
    if (r && r.ok) {
      toast('已切换到 ' + (r.account.uin || r.account.pid), 'ok')
      const st = await getJSON('/api/state')
      if (st) renderState(st)
    } else {
      toast((r && (r.msg || r.text)) || '切换失败', 'err')
    }
  })

  function renderState (s) {
    if (!s) return
    store.state = s
    const p = s.payload || {}
    const q = s.qq || {}
    const connected = !!p.connected
    const running = !!q.running

    setChip('#chip-conn', connected ? 'on' : (running ? 'warn' : 'off'),
      connected ? '已连接' : (running ? '连接中' : '未连接'))
    setChip('#chip-mode', 'on', '原生')
    setChip('#chip-qq', running ? 'on' : 'off', running ? '运行中' : '未运行')

    const kn = s.kernel || {}
    setChip('#chip-backend', kn.online ? 'on' : 'off',
      kn.online ? '已连接' : '未连接')
    renderAccounts(p)

    $('#hero-mode').textContent = connected ? 'QQ 客户端' : '待连接'
    $('#hero-mode-note').textContent = running
      ? 'QQ 照常登录使用，面板在后台接管消息'
      : '先启动 QQ，面板会自动接管'
    $('#badge-mode').textContent = 'QQ 客户端'
    $('#badge-mode').className = 'badge ok'

    $('#hero-pid').textContent = running ? '运行中' : '已停止'
    $('#hero-qq-note').textContent = running
      ? 'QQ 正在登录使用'
      : '点下面按钮启动 QQ'
    $('#badge-qq').textContent = running ? '运行中' : '已停止'
    $('#badge-qq').className = 'badge ' + (running ? 'ok' : 'bad')

    $('#hero-kind').textContent = connected ? '已连接' : '未连接'
    $('#hero-pipe-note').textContent = connected
      ? '消息收发正常'
      : '连接后即可收发消息'
    $('#badge-pipe').textContent = connected ? '正常' : '离线'
    $('#badge-pipe').className = 'badge ' + (connected ? 'ok' : 'warn')

    const rt = s.runtime || {}
    const st = rt.state || {}
    const login = st.login || {}
    $('#rt-uin').textContent = login.uin || '—'
    $('#rt-uptime').textContent = fmtUptime(s.uptime)
    $('#rt-updated').textContent = '更新于 ' + nowHMS()

    const labHint = $('#lab-msf-hint')
    if (labHint) {
      labHint.textContent = connected ? '可用' : 'QQ 未连接'
      labHint.style.color = connected ? 'var(--ok)' : 'var(--muted)'
    }

    $('#ab-ver').textContent = 'v' + (s.version || '—')
    $('#ab-url').textContent = (s.panel && s.panel.url) || '—'

    // 设置表单只在首次填充，避免覆盖已填内容
    if (!store.cfgFilled) fillConfig(s.config)

  }

  const OB_BLOCKS = [
    { key: 'httpServers', kind: 'server', label: 'HTTP 服务', addrLabel: '端口', addrPh: '3000' },
    { key: 'httpClients', kind: 'client', label: 'HTTP 上报', addrLabel: '上报地址', addrPh: 'http://127.0.0.1:8080/onebot/event' },
    { key: 'wsServers', kind: 'server', label: '正向 WS', addrLabel: '端口', addrPh: '3001' },
    { key: 'wsClients', kind: 'client', label: '反向 WS', addrLabel: 'WS 地址', addrPh: 'ws://127.0.0.1:6199/ws' }
  ]

  function migrateLegacyNet (cfg) {
    return {
      httpServers: cfg.obServerPort ? [{ name: 'HTTP 服务', port: cfg.obServerPort, token: '', enable: true }] : [],
      wsServers: [],
      wsClients: (cfg.obServerReverse || []).map((line) => {
        const m = String(line).trim().match(/^(\S+)(?:\s+(\S+))?$/)
        return m ? { name: '反向 WS', url: m[1], token: m[2] || '', enable: true } : null
      }).filter(Boolean),
      httpClients: (cfg.obServerPost || []).map((line) => {
        const m = String(line).trim().match(/^(\S+)(?:\s+(\S+))?$/)
        return m ? { name: 'HTTP 上报', url: m[1], token: m[2] || '', enable: true } : null
      }).filter(Boolean)
    }
  }

  function renderOb (net) {
    for (const b of OB_BLOCKS) {
      const list = $('[data-ob-list="' + b.key + '"]')
      if (!list) continue
      list.innerHTML = ''
      const items = (net[b.key] || [])
      if (!items.length) {
        list.innerHTML = '<div class="ob-empty">还没有连接，点右上「添加」建一个</div>'
        continue
      }
      items.forEach((e, idx) => {
        const card = document.createElement('div')
        card.className = 'ob-entry'
        card.dataset.idx = idx
        const addr = b.kind === 'server'
          ? '<input type="number" min="1024" max="65535" data-obf="port" value="' + String(e.port || '') + '" placeholder="' + b.addrPh + '">'
          : '<input type="text" spellcheck="false" data-obf="url" value="' + String(e.url || '').replace(/"/g, '&quot;') + '" placeholder="' + b.addrPh + '">'
        card.innerHTML =
          '<div class="ob-entry-head"><input type="text" class="ob-name" data-obf="name" value="' + String(e.name || '').replace(/"/g, '&quot;') + '" placeholder="' + b.label + '名称">' +
          '<label class="checkline ob-on"><input type="checkbox" data-obf="enable"' + (e.enable !== false ? ' checked' : '') + '><span>启用</span></label>' +
          '<button type="button" class="btn small danger" data-ob-del>删除</button></div>' +
          '<div class="ob-entry-grid">' +
          '<label><span>' + b.addrLabel + '</span>' + addr + '</label>' +
          '<label><span>专用令牌（留空用统一令牌）</span><input type="password" spellcheck="false" autocomplete="off" data-obf="token" value="' + String(e.token || '').replace(/"/g, '&quot;') + '"></label>' +
          '</div>'
        list.appendChild(card)
      })
    }
  }

  function readObBlock (key) {
    const list = $('[data-ob-list="' + key + '"]')
    if (!list) return []
    return [...list.querySelectorAll('.ob-entry')].map((card) => ({
      name: card.querySelector('[data-obf="name"]').value.trim(),
      port: Number(card.querySelector('[data-obf="port"]')?.value) || 0,
      url: card.querySelector('[data-obf="url"]')?.value.trim() || '',
      token: card.querySelector('[data-obf="token"]').value.trim(),
      enable: card.querySelector('[data-obf="enable"]').checked
    }))
  }

  function bindObButtons () {
    if (store.obBound) return
    store.obBound = true
    $$('[data-ob-add]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.obAdd
        const list = $('[data-ob-list="' + key + '"]')
        if (!list) return
        const b = OB_BLOCKS.find((x) => x.key === key)
        const empty = b.kind === 'server' ? { name: '', port: '', token: '', enable: true } : { name: '', url: '', token: '', enable: true }
        const cur = readObBlock(key)
        cur.push(empty)
        renderOb({ [key]: cur, httpServers: readObBlock('httpServers'), wsServers: readObBlock('wsServers'), wsClients: readObBlock('wsClients'), httpClients: readObBlock('httpClients') })
        const cards = list.querySelectorAll('.ob-entry')
        if (cards.length) cards[cards.length - 1].querySelector('[data-obf="name"]')?.focus()
      })
    })
    document.addEventListener('click', (e) => {
      const del = e.target.closest('[data-ob-del]')
      if (!del) return
      const card = del.closest('.ob-entry')
      const list = card && card.closest('.ob-entries')
      if (!card || !list) return
      const key = list.dataset.obList
      const cur = readObBlock(key)
      cur.splice(Number(card.dataset.idx), 1)
      renderOb({ [key]: cur, httpServers: readObBlock('httpServers'), wsServers: readObBlock('wsServers'), wsClients: readObBlock('wsClients'), httpClients: readObBlock('httpClients') })
    })
  }

  function fillConfig (cfg) {
    if (!cfg) return
    const f = $('#cfg-form')
    f.qqExe.value = cfg.qqExe || ''
    f.autoStartQQ.checked = !!cfg.autoStartQQ
    f.autoInject.checked = !!cfg.autoInject
    if (f.obServerToken) f.obServerToken.value = cfg.obServerToken || ''
    /* 矩阵真空而旧字段有值（老配置升级）→ 前端先迁移显示，保存后落盘 */
    const legacy = migrateLegacyNet(cfg)
    const empty = (net) => !net || OB_BLOCKS.every((b) => !(net[b.key] || []).length)
    renderOb(empty(cfg.obNetwork) ? legacy : cfg.obNetwork)
    bindObButtons()
    store.cfgFilled = true
    store.prefix = cfg.cmdPrefix || '#fl'
  }

  const ACT_LABEL = {
    start: '启动 QQ',
    stop: '停止 QQ',
    restart: '重启 QQ',
    inject: '连接',
    reload: '重新连接'
  }

  async function doAction (act) {
    const btns = $$(`[data-act="${act}"]`)
    btns.forEach((b) => { b.disabled = true })
    pushSys(`执行：${ACT_LABEL[act] || act}`)
    try {
      let r
      if (act === 'reload') r = await post('/api/payload/reload', {})
      else r = await post('/api/qq/' + act, {})
      const text = r.text || r.msg || (r.ok ? '完成' : '失败')
      pushSys(text, r.ok ? 'ok' : 'error')
      toast(text, r.ok ? 'ok' : 'error')
      refreshState()
    } finally {
      btns.forEach((b) => { b.disabled = false })
    }
  }

  function initActions () {
    $$('[data-act]').forEach((b) => b.addEventListener('click', () => doAction(b.dataset.act)))
    $('#btn-refresh').addEventListener('click', async (e) => {
      const btn = $('#btn-refresh')
      btn.classList.add('spin')
      await refreshState()
      setTimeout(() => btn.classList.remove('spin'), 500)
    })
    $('#btn-inject')?.addEventListener('click', async () => {
      const btn = $('#btn-inject')
      btn.disabled = true
      const r = await post('/api/qq/inject', {})
      toast(r.ok ? '已重新连接' : (r.msg || '连接失败'), r.ok ? 'ok' : 'error')
      btn.disabled = false
      refreshState()
    })
  }

  async function refreshState () {
    const s = await getJSON('/api/state')
    if (s && !s.error) renderState(s)
  }

  function initSettings () {
    $('#cfg-form').addEventListener('submit', async (e) => {
      e.preventDefault()
      const f = e.target
      const body = {
        qqExe: f.qqExe.value.trim(),
        autoStartQQ: f.autoStartQQ.checked,
        autoInject: f.autoInject.checked,
        obServerToken: f.obServerToken ? f.obServerToken.value.trim() : '',
        obNetwork: {
          httpServers: readObBlock('httpServers'),
          httpClients: readObBlock('httpClients'),
          wsServers: readObBlock('wsServers'),
          wsClients: readObBlock('wsClients')
        }
      }
      const msg = $('#cfg-msg')
      msg.textContent = '保存中…'
      const r = await post('/api/config', body)
      if (r.ok) {
        /* 后端可能报「已保存但热更新失败」：既不能显示纯成功，也不能显示保存失败 */
        const text = r.msg || (r.restartNeeded ? '已保存，端口改动需重启面板生效' : '已保存')
        msg.textContent = text
        toast(text, r.warn ? 'warn' : 'ok')
      } else {
        msg.textContent = '保存失败'
        toast('保存失败', 'error')
      }
      setTimeout(() => { msg.textContent = '' }, 4000)
    })
  }

  function connectStream () {
    const es = new EventSource('/api/stream?token=' + encodeURIComponent(token()))

    es.addEventListener('log', (e) => {
      try { appendLog(JSON.parse(e.data)) } catch {}
    })
    es.addEventListener('state', (e) => {
      try { renderState(JSON.parse(e.data)) } catch {}
    })
    es.addEventListener('clear', () => {
      store.logs = []
      $('#term-body').innerHTML = ''
      updateLogCount()
    })
    es.addEventListener('op', (e) => {
      try {
        const o = JSON.parse(e.data)
        /* 只有「下发即回」的老通道（/api/lab/send 等）还会走这里；
           实验台的新路径直接在 runFn 里拿结果，不重复记 */
        const el = opLogPush(o.name || '操作', '')
        opLogFill(el, !!o.ok, o.ok ? '成功' : '失败',
          Array.isArray(o.lines) && o.lines.length ? o.lines : [o.ret || ''], null)
        setOpState((o.name || '操作') + (o.ok ? ' 成功' : ' 失败') + ' · ' + nowHMS(), !!o.ok)
        const msgEl = document.querySelector(`[data-msg="${o.name}"]`)
        if (msgEl) { msgEl.textContent = o.ok ? '成功' : '失败'; msgEl.className = 'hint' + (o.ok ? ' ok' : ' err') }
      } catch {}
    })
    es.onerror = () => {
      setChip('#chip-conn', 'warn', '重连中')
    }
  }

  async function loadLogs () {
    const rows = await getJSON('/api/logs?n=120')
    if (Array.isArray(rows)) {
      store.logs = rows
      redrawLogs()
      renderMiniLog()
      rows.slice(-40).forEach((r) => { renderLabFeed(r) })
    }
  }

  async function boot () {
    // URL 带 ?token= → 直接当本次会话的令牌用（从控制台复制的链接）
    const qToken = (new URLSearchParams(location.search).get('token') || '').trim()
    if (qToken) {
      sessionStorage.setItem(TOKEN_KEY, qToken)
      const u = new URL(location.href)
      u.searchParams.delete('token')
      history.replaceState(null, '', u.pathname + u.search + u.hash)
    }

    let auth = null
    try {
      const res = await fetch('/api/auth/status', { headers: { 'x-fl-token': token() } })
      auth = await res.json()
    } catch {}
    if (!auth) { location.href = '/login.html'; return }
    if (!auth.authed) { logout(); return }
    store.authRequired = true
    store.tokenFile = auth.tokenFile || ''

    initTheme()
    applyPrefs()
    const params = new URLSearchParams(location.search)
    if (params.get('theme')) {
      document.documentElement.dataset.theme = params.get('theme') === 'light' ? 'light' : 'dark'
    }
    initNav()
    if (params.get('page')) goto(params.get('page'))
    initConsole()
    initActions()
    initSettings()
    initLab()
    initMessages()
    initEvents()
    initDebug()
    initPrefs()
    syncPrefsUI()

    pushSys('FrishLuna 控制台已就绪')
    await refreshState()
    await loadLogs()

    // ?shot=1 用于无头截图：不挂 SSE（长连接会让 headless 永不空闲）
    const shot = location.search.includes('shot=1')
    if (!shot) connectStream()

    // 兜底轮询（SSE 断线时也能更新）
    setInterval(() => { if (!store.state || Date.now() - (store.state.now || 0) > 12000) refreshState() }, 8000)

    // 键盘：Ctrl+K 聚焦输入
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        goto('console')
      }
    })
  }

  document.addEventListener('DOMContentLoaded', boot)
})()
