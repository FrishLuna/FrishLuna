import fs from 'node:fs';

const major = process.argv[2] || process.env.FL_QQ_MAJOR || '';
if (!major) { console.error('用法: node tools/qq-obtain-appid.mjs <path/to/major.node>  (或设置 FL_QQ_MAJOR)'); process.exit(2) }
if (!fs.existsSync(major)) { console.error('找不到', major); process.exit(1); }
const buf = fs.readFileSync(major);
console.log('major.node =', major, buf.length, 'bytes');

// appid
const APPID_MARK = Buffer.from('QQAppId/', 'utf8');
const appids = [];
let pos = 0;
while (appids.length < 8) {
  const i = buf.indexOf(APPID_MARK, pos);
  if (i < 0) break;
  let end = i + APPID_MARK.length;
  while (end < buf.length && buf[end] !== 0) end++;
  const s = buf.subarray(i + APPID_MARK.length, end).toString('utf8');
  if (/^\d+$/.test(s)) appids.push(s);
  pos = end + 1;
}
console.log('appid 候选 =', [...new Set(appids)]);

// qua
const QUA_RE = /V1_(?:WIN|LNX|MAC)_NQ_[A-Za-z0-9._-]+_GW_B/g;
const quas = new Set();
pos = 0;
const MARK = Buffer.from('V1_', 'latin1');
while (quas.size < 6) {
  const i = buf.indexOf(MARK, pos);
  if (i < 0) break;
  const s = buf.subarray(i, Math.min(i + 80, buf.length)).toString('latin1');
  QUA_RE.lastIndex = 0;
  const m = QUA_RE.exec(s);
  if (m) quas.add(m[0]);
  pos = i + 3;
}
console.log('qua 候选 =', [...quas]);
