/**
 * 在云手机的 WebView 上，用 CDP 完整驱动一次「导入 → 计算 → 出结果」，
 * 并把**页面和所有 Worker 的 console / 异常**实时打出来。
 *
 *   node on_cards/phone_verify/watch.js <fixture 名> [最长分钟数]
 *
 * 前提：adb -s <serial> forward tcp:9222 localabstract:webview_devtools_remote_<pid>
 *
 * ⚠️ 云手机的 adb 会**周期性掉线**（"device offline"），一掉线 forward 就全没了，
 *    挂在它上面的 WebSocket 也跟着断。所以这个脚本不持有「一条长命的求值」：
 *      * 读状态（页面的 DOM）在**主机侧轮询**，断了就重连接着轮；
 *      * 真正有副作用的动作（导入、点计算）才发一次，发完靠轮询确认结果；
 *      * /json 与 WebSocket 都带耐心重试。
 *    页面里的计算进程本来就不依赖这条 WS，所以断线不会毁掉这一轮求解。
 */
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const PORT = Number(process.env.CDP_PORT || 9222);
const FIXTURE = process.argv[2] || 'solver-ap';
const MAX_MINUTES = Number(process.argv[3] || 20);
const APP_URL = process.env.WATCH_URL || 'http://localhost:8899/ournotes-planner/';
const FLAG_KEY = 'ournotes-isolation-reload:' + new URL(APP_URL).pathname;
// 仓库根目录（本文件在 tools/mobile/ 下）
const REPO = path.resolve(__dirname, '..', '..');
// 产出的结果 / 进度轨迹都写到这里（work/ 已在 .gitignore 里），可用 MOBILE_OUT_DIR 覆盖
const OUT_DIR = process.env.MOBILE_OUT_DIR || path.join(REPO, 'work', 'mobile');
const OUT = path.join(OUT_DIR, 'watch-' + FIXTURE + '.jsonl');

const stamp = () => new Date().toISOString().slice(11, 23);
const log = (line) => console.log(`[${stamp()}] ${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- devtools HTTP
// WebView 的 devtools HTTP 端点很脆：刚建好的 forward 上经常直接 socket hang up，
// 云手机掉线重连期间还会 ECONNREFUSED。多试几次（默认约 2 分钟），别当成失败。
function targetsOnce() {
  return new Promise((resolve, reject) => {
    const req = http.get({host: '127.0.0.1', port: PORT, path: '/json', agent: false,
      headers: {Connection: 'close'}}, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
  });
}

async function targets(tries = 60, gapMs = 2500) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try { return await targetsOnce(); } catch (e) {
      last = e;
      if (i % 8 === 0) log(`  /json 还没通（第 ${i} 次）：${e.message}`);
      await sleep(gapMs);
    }
  }
  throw new Error(`/json 连续 ${tries} 次无响应: ${last && last.message}`);
}

// devtools 回的 webSocketDebuggerUrl 通常已经指向我们 forward 的那个端口，
// **优先原样用**（实测改写 host 会被服务端拒掉）。改写只作为兜底候选。
function wsCandidates(page) {
  const out = [];
  if (page.webSocketDebuggerUrl) out.push(page.webSocketDebuggerUrl);
  try {
    const u = new URL(page.webSocketDebuggerUrl);
    u.host = `127.0.0.1:${PORT}`;
    if (!out.includes(u.toString())) out.push(u.toString());
  } catch {}
  return out;
}

class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.handlers = []; this.dead = false; }
  connect() {
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(this.url); }
      catch (e) { reject(new Error(`WebSocket() 构造失败 ${this.url}: ${e.message}`)); return; }
      this.ws = ws;
      const fail = (why) => {
        this.dead = true;
        for (const {reject: bad} of this.pending.values()) bad(new Error('ws closed: ' + why));
        this.pending.clear();
        reject(new Error(`ws ${why} on ${this.url}`));
      };
      ws.onopen = () => resolve();
      ws.onerror = (e) => fail(`error type=${e && e.type} msg=${(e && e.message) || '(空)'}` +
        ` inner=${(e && e.error && (e.error.message || e.error)) || '(无)'}`);
      ws.onclose = (e) => { this.dead = true; if (this.oncloseHook) this.oncloseHook(e); };
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id && this.pending.has(msg.id)) {
          const {resolve: done, reject: bad} = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? bad(new Error(JSON.stringify(msg.error))) : done(msg.result);
          return;
        }
        this.handlers.forEach((h) => h(msg));
      };
    });
  }
  send(method, params = {}, sessionId, timeoutMs = 30000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      if (this.dead) { reject(new Error('ws already closed')); return; }
      // 必须带超时：应用 boot 时主线程可能在忙，Runtime.evaluate 会**一直不返回**，
      // 没有超时的话轮询循环就静默卡死在一次求值上（实测卡了好几分钟，日志一片空白）。
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时 ${timeoutMs}ms`));
      }, timeoutMs);
      const settle = (fn) => (value) => { clearTimeout(timer); fn(value); };
      this.pending.set(id, {resolve: settle(resolve), reject: settle(reject)});
      try { this.ws.send(JSON.stringify(sessionId ? {id, method, params, sessionId} : {id, method, params})); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  on(fn) { this.handlers.push(fn); }
  close() { try { this.ws.close(); } catch {} }
}

// ---------------------------------------------------------------- 连接 / 重连
const sessionNames = new Map();
const describe = (sessionId) => sessionNames.get(sessionId) || 'page';
let live = false;

function onEvent(msg) {
  if (msg.method === 'Target.attachedToTarget') {
    const {sessionId, targetInfo} = msg.params;
    sessionNames.set(sessionId, `worker:${(targetInfo.url || '').split('/').pop()}`);
    if (live) log(`# attached ${targetInfo.type} ${targetInfo.url}`);
    return;
  }
  if (!live) return;
  if (msg.method === 'Runtime.consoleAPICalled') {
    const args = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
    log(`[${describe(msg.sessionId)} console.${msg.params.type}] ${String(args).slice(0, 600)}`);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    log(`[${describe(msg.sessionId)} EXCEPTION] ${(d.exception?.description || d.text || '').slice(0, 1200)}`);
    return;
  }
  if (msg.method === 'Log.entryAdded') {
    log(`[${describe(msg.sessionId)} log.${msg.params.entry.level}] ${String(msg.params.entry.text).slice(0, 600)}`);
  }
}

let cdp = null;
let appPath = new URL(APP_URL).pathname;

function pagesOf(list) {
  const matching = list.filter((t) => t.type === 'page' && t.url.includes(appPath) && !t.url.includes('/_pt/'));
  if (matching.length) return matching;
  const any = list.find((t) => t.type === 'page');
  return any ? [any] : [];
}

// 连上（必要时重连）。target 会变（页面导航、浏览器弹窗被点掉都可能让旧 target 作废），
// 所以每一轮都**重新列 targets**；每个候选 URL 也重试几次：/json 能答 ≠ WebSocket 能连。
async function attach() {
  let last;
  for (let round = 1; round <= 6; round++) {
    const list = await targets();
    const pages = pagesOf(list);
    if (pages.length) {
      for (const page of pages) {
        for (const url of wsCandidates(page)) {
          for (let attempt = 1; attempt <= 2; attempt++) {
            const candidate = new CDP(url);
            try {
              await candidate.connect();
              log(`cdp connected: ${url} (${page.url})`);
              candidate.on(onEvent);
              await candidate.send('Runtime.enable');
              await candidate.send('Log.enable');
              await candidate.send('Page.enable');
              await candidate.send('Target.setAutoAttach', {autoAttach: true, waitForDebuggerOnStart: false, flatten: true});
              cdp = candidate;
              return cdp;
            } catch (e) {
              last = e;
              candidate.close();
              await sleep(1500);
            }
          }
        }
      }
    }
    log(`attach 第 ${round} 轮没成功（${last && last.message}），重新列 targets …`);
    await sleep(2500);
  }
  throw new Error('连不上 devtools WebSocket —— ' + (last && last.message));
}

async function reattach(why) {
  log(`re-attaching (${why}) ...`);
  if (cdp) cdp.close();
  cdp = null;
  await sleep(1500);
  return attach();
}

// 只读求值：断了就重连再读（读是幂等的，重试安全）
async function read(expression, awaitPromise = false, tries = 4) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      if (!cdp || cdp.dead) await attach();
      const r = await cdp.send('Runtime.evaluate', {expression, awaitPromise, returnByValue: true});
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result?.value;
    } catch (e) {
      last = e;
      await reattach(e.message).catch(() => {});
      await sleep(2000);
    }
  }
  throw new Error(`读页面状态失败：${last && last.message}`);
}

// 有副作用的动作：只发一次，不重试（重试可能点两次「计算」）
async function act(expression, awaitPromise = false) {
  if (!cdp || cdp.dead) await attach();
  const r = await cdp.send('Runtime.evaluate', {expression, awaitPromise, returnByValue: true});
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}

// ---------------------------------------------------------------- 主流程
const STATE = `(() => { const $ = id => document.getElementById(id);
  return { title: ($('progressTitle')?.textContent || '').trim(),
           count: ($('progressCount')?.textContent || '').trim(),
           done: $('results') ? !$('results').hidden : false,
           msg: ($('message')?.textContent || '').trim(),
           error: !!($('message') && $('message').classList.contains('error')),
           booted: !!(($('name') && $('name').value !== '') ||
                      /^\\s*\\d+\\s*\\+\\s*\\d+\\s*\$/.test($('ownedCount')?.textContent || '')),
           loadError: $('loadError') && !$('loadError').hidden ? $('loadError').textContent : null }; })()`;

const trace = [];           // 主机侧采样，落盘成 watch-<fixture>.jsonl
function record(state, when = Date.now()) {
  const line = state.title + ' || ' + state.count;
  if (!trace.length || trace[trace.length - 1][1] !== line) trace.push([when, line]);
}

// reload 页面（顺便置上 sessionStorage 标记：手机浏览器拿不到跨源隔离，
// Service Worker 那套「注册→刷新」既没用又可能一直等 controllerchange 卡住）
async function reloadPage() {
  await attach();
  await act("try { sessionStorage.setItem('" + FLAG_KEY + "', '1'); } catch (e) {} 'ok'").catch(() => {});
  await cdp.send('Page.navigate', {url: APP_URL}).catch(() => {});
  await sleep(800);
  live = true;
  await cdp.send('Page.reload', {ignoreCache: true}).catch(() => {});
  cdp.close();
  cdp = null;   // reload 之后旧的 page target 就没了，必须重新列 targets
}

// 等 boot。**关键**：云手机掉线时 reverse 隧道也会一起断，
// 页面自己去取 wasm/资源就会 "Failed to fetch"，页面直接停在「网页未能加载」且永远不会自己好。
// 所以这里一旦发现加载失败/超时，就整页重来（隧道由主机侧 watchdog 补回来了）。
async function bootOnce(budgetMs) {
  const deadline = Date.now() + budgetMs;
  let last = null;
  let lastLogAt = 0;
  for (;;) {
    let state = null;
    try { state = await read(STATE, false, 2); }
    catch (e) { state = null; }
    if (state) {
      last = state;
      if (state.loadError) return {ok: false, why: '页面报错：' + state.loadError};
      if (/未能加载|Failed to fetch|加载失败/.test(String(state.msg || ''))) {
        return {ok: false, why: '资源加载失败：' + state.msg};
      }
      if (state.booted) return {ok: true, state};
    }
    // 每 20 秒报一次当前状态：不然 boot 期间的日志一片空白，看不出卡在哪一步
    if (Date.now() - lastLogAt > 20000) {
      lastLogAt = Date.now();
      log('  booting… ' + (state ? JSON.stringify(state) : '(读不到状态)'));
    }
    if (Date.now() > deadline) return {ok: false, why: 'boot 超时，最后状态 ' + JSON.stringify(last)};
    await sleep(1500);
  }
}

(async () => {
  let bootedState = null;
  for (let attempt = 1; attempt <= 4 && !bootedState; attempt++) {
    if (process.env.WATCH_NO_RELOAD) { await attach(); live = true; }
    else { log(`reloading page (ignoreCache) … 第 ${attempt} 次`); await reloadPage(); }
    const outcome = await bootOnce(attempt === 1 ? 5 * 60 * 1000 : 6 * 60 * 1000);
    if (outcome.ok) { bootedState = outcome.state; break; }
    log(`boot 失败（第 ${attempt} 次）：${outcome.why}`);
    await sleep(6000);
  }
  if (!bootedState) throw new Error('应用 boot 不成功（已重试 4 次）');
  await sleep(1500);
  log('booted');
  live = true;
  log('env: ' + JSON.stringify(await read(
    `({isolated: crossOriginIsolated, sab: typeof SharedArrayBuffer, secure: isSecureContext,
       sw: !!navigator.serviceWorker?.controller, locks: !!navigator.locks, ua: navigator.userAgent})`)));

  // ---- 导入：动作发一次，然后靠轮询确认（导入本身是页面的事，不受断线影响）----
  const fixture = JSON.parse(fs.readFileSync(path.join(REPO, 'browser', 'work', 'fixtures', `${FIXTURE}.json`), 'utf8'));
  const requestText = JSON.stringify(fixture.request);
  const before = await read("document.getElementById('ownedCount').textContent");
  await act(`(() => {
    const input = document.getElementById('import'), dt = new DataTransfer();
    dt.items.add(new File([${JSON.stringify(requestText)}], 'request.json', {type: 'application/json'}));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', {bubbles: true}));
    return input.files.length; })()`);
  let imported = null;
  for (let i = 0; i < 40; i++) {
    const state = await read(STATE);
    if (String(state.msg).includes('已导入')) { imported = state; break; }
    if (state.error) throw new Error('导入报错：' + state.msg);
    await sleep(800);
  }
  log(`import: before=${JSON.stringify(before)} after=${JSON.stringify(imported && imported.msg)}`);
  if (!imported) throw new Error('导入没生效（40 次轮询都没等到「已导入」）');

  // ---- 计算：点一次，然后**主机侧**轮询（断线重连也能接着等）----
  await act("document.getElementById('calculate').click(); 'clicked'");
  log('calculate clicked，开始轮询进度 …');
  const deadline = Date.now() + MAX_MINUTES * 60 * 1000;
  let final = null;
  let lastLog = 0;
  while (Date.now() < deadline) {
    await sleep(2000);
    let state;
    try { state = await read(STATE, false, 2); }
    catch (e) { log('  (轮询失败，继续等) ' + e.message); continue; }
    record(state);
    if (Date.now() - lastLog > 30000) {
      lastLog = Date.now();
      log(`  ${state.title} || ${state.count}`);
    }
    if (state.done) { final = {done: true, title: state.title, count: state.count}; break; }
    if (state.error) { final = {done: false, error: state.msg, title: state.title, count: state.count}; break; }
  }
  if (!final) final = {done: false, timeout: true};
  log('final: ' + JSON.stringify(final));

  // ---- 取结果（导出按钮会把 {schema_version, actual_inputs, result} 交出去）----
  if (final.done) {
    const payload = await read(`(async () => {
      const blob = await new Promise(resolve => {
        const original = URL.createObjectURL;
        URL.createObjectURL = b => { URL.createObjectURL = original; resolve(b); return original.call(URL, b); };
        document.getElementById('exportResult').click();
      });
      return await blob.text();
    })()`, true, 6);
    fs.mkdirSync(OUT_DIR, {recursive: true});
    fs.writeFileSync(path.join(OUT_DIR, `result-${FIXTURE}.json`), payload);
    log(`saved result-${FIXTURE}.json (${payload.length} bytes)`);
    const parsed = JSON.parse(payload);
    log('algorithm: ' + (parsed.result?.search?.algorithm ?? null)
      + '  optimality_proven: ' + (parsed.result?.search?.optimality_proven ?? null));
  }

  // 页面侧还留了一份「变化才记」的更细轨迹，能取到就并进来
  const pageLines = await read('window.__watchLines || []', false, 2).catch(() => []);
  const merged = trace.concat(Array.isArray(pageLines) ? pageLines : [])
    .sort((a, b) => a[0] - b[0]);
  fs.writeFileSync(OUT, merged.map((l) => JSON.stringify(l)).join('\n'));
  log(`progress trace -> ${path.basename(OUT)} (host ${trace.length} + page ${(pageLines || []).length})`);
  if (cdp) cdp.close();
  process.exit(final.done ? 0 : 1);
})().catch((error) => { console.error('FAILED:', error.message); process.exit(1); });
