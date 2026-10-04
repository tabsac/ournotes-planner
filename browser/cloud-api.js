/**
 * 云端接口客户端 v2（账号系统）—— 契约见《网页-服务器对接-账号系统变更.md》。
 *
 * 与 v1 的区别：
 *   * 登录从「机器人一次性码」改成 **账号 + 密码**（`POST /api/register` / `POST /api/login`）；
 *   * QQ 变成账号里的**绑定项**（`/api/bind/qq/start` + 轮询 `/api/me`）；
 *   * 新增 `GET /api/me`、`POST /api/account/password`；
 *   * `/api/results*` 契约一个字没变，但响应里可能多 `stripped`（服务端剔除了敏感字段）。
 *
 * 设计原则（沿用 v1，踩过坑的结论）：
 *   1. **地址不硬编码**：`<meta name="ournotes-api-base">`（本机构建注入，**空串 = 与网页同源**）
 *      → localStorage → 都没有则「云端未启用」，**一个请求都不发**（公开镜像站就是这种状态）。
 *   2. **离线优先**：任何云端失败都不阻塞本地功能（计算、卡库、导出照常）。
 *   3. **token 只进 `Authorization` 头**，绝不进 URL。
 *   4. **上传前自己先过滤**敏感字段（红线：抓包原文/凭据绝不能进 payload），
 *      服务端的 `stripped` 只是最后一道保险。
 *   5. **503 是 nginx 限流，返回的是 HTML 不是 JSON** —— 先看 `Content-Type` 再决定怎么解析，
 *      并且退避 1~2 秒自动重试一次。
 */

const META_SELECTOR = 'meta[name="ournotes-api-base"]';
const BASE_KEY = "ournotes-cloud-api-base";
const TOKEN_KEY = "ournotes-cloud-token";
const ACCOUNT_KEY = "ournotes-cloud-account";
const RESULT_KEY = "ournotes-cloud-result";          // B25 卡片关联的那条结果
const PROFILE_RESULT_KEY = "ournotes-cloud-profile";  // 卡库关联的那条结果
export const OFFICIAL_SITE = "https://on.tabsac.com/";

export const MAX_PAYLOAD_BYTES = 256 * 1024;
export const MAX_RESULTS = 200;
export const USERNAME_RE = /^[A-Za-z0-9_.\-]{3,24}$/;
export const MIN_PASSWORD = 8;
const TIMEOUT_MS = 15000;
const RATE_LIMIT_RETRY_MS = 1500;

/** 统一的错误对象：`.code` 是服务端错误码，或 "network"/"not_configured"/"http"/"rate_limited"。 */
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
    } catch { /* 隐私模式写不进去就降级，别报错 */ }
}

/* ------------------------------------------------------------------ 地址 */

/** {base, source} 或 null（null = 云端未启用）。 */
export function apiBaseInfo() {
    const local = read(BASE_KEY);
    if (local !== null) return {base: local, source: "local"};
    const meta = document.querySelector(META_SELECTOR);
    if (meta) return {base: (meta.getAttribute("content") || "").trim(), source: "build"};
    return null;
}

/** 当前 API base（**空串 = 与网页同源**）；null = 未启用。 */
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

/* ------------------------------------------------------------ 身份 / token */

export function token() {
    return read(TOKEN_KEY);
}

/** 本地记着的账号对象：{id, username, qq, createdAt}。 */
export function currentAccount() {
    const raw = read(ACCOUNT_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
}

function setAccount(account, expiresIn) {
    if (account) write(ACCOUNT_KEY, JSON.stringify(account));
    else write(ACCOUNT_KEY, null);
    if (expiresIn) write("ournotes-cloud-expires", String(Date.now() + Number(expiresIn) * 1000));
}

function setToken(value) {
    write(TOKEN_KEY, value || null);
    if (!value) write("ournotes-cloud-expires", null);
}

const authListeners = new Set();

/** 订阅登录态变化（登录/登出/被 401 踢掉），返回取消订阅函数。 */
export function onAuthChange(listener) {
    authListeners.add(listener);
    return () => authListeners.delete(listener);
}

function notifyAuth() {
    const account = currentAccount();
    for (const listener of authListeners) {
        try { listener(account); } catch { /* 别让订阅者的异常影响主流程 */ }
    }
}

function clearSession() {
    setToken(null);
    setAccount(null);
}

/* ------------------------------------------------------------------ 请求 */

function url(path) {
    const base = apiBase();
    if (base === null) throw new CloudError("not_configured", "这个站点没有启用云端功能");
    return base + path;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 判断响应是不是 JSON（503 是 nginx 的 HTML，直接 .json() 会抛）。 */
function isJson(response) {
    return (response.headers.get("Content-Type") || "").toLowerCase().includes("json");
}

async function parseBody(response) {
    if (response.status === 204) return null;
    if (!isJson(response)) {
        // nginx 限流页 / 网关错误页：只取一小段文本，别把整个 HTML 塞进错误里
        const text = await response.text().catch(() => "");
        return {__text: text.slice(0, 200)};
    }
    const text = await response.text().catch(() => "");
    if (!text) return null;
    try { return JSON.parse(text); } catch { return {__text: text.slice(0, 200)}; }
}

/**
 * 发一个请求。没配置就抛 not_configured（**不发请求**）；
 * 503（nginx 限流）退避后自动重试一次，仍失败抛 rate_limited。
 */
async function request(path, {method = "GET", body, auth = true, retryOn503 = true} = {}) {
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
            cache: "no-store",       // 云端结果必须走网络，别让 SW/缓存给过期数据
            credentials: "omit",
            mode: "cors",
        });
    } catch (error) {
        clearTimeout(timer);
        const hint = error?.name === "AbortError"
            ? "请求超时"
            : "连不上服务器（网络不通，或页面的 connect-src 没放行这个地址）";
        throw new CloudError("network", hint + "：" + (error?.message || error));
    }
    clearTimeout(timer);

    // nginx 限流：503 + HTML。等一下再试一次，别动不动就报「服务器挂了」。
    if (response.status === 503) {
        if (retryOn503) {
            await sleep(RATE_LIMIT_RETRY_MS);
            return request(path, {method, body, auth, retryOn503: false});
        }
        throw new CloudError("rate_limited", "操作太快了（服务器限流），请稍等几秒再试", 503);
    }

    const data = await parseBody(response);
    if (!response.ok) {
        const code = (data && !data.__text && data.error) || "http";
        let message = (data && !data.__text && data.message) || `服务器返回 ${response.status}`;
        if (response.status === 503) message = "操作太快了（服务器限流），请稍等几秒再试";
        if (response.status === 401 && auth) { clearSession(); notifyAuth(); }
        throw new CloudError(code, message, response.status);
    }
    return data;
}

/* ------------------------------------------------------------ 注册 / 登录 */

function validateCredentials(username, password) {
    const name = String(username || "").trim();
    if (!USERNAME_RE.test(name)) throw new CloudError("unprocessable", "用户名 3–24 位，只能用字母数字和 _ . -");
    if (String(password || "").length < MIN_PASSWORD) {
        throw new CloudError("unprocessable", `密码至少 ${MIN_PASSWORD} 位`);
    }
    return {username: name, password: String(password)};
}

/** 注册（成功即返回 token，不用再登录一次）。 */
export async function register(username, password) {
    const body = validateCredentials(username, password);
    const data = await request("/api/register", {method: "POST", body, auth: false});
    if (!data || !data.token) throw new CloudError("bad_response", "服务器没有返回 token");
    setToken(data.token);
    setAccount(data.account || {username: body.username}, data.expiresIn);
    notifyAuth();
    return currentAccount();
}

export async function login(username, password) {
    const body = validateCredentials(username, password);
    const data = await request("/api/login", {method: "POST", body, auth: false});
    if (!data || !data.token) throw new CloudError("bad_response", "服务器没有返回 token");
    setToken(data.token);
    setAccount(data.account || {username: body.username}, data.expiresIn);
    notifyAuth();
    return currentAccount();
}

/** v1 的机器人一次性码登录：**保留但不再在界面上引导**（老用户平滑）。 */
export async function loginWithCode(code) {
    const value = String(code || "").trim();
    const data = await request("/api/login", {method: "POST", body: {code: value}, auth: false});
    if (!data || !data.token) throw new CloudError("bad_response", "服务器没有返回 token");
    setToken(data.token);
    setAccount(data.account || {qq: data.qq}, data.expiresIn);
    notifyAuth();
    return currentAccount();
}

/** 拉一次自己的账号（绑定 QQ 的进度就靠轮询它）。 */
export async function me() {
    const data = await request("/api/me");
    const account = data?.account || null;
    if (account) setAccount(account);
    notifyAuth();
    return account;
}

/** 有 token 时校验一次登录态；没 token 直接返回 null（不发请求）。 */
export async function refreshSession() {
    if (!token() || !isConfigured()) return null;
    return me();
}

export async function logout() {
    if (isConfigured() && token()) {
        try { await request("/api/logout", {method: "POST"}); } catch { /* 撤销失败也要退出 */ }
    }
    clearSession();
    notifyAuth();
}

/** 本地清掉登录态（改密成功后服务端已吊销全部 token，不该再去调 logout）。 */
export function forgetSession() {
    clearSession();
    notifyAuth();
}

export async function changePassword(oldPassword, newPassword) {
    if (String(newPassword || "").length < MIN_PASSWORD) {
        throw new CloudError("unprocessable", `新密码至少 ${MIN_PASSWORD} 位`);
    }
    await request("/api/account/password", {
        method: "POST", body: {oldPassword: String(oldPassword || ""), newPassword: String(newPassword)},
    });
    // ⚠️ 服务端改密会吊销该账号**所有** token：本地必须清掉并回登录页
    clearSession();
    notifyAuth();
}

/* ------------------------------------------------------------- 绑定 QQ */

/** 取绑定码：返回 {code, expiresIn, hint}。code 是字符串（可能以 0 开头）。 */
export function bindQqStart(qq) {
    const value = String(qq ?? "").trim();
    if (!/^\d{5,12}$/.test(value)) throw new CloudError("unprocessable", "QQ 号看起来不对（5–12 位数字）");
    return request("/api/bind/qq/start", {method: "POST", body: {qq: value}});
}

export function bindQqRemove() {
    return request("/api/bind/qq/remove", {method: "POST"});
}

/** 绑定命令（照抄服务端 hint 的格式；机器人侧三种别名都认）。 */
export function bindCommand(code) {
    return `/on绑定网页 ${String(code ?? "").trim()}`;
}

/* ------------------------------------------------- 结果（服务器只存展示数据） */

/**
 * 客户端侧的敏感字段过滤（红线：抓包原文/凭据绝不能上传）。
 * 服务端还会再剔一遍（并在响应里回 `stripped`），但**第一道必须是我们自己**。
 */
const SENSITIVE = /(access[_-]?key|id[_-]?token|token|credential|password|passwd|secret|sign|session|ssid|udid|device[_-]?id|\bmid\b|openid|cookie|authorization|auth[_-]?key)/i;

export function sanitizePayload(value) {
    const removed = [];
    const walk = (node, path) => {
        if (Array.isArray(node)) {
            node.forEach((item, index) => walk(item, `${path}[${index}]`));
            return node;
        }
        if (node && typeof node === "object") {
            for (const key of Object.keys(node)) {
                if (SENSITIVE.test(key)) {
                    removed.push(`${path}.${key}`.replace(/^\./, ""));
                    delete node[key];
                } else {
                    walk(node[key], `${path}.${key}`);
                }
            }
        }
        return node;
    };
    const clean = walk(JSON.parse(JSON.stringify(value ?? null)), "payload");
    return {payload: clean, removed};
}

export function payloadBytes(payload) {
    return new TextEncoder().encode(JSON.stringify(payload ?? null)).length;
}

/** 上传前统一处理：过滤敏感字段 + 体积检查。返回 {payload, removed, bytes, notice}。 */
export function preparePayload(value) {
    const {payload, removed} = sanitizePayload(value);
    const bytes = payloadBytes(payload);
    if (bytes > MAX_PAYLOAD_BYTES) {
        throw new CloudError("too_large", `这条结果 ${Math.round(bytes / 1024)} KB，超过 256 KB 上限`);
    }
    const notice = removed.length ? `已自动移除 ${removed.length} 项敏感字段（${removed.slice(0, 3).join("、")}…）` : "";
    return {payload, removed, bytes, notice};
}

export function listResults() {
    return request("/api/results").then(list => Array.isArray(list) ? list : []);
}

export function getResult(id) {
    return request("/api/results/" + encodeURIComponent(id));
}

export async function createResult({title, summary, payload}) {
    const prepared = preparePayload(payload);
    const data = await request("/api/results", {
        method: "POST", body: {title, summary, payload: prepared.payload},
    });
    return {...data, stripped: data?.stripped || [], notice: data?.notice || prepared.notice,
            localNotice: prepared.notice, bytes: prepared.bytes};
}

export async function updateResult(id, {payload, version}) {
    const prepared = preparePayload(payload);
    const data = await request("/api/results/" + encodeURIComponent(id), {
        method: "PUT", body: {payload: prepared.payload, version},
    });
    return {...data, stripped: data?.stripped || [], notice: data?.notice || prepared.notice,
            localNotice: prepared.notice, bytes: prepared.bytes};
}

export function deleteResult(id) {
    return request("/api/results/" + encodeURIComponent(id), {method: "DELETE"});
}

/** 关联记录（本机某条本地数据 ↔ 云端哪一条），供「覆盖更新」用。 */
export function linkedResult(which = "b25") {
    const raw = read(which === "profile" ? PROFILE_RESULT_KEY : RESULT_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
}

export function setLinkedResult(info, which = "b25") {
    write(which === "profile" ? PROFILE_RESULT_KEY : RESULT_KEY, info ? JSON.stringify(info) : null);
}

/* ------------------------------------------------------------ 只读数据接口 */

export function dataVersion() {
    return request("/data/version.json", {auth: false});
}

/* ------------------------------------------------------------------ 错误文案 */

export function describeError(error) {
    if (error instanceof CloudError) {
        const table = {
            not_configured: "这个站点没有启用云端功能，请访问官方站点 " + OFFICIAL_SITE,
            unauthorized: error.message === "还没有登录" ? "请先登录" : "登录已过期，请重新登录",
            conflict: error.message,
            too_large: error.message,
            rate_limited: error.message,
            network: error.message,
            unprocessable: error.message,
        };
        return table[error.code] || error.message;
    }
    return String(error?.message || error);
}
