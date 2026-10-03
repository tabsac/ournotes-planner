/**
 * 截图「角色与道具」页，检查立绘与道具图标是否正常显示。
 *   OURNOTES_PACKAGE_DIR  可选：先导入账号包再截图
 */
const fs = require("node:fs");
const path = require("node:path");
const {chromium} = require(process.env.OURNOTES_PLAYWRIGHT_MODULE || "playwright");

const BASE = process.env.OURNOTES_BROWSER_URL || "http://127.0.0.1:8877/ournotes-planner/";
const SHOT = process.env.OURNOTES_SHOT || "growth-panel.png";

(async () => {
    const browser = await chromium.launch({headless: true, channel: process.env.OURNOTES_BROWSER_CHANNEL || undefined});
    const page = await (await browser.newContext({viewport: {width: 1500, height: 1400}})).newPage();
    try {
        await page.goto(BASE, {waitUntil: "domcontentloaded"});
        await page.waitForFunction(() => window.PlannerAccount?.current?.(), null, {timeout: 180000});

        if (process.env.OURNOTES_PACKAGE_DIR) {
            const files = fs.readdirSync(process.env.OURNOTES_PACKAGE_DIR)
                .map(n => path.join(process.env.OURNOTES_PACKAGE_DIR, n));
            await page.locator('[data-tab="account"]').click();
            await page.locator('#accountImportRoot input[type="file"]').first().setInputFiles(files);
            await page.waitForSelector("#accountReport button", {timeout: 120000});
            await page.waitForTimeout(1500);
            const merge = page.locator("#accountReport button").first();
            if (await merge.count()) { await merge.click(); await page.waitForTimeout(2500); }
        }

        await page.locator('[data-tab="growth"]').click();
        await page.waitForTimeout(1200);

        // 统计图片是否真的加载出来了（naturalWidth>0 才算成功）
        const stats = await page.evaluate(() => {
            const imgs = [...document.querySelectorAll(".growth-art")];
            return {
                total: imgs.length,
                loaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length,
                broken: imgs.filter(i => i.complete && i.naturalWidth === 0).map(i => i.getAttribute("src")).slice(0, 5),
                sample: imgs.slice(0, 3).map(i => i.getAttribute("src")),
            };
        });
        console.log(`立绘/图标 <img> 共 ${stats.total} 个，成功加载 ${stats.loaded} 个`);
        if (stats.broken.length) console.log("  加载失败:", JSON.stringify(stats.broken));
        console.log("  示例 src:", JSON.stringify(stats.sample));

        await page.locator("#growth").screenshot({path: SHOT});
        console.log("已截图:", SHOT);
    } catch (e) {
        console.error("!!! 失败:", e.message);
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
})();
