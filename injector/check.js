(function () {
  var s = globalThis.__fl_session
  function em (k, v) { try { __fl_emit(JSON.stringify({ evt: 'p', k: k, v: v })) } catch (e) {} }
  if (!s) return 'no session'
  try { em('sid', String(s.getSessionId())) } catch (e) { em('sid ERR', e && e.message) }
  try { em('msf', String(s.getMSFService().getMsfStatus())) } catch (e) { em('msf ERR', e && e.message) }
  try {
    var rc = s.getRecentContactService().getRecentContactListSync()
    em('recent', rc && (rc.errMsg || ('n=' + (rc.sortedContactList ? rc.sortedContactList.length : '?'))))
  } catch (e) { em('recent ERR', e && e.message) }
  try {
    var g = s.getGroupService().getGroupList(false)
    if (g && g.then) g.then(function (r) { em('groups', r && (r.groupList ? ('n=' + r.groupList.length) : ('result=' + r.result + ' err=' + r.errMsg))) })
  } catch (e) { em('groups ERR', e && e.message) }
  return 'check'
})()
