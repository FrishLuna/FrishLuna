import { execFileSync } from 'node:child_process';
import { attachPort, listTargets, connect } from './cdp.mjs';

const DEFAULT_PORT = 9229;

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

/** 找 QQ 主进程：命令行不含 --type=，且是 QQ.exe */
function findQQMainPid() {
  const ps = [
    '-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='QQ.exe'" | Where-Object { $_.CommandLine -notmatch '--type=' } | Select-Object -ExpandProperty ProcessId`,
  ];
  const out = execFileSync('powershell.exe', ps, { encoding: 'utf8' }).trim();
  const pids = out.split(/\s+/).filter(Boolean).map(Number).filter((n) => n > 0);
  return pids;
}

async function waitInspector(port, tries = 30, gapMs = 400) {
  for (let i = 0; i < tries; i++) {
    try {
      const list = await listTargets(port, '127.0.0.1', 1500);
      if (list.length) return list;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, gapMs));
  }
  return null;
}

async function main() {
  const jsonOut = !!arg('json');
  const wantProbe = !!arg('probe');
  const exprArg = arg('expr');
  const port = Number(arg('port', DEFAULT_PORT));

  let pid = Number(arg('pid', 0));
  if (!pid) {
    const pids = findQQMainPid();
    if (!pids.length) {
      console.error('❌ 没找到运行中的 QQ 主进程（QQ.exe 且命令行不含 --type=）');
      process.exit(2);
    }
    pid = pids[0];
  }
  console.log(`目标 QQ 主进程 PID = ${pid}`);

  // 1) 已经在监听就复用，否则用 _debugProcess 现场开
  let list = null;
  try { list = await listTargets(port, '127.0.0.1', 1200); } catch { list = null; }

  if (list) {
    console.log(`端口 ${port} 上已有 inspector，直接复用`);
  } else {
    if (typeof process._debugProcess !== 'function') {
      console.error('❌ 本机 Node 没有 process._debugProcess，无法动态注入');
      process.exit(3);
    }
    console.log(`调用 process._debugProcess(${pid}) 开 inspector…`);
    process._debugProcess(pid);
    list = await waitInspector(port);
    if (!list) {
      console.error('❌ 调用了 _debugProcess 但 9229 没起来。可能 QQ 禁用了 inspector。');
      process.exit(4);
    }
    console.log(`✅ inspector 已开，targets=${list.length}`);
  }

  // 2) 连上去，跑一段 boot 代码：确认环境 + 找 wrapper.node
  const target = list.find((t) => (t.title || '').includes(String(pid))) || list[0];
  if (!target?.webSocketDebuggerUrl) {
    console.error('❌ target 没有 webSocketDebuggerUrl:', JSON.stringify(list[0]).slice(0, 300));
    process.exit(5);
  }
  const c = await connect(target.webSocketDebuggerUrl);

  const boot = `
  (() => {
    const out = {
      pid: process.pid,
      node: process.version,
      electron: process.versions.electron || null,
      chrome: process.versions.chrome || null,
      arch: process.arch,
      type: process.type || null,
      mainModule: (process.mainModule && process.mainModule.filename) || null,
      argv: process.argv.slice(0, 8),
      moduleCacheCount: 0,
      wrapperInCache: [],
      addons: [],
    };
    try {
      const M = globalThis.require ? require('module') : null;
      const cache = (M && M._cache) ? M._cache : {};
      const keys = Object.keys(cache);
      out.moduleCacheCount = keys.length;
      for (const k of keys) {
        if (/\\.node$/i.test(k)) out.addons.push(k);
        if (/wrapper\\.node$/i.test(k)) out.wrapperInCache.push(k);
      }
      out.addons = out.addons.slice(0, 30);
    } catch (e) {
      out.cacheError = String(e && e.message || e);
    }
    return JSON.stringify(out);
  })()
  `;

  const raw = await c.evaluate(boot);
  let info;
  try { info = JSON.parse(raw); } catch { info = { parseError: String(raw).slice(0, 500) }; }

  if (jsonOut) {
    console.log(JSON.stringify(info, null, 2));
  } else {
    console.log('\n=== QQ 主进程环境 ===');
    console.log('pid        :', info.pid);
    console.log('node       :', info.node);
    console.log('electron   :', info.electron);
    console.log('chrome     :', info.chrome);
    console.log('arch       :', info.arch);
    console.log('process.type:', info.type);
    console.log('mainModule :', info.mainModule);
    console.log('argv       :', (info.argv || []).join(' '));
    console.log('模块缓存数 :', info.moduleCacheCount);
    console.log('\n=== 已加载原生模块 (.node) ===');
    if (!info.addons || !info.addons.length) console.log('  (缓存里没有 .node，可能用 process.dlopen 直接加载)');
    else for (const a of info.addons) console.log('  ' + a);
    console.log('\n=== wrapper.node 在缓存中 ===');
    console.log(info.wrapperInCache?.length ? info.wrapperInCache.join('\n') : '  未找到');
    if (info.cacheError) console.log('\ncache 读取异常:', info.cacheError);
  }

  // 3) 自定义表达式
  if (typeof exprArg === 'string') {
    const v = await c.evaluate(exprArg);
    console.log('\n=== expr 结果 ===');
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  }

  c.close();
  console.log('\n已完成（注入点已分离，QQ 继续正常运行）');
}

main().catch((e) => {
  console.error('❌ 注入失败:', e.message);
  process.exit(1);
});
