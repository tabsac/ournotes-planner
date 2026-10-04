/**
 * 「云端结果」端到端检查：用本地替身服务器（mock_api_server.cjs）跑完整链路。
 *
 * 覆盖：
 *   ① 没配地址时**一个请求都不发**、也没有控制台报错（公开站点的状态）
 *   ② 登录码登录（错的码要被挡）
 *   ③ 把本机卡片存到云端（POST）
 *   ④ **换设备**（全新 context、没有 localStorage）登录后取回，卡片完整还原
 *   ⑤ 覆盖更新走 PUT + 版本冲突返回 409
 *   ⑥ 服务器挂掉时：本地卡片照常显示，面板只写错误，不崩
 *
 *   node browser/tests/check_cloud_sync.cjs            （需要 browser/dist 已构建）
 */
const fs = require("fs");
const path = require("path");
const {spawn} = require("child_process");
const {chromium} = require(process.env.OURNOTES_PLAYWRIGHT_MODULE || "playwright");

const ROOT = path.resolve(__dirname, "../..");
const PYTHON = process.env.OURNOTES_PYTHON || (process.platform === "win32" ? "python" : "python3");
const PREVIEW_PORT = Number(process.env.CLOUD_CHECK_PORT || 8879);
const API_PORT = Number(process.env.CLOUD_CHECK_API_PORT || 8907);
const BASE = `http://127.0.0.1:${PREVIEW_PORT}/ournotes-planner/`;
const API_BASE = "/cloud-api";                       // 同源代理前缀（CSP 只需 'self'）
const SAMPLE = path.join(__dirname, "_b25_sample",
    "5e1ecee06a7fc06f305ae5c12acfe7a7f67b8ece7af76932ed3afab00c3c6921");
const SHOT_DIR = process.env.OURNOTES_CLOUD_SHOT_DIR || path.join(ROOT, "work/cloud-check");

const problems = [];
const check = (ok, label, detail) => {
    console.log(`   ${ok ? "[OK]  " : "[FAIL]"} ${label}${detail === undefined ? "" : "  -> " + detail}`);
    if (!ok) problems.push(label);
};

const waitFor = (child, marker, timeout = 30000) => new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`启动超时，没看到「${marker}」：${buffer.slice(-400)}`)), timeout);
    const onData = chunk => {
        buffer += String(chunk);
        if (buffer.includes(marker)) { clearTimeout(timer); child.stdout.off("data", onData); resolve(buffer); }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", chunk => { buffer += String(chunk); });
    child.on("exit", code => { clearTimeout(timer); reject(new Error(`进程提前退出(${code})：${buffer.slice(-400)}`)); });
});

const started = [];
function launch(command, args, marker) {
    const child = spawn(command, args, {cwd: ROOT, stdio: ["ignore", "pipe", "pipe"]});
    started.push(child);
    return waitFor(child, marker).then(() => child);
}

function stopAll() {
    for (const child of started) { try { child.kill(); } catch { /* 忽略 */ } }
}

const cloudState = page => page.evaluate(() => {
    const panel = document.querySelector("#cloudPanel");
    return {
        present: !!panel,
        open: !!panel?.querySelector("#cloudDetails")?.open,
        state: panel?.querySelector("#cloudState")?.textContent.trim(),
        msg: panel?.querySelector("#cloudMsg")?.textContent.trim(),
        error: !!panel?.querySelector("#cloudMsg.cloud-error"),
        items: [...(panel?.querySelectorAll(".cloud-item") || [])].map(li => ({
            title: li.querySelector("b")?.textContent.trim(),
            load: !!li.querySelector("[data-cloud-load]"),
        })),
        loggedIn: !!panel?.querySelector("#cloudLogout"),
    };
});

const cardState = page => page.evaluate(() => {
    const panel = document.querySelector("#b25Root .b25-panel");
    return {
        count: panel ? panel.querySelectorAll(".b25-card").length : 0,
        rating: panel?.querySelector(".b25-rating strong")?.textContent.trim() || null,
        empty: !!document.querySelector("#b25Root .b25-empty"),
        firstName: panel?.querySelector(".b25-card .b25-title")?.textContent.trim() || null,
    };
});

const openApp = async (context, {apiBase = API_BASE} = {}) => {
    const page = await context.newPage();
    const bad = [];
    const apiCalls = [];
    page.on("response", r => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
    page.on("console", m => { if (m.type() === "error") bad.push("console: " + m.text().slice(0, 200)); });
    page.on("pageerror", e => bad.push("pageerror: " + String(e.message).slice(0, 200)));
    page.on("request", r => { if (r.url().includes("/cloud-api/")) apiCalls.push(r.url()); });
    await page.addInitScript(base => {
        if (base === null) localStorage.removeItem("ournotes-cloud-api-base");
        else localStorage.setItem("ournotes-cloud-api-base", base);
    }, apiBase);
    await page.goto(BASE, {waitUntil: "domcontentloaded"});
    await page.waitForFunction(() => window.PlannerAccount?.current?.(), null, {timeout: 180000});
    return {page, bad, apiCalls};
};

const gotoB25 = async page => {
    await page.locator('[data-tab="b25"]').click();
    await page.waitForSelector("#b25Root .b25-panel, #b25Root .b25-empty", {timeout: 20000});
    await page.waitForSelector("#cloudPanel #cloudDetails", {timeout: 20000});
};

const setPanel = async (page, selector, value) => {
    await page.locator("#cloudPanel #cloudDetails").evaluate(el => { el.open = true; });
    await page.fill(selector, value);
};

const clickAndSettle = async (page, selector) => {
    await page.locator(selector).click();
    // 面板里的操作都是「发请求 → 改状态 → 重画」，等状态稳定下来
    await page.waitForTimeout(600);
};

/** 等到面板上的提示语满足条件（网络失败、代理 502 都要等一小会儿）。 */
const waitForMessage = async (page, pattern, timeout = 6000) => {
    const deadline = Date.now() + timeout;
    let last = null;
    while (Date.now() < deadline) {
        last = await cloudState(page);
        if (pattern.test(last.msg)) return last;
        await page.waitForTimeout(250);
    }
    return last;
};

(async () => {
    if (!fs.existsSync(SAMPLE)) { console.error("缺少样本包:", SAMPLE); process.exit(1); }
    fs.mkdirSync(SHOT_DIR, {recursive: true});

    let mock, preview, browser;
    try {
        mock = await launch(process.execPath, [path.join(__dirname, "mock_api_server.cjs"), String(API_PORT)],
            "mock api:");
        preview = await launch(PYTHON, ["-B", path.join(__dirname, "preview_server.py"),
            "--port", String(PREVIEW_PORT), "--api-proxy", `http://127.0.0.1:${API_PORT}`],
            "Static preview:");
        check(true, "替身服务器 + 预览服务器已起", `:${API_PORT} ← ${API_BASE} ← :${PREVIEW_PORT}`);

        browser = await chromium.launch({headless: true,
            channel: process.env.OURNOTES_BROWSER_CHANNEL || "msedge"});

        // ---- ① 未配置：一个请求都不发 ----
        console.log("\n[1] 没配服务器地址时（公开站点的默认状态）");
        const offlineCtx = await browser.newContext({viewport: {width: 1280, height: 900}});
        const a0 = await openApp(offlineCtx, {apiBase: null});
        await gotoB25(a0.page);
        const off = await cloudState(a0.page);
        check(off.present, "B25 页上有云端面板");
        check(off.state === "未配置", "状态显示未配置", off.state);
        check(a0.apiCalls.length === 0, "没有向服务器发任何请求", a0.apiCalls.length + " 次");
        check(a0.bad.length === 0, "没有控制台报错", a0.bad.slice(0, 3).join(" | "));
        await offlineCtx.close();

        // ---- ②③ 导入账号包 → 登录 → 上传 ----
        console.log("\n[2] 导入账号包并登录");
        const deviceA = await browser.newContext({viewport: {width: 1280, height: 900}});
        const a = await openApp(deviceA);
        await a.page.locator('[data-tab="account"]').click();
        await a.page.waitForSelector("#accountImportRoot #accountDrop", {timeout: 60000});
        await a.page.setInputFiles("#accountImportRoot input[type=file]:not([webkitdirectory])", SAMPLE);
        await a.page.waitForSelector("#accountB25 .b25-teaser", {timeout: 180000});
        await gotoB25(a.page);
        const local = await cardState(a.page);
        check(local.count === 25, "本机卡片已生成（25 张）", local.count);
        const aState = await cloudState(a.page);
        check(aState.state === "未登录", "地址已配置、还没登录", aState.state);

        await setPanel(a.page, "#cloudPanel #cloudCode", "000000");
        await clickAndSettle(a.page, "#cloudPanel #cloudLogin");
        let st = await cloudState(a.page);
        check(st.error && /登录码/.test(st.msg), "错的登录码被挡下并有提示", st.msg);
        check(!st.loggedIn, "没有登录成功");

        await setPanel(a.page, "#cloudPanel #cloudCode", "123456");
        await clickAndSettle(a.page, "#cloudPanel #cloudLogin");
        st = await cloudState(a.page);
        check(st.loggedIn && /已登录/.test(st.state), "正确登录码登录成功", st.state);

        console.log("\n[3] 把当前卡片存到云端");
        await clickAndSettle(a.page, "#cloudPanel #cloudUpload");
        st = await cloudState(a.page);
        check(/已存到云端/.test(st.msg), "上传成功", st.msg);
        check(st.items.length === 1, "云端列表里有 1 条", st.items.length);
        check(/B25 成绩/.test(st.items[0]?.title || ""), "标题是人话", st.items[0]?.title);
        const token = await a.page.evaluate(() => localStorage.getItem("ournotes-cloud-token"));
        const onServer = await (await fetch(`http://127.0.0.1:${API_PORT}/api/results`, {
            headers: {Authorization: "Bearer " + token}})).json();
        check(onServer.length === 1 && onServer[0].size < 256 * 1024,
            "服务器上确实存下了（体积远小于 256 KB）", `${onServer.length} 条 / ${onServer[0]?.size} 字节`);
        const stored = await (await fetch(`http://127.0.0.1:${API_PORT}/api/results/${onServer[0].id}`, {
            headers: {Authorization: "Bearer " + token}})).json();
        // 「不含原始账号包」看的是**结构**：不能有游戏模型的 _xxx 字段，体积也不该是账号包那个量级。
        // （提示语正文里出现 `_liveMusicResults` 这种词是文案，不算数据。）
        const topKeys = Object.keys(stored.payload || {});
        check(!topKeys.some(k => k.startsWith("_")) && onServer[0].size < 64 * 1024
              && stored.payload.entries?.length === 25,
            "上传的是卡片结果（无游戏模型字段，约 10 KB，不是 3 MB 的账号包）",
            `${topKeys.length} 个字段 / ${onServer[0].size} 字节`);
        check(stored.payload.entries?.length === 25, "结果里就是那 25 张卡", stored.payload.entries?.length);
        await a.page.locator("#b25Root .b25-panel").screenshot({path: path.join(SHOT_DIR, "device-a.png")});

        // ---- ④ 换设备取回 ----
        console.log("\n[4] 换一台设备（全新浏览器上下文）取回");
        const deviceB = await browser.newContext({viewport: {width: 1280, height: 900}});
        const b = await openApp(deviceB, {apiBase: null});     // 这台设备连地址都还没配
        await gotoB25(b.page);
        const fresh = await cardState(b.page);
        check(fresh.empty, "新设备上没有本地卡片（是空状态）");
        let bs = await cloudState(b.page);
        check(bs.state === "未配置", "新设备一开始也是未配置", bs.state);
        // 用界面上的「服务器地址 + 保存」把地址配上（顺便测这条路径）
        await setPanel(b.page, "#cloudPanel #cloudBase", API_BASE);
        await clickAndSettle(b.page, "#cloudPanel #cloudSaveBase");
        bs = await cloudState(b.page);
        check(bs.state === "未登录", "保存地址后变成未登录", bs.state);
        await setPanel(b.page, "#cloudPanel #cloudCode", "123456");
        await clickAndSettle(b.page, "#cloudPanel #cloudLogin");
        await clickAndSettle(b.page, "#cloudPanel #cloudRefresh");
        st = await cloudState(b.page);
        check(st.items.length === 1 && st.items[0].load, "云端列表可见且可取回", st.items.length);
        await clickAndSettle(b.page, "#cloudPanel [data-cloud-load]");
        const restored = await cardState(b.page);
        st = await waitForMessage(b.page, /已取回/);
        check(/已取回/.test(st.msg), "取回成功（提示语在卡片重画后仍然在）", st.msg);
        check(restored.count === 25, "新设备上还原出 25 张卡", restored.count);
        check(restored.rating === local.rating, "Rating 与本机一致",
            `${local.rating} -> ${restored.rating}`);
        check(restored.firstName === local.firstName, "第 1 名一致",
            `${local.firstName} -> ${restored.firstName}`);
        await b.page.locator("#b25Root .b25-panel").screenshot({path: path.join(SHOT_DIR, "device-b.png")});
        check(b.bad.length === 0, "新设备上没有控制台报错", b.bad.slice(0, 3).join(" | "));

        // ---- ⑤ 覆盖更新 / 版本冲突 ----
        console.log("\n[5] 覆盖更新与版本冲突");
        await clickAndSettle(a.page, "#cloudPanel #cloudUpload");
        st = await cloudState(a.page);
        check(/已覆盖云端那条结果/.test(st.msg), "第二次上传走「覆盖更新」（PUT）", st.msg);
        const after = await (await fetch(`http://127.0.0.1:${API_PORT}/api/results`, {
            headers: {Authorization: "Bearer " + token}})).json();
        check(after.length === 1, "仍然只有 1 条（没有重复堆积）", after.length);
        const conflict = await fetch(`http://127.0.0.1:${API_PORT}/api/results/${after[0].id}`, {
            method: "PUT",
            headers: {Authorization: "Bearer " + token, "Content-Type": "application/json"},
            body: JSON.stringify({payload: {entries: [1]}, version: 1})});
        const conflictBody = await conflict.json();
        check(conflict.status === 409 && conflictBody.error === "conflict",
            "拿旧版本号写回会被 409 挡住", `${conflict.status} ${conflictBody.error}`);

        // ---- ⑥ 服务器挂掉 ----
        console.log("\n[6] 服务器挂掉时不能影响本地");
        mock.kill();
        await new Promise(r => setTimeout(r, 400));
        await clickAndSettle(a.page, "#cloudPanel #cloudRefresh");
        st = await waitForMessage(a.page, /连不上|服务器|upstream|超时/);
        const stillThere = await cardState(a.page);
        check(st.error, "面板上给出错误提示", st.msg.slice(0, 80) || "(没有提示)");
        check(stillThere.count === 25, "本地卡片照常显示 25 张", stillThere.count);
        // 前面「错的登录码」本来就会产生一次 401，那是**预期内**的，不当作报错
        const unexpected = a.bad.filter(t => !/Failed to load resource|502|ERR_|401 .*\/api\/login/.test(t));
        check(unexpected.length === 0, "除了预期的网络失败/401，没有别的报错",
            unexpected.slice(0, 2).join(" | "));

        await offlineCtx.close?.(); await deviceA.close(); await deviceB.close();
    } catch (error) {
        console.error("!!! 失败:", error.message);
        problems.push("异常: " + error.message);
    } finally {
        if (browser) await browser.close().catch(() => {});
        stopAll();
    }
    console.log(problems.length ? `\n${problems.length} 项未通过` : "\n全部通过");
    process.exit(problems.length ? 1 : 0);
})();
