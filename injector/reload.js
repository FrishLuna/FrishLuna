(function () {
  var fs = process.mainModule.require('fs');
  var dir = (typeof __fl_dir === 'string' ? __fl_dir : '').replace(/[\\/]+$/, '')
  var p = dir + '/bridge.js'
  var src = fs.readFileSync(p, 'utf8');
  globalThis.__fl8 = null;
  (0, eval)(src);
  return 'reloaded ' + src.length;
})()
