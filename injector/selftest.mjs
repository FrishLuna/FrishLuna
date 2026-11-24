import { attachPort } from './cdp.mjs';

const PORT = Number(process.argv[2] || 9333);

const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
};

try {
  const c = await attachPort(PORT);
  console.log('已连接:', c.target.title || c.target.url || '(no title)');

  const v1 = await c.evaluate('globalThis.__probe');
  ok('读到目标进程的全局变量', v1 === 'hello-from-target', `实际=${JSON.stringify(v1)}`);

  const v2 = await c.evaluate('globalThis.__add(3,4)');
  ok('调用目标进程里的函数', v2 === 7, `实际=${v2}`);

  const v3 = await c.evaluate('process.version');
  ok('访问 process 对象', typeof v3 === 'string' && v3.startsWith('v'), `实际=${v3}`);

  const v4 = await c.evaluate('process.pid');
  ok('拿到目标进程 PID', typeof v4 === 'number', `pid=${v4}`);

  const v5 = await c.evaluate(`JSON.stringify(Object.keys(process.versions))`);
  ok('读 versions（看是否 electron）', typeof v5 === 'string', v5);

  const v6 = await c.evaluate(`
    (() => {
      const M = require('module');
      return JSON.stringify({
        hasModule: !!M,
        cacheCount: Object.keys(M._cache || {}).length,
      });
    })()
  `);
  ok('目标进程里能 require("module") 并读 _cache', typeof v6 === 'string', v6);

  const v7 = await c.evaluate(`
    (() => {
      const M = require('module');
      const keys = Object.keys(M._cache || {});
      return JSON.stringify(keys.slice(0, 5));
    })()
  `);
  ok('能列出已加载模块', typeof v7 === 'string', v7);

  c.close();
  console.log('\n全部检查完成');
} catch (e) {
  console.error('❌ 失败:', e.message);
  process.exitCode = 1;
}
