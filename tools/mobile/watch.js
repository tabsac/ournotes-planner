/**
 * 在云手机的 WebView 上，用 CDP 完整驱动一次「导入 → 计算 → 出结果」，
 * 并把**页面和所有 Worker 的 console / 异常**实时打出来。
 *
 *   node watch.js <fixture 名> [最长分钟数]
 *
 * 前提：adb -s <serial> forward tcp:9222 localabstract:webview_devtools_remote_<pid>
 *      （正常走 `driver.ps1 -Steps 'watch.js solver-ap'`，隧道由它持有）
 *
 * ⚠️ 云手机的 adb 会**周期性掉线**（"device offline"），一掉线 forward 就全没了，
 *    挂在它上面的 WebSocket 也跟着断。所以这个脚本不持有「一条长命的求值」：
 *      * 读状态（页面的 DOM）在**主机侧轮询**，断了就重连接着轮；
 *      * 真正有副作用的动作（导入、点计算）才发一次，发完靠轮询确认结果；
 *      * /json 与 WebSocket 都带耐心重试。
 *    页面里的计算进程本来就不依赖这条 WS，所以断线不会毁掉这一轮求解。
 *    这些机制都在 `app-client.js`（与 cancel_test.js / download_test.js 共用）。
 *
 * 环境开关：
 *   WATCH_NO_RELOAD=1  不 reload，直接连现在这个页面（调页面状态时用；会沿用已导入的卡库）
 *   CDP_PORT / WATCH_URL / MOBILE_OUT_DIR  见 app-client.js
 */
const fs = require('node:fs');
const path = require('node:path');
const {Session, OUT_DIR} = require('./app-client');

const FIXTURE = process.argv[2] || 'solver-ap';
const MAX_MINUTES = Number(process.argv[3] || 20);
const OUT = path.join(OUT_DIR, 'watch-' + FIXTURE + '.jsonl');

const session = new Session({label: 'watch', talkative: true});
const trace = [];           // 主机侧采样，落盘成 watch-<fixture>.jsonl
function record(state, when = Date.now()) {
  const line = state.title + ' || ' + state.count;
  if (!trace.length || trace[trace.length - 1][1] !== line) trace.push([when, line]);
}

(async () => {
  await session.boot({attempts: 4, budgetMs: 5 * 60 * 1000,
                      noReload: !!process.env.WATCH_NO_RELOAD});
  session.log('booted');
  session.log('env: ' + JSON.stringify(await session.read(
    `({isolated: crossOriginIsolated, sab: typeof SharedArrayBuffer, secure: isSecureContext,
       sw: !!navigator.serviceWorker?.controller, locks: !!navigator.locks, ua: navigator.userAgent})`)));

  await session.importFixture(FIXTURE);

  const final = await session.calculateAndWait({maxMinutes: MAX_MINUTES, onSample: record});
  session.log('final: ' + JSON.stringify(final));

  // ---- 取结果（导出按钮会把 {schema_version, actual_inputs, result} 交出去）----
  if (final.done) {
    const payload = await session.exportPayload();
    fs.mkdirSync(OUT_DIR, {recursive: true});
    fs.writeFileSync(path.join(OUT_DIR, `result-${FIXTURE}.json`), payload);
    session.log(`saved result-${FIXTURE}.json (${payload.length} bytes)`);
    const parsed = JSON.parse(payload);
    session.log('algorithm: ' + (parsed.result?.search?.algorithm ?? null)
      + '  optimality_proven: ' + (parsed.result?.search?.optimality_proven ?? null));
  }

  // 页面侧还留了一份「变化才记」的更细轨迹，能取到就并进来
  const pageLines = await session.read('window.__watchLines || []', false, 2).catch(() => []);
  const merged = trace.concat(Array.isArray(pageLines) ? pageLines : [])
    .sort((a, b) => a[0] - b[0]);
  fs.writeFileSync(OUT, merged.map((l) => JSON.stringify(l)).join('\n'));
  session.log(`progress trace -> ${path.basename(OUT)} (host ${trace.length} + page ${(pageLines || []).length})`);
  session.close();
  process.exit(final.done ? 0 : 1);
})().catch((error) => { console.error('FAILED:', error.message); process.exit(1); });
