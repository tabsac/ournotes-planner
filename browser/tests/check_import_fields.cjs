/**
 * 验证「账号包导入」写进卡库的字段名与状态是否与配队程序一致。
 *
 *   1. character_ranks 必须是 .rank（不是 .level）
 *   2. 成员卡必须带 live_skill_level / gekisou_skill_level
 *   3. 乐队道具必须全部输出，未解锁的用 level 0（而不是缺条目）
 *   4. 带着真实队伍 + 手动 AP 跑养成校验时，道具等级不应再报「未填写」
 *
 * 第 4 点是关键：旧的 check_account_import.cjs 只传 profile、不传候选卡，
 * 队伍为空 -> required_facility_ids 为空 -> 永远 complete:true，
 * 所以它漏掉了「道具等级全部未填写」这个 bug。
 *
 * 环境变量：
 *   OURNOTES_PACKAGE_DIR   含账号包文件（或 zip）的目录，必填
 *   OURNOTES_BROWSER_CHANNEL  例如 msedge
 */
const fs = require("node:fs");
const path = require("node:path");
const {chromium} = require(process.env.OURNOTES_PLAYWRIGHT_MODULE || "playwright");

const BASE = process.env.OURNOTES_BROWSER_URL || "http://127.0.0.1:8877/ournotes-planner/";
const PKG_DIR = process.env.OURNOTES_PACKAGE_DIR;
if (!PKG_DIR) { console.error("需要 OURNOTES_PACKAGE_DIR"); process.exit(2); }
const files = fs.readdirSync(PKG_DIR).map(n => path.join(PKG_DIR, n));

(async () => {
    const browser = await chromium.launch({headless: true, channel: process.env.OURNOTES_BROWSER_CHANNEL || undefined});
    const page = await (await browser.newContext({viewport: {width: 1440, height: 1100}})).newPage();
    const failures = [];
    const check = (ok, label, detail) => {
        console.log(`  ${ok ? "✓" : "✗"} ${label}${detail === undefined ? "" : "  " + detail}`);
        if (!ok) failures.push(label);
    };
    try {
        await page.goto(BASE, {waitUntil: "domcontentloaded"});
        await page.waitForFunction(
            () => document.getElementById("accountImportRoot")?.querySelector("#accountDrop"),
            null, {timeout: 180000});
        await page.waitForFunction(() => window.PlannerAccount?.current?.(), null, {timeout: 180000});

        await page.locator('[data-tab="account"]').click();
        await page.locator('#accountImportRoot input[type="file"]').first().setInputFiles(files);
        await page.waitForSelector("#accountReport button", {timeout: 120000});
        await page.waitForTimeout(1500);
        const merge = page.locator("#accountReport button").first();
        if (await merge.count()) { await merge.click(); await page.waitForTimeout(2500); }

        const state = await page.evaluate(() => {
            const s = window.PlannerAccount.current();
            return {
                name: s?.name,
                ranks: (s?.profile?.character_ranks || []).slice(0, 3),
                members: (s?.profile?.inventory?.members || []).slice(0, 2),
                facilities: s?.profile?.facilities || [],
                total: s?.profile?.character_total_rank,
            };
        });
        console.log("卡库名:", state.name);
        console.log("角色等级前 3:", JSON.stringify(state.ranks));
        console.log("成员卡前 2:", JSON.stringify(state.members));
        console.log("总角色等级:", state.total);
        console.log(`乐队道具 ${state.facilities.length} 项，其中 level>0 的 ${state.facilities.filter(f => f.level > 0).length} 项`);
        console.log("");

        check(state.ranks.length > 0 && state.ranks.every(r => typeof r.rank === "number"), "character_ranks 用 rank 字段");
        check(state.ranks.every(r => r.level === undefined), "character_ranks 没有误用 level");
        check(state.members.length > 0 && state.members.every(m => typeof m.live_skill_level === "number"), "成员卡带 live_skill_level");
        check(state.members.every(m => typeof m.gekisou_skill_level === "number"), "成员卡带 gekisou_skill_level");
        check(state.facilities.length > 0, "facilities 非空（未解锁也要输出 level 0）", `共 ${state.facilities.length} 项`);
        check(state.facilities.every(f => Number.isInteger(f.level) && f.level >= 0), "facilities 的 level 都是 >=0 的整数");

        // ---- 带真实队伍 + 手动 AP 跑养成校验 ----
        const growth = await page.evaluate(async () => {
            const s = window.PlannerAccount.current();
            const cat = window.PlannerAccount.catalog();
            const owned = s.profile.inventory.members.map(r => r.id);
            const picked = [], seen = new Set();
            for (const id of owned) {
                const ch = cat.members.find(m => m.id === id)?.character_id;
                if (ch != null && !seen.has(ch)) { seen.add(ch); picked.push(id); }
                if (picked.length === 5) break;
            }
            const snaps = s.profile.inventory.snaps.map(r => r.id).slice(0, 5);
            const result = await Planner.request("/api/check-growth", {
                method: "POST",
                body: JSON.stringify({
                    profile: s.profile,
                    candidate_member_ids: picked,
                    candidate_snap_ids: snaps,
                    settings: {normal: {method: "ap"}, challenge: {method: "ap"}},
                }),
            });
            return {result, picked, snaps};
        });
        const issues = growth.result.issues || [];
        console.log("\n养成校验（手动 AP + 真实队伍）:");
        console.log("  候选成员卡:", JSON.stringify(growth.picked));
        console.log("  required_facility_ids:", JSON.stringify(growth.result.required_facility_ids));
        console.log("  live_skill_required:", growth.result.live_skill_required);
        console.log(`  共 ${issues.length} 项问题`);
        for (const it of issues.slice(0, 24)) console.log(`    - ${it.label}  ${it.reason}`);

        check(growth.result.required_facility_ids.length > 0, "校验确实要求了道具等级（否则测不到）");
        const facilityIssues = issues.filter(i => typeof i.label === "string" && i.label.includes("道具等级"));
        check(facilityIssues.length === 0, "道具等级没有「未填写」", `实际 ${facilityIssues.length} 项`);
        const liveIssues = issues.filter(i => typeof i.label === "string" && i.label.includes("Live 技能等级"));
        check(liveIssues.length === 0, "Live 技能等级没有「未填写」", `实际 ${liveIssues.length} 项`);
        const rankIssues = issues.filter(i => typeof i.label === "string" && i.label.includes("角色等级"));
        check(rankIssues.length === 0, "角色等级没有「未填写」", `实际 ${rankIssues.length} 项`);
    } catch (e) {
        failures.push("异常: " + e.message);
        console.error("!!! 失败:", e.message);
    } finally {
        await browser.close();
    }
    console.log(failures.length ? `\n=== 有 ${failures.length} 项失败 ===` : "\n=== 全部通过 ===");
    process.exit(failures.length ? 1 : 0);
})();
