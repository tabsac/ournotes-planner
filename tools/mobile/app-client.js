/**
 * 真机（云手机 WebView）CDP 客户端 —— `watch.js` / `cancel_test.js` / `download_test.js` 共用。
 *
 * 这里装的是**踩过坑之后**才长成这样的那部分逻辑，改之前先读 `README.md` 的「踩过的坑」：
 *
 *   * `/json` 与 WebSocket 都要耐心重试（刚建好的 forward 上经常直接 hang up，掉线期间 ECONNREFUSED）；
 *   * 每条 CDP 命令都要带**超时**：应用 boot 时主线程可能在忙，`Runtime.evaluate` 会一直不返回，
 *     没有超时的话调用方的轮询循环就静默卡死在一次求值上（实测卡了好几分钟，日志一片空白）；
 *   * 「读状态」会重连重试（读是幂等的），「有副作用的动作」只发一次（重试可能点两次「计算」）；
 *   * 页面 reload 之后旧 target 就没了，必须重新列 targets；
 *   * 同一台手机上**可能同时存在两个同 URL 的 page target**（上一轮就栽在这），
 *     所以选 target 不能「取第一个」—— 见 `pickPage()`。
 */
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

// 仓库根目录（本文件在 tools/mobile/ 下）
const REPO = path.resolve(__dirname, '..', '..');
// 产出的结果 / 进度轨迹都写到这里（work/ 已在 .gitignore 里），可用 MOBILE_OUT_DIR 覆盖
const OUT_DIR = process.env.MOBILE_OUT_DIR || path.join(REPO, 'work', 'mobile');
const PORT = Number(process.env.CDP_PORT || 9222);
const APP_URL = process.env.WATCH_URL || 'http://localhost:8899/ournotes-planner/';

const stamp = () => new Date().toISOString().slice(11, 23);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fixture（带原生 oracle 的期望值）从哪儿读：**优先取验收流水线刚生成的那份**。
// 之前硬写 `browser/work/fixtures/`，而 `tools/run_checks.py` 生成的是 `work/validation/` ——
// 两个目录内容一旦不同（实测只差 `elapsed_seconds` 这类耗时字段），手机就会**对着一份过期 oracle 比对**，
// 而且一句提示都没有。现在两份都认，并且把实际用的那份打进日志（凭据里因此有据可查）。
const FIXTURE_DIRS = [process.env.MOBILE_FIXTURES,
                      path.join(REPO, 'work', 'validation'),
                      path.join(REPO, 'browser', 'work', 'fixtures')].filter(Boolean);

function fixturePath(name) {
  for (const dir of FIXTURE_DIRS) {
    const file = path.join(dir, `${name}.json`);
    if (fs.existsSync(file)) return file;
  }
  throw new Error(`找不到 fixture ${name}.json，找过：\n  `
    + FIXTURE_DIRS.map((d) => path.join(d, `${name}.json`)).join('\n  '));
}

// ---------------------------------------------------------------- devtools HTTP
// WebView 的 devtools HTTP 端点很脆：刚建好的 forward 上经常直接 socket hang up，
// 云手机掉线重连期间还会 ECONNREFUSED。多试几次（默认约 2 分钟），别当成失败。
function targetsOnce(port = PORT) {
  return new Promise((resolve, reject) => {
    const req = http.get({host: '127.0.0.1', port, path: '/json', agent: false,
      headers: {Connection: 'close'}}, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
  });
}

// devtools 回的 webSocketDebuggerUrl 通常已经指向我们 forward 的那个端口，
// **优先原样用**（实测改写 host 会被服务端拒掉）。改写只作为兜底候选。
function wsCandidates(page, port = PORT) {
  const out = [];
  if (page.webSocketDebuggerUrl) out.push(page.webSocketDebuggerUrl);
  try {
    const u = new URL(page.webSocketDebuggerUrl);
    u.host = `127.0.0.1:${port}`;
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

// 一次求值 → 值（异常改成 throw）
function valueOf(result) {
  if (result && result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result?.result?.value;
}

// ---------------------------------------------------------------- 页面状态表达式
// 应用 boot 完成的判据：`#name` 有值，或 `#ownedCount` 匹配 `N + M`。
const STATE = `(() => { const $ = id => document.getElementById(id);
  return { title: ($('progressTitle')?.textContent || '').trim(),
           count: ($('progressCount')?.textContent || '').trim(),
           done: $('results') ? !$('results').hidden : false,
           busy: $('progressBox') ? !$('progressBox').hidden : false,
           cancelDisabled: $('cancel') ? $('cancel').disabled : null,
           hasApp: !!$('calculate'),
           msg: ($('message')?.textContent || '').trim(),
           error: !!($('message') && $('message').classList.contains('error')),
           booted: !!(($('name') && $('name').value !== '') ||
                      /^\\s*\\d+\\s*\\+\\s*\\d+\\s*\$/.test($('ownedCount')?.textContent || '')),
           loadError: $('loadError') && !$('loadError').hidden ? $('loadError').textContent : null }; })()`;

// X 浏览器注入脚本的固定噪音（只为让日志能读，不影响任何判断）
const NOISE = /auto fill|extract text content|content tag:|look up:tag|node offset|conteng:|remove tags:|remove content:|the man content|try_get_title|try travel|next step|element rule|loadHideElementRule|========|_XJSAPI_ is not defined/;

// 选 target 用的探针：**不改页面**，只回答「这个 target 值不值得驱动」。
const PROBE = `(() => { const $ = id => document.getElementById(id);
  return { href: location.href,
           ready: document.readyState,
           visibility: document.visibilityState || null,
           hasApp: !!$('calculate'),
           booted: !!(($('name') && $('name').value !== '') ||
                      /^\\s*\\d+\\s*\\+\\s*\\d+\\s*\$/.test($('ownedCount')?.textContent || '')),
           busy: $('progressBox') ? !$('progressBox').hidden : false,
           results: $('results') ? !$('results').hidden : false,
           title: ($('progressTitle')?.textContent || '').trim() }; })()`;

class Session {
  constructor(options = {}) {
    this.label = options.label || '';
    this.appUrl = options.appUrl || APP_URL;
    this.appPath = new URL(this.appUrl).pathname;
    this.port = Number(options.port || PORT);
    this.live = false;                 // 关掉之前，事件日志一律不打印（Runtime.enable 会重放历史 console）
    this.talkative = options.talkative !== false;
    this.cdp = null;
    this.targetId = null;
    this.sessionNames = new Map();
    this.hooks = [];                   // 每条消息都过一遍（download_test.js 用它捞 download 事件）
    this.loadErrorAt = 0;              // 最近一次「资源加载失败」的浏览器日志时间（见 bootOnce）
    this.lastLoadError = null;
  }

  onAny(fn) { this.hooks.push(fn); }

  log(line) { if (this.talkative) console.log(`[${stamp()}]${this.label ? ` [${this.label}]` : ''} ${line}`); }

  // ------------------------------------------------------------ 列 targets / 选 target
  /**
   * 列 targets，列不到就耐心重试。
   *
   * ⚠️ 默认重试窗口要**够长**：云手机掉线是成串来的（实测一分钟里能掉 20 次），
   *    每次掉线 adb 都会把 CDP 的 forward 抹掉，"socket hang up" / ECONNREFUSED 交替出现。
   *    主机侧的 watchdog 每 3 秒补一次隧道、探到「映射在但已死」还会硬重建（约 60 秒一轮），
   *    所以链路通常一两分钟就回来 —— 但原来只等 150 秒（60×2.5s），一个大点的掉线串就能把
   *    整轮 watch 判死，前面的下载全白费。这里放宽到 10 分钟（可用 `MOBILE_JSON_TRIES` 调）。
   *    放宽的只是**等链路**的耐心，判据（compare.js 对原生 oracle）一个字没动。
   */
  async targets(tries = Number(process.env.MOBILE_JSON_TRIES || 240), gapMs = 2500) {
    let last;
    for (let i = 1; i <= tries; i++) {
      try { return await targetsOnce(this.port); } catch (e) {
        last = e;
        if (i % 8 === 0) this.log(`  /json 还没通（第 ${i} 次）：${e.message}`);
        await sleep(gapMs);
      }
    }
    throw new Error(`/json 连续 ${tries} 次无响应: ${last && last.message}`);
  }

  // 应用自己的页面 target。注意别用 endsWith：应用算完会把 URL 变成 .../ournotes-planner/#plan
  pagesOf(list) {
    const matching = list.filter((t) => t.type === 'page' && t.url.includes(this.appPath)
      && !t.url.includes('/_pt/'));
    if (matching.length) return matching;
    const any = list.find((t) => t.type === 'page');
    return any ? [any] : [];
  }

  /** 给候选 target 打分排序：优先上次用的那个 id，其次前台可见的、已 boot 的、空闲的。 */
  rankPages(pages, preferId) {
    return pages.map((p) => ({page: p, score: (preferId && p.id === preferId ? 100 : 0)}))
      // 没有偏好信息时保持 /json 的原顺序（第一个通常是最近打开的那个）
      .sort((a, b) => b.score - a.score);
  }

  // ------------------------------------------------------------ 连接 / 重连
  /** 连一个候选 WS（每个 URL 试 2 次），成功返回 CDP，失败返回 null。 */
  async connectPage(page) {
    let last;
    for (const url of wsCandidates(page, this.port)) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const candidate = new CDP(url);
        try {
          await candidate.connect();
          return candidate;
        } catch (e) {
          last = e;
          candidate.close();
          await sleep(1500);
        }
      }
    }
    if (last) this.log(`  连不上 ${page.url}: ${last.message}`);
    return null;
  }

  /** 采用这条连接：补齐 domain、记下 target，交出去用。失败返回 null（连接可能刚好断掉）。 */
  async adoptQuietly(page, cdp, onFail) {
    try { return await this.adopt(page, cdp); }
    catch (e) {
      if (onFail) onFail(e);
      cdp.close();
      return null;
    }
  }

  /** 采用这条连接：补齐 domain、记下 target，交出去用。 */
  async adopt(page, cdp) {
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');
    await cdp.send('Target.setAutoAttach',
      {autoAttach: true, waitForDebuggerOnStart: false, flatten: true});
    this.cdp = cdp;
    this.targetId = page.id;
    this.log(`cdp connected: ${this.appUrl} (target ${page.id} ${page.url})`);
    return this.cdp;
  }

  /**
   * 连上应用页 —— 必要时换 target 重连。
   *
   * ⚠️ 同一台手机上会有**多个同 URL 的 page target**（第 15 轮起就一直是这样，本轮实测最多 5 个：
   * 几个 `/ournotes-planner/` + 几个 `.../#plan`，后者是算完之后改成 hash 的旧标签页）。
   * 于是选 target 不能「取第一个」，也不能「谁 booted 就用谁」——
   *
   *   实测踩到的坑：`reloadPage()` 之后重连时，刚 reload 的那个 target 正在加载
   *   （此刻 `visible=hidden`、`booted=false`），而旁边一个**上一轮的旧标签页**满足
   *   `booted=true`，于是驱动连到了旧页面上 —— 接着「导入没生效」「点了计算没反应」，
   *   看起来像应用坏了，其实是连错了页面（本轮的两次跑空就是这么来的）。
   *
   * 现在的判据，按优先级：
   *   ① **上次 reload 的那个 target（按 id 认回来）** —— 连上就用，不再看别的；
   *   ② 前台**可见**的那个（同一时刻手机浏览器只有一个 WebView 是 visible）；
   *   ③ 都没有（浏览器在后台/息屏）才退回分数最高的：可见 > 已 boot > 其它。
   */
  async attach(preferId = null) {
    let last = null;
    const preferred = preferId || this.targetId;
    for (let round = 1; round <= 6; round++) {
      const pages = this.pagesOf(await this.targets());
      if (pages.length) {
        const ranked = this.rankPages(pages, preferred);
        if (ranked.length > 1) {
          this.log(`有 ${ranked.length} 个候选 target：` + ranked.map((r) => r.page.url).join(' | '));
        }
        let fallback = null;   // {page, cdp, score}：没有「可见」的候选时用它
        for (const {page} of ranked) {
          const cdp = await this.connectPage(page);
          if (!cdp) { last = last || new Error(`连不上 ${page.url}`); continue; }
          cdp.on((msg) => this.onEvent(msg));
          if (preferred && page.id === preferred) {
            this.log(`  候选 ${page.id} 就是上次用的那个 target，直接用`);
            const adopted = await this.adoptQuietly(page, cdp, (e) => { last = e; });
            if (adopted) { if (fallback) fallback.cdp.close(); return adopted; }
            continue;
          }
          let probe = null;
          try {
            probe = valueOf(await cdp.send('Runtime.evaluate',
              {expression: PROBE, returnByValue: true}, undefined, 15000));
          } catch (e) { last = e; }
          if (probe) {
            this.log(`  候选 ${page.id} 探测：visible=${probe.visibility} booted=${probe.booted}` +
              ` busy=${probe.busy} hasApp=${probe.hasApp} title=${JSON.stringify(probe.title)}`);
          }
          const score = !probe ? 0 : (probe.visibility === 'visible' ? 2 : (probe.booted ? 1 : 0));
          if (score >= 2) {
            const adopted = await this.adoptQuietly(page, cdp, (e) => { last = e; });
            if (adopted) { if (fallback) fallback.cdp.close(); return adopted; }
            continue;
          }
          if (!fallback || score > fallback.score) {
            if (fallback) fallback.cdp.close();
            fallback = {page, cdp, score};
          } else {
            cdp.close();
          }
        }
        if (fallback) {
          const adopted = await this.adoptQuietly(fallback.page, fallback.cdp, (e) => { last = e; });
          if (adopted) return adopted;
        }
        last = last || new Error('候选 target 一个都连不上');
      }
      this.log(`attach 第 ${round} 轮没成功（${last && last.message}），重新列 targets …`);
      await sleep(2500);
    }
    throw new Error('连不上 devtools WebSocket —— ' + (last && last.message));
  }

  async reattach(why) {
    this.log(`re-attaching (${why}) ...`);
    if (this.cdp) this.cdp.close();
    this.cdp = null;
    await sleep(1500);
    return this.attach();
  }

  close() { if (this.cdp) this.cdp.close(); this.cdp = null; }

  // ------------------------------------------------------------ 读写
  /** 只读求值：断了就重连再读（读是幂等的，重试安全） */
  async read(expression, awaitPromise = false, tries = 4) {
    let last;
    for (let i = 1; i <= tries; i++) {
      try {
        if (!this.cdp || this.cdp.dead) await this.attach();
        return valueOf(await this.cdp.send('Runtime.evaluate',
          {expression, awaitPromise, returnByValue: true}));
      } catch (e) {
        last = e;
        await this.reattach(e.message).catch(() => {});
        await sleep(2000);
      }
    }
    throw new Error(`读页面状态失败：${last && last.message}`);
  }

  /** 有副作用的动作：只发一次，不重试（重试可能点两次「计算」） */
  async act(expression, awaitPromise = false, timeoutMs = 30000) {
    if (!this.cdp || this.cdp.dead) await this.attach();
    return valueOf(await this.cdp.send('Runtime.evaluate',
      {expression, awaitPromise, returnByValue: true}, undefined, timeoutMs));
  }

  async state(tries = 2) { return await this.read(STATE, false, tries); }

  /** 直接发一条 CDP 命令（给需要 Debugger/Page 这类域的小工具用；同样带超时）。 */
  async send(method, params = {}, timeoutMs = 30000) {
    if (!this.cdp || this.cdp.dead) await this.attach();
    return await this.cdp.send(method, params, undefined, timeoutMs);
  }

  // ------------------------------------------------------------ 事件日志
  onEvent(msg) {
    for (const hook of this.hooks) { try { hook(msg); } catch {} }
    // 「资源没加载出来」要**在 live 之前也记**：整页重来的判据靠它（见 bootOnce）。
    // 典型症状：云手机掉线时 reverse 隧道一起没，页面自己去取 12 MB wasm 就 net::ERR_FAILED，
    // 而这时页面是**空的**（应用脚本没跑起来，`#loadError` / `#message` 都是空的），
    // 只看 DOM 是看不出「加载失败」的 —— 只有浏览器自己那句日志说了真话。
    if (msg.method === 'Log.entryAdded') {
      const text = String(msg.params?.entry?.text || '');
      if (/net::ERR_|Failed to load resource|Failed to fetch/i.test(text)) {
        this.loadErrorAt = Date.now();
        this.lastLoadError = text.slice(0, 200);
      }
    }
    if (msg.method === 'Target.attachedToTarget') {
      const {sessionId, targetInfo} = msg.params;
      this.sessionNames.set(sessionId, `worker:${(targetInfo.url || '').split('/').pop()}`);
      if (this.live) this.log(`# attached ${targetInfo.type} ${targetInfo.url}`);
      return;
    }
    if (!this.live) return;
    const describe = (sessionId) => this.sessionNames.get(sessionId) || 'page';
    if (msg.method === 'Runtime.consoleAPICalled') {
      const args = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
      const text = String(args);
      // X 浏览器往页面里注了一整套「读页面 / 自动填卡号」的脚本，**每加载一次就刷几百行 console**，
      // 把真正有用的日志（应用自己的 warn、CSP 拒绝、异常）全埋了。这里只滤掉它那几类固定噪音。
      if (NOISE.test(text)) return;
      this.log(`[${describe(msg.sessionId)} console.${msg.params.type}] ${text.slice(0, 600)}`);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      this.log(`[${describe(msg.sessionId)} EXCEPTION] ${(d.exception?.description || d.text || '').slice(0, 1200)}`);
      return;
    }
    if (msg.method === 'Log.entryAdded') {
      this.log(`[${describe(msg.sessionId)} log.${msg.params.entry.level}] ${String(msg.params.entry.text).slice(0, 600)}`);
    }
  }

  // ------------------------------------------------------------ reload / boot
  /**
   * 清空这个源的存储（IndexedDB / 缓存 / 存储）。
   *
   * 为什么需要它：应用的**续算缓存**（`search-v1.sqlite3`，存在 IndexedDB 里）是跨刷新保留的，
   * 所以「重新跑一次」经常只是**复用缓存**（实测手机上 8 秒就出结果、`复用 2 项`）——
   * 那样的绿灯证明不了「这台手机上真的把搜索跑完了」。要验搜索本身，就得从零算一次。
   * 由 `MOBILE_CLEAR_STORAGE=1` 打开（见 watch.js / cancel_test.js）。
   */
  async clearStorage() {
    const origin = new URL(this.appUrl).origin;
    const survey = () => this.read(`(async () => {
      const out = {localStorageKeys: 0, databases: [], caches: 0};
      try { out.localStorageKeys = localStorage.length; } catch (e) {}
      try { out.databases = (await indexedDB.databases()).map((d) => d.name); } catch (e) {}
      try { out.caches = (await caches.keys()).length; } catch (e) {}
      return out; })()`, true, 3).catch(() => null);
    const before = await survey();
    this.log('  清理前：' + JSON.stringify(before));
    try {
      await this.send('Storage.clearDataForOrigin',
        {origin, storageTypes: 'indexeddb,local_storage,cache_storage,service_workers,websql,file_systems'},
        30000);
    } catch (e) {
      this.log('  Storage.clearDataForOrigin 不可用：' + e.message);
    }
    let after = await survey();
    // ⚠️ 实测 `storageTypes: 'all'` 在这台手机上**什么都没清掉**（卡库还在、续算也还在），
    //    所以这里不信任它的返回值：清完**回头看一遍**，还有就自己动手删。
    if (after && (after.localStorageKeys || (after.databases || []).length)) {
      this.log('  清完还在，改用页面 API 自己删：' + JSON.stringify(after));
      const removed = await this.act(`(async () => {
        const out = {db: 0, ls: 0, cache: 0};
        try { for (const db of await indexedDB.databases()) { indexedDB.deleteDatabase(db.name); out.db++; } } catch (e) {}
        try { out.ls = localStorage.length; localStorage.clear(); } catch (e) {}
        try { for (const k of await caches.keys()) { if (await caches.delete(k)) out.cache++; } } catch (e) {}
        return out; })()`, true, 20000).catch((e) => ({error: e.message}));
      this.log('  自己删的结果：' + JSON.stringify(removed));
      after = await survey();
    }
    this.log('  清理后：' + JSON.stringify(after) + ' —— 这一轮从零算');
    return after;
  }

  /** reload 页面（顺便置 sessionStorage 标记：手机浏览器拿不到跨源隔离，Service Worker 那套「注册→刷新」既没用又可能卡住） */
  async reloadPage() {
    await this.attach();
    const pinned = this.targetId;   // ⚠️ 记住 reload 的是哪一个 target：重连时按 id 认回来
    const flagKey = 'ournotes-isolation-reload:' + this.appPath;
    await this.act(`try { sessionStorage.setItem(${JSON.stringify(flagKey)}, '1'); } catch (e) {} 'ok'`).catch(() => {});
    // Service Worker / 缓存只在**明确要求**时清（`MOBILE_CLEAR_SW=1`）。
    // ⚠️ 别默认清：实测把这台手机上的 SW unregister 掉之后，应用启动时那句
    //    `await navigator.serviceWorker.ready` **永远不 resolve**，页面就永远停在
    //    「正在准备首次运行，页面会自动刷新一次…」—— 看起来像链路卡死，其实是注册流程卡住。
    //    （v0.1.3 给 `ready` 补了 5 秒上限；这里仍然默认不动 SW，免得把「首次安装」这条路当常态。）
    if (process.env.MOBILE_CLEAR_SW) {
      const cleaned = await this.act(`(async () => {
        let sw = 0, cache = 0;
        try { for (const r of await navigator.serviceWorker.getRegistrations()) { if (await r.unregister()) sw++; } } catch (e) {}
        try { for (const k of await caches.keys()) { if (await caches.delete(k)) cache++; } } catch (e) {}
        return {sw, cache}; })()`, true).catch(() => null);
      if (cleaned) this.log(`  清掉 service worker ${cleaned.sw} 个 / 缓存 ${cleaned.cache} 个（MOBILE_CLEAR_SW=1）`);
    }
    await this.cdp.send('Page.navigate', {url: this.appUrl}).catch(() => {});
    await sleep(800);
    this.live = true;
    // ⚠️ reload 要不要**绕过 HTTP 缓存**：默认**不绕过**（2026-10-05 改）。
    //    为什么改：真机验证的链路很窄（实测宿主↔云手机 ~180 KB/s），而应用一次冷启动要下
    //    ~27 MB（pyodide 9.6 MB + ortools wasm 11 MB + stdlib + 运行时包）。`ignoreCache:true`
    //    等于每次 reload 都把这 27 MB **重下一遍**；而云手机每隔几十秒掉一次线，一掉线就把
    //    在途的请求掐死 —— 于是永远凑不出一次完整下载，boot 次次超时（实测连卡三轮）。
    //    不绕过缓存是安全的：资源名都带内容哈希（`assets/*-<hash>.wasm` 之类），应用自己取的
    //    运行时 URL 也带 `?v=<runtime_sha256>` —— 换了构建就是**另一个 URL**，缓存里拿不到旧货；
    //    HTML 本身由服务器/Browser 的缓存策略决定，这里不额外放宽。
    //    要验冷启动、或要看资源新鲜度时：`MOBILE_RELOAD_BYPASS_CACHE=1`。
    const bypassCache = !!process.env.MOBILE_RELOAD_BYPASS_CACHE;
    await this.cdp.send('Page.reload', {ignoreCache: bypassCache}).catch(() => {});
    this.log(`  reload 完成（ignoreCache=${bypassCache}）`);
    this.cdp.close();
    this.cdp = null;      // reload 之后旧的 WebSocket 会话没用了，必须重新列 targets
    this.targetId = pinned;
  }

  /**
   * 等 boot。**关键**：云手机掉线时 reverse 隧道也会一起断，页面自己去取 wasm/资源就会
   * "Failed to fetch"，页面直接停在「网页未能加载」且永远不会自己好。
   * 所以这里一旦发现加载失败/超时，就整页重来（隧道由主机侧 watchdog 补回来了）。
   */
  async bootOnce(budgetMs) {
    const startedAt = Date.now();
    const deadline = startedAt + budgetMs;
    let last = null;
    let lastLogAt = 0;
    for (;;) {
      let state = null;
      try { state = await this.read(STATE, false, 2); } catch (e) { state = null; }
      if (state) {
        last = state;
        if (state.loadError) return {ok: false, why: '页面报错：' + state.loadError};
        if (/未能加载|Failed to fetch|加载失败/.test(String(state.msg || ''))) {
          return {ok: false, why: '资源加载失败：' + state.msg};
        }
        // 页面是**空的**（连应用的 `#calculate` 都没有）+ 这轮里有过 net::ERR_* → 认定加载失败，
        // 别在这里白等到预算用完（实测一次掉线要白等 5 分钟，四轮就是 20 分钟，全在做无用功）。
        if (!state.hasApp && this.loadErrorAt >= startedAt) {
          return {ok: false, why: `页面没加载出来（${this.lastLoadError || 'net::ERR_*'}）`};
        }
        // 连外壳都在、但一连 60 秒都没 boot 出来，而且这轮报过 net::ERR_* —— 一样是没加载完，
        // 整页重来（换构建之后服务端资源换了哈希，正是这种「外壳在、脚本没下来」的形态）。
        if (!state.booted && this.loadErrorAt >= startedAt && Date.now() - startedAt > 60000) {
          return {ok: false, why: `资源没下全，页面一直没 boot（${this.lastLoadError || 'net::ERR_*'}）`};
        }
        if (state.booted) return {ok: true, state};
      }
      // 每 20 秒报一次当前状态：不然 boot 期间的日志一片空白，看不出卡在哪一步
      if (Date.now() - lastLogAt > 20000) {
        lastLogAt = Date.now();
        this.log('  booting… ' + (state ? JSON.stringify(state) : '(读不到状态)'));
      }
      if (Date.now() > deadline) return {ok: false, why: 'boot 超时，最后状态 ' + JSON.stringify(last)};
      await sleep(1500);
    }
  }

  /** reload（可关）→ 等 boot，最多试 attempts 次。返回 boot 完成时的页面状态。 */
  async boot({attempts = 4, budgetMs = 5 * 60 * 1000, noReload = false, attachInstead = false,
              clearStorage = !!process.env.MOBILE_CLEAR_STORAGE} = {}) {
    let bootedState = null;
    for (let attempt = 1; attempt <= attempts && !bootedState; attempt++) {
      if (noReload || attachInstead) {
        await this.attach();
        this.live = true;
        if (clearStorage) await this.clearStorage();
      } else {
        this.log(`reloading page (ignoreCache) … 第 ${attempt} 次`);
        if (clearStorage) { await this.attach(); await this.clearStorage(); }
        await this.reloadPage();
      }
      const outcome = await this.bootOnce(attempt === 1 ? budgetMs : Math.max(budgetMs, 6 * 60 * 1000));
      if (outcome.ok) { bootedState = outcome.state; break; }
      this.log(`boot 失败（第 ${attempt} 次）：${outcome.why}`);
      await sleep(6000);
    }
    if (!bootedState) throw new Error(`应用 boot 不成功（已重试 ${attempts} 次）`);
    await sleep(1500);
    this.live = true;
    return bootedState;
  }

  // ------------------------------------------------------------ 应用自己的路径
  /** 读 fixture（主机侧读进来，不依赖 dist 里多放文件）；用哪一份会打日志 */
  fixture(name) {
    const file = fixturePath(name);
    this.log(`fixture: ${path.relative(REPO, file)}`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  /** 塞 `#import`（`change` 事件，1 MB 上限），发一次动作 + 主机侧轮询确认「已导入」 */
  async importFixture(name) {
    const requestText = JSON.stringify(this.fixture(name).request);
    const before = await this.read("document.getElementById('ownedCount').textContent");
    const dispatch = () => this.act(`(() => {
      const input = document.getElementById('import'), dt = new DataTransfer();
      dt.items.add(new File([${JSON.stringify(requestText)}], 'request.json', {type: 'application/json'}));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', {bubbles: true}));
      return input.files.length; })()`);
    await dispatch();
    // 一次不成再补一次：探针刚好落在「页面还没绑好监听」的窗口里时，change 事件会石沉大海
    for (let round = 1; round <= 2; round++) {
      for (let i = 0; i < (round === 1 ? 15 : 25); i++) {
        const state = await this.state();
        if (String(state.msg).includes('已导入')) {
          this.log(`import: before=${JSON.stringify(before)} after=${JSON.stringify(state.msg)}`);
          return state;
        }
        if (state.error) throw new Error('导入报错：' + state.msg);
        await sleep(800);
      }
      if (round === 1) {
        const diag = await this.read(`({href: location.href, ready: document.readyState,
          hasApp: !!document.getElementById('calculate'),
          importDisabled: document.getElementById('import')?.disabled ?? null})`).catch((e) => ({err: e.message}));
        this.log(`  第一次导入没等到「已导入」，再补一次。页面：${JSON.stringify(diag)}`);
        await dispatch().catch((e) => this.log('  补发失败：' + e.message));
      }
    }
    const last = await this.state().catch(() => ({}));
    throw new Error(`导入没生效（两轮轮询都没等到「已导入」）：${JSON.stringify(last)}`);
  }

  /** 点「开始计算」，然后**主机侧**轮询到终态（断线重连也能接着等）。 */
  async calculateAndWait({maxMinutes = 20, onSample = null, acceptCancelled = false} = {}) {
    await this.act("document.getElementById('calculate').click(); 'clicked'");
    this.log('calculate clicked，开始轮询进度 …');
    const deadline = Date.now() + maxMinutes * 60 * 1000;
    let lastLog = 0;
    let final = null;
    while (Date.now() < deadline) {
      await sleep(2000);
      let state;
      try { state = await this.state(); }
      catch (e) { this.log('  (轮询失败，继续等) ' + e.message); continue; }
      if (onSample) onSample(state);
      if (Date.now() - lastLog > 30000) {
        lastLog = Date.now();
        this.log(`  ${state.title} || ${state.count}`);
      }
      const cancelled = String(state.msg).includes('计算已取消');
      if (state.done) { final = {done: true, cancelled, title: state.title, count: state.count}; break; }
      if (cancelled) { final = {done: false, cancelled: true, title: state.title, count: state.count, msg: state.msg}; break; }
      if (state.error) { final = {done: false, error: state.msg, title: state.title, count: state.count}; break; }
    }
    if (!final) final = {done: false, timeout: true};
    if (acceptCancelled && final.cancelled) return final;
    return final;
  }

  /** 取结果：覆盖 `URL.createObjectURL` 截下应用自己要下载的那个 Blob（比对用的数据是真的）。 */
  async exportPayload() {
    return await this.read(`(async () => {
      const blob = await new Promise(resolve => {
        const original = URL.createObjectURL;
        URL.createObjectURL = b => { URL.createObjectURL = original; resolve(b); return original.call(URL, b); };
        document.getElementById('exportResult').click();
      });
      return await blob.text();
    })()`, true, 6);
  }
}

module.exports = {REPO, OUT_DIR, PORT, APP_URL, STATE, PROBE, stamp, sleep,
                  targetsOnce, wsCandidates, CDP, Session, valueOf, fixturePath};
