/**
 * 只读探针：把应用当前的关键状态打出来 —— **不导航、不点击、不刷新**。
 *
 * 用途：手动点击流程（人点、脚本验）里的「取证」环节。比如人点完「取消」之后，
 * 屏幕上看不出到底是「取消了」还是「算完了」，这一句就能给出页面里的原文：
 *   - `#message`（应用自己的提示，取消的终态就写在这里）
 *   - `#results` 是否可见（取消后必须仍隐藏）
 *   - `#exportResult` 是否存在（只有出过结果才有这个按钮）
 *
 *   node state_probe.js
 *
 * ⚠️ 它只 attach，不 reload —— 所以**不会**把用户正在操作的页面状态清掉。
 */
const {Session} = require('./app-client');

const session = new Session({label: 'probe'});

(async () => {
  await session.attach();
  session.live = false;                    // 只读，不打印页面日志
  const snapshot = await session.read(`(() => {
    const $ = id => document.getElementById(id);
    const t = el => (el ? (el.textContent || '').trim() : null);
    return {
      message: t($('message')),
      messageClass: $('message') ? $('message').className : null,
      resultsHidden: $('results') ? $('results').hidden : null,
      hasExportResult: !!$('exportResult'),
      progressBoxHidden: $('progressBox') ? $('progressBox').hidden : null,
      progressTitle: t($('progressTitle')),
      progressCount: t($('progressCount')),
      profileName: t($('profileName')),
      profileBadge: t($('profileBadge')),
      ownedCount: t($('ownedCount')),
      calculateDisabled: $('calculate') ? $('calculate').disabled : null,
      visibility: document.visibilityState,
    }; })()`, false, 3);
  console.log(JSON.stringify(snapshot, null, 2));
  session.close();
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
