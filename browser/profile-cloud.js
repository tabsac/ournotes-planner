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
    CloudError, apiBase, createResult, currentAccount, getResult, linkedResult, listResults,
    preparePayload, setLinkedResult, token, updateResult,
} from "./cloud-api.js";

const PUSH_DEBOUNCE_MS = 4000;
export const PROFILE_KIND = "profile";

/** 本地状态：'off'（未启用/未登录）/ 'idle' / 'dirty' / 'syncing' / 'synced' / 'conflict' / 'error' */
const state = {mode: "idle", at: 0, error: "", detail: ""};
const listeners = new Set();
let timer = null;
let hooks = null;
let busy = false;

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
    return !!apiBase() && !!token();
}

/**
 * 接上钩子。`hooks` = {getDocument, installDocument}：
 *   * `getDocument()` 拿当前卡库（导出的 JSON 形状，能直接喂给 normalizeImport）
 *   * `installDocument(doc)` 把一份卡库装进应用（返回 false 表示这会儿不能装，比如正在计算）
 */
export function attachProfileCloud(nextHooks) {
    hooks = nextHooks;
    if (!canSync()) { set(apiBase() ? "idle" : "off"); return; }
    set(linkedResult("profile") ? "synced" : "idle");
}

/** 登录态变化时由界面调用：刚登录就尝试认领云端已有的卡库（不自动覆盖本地）。 */
export async function onAuthChanged(account) {
    if (!account) { set("idle"); return; }
    try {
        const linked = linkedResult("profile");
        if (linked?.id) {
            const item = await getResult(linked.id).catch(error => {
                if (error instanceof CloudError && error.status === 404) {
                    setLinkedResult(null, "profile");
                    return null;
                }
                throw error;
            });
            if (item) { set("synced", {detail: "云端已有关联卡库"}); return; }
        }
        set("idle");
    } catch (error) {
        set("error", {error: error.message || String(error)});
    }
}

/** 本地卡库保存后调用（来自 profile-storage 的钩子）：延迟合并推送。 */
export function noteLocalSave() {
    if (!canSync()) { set(apiBase() ? "idle" : "off"); return; }
    set("dirty", {detail: "有新改动待上传"});
    clearTimeout(timer);
    timer = setTimeout(() => { push().catch(() => {}); }, PUSH_DEBOUNCE_MS);
}

/** 立刻推送（界面上的「立即同步」按钮也用它）。 */
export async function push() {
    if (!hooks) throw new CloudError("no_hooks", "卡库同步还没接上");
    if (!canSync()) throw new CloudError("unauthorized", "请先登录再同步卡库");
    if (busy) return null;
    busy = true;
    clearTimeout(timer);
    set("syncing");
    try {
        const document = hooks.getDocument();
        const prepared = preparePayload(document);
        const linked = linkedResult("profile");
        let result;
        if (linked?.id) {
            try {
                result = await updateResult(linked.id, {payload: payloadOf(prepared.payload), version: linked.version});
            } catch (error) {
                if (error instanceof CloudError && error.status === 409) {
                    set("conflict", {detail: "云端那条卡库被别的设备改过", error: error.message});
                    return null;
                }
                throw error;
            }
            setLinkedResult({id: linked.id, version: result?.version ?? (linked.version + 1)}, "profile");
        } else {
            const created = await createResult({
                title: titleOf(prepared.payload),
                summary: summaryOf(prepared.payload),
                payload: payloadOf(prepared.payload),
            });
            setLinkedResult({id: created.id, version: created.version ?? 1}, "profile");
            result = created;
        }
        set("synced", {detail: prepared.notice || ""});
        return result;
    } catch (error) {
        set("error", {error: error.message || String(error)});
        throw error;
    } finally {
        busy = false;
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
export async function pull(id) {
    const item = await getResult(id);
    const payload = item?.payload;
    const document = payload?.document ?? (payload?.profile ? payload : null);
    if (!document || !document.profile?.inventory) {
        throw new CloudError("empty", "这条结果里没有卡库数据");
    }
    if (typeof hooks?.installDocument !== "function") {
        throw new CloudError("no_hooks", "卡库同步还没接上");
    }
    const installed = hooks.installDocument(document);
    if (!installed) throw new CloudError("busy", "正在计算中，等这次算完再恢复卡库");
    setLinkedResult({id: item.id, version: item.version ?? 1}, "profile");
    set("synced", {detail: `已取回「${item.title || id}」`});
    return document;
}
