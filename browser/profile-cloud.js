/**
 * 卡库（个人养成）的云端同步 —— 把 `profile-storage.js` 包一层。
 *
 * 服务器侧没有「卡库」这个专门概念，只有**结果**（`/api/results`），所以卡库就是一条结果：
 *   title   = 「个人卡库 · <卡库名>」
 *   summary = 「N 张成员卡 / M 张留影卡」
 *   payload = { kind: "profile", document: <导出的卡库 JSON>, savedAt }
 *
 * 行为约定（照红线来）：
 *   * **只增不删、离线优先**：本地卡库永远先写成功；云端失败只把状态标成「未同步」，绝不阻塞编辑与计算。
 *   * 保存后**延迟几秒合并推送**（连续改动只推一次）。
 *   * 第一次推 POST，之后按 `version` 走 PUT；409 说明别的设备改过 → 标成冲突让用户决定。
 *   * 上传前用 `cloud-api.js` 的 `preparePayload` 过滤敏感字段并提示。
 */
import {
    CloudError, currentAccount, getResult, isConfigured, linkedResult, listResults,
    preparePayload, saveLinkedResult, setLinkedResult, token,
} from "./cloud-api.js";

const PUSH_DEBOUNCE_MS = 4000;
export const PROFILE_KIND = "profile";

/** 本地状态：'off'（未启用/未登录）/ 'idle' / 'dirty' / 'syncing' / 'synced' / 'conflict' / 'error' */
const state = {mode: "idle", at: 0, error: "", detail: "", profiles: [], restoreId: null};
const listeners = new Set();
let timer = null;
let hooks = null;
let busy = false;
let installing = false;
let epoch = 0;
let lastAuthIdentity = null;
let poll = null;
const identity = () => `${currentAccount()?.id ?? ""}:${token() ?? ""}`;
// Fingerprint is the complete sanitized document, excluding removed secrets.
// JSON.stringify preserves object enumeration order and array order; no key/card
// sorting or numeric tolerance is applied. Numbers follow JSON (including -0 -> 0);
// numeric strings remain distinct. savedAt is an envelope field, not part of doc.
// This assumes schema-normalized documents emitted by the same import pipeline.
// Different object key order can create a conservative false conflict; do not
// change serialization without migrating existing linked.fingerprint baselines.
const fingerprint = doc => JSON.stringify(preparePayload(doc).payload);
const acknowledge = (item, doc) => setLinkedResult({id: item.id, version: item.version ?? 1,
    fingerprint: fingerprint(doc)}, "profile");
const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { push().catch(() => {}); }, PUSH_DEBOUNCE_MS);
};

export async function reconcile() {
    if (!canSync() || !hooks || busy || state.mode === "conflict") return;
    const who = identity(), generation = epoch;
    const linked = linkedResult("profile");
    if (!linked?.id) {
        busy = true;
        try {
            const profiles = await listCloudProfiles();
            if (identity() !== who || epoch !== generation) return;
            state.profiles = profiles;
            state.restoreId = profiles.length === 1 ? profiles[0].id : null;
            if (!profiles.length) { set("idle"); return; }
            if (profiles.length === 1 && emptyLocal()) {
                set("syncing", {detail: "正在自动恢复云端卡库"});
                await pull(profiles[0].id, {onlyEmpty: true});
            } else {
                set("conflict", {detail: profiles.length > 1
                    ? `云端有 ${profiles.length} 份卡库，请从列表选择恢复，或保留本机另存`
                    : "本机已有内容，请选择恢复云端或保留本机另存"});
            }
        } catch (error) {
            if (identity() === who && epoch === generation) set("error", {error: error.message});
        } finally { busy = false; }
        return;
    }
    busy = true;
    try {
        const item = await getResult(linked.id);
        if (identity() !== who || epoch !== generation) return;
        const remote = item?.payload?.document;
        if (!remote?.profile?.inventory) throw new CloudError("empty", "云端卡库格式不正确");
        const local = fingerprint(hooks.getDocument()), cloud = fingerprint(remote);
        if (local === cloud) {
            acknowledge(item, remote);
            set("synced");
        } else if (!linked.fingerprint && emptyLocal()) {
            installing = true;
            let installed;
            try { installed = hooks.installDocument(remote); } finally { installing = false; }
            if (!installed) { set("dirty", {detail: "正在计算，稍后自动恢复云端卡库"}); return; }
            acknowledge(item, remote);
            set("synced", {detail: "已自动恢复云端卡库"});
        } else if (!linked.fingerprint) {
            set("conflict", {detail: "尚无共同同步记录，请选择保留本机或恢复云端"});
        } else if (cloud === linked.fingerprint) {
            // Local changes made offline or while uploading survive reloads.
            acknowledge(item, remote);
            set("dirty", {detail: "本机改动待上传"});
            schedule();
        } else if (local === linked.fingerprint) {
            installing = true;
            const installed = hooks.installDocument(remote);
            installing = false;
            if (!installed) { set("dirty", {detail: "正在计算，稍后自动取回云端更新"}); return; }
            acknowledge(item, remote);
            set("synced", {detail: "已自动取回云端更新"});
        } else {
            set("conflict", {detail: "两端都有新改动，请选择保留或恢复"});
        }
    } catch (error) {
        if (identity() === who && epoch === generation) set("error", {error: error.message});
    } finally { installing = false; busy = false; }
}

function emit() {
    for (const listener of listeners) {
        try { listener({...state}); } catch { /* 订阅者异常不影响同步 */ }
    }
}

export function onProfileSyncChange(listener) {
    listeners.add(listener);
    listener({...state});
    return () => listeners.delete(listener);
}

export function profileSyncState() {
    return {...state};
}

function set(mode, extra = {}) {
    state.mode = mode;
    state.error = extra.error ?? (mode === "error" ? state.error : "");
    state.detail = extra.detail ?? "";
    if (mode === "synced") state.at = Date.now();
    emit();
}

function summaryOf(document) {
    const members = document?.profile?.inventory?.members?.length ?? 0;
    const snaps = document?.profile?.inventory?.snaps?.length ?? 0;
    return `${members} 张成员卡 / ${snaps} 张留影卡`;
}

function titleOf(document) {
    const name = document?.name || "未命名卡库";
    return `个人卡库 · ${name}`;
}

function canSync() {
    // ⚠️ **不要**写成 `!!apiBase()`：同源部署时 apiBase() 返回的是**空串**（不是 null），
    //    空串在 JS 里是 falsy → 整个卡库同步会在同源形态下静默失效（v0.3.0 线上踩过，
    //    服务器侧靠源码级 A/B 定死）。判断「有没有启用云端」一律走 isConfigured()。
    return isConfigured() && !!token();
}

/**
 * 接上钩子。`hooks` = {getDocument, installDocument}：
 *   * `getDocument()` 拿当前卡库（导出的 JSON 形状，能直接喂给 normalizeImport）
 *   * `installDocument(doc)` 把一份卡库装进应用（返回 false 表示这会儿不能装，比如正在计算）
 */
export function attachProfileCloud(nextHooks) {
    hooks = nextHooks;
    set(canSync() ? "idle" : (isConfigured() ? "idle" : "off"));
    if (!poll) {
        poll = setInterval(() => { reconcile().catch(() => {}); }, 60000);
        window.addEventListener("focus", () => { reconcile().catch(() => {}); });
        window.addEventListener("online", () => { reconcile().catch(() => {}); });
    }
}

/** 登录态变化时由界面调用：刚登录就尝试认领云端已有的卡库（不自动覆盖本地）。 */
export async function onAuthChanged(account) {
    if (lastAuthIdentity === identity()) { await reconcile(); return; }
    lastAuthIdentity = identity();
    const generation = ++epoch, who = identity();
    clearTimeout(timer);
    state.profiles = [];
    state.restoreId = null;
    set("idle");
    if (!account) return;
    await reconcile();

}

/** 本地卡库保存后调用（来自 profile-storage 的钩子）：延迟合并推送。 */
export function noteLocalSave() {
    if (installing) return;
    if (state.mode === "conflict") return;
    if (!canSync()) { set(isConfigured() ? "idle" : "off"); return; }
    set("dirty", {detail: "有新改动待上传"});
    schedule();
}

/** 立刻推送（界面上的「立即同步」按钮也用它）。 */
export async function push() {
    if (!hooks) throw new CloudError("no_hooks", "卡库同步还没接上");
    // 本地守卫用**自己的**错误码，别复用 unauthorized（那会让界面把「没登录」说成「登录已过期」）
    if (!isConfigured()) throw new CloudError("not_configured", "这个站点没有启用云端功能");
    if (!token()) throw new CloudError("not_logged_in", "请先登录再同步卡库");
    if (state.mode === "conflict") throw new CloudError("conflict", "请先选择恢复云端或保留本机另存");
    if (busy) return null;
    busy = true;
    const who = identity(), generation = epoch;
    let sent = null, completed = false;
    clearTimeout(timer);
    set("syncing");
    try {
        const document = hooks.getDocument();
        const prepared = preparePayload(document);
        sent = fingerprint(prepared.payload);
        const body = {
            title: titleOf(prepared.payload),
            summary: summaryOf(prepared.payload),
            payload: payloadOf(prepared.payload),
        };
        // 有关联就 PUT；关联没了（换过账号 / 别处删了 / 服务端 404）就清掉关联重新 POST
        const result = await saveLinkedResult({which: "profile", ...body});
        if (identity() !== who || epoch !== generation) return null;
        if (result?.conflict) {
            set("conflict", {detail: "云端那条卡库被别的设备改过", error: result.error.message});
            return null;
        }
        const linked = linkedResult("profile");
        if (linked) setLinkedResult({...linked, fingerprint: sent}, "profile");
        completed = true;
        set("synced", {detail: prepared.notice || ""});
        return result;
    } catch (error) {
        if (identity() === who && epoch === generation) set("error", {error: error.message || String(error)});
        throw error;
    } finally {
        busy = false;
        if (completed && identity() === who && epoch === generation && fingerprint(hooks.getDocument()) !== sent) {
            set("dirty", {detail: "上传期间的新改动待上传"});
            schedule();
        }
    }
}

function payloadOf(document) {
    return {kind: PROFILE_KIND, document, savedAt: new Date().toISOString()};
}

/** 列出云端所有卡库类结果（不含 payload，界面按需再取）。 */
export async function listCloudProfiles() {
    const list = await listResults();
    return list.filter(item => /个人卡库/.test(item.title || ""));
}

/** 取回云端某条卡库并装进应用。 */
export async function pull(id, {onlyEmpty = false} = {}) {
    const who = identity(), generation = epoch;
    const item = await getResult(id);
    if (identity() !== who || epoch !== generation) throw new CloudError("session_changed", "账号已切换");
    const payload = item?.payload;
    const document = payload?.document ?? (payload?.profile ? payload : null);
    if (!document || !document.profile?.inventory) {
        throw new CloudError("empty", "这条结果里没有卡库数据");
    }
    if (typeof hooks?.installDocument !== "function") {
        throw new CloudError("no_hooks", "卡库同步还没接上");
    }
    if (onlyEmpty && !emptyLocal()) { set("conflict", {detail: "恢复前本机已有新改动，请选择恢复或另存"}); return null; }
    installing = true;
    let installed;
    try { installed = hooks.installDocument(document); } finally { installing = false; }
    if (!installed) throw new CloudError("busy", "正在计算中，等这次算完再恢复卡库");
    acknowledge(item, document);
    set("synced", {detail: `已取回「${item.title || id}」`});
    return document;
}

function emptyLocal() {
    const inventory = hooks?.getDocument()?.profile?.inventory;
    return !inventory || (!(inventory.members?.length) && !(inventory.snaps?.length));
}

export async function keepLocalAsNew() {
    if (busy) throw new CloudError("busy", "正在同步，请稍后再试");
    setLinkedResult(null, "profile");
    state.restoreId = null;
    set("idle");
    return push();
}
