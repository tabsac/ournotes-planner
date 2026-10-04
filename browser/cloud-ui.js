/**
 * 「云端同步」面板 —— 服务器对接的 B 最小版界面。
 *
 * 只做一件事：把**算好的卡片结果**（展示用 JSON）存到服务器、在别的设备上取回来。
 * **不上传原始账号包**（那是完整账号数据），服务器也不做任何计算。
 *
 * 两条硬约束：
 *  1. 没配置服务器地址时**一个请求都不发**（公开站点就是这种状态，不能有控制台报错）。
 *  2. 云端出任何问题都不影响本地功能：本地卡片照常显示，只在面板里写清楚状态。
 */
import * as cloud from "./cloud-api.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c =>
    ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));

function when(seconds) {
    if (!seconds) return "";
    const d = new Date(Number(seconds) * 1000);
    if (Number.isNaN(d.getTime())) return "";
    const pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

function titleOf(record) {
    const name = record.playerName || (record.player && record.player.name) || "（未命名）";
    return `B25 成绩 · ${name}`;
}

export function mountCloudPanel(root, {getRecord, onRecordLoaded, initialMessage} = {}) {
    if (!root) return;
    const state = {busy: false, configured: cloud.isConfigured(), user: cloud.currentUser(),
                   results: null, linked: cloud.linkedResult(), message: initialMessage || "", error: false};

    root.innerHTML = `
<details class="cloud-panel" id="cloudDetails">
  <summary>云端同步（可选）<span class="cloud-state" id="cloudState"></span></summary>
  <div class="cloud-body">
    <div class="cloud-line">
      <span class="cloud-label">服务器地址</span>
      <input id="cloudBase" class="cloud-input" type="text" spellcheck="false"
             placeholder="留空 = 与网页同源；或 https://…">
      <button id="cloudSaveBase" type="button">保存</button>
      <button id="cloudTest" type="button">测试连接</button>
    </div>
    <div class="cloud-line" id="cloudAuthLine"></div>
    <div class="cloud-line cloud-actions">
      <button id="cloudUpload" type="button" class="primary">把当前卡片存到云端</button>
      <button id="cloudRefresh" type="button">刷新云端列表</button>
    </div>
    <div id="cloudList"></div>
    <p class="cloud-note">只上传这张卡片的<b>结果数据</b>（曲名、谱面等级、FC/AP、统计），
       <b>不含原始账号包</b>；服务器只存不算，计算仍然在你自己的设备上。</p>
    <p class="cloud-msg" id="cloudMsg"></p>
  </div>
</details>`;

    const $ = id => root.querySelector("#" + id);
    const setMessage = (text, isError = false) => {
        state.message = text || "";
        state.error = isError;
    };

    function render() {
        state.configured = cloud.isConfigured();
        state.user = cloud.currentUser();
        state.linked = cloud.linkedResult();
        const info = cloud.apiBaseInfo();

        $("cloudState").textContent = !state.configured ? "未配置"
            : state.user ? `已登录 ${state.user.qq ?? ""}`.trim() : "未登录";
        const baseInput = $("cloudBase");
        // 只在用户没在输入时回填，别抢光标
        if (document.activeElement !== baseInput) {
            baseInput.value = state.configured ? (info?.base ?? "") : "";
        }
        baseInput.placeholder = info?.source === "build"
            ? "构建时已注入（这里留空即用它）" : "留空 = 与网页同源；或 https://…";

        $("cloudAuthLine").innerHTML = !state.configured ? "" : (state.user
            ? `<span class="cloud-label">已登录</span><code>${esc(state.user.qq ?? "")}</code>
               <span class="cloud-dim">${esc(when(state.user.at))}</span>
               <button id="cloudLogout" type="button">退出登录</button>`
            : `<span class="cloud-label">登录码</span>
               <input id="cloudCode" class="cloud-input cloud-input-code" type="text" inputmode="numeric"
                      maxlength="8" placeholder="机器人里发 /on登录码">
               <button id="cloudLogin" type="button">登录</button>
               <span class="cloud-dim">不用密码：在 QQ 机器人里发一次登录码</span>`);

        const list = state.results;
        $("cloudList").innerHTML = !state.configured ? ""
            : !list ? "" : (list.length ? `<ul class="cloud-items">${list.map(item => `
            <li class="cloud-item">
              <div class="cloud-item-main">
                <b>${esc(item.title || "(无标题)")}</b>
                <span class="cloud-dim">${esc(when(item.createdAt))}
                  ${item.size ? `· ${Math.max(1, Math.round(item.size / 1024))} KB` : ""}
                  ${state.linked && state.linked.id === item.id ? "· 本机关联" : ""}</span>
                ${item.summary ? `<span class="cloud-item-sum">${esc(item.summary)}</span>` : ""}
              </div>
              <div class="cloud-item-actions">
                <button type="button" data-cloud-load="${esc(item.id)}">取回</button>
                <button type="button" data-cloud-delete="${esc(item.id)}">删除</button>
              </div>
            </li>`).join("")}</ul>` : '<p class="cloud-dim">云端还没有内容。</p>');

        $("cloudUpload").disabled = state.busy || !state.configured || !state.user;
        $("cloudRefresh").disabled = state.busy || !state.configured || !state.user;
        $("cloudMsg").textContent = state.message;
        $("cloudMsg").classList.toggle("cloud-error", !!state.error);

        root.querySelectorAll("[data-cloud-load]").forEach(button =>
            button.addEventListener("click", () => load(button.dataset.cloudLoad)));
        root.querySelectorAll("[data-cloud-delete]").forEach(button =>
            button.addEventListener("click", () => remove(button.dataset.cloudDelete)));
        const logout = $("cloudLogout");
        if (logout) logout.addEventListener("click", doLogout);
        const loginButton = $("cloudLogin");
        if (loginButton) loginButton.addEventListener("click", doLogin);
        const code = $("cloudCode");
        if (code) code.addEventListener("keydown", event => { if (event.key === "Enter") doLogin(); });
    }

    /** 统一包一层：busy 状态、错误归一、任何失败都只体现在面板里。 */
    async function run(work) {
        state.busy = true;
        try {
            await work();
        } catch (error) {
            setMessage(cloud.describeError(error), true);
        } finally {
            state.busy = false;
            render();
        }
    }

    async function refreshList() {
        state.results = await cloud.listResults();
    }

    function doLogin() {
        const code = $("cloudCode")?.value || "";
        return run(async () => {
            const user = await cloud.login(code);
            setMessage(`已登录 ${user?.qq ?? ""}`.trim());
            await refreshList();
        });
    }

    function doLogout() {
        return run(async () => {
            await cloud.logout();
            cloud.clearLink();
            state.results = null;
            setMessage("已退出登录");
        });
    }

    function upload() {
        const record = getRecord?.();
        return run(async () => {
            if (!record) throw new cloud.CloudError("empty", "本机还没有卡片：先去「账号包导入」导一次包");
            const payload = record;
            const body = {title: titleOf(record), summary: summaryOf(record), payload};
            const linked = cloud.linkedResult();
            if (linked && linked.id) {
                const updated = await cloud.updateResult(linked.id, {payload, version: linked.version});
                state.linked = {id: linked.id, version: updated?.version ?? (linked.version + 1),
                                savedAt: record.savedAt};
                setMessage("已覆盖云端那条结果");
            } else {
                const created = await cloud.createResult(body);
                state.linked = {id: created.id, version: created.version ?? 1, savedAt: record.savedAt};
                setMessage("已存到云端");
            }
            cloud.setLinkedResult(state.linked);
            await refreshList();
        });
    }

    function load(id) {
        return run(async () => {
            const item = await cloud.getResult(id);
            const payload = item?.payload;
            if (!payload || !Array.isArray(payload.entries) || !payload.entries.length) {
                throw new cloud.CloudError("empty", "这条结果里没有卡片数据");
            }
            const note = `已取回「${item.title || id}」`;
            // 取回之后整张卡片会重画一次（本面板也跟着重建），所以把提示一起交出去
            onRecordLoaded?.(payload, note);
            state.linked = {id, version: item.version ?? 1, savedAt: payload.savedAt};
            cloud.setLinkedResult(state.linked);
            setMessage(note);
            await refreshList();
        });
    }

    function remove(id) {
        if (!window.confirm("删除云端这条结果？本机卡片不受影响。")) return Promise.resolve();
        return run(async () => {
            await cloud.deleteResult(id);
            if (cloud.linkedResult()?.id === id) cloud.clearLink();
            await refreshList();
            setMessage("已删除");
        });
    }

    root.querySelector("#cloudSaveBase").addEventListener("click", () => run(async () => {
        cloud.setApiBase($("cloudBase").value);
        state.results = null;
        setMessage(cloud.isConfigured() ? "地址已保存" : "已清空地址（云端功能关闭）");
    }));
    root.querySelector("#cloudTest").addEventListener("click", () => run(async () => {
        const version = await cloud.dataVersion();
        // updatedAt 可能是 UTC 秒，也可能是 ISO 串 —— 两种都认
        const stamp = version?.updatedAt;
        const seconds = Number.isFinite(Number(stamp)) ? Number(stamp) : Date.parse(stamp) / 1000;
        setMessage(`连上了：数据版本 ${version?.dataVersion ?? "?"}`
            + `（更新于 ${when(seconds) || stamp || "?"}）`);
    }));
    root.querySelector("#cloudUpload").addEventListener("click", upload);
    root.querySelector("#cloudRefresh").addEventListener("click", () => run(async () => {
        await refreshList();
        setMessage("列表已刷新");
    }));

    // 挂载时**不发任何请求**：只根据本地状态把界面画出来
    render();
}
