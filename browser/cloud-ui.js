/**
 * 「账号」面板 —— 账号密码登录 / 注册 / 绑定 QQ / 改密 / 退出 + 云端结果与卡库同步。
 *
 * 挂在应用新增的「账号」页签里（`#cloudRoot`），另有：
 *   * 头部小标识 `#cloudBadge`：未登录 / 用户名 / 同步状态，点它跳到本页；
 *   * B25 页只留一条窄条（见 b25-ui.js），真正登录/注册都在这页。
 *
 * 硬约束：
 *   1. 没启用云端（公开镜像站）时**一个请求都不发**，只显示「请访问官方站点」。
 *   2. 云端任何失败都只体现在本面板里：计算、卡库、导出照常。
 *   3. 绑定 QQ 的轮询上限 10 分钟，切页签/关弹窗都要停。
 */
import * as cloud from "./cloud-api.js";
import {bindCommand, describeError} from "./cloud-api.js";
import {
    attachProfileCloud, listCloudProfiles, onProfileSyncChange, profileSyncState, pull, push,
} from "./profile-cloud.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c =>
    ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));

const BIND_POLL_MS = 3000;
const BIND_POLL_LIMIT = 10 * 60 * 1000;

function when(seconds) {
    if (!seconds) return "";
    const d = new Date(Number(seconds) * 1000);
    if (Number.isNaN(d.getTime())) return "";
    const pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function whenMs(ms) {
    if (!ms) return "";
    return when(Math.floor(ms / 1000));
}

/** 一键复制：clipboard 优先，失败退回 execCommand（老浏览器/无权限时也能用）。 */
async function copyText(text) {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch { /* 落到兜底 */ }
    try {
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.append(area);
        area.select();
        const ok = document.execCommand("copy");
        area.remove();
        return ok;
    } catch { return false; }
}

function summaryOf(record) {
    const stats = record.stats || {};
    const parts = [];
    if (stats.rating_avg != null) parts.push(`Rating ${stats.rating_avg}`);
    if (stats.count) parts.push(`${stats.count} 首`);
    if (stats.fc_count != null || stats.ap_count != null) {
        parts.push(`FC ${stats.fc_count ?? "-"} / AP ${stats.ap_count ?? "-"}`);
    }
    return parts.join(" · ");
}

export function mountCloudPanel(root, options = {}) {
    if (!root) return;
    const {getCardRecord, onCardLoaded} = options;
    const state = {
        view: "login",          // login | register | account
        configured: cloud.isConfigured(),
        account: cloud.currentAccount(),
        // 有 token 就先显示「正在校验登录态」，别先闪一下账号区再被 401 打回登录表
        checking: cloud.isConfigured() && !!cloud.token(),
        results: null,
        cardLinked: cloud.linkedResult("b25"),
        profiles: null,
        busy: false,
        message: "",
        error: false,
        bind: null,             // {qq, code, hint, startedAt, timer, attempts, status}
        profileSync: profileSyncState(),
    };

    root.innerHTML = `
<div class="cloud-panel-open">
  <div class="cloud-head">
    <h3>云端账号</h3>
    <span class="cloud-dim" id="cloudServerLine"></span>
  </div>

  <section id="cloudAuthBox" class="cloud-card"></section>
  <section id="cloudAccountBox" class="cloud-card" hidden></section>
  <section id="cloudResultsBox" class="cloud-card" hidden></section>
  <section id="cloudProfileBox" class="cloud-card" hidden></section>
  <p class="cloud-msg" id="cloudMsg"></p>
</div>
<div class="cloud-overlay" id="cloudBindOverlay" hidden>
  <div class="cloud-dialog" role="dialog" aria-modal="true">
    <h3>绑定 QQ</h3>
    <div id="cloudBindBody"></div>
    <div class="cloud-dialog-actions">
      <button type="button" id="cloudBindClose">关闭</button>
    </div>
  </div>
</div>`;

    const $ = id => root.querySelector("#" + id);
    const setMessage = (text, isError = false) => { state.message = text || ""; state.error = isError; };

    /* ------------------------------------------------------------ 渲染 */

    function render() {
        state.configured = cloud.isConfigured();
        state.account = cloud.currentAccount();
        state.profileSync = profileSyncState();
        const info = cloud.apiBaseInfo();

        $("cloudServerLine").textContent = !state.configured
            ? "未启用（这个站点没有后端）"
            : (info?.source === "build" ? `同源 ${info.base || location.origin}` : `自定义 ${info.base || location.origin}`);

        if (!state.configured) {
            $("cloudAuthBox").hidden = false;
            $("cloudAccountBox").hidden = true;
            $("cloudResultsBox").hidden = true;
            $("cloudProfileBox").hidden = true;
            $("cloudAuthBox").innerHTML = `
              <p>这个站点没有连接后端，云端账号与同步不可用。<b>计算、卡库、导出都照常用。</b></p>
              <p class="cloud-dim">官方站点：<a href="${cloud.OFFICIAL_SITE}" target="_blank" rel="noopener">${esc(cloud.OFFICIAL_SITE)}</a></p>`;
        } else if (state.checking) {
            $("cloudAuthBox").hidden = false;
            $("cloudAccountBox").hidden = true;
            $("cloudResultsBox").hidden = true;
            $("cloudProfileBox").hidden = true;
            $("cloudAuthBox").innerHTML = '<p class="cloud-dim">正在校验登录态…</p>';
        } else if (!state.account) {
            // 表单**只在需要时重建**：一次失败的提交也会走 render()，
            // 如果每次都重建，用户刚填的用户名/密码就被清空了（踩过）。
            $("cloudAuthBox").hidden = false;
            if (state.renderedAuth !== state.view || !$("cloudUsername")) renderAuthForm();
            $("cloudAccountBox").hidden = true;
            $("cloudResultsBox").hidden = true;
            $("cloudProfileBox").hidden = true;
        } else {
            state.renderedAuth = null;
            $("cloudAuthBox").hidden = true;
            $("cloudAccountBox").hidden = false;
            $("cloudResultsBox").hidden = false;
            $("cloudProfileBox").hidden = false;
            // 账号区同理：只有账号信息真的变了才重建，否则「修改密码」表单里刚填的东西会被清掉
            const signature = `${state.account.id || ""}|${state.account.username || ""}|${state.account.qq || ""}`;
            if (state.renderedAccount !== signature || !$("cloudChangePwGo")) renderAccount();
            state.renderedAccount = signature;
            renderResults();
            renderProfile();
        }
        $("cloudMsg").textContent = state.message;
        $("cloudMsg").classList.toggle("cloud-error", !!state.error);
        if (state.bind) renderBind();
        updateBadge();
    }

    function renderAuthForm() {
        const registerMode = state.view === "register";
        state.renderedAuth = state.view;
        $("cloudAuthBox").innerHTML = `
          <div class="cloud-tabs">
            <button type="button" class="${registerMode ? "" : "active"}" data-cloud-view="login">登录</button>
            <button type="button" class="${registerMode ? "active" : ""}" data-cloud-view="register">注册</button>
          </div>
          <div class="cloud-line">
            <span class="cloud-label">用户名</span>
            <input id="cloudUsername" class="cloud-input" type="text" autocomplete="username"
                   spellcheck="false" placeholder="3–24 位字母数字 _ . -">
          </div>
          <div class="cloud-line">
            <span class="cloud-label">密码</span>
            <input id="cloudPassword" class="cloud-input" type="password" autocomplete="${registerMode ? "new-password" : "current-password"}"
                   placeholder="至少 8 位">
            <button id="cloudSubmit" type="button" class="primary">${registerMode ? "注册并登录" : "登录"}</button>
          </div>
          <p class="cloud-dim">${registerMode
                ? "注册后会直接登录；账号只用来在本站保存/取回你自己的结果。"
                : "忘记密码目前需要找管理员（以后会支持用已绑定的 QQ 自助重置）。"}</p>`;
        root.querySelectorAll("[data-cloud-view]").forEach(button =>
            button.addEventListener("click", () => {
                if (state.view === button.dataset.cloudView) return;
                state.view = button.dataset.cloudView;
                setMessage("");
                render();
            }));
        const submit = $("cloudSubmit");
        submit.addEventListener("click", () => (registerMode ? doRegister() : doLogin()));
        for (const id of ["cloudUsername", "cloudPassword"]) {
            $(id).addEventListener("keydown", event => {
                if (event.key === "Enter") (registerMode ? doRegister() : doLogin());
            });
        }
    }

    function renderAccount() {
        const account = state.account || {};
        const bound = account.qq ? String(account.qq) : "";
        $("cloudAccountBox").innerHTML = `
          <div class="cloud-account-row">
            <div>
              <div class="cloud-account-name">${esc(account.username || "（未命名）")}</div>
              <div class="cloud-dim">注册于 ${esc(when(account.createdAt)) || "—"}
                ${bound ? `· 已绑定 QQ <code>${esc(bound)}</code>` : "· 未绑定 QQ"}</div>
            </div>
            <div class="cloud-account-actions">
              ${bound
                ? `<button type="button" id="cloudUnbind">解绑 QQ</button>`
                : `<button type="button" id="cloudBind" class="primary">绑定 QQ</button>`}
              <button type="button" id="cloudChangePw">修改密码</button>
              <button type="button" id="cloudLogout">退出登录</button>
            </div>
          </div>
          <div id="cloudChangePwBox" hidden class="cloud-inline-form">
            <input id="cloudOldPw" class="cloud-input" type="password" placeholder="原密码" autocomplete="current-password">
            <input id="cloudNewPw" class="cloud-input" type="password" placeholder="新密码（至少 8 位）" autocomplete="new-password">
            <button type="button" id="cloudChangePwGo" class="primary">确认修改</button>
            <span class="cloud-dim">改完所有设备都要重新登录</span>
          </div>`;
        $("cloudLogout").addEventListener("click", doLogout);
        const bindButton = $("cloudBind");
        if (bindButton) bindButton.addEventListener("click", () => openBind());
        const unbind = $("cloudUnbind");
        if (unbind) unbind.addEventListener("click", doUnbind);
        $("cloudChangePw").addEventListener("click", () => {
            const box = $("cloudChangePwBox");
            box.hidden = !box.hidden;
        });
        $("cloudChangePwGo").addEventListener("click", doChangePassword);
    }

    function renderResults() {
        const list = state.results;
        $("cloudResultsBox").innerHTML = `
          <div class="cloud-head">
            <h4>云端结果</h4>
            <div class="cloud-account-actions">
              <button type="button" id="cloudUploadCard">存当前成绩卡</button>
              <button type="button" id="cloudRefresh">刷新列表</button>
            </div>
          </div>
          ${!list ? '<p class="cloud-dim">点「刷新列表」看云端存了什么。</p>'
            : (list.length ? `<ul class="cloud-items">${list.map(item => `
              <li class="cloud-item">
                <div class="cloud-item-main">
                  <b>${esc(item.title || "(无标题)")}</b>
                  <span class="cloud-dim">${esc(when(item.createdAt))}
                    ${item.size ? `· ${Math.max(1, Math.round(item.size / 1024))} KB` : ""}
                    ${state.cardLinked && state.cardLinked.id === item.id ? "· 本机关联" : ""}</span>
                  ${item.summary ? `<span class="cloud-item-sum">${esc(item.summary)}</span>` : ""}
                </div>
                <div class="cloud-item-actions">
                  <button type="button" data-cloud-load="${esc(item.id)}">取回</button>
                  <button type="button" data-cloud-delete="${esc(item.id)}">删除</button>
                </div>
              </li>`).join("")}</ul>` : '<p class="cloud-dim">云端还没有内容。</p>')}
          <p class="cloud-note">只上传<b>展示用结果</b>（成绩卡 / 卡库）——上传前会自动剔除鉴权类字段，
            服务器只存不算。</p>`;
        $("cloudUploadCard").addEventListener("click", uploadCard);
        $("cloudRefresh").addEventListener("click", () => run(async () => {
            await refreshList();
            setMessage("列表已刷新");
        }));
        root.querySelectorAll("[data-cloud-load]").forEach(button =>
            button.addEventListener("click", () => loadCard(button.dataset.cloudLoad)));
        root.querySelectorAll("[data-cloud-delete]").forEach(button =>
            button.addEventListener("click", () => removeResult(button.dataset.cloudDelete)));
    }

    function renderProfile() {
        const sync = state.profileSync || {};
        const modeText = {
            off: "未启用", idle: "未同步", dirty: "有改动待上传", syncing: "正在同步…",
            synced: "已同步", conflict: "冲突（别的设备改过）", error: "同步失败",
        }[sync.mode] || sync.mode;
        // ⚠️ 列表要**声明式**地画在这里：run() 结束时会再 render() 一次，
        //    如果列表是在事件处理里命令式写进 DOM，就会被这次重画抹掉（踩过）。
        const profiles = state.profiles;
        $("cloudProfileBox").innerHTML = `
          <div class="cloud-head">
            <h4>个人卡库同步</h4>
            <div class="cloud-account-actions">
              <button type="button" id="cloudProfilePush" class="primary">立即上传卡库</button>
              <button type="button" id="cloudProfileList">云端卡库列表</button>
            </div>
          </div>
          <p class="cloud-dim">状态：<b>${esc(modeText)}</b>${sync.at ? ` · 上次成功 ${esc(whenMs(sync.at))}` : ""}
            ${sync.error ? ` · ${esc(sync.error)}` : ""}${sync.detail ? ` · ${esc(sync.detail)}` : ""}</p>
          <div id="cloudProfileListBox">${!profiles ? ""
            : (profiles.length ? `<ul class="cloud-items">${profiles.map(item => `
              <li class="cloud-item">
                <div class="cloud-item-main">
                  <b>${esc(item.title || "")}</b>
                  <span class="cloud-dim">${esc(when(item.createdAt))}${item.summary ? ` · ${esc(item.summary)}` : ""}</span>
                </div>
                <div class="cloud-item-actions">
                  <button type="button" data-cloud-profile="${esc(item.id)}">恢复到本机</button>
                </div>
              </li>`).join("")}</ul>` : '<p class="cloud-dim">云端还没有卡库。</p>')}</div>
          <p class="cloud-note">卡库会随每次编辑自动上传（改动合并后延迟几秒），失败不影响本地使用。</p>`;
        $("cloudProfilePush").addEventListener("click", () => run(async () => {
            const result = await push();
            setMessage(result?.notice || result?.localNotice || "卡库已上传");
        }));
        $("cloudProfileList").addEventListener("click", () => run(async () => {
            state.profiles = await listCloudProfiles();
            setMessage(state.profiles.length ? `云端有 ${state.profiles.length} 份卡库` : "云端还没有卡库");
        }));
        root.querySelectorAll("[data-cloud-profile]").forEach(button =>
            button.addEventListener("click", () => run(async () => {
                if (!window.confirm("用云端这份卡库覆盖本机卡库？本机当前养成会被替换。")) return;
                const document_ = await pull(button.dataset.cloudProfile);
                setMessage(`已恢复卡库「${document_?.name || ""}」`);
            })));
    }

    function updateBadge() {
        const badge = document.getElementById("cloudBadge");
        if (!badge) return;
        if (!state.configured) { badge.textContent = "云端未启用"; badge.dataset.state = "off"; return; }
        if (!state.account) { badge.textContent = "登录"; badge.dataset.state = "out"; return; }
        const sync = state.profileSync || {};
        badge.textContent = sync.mode === "syncing" ? `${state.account.username} · 同步中`
            : sync.mode === "error" ? `${state.account.username} · 同步失败`
            : state.account.username;
        badge.dataset.state = "in";
    }

    /* ------------------------------------------------------ 登录 / 注册 */

    function doLogin() {
        const username = $("cloudUsername")?.value || "";
        const password = $("cloudPassword")?.value || "";
        return run(async () => {
            const account = await cloud.login(username, password);
            await afterAuth(account, "已登录");
        });
    }

    function doRegister() {
        const username = $("cloudUsername")?.value || "";
        const password = $("cloudPassword")?.value || "";
        return run(async () => {
            const account = await cloud.register(username, password);
            await afterAuth(account, "注册成功，已登录");
        });
    }

    function doLogout() {
        return run(async () => {
            await cloud.logout();
            state.results = null;
            state.profiles = null;
            state.view = "login";
            setMessage("已退出登录（本机卡库与计算结果都还在）");
        });
    }

    function doChangePassword() {
        const oldPassword = $("cloudOldPw")?.value || "";
        const newPassword = $("cloudNewPw")?.value || "";
        return run(async () => {
            await cloud.changePassword(oldPassword, newPassword);
            state.results = null;
            state.profiles = null;
            state.view = "login";
            setMessage("密码已修改：所有设备都需要用新密码重新登录");
        });
    }

    async function afterAuth(account, okText) {
        setMessage(okText + (account?.qq ? "" : "（还没绑定 QQ，绑了以后找密码/找人都方便）"));
        // 刚登录：先看看云端有没有这个账号的卡库，有就提示（**不自动覆盖本地**）
        await import("./profile-cloud.js").then(m => m.onAuthChanged(account)).catch(() => {});
        await refreshList();
    }

    async function refreshList() {
        state.results = await cloud.listResults();
        state.cardLinked = cloud.linkedResult("b25");
    }

    /* ------------------------------------------------------------ 成绩卡 */

    function uploadCard() {
        return run(async () => {
            const record = getCardRecord?.();
            if (!record) throw new cloud.CloudError("empty", "本机还没有成绩卡：先去「账号包导入」导一次游戏账号包");
            const body = {
                title: `B25 成绩 · ${record.playerName || record.player?.name || "（未命名）"}`,
                summary: summaryOf(record),
                payload: record,
            };
            const linked = cloud.linkedResult("b25");
            let notice;
            if (linked?.id) {
                const updated = await cloud.updateResult(linked.id, {payload: body.payload, version: linked.version});
                cloud.setLinkedResult({id: linked.id, version: updated?.version ?? (linked.version + 1), savedAt: record.savedAt}, "b25");
                notice = updated.localNotice || updated.notice;
                setMessage(joinNotice("已覆盖云端那条成绩卡", updated));
            } else {
                const created = await cloud.createResult(body);
                cloud.setLinkedResult({id: created.id, version: created.version ?? 1, savedAt: record.savedAt}, "b25");
                notice = created.localNotice || created.notice;
                setMessage(joinNotice("成绩卡已存到云端", created));
            }
            await refreshList();
            if (notice) setMessage(state.message + "；" + notice);
        });
    }

    function joinNotice(base, result) {
        const stripped = result?.stripped?.length;
        if (stripped) return `${base}；服务器剔除了 ${stripped} 项敏感字段（${result.stripped.slice(0, 2).join("、")}…）`;
        return base;
    }

    function loadCard(id) {
        return run(async () => {
            const item = await cloud.getResult(id);
            const payload = item?.payload;
            if (!payload || !Array.isArray(payload.entries) || !payload.entries.length) {
                throw new cloud.CloudError("empty", "这条结果不是成绩卡（没有卡片数据）");
            }
            onCardLoaded?.(payload, `已取回「${item.title || id}」`);
            cloud.setLinkedResult({id, version: item.version ?? 1, savedAt: payload.savedAt}, "b25");
            setMessage(`已取回「${item.title || id}」`);
            await refreshList();
        });
    }

    function removeResult(id) {
        if (!window.confirm("删除云端这条结果？本机数据不受影响。")) return Promise.resolve();
        return run(async () => {
            await cloud.deleteResult(id);
            if (cloud.linkedResult("b25")?.id === id) cloud.setLinkedResult(null, "b25");
            if (cloud.linkedResult("profile")?.id === id) cloud.setLinkedResult(null, "profile");
            await refreshList();
            setMessage("已删除");
        });
    }

    /* --------------------------------------------------------- 绑定 QQ */

    function openBind() {
        state.bind = {qq: "", code: "", hint: "", status: "input", startedAt: 0, attempts: 0, timer: null};
        $("cloudBindOverlay").hidden = false;
        render();
    }

    function closeBind() {
        if (state.bind?.timer) clearInterval(state.bind.timer);
        state.bind = null;
        $("cloudBindOverlay").hidden = true;
        render();
    }

    function renderBind() {
        const bind = state.bind;
        const body = $("cloudBindBody");
        if (!body) return;
        const account = state.account || {};
        if (bind.status === "input") {
            body.innerHTML = `
              <p>请填你<b>自己的 QQ 号</b>（绑定后这个 QQ 就代表你）。</p>
              <div class="cloud-line">
                <span class="cloud-label">QQ 号</span>
                <input id="cloudBindQq" class="cloud-input" type="text" inputmode="numeric" placeholder="5–12 位数字"
                       value="${esc(bind.qq || "")}">
                <button type="button" id="cloudBindStart" class="primary">生成绑定码</button>
              </div>`;
            const input = $("cloudBindQq");
            input.addEventListener("input", () => { bind.qq = input.value; });   // 重画也别丢输入
            $("cloudBindStart").addEventListener("click", doBindStart);
            input.addEventListener("keydown", event => { if (event.key === "Enter") doBindStart(); });
            return;
        }
        if (bind.status === "waiting") {
            const command = bindCommand(bind.code);
            body.innerHTML = `
              <p>照这三步做（<b>必须用 QQ ${esc(bind.qq)} 发送</b>）：</p>
              <ol class="cloud-steps">
                <li>复制这串码：<b class="cloud-code">${esc(bind.code)}</b></li>
                <li>打开 QQ，在群里（或私聊机器人）发送：<code>${esc(command)}</code>
                    <button type="button" id="cloudCopyCmd">一键复制命令</button></li>
                <li>发完回到这里，页面会自动刷新状态（每 3 秒查一次）</li>
              </ol>
              <p class="cloud-dim">${esc(bind.hint || "")}<br>
                码 10 分钟内有效、只能用一次；发错 QQ 不会消耗码，本人再发一次仍然有效。</p>
              <p class="cloud-dim" id="cloudBindProgress">等待中…（已等 ${Math.round(bind.attempts * 3)} 秒）</p>`;
            $("cloudCopyCmd").addEventListener("click", async event => {
                const ok = await copyText(command);
                event.currentTarget.textContent = ok ? "已复制 ✓" : "复制失败，请手动选";
                setTimeout(() => { event.currentTarget.textContent = "一键复制命令"; }, 2000);
            });
            return;
        }
        if (bind.status === "done") {
            body.innerHTML = `<p>绑定成功：<b>${esc(account.qq || bind.qq)}</b> 已绑到账号「${esc(account.username || "")}」。</p>
              <p class="cloud-dim">以后忘密码可以找管理员用这个 QQ 核实身份。</p>`;
            return;
        }
        if (bind.status === "expired") {
            body.innerHTML = `<p>码过期了，重新生成一个吧。</p>
              <button type="button" id="cloudBindAgain" class="primary">重新生成</button>`;
            $("cloudBindAgain").addEventListener("click", doBindStart);
            return;
        }
        body.innerHTML = `<p class="cloud-error-text">${esc(bind.error || "绑定失败")}</p>
          <button type="button" id="cloudBindAgain" class="primary">重新开始</button>`;
        $("cloudBindAgain").addEventListener("click", () => {
            state.bind = {...bind, status: "input", error: ""};
            render();
        });
    }

    function doBindStart() {
        const qq = $("cloudBindQq")?.value || state.bind?.qq || "";
        return run(async () => {
            const started = await cloud.bindQqStart(qq);
            state.bind = {
                qq: String(qq).trim(), code: String(started?.code ?? ""), hint: started?.hint || "",
                status: "waiting", startedAt: Date.now(), attempts: 0, timer: null,
            };
            setMessage("绑定码已生成，去 QQ 里发命令");
            startBindPolling();
        });
    }

    function startBindPolling() {
        const bind = state.bind;
        if (!bind) return;
        if (bind.timer) clearInterval(bind.timer);
        bind.timer = setInterval(async () => {
            const current = state.bind;
            if (!current || current.status !== "waiting") return;
            if (Date.now() - current.startedAt > BIND_POLL_LIMIT) {
                clearInterval(current.timer);
                current.status = "expired";
                render();
                return;
            }
            current.attempts += 1;
            try {
                const account = await cloud.me();
                if (account?.qq) {
                    clearInterval(current.timer);
                    current.status = "done";
                    setMessage("绑定成功");
                    render();
                    return;
                }
            } catch (error) {
                // 401（会话失效）要停下来，其它错误（网络抖动/限流）继续轮询
                if (error instanceof cloud.CloudError && error.status === 401) {
                    clearInterval(current.timer);
                    current.status = "error";
                    current.error = "登录过期了，请重新登录后再绑定";
                    render();
                    return;
                }
            }
            const progress = $("cloudBindProgress");
            if (progress) progress.textContent = `等待中…（已等 ${Math.round(current.attempts * 3)} 秒）`;
        }, BIND_POLL_MS);
    }

    function doUnbind() {
        if (!window.confirm("解绑 QQ？解绑后这个 QQ 不再关联你的账号。")) return Promise.resolve();
        return run(async () => {
            await cloud.bindQqRemove();
            await cloud.me();
            setMessage("已解绑 QQ");
        });
    }

    /* ------------------------------------------------------------ 公共 */

    async function run(work) {
        state.busy = true;
        try {
            await work();
        } catch (error) {
            setMessage(describeError(error), true);
        } finally {
            state.busy = false;
            render();
        }
    }

    root.querySelector("#cloudBindClose").addEventListener("click", closeBind);

    // 登录态变化（含被 401 踢掉、改密后）都要重画
    cloud.onAuthChange(() => render());
    // 卡库同步状态变化也重画（只改状态行，代价很小）
    onProfileSyncChange(sync => {
        state.profileSync = sync;
        updateBadge();
        const box = $("cloudProfileBox");
        if (box && !box.hidden) {
            const line = box.querySelector("p.cloud-dim");
            if (line) {
                const modeText = {
                    off: "未启用", idle: "未同步", dirty: "有改动待上传", syncing: "正在同步…",
                    synced: "已同步", conflict: "冲突（别的设备改过）", error: "同步失败",
                }[sync.mode] || sync.mode;
                line.innerHTML = `状态：<b>${esc(modeText)}</b>${sync.at ? ` · 上次成功 ${esc(whenMs(sync.at))}` : ""}`
                    + `${sync.error ? ` · ${esc(sync.error)}` : ""}${sync.detail ? ` · ${esc(sync.detail)}` : ""}`;
            }
        }
    });

    // 有 token 就校验一次登录态（失效会被 401 清掉 → 回到登录表）
    if (state.configured && cloud.token()) {
        cloud.refreshSession()
            .then(account => { if (account) setMessage(`已登录 ${account.username}`); })
            .catch(() => { /* 401 已经清了 token，界面上会显示登录表 */ })
            .finally(() => { state.checking = false; render(); });
    } else {
        state.checking = false;
        render();
    }
}

/** 让外部（profile-storage 的钩子）也能接上卡库同步。 */
export {attachProfileCloud};
