/**
 * 端到端验证「粘贴账号包文本」路径 —— 也就是手机取包工具那条主线。
 *   OURNOTES_PAYLOAD_FILE  由 make_payload.py 生成的那段文本
 */
const fs = require("node:fs");
const assert = require("node:assert/strict");
const {chromium} = require(process.env.OURNOTES_PLAYWRIGHT_MODULE || "playwright");

const BASE = process.env.OURNOTES_BROWSER_URL || "http://127.0.0.1:8877/ournotes-planner/";
const PAYLOAD = process.env.OURNOTES_PAYLOAD_FILE;
if (!PAYLOAD) { console.error("需要 OURNOTES_PAYLOAD_FILE"); process.exit(2); }
const text = fs.readFileSync(PAYLOAD, "utf8").trim();
console.log("粘贴文本长度:", text.length, "字符，前缀:", text.slice(0, 12));

(async () => {
    const browser = await chromium.launch({headless: true, channel: process.env.OURNOTES_BROWSER_CHANNEL || undefined});
    const page = await browser.newPage({viewport: {width: 1440, height: 1100}});
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));

    let failed = false;
    try {
        await page.goto(BASE, {waitUntil: "domcontentloaded"});
        await page.waitForFunction(
            () => document.getElementById("accountImportRoot")?.querySelector("#accountPaste"),
            null, {timeout: 180000});
        await page.waitForFunction(() => /\+/.test(document.getElementById("ownedCount")?.textContent || ""),
            null, {timeout: 180000});
        console.log("  ✓ 页面就绪");

        await page.click('button[data-tab="account"]');
        await page.fill("#accountPaste", text);
        console.log("  ✓ 已粘贴到输入框");

        await page.click("#accountPasteGo");
        await page.waitForSelector("#accountReport .account-summary", {timeout: 60000});
        const report = await page.locator("#accountReport").innerText();
        console.log("\n--- 页面显示 ---\n" + report + "\n----------------");

        const members = Number(report.match(/成员卡\s*(\d+)\s*张/)?.[1] ?? 0);
        assert.ok(members > 0, "应识别出成员卡");
        console.log(`  ✓ 识别到成员卡 ${members} 张`);

        await page.click("#accountApply");
        await page.waitForTimeout(1500);
        const state = await page.evaluate(() => window.PlannerAccount.current());
        assert.ok(state?.profile?.inventory?.members?.length > 0, "卡库应有成员卡");
        console.log("  导入后卡库:", JSON.stringify({
            members: state.profile.inventory.members.length,
            snaps: state.profile.inventory.snaps.length,
            characters: state.profile.character_ranks.length,
            total_rank: state.profile.character_total_rank,
        }));

        const issues = await page.evaluate(async () => await Planner.request("/api/check-growth", {
            method: "POST",
            body: JSON.stringify({profile: window.PlannerAccount.current().profile}),
        }));
        assert.equal(issues.complete, true);
        assert.deepEqual(issues.issues, []);
        console.log("  ✓ 官方公式校验通过:", JSON.stringify(issues));
        console.log("\n=== 全部通过 ===");
    } catch (error) {
        failed = true;
        console.error("\n!!! 失败:", error.message);
        try {
            await page.screenshot({path: "account-paste-failure.png", fullPage: true});
            console.error("页面文本:", (await page.locator("body").innerText()).slice(0, 1000));
        } catch { /* 忽略 */ }
    } finally {
        if (errors.length) console.error("页面错误:", errors.slice(0, 5));
        await browser.close();
    }
    process.exit(failed ? 1 : 0);
})();
