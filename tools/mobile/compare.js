/**
 * 把真机导出的结果和原生 oracle 逐条比。
 * 判据与 browser/tests/check_browser.cjs 里的 compare() 完全一致。
 *
 *   node on_cards/phone_verify/compare.js solver-ap
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

// 仓库根目录（本文件在 tools/mobile/ 下）
const REPO = path.resolve(__dirname, '..', '..');
// 产出的结果 / 进度轨迹都写到这里（work/ 已在 .gitignore 里），可用 MOBILE_OUT_DIR 覆盖
const OUT_DIR = process.env.MOBILE_OUT_DIR || path.join(REPO, 'work', 'mobile');
const name = process.argv[2] || 'solver-ap';
// 第三个参数可选：指定要比对的导出结果文件（例如取消后重跑的 result-after-cancel-*.json）
const actualPath = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(OUT_DIR, `result-${name}.json`);
const actual = JSON.parse(fs.readFileSync(actualPath, 'utf8')).result;
const fixture = JSON.parse(fs.readFileSync(path.join(REPO, 'browser', 'work', 'fixtures', `${name}.json`), 'utf8'));
const expected = fixture.expected;

function key(row, objective) {
  const other = objective === 'event_pt' ? 'shop_pt' : 'event_pt';
  return [row.totals[objective], row.totals[other], row.totals.cp_remaining,
          row.normal.power, row.challenge.power, -row.normal.song_id, -row.challenge.song_id];
}

assert.equal(actual.search.complete, true, 'search.complete 应为 true');
assert.deepEqual(actual.difference, expected.difference, 'difference 不一致');
for (const objective of ['event_pt', 'shop_pt']) {
  assert.deepEqual(key(actual.plans[objective], objective), key(expected.plans[objective], objective),
    `${objective} 的 plans 不一致`);
  for (const mode of ['normal', 'challenge']) {
    assert.deepEqual(actual.top3[objective][mode].map((row) => key(row, objective)),
      expected.top3[objective][mode].map((row) => key(row, objective)), `${objective}/${mode} 的 top3 不一致`);
    assert.equal(new Set(actual.top3[objective][mode].map((row) => row[mode].song_id)).size,
      expected.top3[objective][mode].length, `${objective}/${mode} top3 出现重复乐曲`);
  }
}

console.log(`PASSED  ${name}`);
console.log(`  algorithm          = ${actual.search.algorithm}`);
console.log(`  optimality_proven  = ${actual.search.optimality_proven}`);
console.log(`  complete           = ${actual.search.complete}`);
for (const objective of ['event_pt', 'shop_pt']) {
  const row = actual.plans[objective];
  console.log(`  ${objective.padEnd(9)} = event_pt ${row.totals.event_pt} / shop_pt ${row.totals.shop_pt}`
    + ` / cp 剩余 ${row.totals.cp_remaining} / power ${row.normal.power}/${row.challenge.power}`);
}
