/**
 * 端到端验证「账号包导入」：
 *   把真实账号包文件塞进页面 -> 解密 -> Python 换算 -> 报告 -> 合并进卡库 -> 校验 state。
 *
 * 环境变量：
 *   OURNOTES_BROWSER_URL   默认 http://127.0.0.1:8877/ournotes-planner/
 *   OURNOTES_PACKAGE_DIR   真实账号包目录（必填）
 *   OURNOTES_BROWSER_CHANNEL  可选，例如 msedge
 */
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const {chromium} = require(process.env.OURNOTES_PLAYWRIGHT_MODULE || "playwright");

const BASE = process.env.OURNOTES_BROWSER_URL || "http://127.0.0.1:8877/ournotes-planner/";
const PKG_DIR = process.env.OURNOTES_PACKAGE_DIR;
if (!PKG_DIR) {
    console.error("需要 OURNOTES_PACKAGE_DIR 指向真实账号包目录");
    process.exit(2);
}
const files = fs.readdirSync(PKG_DIR).map(n => path.join(PKG_DIR, n));
console.log("账号包文件:", files.map(f => path.basename(f)).join(", "));

(async () => {
    const browser = await chromium.launch({
        headless: true,
        channel: process.env.OURNOTES_BROWSER_CHANNEL || undefined,
    });
    const context = await browser.newContext({viewport: {width: 1440, height: 1100}});
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });

    let failed = false;
    try {
        console.log("打开", BASE);
        await page.goto(BASE, {waitUntil: "domcontentloaded"});

        console.log("等待计算组件与 App 初始化就绪（首次较慢）…");
        await page.waitForFunction(
            () => document.getElementById("accountImportRoot")
                && document.getElementById("accountImportRoot").querySelector("#accountDrop"),
            null, {timeout: 180000});
        // 关键：App 的点击处理里有 `if (!el || !state) return`，state 还没准备好时点 tab 会被忽略
        await page.waitForFunction(
            () => { try { return !!window.PlannerAccount?.current?.(); } catch { return false; } },
            null, {timeout: 180000});
        await page.waitForFunction(
            () => /\+/.test(document.getElementById("ownedCount")?.textContent || ""),
            null, {timeout: 180000});
        const loadError = await page.locator("#loadError").isVisible();
        if (loadError) throw new Error("页面加载失败：" + await page.locator("#loadError").textContent());
        assert.equal(await page.evaluate(() => crossOriginIsolated), true, "需要跨域隔离");
        console.log("  ✓ 页面就绪，跨域隔离已启用");

        console.log("切到「账号包导入」页");
        await page.click('button[data-tab="account"]');
        await page.waitForSelector("#accountImportRoot #accountDrop", {state: "visible"});

        console.log("把真实账号包塞进文件输入框");
        await page.locator('#accountImportRoot input[type="file"]').first().setInputFiles(files);

        console.log("等待识别结果…");
        await page.waitForSelector("#accountReport .account-summary", {timeout: 120000});
        const report = await page.locator("#accountReport").innerText();
        console.log("\n--- 页面显示的报告 ---\n" + report + "\n----------------------");

        assert.match(report, /成员卡/, "报告里应有成员卡");
        const memberMatch = report.match(/成员卡\s*(\d+)\s*张/);
        const snapMatch = report.match(/留影卡（Snap）\s*(\d+)\s*张/);
        assert.ok(memberMatch, "报告里应显示成员卡数量");
        assert.ok(Number(memberMatch[1]) > 0, "成员卡数量应大于 0");
        console.log(`  ✓ 识别到成员卡 ${memberMatch[1]} 张、留影卡 ${snapMatch ? snapMatch[1] : "?"} 张`);

        console.log("点「合并进卡库」");
        await page.click("#accountApply");
        await page.waitForFunction(
            () => window.PlannerAccount.current()?.account_import != null || true, null, {timeout: 30000});
        await page.waitForTimeout(1500);

        const state = await page.evaluate(() => window.PlannerAccount.current());
        console.log("  导入后卡库：", JSON.stringify({
            members: state?.profile?.inventory?.members?.length,
            snaps: state?.profile?.inventory?.snaps?.length,
            character_ranks: state?.profile?.character_ranks?.length,
            character_total_rank: state?.profile?.character_total_rank,
            candidates: [state?.candidate_member_ids?.length, state?.candidate_snap_ids?.length],
            name: state?.name,
        }));
        assert.ok(state?.profile?.inventory?.members?.length > 0, "卡库应有成员卡");
        assert.ok(state?.candidate_member_ids?.length >= 5, "候选成员卡应至少 5 张");
        assert.equal(new Set(state.candidate_member_ids).size, state.candidate_member_ids.length, "候选成员卡不应重复");

        // 候选卡必须真的拥有，且至少 5 位不同角色
        const owned = new Set(state.profile.inventory.members.map(r => r.id));
        for (const id of state.candidate_member_ids) assert.ok(owned.has(id), "候选卡必须是已拥有的：" + id);

        const catalog = await page.evaluate(() => window.PlannerAccount.catalog());
        const characters = new Set(state.candidate_member_ids.map(
            id => catalog.members.find(m => m.id === id)?.character_id));
        assert.ok(characters.size >= 5, "候选成员卡应覆盖至少 5 位不同角色，实际 " + characters.size);
        console.log(`  ✓ 候选成员卡覆盖 ${characters.size} 位不同角色`);

        // 用官方公式复核一遍导入的卡库
        const issues = await page.evaluate(async () => {
            return await Planner.request("/api/check-growth", {
                method: "POST",
                body: JSON.stringify({profile: window.PlannerAccount.current().profile}),
            });
        });
        console.log("  养成校验：", JSON.stringify(issues));
        assert.equal(issues.complete, true, "导入的卡库应通过养成校验");
        assert.deepEqual(issues.issues, [], "不应有养成问题");

        console.log("\n登录后页面标题卡：", await page.locator("#ownedCount").textContent().catch(() => "(读不到)"));
        console.log("\n=== 全部通过 ===");
    } catch (error) {
        failed = true;
        console.error("\n!!! 失败:", error.message);
        try {
            await page.screenshot({path: "account-import-failure.png", fullPage: true});
            console.error("已截图 account-import-failure.png");
            console.error("页面文本片段:", (await page.locator("body").innerText()).slice(0, 1200));
        } catch { /* 忽略 */ }
    } finally {
        if (errors.length) console.error("页面错误:", errors.slice(0, 8));
        await browser.close();
    }
    process.exit(failed ? 1 : 0);
})();
