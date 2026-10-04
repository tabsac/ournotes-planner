/**
 * WebSocket 握手探针：/json 通了但 WS 连不上时，用它看**服务端到底回了什么**。
 * Node 内置 WebSocket 出错时给的信息很少（"ws error" + 空 message），
 * 所以这里手工发一次 Upgrade 请求，把 HTTP 状态行和响应头原样打出来。
 *
 *   node ws_probe.js
 */
const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.env.CDP_PORT || 9222);

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

// 手工握手：能拿到状态行 / 响应头，内置 WebSocket 失败时这些信息全丢了
function upgrade(path, extraHeaders = {}) {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: '127.0.0.1', port: PORT, path, method: 'GET', agent: false,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key,
        ...extraHeaders,
      },
    });
    const outcome = {event: null, status: null, headers: null, body: '', error: null};
    req.on('upgrade', (res, socket) => {
      outcome.event = 'upgrade(101)';
      outcome.status = res.statusCode;
      outcome.headers = res.headers;
      socket.destroy();
      resolve(outcome);
    });
    req.on('response', (res) => {
      outcome.event = 'response(非 101 —— 被拒了)';
      outcome.status = res.statusCode;
      outcome.headers = res.headers;
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { outcome.body = body.slice(0, 400); resolve(outcome); });
    });
    req.on('error', (e) => { outcome.event = 'error'; outcome.error = `${e.name}: ${e.message}`; resolve(outcome); });
    req.setTimeout(10000, () => { outcome.event = 'timeout'; req.destroy(); resolve(outcome); });
    req.end();
  });
}

(async () => {
  console.log(`== devtools @ 127.0.0.1:${PORT} ==`);
  let list;
  try { list = JSON.parse((await get('/json')).body); }
  catch (e) { console.log('GET /json 失败：', e.message); process.exit(1); }

  const pages = list.filter((t) => t.type === 'page');
  console.log(`page targets: ${pages.length}`);
  for (const page of pages) console.log(`  id=${page.id}  url=${page.url}\n     ws=${page.webSocketDebuggerUrl}`);

  if (!pages.length) { console.log('没有 page target'); process.exit(1); }

  const target = pages[0];
  const rawPath = new URL(target.webSocketDebuggerUrl).pathname;
  console.log(`\n-- 手工 Upgrade ${rawPath} （Host: 127.0.0.1:${PORT}）--`);
  console.log(JSON.stringify(await upgrade(rawPath), null, 2));

  console.log(`\n-- 手工 Upgrade ${rawPath} （Host: localhost:${PORT}）--`);
  console.log(JSON.stringify(await upgrade(rawPath, {Host: `localhost:${PORT}`}), null, 2));

  console.log('\n-- Node 内置 WebSocket --');
  await new Promise((resolve) => {
    let ws;
    try { ws = new WebSocket(target.webSocketDebuggerUrl); }
    catch (e) { console.log('构造失败:', e.name, e.message); return resolve(); }
    ws.onopen = () => { console.log('open ok'); ws.close(); resolve(); };
    ws.onerror = (e) => {
      console.log(`error: type=${e.type} message=${JSON.stringify(e.message)}`);
      console.log(`  e.error = ${e.error && e.error.name}: ${e.error && e.error.message}`);
      console.log(`  stack = ${(e.error && e.error.stack || '').split('\n').slice(0, 6).join(' | ')}`);
      resolve();
    };
    setTimeout(() => { console.log('（8 秒还没结果）'); resolve(); }, 8000);
  });
  process.exit(0);
})().catch((e) => { console.error('PROBE FAILED:', e); process.exit(1); });
