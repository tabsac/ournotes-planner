/**
 * 账号系统（v2）+ 云端同步的端到端检查。
 *
 * 覆盖《网页-服务器对接-账号系统变更.md》§6 验收里网页端负责的那几条：
 *   ① 注册 → 自动登录 → 刷新后仍是登录态（GET /api/me 200）
 *   ② 绑定 QQ 全流程：错误 QQ 发送被拒**且码不消耗**；本人发送成功；界面靠 3 秒轮询自动变「已绑定」
 *   ③ 结果：存一条 → 换一个浏览器登录同账号能看到它 → 删除
 *   ④ 卡库：本机编辑 → 自动上传 → 换设备恢复
 *   ⑤ 改密后旧 token 立即失效、被迫重新登录
 *   ⑥ 503（nginx 限流，HTML）：退避重试一次能成功；连续 503 给出「操作太快」提示
 *   ⑦ 未配置后端时零请求零报错；401 清 token；token 不进 URL
 *
 *   node browser/tests/check_cloud_sync.cjs
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
const API_BASE = "/cloud-api";
const SAMPLE = path.join(__dirname, "_b25_sample",
    "5e1ecee06a7fc06f305ae5c12acfe7a7f67b8ece7af76932ed3afab00c3c6921");
const SHOT_DIR = process.env.OURNOTES_CLOUD_SHOT_DIR || path.join(ROOT, "work/cloud-check");

const USERNAME = "karen_" + Math.floor(Date.now() / 1000) % 100000;
const PASSWORD = "web-test-pw-1";
const NEW_PASSWORD = "web-test-pw-2";
const QQ = "44008952";
const WRONG_QQ = "1234567890";

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

const api = (path, options = {}) => fetch(`http://127.0.0.1:${API_PORT}${path}`, {
    ...options,
    headers: {"Content-Type": "application/json", ...(options.headers || {})},
});

const pageState = page => page.evaluate(() => {
    const root = document.getElementById("cloudRoot");
    const text = sel => root?.querySelector(sel)?.textContent.trim() ?? null;
    return {
        configured: !!root?.querySelector("#cloudServerLine"),
        serverLine: text("#cloudServerLine"),
        authVisible: !!root?.querySelector("#cloudAuthBox") && !root.querySelector("#cloudAuthBox").hidden,
        accountVisible: !!root?.querySelector("#cloudAccountBox") && !root.querySelector("#cloudAccountBox").hidden,
        loginVisible: !!root?.querySelector("#cloudSubmit"),
        submitLabel: text("#cloudSubmit"),
        accountName: text(".cloud-account-name"),
        accountLine: text(".cloud-account-row .cloud-dim"),
        msg: text("#cloudMsg"),
        error: !!root?.querySelector("#cloudMsg.cloud-error"),
        badge: document.getElementById("cloudBadge")?.textContent.trim() ?? null,
        results: [...(root?.querySelectorAll("#cloudResultsBox .cloud-item") || [])]
            .map(li => li.querySelector("b")?.textContent.trim()),
        profileLine: root?.querySelector("#cloudProfileBox p.cloud-dim")?.textContent.replace(/\s+/g, " ").trim() ?? null,
        bindOpen: !document.getElementById("cloudBindOverlay")?.hidden,
        bindBody: document.getElementById("cloudBindBody")?.textContent.replace(/\s+/g, " ").trim() ?? "",
        bindCode: document.querySelector(".cloud-code")?.textContent.trim() ?? null,
        hasCopyButton: !!document.getElementById("cloudCopyCmd"),
    };
});

const appState = page => page.evaluate(() => ({
    owned: document.getElementById("ownedCount")?.textContent.trim() ?? null,
    cardCount: document.querySelectorAll("#b25Root .b25-card").length,
    b25Empty: !!document.querySelector("#b25Root .b25-empty"),
    badge: document.getElementById("cloudBadge")?.textContent.trim() ?? null,
}));

async function openApp(context, {apiBase = API_BASE, base = BASE} = {}) {
    const page = await context.newPage();
    const bad = [], calls = [], net = [];
    page.on("response", r => {
        const url = r.url();
        if (url.includes("/api/") || url.includes("/cloud-api/")) {
            const method = r.request().method();
            if (!url.includes("/api/internal/")) net.push({method, url, status: r.status()});
        }
        if (r.status() >= 400 && !url.includes("/cloud-api/api/internal/")) bad.push(`${r.status()} ${url}`);
    });
    page.on("console", m => { if (m.type() === "error") bad.push("console: " + m.text().slice(0, 200)); });
    page.on("pageerror", e => bad.push("pageerror: " + String(e.message).slice(0, 200)));
    page.on("request", r => { if (r.url().includes("/cloud-api/") || r.url().includes("/api/")) calls.push(r.url()); });
    await page.addInitScript(value => {
        if (value === null) localStorage.removeItem("ournotes-cloud-api-base");
        else localStorage.setItem("ournotes-cloud-api-base", value);
    }, apiBase);
    await page.goto(base, {waitUntil: "domcontentloaded"});
    await page.waitForFunction(() => window.PlannerAccount?.current?.(), null, {timeout: 180000});
    await page.waitForSelector("#cloudBadge", {timeout: 20000});
    return {page, bad, calls, net};
}

const gotoCloud = async page => {
    await page.locator('.tabs button[data-tab="cloud"]').click();
    await page.waitForSelector("#cloudRoot .cloud-panel-open", {timeout: 20000});
    await page.waitForTimeout(300);
};

const fill = (page, selector, value) => page.fill(selector, value);
const click = async (page, selector, settle = 700) => {
    await page.locator(selector).click();
    await page.waitForTimeout(settle);
};

(async () => {
    if (!fs.existsSync(SAMPLE)) { console.error("缺少样本包:", SAMPLE); process.exit(1); }
    fs.mkdirSync(SHOT_DIR, {recursive: true});
    // 默认**不构建**：验收要验的是「已经构建好的那份产物」。
    // 想让它顺手构建就设 CLOUD_CHECK_BUILD=1（本地开发时方便）。
    if (process.env.CLOUD_CHECK_BUILD === "1") {
        console.log("构建 dist …");
        const build = spawn(PYTHON, ["-B", "browser/build_browser.py", "--build"], {cwd: ROOT, stdio: "inherit"});
        await new Promise((resolve, reject) => build.on("exit", code => code === 0 ? resolve() : reject(new Error("构建失败"))));
    } else if (!fs.existsSync(path.join(ROOT, "browser/dist/index.html"))) {
        console.error("browser/dist 还没有构建：先跑 python -B browser/build_browser.py --build");
        process.exit(1);
    }

    let browser;
    try {
        await launch(process.execPath, [path.join(__dirname, "mock_account_api.cjs"), String(API_PORT)], "mock account api:");
        await launch(PYTHON, ["-B", path.join(__dirname, "preview_server.py"),
            "--port", String(PREVIEW_PORT), "--api-proxy", `http://127.0.0.1:${API_PORT}`], "Static preview:");
        check(true, "替身后端 + 预览服务器已起", `:${API_PORT} ← ${API_BASE} ← :${PREVIEW_PORT}`);

        browser = await chromium.launch({headless: true, channel: process.env.OURNOTES_BROWSER_CHANNEL || "msedge"});

        // ---- ① 未配置后端：零请求零报错 ----
        // 交付给服务器的那份构建自带「同源」meta，这时「未配置」这条不适用（第 10 条会验它）。
        const builtHtml = fs.readFileSync(path.join(ROOT, "browser/dist/index.html"), "utf8");
        const builtMeta = /<meta name="ournotes-api-base" content="([^"]*)"/.exec(builtHtml);
        console.log("\n[1] 没有后端时（公开镜像站）");
        if (builtMeta) {
            console.log("   [SKIP] 这份构建注入了 api-base（交付构建），改由第 10 条验证同源形态");
        } else {
            const offlineCtx = await browser.newContext({viewport: {width: 1280, height: 1000}});
            const off = await openApp(offlineCtx, {apiBase: null});
            await gotoCloud(off.page);
            let st = await pageState(off.page);
            check(/未启用/.test(st.serverLine || ""), "显示「未启用」并给出官方站点", st.serverLine);
            check(off.calls.length === 0, "一个请求都没发", off.calls.length + " 次");
            check(off.bad.length === 0, "没有控制台报错", off.bad.slice(0, 3).join(" | "));
            await offlineCtx.close();
        }

        // ---- ② 注册 → 自动登录 ----
        console.log("\n[2] 注册 → 自动登录");
        const ctxA = await browser.newContext({viewport: {width: 1280, height: 1000}});
        const a = await openApp(ctxA);
        await gotoCloud(a.page);
        st = await pageState(a.page);
        check(st.loginVisible, "默认显示登录表单", st.submitLabel);
        await click(a.page, '[data-cloud-view="register"]');
        st = await pageState(a.page);
        check(/注册/.test(st.submitLabel || ""), "切到注册模式", st.submitLabel);

        await fill(a.page, "#cloudUsername", USERNAME);
        await fill(a.page, "#cloudPassword", "short");
        await click(a.page, "#cloudSubmit");
        st = await pageState(a.page);
        check(st.error && /至少 8 位/.test(st.msg || ""), "密码太短被前端挡下", st.msg);

        await fill(a.page, "#cloudPassword", PASSWORD);
        await click(a.page, "#cloudSubmit", 1200);
        st = await pageState(a.page);
        check(st.accountVisible && st.accountName === USERNAME, "注册后直接进账号区", st.accountName);
        check(/未绑定 QQ/.test(st.accountLine || ""), "显示未绑定 QQ", st.accountLine);
        check(/karen_|^\S+$/.test(st.badge || ""), "头部标识变成用户名", st.badge);
        const tokenA = await a.page.evaluate(() => localStorage.getItem("ournotes-cloud-token"));
        check(!!tokenA, "token 已存进 localStorage");

        // ---- ③ 刷新后仍是登录态 ----
        console.log("\n[3] 刷新后仍是登录态");
        await a.page.reload({waitUntil: "domcontentloaded"});
        await a.page.waitForFunction(() => window.PlannerAccount?.current?.(), null, {timeout: 120000});
        await gotoCloud(a.page);
        st = await pageState(a.page);
        check(st.accountVisible, "刷新后直接是已登录", st.accountName);
        check(a.calls.some(u => u.includes("/api/me")), "启动时调过 GET /api/me");
        check(a.calls.every(u => !/[?&]token=/.test(u)), "token 从未出现在 URL 里");

        // ---- ④ 绑定 QQ ----
        console.log("\n[4] 绑定 QQ（含发错 QQ 不消耗码）");
        await click(a.page, "#cloudBind");
        st = await pageState(a.page);
        check(st.bindOpen, "弹出绑定窗口");
        await fill(a.page, "#cloudBindQq", "abc");
        await click(a.page, "#cloudBindStart");
        st = await pageState(a.page);
        check(st.error && /QQ 号看起来不对/.test(st.msg || ""), "非法 QQ 被前端挡下", st.msg);

        await fill(a.page, "#cloudBindQq", QQ);
        await click(a.page, "#cloudBindStart", 900);
        st = await pageState(a.page);
        const code = st.bindCode;
        check(!!code && /^\d{6}$/.test(code), "拿到 6 位绑定码（按字符串处理）", code);
        check(st.hasCopyButton && /一键复制命令/.test(st.bindBody || ""), "有「一键复制命令」和三步说明");
        check(st.bindBody.includes(`/on绑定网页 ${code}`), "命令文案正确");

        const wrong = await (await api("/api/internal/bind", {
            method: "POST", body: JSON.stringify({code, qq: WRONG_QQ})})).json();
        check(/不是发给这个 QQ/.test(wrong.message || ""), "用别的 QQ 发被拒", wrong.message);
        await a.page.waitForTimeout(3500);                  // 让它轮询一轮
        st = await pageState(a.page);
        check(st.bindOpen && !st.error && /等待中/.test(st.bindBody || ""),
            "被拒后页面仍在等待（码没被消耗）", st.bindBody.slice(-40));

        const right = await (await api("/api/internal/bind", {
            method: "POST", body: JSON.stringify({code, qq: QQ})})).json();
        check(right.ok === true, "用本人 QQ 发 → 机器人侧绑定成功", JSON.stringify(right));
        await a.page.waitForFunction(() => /已绑定 QQ/.test(document.querySelector("#cloudRoot .cloud-account-row .cloud-dim")?.textContent || ""),
            null, {timeout: 15000});
        await click(a.page, "#cloudBindClose");
        st = await pageState(a.page);
        check(/已绑定 QQ 44008952/.test(st.accountLine || ""), "轮询把界面更新成「已绑定」", st.accountLine);

        // ---- ⑤ 成绩卡结果：上传 → 换设备可见 → 删除 ----
        console.log("\n[5] 成绩卡：上传 → 换设备取回 → 删除");
        await a.page.locator('[data-tab="account"]').click();
        await a.page.waitForSelector("#accountImportRoot #accountDrop", {timeout: 60000});
        await a.page.setInputFiles("#accountImportRoot input[type=file]:not([webkitdirectory])", SAMPLE);
        await a.page.waitForSelector("#accountB25 .b25-teaser", {timeout: 180000});

        // 顺手塞一个敏感字段：客户端**自己**就该剔掉（红线）
        await a.page.evaluate(() => {
            const key = Object.keys(localStorage).find(k => k.startsWith("ournotes-b25-v1"));
            const record = JSON.parse(localStorage.getItem(key));
            record.raw = {access_key: "SHOULD-NEVER-UPLOAD", id_token: "nope"};
            localStorage.setItem(key, JSON.stringify(record));
        });
        await gotoCloud(a.page);
        await click(a.page, "#cloudUploadCard", 1500);
        st = await pageState(a.page);
        check(/已存到云端/.test(st.msg || ""), "成绩卡已上传", st.msg);
        check(/已自动移除 2 项敏感字段/.test(st.msg || ""), "客户端自己剔除了敏感字段", st.msg);
        check(st.results.some(t => /B25 成绩/.test(t)), "列表里出现这条成绩卡", st.results.join(" / "));
        const tokenA2 = await a.page.evaluate(() => localStorage.getItem("ournotes-cloud-token"));
        const serverList = await (await api("/api/results", {headers: {Authorization: "Bearer " + tokenA2}})).json();
        const stored = await (await api("/api/results/" + serverList[0].id,
            {headers: {Authorization: "Bearer " + tokenA2}})).json();
        check(!JSON.stringify(stored.payload).includes("SHOULD-NEVER-UPLOAD"),
            "服务器上那份不含敏感值（上传前已剔除）");

        console.log("\n[5b] 换设备登录同账号可见");
        const ctxB = await browser.newContext({viewport: {width: 1280, height: 1000}});
        const b = await openApp(ctxB);
        await gotoCloud(b.page);
        await fill(b.page, "#cloudUsername", USERNAME);
        await fill(b.page, "#cloudPassword", PASSWORD);
        await click(b.page, "#cloudSubmit", 1200);
        await click(b.page, "#cloudRefresh", 900);
        st = await pageState(b.page);
        check(st.results.length >= 1, "新设备看到云端那条成绩卡", st.results.length);
        await click(b.page, "#cloudResultsBox [data-cloud-load]", 1200);
        const b25 = await b.page.evaluate(() => {
            const key = Object.keys(localStorage).find(k => k.startsWith("ournotes-b25-v1"));
            return key ? JSON.parse(localStorage.getItem(key)).entries.length : 0;
        });
        check(b25 === 25, "取回后本机还原出 25 张卡", b25);
        await b.page.locator('[data-tab="b25"]').click();
        await b.page.waitForSelector("#b25Root .b25-card", {timeout: 15000});
        const cards = await b.page.evaluate(() => document.querySelectorAll("#b25Root .b25-card").length);
        check(cards === 25, "B25 页渲染 25 张卡", cards);

        // ---- ⑥ 卡库云同步 ----
        console.log("\n[6] 卡库云同步（本机改卡库 → 上传 → 换设备恢复）");
        await a.page.locator('[data-tab="inventory"]').click();
        await a.page.waitForSelector("#ownedCount", {timeout: 20000});
        // 浏览器版出厂是**空卡库**（demo 按钮是隐藏的），所以先用应用自己的卡池塞一张卡进去，
        // 否则「恢复成功」是空对空、测不出东西。
        const seeded = await a.page.evaluate(async () => {
            const bootstrap = await (await window.plannerFetch("/api/bootstrap")).json();
            const document_ = window.PlannerProfile.document();
            const memberId = bootstrap.catalog.members[0].id;
            const snapId = bootstrap.catalog.snaps[0].id;
            document_.name = "云同步测试卡库";
            document_.is_demo = false;
            document_.profile.inventory.members = [{id: memberId, level: 20, training_count: 0,
                awakening_count: 0, live_skill_level: 1, gekisou_skill_level: 1}];
            document_.profile.inventory.snaps = [{id: snapId, level: 20, limit_break_count: 0}];
            document_.candidate_member_ids = [memberId];
            document_.candidate_snap_ids = [snapId];
            return window.PlannerProfile.install(document_);
        });
        check(seeded === true, "通过卡库桥塞进 1 张成员卡 + 1 张留影卡");
        await a.page.waitForTimeout(800);
        const sourceOwned = await a.page.evaluate(() => document.getElementById("ownedCount").textContent.trim());
        const sourceName = await a.page.evaluate(() => document.getElementById("profileName").textContent.trim());
        check(sourceOwned === "1 + 1" && sourceName === "云同步测试卡库",
            "A 设备卡库已是非空且可辨认", `${sourceName} · ${sourceOwned}`);
        await gotoCloud(a.page);
        await click(a.page, "#cloudProfilePush", 1500);
        st = await pageState(a.page);
        check(/卡库已上传/.test(st.msg || "") || /已同步/.test(st.profileLine || ""),
            "卡库已上传", st.msg + " | " + st.profileLine);

        await gotoCloud(b.page);
        await click(b.page, "#cloudProfileList", 1200);
        st = await pageState(b.page);
        const profileButton = await b.page.locator("[data-cloud-profile]").count();
        check(profileButton >= 1, "新设备能看到云端卡库", profileButton);
        b.page.once("dialog", dialog => dialog.accept());
        await click(b.page, "[data-cloud-profile]", 1500);
        await b.page.locator('[data-tab="inventory"]').click();
        await b.page.waitForTimeout(800);
        const restoredOwned = await b.page.evaluate(() => document.getElementById("ownedCount").textContent.trim());
        const restoredName = await b.page.evaluate(() => document.getElementById("profileName").textContent.trim());
        check(restoredOwned === sourceOwned, "恢复后卡库一致（已录入卡数相同）", `${sourceOwned} -> ${restoredOwned}`);
        check(restoredName === sourceName, "卡库名也一致", `${sourceName} -> ${restoredName}`);

        // ---- ⑦ 改密：旧 token 立刻失效 ----
        console.log("\n[7] 修改密码 → 旧 token 失效");
        await gotoCloud(a.page);
        await click(a.page, "#cloudChangePw");
        await fill(a.page, "#cloudOldPw", PASSWORD);
        await fill(a.page, "#cloudNewPw", "1234");
        await click(a.page, "#cloudChangePwGo", 1000);
        st = await pageState(a.page);
        check(st.error && /至少 8 位/.test(st.msg || ""), "新密码太短被挡", st.msg);
        await fill(a.page, "#cloudNewPw", NEW_PASSWORD);
        await click(a.page, "#cloudChangePwGo", 1500);
        st = await pageState(a.page);
        check(st.loginVisible, "改密 204 后回到登录表单", st.submitLabel);
        check(await a.page.evaluate(() => localStorage.getItem("ournotes-cloud-token")) === null,
            "本地 token 已清掉");
        const stale = await api("/api/me", {headers: {Authorization: "Bearer " + tokenA2}});
        check(stale.status === 401, "旧 token 在服务端已失效（401）", stale.status);

        // ---- ⑧ 503 限流 ----
        console.log("\n[8] nginx 限流 503（HTML）处理");
        await fill(a.page, "#cloudUsername", USERNAME);
        await fill(a.page, "#cloudPassword", NEW_PASSWORD);
        await click(a.page, "#cloudSubmit", 1500);
        st = await pageState(a.page);
        check(st.accountVisible, "新密码可以登录", st.accountName);

        await api("/api/internal/status503", {method: "POST", body: JSON.stringify({count: 1})});
        await click(a.page, "#cloudRefresh", 3000);
        st = await pageState(a.page);
        check(!st.error && st.results.length >= 1, "遇到 1 个 503 会退避重试并成功", st.msg);

        await api("/api/internal/status503", {method: "POST", body: JSON.stringify({count: 3})});
        await click(a.page, "#cloudRefresh", 4000);
        st = await pageState(a.page);
        check(st.error && /太快|限流/.test(st.msg || ""), "连续 503 给出「操作太快」提示", st.msg);

        // ---- ⑧b 卡库冲突：选择框（服务端 409 语义没变，缺的是 UI 出路）----
        console.log("\n[8b] 卡库冲突：用云端覆盖本机 / 保留本机另存");
        const tokenNow = await a.page.evaluate(() => localStorage.getItem("ournotes-cloud-token"));
        const linkNow = await a.page.evaluate(() => JSON.parse(localStorage.getItem("ournotes-cloud-profile") || "null"));
        check(!!linkNow?.id, "本机已关联一条云端卡库", JSON.stringify(linkNow));
        await api("/api/internal/touch-result", {method: "POST", body: JSON.stringify({id: linkNow.id, by: 1})});
        await gotoCloud(a.page);
        await click(a.page, "#cloudProfilePush", 1500);
        st = await pageState(a.page);
        const conflictShown = await a.page.locator("#cloudConflictKeep").count();
        check(/冲突/.test(st.profileLine || "") && conflictShown === 1,
            "服务端 409 时出现冲突选择框", st.profileLine);
        await click(a.page, "#cloudConflictKeep", 1800);
        st = await pageState(a.page);
        const kept = a.net.filter(r => r.method === "POST" && /\/api\/results$/.test(r.url)).pop();
        check(!!kept && kept.status === 201, "「保留本机」→ 另存为云端新的一份（POST 201）",
            a.net.map(r => `${r.method} ${r.status}`).join(" | "));
        check(/已同步/.test(st.profileLine || ""), "另存后状态回到已同步", st.profileLine);

        // 再把「云端那份」改掉，制造第二次冲突 → 用云端覆盖本机
        const linkNew = await a.page.evaluate(() => JSON.parse(localStorage.getItem("ournotes-cloud-profile") || "null"));
        const cloudCopy = await (await api("/api/results/" + linkNew.id,
            {headers: {Authorization: "Bearer " + tokenNow}})).json();
        cloudCopy.payload.document.name = "云端改过的卡库";
        await api("/api/results/" + linkNew.id, {
            method: "PUT",
            headers: {Authorization: "Bearer " + tokenNow},
            body: JSON.stringify({payload: cloudCopy.payload, version: cloudCopy.version}),
        });
        await api("/api/internal/touch-result", {method: "POST", body: JSON.stringify({id: linkNew.id, by: 1})});
        await click(a.page, "#cloudProfilePush", 1500);
        check(await a.page.locator("#cloudConflictPull").count() === 1, "第二次冲突同样给出选择框");
        a.page.once("dialog", dialog => dialog.accept());
        await click(a.page, "#cloudConflictPull", 1800);
        const nameAfter = await a.page.evaluate(() => document.getElementById("profileName").textContent.trim());
        check(nameAfter === "云端改过的卡库", "「用云端覆盖本机」把云端那份装回本页", nameAfter);

        // ---- ⑨ token 失效后自动回登录页 ----
        console.log("\n[9] token 被服务端清掉后自动回登录页");
        await a.page.evaluate(() => localStorage.setItem("ournotes-cloud-token", "t_bogus_token_value"));
        await a.page.reload({waitUntil: "domcontentloaded"});
        await a.page.waitForFunction(() => window.PlannerAccount?.current?.(), null, {timeout: 120000});
        await gotoCloud(a.page);
        // 有 token 时会先显示「正在校验登录态」，等它落到登录表
        await a.page.waitForFunction(() => !!document.querySelector("#cloudRoot #cloudSubmit"), null, {timeout: 20000})
            .catch(() => {});
        st = await pageState(a.page);
        check(st.loginVisible, "无效 token 被清掉并显示登录表单", st.submitLabel);
        check(await a.page.evaluate(() => localStorage.getItem("ournotes-cloud-token")) === null, "本地 token 已清空");
        // 关联指针语义（v0.3.2 定死）：**改密/401 不清**（同账号重新登录还要认得回来），
        // 但**显式登出**要清干净 —— 服务器侧之前实测「登出后 ournotes-cloud-* 一个不剩」。
        check(await a.page.evaluate(() => localStorage.getItem("ournotes-cloud-profile")) !== null,
            "改密/401 之后关联指针还在（同账号重登仍认得回云端那条卡库）");
        await fill(a.page, "#cloudUsername", USERNAME);
        await fill(a.page, "#cloudPassword", NEW_PASSWORD);
        await click(a.page, "#cloudSubmit", 1500);
        await click(a.page, "#cloudLogout", 1200);
        const cloudKeys = await a.page.evaluate(() =>
            Object.keys(localStorage)
                .filter(key => key.startsWith("ournotes-cloud-"))
                // api-base 是**测试注入**的（生产上来自构建期 meta），不算会话残留
                .filter(key => key !== "ournotes-cloud-api-base"));
        check(cloudKeys.length === 0, "显式登出后会话与关联指针都不剩", JSON.stringify(cloudKeys));

        await a.page.screenshot({path: path.join(SHOT_DIR, "account-page.png")});
        // 预期噪音：① 故意造出来的 401/409/503；② **测试夹具**缺几张卡面导致的图片 404
        //（app 自带重试，另有 check_images.cjs 覆盖）—— 都不是这次改动的问题
        const noise = t => /401/.test(t) || /409/.test(t) || /503/.test(t)
            || /(card-images|avatar-images|jacket-images|ui-images)\/.*\.webp/.test(t)
            || /Failed to load resource.*(404|409|503)/.test(t);
        check(a.bad.filter(t => !noise(t)).length === 0, "A 设备除预期的 401/夹具缺图外没有报错",
            a.bad.filter(t => !noise(t)).slice(0, 3).join(" | "));
        check(b.bad.filter(t => !noise(t)).length === 0, "B 设备除预期的 401/夹具缺图外没有报错",
            b.bad.filter(t => !noise(t)).slice(0, 3).join(" | "));

        await ctxA.close(); await ctxB.close();

        // ---- ⑩ 交付给服务器的那份产物：构建期注入「同源空串」，apiBase='' ------------------
        // 只有带 <meta name="ournotes-api-base" content=""> 的构建才跑这条（GitHub Pages 镜像没有）。
        console.log("\n[10] 交付产物（同源 apiBase）");
        const meta = builtMeta;
        if (!meta) {
            console.log("   [SKIP] 这份构建没有注入 api-base（镜像站构建），跳过");
        } else if (meta[1] !== "") {
            check(false, "同源构建里 api-base 必须是空串", meta[1]);
        } else {
            // 同一份 dist，另起一个预览把 `/api` 与 `/data` 都**原样**代理到替身后端
            //（模拟 on.tabsac.com 的同源形态：nginx 就是这么配的两个 location）。
            const sameOriginPort = PREVIEW_PORT + 1;
            await launch(PYTHON, ["-B", path.join(__dirname, "preview_server.py"),
                "--port", String(sameOriginPort), "--api-proxy", `http://127.0.0.1:${API_PORT}`,
                "--api-prefix", "/api,/data", "--api-strip", "false"], "Static preview:");
            const ctxC = await browser.newContext({viewport: {width: 1280, height: 1000}});
            // 注意要打开**同源预览那个端口**（8880），否则请求还是打到 8879 的前缀代理上
            const c = await openApp(ctxC, {
                apiBase: null,      // 不碰 localStorage，用构建注入的值
                base: `http://127.0.0.1:${sameOriginPort}/ournotes-planner/`,
            });
            await gotoCloud(c.page);
            let sc = await pageState(c.page);
            check(/同源/.test(sc.serverLine || ""), "面板认出「同源」后端", sc.serverLine);
            await click(c.page, '[data-cloud-view="register"]');     // 默认是登录表，先切注册
            await fill(c.page, "#cloudUsername", USERNAME + "_so");
            await fill(c.page, "#cloudPassword", PASSWORD);
            await click(c.page, "#cloudSubmit", 1500);
            sc = await pageState(c.page);
            check(sc.accountVisible, "同源模式下注册/登录直接可用（不需要任何地址配置）",
                sc.accountName || `面板提示：${sc.msg || "(空)"}`
                + ` | 请求：${c.calls.map(u => u.replace(`http://127.0.0.1:${sameOriginPort}`, "")).join(" ")}`
                + ` | 4xx/5xx：${c.bad.slice(0, 3).join(" ; ")}`);
            check(sc.badge && sc.badge !== "登录", "头部标识同步", sc.badge);

            // ---- ⑩b 同源空串下**必须**走通卡库同步（v0.3.0 的 bug 就藏在这里）----
            // v0.3.0：profile-cloud 用 `!!apiBase()` 判断，空串是 falsy → canSync() 恒 false
            // → 状态显示「未启用」、点上传一个请求都不发。这三条断言就是那个洞的补丁。
            sc = await pageState(c.page);
            check(/未同步/.test(sc.profileLine || ""), "同源下卡库状态是「未同步」（不是「未启用」）",
                sc.profileLine);
            const seededSameOrigin = await c.page.evaluate(async () => {
                const bootstrap = await (await window.plannerFetch("/api/bootstrap")).json();
                const document_ = window.PlannerProfile.document();
                const memberId = bootstrap.catalog.members[0].id;
                const snapId = bootstrap.catalog.snaps[0].id;
                document_.name = "同源卡库";
                document_.profile.inventory.members = [{id: memberId, level: 20, training_count: 0,
                    awakening_count: 0, live_skill_level: 1, gekisou_skill_level: 1}];
                document_.profile.inventory.snaps = [{id: snapId, level: 20, limit_break_count: 0}];
                document_.candidate_member_ids = [memberId];
                document_.candidate_snap_ids = [snapId];
                return window.PlannerProfile.install(document_);
            });
            check(seededSameOrigin === true, "同源下也能改卡库（为自动推送做准备）");

            c.net.length = 0;
            await click(c.page, "#cloudProfilePush", 2000);
            sc = await pageState(c.page);
            const posted = c.net.find(r => r.method === "POST" && /\/api\/results$/.test(r.url));
            check(!!posted && posted.status === 201,
                "同源下点「立即上传卡库」真的发出 POST /api/results 201",
                c.net.map(r => `${r.method} ${r.status} ${r.url.split("/api/")[1] || ""}`).join(" | ") || "(没有请求)");
            check(/已同步/.test(sc.profileLine || ""), "上传后状态变「已同步」", sc.profileLine);

            // 本地改动 → debounce 4 秒后**自动 PUT**（v0.3.0 也是整条不触发的）
            c.net.length = 0;
            await c.page.evaluate(() => {
                const document_ = window.PlannerProfile.document();
                document_.name = "同源卡库（改过）";
                window.PlannerProfile.install(document_);
            });
            const putSeen = await (async () => {
                await c.page.waitForTimeout(9000);           // debounce 4 秒 + 请求往返
                return c.net.some(r => r.method === "PUT" && /\/api\/results\//.test(r.url));
            })();
            check(putSeen, "本地改动会自动 PUT 推上去（debounce 合并）",
                c.net.map(r => `${r.method} ${r.status}`).join(" | ") || "(没有请求)");

            // ---- ⑩c 远端只读数据：字节校验 + 与内置快照比对 + 陈旧提醒 ----
            // 替身后端是**从 snapshot-digest.json 反推**出 songs.json 的，所以这里必须报「一致」；
            // 再用内部接口改一首歌，必须精确报出「1 处等级变化」并弹提醒。
            console.log("\n[10c] /data 只读数据：校验 / 比对 / 陈旧提醒");
            await c.page.locator('.tabs button[data-tab="software"]').click();
            await c.page.waitForSelector("#dataStatusRoot .data-status", {timeout: 20000});
            const readData = () => c.page.evaluate(() => {
                const box = document.getElementById("dataStatusRoot");
                const rows = {};
                for (const tr of box.querySelectorAll("tr")) {
                    const key = tr.querySelector("th")?.textContent.trim();
                    if (key) rows[key] = tr.querySelector("td")?.textContent.trim();
                }
                return {rows, notice: document.getElementById("remoteDataNotice")?.textContent.trim() || ""};
            });
            let data = await readData();
            check(/2026-10-05/.test(data.rows["线上数据版本"] || ""), "读到线上数据版本",
                data.rows["线上数据版本"]);
            check(/通过/.test(data.rows["字节校验（fileDigests）"] || ""), "字节校验通过（sha256 对得上）",
                data.rows["字节校验（fileDigests）"]);
            check(/一致/.test(data.rows["曲目数据与内置快照"] || ""), "与内置快照一致",
                data.rows["曲目数据与内置快照"]);
            check(/与内置一致/.test(data.rows["线上当前活动"] || ""), "当前活动与内置一致",
                data.rows["线上当前活动"]);
            check(/未使用/.test(data.rows["卡牌数据（cards.json）"] || ""), "cards.json 如实标注未使用",
                data.rows["卡牌数据（cards.json）"]);
            check(!data.notice, "一致时没有顶部提醒", data.notice || "(无)");

            console.log("     改一首歌的等级 → 重新检查");
            await api("/api/internal/mutate-data", {
                method: "POST", body: JSON.stringify({id: 100001, difficulty: "EXPERT", display: 26})});
            await click(c.page, "#dataStatusRefresh", 2500);
            data = await readData();
            check(/不一致/.test(data.rows["曲目数据与内置快照"] || "")
                  && /等级变化 1/.test(data.rows["曲目数据与内置快照"] || ""),
                "改一处等级后精确报出「1 处等级变化」", data.rows["曲目数据与内置快照"]);
            const diffRow = await c.page.evaluate(() =>
                [...document.querySelectorAll("#dataStatusRoot tr td")]
                    .map(td => td.textContent).find(text => /EXPERT 等级/.test(text)) || "");
            check(/25 → 26/.test(diffRow), "差异明细写明 25 → 26", diffRow.slice(0, 60));
            check(/线上曲目数据与内置快照不一致/.test(data.notice) && /仍使用内置快照/.test(data.notice),
                "顶部弹出「线上数据变了、计算仍用内置快照」的提醒", data.notice.slice(0, 80));
            await ctxC.close();
        }
    } catch (error) {
        console.error("!!! 失败:", error.message);
        problems.push("异常: " + error.message);
    } finally {
        if (browser) await browser.close().catch(() => {});
        for (const child of started) { try { child.kill(); } catch { /* 忽略 */ } }
    }
    console.log(problems.length ? `\n${problems.length} 项未通过` : "\n全部通过");
    process.exit(problems.length ? 1 : 0);
})();
