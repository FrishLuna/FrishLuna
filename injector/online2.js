(function () {
  var s = globalThis.__fl_session
  function em (k, v) { try { __fl_emit(JSON.stringify({ evt: 'p', k: k, v: v })) } catch (e) {} }
  if (!s) return 'no session'
  var cands = [
    ['"nt_2"', 'nt_2'],
    ["{sessionId:'nt_2'}", { sessionId: 'nt_2' }],
    ["{id:'nt_2'}", { id: 'nt_2' }],
    ["{uin:'1000000000'}", { uin: '1000000000' }],
    ["{isOnline:true}", { isOnline: true }]
  ]
  for (var i = 0; i < cands.length; i++) {
    try { em('onLine ' + cands[i][0], 'ret=' + String(s.onLine(cands[i][1]))) }
    catch (e) { em('onLine ' + cands[i][0], 'ERR:' + (e && e.message)) }
  }
  setTimeout(function () {
    try { em('msf', String(s.getMSFService().getMsfStatus())) } catch (e) {}
    try {
      var rc = s.getRecentContactService().getRecentContactListSync()
      em('recent', rc && (rc.errMsg || ('n=' + (rc.sortedContactList ? rc.sortedContactList.length : '?'))))
    } catch (e) { em('recent ERR', e && e.message) }
  }, 3000)
  return 'online2'
})()
