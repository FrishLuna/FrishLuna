import net from 'node:net';
import fs from 'node:fs';

const pid = process.argv[2];
const file = process.argv[3];
const seconds = Number(process.argv[4] || 6);
if (!pid || !file) { console.error('用法: node send.mjs <pid> <json文件> [秒数]'); process.exit(1); }

const cmdText = fs.readFileSync(file, 'utf8').trim();
const EVT = `\\\\.\\pipe\\frishluna.${pid}.evt`;
const CMD = `\\\\.\\pipe\\frishluna.${pid}.cmd`;

let buf = Buffer.alloc(0);
const evt = net.connect(EVT);
evt.on('connect', () => {
  const cmd = net.connect(CMD);
  cmd.on('connect', () => {
    cmd.resume();
    cmd.write(cmdText, (e) => { if (e) console.error('写入失败:', e.message); });
  });
  cmd.on('data', () => {});
  cmd.on('error', (e) => console.error('cmd:', e.message));
});
evt.on('data', (c) => {
  buf = Buffer.concat([buf, c]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const s = buf.subarray(4, 4 + len).toString('utf8');
    buf = buf.subarray(4 + len);
    let tag = '?';
    try { tag = JSON.parse(s).evt || '?'; } catch { tag = 'BAD'; }
    if (/^(hb)$/.test(tag)) continue;
    console.log(`[${tag}] ${s.length > 20000 ? s.slice(0, 20000) + '…' : s}`);
  }
});
evt.on('error', (e) => { console.error('evt:', e.message); process.exit(2); });
setTimeout(() => { evt.end(); setTimeout(() => process.exit(0), 150); }, seconds * 1000);
