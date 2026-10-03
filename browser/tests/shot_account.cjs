/**
 * 截图「账号包导入」页并检查下载链接是否可用。
 * 展开教程，并把整页截下来（教程部分单独再截一张）。
 */
const {chromium} = require(process.env.OURNOTES_PLAYWRIGHT_MODULE || "playwright");

const BASE = process.env.OURNOTES_BROWSER_URL || "http://127.0.0.1:8877/ournotes-planner/";
const SHOT = process.env.OURNOTES_SHOT || "account-tab.png";
const HELP_SHOT = process.env.OURNOTES_HELP_SHOT || "account-help.png";

(async () => {
    const browser = await chromium.launch({headless: true, channel: process.env.OURNOTES_BROWSER_CHANNEL || undefined});
    const page = await (await browser.newContext({viewport: {width: 1200, height: 1200}})).newPage();
    const bad = [];
    page.on("response", r => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
    let failed = false;
    try {
        await page.goto(BASE, {waitUntil: "domcontentloaded"});
        await page.waitForFunction(() => window.PlannerAccount?.current?.(), null, {timeout: 180000});
        await page.locator('[data-tab="account"]').click();
        await page.waitForSelector("#accountImportRoot #accountDrop", {timeout: 60000});
        await page.waitForTimeout(800);

        const links = await page.evaluate(() => [...document.querySelectorAll("#accountImportRoot a[download], #accountImportRoot a[target]")]
            .map(a => ({text: a.textContent.trim().slice(0, 44), href: a.getAttribute("href")})));
        console.log("下载/外链:");
        for (const l of links) console.log(`   ${l.href}   ${l.text}`);

        await page.locator("#accountImportRoot").screenshot({path: SHOT});
        console.log("已截图:", SHOT);

        // 展开教程
        await page.locator("#accountImportRoot details.account-help").evaluate(el => { el.open = true; });
        await page.waitForTimeout(600);
        const help = await page.evaluate(() => {
            const b = document.getElementById("accountHelpBody");
            return {
                headings: [...b.querySelectorAll("h4")].map(h => h.textContent.trim()),
                length: b.innerText.length,
                hasZadigRecommend: /用 Zadig 把该设备的驱动换成 WinUSB/.test(b.innerText),
                mentionsTool: /取包工具/.test(b.innerText),
                mentionsWireless: /无线调试/.test(b.innerText),
            };
        });
        console.log("\n教程小节:");
        for (const h of help.headings) console.log("   -", h);
        console.log(`共 ${help.length} 字`);
        console.log(`  含「取包工具」: ${help.mentionsTool}  含「无线调试」: ${help.mentionsWireless}`);
        console.log(`  还在推荐用 Zadig: ${help.hasZadigRecommend}  (必须为 false)`);

        await page.locator("#accountImportRoot details.account-help").screenshot({path: HELP_SHOT});
        console.log("已截图:", HELP_SHOT);

        if (help.hasZadigRecommend) { console.error("教程里还在推荐 Zadig"); failed = true; }
        if (bad.length) { console.error("有 4xx/5xx 请求:", bad.slice(0, 5)); failed = true; }
    } catch (e) {
        failed = true;
        console.error("!!! 失败:", e.message);
    } finally {
        await browser.close();
    }
    process.exit(failed ? 1 : 0);
})();
