(function () {
  var s = globalThis.__fl_session
  function em (k, v) { try { __fl_emit(JSON.stringify({ evt: 'p', k: k, v: v })) } catch (e) {} }
  if (!s) return 'no session'
  var ms
  try { ms = s.getMSFService() } catch (e) { return em('getMSF ERR', e && e.message) }
  em('status0', (function () { try { return String(ms.getMsfStatus()) } catch (e) { return 'ERR' } })())
  try { em('online()', 'ret=' + String(ms.online())) } catch (e) { em('online ERR', e && e.message) }
  setTimeout(function () {
    try { em('status1', String(ms.getMsfStatus())) } catch (e) { em('status1 ERR', e && e.message) }
    try {
      var rc = s.getRecentContactService().getRecentContactListSync()
      em('recent', rc && (rc.errMsg || ('n=' + (rc.sortedContactList ? rc.sortedContactList.length : '?'))))
    } catch (e) { em('recent ERR', e && e.message) }
  }, 3000)
  return 'msf-probe'
})()
