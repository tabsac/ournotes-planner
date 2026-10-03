/**
 * 数据刷新后「有卡但没卡图」的兜底检查。
 *
 * 卡图来自配队程序的固定快照，主数据却能一键刷新，所以两者会脱节 ——
 * 实测刷到 1.0.0.300 时 members-64 / snaps-70 就是只有数据没有图。
 * 这里确认：缺图会换成内联 SVG 占位，而且正常卡图不受影响。
 */
const {chromium} = require(process.env.OURNOTES_PLAYWRIGHT_MODULE || "playwright");
const BASE = process.env.OURNOTES_BROWSER_URL || "http://127.0.0.1:8877/ournotes-planner/";

const MISSING = ["card-images/members-64.webp", "card-images/snaps-70.webp"];
const PRESENT = "card-images/members-1.webp";

(async () => {
    const browser = await chromium.launch({headless: true, channel: process.env.OURNOTES_BROWSER_CHANNEL || undefined});
    const page = await (await browser.newContext()).newPage();
    let failed = false;
    try {
        await page.goto(BASE, {waitUntil: "domcontentloaded"});
        await page.waitForFunction(() => window.PlannerAccount, null, {timeout: 120000});

        // 一次 evaluate 里把两张缺图和一张正常图都跑完，逻辑和 _diag_fallback.cjs 保持一致
        const result = await page.evaluate(async ({missing, present}) => {
            const probe = async (path) => {
                const img = new Image();
                document.body.append(img);
                img.src = "./" + path;
                await new Promise(r => setTimeout(r, 2000));
                const out = {
                    src: img.getAttribute("src") || "",
                    loaded: img.naturalWidth > 0,
                    fallbackFlag: img.dataset.cardFallback === "1",
                };
                img.remove();
                return out;
            };
            const missingResults = [];
            for (const path of missing) missingResults.push({path, ...await probe(path)});
            return {missingResults, present: {path: present, ...await probe(present)}};
        }, {missing: MISSING, present: PRESENT});

        for (const item of result.missingResults) {
            const swapped = item.src.startsWith("data:image/svg+xml");
            const ok = swapped && item.loaded && item.fallbackFlag;
            console.log(`   ${ok ? "[OK]  " : "[FAIL]"} ${item.path}  换了占位图=${swapped}`
                + `  占位图已渲染=${item.loaded}  标记=${item.fallbackFlag}`);
            if (!ok) failed = true;
        }

        const good = result.present;
        const ok = good.src.includes("members-1.webp") && good.loaded && !good.fallbackFlag;
        console.log(`   ${ok ? "[OK]  " : "[FAIL]"} ${good.path}  正常卡图未被误伤`
            + `  src=${good.src.slice(-18)}  已渲染=${good.loaded}`);
        if (!ok) failed = true;
    } catch (e) {
        console.error("!!! 失败:", e.message);
        failed = true;
    } finally {
        await browser.close();
    }
    console.log(failed ? "\n有未通过项" : "\n全部通过");
    process.exit(failed ? 1 : 0);
})();
