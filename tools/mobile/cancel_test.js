/**
 * 真机验「无 SharedArrayBuffer 时的取消通道」：
 *   ① 起一次计算，**等它进入代价最高的求解阶段**再点取消 → 应当最终落到「计算已取消」，且不崩；
 *   ② 紧接着再跑一次正常计算 → 必须照样算出结果（并与 oracle 逐条一致，交给 compare.js）
 *      —— 验证取消没有把「已取消」写进求解缓存、求解进程能被重建。
 *
 *   node cancel_test.js [fixture=solver-ap]
 *
 * 第 15 轮这个用例没验成，原因写进了设计笔记 2i⑥，本文件是针对那两条改的：
 *
 *   * **老写法在页面里跑一次长 `await`**（RPC 里最长等 180 秒/900 秒），中途断线/掉 target
 *     就整条命令一直不返回（实测阶段 [2] 挂住 8 分钟）；现在一律**主机侧轮询**，
 *     每次求值都有超时（见 app-client.js），断了就重连接着等。
 *   * **老写法「取第一个同 URL 的 page target」**：新机上同时存在 `/ournotes-planner/`
 *     与 `.../#plan` 两个 target，可能连到那个空壳/后台的，于是「点了取消页面什么也没发生」；
 *     现在由 `Session.attach()` 先探测再选（前台可见 / 已 boot 的优先）。
 *   * **老写法的等待条件本身是错的**：它等「进度标题或提示里出现『取消』」，
 *     而点下取消的**那一刻**应用就把标题改成「正在取消…」—— 条件立刻满足，
 *     于是它没等到任何结果就往下走（真机日志里就是「`resultsHidden=true` 但 message 为空」）。
 *     现在等的终态是 `#message` 出现「计算已取消」（应用只在这一步才写它）。
 *
 * 环境开关：CANCEL_STAGE_MS（等求解阶段的上限，默认 120000）
 *           CANCEL_NOTICE_MS（点了取消之后等终态的上限，默认 180000）
 *           CANCEL_RERUN_MIN（② 重跑的上限分钟数，默认 20）
 */
const fs = require('node:fs');
const path = require('node:path');
const {Session, OUT_DIR, sleep} = require('./app-client');

const FIXTURE = process.argv[2] || 'solver-ap';
const STAGE_MS = Number(process.env.CANCEL_STAGE_MS || 120000);
const NOTICE_MS = Number(process.env.CANCEL_NOTICE_MS || 180000);
const RERUN_MIN = Number(process.env.CANCEL_RERUN_MIN || 20);
// 「代价最高的求解阶段」：真机轨迹里就是这一段（第 15 轮实测它单独跑了 76 秒）
const SOLVE_STAGE = /精确求解/;
// 应用的终态提示（generated-app.js 里 `job.status === 'cancelled'` / 取消后仍完成 两条都含它）
const CANCELED_NOTICE = '计算已取消';

const session = new Session({label: 'cancel', talkative: true});
const samples = [];

(async () => {
  await session.boot({attempts: 4, budgetMs: 5 * 60 * 1000});
  session.log('booted');
  session.log('env: ' + JSON.stringify(await session.read(
    `({isolated: crossOriginIsolated, sab: typeof SharedArrayBuffer, secure: isSecureContext,
       locks: !!navigator.locks, ua: navigator.userAgent})`)));
  await session.importFixture(FIXTURE);

  // ---------------------------------------------------------------- 阶段 ①
  // 起计算 → 主机侧轮询到「精确求解中…」→ 点取消 → 主机侧轮询到终态
  session.log(`[1] 开始计算，进入「${SOLVE_STAGE.source}」后点取消 …`);
  await session.act("document.getElementById('calculate').click(); 'clicked'");

  let entered = null;
  const stageDeadline = Date.now() + STAGE_MS;
  let lastStageLog = 0;
  while (Date.now() < stageDeadline) {
    await sleep(1000);
    let state;
    try { state = await session.state(); } catch (e) { continue; }
    samples.push({t: Date.now(), stage: 'wait-solve', title: state.title, msg: state.msg, busy: state.busy});
    if (Date.now() - lastStageLog > 15000) {
      lastStageLog = Date.now();
      session.log(`  … ${state.title} || ${state.count}`);
    }
    // 点了「计算」却没进入运行态 —— 别把它误读成「算完了」。最常见的原因是
    // **同一个网址还开着另一个标签页**：应用的「多标签互斥」会把本页标成卡库已过期
    // （`profileStore.outOfDate`），于是 `calculate()` 一进门就 return，什么都不会发生。
    // 实测就撞上过：手机上残留了 2 个 app page target，取消用例在 1 秒内就「结束」了。
    if (!state.busy && !state.done) {
      const diag = await session.read(`({notice: (document.getElementById('message')?.textContent || '').trim(),
        buttons: ['demo','new','import'].map(id => id + '=' + (document.getElementById(id)?.disabled ?? 'n/a')).join(','),
        inputsDisabled: document.getElementById('inputArea')?.disabled ?? null,
        visible: document.visibilityState, href: location.href})`).catch((e) => ({diagError: e.message}));
      throw new Error(`点了「计算」但应用没有进入运行状态（title=${JSON.stringify(state.title)}）。`
        + `最常见原因：同一个网址还有**另一个标签页** → 应用把本页标成「卡库已过期」，calculate() 直接返回。`
        + `用 driver.ps1 -Reopen 从干净浏览器开始。诊断：${JSON.stringify(diag)}`);
    }
    if (state.done) {
      throw new Error(`还没点取消就已经出结果了（title=${JSON.stringify(state.title)}）`
        + ` —— 这个 fixture 在这台手机上跑得太快，取消无从验起；换更长的用例或减小 CANCEL_STAGE_MS`);
    }
    if (SOLVE_STAGE.test(state.title)) { entered = state; break; }
  }
  if (!entered) throw new Error(`${STAGE_MS}ms 内没等到求解阶段，最后一条 ${JSON.stringify(samples.at(-1))}`);

  const before = await session.state();
  session.log(`[1] 求解阶段中，点取消。期间进度：${JSON.stringify(before.title)} || ${JSON.stringify(before.count)}`);
  session.log(`[1] 取消按钮 disabled=${before.cancelDisabled}`);
  const clickAt = Date.now();
  const clicked = await session.act(`(() => { const b = document.getElementById('cancel');
    const wasDisabled = b.disabled; b.click();
    return {wasDisabled, titleNow: document.getElementById('progressTitle').textContent}; })()`);
  session.log(`[1] cancel clicked: ${JSON.stringify(clicked)}`);

  let terminal = null;
  const noticeDeadline = clickAt + NOTICE_MS;
  let lastNoticeLog = 0;
  while (Date.now() < noticeDeadline) {
    await sleep(1000);
    let state;
    try { state = await session.state(); } catch (e) { continue; }
    samples.push({t: Date.now(), stage: 'wait-cancel', title: state.title, msg: state.msg, busy: state.busy});
    if (String(state.msg).includes(CANCELED_NOTICE)) { terminal = state; break; }
    if (state.error) throw new Error('取消过程中页面报错：' + state.msg);
    if (Date.now() - lastNoticeLog > 15000) {
      lastNoticeLog = Date.now();
      session.log(`  … 等取消落地：title=${JSON.stringify(state.title)} msg=${JSON.stringify(state.msg)}`);
    }
  }
  const noticeSeconds = Math.round((Date.now() - clickAt) / 1000);
  if (!terminal) {
    const last = samples.at(-1) || {};
    throw new Error(`点了取消 ${noticeSeconds} 秒后仍未出现「${CANCELED_NOTICE}」` +
      `（title=${JSON.stringify(last.title)} msg=${JSON.stringify(last.msg)}）`);
  }
  session.log(`[1] 取消落地：${noticeSeconds} 秒后 msg=${JSON.stringify(terminal.msg.slice(0, 80))}…`);
  if (terminal.busy) session.log('[1] 注意：取消提示已出现，但进度框还没收起');
  if (terminal.done) throw new Error('取消之后居然出了结果面板 —— 取消没有生效');

  // ---------------------------------------------------------------- 阶段 ②
  session.log('[2] 重新跑一次完整计算 …');
  const rerunStart = Date.now();
  const final = await session.calculateAndWait({maxMinutes: RERUN_MIN});
  const rerunSeconds = Math.round((Date.now() - rerunStart) / 1000);
  session.log(`[2] ${JSON.stringify(final)}（${rerunSeconds} 秒）`);
  if (!final.done) throw new Error('取消后重跑没出结果：' + JSON.stringify(final));

  const payload = await session.exportPayload();
  fs.mkdirSync(OUT_DIR, {recursive: true});
  const out = path.join(OUT_DIR, `result-after-cancel-${FIXTURE}.json`);
  fs.writeFileSync(out, payload);
  session.log(`[2] 已保存 ${path.basename(out)}（${payload.length} 字节）`);

  const parsed = JSON.parse(payload);
  const summary = {
    fixture: FIXTURE,
    checked_at: new Date().toISOString(),
    stage_when_canceled: before.title,
    progress_when_canceled: before.count,
    cancel_click_title: clicked && clicked.titleNow,   // 应用在这一刻会写「正在取消…」
    cancel_notice: terminal.msg,
    cancel_notice_seconds: noticeSeconds,
    results_hidden_after_cancel: !terminal.done,
    rerun_seconds: rerunSeconds,
    rerun: {algorithm: parsed.result?.search?.algorithm,
            optimality_proven: parsed.result?.search?.optimality_proven,
            complete: parsed.result?.search?.complete},
    samples: samples.map((s) => ({t: s.t, stage: s.stage, title: s.title, busy: s.busy})),
  };
  fs.writeFileSync(path.join(OUT_DIR, `cancel-${FIXTURE}.json`),
    JSON.stringify(summary, null, 2), 'utf8');
  session.log(`[1] 取消阶段＝${JSON.stringify(before.title)}；取消落地用时 ${noticeSeconds} 秒`
    + `；② 重跑 ${rerunSeconds} 秒，algorithm=${summary.rerun.algorithm}`);
  session.log(`PASSED  cancel-${FIXTURE}（明细 work/mobile/cancel-${FIXTURE}.json）`);
  session.close();
  process.exit(0);
})().catch((error) => {
  console.error('FAILED:', error.message);
  try {
    fs.mkdirSync(OUT_DIR, {recursive: true});
    fs.writeFileSync(path.join(OUT_DIR, `cancel-${FIXTURE}.json`),
      JSON.stringify({fixture: FIXTURE, passed: false, error: error.message,
        checked_at: new Date().toISOString()}, null, 2), 'utf8');
  } catch {}
  process.exit(1);
});
