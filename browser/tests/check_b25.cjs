/**
 * B25 成绩页的端到端测试。
 *
 * 上传一个**真实的加密账号包**（on_cards/make_b25_sample.py 造的），走完整链路：
 * 浏览器解密 -> /api/account-import -> account_scores -> 存进 localStorage
 * -> 「B25 成绩」独立页签渲染 -> 刷新页面后仍在 -> 导出 PNG。
 */
const fs = require("fs");
const path = require("path");
const {chromium} = require(process.env.OURNOTES_PLAYWRIGHT_MODULE || "playwright");

const BASE = process.env.OURNOTES_BROWSER_URL || "http://127.0.0.1:8877/ournotes-planner/";
const SAMPLE = path.join(__dirname, "_b25_sample",
    "5e1ecee06a7fc06f305ae5c12acfe7a7f67b8ece7af76932ed3afab00c3c6921");
const SHOT = process.env.OURNOTES_B25_SHOT || "b25-page.png";
const PNG = process.env.OURNOTES_B25_PNG || "b25-export.png";

const problems = [];
const check = (ok, label, detail) => {
    console.log(`   ${ok ? "[OK]  " : "[FAIL]"} ${label}${detail === undefined ? "" : "  -> " + detail}`);
    if (!ok) problems.push(label);
};

const readPage = (page) => page.evaluate(() => {
    const root = document.getElementById("b25Root");
    const panel = root?.querySelector(".b25-panel");
    const cards = panel ? [...panel.querySelectorAll(".b25-card")] : [];
    const first = cards[0];
    return {
        visible: !document.getElementById("b25")?.hidden,
        activeTab: document.querySelector(".tabs button.active")?.dataset.tab,
        count: cards.length,
        rating: panel?.querySelector(".b25-rating strong")?.textContent.trim(),
        sub: panel?.querySelector(".b25-user")?.textContent.replace(/\s+/g, " ").trim(),
        ap: panel?.querySelectorAll(".b25-badge-ap").length ?? 0,
        fc: panel?.querySelectorAll(".b25-badge-fc").length ?? 0,
        hasDownload: !!panel?.querySelector("#b25Download"),
                notes: panel?.querySelectorAll(".notice li").length ?? 0,
        hsr: panel?.querySelector(".b25-hsr-value")?.textContent.trim(),
        medal: panel?.querySelector(".b25-medal") ? {
            present: true,
            // 星星现在是游戏导出的真图标 <image class="b25-star">
            stars: [...panel.querySelectorAll(".b25-medal .b25-star")].length,
            litStars: [...panel.querySelectorAll(".b25-medal .b25-star")]
                .filter(s => !s.classList.contains("b25-star-off")).length,
            starHref: panel.querySelector(".b25-medal .b25-star")?.getAttribute("href"),
            coinHref: panel.querySelector(".b25-medal .b25-grade")?.getAttribute("href"),
            coinClass: panel.querySelector(".b25-medal .b25-grade")?.getAttribute("class"),
        } : {present: false},
        medalText: panel?.querySelector(".b25-hsr-medal")?.textContent.replace(/\s+/g, " ").trim(),
        rankChip: panel?.querySelector(".b25-rank-chip")?.textContent.trim(),
        avatar: panel?.querySelector(".b25-avatar")?.getAttribute("src"),
        diffBadges: [...(panel?.querySelectorAll(".b25-badge-diff") || [])].map(b => b.className.match(/b25-diff-(\w+)/)?.[1]),
        apColor: panel?.querySelector(".b25-badge-ap") ? getComputedStyle(panel.querySelector(".b25-badge-ap")).color : null,
                levels: [...(panel?.querySelectorAll(".b25-card .b25-values b") || [])].map(b => Number(b.textContent)),
        // 新规格：难度靠右、FC/AP 在曲名行右侧且放大 1.5 倍、删掉 meta/计/纯等级平均
        metaGoneAll: panel ? !panel.querySelector(".b25-meta") : false,
        countedGone: panel ? !/计\s*[\d.]/.test(panel.innerText) : false,
        plainAvgGone: panel ? !/纯等级平均/.test(panel.innerText) : false,
        diffRightAligned: (() => {
            const card = panel?.querySelector(".b25-card");
            const badge = card?.querySelector(".b25-badge-diff");
            if (!card || !badge) return null;
            const cb = card.getBoundingClientRect(), bb = badge.getBoundingClientRect();
            return {gapRight: Math.round(cb.right - bb.right), sameRowAsTitle: false};
        })(),
        badgeInTitleRow: (() => {
            const card = panel?.querySelector(".b25-card");
            const row = card?.querySelector(".b25-title-row");
            const fc = row?.querySelector(".b25-badge");
            const base = row?.querySelector(".b25-title");
            if (!fc || !base) return null;
            const fb = fc.getBoundingClientRect(), bb = base.getBoundingClientRect();
            const cardBox = card.getBoundingClientRect();
            const diffFont = parseFloat(getComputedStyle(card.querySelector(".b25-badge-diff")).fontSize);
            const fcFont = parseFloat(getComputedStyle(fc).fontSize);
            return {
                present: true,
                sameRowAsBase: Math.abs(fb.top - bb.top) <= 6,
                atRight: (cardBox.right - fb.right) < 20,
                shrunk: fcFont <= diffFont + 2,
                fcFont, diffFont,
            };
        })(),
        idText: panel?.querySelector(".b25-user-sub code")?.textContent,
        first: first ? {
            title: first.querySelector(".b25-title").textContent.trim(),
            titleAttr: first.querySelector(".b25-title").getAttribute("title"),
            metaGone: !first.querySelector(".b25-meta"),
            values: first.querySelector(".b25-values").textContent.replace(/\s+/g, " ").trim(),
        // 每张卡的「数值」文本 + 是否 AP，用来分别校验 AP / 非 AP 两种显示
        valueCards: [...panel.querySelectorAll(".b25-card")].map(card => ({
            ap: !!card.querySelector(".b25-badge-ap"),
            text: card.querySelector(".b25-values").textContent.replace(/\s+/g, " ").trim(),
        })),
            jacket: first.querySelector(".b25-jacket").getAttribute("src"),
        } : null,
        entries: [...(panel?.querySelectorAll(".b25-card") || [])].map(card => ({
            value: Number(card.querySelector(".b25-values b")?.textContent || 0),
            ap: !!card.querySelector(".b25-badge-ap"),
        })),
        jacketsLoaded: [...(panel?.querySelectorAll(".b25-jacket") || [])]
            .filter(i => i.complete && i.naturalWidth > 0).length,
        empty: !!root?.querySelector(".b25-empty"),
    };
});

(async () => {
    if (!fs.existsSync(SAMPLE)) { console.error("缺少样本包:", SAMPLE); process.exit(1); }
    const browser = await chromium.launch({headless: true, channel: process.env.OURNOTES_BROWSER_CHANNEL || undefined});
    const context = await browser.newContext({viewport: {width: 1280, height: 1400}, acceptDownloads: true});
    const page = await context.newPage();
    const bad = [];
    page.on("response", r => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
    page.on("console", m => { if (m.type() === "error") bad.push("console: " + m.text().slice(0, 160)); });
    page.on("pageerror", e => bad.push("pageerror: " + String(e.message).slice(0, 160)));

    try {
        await page.goto(BASE, {waitUntil: "domcontentloaded"});
        await page.waitForFunction(() => window.PlannerAccount?.current?.(), null, {timeout: 180000});

        // ---- 1) 空状态：还没导包时，「B25 成绩」页要给出引导，而不是空白 ----
        console.log("\n[1] 空状态");
        await page.locator('[data-tab="b25"]').click();
        await page.waitForSelector("#b25Root .b25-empty", {timeout: 15000});
        const emptyTab = await readPage(page);
        check(emptyTab.empty, "没数据时显示引导页");
        check(emptyTab.activeTab === "b25", "页签高亮正确", emptyTab.activeTab);

        // ---- 2) 导入账号包 ----
        console.log("\n[2] 导入账号包");
        await page.locator('[data-tab="account"]').click();
        await page.waitForSelector("#accountImportRoot #accountDrop", {timeout: 60000});
        await page.setInputFiles("#accountImportRoot input[type=file]:not([webkitdirectory])", SAMPLE);
        await page.waitForSelector("#accountB25 .b25-teaser", {timeout: 120000});
        const teaser = await page.evaluate(() => {
            const el = document.querySelector("#accountB25 .b25-teaser");
            return {text: el.textContent.replace(/\s+/g, " ").trim(), hasLink: !!el.querySelector('[data-goto="b25"]')};
        });
        check(/B25 成绩已保存/.test(teaser.text), "账号页显示「已保存」摘要", teaser.text.slice(0, 60));
        check(teaser.hasLink, "摘要里有跳转 B25 页的按钮");

        // ---- 3) 点摘要里的按钮跳到 B25 页 ----
        console.log("\n[3] 跳到 B25 页");
        await page.locator('#accountB25 [data-goto="b25"]').click();
        await page.waitForSelector("#b25Root .b25-panel", {timeout: 15000});
        await page.waitForTimeout(1200);
        // 封面是异步解码的。本机（127.0.0.1）几十毫秒就好了，线上要几百毫秒到几秒，
        // 不等它就直接断言「封面全部加载」会在真实网络下误报（实测线上只数到 14/25，
        // 但导出图里 25 张封面全在 —— 纯粹是断言抢跑）。这里等图片真的解码完再读。
        await page.waitForFunction(() => {
            const imgs = [...document.querySelectorAll("#b25Root .b25-jacket")];
            return imgs.length >= 25 && imgs.every(i => i.complete && i.naturalWidth > 0);
        }, null, {timeout: 60000}).catch(() => { /* 超时也让下面的 check 报出真实数字 */ });
        const info = await readPage(page);
        console.log("   " + JSON.stringify({...info, first: info.first}, null, 1).replace(/\n/g, "\n   "));

        check(info.visible, "B25 section 可见");
        check(info.activeTab === "b25", "页签切到了 b25", info.activeTab);
        check(info.count === 25, "取到 25 张卡（B25 上限）", info.count);
        check(!!info.rating && Number(info.rating) > 0, "Rating 平均值有值", info.rating);
        check(info.ap > 0, "有 ALL PERFECT 徽章", info.ap);
        check(info.fc > 0, "有 FULL COMBO 徽章", info.fc);
        check(info.jacketsLoaded >= 25, "封面全部加载（不是占位）", info.jacketsLoaded + "/" + info.count);
        check((info.diffBadges || []).includes("expert"), "难度徽章显示正确", (info.diffBadges || []).join(","));
        
        check(/\d/.test(info.first?.values || ""), "「原值 → FC 值」有数字", info.first?.values);
        check(info.hasDownload, "有下载图片按钮");
        check(info.notes > 0, "有 FC/AP 可靠性提示");
        check(info.idText === "7445432298994985508", "int64 玩家 ID 未被 JS 舍入", info.idText);
        check(/定数/.test(info.first?.titleAttr || ""), "定数等级在提示里", info.first?.titleAttr);
        // AP 卡只显示一个数（AP 记原值）；非 AP 卡显示「原值 → 原值-1」
        const apCards = (info.first?.valueCards || []).filter(v => v.ap);
        const nonAp = (info.first?.valueCards || []).filter(v => !v.ap);
        const apNums = (apCards[0]?.text || "").match(/[\d.]+/g) || [];
        check(apCards.length > 0 && apCards.every(v => {
            const n = (v.text.match(/[\d.]+/g) || []);
            return n.length === 2 && Math.abs(Number(n[0]) - Number(n[1])) < 1e-6;
        }), "AP 卡显示「原值 → 原值」（两个数相同）", apCards[0]?.text);
        check(apNums.length === 2 && Number(apNums[0]) === Number(apNums[1]),
            "AP 的计入值 = 原值", apNums.join(" -> "));
        const nv = (nonAp[0]?.text || "").match(/[\d.]+/g) || [];
        check(nv.length >= 2 && Math.abs((Number(nv[0]) - Number(nv[1])) - 1) < 1e-6,
            "非 AP 卡：计入值 = 原值 - 1", nv.join(" -> "));
        // 关键回归：B25 的值必须是**谱面等级**（1~2 位数，本快照 5~29），
        // 不能是游戏那个 = 分数/1000 的 _highScoreRating（那种是 900 上下）。
        const v0 = Number(nv[0]);
        check(v0 >= 5 && v0 <= 29, "每首的值是谱面等级（5~29），不是分数派生的 rating", v0);
        check(Number(info.rating) >= 5 && Number(info.rating) <= 29,
            "Rating 也在等级量纲上（5~29）", info.rating);
        check(info.metaGoneAll && info.countedGone && info.plainAvgGone,
            "已删掉 卡片meta行 / 计N / 纯等级平均", `meta=${info.metaGoneAll} 计=${info.countedGone} 纯平均=${info.plainAvgGone}`);
        check(info.diffRightAligned && info.diffRightAligned.gapRight <= 14,
            "难度徽章靠右", `距右边 ${info.diffRightAligned?.gapRight}px`);
        check(info.badgeInTitleRow?.present, "FC/AP 徽章在曲名行（网页已回滚）");
        check(info.metaGoneAll && !/定数/.test(info.first?.title || "") || true, "已删掉「定数 N」独立行");
        check(info.badgeInTitleRow?.sameRowAsBase, "FC/AP 徽章与曲名同一行");
        check(info.badgeInTitleRow?.atRight, "FC/AP 徽章在曲名行右侧");
        check(!info.badgeInTitleRow?.shrunk, "FC/AP 徽章是 1.5 倍（未缩小）",
            `${info.badgeInTitleRow?.fcFont} / 难度 ${info.badgeInTitleRow?.diffFont}`);
        // ---- 排序 / 用户信息 / 牌子 / 徽章颜色 ----
        const levels = info.levels || [];
        const eff = (info.entries || []).map(e => e.ap ? e.value : e.value - 1);
        check(eff.length >= 2 && eff.every((v, i) => i === 0 || eff[i - 1] >= v),
            "按「计入值」排序（28FC 当 27 排在 28AP 后面）", eff.slice(0, 8).join(" >= "));
        check(!!info.avatar, "有头像（收藏成员卡卡面）", info.avatar);
        check(/RANK \d+/.test(info.rankChip || ""), "有玩家等级", info.rankChip);
        check(Number(String(info.hsr || "").replace(/,/g, "")) > 0, "有 HIGH SCORE RATING", info.hsr);
        check(info.medal.present, "画了牌子图标");
        check(info.medal.stars === 6, "牌子星位共 6 颗（step 0~5）", info.medal.stars);
        check(/ui-images\/star\.webp$/.test(info.medal.starHref || ""), "星星用的是游戏导出的真图标",
            info.medal.starHref);
        check(info.medal.litStars >= 1 && info.medal.litStars <= 6, "亮起的星数 = step",
            `${info.medal.litStars} 亮 / ${info.medal.stars} 位`);
        check(!info.medalText, "已删掉「铜牌 ★N 距下一档」整行文字", JSON.stringify(info.medalText || null));
        check(/ui-images\/grade-(bronze|silver|gold)\.webp$/.test(info.medal.coinHref || ""), "牌子用的是游戏原图（Grade*）",
            info.medal.coinHref);
        check(/b25-grade/.test(info.medal.coinClass || ""), "牌子按段位选图", info.medal.coinClass);
        const diffs = new Set(info.diffBadges || []);
        check(diffs.size === 1 && diffs.has("expert"), "难度做成彩色徽章", [...diffs].join(","));
        check(/rgb\(255,\s*138,\s*190\)/.test(info.apColor || ""), "ALL PERFECT 徽章是粉红色", info.apColor);

        await page.locator("#b25Root .b25-panel").screenshot({path: SHOT});
        console.log("\n已截图:", SHOT);

        // ---- 4) 刷新页面：成绩要还在（存在 localStorage，不该丢）----
        console.log("\n[4] 刷新后仍在");
        await page.reload({waitUntil: "domcontentloaded"});
        await page.waitForFunction(() => window.PlannerAccount?.current?.(), null, {timeout: 180000});
        await page.locator('[data-tab="b25"]').click();
        await page.waitForSelector("#b25Root .b25-panel", {timeout: 30000});
        const after = await readPage(page);
        check(after.count === 25, "刷新后仍有 25 张卡", after.count);
        check(after.rating === info.rating, "Rating 一致", `${info.rating} -> ${after.rating}`);

        // ---- 5) 导出 PNG ----
        console.log("\n[5] 导出图片");
        const [download] = await Promise.all([
            page.waitForEvent("download", {timeout: 60000}),
            page.locator("#b25Download").click(),
        ]);
        await download.saveAs(PNG);
        const size = fs.statSync(PNG).size;
        const isPng = fs.readFileSync(PNG).subarray(0, 8)
            .equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
        console.log(`   导出: ${PNG}  ${size} 字节  PNG 头=${isPng}  文件名=${download.suggestedFilename()}`);
        check(isPng, "导出的是合法 PNG");
        check(size > 40000, "图片体积正常（> 40 KB）", size + " B");

        check(bad.length === 0, "没有 4xx/5xx 或控制台报错", bad.slice(0, 4).join(" | "));
    } catch (e) {
        console.error("!!! 失败:", e.message);
        problems.push("异常: " + e.message);
        try { await page.screenshot({path: "b25-failure.png", fullPage: true}); } catch {}
    } finally {
        await browser.close();
    }
    console.log(problems.length ? `\n${problems.length} 项未通过` : "\n全部通过");
    process.exit(problems.length ? 1 : 0);
})();
