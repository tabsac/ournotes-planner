/**
 * 跑一次真实计算并截图「收益规划」结果，检查队伍成员卡 / Snap / 乐曲封面有没有显示。
 *
 * 计算很慢，所以：
 *   - 不把输出接进 Select-Object，否则 PowerShell 会缓冲到进程结束才显示
 *   - 每 15 秒打一次进度（页面上的状态文本 + 已用时间）
 *   - 点击前先报告「计算」按钮是否可用、养成校验还剩几项
 */
const fs = require("node:fs");
const path = require("node:path");
const {chromium} = require(process.env.OURNOTES_PLAYWRIGHT_MODULE || "playwright");

const BASE = process.env.OURNOTES_BROWSER_URL || "http://127.0.0.1:8877/ournotes-planner/";
const PKG_DIR = process.env.OURNOTES_PACKAGE_DIR;
const SHOT = process.env.OURNOTES_SHOT || "plan-panel.png";
const LIMIT_MS = Number(process.env.OURNOTES_PLAN_TIMEOUT_MS || 1800000);

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await chromium.launch({headless: true, channel: process.env.OURNOTES_BROWSER_CHANNEL || undefined});
    const page = await (await browser.newContext({viewport: {width: 1500, height: 1500}})).newPage();
    page.on("pageerror", e => console.error("[pageerror]", e.message));
    page.on("console", m => { if (m.type() === "error") console.error("[console]", m.text().slice(0, 200)); });
    let failed = false;
    try {
        await page.goto(BASE, {waitUntil: "domcontentloaded"});
        await page.waitForFunction(() => window.PlannerAccount?.current?.(), null, {timeout: 180000});
        console.log("[1] 页面就绪");

        if (PKG_DIR) {
            const files = fs.readdirSync(PKG_DIR).map(n => path.join(PKG_DIR, n));
            await page.locator('[data-tab="account"]').click();
            await page.locator('#accountImportRoot input[type="file"]').first().setInputFiles(files);
            await page.waitForSelector("#accountReport button", {timeout: 120000});
            await page.waitForTimeout(1500);
            const merge = page.locator("#accountReport button").first();
            if (await merge.count()) { await merge.click(); await page.waitForTimeout(2500); }
            console.log("[2] 已导入并合并卡库");
        }

        await page.locator('[data-tab="plan"]').click();
        await page.waitForTimeout(1000);

        const pre = await page.evaluate(() => ({
            calcDisabled: document.getElementById("calculate")?.disabled,
            growth: document.getElementById("growthCheckTitle")?.innerText,
            candidates: window.PlannerAccount.current()?.candidate_member_ids?.length,
        }));
        console.log("[3] 计算按钮 disabled =", pre.calcDisabled, "| 候选成员卡", pre.candidates);
        console.log("    养成校验:", pre.growth);

        console.log("[4] 点「计算两种最优收益」…");
        const t0 = Date.now();
        await page.locator("#calculate").click();

        let done = false;
        while (Date.now() - t0 < LIMIT_MS) {
            await sleep(15000);
            const s = await page.evaluate(() => {
                const el = document.getElementById("results");
                const box = document.getElementById("progressBox");
                return {
                    slots: document.querySelectorAll("#results .deck-slot").length,
                    visible: el && !el.hidden,
                    progress: box ? (box.innerText || "").replace(/\s+/g, " ").slice(0, 160) : "",
                };
            });
            const secs = Math.round((Date.now() - t0) / 1000);
            console.log(`    ${secs}s  槽位=${s.slots}  结果可见=${s.visible}  ${s.progress ? "状态: " + s.progress : ""}`);
            if (s.slots > 0) { done = true; break; }
        }
        if (!done) throw new Error(`等了 ${Math.round((Date.now() - t0) / 1000)} 秒仍无结果`);
        console.log(`[5] 结果已出现，用时 ${Math.round((Date.now() - t0) / 1000)} 秒`);
        await page.waitForTimeout(3000);

        const details = page.locator("#results details").first();
        if (await details.count()) { await details.evaluate(el => { el.open = true; }); await page.waitForTimeout(1500); }

        // 结果区里的图都带 loading="lazy"，没滚到的位置根本不会去请求，
        // 直接统计会把「还没加载」误报成「加载失败」。这里先强制全部立即加载。
        await page.evaluate(() => {
            document.querySelectorAll("#results details").forEach(d => { d.open = true; });
            document.querySelectorAll("#results img").forEach(i => {
                i.loading = "eager";
                const src = i.getAttribute("src");   // 重新赋值触发一次加载
                i.setAttribute("src", src);
            });
        });
        await page.waitForTimeout(6000);

        const stats = await page.evaluate(() => {
            const grab = sel => {
                const imgs = [...document.querySelectorAll(sel)];
                return {total: imgs.length, loaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length,
                        broken: imgs.filter(i => i.complete && i.naturalWidth === 0).map(i => i.getAttribute("src")).slice(0, 6)};
            };
            return {
                slots: document.querySelectorAll("#results .deck-slot").length,
                deck: grab("#results .deck-art img"),
                cover: grab("#results .song-cover"),
                coverSample: [...document.querySelectorAll("#results .song-cover")].slice(0, 3).map(i => i.getAttribute("src")),
                firstSlot: document.querySelector("#results .deck-slot")?.innerText?.replace(/\s+/g, " ").slice(0, 150),
            };
        });
        console.log(`[6] 队伍槽位 ${stats.slots}`);
        console.log(`    成员/Snap 卡图 ${stats.deck.loaded}/${stats.deck.total} 加载成功`, stats.deck.broken.length ? JSON.stringify(stats.deck.broken) : "");
        console.log(`    乐曲封面     ${stats.cover.loaded}/${stats.cover.total} 加载成功`, stats.cover.broken.length ? JSON.stringify(stats.cover.broken) : "");
        console.log("    封面示例:", JSON.stringify(stats.coverSample));
        console.log("    首槽位:", JSON.stringify(stats.firstSlot));

        await page.locator("#results").screenshot({path: SHOT});
        console.log("[7] 已截图:", SHOT);
        if (stats.deck.total === 0 || stats.deck.loaded !== stats.deck.total) { console.error("成员卡图未全部加载"); failed = true; }
        if (stats.cover.total === 0 || stats.cover.loaded !== stats.cover.total) { console.error("乐曲封面未全部加载"); failed = true; }
    } catch (e) {
        failed = true;
        console.error("!!! 失败:", e.message);
        try { await page.locator("#plan").screenshot({path: "plan-failure.png"}); console.error("已截图 plan-failure.png"); } catch {}
    } finally {
        await browser.close();
    }
    process.exit(failed ? 1 : 0);
})();
