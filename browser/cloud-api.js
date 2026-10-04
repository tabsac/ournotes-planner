/**
 * 云端接口客户端（服务器对接说明 §3/§4 的契约）。
 *
 * 设计原则（都是踩过坑的结论，别改）：
 *  1. **地址不硬编码**：优先读本机构建注入的 `<meta name="ournotes-api-base">`，
 *     其次读 localStorage（用户在界面上填的）。**没有配置 = 一个请求都不发**，
 *     页面完全离线可用（公开的 GitHub Pages 构建就是这种状态）。
 *  2. **默认离线优先**：所有调用都是「本地先成功、云端失败不阻塞」，失败只体现在同步状态上。
 *  3. **token 只放 Authorization 头**，绝不进 URL（会进日志/历史）。
 *  4. 时间与体量按契约：结果 JSON 单条 ≤ 256 KB、每账号 ≤ 200 条、时间用 UTC 秒。
 */

const META_SELECTOR = 'meta[name="ournotes-api-base"]';
const BASE_KEY = "ournotes-cloud-api-base";
const TOKEN_KEY = "ournotes-cloud-token";
const USER_KEY = "ournotes-cloud-user";
const RESULT_KEY = "ournotes-cloud-result";     // {id, version, savedAt} —— 用来决定 POST 还是 PUT

export const MAX_PAYLOAD_BYTES = 256 * 1024;
export const MAX_RESULTS = 200;
const TIMEOUT_MS = 15000;

/** 统一的错误对象：`.code` 是服务端错误码或 "network"/"not_configured"/"http"。 */
export class CloudError extends Error {
    constructor(code, message, status = 0) {
        super(message || code);
        this.name = "CloudError";
        this.code = code;
        this.status = status;
    }
}

function storage() {
    try { return window.localStorage; } catch { return null; }
}

function read(key) {
    try { return storage()?.getItem(key) ?? null; } catch { return null; }
}

function write(key, value) {
    try {
        if (value === null) storage()?.removeItem(key);
        else storage()?.setItem(key, value);
    } catch { /* 隐私模式写不进去就算了，功能降级但不报错 */ }
}

/** 地址来源：用户在界面里填的 > 构建时注入的 meta。返回 {base, source} 或 null。 */
export function apiBaseInfo() {
    const local = read(BASE_KEY);
    if (local !== null) return {base: local, source: "local"};
    const meta = document.querySelector(META_SELECTOR);
    if (meta) return {base: (meta.getAttribute("content") || "").trim(), source: "build"};
    return null;
}

/** 当前 API base（字符串，可能是空串 = 与网页同源）；null = 没配置，云端功能关闭。 */
export function apiBase() {
    const info = apiBaseInfo();
    if (!info) return null;
    return String(info.base || "").replace(/\/+$/, "");
}

export function isConfigured() {
    return apiBase() !== null;
}

export function setApiBase(base) {
    const value = String(base ?? "").trim().replace(/\/+$/, "");
    if (value && !/^(https?:\/\/|\/)/.test(value)) {
        throw new CloudError("bad_base", "地址要以 http(s):// 或 / 开头（留空 = 与网页同源）");
    }
    if (/["'<>\s]/.test(value)) throw new CloudError("bad_base", "地址里不能有引号、尖括号或空格");
    write(BASE_KEY, value);
    return value;
}

export function clearApiBase() {
    write(BASE_KEY, null);
}

export function token() {
    return read(TOKEN_KEY);
}

export function currentUser() {
    const raw = read(USER_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
}

/** 上一次上传/取回的云端条目（用于「覆盖更新」和冲突判断）。 */
export function linkedResult() {
    const raw = read(RESULT_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
}

function linkResult(info) {
    write(RESULT_KEY, info ? JSON.stringify(info) : null);
}

/** 记下「本机卡片对应云端哪一条」，供上传时决定 POST 还是 PUT。 */
export function setLinkedResult(info) {
    linkResult(info);
}

export function clearLink() {
    write(RESULT_KEY, null);
}

/** payload 的实际字节数（按 UTF-8 算，和服务端的判断一致）。 */
export function payloadBytes(payload) {
    const text = JSON.stringify(payload ?? null);
    return new TextEncoder().encode(text).length;
}

function url(path) {
    const base = apiBase();
    if (base === null) throw new CloudError("not_configured", "还没有配置服务器地址");
    return base + path;
}

/**
 * 发一个请求。**没配置就抛 not_configured（不发请求）**，网络/CSP 失败归一成 network。
 */
async function request(path, {method = "GET", body, auth = true} = {}) {
    const target = url(path);
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth) {
        const bearer = token();
        if (!bearer) throw new CloudError("unauthorized", "还没有登录", 401);
        headers["Authorization"] = "Bearer " + bearer;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response;
    try {
        response = await fetch(target, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller.signal,
            // 云端结果必须走网络：别让 Service Worker / 缓存给出过期数据
            cache: "no-store",
            credentials: "omit",
            mode: "cors",
        });
    } catch (error) {
        clearTimeout(timer);
        // abort / CSP 拒绝 / 跨域被挡 / 服务器不可达，都落到这里：错误信息要能指路
        const hint = error?.name === "AbortError"
            ? "请求超时"
            : "连不上服务器（网络不通、证书不对，或页面的 connect-src 没放行这个地址）";
        throw new CloudError("network", hint + "：" + (error?.message || error));
    }
    clearTimeout(timer);

    if (response.status === 204) return null;
    let data = null;
    const text = await response.text().catch(() => "");
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }
    if (!response.ok) {
        const code = (data && data.error) || "http";
        const message = (data && data.message) || `服务器返回 ${response.status}`;
        if (response.status === 401) { write(TOKEN_KEY, null); write(USER_KEY, null); }
        throw new CloudError(code, message, response.status);
    }
    return data;
}

/* ---------------------------------------------------------------- 登录 */

/** 用机器人给的一次性码换 token（服务器不存密码）。 */
export async function login(code) {
    const value = String(code || "").trim();
    if (!/^\d{4,8}$/.test(value)) throw new CloudError("bad_code", "登录码是 6 位数字");
    const data = await request("/api/login", {method: "POST", body: {code: value}, auth: false});
    if (!data || !data.token) throw new CloudError("bad_response", "服务器没有返回 token");
    write(TOKEN_KEY, data.token);
    write(USER_KEY, JSON.stringify({qq: data.qq ?? null, expiresIn: data.expiresIn ?? null,
                                    at: Math.floor(Date.now() / 1000)}));
    return currentUser();
}

export async function logout() {
    if (isConfigured() && token()) {
        // 撤销失败也要把本地清掉：用户点了「退出」就得退出
        try { await request("/api/logout", {method: "POST"}); } catch { /* 忽略 */ }
    }
    write(TOKEN_KEY, null);
    write(USER_KEY, null);
}

/* ------------------------------------------------------- 结果（只存展示用数据） */

export function listResults() {
    return request("/api/results").then(list => Array.isArray(list) ? list : []);
}

export function getResult(id) {
    return request("/api/results/" + encodeURIComponent(id));
}

export async function createResult({title, summary, payload}) {
    const bytes = payloadBytes(payload);
    if (bytes > MAX_PAYLOAD_BYTES) {
        throw new CloudError("too_large", `这条结果 ${Math.round(bytes / 1024)} KB，超过 256 KB 上限`);
    }
    const data = await request("/api/results", {method: "POST", body: {title, summary, payload}});
    return data;
}

export async function updateResult(id, {payload, version}) {
    const bytes = payloadBytes(payload);
    if (bytes > MAX_PAYLOAD_BYTES) {
        throw new CloudError("too_large", `这条结果 ${Math.round(bytes / 1024)} KB，超过 256 KB 上限`);
    }
    return request("/api/results/" + encodeURIComponent(id), {method: "PUT", body: {payload, version}});
}

export function deleteResult(id) {
    return request("/api/results/" + encodeURIComponent(id), {method: "DELETE"});
}

/* ------------------------------------------------------------ 只读数据接口 */

/** 服务器上的数据版本（§3）—— 用来「测试连接」，不需要登录。 */
export function dataVersion() {
    return request("/data/version.json", {auth: false});
}

/** 给界面用的一句话错误描述。 */
export function describeError(error) {
    if (error instanceof CloudError) {
        const table = {
            not_configured: "还没有配置服务器地址",
            unauthorized: "登录已过期，请重新用登录码进入",
            conflict: "另一端改过这条结果，先刷新再改",
            too_large: error.message,
            rate_limited: "操作太频繁，等一会儿再试",
            network: error.message,
        };
        return table[error.code] || error.message;
    }
    return String(error?.message || error);
}
