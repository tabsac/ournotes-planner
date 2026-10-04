/**
 * 真机验「导出结果到底有没有落盘」—— 设计笔记 2i⑥ 第 2 条。
 *
 * 背景：`browser/index.html` 的 CSP 是 `connect-src 'self'`，而应用自己的导出是
 * 「`URL.createObjectURL(blob)` → `<a download>` → `a.click()`」。
 * 桌面验收走在 Playwright 的 download 事件上、一直全绿；真机取结果用的是
 * **覆盖 `URL.createObjectURL` 截 Blob**（比对数据因此是真的），
 * 但**手机上的文件到底有没有真的落到磁盘，此前没查过**。
 *
 * 这个脚本只做「浏览器侧」那半件事：**真点一次导出**（不拦截、不改写任何东西），
 * 把点前后页面/控制台/CDP 下载事件都记下来。
 * 设备侧那半件（文件到底在不在）由 `driver.ps1` 的 `adb` 步骤前后各列一次目录来完成，
 * 因为跑驱动的进程才持有 adb 隧道：
 *
 *   & tools/mobile/driver.ps1 -Steps `
 *       'adb shell ls -l /sdcard/Download', `
 *       'download_test.js solver-ap', `
 *       'adb shell ls -l /sdcard/Download'
 *
 *   node download_test.js [fixture=solver-ap]
 *
 * 复用当前页面（已有结果就直接点导出）；没有结果就自己跑一次完整计算。
 * 产出 `work/mobile/download-<fixture>.json`：点击结果、控制台/异常、CDP 下载事件。
 */
const fs = require('node:fs');
const path = require('node:path');
const {Session, OUT_DIR} = require('./app-client');

const FIXTURE = process.argv[2] || 'solver-ap';
const WAIT_MS = Number(process.env.DOWNLOAD_WAIT_MS || 20000);

const session = new Session({label: 'download', talkative: true});
const console_lines = [];
const download_events = [];
const exceptions = [];
const scripts = new Map();          // scriptId -> url（用来回答「这段代码是谁的」）

session.onAny((msg) => {
  const method = String(msg.method || '');
  if (method === 'Debugger.scriptParsed') {
    const p = msg.params || {};
    if (scripts.size < 500) scripts.set(p.scriptId, p.url || '(匿名脚本)');
    return;
  }
  if (/download/i.test(method)) {
    download_events.push({t: Date.now(), method, params: JSON.stringify(msg.params || {}).slice(0, 500)});
    session.log(`CDP 下载事件: ${method} ${JSON.stringify(msg.params || {}).slice(0, 300)}`);
    return;
  }
  if (method === 'Log.entryAdded') {
    const e = msg.params.entry || {};
    console_lines.push({t: Date.now(), level: e.level, source: e.source, text: String(e.text).slice(0, 500)});
    return;
  }
  if (method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
    console_lines.push({t: Date.now(), level: msg.params.type, source: 'console',
      text: String(text).slice(0, 500)});
    return;
  }
  if (method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails || {};
    exceptions.push({t: Date.now(), scriptId: d.scriptId, line: d.lineNumber, column: d.columnNumber,
      text: String(d.exception?.description || d.text || '').slice(0, 800)});
  }
});

/** 异常栈里那句 `at Object.xxx (<匿名>:1:8450)` 到底是谁的代码？把那个 scriptId 的源码抓出来。 */
async function identifyScript(scriptId, needle = 'downloadBlobUrl') {
  try {
    const {scriptSource} = await session.send('Debugger.getScriptSource', {scriptId});
    const at = scriptSource.indexOf(needle);
    return {
      script_id: scriptId,
      url: scripts.get(scriptId) || '(未在 scriptParsed 里见过)',
      length: scriptSource.length,
      // 抓 needle 前后各 240 字，够看清它是干嘛的
      snippet: at >= 0 ? scriptSource.slice(Math.max(0, at - 240), at + 240) : null,
      head: scriptSource.slice(0, 200),
    };
  } catch (error) {
    return {script_id: scriptId, error: error.message};
  }
}

/**
 * 把所有**匿名脚本**（浏览器注入页面的那些）整份存下来 —— 手机上没法直接读，只能靠 CDP 抓。
 * 存到 work/mobile/injected-scripts/script-<id>.js，出事时就能逐字读它到底怎么处理下载。
 */
async function dumpInjectedScripts(minLength = 2000) {
  const dir = path.join(OUT_DIR, 'injected-scripts');
  fs.mkdirSync(dir, {recursive: true});
  const kept = [];
  for (const [scriptId, url] of scripts) {
    if (url !== '(匿名脚本)') continue;
    try {
      const {scriptSource} = await session.send('Debugger.getScriptSource', {scriptId});
      if (scriptSource.length < minLength) continue;
      fs.writeFileSync(path.join(dir, `script-${scriptId}.js`), scriptSource, 'utf8');
      kept.push({script_id: scriptId, length: scriptSource.length,
        file: `injected-scripts/script-${scriptId}.js`});
    } catch (e) { /* 有的脚本已经回收了，忽略 */ }
  }
  if (kept.length) {
    session.log(`已把 ${kept.length} 个注入脚本整份存到 injected-scripts/：`
      + kept.map((k) => `#${k.script_id}(${k.length}B)`).join(' '));
  }
  return kept;
}

(async () => {
  // 复用当前页面（上一步刚算完，结果面板还在），不 reload —— reload 会把结果和卡库都清掉
  await session.attach();
  session.live = true;

  // ⚠️ 必须在**前台可见**的那个页面上点导出。
  // 实测教训：同一台手机上会攒下好几个同 URL 的 target，其中 `visible=hidden` 的是后台 WebView ——
  // 在后台页面上点 `a.click()`，浏览器**根本不会走它的下载那条路**（既不报错、也不落盘），
  // 于是「没有异常」会被误读成「修好了」。这里直接把它当失败处理，不给误判留口子。
  let visible = null;
  for (let attempt = 1; attempt <= 3 && visible !== 'visible'; attempt++) {
    visible = await session.read('document.visibilityState', false, 3).catch(() => null);
    if (visible === 'visible') break;
    session.log(`当前页面 visibilityState=${visible}（后台页面），换一个前台可见的 target 再试（第 ${attempt} 次）`);
    session.close();
    session.targetId = null;      // 清掉钉住，让 attach() 重新按「前台可见」挑
    await new Promise((r) => setTimeout(r, 1500));
    await session.attach();
  }
  if (visible !== 'visible') {
    throw new Error(`没能连到前台可见的页面（visibilityState=${visible}）—— ` +
      '后台页面点导出不会触发浏览器的下载，这个用例在后台页面上没有意义');
  }
  session.log('页面在前台（visibilityState=visible）✔');

  let state = await session.state();
  session.log('当前页面状态：' + JSON.stringify({booted: state.booted, busy: state.busy,
    done: state.done, title: state.title, msg: state.msg}));

  if (!state.booted) {
    session.log('页面还没 boot，先 reload 等一次 …');
    await session.boot();
  }
  state = await session.state();
  if (!state.done) {
    session.log('还没有结果面板，先自己跑一次完整计算 …');
    if (!String(state.msg).includes('已导入')) await session.importFixture(FIXTURE);
    const final = await session.calculateAndWait({maxMinutes: 20});
    session.log('final: ' + JSON.stringify(final));
    if (!final.done) throw new Error('没算出结果，导出无从验起：' + JSON.stringify(final));
  }

  const before = await session.read(`(() => { const b = document.getElementById('exportResult');
    return {exists: !!b, label: b ? b.textContent.trim() : null}; })()`);
  session.log(`导出按钮：${JSON.stringify(before)}`);
  if (!before.exists) throw new Error('页面上没有导出按钮（结果面板没渲染出来？）');

  console_lines.length = 0; exceptions.length = 0; download_events.length = 0;
  // 打开 Debugger 域：① 出异常时能把「那段代码」抓出来看是谁的；② 顺手把注入脚本整份存下来
  await session.send('Debugger.enable').catch((e) => session.log('Debugger.enable 失败：' + e.message));
  await new Promise((r) => setTimeout(r, 1500));   // 等 scriptParsed 把已存在的脚本报一遍
  await dumpInjectedScripts().catch((e) => session.log('抓注入脚本失败：' + e.message));
  const clickedAt = Date.now();
  // ⚠️ 不覆盖 URL.createObjectURL、不拦 a.click()：这就是用户点下去的那一下
  await session.act("document.getElementById('exportResult').click(); 'clicked'");
  session.log('已真点「导出本次结果与实际输入」，等 ' + WAIT_MS + 'ms 看浏览器的反应 …');

  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
  const settled = Date.now() - clickedAt;

  // 有异常就查它是谁的代码
  const blamed = [];
  for (const e of exceptions.slice(0, 3)) {
    if (e.scriptId === undefined) continue;
    const who = await identifyScript(e.scriptId);
    blamed.push(who);
    session.log(`异常来自 scriptId=${e.scriptId} url=${who.url} 长度=${who.length}`);
  }
  const injected = await dumpInjectedScripts().catch(() => []);

  const summary = {
    fixture: FIXTURE,
    checked_at: new Date().toISOString(),
    export_button: before,
    clicked_at: clickedAt,
    waited_ms: settled,
    download_events,
    exceptions,
    blamed_scripts: blamed,
    injected_scripts: injected,
    console: console_lines,
    // 有 downloadWillBegin 说明「浏览器进程确实开始下载了」；有 CSP 拒绝/异常则是「没走到下载」
    verdict: download_events.length ? 'browser-started-download'
      : (exceptions.length || console_lines.some((l) => /Refused|Content Security Policy/i.test(l.text)))
        ? 'blocked-in-page' : 'no-cdp-signal',
  };
  fs.mkdirSync(OUT_DIR, {recursive: true});
  fs.writeFileSync(path.join(OUT_DIR, `download-${FIXTURE}.json`),
    JSON.stringify(summary, null, 2), 'utf8');

  session.log(`导出点击后 ${settled}ms：CDP 下载事件 ${download_events.length} 条，`
    + `页面异常 ${exceptions.length} 条，console/log ${console_lines.length} 条`);
  for (const line of console_lines.slice(-15)) session.log(`  [${line.level}/${line.source}] ${line.text}`);
  for (const e of exceptions.slice(-5)) session.log(`  [EXCEPTION] ${e.text.split('\n')[0]}`);
  session.log(`verdict = ${summary.verdict}（文件有没有真落盘，看主机侧 adb 步骤的前后目录）`);
  session.log(`DOWNLOAD-CLICKED ${JSON.stringify(summary.verdict)}`);
  session.close();
  process.exit(0);
})().catch((error) => { console.error('FAILED:', error.message); process.exit(1); });
