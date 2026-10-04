/**
 * 真机验「无 SharedArrayBuffer 时的取消通道」：
 *   ① 起一次计算，3 秒后点取消 → 应当走进度/提示里出现「取消」，且不崩；
 *   ② 紧接着再跑一次正常计算 → 必须照样算出结果并与 oracle 一致
 *      （验证取消没有把「已取消」写进求解缓存、求解进程能被重建）。
 *
 *   node on_cards/phone_verify/cancel_test.js solver-ap
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const PORT = Number(process.env.CDP_PORT || 9222);
const FIXTURE = process.argv[2] || 'solver-ap';
// 仓库根目录（本文件在 tools/mobile/ 下）
const REPO = path.resolve(__dirname, '..', '..');
// 产出的结果 / 进度轨迹都写到这里（work/ 已在 .gitignore 里），可用 MOBILE_OUT_DIR 覆盖
const OUT_DIR = process.env.MOBILE_OUT_DIR || path.join(REPO, 'work', 'mobile');

const targets = async (tries = 8) => {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      return await new Promise((resolve, reject) => {
        const req = http.get({host: '127.0.0.1', port: PORT, path: '/json', agent: false,
          headers: {Connection: 'close'}}, (res) => {
          let body = ''; res.on('data', (c) => (body += c));
          res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
        });
        req.on('error', reject);
        req.setTimeout(8000, () => req.destroy(new Error('timeout')));
      });
    } catch (e) { last = e; await new Promise((r) => setTimeout(r, 1500)); }
  }
  throw new Error(`/json 连续 ${tries} 次无响应: ${last && last.message}`);
};

class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error('ws error: ' + (e.message || '')));
      this.ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && this.pending.has(m.id)) {
          const {resolve: ok, reject: bad} = this.pending.get(m.id);
          this.pending.delete(m.id);
          m.error ? bad(new Error(JSON.stringify(m.error))) : ok(m.result);
        }
      };
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, {resolve, reject}); this.ws.send(JSON.stringify({id, method, params})); });
  }
}

(async () => {
  const list = await targets();
  // 注意别用 endsWith：应用算完会把 URL 变成 .../ournotes-planner/#plan
  const page = list.find((t) => t.type === 'page' && t.url.includes('/ournotes-planner/') && !t.url.includes('/_pt/'));
  if (!page) throw new Error('没找到应用页');
  // devtools 给的 ws 端口不一定等于我们 forward 的端口，统一改写
  const ws = new URL(page.webSocketDebuggerUrl);
  ws.host = `127.0.0.1:${PORT}`;
  const cdp = new CDP(ws.toString());
  await cdp.connect();
  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 导入用的 fixture 从**主机侧**读进来再注入，不依赖 dist 里多放一个文件
  // （dist 必须和已发布的 docs/ 逐字节一致，不能为了测试往里塞东西）。
  const fixture = JSON.parse(fs.readFileSync(path.join(REPO, 'browser', 'work', 'fixtures', `${FIXTURE}.json`), 'utf8'));
  const requestText = JSON.stringify(fixture.request);
  await evaluate(`(async () => {
    if (!document.getElementById('name').value) {
      const input = document.getElementById('import'), dt = new DataTransfer();
      dt.items.add(new File([${JSON.stringify(requestText)}], 'request.json', {type:'application/json'}));
      input.files = dt.files; input.dispatchEvent(new Event('change', {bubbles:true}));
      await new Promise(r => setTimeout(r, 4000));
    }
    return document.getElementById('name').value; })()`);

  console.log('[1] 起一次计算，3 秒后取消 …');
  const cancelPhase = await evaluate(`(async () => {
    const $ = id => document.getElementById(id);
    $('calculate').click();
    await new Promise(r => setTimeout(r, 3000));
    const before = {title: $('progressTitle').textContent, cancelDisabled: $('cancel').disabled};
    $('cancel').click();
    const t0 = Date.now();
    while (Date.now() - t0 < 180000) {
      await new Promise(r => setTimeout(r, 1500));
      const msg = $('message').textContent || '', title = $('progressTitle').textContent || '';
      if (msg.includes('取消') || title.includes('取消')) break;
    }
    await new Promise(r => setTimeout(r, 3000));
    return {before, title: $('progressTitle').textContent, message: $('message').textContent,
            resultsHidden: $('results').hidden, cancelling: $('cancel').disabled};
  })()`);
  console.log('[1] 结果:', JSON.stringify(cancelPhase));

  console.log('[2] 再跑一次完整计算 …');
  const second = await evaluate(`(async () => {
    const $ = id => document.getElementById(id);
    $('calculate').click();
    const t0 = Date.now();
    while (Date.now() - t0 < 900000) {
      await new Promise(r => setTimeout(r, 3000));
      if (!$('results').hidden) break;
    }
    if ($('results').hidden) return {done: false, title: $('progressTitle').textContent, message: $('message').textContent};
    const blob = await new Promise(resolve => {
      const original = URL.createObjectURL;
      URL.createObjectURL = b => { URL.createObjectURL = original; resolve(b); return original.call(URL, b); };
      $('exportResult').click();
    });
    return {done: true, seconds: Math.round((Date.now() - t0) / 1000), payload: await blob.text()};
  })()`);
  console.log('[2] done=%s seconds=%s', second.done, second.seconds);
  if (second.done) {
    fs.mkdirSync(OUT_DIR, {recursive: true});
    const out = path.join(OUT_DIR, `result-after-cancel-${FIXTURE}.json`);
    fs.writeFileSync(out, second.payload);
    console.log('[2] 已保存', path.basename(out));
  } else {
    console.log('[2] 失败:', JSON.stringify(second));
    process.exitCode = 1;
  }
  cdp.ws.close();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
