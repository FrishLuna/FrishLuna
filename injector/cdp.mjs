const DEFAULT_TIMEOUT = 8000;

/** 读 http://host:port/json/list，返回主进程 target（没有的话退回第一个） */
export async function listTargets(port, host = '127.0.0.1', timeout = DEFAULT_TIMEOUT) {
  const url = `http://${host}:${port}/json/list`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) throw new Error(`GET ${url} -> HTTP ${r.status}`);
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) throw new Error('/json/list 为空');
    return arr;
  } finally {
    clearTimeout(timer);
  }
}

export async function pickMainTarget(port, host = '127.0.0.1') {
  const list = await listTargets(port, host);
  const main = list.find((t) => t.type === 'node' || !t.type || t.type === 'page') || list[0];
  return main;
}

/**
 * 连上 target，返回 { evaluate, close, target }。
 * evaluate(expr, {awaitPromise=true, returnByValue=true}) -> 结果值
 */
export async function connect(wsUrl, { timeout = 10000 } = {}) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let seq = 0;

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('WebSocket 连接超时: ' + wsUrl)), timeout);
    ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
    ws.addEventListener('error', (e) => { clearTimeout(t); reject(new Error('WebSocket 错误: ' + (e.message || 'unknown'))); }, { once: true });
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message || 'CDP error'} (code ${msg.error.code})`));
      else resolve(msg.result);
    }
  });

  function send(method, params = {}, tmo = 15000) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} 超时`)); }, tmo);
      pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // 打开 Runtime 域
  try { await send('Runtime.enable', {}, 5000); } catch { /* 有些版本不需要显式 enable */ }

  async function evaluate(expr, { awaitPromise = true, returnByValue = true, timeout: tmo = 20000 } = {}) {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      awaitPromise,
      returnByValue,
      allowUnsafeEvalBlockedByCSP: true,
      replMode: true,
      includeCommandLineAPI: true,
    }, tmo);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const txt = d.exception?.description || d.text || 'JS 执行异常';
      throw new Error(txt);
    }
    return r.result?.value;
  }

  return { evaluate, send, close: () => { try { ws.close(); } catch {} }, ws };
}

/** 一步到位：端口 -> 主 target -> 连接 */
export async function attachPort(port, host = '127.0.0.1') {
  const t = await pickMainTarget(port, host);
  const url = t.webSocketDebuggerUrl;
  if (!url) throw new Error('target 没有 webSocketDebuggerUrl: ' + JSON.stringify(t).slice(0, 200));
  const c = await connect(url);
  c.target = t;
  return c;
}
