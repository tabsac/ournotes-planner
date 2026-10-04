/**
 * 真机 CDP 链路探针：把「连不上」拆成三个层次，一次跑完看清楚卡在哪一层。
 *
 *   ① HTTP /json            —— forward 通不通
 *   ② WebSocket 握手        —— devtools 的 upgrade 通不通
 *   ③ WebSocket 上的命令：
 *        Browser.getVersion  —— **浏览器进程**就能答，不需要渲染器
 *        Target.getTargets    —— 同上
 *        Runtime.evaluate    —— 需要**渲染器主线程**执行
 *      如果 ②③Browser 都好、只有 Runtime.evaluate 不应答，那就是页面/渲染器的问题，
 *      跟隧道无关 —— 别再折腾 adb 了。
 *
 *   node cdp_probe.js [超时毫秒]
 */
const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.env.CDP_PORT || 9222);
const TIMEOUT = Number(process.argv[2] || 15000);

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({host: '127.0.0.1', port: PORT, path, agent: false, headers: {Connection: 'close'}}, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({status: res.statusCode, body}));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
  });
}

function upgrade(path) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path, method: 'GET', agent: false,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
      },
    });
    const out = {status: null, headers: null};
    req.on('upgrade', (res, socket) => { out.status = res.statusCode; out.headers = res.headers; socket.destroy(); resolve(out); });
    req.on('response', (res) => { out.status = res.statusCode; res.resume(); resolve(out); });
    req.on('error', (e) => { out.error = `${e.name}: ${e.message}`; resolve(out); });
    req.setTimeout(10000, () => { out.error = 'timeout'; req.destroy(); resolve(out); });
    req.end();
  });
}

(async () => {
  console.log(`== CDP 链路探针 @ 127.0.0.1:${PORT}（单命令超时 ${TIMEOUT}ms）==`);

  // ① /json
  let list;
  try {
    const r = await get('/json');
    list = JSON.parse(r.body);
    console.log(`① GET /json -> ${r.status}，targets=${list.length}`);
  } catch (e) {
    console.log(`① GET /json 失败：${e.message}  —— 隧道/forward 层面的问题`);
    process.exit(1);
  }
  const page = list.find((t) => t.type === 'page' && t.url.includes('ournotes')) || list.find((t) => t.type === 'page');
  if (!page) { console.log('没有 page target'); process.exit(1); }
  console.log(`   page: ${page.url}`);

  // ② 握手
  const up = await upgrade(new URL(page.webSocketDebuggerUrl).pathname);
  console.log(`② 手工 Upgrade -> ${up.status === 101 ? '101 成功' : JSON.stringify(up)}`);

  // ③ 命令
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const call = (method, params = {}) => new Promise((resolve) => {
    const myId = ++id;
    const timer = setTimeout(() => { done({method, 结果: `超时 ${TIMEOUT}ms`}); }, TIMEOUT);
    const onMsg = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id !== myId) return;
      done(m.error ? {method, error: m.error} : {method, result: m.result});
    };
    const done = (v) => { clearTimeout(timer); ws.removeEventListener('message', onMsg); resolve(v); };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({id: myId, method, params}));
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', (e) => reject(new Error(`ws error ${(e && e.message) || ''} inner=${(e && e.error && e.error.message) || e.error}`)));
    setTimeout(() => reject(new Error('握手超时')), 10000);
  }).then(() => console.log('   WebSocket 已连上')).catch((e) => { console.log(`   WebSocket 连不上：${e.message}`); process.exit(1); });

  for (const [method, params] of [
    ['Browser.getVersion', {}],
    ['Target.getTargets', {}],
    ['Runtime.enable', {}],
    ['Runtime.evaluate', {expression: '1+1', returnByValue: true}],
  ]) {
    const r = await call(method, params);
    const brief = r.error ? `错 ${JSON.stringify(r.error)}`
      : r.结果 ? r.结果
      : JSON.stringify(r.result).slice(0, 160);
    console.log(`③ ${method.padEnd(20)} -> ${brief}`);
  }

  // 页面还活着吗：读 DOM（同样需要渲染器）
  console.log(`③ setTimeout 计时器 -> ${JSON.stringify(await call('Runtime.evaluate', {
    expression: 'new Promise(r => { const t0 = performance.now(); setTimeout(() => r(Math.round(performance.now() - t0)), 300); })',
    awaitPromise: true, returnByValue: true,
  })).slice(0, 200)}`);

  try { ws.close(); } catch {}
  process.exit(0);
})().catch((e) => { console.error('PROBE FAILED:', e); process.exit(1); });
