(() => {
  'use strict'

  const $ = (s) => document.querySelector(s)

  const PREF_KEY = 'fl-prefs'
  function readPrefs () {
    try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {} } catch { return {} }
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
  function applyPrefs () {
    const p = readPrefs()
    const theme = p.theme === 'light' ? 'light'
      : p.theme === 'system'
        ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
        : 'dark'
    document.documentElement.dataset.theme = theme
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
    if (p.animations === false) document.body.classList.add('no-anim')
  }
  applyPrefs()

  const cv = $('#fl-bg')
  const ctx = cv.getContext('2d')
  let W = 0, H = 0, dots = [], raf = 0
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  function accentDotColor () {
    const css = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    const rgb = hexRgb(css) || [122, 162, 255]
    return rgb.join(',')
  }
  let DOT_RGB = accentDotColor()

  function resize () {
    W = cv.width = window.innerWidth * devicePixelRatio
    H = cv.height = window.innerHeight * devicePixelRatio
    cv.style.width = window.innerWidth + 'px'
    cv.style.height = window.innerHeight + 'px'
    const n = Math.min(90, Math.round((window.innerWidth * window.innerHeight) / 16000))
    dots = Array.from({ length: n }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      vx: (Math.random() - .5) * .35 * devicePixelRatio,
      vy: (Math.random() - .5) * .35 * devicePixelRatio,
      r: (Math.random() * 1.6 + .7) * devicePixelRatio,
      tw: Math.random() * Math.PI * 2
    }))
  }

  function tick () {
    ctx.clearRect(0, 0, W, H)
    const LINK = 140 * devicePixelRatio
    for (const d of dots) {
      d.x += d.vx; d.y += d.vy; d.tw += .02
      if (d.x < -20) d.x = W + 20
      if (d.x > W + 20) d.x = -20
      if (d.y < -20) d.y = H + 20
      if (d.y > H + 20) d.y = -20
    }
    ctx.lineWidth = 1 * devicePixelRatio
    for (let i = 0; i < dots.length; i++) {
      for (let j = i + 1; j < dots.length; j++) {
        const a = dots[i], b = dots[j]
        const dx = a.x - b.x, dy = a.y - b.y
        const dist = Math.hypot(dx, dy)
        if (dist < LINK) {
          const alpha = (1 - dist / LINK) * .22
          ctx.strokeStyle = `rgba(${DOT_RGB}, ${alpha.toFixed(3)})`
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
        }
      }
    }
    for (const d of dots) {
      const alpha = .35 + .3 * Math.sin(d.tw)
      ctx.fillStyle = `rgba(${DOT_RGB}, ${alpha.toFixed(3)})`
      ctx.beginPath()
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2)
      ctx.fill()
    }
    raf = requestAnimationFrame(tick)
  }

  resize()
  window.addEventListener('resize', resize)
  if (!reduced) tick()
  else {
    tick(); cancelAnimationFrame(raf)
  }

  const card = $('#login-card')
  window.addEventListener('mousemove', (e) => {
    const dx = (e.clientX / window.innerWidth - .5)
    const dy = (e.clientY / window.innerHeight - .5)
    card.style.transform = `rotateY(${dx * 4}deg) rotateX(${-dy * 4}deg)`
    document.querySelectorAll('.login-deco').forEach((el, i) => {
      const f = (i + 1) * 8
      el.style.translate = `${dx * f}px ${dy * f}px`
    })
  })

  /* 只放 sessionStorage：关掉浏览器即失效，不做「在本机记住」 */
  const TOKEN_KEY = 'fl-token'

  const form = $('#login-form')
  const input = $('#login-token')
  const btn = $('#login-btn')
  const btnText = $('#login-btn-text')
  const msg = $('#login-msg')

  function say (text, ok) {
    msg.textContent = text
    msg.classList.toggle('ok', !!ok)
  }

  async function api (path, body, tk) {
    const headers = {}
    if (body) headers['Content-Type'] = 'application/json'
    if (tk) headers['x-fl-token'] = tk
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers,
      body: body ? JSON.stringify(body) : undefined
    })
    let data = {}
    try { data = await res.json() } catch {}
    return Object.assign({ __status: res.status }, data)
  }

  function store (token) {
    sessionStorage.setItem(TOKEN_KEY, token)
  }

  function enter () {
    btnText.textContent = '进入面板…'
    setTimeout(() => { location.replace('/') }, 320)
  }

  $('#token-paste').addEventListener('click', async () => {
    try {
      const t = (await navigator.clipboard.readText() || '').trim()
      if (!t) { say('剪贴板是空的'); input.focus(); return }
      input.value = t
      say('已粘贴', true)
      input.focus()
    } catch {
      say('浏览器不让读剪贴板，手动粘贴一下')
      input.focus()
    }
  })

  ;(async () => {
    // 旧版本会把令牌留在 localStorage，这里统一清掉，不再本机持久化
    try { localStorage.removeItem(TOKEN_KEY) } catch {}
    const q = (new URLSearchParams(location.search).get('token') || '').trim()
    if (q) {
      sessionStorage.setItem(TOKEN_KEY, q)
      history.replaceState(null, '', location.pathname)
      location.replace('/')
      return
    }
    const saved = sessionStorage.getItem(TOKEN_KEY) || ''
    if (saved) {
      try {
        const st = await api('/api/auth/status', null, saved)
        if (st.authed) {
          btnText.textContent = '进入面板…'
          location.replace('/')
          return
        }
        // 令牌失效（被重置）：清掉，留在登录页
        sessionStorage.removeItem(TOKEN_KEY)
        say('令牌已失效（可能被重置了），用新的重新进入')
      } catch {
        say('面板服务没连上，检查面板进程')
      }
    }
    setTimeout(() => input.focus(), 420)
  })()

  const setupBlock = $('#setup-block')
  const setupInput = $('#setup-token')
  const setupMsg = $('#setup-msg')
  const setupSave = $('#setup-save')
  const setupSaveText = $('#setup-save-text')
  let setupTicket = ''

  /* 规则和服务端一致：最短 8 位；随机生成的一律 16 位（大小写字母 + 数字，强度＝中） */
  const TOKEN_MIN = 8
  const TOKEN_MAX = 64
  const TOKEN_GEN_LEN = 16
  const GEN_CHARS = 'abcdefghijklmnopqrstuvw' + 'xyzABCDEFGHIJKLMNOPQRSTUV' + 'WXYZ0123456789'
  const pick = () => GEN_CHARS[crypto.getRandomValues(new Uint32Array(1))[0] % GEN_CHARS.length]
  function genToken () {
    for (let guard = 0; guard < 50; guard++) {
      let out = ''
      for (let i = 0; i < TOKEN_GEN_LEN; i++) out += pick()
      if (/[a-z]/.test(out) && /[A-Z]/.test(out) && /[0-9]/.test(out)) return out
    }
    /* 极端兜底：先放齐大小写+数字各一个，其余随机，再打乱 */
    const chars = ['a', 'Z', '7'].concat(Array.from({ length: TOKEN_GEN_LEN - 3 }, pick))
    for (let i = chars.length - 1; i > 0; i--) {
      const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1)
      const t = chars[i]; chars[i] = chars[j]; chars[j] = t
    }
    return chars.join('')
  }

  const setupMeter = $('#setup-meter')
  const setupLevelEl = $('#setup-level')
  const setupHint = $('#setup-hint')

  /* 和 app/server/auth.js 的 tokenStrength() 必须保持同一套规则 */
  const SETUP_CHARS = new Set((GEN_CHARS + '!@#$%^&*()-_+=' + '[]{};:,.?/~').split(''))
  const LEVEL_TXT = { low: '低', medium: '中', high: '高' }
  const LEVEL_HINT = {
    low: '最低强度（字母 + 数字）。让大小写都有就到「中」，再添个符号到「高」',
    medium: '强度：中（大写 + 小写 + 数字）。加一个符号（如 - _ ! @）可升到「高」',
    high: '强度：高（大写 + 小写 + 数字 + 符号）'
  }

  function strengthOf (v) {
    const s = String(v || '')
    const hasLower = /[a-z]/.test(s)
    const hasUpper = /[A-Z]/.test(s)
    const hasDigit = /[0-9]/.test(s)
    const hasSpecial = /[^A-Za-z0-9]/.test(s)
    const hasLetter = hasLower || hasUpper
    const len = s.length
    const lenOk = len >= TOKEN_MIN && len <= TOKEN_MAX
    const charOk = s.length > 0 && [...s].every((c) => SETUP_CHARS.has(c))
    const ok = lenOk && charOk && hasLetter && hasDigit
    let level = 'none'
    if (ok) {
      level = (hasSpecial && hasUpper && hasLower && hasDigit)
        ? 'high'
        : (hasUpper && hasLower && hasDigit) ? 'medium' : 'low'
    }
    const reasons = []
    if (len < TOKEN_MIN) reasons.push('至少 ' + TOKEN_MIN + ' 位')
    if (len > TOKEN_MAX) reasons.push('最多 ' + TOKEN_MAX + ' 位')
    if (!charOk) reasons.push('只能用字母、数字和常见符号')
    if (!hasLetter) reasons.push('必须含字母')
    if (!hasDigit) reasons.push('必须含数字')
    return { ok, level, reasons }
  }

  function refreshStrength () {
    const s = strengthOf(setupInput.value)
    setupMeter.dataset.level = s.ok ? s.level : 'none'
    setupLevelEl.textContent = s.ok ? '强度 ' + LEVEL_TXT[s.level] : '未达到要求'
    if (s.ok) {
      setupHint.textContent = LEVEL_HINT[s.level]
      setupHint.classList.add('good')
      setupHint.classList.remove('bad')
    } else {
      setupHint.textContent = s.reasons.join(' · ')
      setupHint.classList.add('bad')
      setupHint.classList.remove('good')
    }
    /* 不合格就锁住「保存并进入」——省得用户点了才被服务端打回 */
    setupSave.disabled = !s.ok
    return s
  }

  function setupSay (text, ok) {
    setupMsg.textContent = text
    setupMsg.classList.toggle('ok', !!ok)
  }

  function showSetup (ticket) {
    setupTicket = ticket
    form.hidden = true
    setupBlock.hidden = false
    setupInput.value = genToken()
    refreshStrength()
    setTimeout(() => { setupInput.focus(); setupInput.select() }, 160)
  }

  async function saveSetup () {
    const v = setupInput.value.trim()
    const s = strengthOf(v)
    if (!s.ok) {
      setupSay('令牌不合规：' + s.reasons.join('、'))
      setupInput.select()
      return
    }
    setupSave.disabled = true
    setupSaveText.textContent = '保存中…'
    try {
      const r = await api('/api/auth/setup', { ticket: setupTicket, token: v })
      if (r.ok) {
        sessionStorage.setItem(TOKEN_KEY, r.token)
        setupSay('已设置，正在进入…', true)
        setTimeout(() => { location.replace('/') }, 360)
      } else {
        setupSay(r.msg || '设置失败，再试一次')
        setupSaveText.textContent = '保存并进入'
      }
    } catch (err) {
      setupSay('请求失败: ' + err.message)
      setupSaveText.textContent = '保存并进入'
    } finally {
      if (setupSaveText.textContent === '保存中…') setupSaveText.textContent = '保存并进入'
      refreshStrength()
    }
  }

  $('#setup-gen').addEventListener('click', () => {
    setupInput.value = genToken()
    setupInput.focus()
    setupInput.select()
    refreshStrength()
    setupSay('已生成新令牌，记下来再用')
  })
  setupSave.addEventListener('click', saveSetup)
  setupInput.addEventListener('input', refreshStrength)
  setupInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveSetup() }
  })

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const v = input.value.trim()
    if (!v) { shake(); say('先输入访问令牌'); return }
    btn.disabled = true
    try {
      const r = await api('/api/auth/login', { token: v })
      if (r.ok && r.setupRequired) {
        say('初始令牌验证通过', true)
        showSetup(r.ticket)
        return
      }
      if (r.ok) {
        store(r.token)
        say('验证通过', true)
        enter()
      } else {
        shake()
        say(r.msg || '令牌不对，再试一次')
        input.select()
      }
    } catch (err) {
      shake()
      say('请求失败: ' + err.message)
    } finally {
      btn.disabled = false
    }
  })

  function shake () {
    card.classList.remove('shake')
    void card.offsetWidth
    card.classList.add('shake')
  }
})()
