// 精确排查：等 App 真正就绪后，看桥接能不能拿到 state、点击 tab 是否生效
const {chromium} = require("playwright");
const BASE = process.env.OURNOTES_BROWSER_URL || "http://127.0.0.1:8877/ournotes-planner/";
(async () => {
    const browser = await chromium.launch({headless: true, channel: process.env.OURNOTES_BROWSER_CHANNEL || undefined});
    const page = await browser.newPage();
    page.on("pageerror", e => console.log("PAGEERROR:", e.message));
    await page.goto(BASE, {waitUntil: "domcontentloaded"});

    console.log("等 App 就绪（ownedCount 出现数字）…");
    await page.waitForFunction(() => /\+/.test(document.getElementById("ownedCount")?.textContent || ""), null, {timeout: 180000});
    await page.waitForTimeout(1500);

    const snap = async (label) => {
        const r = await page.evaluate(() => ({
            ownedCount: document.getElementById("ownedCount")?.textContent,
            profileName: document.getElementById("profileName")?.textContent,
            bridgeCurrent: (() => {
                try {
                    const s = window.PlannerAccount?.current?.();
                    return s ? {name: s.name, members: s.profile?.inventory?.members?.length, keys: Object.keys(s).slice(0, 8)} : String(s);
                } catch (e) { return "ERR " + e.message; }
            })(),
            bridgeCatalog: (() => {
                try { const c = window.PlannerAccount?.catalog?.(); return c ? {members: c.members?.length, snaps: c.snaps?.length} : String(c); }
                catch (e) { return "ERR " + e.message; }
            })(),
            tabs: Array.from(document.querySelectorAll(".tab-page")).map(s => s.id + (s.hidden ? ":H" : ":V")).join(" "),
        }));
        console.log(label, JSON.stringify(r));
    };

    await snap("就绪后:");

    console.log("\n点「我的卡库」（App 自己的 tab）");
    await page.click('button[data-tab="inventory"]');
    await page.waitForTimeout(500);
    await snap("  ->");

    console.log("\n点「收益规划」回来");
    await page.click('button[data-tab="plan"]');
    await page.waitForTimeout(500);
    await snap("  ->");

    console.log("\n点「账号包导入」（我加的 tab）");
    await page.click('button[data-tab="account"]');
    await page.waitForTimeout(500);
    await snap("  ->");

    await browser.close();
})();
