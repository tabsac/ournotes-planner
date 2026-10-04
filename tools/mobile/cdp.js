/**
 * 通过 adb forward 出来的 WebView devtools 端口，用裸 CDP 直接跟云手机上的页面说话。
 * （WebView 不支持 Browser 级上下文管理，所以 Playwright 的 connectOverCDP 用不了，
 *   这里直接连 page target 的 WebSocket。）
 *
 *   node on_cards/phone_verify/cdp.js dump             # 页面状态摘要
 *   node on_cards/phone_verify/cdp.js eval "<js>"      # 求值（支持 await）
 *   node on_cards/phone_verify/cdp.js listen <秒>      # 实时收集 console / 异常
 *   node on_cards/phone_verify/cdp.js reload
 *
 * 前提：adb -s <serial> forward tcp:9222 localabstract:webview_devtools_remote_<pid>
 */
const http = require('node:http');

const PORT = Number(process.env.CDP_PORT || 9222);
const mode = process.argv[2] || 'dump';
const arg = process.argv.slice(3).join(' ');

// WebView 的 devtools HTTP 端点很脆：空闲连接/刚建立的 forward 上经常直接
// 「socket hang up」（连接被对端掐掉、不给响应）。多试几次就好，别当成失败。
function targetsOnce() {
  return new Promise((resolve, reject) => {
    const req = http.get({host: '127.0.0.1', port: PORT, path: '/json', agent: false,
      headers: {Connection: 'close'}}, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
  });
}

async function targets(tries = 8) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try { return await targetsOnce(); } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error(`/json 连续 ${tries} 次无响应: ${last && last.message}`);
}

class CDP {
  constructor(url) {
    this.url = url; this.id = 0; this.pending = new Map(); this.handlers = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error('ws error: ' + (e.message || 'unknown')));
      this.ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id && this.pending.has(msg.id)) {
          const {resolve: done, reject: fail} = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? fail(new Error(JSON.stringify(msg.error))) : done(msg.result);
          return;
        }
        this.handlers.forEach((h) => h(msg));
      };
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      this.ws.send(JSON.stringify({id, method, params}));
    });
  }
  on(fn) { this.handlers.push(fn); }
  close() { try { this.ws.close(); } catch {} }
}

const summary = `
(() => {
  const t = id => { const el = document.getElementById(id); return el ? (el.textContent || '').trim().slice(0, 400) : null; };
  const panel = document.getElementById('probePanel');
  return {
    title: document.title,
    href: location.href,
    visible: document.visibilityState,
    isolated: window.crossOriginIsolated,
    sab: typeof SharedArrayBuffer,
    name: document.getElementById('name')?.value ?? null,
    ownedCount: t('ownedCount'),
    message: t('message'),
    loadError: document.getElementById('loadError')?.hidden === false ? t('loadError') : null,
    resultsHidden: document.getElementById('results')?.hidden ?? null,
    progressTitle: t('progressTitle'),
    progressCount: t('progressCount'),
    cancelDisabled: document.getElementById('cancel')?.disabled ?? null,
    probeTail: panel ? panel.textContent.split('\\n').slice(-8) : null,
  };
})()`;

(async () => {
  const list = await targets();
  const filter = process.env.CDP_URL_FILTER || 'ournotes';
  const page = list.find((t) => t.type === 'page' && t.url.includes(filter))
    || list.find((t) => t.type === 'page');
  if (!page) throw new Error('没找到 page target');
  console.log('# targets:', list.filter((t) => t.type === 'page').map((t) => t.url).join(' , '));
  console.log('# target:', page.url, '\n');

  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');

  if (mode === 'eval') {
    const r = await cdp.send('Runtime.evaluate', {expression: arg, awaitPromise: true, returnByValue: true});
    console.log(JSON.stringify(r.result?.value ?? r, null, 2));
  } else if (mode === 'dump') {
    // 先看主线程是否还能跑：能跑通说明没死锁
    const t0 = Date.now();
    const r = await cdp.send('Runtime.evaluate', {expression: summary, returnByValue: true});
    console.log(`# evaluate rtt ${Date.now() - t0} ms`);
    console.log(JSON.stringify(r.result?.value ?? r, null, 2));
    const timers = await cdp.send('Runtime.evaluate', {
      expression: 'new Promise(r => { const t0 = performance.now(); setTimeout(() => r(Math.round(performance.now() - t0)), 500); })',
      awaitPromise: true, returnByValue: true});
    console.log('# setTimeout(500) fired after', timers.result?.value, 'ms');
  } else if (mode === 'listen') {
    const seconds = Number(arg) || 20;
    cdp.on((msg) => {
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
        console.log(`[console.${msg.params.type}]`, String(text).slice(0, 500));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        console.log('[exception]', (d.exception?.description || d.text || '').slice(0, 800));
      }
      if (msg.method === 'Log.entryAdded') {
        console.log(`[log.${msg.params.entry.level}]`, String(msg.params.entry.text).slice(0, 500));
      }
    });
    await cdp.send('Log.enable');
    console.log(`# listening ${seconds}s ...`);
    await new Promise((r) => setTimeout(r, seconds * 1000));
  } else if (mode === 'reload') {
    await cdp.send('Page.enable');
    await cdp.send('Page.reload', {ignoreCache: true});
    console.log('reloaded');
  } else {
    throw new Error('未知模式：' + mode);
  }
  cdp.close();
})().catch((error) => { console.error('FAILED:', error.message); process.exit(1); });
