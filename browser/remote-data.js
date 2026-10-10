/**
 * 远端只读数据（`/data/*.json`）的消费 —— **只用来核对与提醒，不用来替换内置快照**。
 *
 * 为什么这样定位（重要）：
 *   * 求解与 B25 用的是**内置快照**（`browser/snapshot-override/…`），它由 `upstream.json`
 *     的 sha256 钉住，验收 oracle 也依赖它 —— 悄悄换成远端数据会让「同一份输入算不出同一个结果」；
 *   * 服务器那份 `/data/*.json` 每 6 小时重建，能告诉我们「游戏数据变了没有」；
 *   * 所以客户端做三件事：**① 校验拿到的字节（fileDigests.sha256）② 检测内容变更
 *     （contentDigests，别用 fileDigests —— 它每次重建都会变）③ 与本页内置快照逐首比对**，
 *     不一致就在界面顶部提示「线上数据已更新，本页仍用内置快照」。
 *
 * 没配后端（GitHub Pages 镜像）时**一个请求都不发**。
 */
import {apiBase, isConfigured} from "./cloud-api.js";

const VERSION_PATH = "/data/version.json";
const CACHE_KEY = "ournotes-remote-data-v1";
const BUNDLED_URL = "./static-data/snapshot-digest.json";
const MAX_REPORTED_DIFFS = 12;

/** 只读数据也要走 apiBase()（空串 = 同源；也可能是 /cloud-api 这种本地代理前缀）。
 *  ⚠️ 别写死成绝对路径 `/data/...`：那样在「显式配了 base」的部署里会打到网页自己的源上（踩过）。 */
const dataUrl = path => (apiBase() ?? "") + path;

const state = {
    checked: false,
    available: false,
    reason: "",                 // no_backend / unreachable / ok
    version: null,              // /data/version.json
    contentChanged: false,      // contentDigests 与上次不同
    integrity: null,            // "ok" | "failed" | "unavailable"
    bundled: null,              // static-data/snapshot-digest.json
    songs: null,                // {matches, added[], removed[], changed[], levelChanges, comboChanges}
    event: null,                // {remote, matches, bundled}
    error: "",
    checkedAt: 0,
};

const listeners = new Set();

function emit() {
    for (const listener of listeners) {
        try { listener({...state}); } catch { /* 订阅者异常不影响主流程 */ }
    }
}

export function onRemoteDataChange(listener) {
    listeners.add(listener);
    listener({...state});
    return () => listeners.delete(listener);
}

export function remoteDataState() {
    return {...state};
}

function readCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); } catch { return null; }
}

function writeCache(value) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(value)); } catch { /* 写不进去就算了 */ }
}

/** 等级格式化要和构建期 `build_browser.py:format_level()` 完全一致（判据是两边的 sha256 相等）。 */
function formatLevel(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "";
    const text = value.toFixed(2);
    return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

/** 把一首歌压成「等级/物量 × 4 难度」的字符串 —— 格式必须与构建期一致。 */
function songKey(song) {
    const byName = {};
    for (const chart of song?.charts || []) {
        byName[String(chart?.name || "").toUpperCase()] = chart;
    }
    return ["EASY", "NORMAL", "HARD", "EXPERT"].map(name => {
        const chart = byName[name] || {};
        const level = chart.display ?? chart.level;
        const combo = chart.combo;
        return `${formatLevel(Number(level))}/${combo === undefined || combo === null ? "" : Number(combo)}`;
    }).join("|");
}

function canonicalDigest(byId) {
    const ids = Object.keys(byId).sort((a, b) => Number(a) - Number(b));
    const body = ids.map(id => `${id}:${byId[id]}`).join("\n");
    return {text: `songs=${ids.length}\n${body}`, count: ids.length};
}

async function sha256Hex(buffer) {
    if (!globalThis.crypto?.subtle) return null;      // 老浏览器/非安全上下文：如实报「无法校验」
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** 取一个 JSON + **原始字节**（要按字节算 sha256，不能先 JSON.parse 再 stringify）。 */
async function fetchJsonWithBytes(url) {
    const response = await fetch(url, {cache: "no-store", credentials: "omit"});
    if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    return {buffer, json: JSON.parse(new TextDecoder().decode(buffer))};
}

function diffSongs(bundled, remote) {
    const added = [], removed = [], changed = [];
    let levelChanges = 0, comboChanges = 0;
    for (const song of remote.songs || []) {
        const id = String(song.id);
        const before = bundled.songsById?.[id];
        const after = songKey(song);
        if (!before) { added.push({id, title: song.title || "", after}); continue; }
        if (before === after) continue;
        const mine = before.split("|"), theirs = after.split("|");
        const diffs = [];
        ["EASY", "NORMAL", "HARD", "EXPERT"].forEach((name, index) => {
            const [myLevel, myCombo] = (mine[index] || "").split("/");
            const [theirLevel, theirCombo] = (theirs[index] || "").split("/");
            if (myLevel !== theirLevel) { diffs.push(`${name} 等级 ${myLevel || "-"} → ${theirLevel || "-"}`); levelChanges += 1; }
            if (myCombo !== theirCombo) { diffs.push(`${name} 物量 ${myCombo || "-"} → ${theirCombo || "-"}`); comboChanges += 1; }
        });
        changed.push({id, title: song.title || "", diffs});
    }
    const remoteIds = new Set((remote.songs || []).map(song => String(song.id)));
    for (const id of Object.keys(bundled.songsById || {})) {
        if (!remoteIds.has(id)) removed.push({id, before: bundled.songsById[id]});
    }
    return {matches: !added.length && !removed.length && !changed.length,
            added, removed, changed, levelChanges, comboChanges};
}

/**
 * 检查远端数据。`force` 时忽略缓存重新拉文件（默认只在 contentDigests 变了才拉）。
 * 任何失败都只是「数据状态不可用」，**不抛异常、不打扰用户**。
 */
export async function checkRemoteData({force = false} = {}) {
    state.checked = true;
    state.error = "";
    if (!isConfigured()) {
        state.available = false;
        state.reason = "no_backend";
        emit();
        syncDataNotice();
        return state;
    }
    try {
        const bundled = await fetch(BUNDLED_URL, {cache: "no-store"}).then(r => (r.ok ? r.json() : null)).catch(() => null);
        state.bundled = bundled;
        const version = await fetchJsonWithBytes(dataUrl(VERSION_PATH));
        state.version = version.json;
        const cached = readCache();
        const contentChanged = !cached || JSON.stringify(cached.contentDigests) !== JSON.stringify(version.json.contentDigests);
        state.contentChanged = contentChanged;

        // 内容没变、也不强制 → 直接用上次的比对结果，不再拉 57 KB
        if (!force && !contentChanged && cached?.songs && cached.bundledKey === JSON.stringify(bundled)) {
            state.available = true;
            state.reason = "ok";
            state.integrity = cached.integrity;
            state.songs = cached.songs;
            state.event = cached.event;
            state.checkedAt = cached.at || Date.now();
            emit();
            syncDataNotice();
            return state;
        }

        const songs = await fetchJsonWithBytes(dataUrl("/data/songs.json"));
        const events = await fetchJsonWithBytes(dataUrl("/data/events.json")).catch(() => null);
        const expected = version.json.fileDigests || {};
        const checks = [{name: "songs.json", ...songs}];
        if (events) checks.push({name: "events.json", ...events});
        let integrity = "ok";
        for (const item of checks) {
            const want = expected[item.name]?.sha256;
            const got = await sha256Hex(item.buffer);
            if (got === null) { integrity = "unavailable"; break; }
            if (want && got !== want) { integrity = "failed"; break; }
        }
        state.integrity = integrity;
        state.songs = bundled ? diffSongs(bundled, songs.json) : null;

        const remoteEvent = (events?.json?.events || []).find(e => e.id === events.json.currentEventId)
            || (events?.json?.events || [])[0] || null;
        state.event = remoteEvent ? {
            remote: {id: remoteEvent.id, name: remoteEvent.name,
                     startAt: remoteEvent.startAt, endAt: remoteEvent.endAt},
            bundled: bundled?.event || null,
            matches: !bundled?.event?.id ? null
                : (String(bundled.event.id) === String(remoteEvent.id)
                   && String(bundled.event.startAt || "") === String(remoteEvent.startAt || "")
                   && String(bundled.event.endAt || "") === String(remoteEvent.endAt || "")),
        } : null;

        state.available = true;
        state.reason = "ok";
        state.checkedAt = Date.now();
        writeCache({bundledKey: JSON.stringify(bundled), contentDigests: version.json.contentDigests, songs: state.songs,
                    event: state.event, integrity, at: state.checkedAt});
    } catch (error) {
        state.available = false;
        state.reason = "unreachable";
        state.error = String(error?.message || error);
    }
    emit();
    syncDataNotice();
    return state;
}

/** 需要给用户看的一句话（没问题返回 null）。 */
export function dataNotice() {
    if (!state.available) return null;
    if (state.integrity === "failed") {
        return "服务器数据校验失败（字节与清单不符）：这次不做数据对比，也不要用它做判断。";
    }
    const parts = [];
    if (state.songs && !state.songs.matches) {
        const bits = [];
        if (state.songs.added.length) bits.push(`新增 ${state.songs.added.length} 首`);
        if (state.songs.removed.length) bits.push(`少 ${state.songs.removed.length} 首`);
        if (state.songs.levelChanges) bits.push(`${state.songs.levelChanges} 处等级变化`);
        if (state.songs.comboChanges) bits.push(`${state.songs.comboChanges} 处物量变化`);
        parts.push(`线上曲目数据与内置快照不一致（${bits.join("、") || "有改动"}）`);
    }
    if (state.event && state.event.matches === false) {
        parts.push(`线上当前活动是「${state.event.remote.name}」（${state.event.remote.startAt} ~ ${state.event.remote.endAt}），`
            + `与本页内置的活动不同`);
    }
    if (!parts.length) return null;
    return parts.join("；")
        + "。服务器会自动更新游戏数据，页面会自动检查新版，并在当前操作结束后更新。";
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c =>
    ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));

function when(ms) {
    if (!ms) return "—";
    const d = new Date(ms);
    const pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 「数据状态」卡片：挂在「关于网页版」页里（`#dataStatusRoot`）。 */
export function mountDataStatusPanel(root) {
    if (!root) return;
    const render = () => {
        if (!state.checked) { root.innerHTML = '<p class="cloud-dim">正在检查数据…</p>'; return; }
        if (state.reason === "no_backend") {
            root.innerHTML = '<p class="cloud-dim">这个站点没有连接后端，看不到线上的数据版本'
                + '（计算用的是随网页发布的内置快照，不受影响）。</p>';
            return;
        }
        if (!state.available) {
            root.innerHTML = `<p class="cloud-dim">数据状态拿不到（${esc(state.error || "网络不可达")}）。</p>`;
            return;
        }
        const version = state.version || {};
        const files = version.files || [];
        const digests = version.fileDigests || {};
        const bundled = state.bundled || {};
        const songs = state.songs;
        const lines = [];
        lines.push(["线上数据版本", `${esc(version.dataVersion || "?")}（更新于 ${esc(version.updatedAt || "?")}）`]);
        lines.push(["内容变更（contentDigests）",
            state.contentChanged ? "<b>与上次不同</b>（服务器重建过数据）" : "与上次相同"]);
        lines.push(["字节校验（fileDigests）", state.integrity === "ok" ? "通过 ✓"
            : state.integrity === "failed" ? '<b class="cloud-error-text">失败——这次不做对比</b>'
            : "此浏览器不支持 crypto.subtle，跳过"]);
        lines.push(["曲目数据与内置快照", !songs ? "（只拉了 version，未对比）"
            : songs.matches ? `一致（${bundled.songs || "?"} 首）✓`
            : `<b>不一致</b>：新增 ${songs.added.length} / 少 ${songs.removed.length} /`
              + ` 等级变化 ${songs.levelChanges} / 物量变化 ${songs.comboChanges}`]);
        if (songs && !songs.matches && songs.changed.length) {
            lines.push(["", songs.changed.slice(0, MAX_REPORTED_DIFFS)
                .map(item => `${esc(item.title || item.id)}：${esc(item.diffs.join("，"))}`).join("<br>")
                + (songs.changed.length > MAX_REPORTED_DIFFS ? `<br>…还有 ${songs.changed.length - MAX_REPORTED_DIFFS} 首` : "")]);
        }
        if (state.event) {
            lines.push(["线上当前活动", `${esc(state.event.remote.name)}（${esc(state.event.remote.startAt)} ~`
                + ` ${esc(state.event.remote.endAt)}）`
                + (state.event.matches === null ? "" : state.event.matches ? " · 与内置一致 ✓" : " · <b>与内置不同</b>")]);
        }
        lines.push(["卡牌数据（cards.json）", digests["cards.json"]
            ? `未使用（${Math.max(1, Math.round((digests["cards.json"].bytes || 0) / 1024))} KB，`
              + `sha256 ${esc(String(digests["cards.json"].sha256 || "").slice(0, 12))}…）` : "—"]);
        lines.push(["内置快照", `${esc(bundled.snapshot || "?")} · ${bundled.songs || "?"} 首 ·`
            + ` MasterLiveMusic ${esc(String(bundled.tables?.MasterLiveMusic || "").slice(0, 8))}…`]);
        lines.push(["上次检查", esc(when(state.checkedAt))]);
        root.innerHTML = `<table class="data-status">${lines.map(([key, value]) =>
            `<tr><th>${esc(key)}</th><td>${value}</td></tr>`).join("")}</table>
          <p class="cloud-dim">远端数据只用来核对与提醒：求解与 B25 仍用内置快照
            （那份由公开源码的 sha256 钉住，验收 oracle 依赖它）。</p>
          <div class="cloud-line"><button id="dataStatusRefresh" type="button">重新检查（强制拉一份）</button>
            <span class="cloud-dim" id="dataStatusState"></span></div>`;
        const button = root.querySelector("#dataStatusRefresh");
        const label = root.querySelector("#dataStatusState");
        button.addEventListener("click", async () => {
            button.disabled = true;
            label.textContent = "正在拉取并校验…";
            try {
                await checkRemoteData({force: true});
                label.textContent = "已更新";
            } catch (error) {
                label.textContent = "失败：" + (error?.message || error);
            } finally {
                button.disabled = false;
            }
        });
    };
    onRemoteDataChange(render);
    render();
}

/** 顶部横幅：远端数据与内置快照不一致时提醒用户（可关闭，关掉后本次会话不再弹）。 */
let noticeDismissed = false;

export function syncDataNotice() {
    const text = noticeDismissed ? null : dataNotice();
    let panel = document.getElementById("remoteDataNotice");
    if (!text) { panel?.remove(); return; }
    if (!panel) {
        panel = document.createElement("div");
        panel.id = "remoteDataNotice";
        panel.className = "notice error";
        panel.setAttribute("role", "status");
        const anchor = document.getElementById("browserLoading");
        anchor?.after(panel);
    }
    panel.textContent = text + " ";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "secondary";
    close.textContent = "知道了";
    close.style.marginLeft = "8px";
    close.addEventListener("click", () => { noticeDismissed = true; panel.remove(); });
    panel.append(close);
}
