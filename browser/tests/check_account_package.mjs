// 验证 account-package.js：
//   1) FIPS-197 已知答案（保证 Rijndael 移植没错）
//   2) 用真实账号包文件解密，与 Python 参考实现的结果逐字节比对
import {readFileSync, readdirSync} from "node:fs";
import {join} from "node:path";
import {selfTest, decryptPackage, findPlayerPackage, extractPlayer, toHex, looksLikePackage}
    from "../account-package.js";

const PKG_DIR = process.argv[2] ||
    "C:\\Users\\13766\\dsh-workspace\\ournotes-account\\localdata\\adf64ecb1653352ce8d73f68e52e97ea713c1789d7141246838a69a8962762ee";
const PY_DIR = process.argv[3] ||
    "C:\\Users\\13766\\dsh-workspace\\ournotes-account\\decrypted";

console.log("=== 1) FIPS-197 已知答案 ===");
const st = selfTest();
for (const r of st.knownAnswers) {
    console.log(`  enc ${r.encOk ? "PASS" : "FAIL"}  got=${r.enc}  want=${r.want}`);
    console.log(`  dec ${r.decOk ? "PASS" : "FAIL"}  got=${r.dec}`);
}
console.log("  Nb=8 往返:", st.nb8RoundTrip ? "PASS" : "FAIL");
if (!st.knownAnswersOk || !st.nb8RoundTrip) {
    console.error("!! 自检失败，后面不用看了");
    process.exit(1);
}

console.log("\n=== 2) 真实账号包解密 + 与 Python 结果逐字节比对 ===");
const names = readdirSync(PKG_DIR);
const entries = names.map(n => ({name: n, bytes: new Uint8Array(readFileSync(join(PKG_DIR, n)))}));
const t0 = Date.now();
const found = findPlayerPackage(entries, (d, t, n) => console.log(`  试解密 [${d}/${t}] ${n.slice(0, 16)}…`));
const dt = Date.now() - t0;
console.log(`  扫描耗时 ${dt} ms`);

if (!found) { console.error("!! 一个都没解出来"); process.exit(1); }
console.log(`  含 _player 的文件: ${found.name}`);

let allOk = true;
for (const e of entries) {
    const got = decryptPackage(e.bytes);
    const pyPath = join(PY_DIR, e.name + ".json");
    let py;
    try { py = readFileSync(pyPath); } catch { console.log(`  ${e.name.slice(0,16)}… 跳过（无 Python 参考）`); continue; }
    const same = got && Buffer.compare(Buffer.from(got.plain), py) === 0;
    console.log(`  ${e.name.slice(0, 16)}…  ${got ? got.plain.length : 0} B vs Python ${py.length} B  ${same ? "一致 ✓" : "不一致 ✗"}`);
    if (!same) allOk = false;
}

const p = extractPlayer(found.json ?? {});
if (p) {
    console.log("\n=== 3) 从解出的数据里读卡库 ===");
    const r = (k) => Array.isArray(p[k]) ? p[k].length : 0;
    console.log(`  _name=${p._name}  _accountid=${p._accountid}`);
    console.log(`  _memberCards=${r("_memberCards")}  _supportCards=${r("_supportCards")}  _characters=${r("_characters")}`);
    console.log(`  _items=${r("_items")}  _decks=${r("_decks")}  _bandItems=${r("_bandItems")}`);
    console.log("  第一张成员卡:", JSON.stringify(p._memberCards?.[0]));
    console.log("  第一张支援卡:", JSON.stringify(p._supportCards?.[0]));
}
console.log("\n" + (allOk ? "ALL OK" : "有比对失败"));
process.exit(allOk ? 0 : 1);
