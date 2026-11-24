import { spawn } from 'child_process';

const child = spawn(process.execPath, ['-e', "globalThis.__x='nofix'; setInterval(()=>{},1000)"], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
console.log('目标 child pid =', child.pid);
console.log('本进程有 process._debugProcess :', typeof process._debugProcess);

let opened = false;
try {
  process._debugProcess(child.pid);
  console.log('已调用 _debugProcess');
} catch (e) {
  console.log('❌ 调用异常:', e.message);
}

for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 500));
  try {
    const r = await fetch('http://127.0.0.1:9229/json/list');
    const j = await r.json();
    console.log(`✅ 第 ${i * 0.5}s: inspector 起来了，targets=${j.length}`, j.map((t) => t.title || t.url).join(','));
    opened = true;
    break;
  } catch {
    if (i === 19) console.log('❌ 20 次轮询后 9229 仍无响应');
  }
}

try { child.kill(); } catch {}
console.log(opened ? '\n结论：可以不重启目标进程直接开 inspector' : '\n结论：_debugProcess 这条路不通');
process.exit(opened ? 0 : 1);
