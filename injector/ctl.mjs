import net from 'node:net';
import fs from 'node:fs';

const pid = Number(process.argv[2]);
const arg = process.argv[3];
if (!pid || !arg) { console.error('用法: node ctl.mjs <pid> <json|@file>'); process.exit(1); }
const payload = arg.startsWith('@') ? fs.readFileSync(arg.slice(1), 'utf8') : arg;

const CMD = `\\\\.\\pipe\\frishluna.${pid}.cmd`;
const sock = net.connect(CMD);
let done = false;
function finish(code, msg) {
  if (done) return; done = true;
  if (msg) console.log(msg);
  try { sock.destroy(); } catch {}
  setTimeout(() => process.exit(code), 50);
}
sock.on('connect', () => {
  sock.write(payload, (e) => {
    if (e) return finish(1, '写入失败: ' + e.message);
    finish(0, `已发送 ${payload.length} 字节`);
  });
});
sock.on('error', (e) => finish(1, '连接失败: ' + e.message));
setTimeout(() => finish(2, '超时'), 6000);
