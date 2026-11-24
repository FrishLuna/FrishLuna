import net from 'node:net';
import { execFileSync } from 'node:child_process';

function findPid() {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='QQ.exe'" | Where-Object { $_.CommandLine -notmatch '--type=' } | Select-Object -ExpandProperty ProcessId`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  const pids = out.split(/\s+/).filter((x) => /^\d+$/.test(x));
  return pids.length ? Number(pids[0]) : 0;
}

const pid = Number(process.argv[2]) || findPid();
const seconds = Number(process.argv[3]) || 15;
const sendCmd = process.argv[4] || '';
if (!pid) { console.error('没找到 QQ 主进程'); process.exit(1); }

const EVT = `\\\\.\\pipe\\frishluna.${pid}.evt`;
const CMD = `\\\\.\\pipe\\frishluna.${pid}.cmd`;
console.log(`evt: ${EVT}`);

let n = 0;
const evt = net.connect(EVT);
let buf = Buffer.alloc(0);

evt.on('connect', () => {
  console.log('evt 已连接，等帧…');
  const cmd = net.connect(CMD);
  cmd.on('connect', () => {
    console.log('cmd 已连接');
    cmd.resume();
    setTimeout(() => cmd.write('{"cmd":"ping"}', (e) => { if (e) console.error('ping 写失败:', e.message); }), 200);
    if (sendCmd) setTimeout(() => cmd.write(sendCmd, (e) => { if (e) console.error('cmd 写失败:', e.message); }), 500);
  });
  cmd.on('data', () => {});
  cmd.on('close', () => console.log('cmd 已关闭'));
  cmd.on('error', (e) => console.error('cmd 错误:', e.message));
  globalThis.__cmd = cmd;
});

evt.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (len > 8 * 1024 * 1024) { console.error('长度异常', len); process.exit(3); }
    if (buf.length < 4 + len) break;
    const json = buf.subarray(4, 4 + len).toString('utf8');
    buf = buf.subarray(4 + len);
    n += 1;
    let tag = '?';
    try { tag = JSON.parse(json).evt || '?'; } catch { tag = 'BADJSON'; }
    const shown = json.length > 1500 ? json.slice(0, 1500) + '…' : json;
    console.log(`\n#${n} [${tag}] ${shown}`);
  }
});

evt.on('error', (e) => { console.error('evt 错误:', e.message); process.exit(2); });
evt.on('close', () => { console.log(`\n连接关闭，共 ${n} 帧`); process.exit(0); });

setTimeout(() => {
  console.log(`\n[超时 ${seconds}s] 共收到 ${n} 帧`);
  try { globalThis.__cmd && globalThis.__cmd.end(); } catch {}
  evt.end();
  setTimeout(() => process.exit(0), 200);
}, seconds * 1000);
