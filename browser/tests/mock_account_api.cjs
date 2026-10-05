/**
 * 账号系统（v2）的**本地替身** —— 按《网页-服务器对接-账号系统变更.md》实现。
 *
 * 用途：在没有真实服务器时端到端测网页（注册/登录/me/改密/绑定 QQ/结果/503 限流/只读数据）。
 * 另外带几个**测试专用**内部接口：
 *   POST /api/internal/bind        {code, qq}   模拟机器人在 QQ 里收到 `/on绑定网页 <码>`
 *   POST /api/internal/status503   {count}      让接下来 count 个请求回 nginx 那种 503 HTML
 *   POST /api/internal/touch-result{id, by}     模拟「另一台设备改过这条结果」→ version 顶上去（制造 409）
 *   POST /api/internal/mutate-data {id, display, combo}  模拟「线上曲目数据变了」
 *
 * ⚠️ `GET /api/results` 每条**必须带 `kind`**（`payload.kind` 优先，老数据按形状嗅探）——
 *    这是真实服务端 2026-10-05 修复单 §3.1 的行为，客户端「按 kind 找最新一条」的自动同步
 *    依赖它。假后端不对齐的话，那条链路在替身上永远测不出来（修完了也过不了）。
 *
 *   node browser/tests/mock_account_api.cjs 8907
 */
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.argv[2] || 8907);
const MAX_PAYLOAD = 256 * 1024;
const MAX_RESULTS = 200;
const TOKEN_TTL = 30 * 24 * 3600;
const CODE_TTL = 600;

const accounts = new Map();   // id -> {id, username, username_lc, password, qq, createdAt}
const tokens = new Map();     // token -> accountId
const bindCodes = new Map();  // code -> {qq, accountId, expiresAt, used}
const results = new Map();    // id -> {id, accountId, title, summary, payload, version, createdAt, updatedAt}
let counter = 0;
let pending503 = 0;
let failLogins = 0;           // 该账号连续密码错误次数（≥10 → 429）

/* ---------------------------------------------------------------- 只读数据 */
// 按服务器契约产出 /data/*：fileDigests（线上字节的 sha256）+ contentDigests（去时间戳后的规范化 sha256）。
//
// ⚠️ 关键：**从构建产物里的 snapshot-digest.json 反推** songs.json，
//    这样「远端数据 == 内置快照」是**构造出来**的，网页端比对必须报「一致」；
//    内部接口 mutate-data 改一首歌，就能精确模拟「线上数据变了 N 处」。
const DIGEST_FILE = path.join(__dirname, "../dist/static-data/snapshot-digest.json");
const BUNDLED = JSON.parse(fs.readFileSync(DIGEST_FILE, "utf8"));
const DIFFS = ["EASY", "NORMAL", "HARD", "EXPERT"];

const dataSongs = {
    generated: "2026-10-05T00:00:00Z",
    count: Object.keys(BUNDLED.songsById).length,
    note: "mock（由内置快照反推，保证「一致」可测）",
    songs: Object.entries(BUNDLED.songsById)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([id, key]) => ({
            id: Number(id),
            title: `乐曲 ${id}`,
            charts: key.split("|").map((part, index) => {
                const [level, combo] = part.split("/");
                const display = Number(level);
                const chart = {name: DIFFS[index], level: Math.floor(display), display};
                if (combo !== "") chart.combo = Number(combo);
                return chart;
            }),
        })),
};
const dataEvents = {generated: "2026-10-05T00:00:00Z", count: 1,
    currentEventId: (BUNDLED.event && BUNDLED.event.id) || 1, note: "mock",
    events: [{id: (BUNDLED.event && BUNDLED.event.id) || 1, name: "内置活动（mock）",
              startAt: (BUNDLED.event && BUNDLED.event.startAt) || "",
              endAt: (BUNDLED.event && BUNDLED.event.endAt) || "", bonus: []}]};
const dataCards = {generated: "2026-10-05T00:00:00Z", counts: {characters: 25, memberCards: 64}};

const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");

/** 与服务器一致的口径：去掉 generated/updatedAt，键排序、无空白，再算 sha256。 */
function canonical(value) {
    const strip = node => {
        if (Array.isArray(node)) return node.map(strip);
        if (node && typeof node === "object") {
            const out = {};
            for (const key of Object.keys(node).sort()) {
                if (key === "generated" || key === "updatedAt") continue;
                out[key] = strip(node[key]);
            }
            return out;
        }
        return node;
    };
    return JSON.stringify(strip(value));
}

function dataFiles() {
    const pairs = [["songs.json", dataSongs], ["cards.json", dataCards], ["events.json", dataEvents]];
    return Object.fromEntries(pairs.map(([name, value]) => {
        const raw = JSON.stringify(value);
        return [name, {raw, fileDigest: sha256(raw), contentDigest: sha256(canonical(value))}];
    }));
}

const now = () => Math.floor(Date.now() / 1000);
const newToken = () => crypto.randomBytes(32).toString("base64url");   // 43 字符
const accountPublic = a => ({id: a.id, username: a.username, qq: a.qq ?? null, createdAt: a.createdAt});

/**
 * 这条结果是什么 kind —— **与真实服务端同一条规则**（服务器侧 `planner_api.py` 的 `result_kind()`，
 * 见修复单 §6）：
 *   1. payload 里出现 `"kind":"<x>"`（正则容忍冒号后空格）→ 原样透出；
 *   2. 否则含 `"document"` → profile；
 *   3. 否则含 `"entries"` 或 `"playerName"` → b25；
 *   4. 否则 → **`unknown`**（不是 null）。
 * 只看 payload 前 64 KB、不整段解析 —— 嗅探是**子串**判断，所以 payload 里恰好出现这些词就会命中。
 * 假后端必须逐字对齐：不然「替身绿、线上红」（或反过来）都测不出来。
 */
function sniffKind(payload) {
    const text = JSON.stringify(payload === undefined ? null : payload).slice(0, 64 * 1024);
    const explicit = /"kind"\s*:\s*"([^"]+)"/.exec(text);
    if (explicit) return explicit[1];
    if (text.includes("document")) return "profile";
    if (text.includes("entries") || text.includes("playerName")) return "b25";
    return "unknown";
}

/** 服务端侧的敏感字段剔除（红线：只存可公开结果）。 */
const SENSITIVE = /(access[_-]?key|id[_-]?token|token|credential|password|passwd|secret|sign|session|ssid|udid|device[_-]?id|\bmid\b|openid|cookie|authorization|auth[_-]?key)/i;
function stripSensitive(value, path = "payload", out = []) {
    if (Array.isArray(value)) { value.forEach((item, index) => stripSensitive(item, `${path}[${index}]`, out)); return value; }
    if (value && typeof value === "object") {
        for (const key of Object.keys(value)) {
            if (SENSITIVE.test(key)) { out.push(`${path}.${key}`); delete value[key]; }
            else stripSensitive(value[key], `${path}.${key}`, out);
        }
    }
    return value;
}

const send = (res, status, body, extra = {}) => {
    const payload = body === null ? "" : JSON.stringify(body);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(payload),
        "Access-Control-Allow-Origin": extra.origin || "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, If-None-Match",
        "Access-Control-Max-Age": "86400",
        ...extra.headers,
    });
    res.end(payload);
};
const fail = (res, status, error, message, origin) => send(res, status, {error, message}, {origin});

const readBody = req => new Promise(resolve => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve(null); } });
});

const USERNAME_RE = /^[A-Za-z0-9_.\-]{3,24}$/;

const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    if (req.method === "OPTIONS") return send(res, 204, null, {origin});

    // 模拟 nginx 限流：503 + **HTML**（客户端的坑就在这儿）
    if (pending503 > 0) {
        pending503 -= 1;
        const html = "<html><head><title>503 Service Temporarily Unavailable</title></head><body>503</body></html>";
        res.writeHead(503, {"Content-Type": "text/html", "Content-Length": Buffer.byteLength(html)});
        return res.end(html);
    }

    // ---- 测试专用内部接口 ----
    if (req.method === "POST" && path === "/api/internal/status503") {
        const body = await readBody(req);
        pending503 = Number(body?.count || 1);
        return send(res, 200, {pending503}, {origin});
    }
    // 模拟「另一台设备改了这条结果」：服务端 version 往上顶
    if (req.method === "POST" && path === "/api/internal/touch-result") {
        const body = await readBody(req) || {};
        const row = results.get(String(body.id || ""));
        if (!row) return fail(res, 404, "not_found", "没有这条结果", origin);
        row.version += Number(body.by || 1);
        row.updatedAt = now();
        return send(res, 200, {id: row.id, version: row.version}, {origin});
    }
    // 模拟「线上曲目数据变了」：改某首歌的显示等级/物量
    if (req.method === "POST" && path === "/api/internal/mutate-data") {
        const body = await readBody(req) || {};
        const song = dataSongs.songs.find(item => String(item.id) === String(body.id));
        if (!song) return fail(res, 404, "not_found", "没有这首歌", origin);
        const chart = song.charts.find(item => item.name === (body.difficulty || "EXPERT"));
        if (!chart) return fail(res, 404, "not_found", "没有这个难度", origin);
        if (body.display !== undefined) chart.display = Number(body.display);
        if (body.combo !== undefined) chart.combo = Number(body.combo);
        return send(res, 200, {song}, {origin});
    }
    if (req.method === "POST" && path === "/api/internal/bind") {
        const body = await readBody(req) || {};
        const code = String(body.code ?? "");
        const sender = String(body.qq ?? "");
        const row = bindCodes.get(code);
        if (!row || row.used || row.expiresAt < now()) {
            return fail(res, 200, "bind_failed", "绑定失败：绑定码不对或已过期", origin);
        }
        if (String(row.qq) !== sender) {
            // 关键行为：发错 QQ **不消耗**码
            return fail(res, 200, "bind_failed", "绑定失败：这个码不是发给这个 QQ 的", origin);
        }
        const other = [...accounts.values()].find(a => String(a.qq) === sender && a.id !== row.accountId);
        if (other) return fail(res, 200, "bind_failed", "绑定失败：这个 QQ 已经绑过别的账号了", origin);
        row.used = true;
        accounts.get(row.accountId).qq = sender;
        return send(res, 200, {ok: true, qq: sender}, {origin});
    }

    // ---- 只读数据 ----
    if (req.method === "GET" && path === "/data/version.json") {
        const files = dataFiles();
        return send(res, 200, {
            dataVersion: "2026-10-05",
            updatedAt: new Date().toISOString(),
            counts: {songs: dataSongs.songs.length, events: dataEvents.events.length},
            files: Object.keys(files),
            source: "mock",
            images: "not-available",
            fileDigests: Object.fromEntries(Object.entries(files).map(([name, item]) =>
                [name, {sha256: item.fileDigest, bytes: Buffer.byteLength(item.raw)}])),
            contentDigests: Object.fromEntries(Object.entries(files).map(([name, item]) =>
                [name, item.contentDigest])),
        }, {origin, headers: {"Cache-Control": "no-cache", ETag: '"mock-data"'}});
    }
    if (req.method === "GET" && path.startsWith("/data/") && path.endsWith(".json")) {
        const item = dataFiles()[path.slice("/data/".length)];
        if (!item) return fail(res, 404, "not_found", "没有这个数据文件", origin);
        res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": Buffer.byteLength(item.raw),
            "Access-Control-Allow-Origin": origin || "*",
            "Cache-Control": "public, max-age=300",
            ETag: '"' + item.fileDigest.slice(0, 16) + '"',
        });
        return res.end(item.raw);
    }

    // ---- 注册 / 登录 ----
    if (req.method === "POST" && path === "/api/register") {
        const body = await readBody(req);
        if (!body) return fail(res, 422, "unprocessable", "请求体不是 JSON", origin);
        const username = String(body.username || "");
        const password = String(body.password || "");
        if (!USERNAME_RE.test(username)) {
            return fail(res, 422, "unprocessable", "用户名 3–24 位，只能用字母数字和 _ . -", origin);
        }
        if (password.length < 8) return fail(res, 422, "unprocessable", "密码至少 8 位", origin);
        if ([...accounts.values()].some(a => a.username_lc === username.toLowerCase())) {
            return fail(res, 409, "conflict", "用户名已被占用", origin);
        }
        const account = {id: "acc_" + crypto.randomBytes(6).toString("hex"), username,
                         username_lc: username.toLowerCase(), password, qq: null, createdAt: now()};
        accounts.set(account.id, account);
        const token = newToken();
        tokens.set(token, account.id);
        return send(res, 201, {token, account: accountPublic(account), expiresIn: TOKEN_TTL}, {origin});
    }

    if (req.method === "POST" && path === "/api/login") {
        const body = await readBody(req) || {};
        if (body.code !== undefined && body.username === undefined) {     // v1 兼容路径
            const qq = String(body.code) === "123456" ? "39360001" : null;
            if (!qq) return fail(res, 401, "unauthorized", "登录码不对或已过期", origin);
            let account = [...accounts.values()].find(a => String(a.qq) === qq);
            if (!account) {
                account = {id: "acc_qq" + qq, username: "qq_" + qq, username_lc: ("qq_" + qq).toLowerCase(),
                           password: crypto.randomBytes(8).toString("hex"), qq, createdAt: now()};
                accounts.set(account.id, account);
            }
            const token = newToken();
            tokens.set(token, account.id);
            return send(res, 200, {token, account: accountPublic(account), expiresIn: TOKEN_TTL}, {origin});
        }
        const username = String(body.username || "");
        const account = [...accounts.values()].find(a => a.username_lc === username.toLowerCase());
        if (!account || account.password !== String(body.password || "")) {
            failLogins += 1;
            if (failLogins >= 10) return fail(res, 429, "rate_limited", "密码错太多次了，10 分钟后再试", origin);
            return fail(res, 401, "unauthorized", "用户名或密码不对", origin);
        }
        failLogins = 0;
        const token = newToken();
        tokens.set(token, account.id);
        return send(res, 200, {token, account: accountPublic(account), expiresIn: TOKEN_TTL}, {origin});
    }

    // ---- 以下都要 Bearer ----
    const auth = /^Bearer\s+(.+)$/.exec(req.headers.authorization || "");
    const accountId = auth ? tokens.get(auth[1]) : null;
    if (!accountId) return fail(res, 401, "unauthorized", "未登录或登录已过期", origin);
    const account = accounts.get(accountId);

    if (req.method === "POST" && path === "/api/logout") {
        tokens.delete(auth[1]);
        return send(res, 204, null, {origin});
    }

    if (req.method === "GET" && path === "/api/me") {
        return send(res, 200, {account: accountPublic(account)}, {origin});
    }

    if (req.method === "POST" && path === "/api/account/password") {
        const body = await readBody(req) || {};
        if (account.password !== String(body.oldPassword || "")) {
            return fail(res, 401, "unauthorized", "原密码不对", origin);
        }
        if (String(body.newPassword || "").length < 8) {
            return fail(res, 422, "unprocessable", "密码至少 8 位", origin);
        }
        account.password = String(body.newPassword);
        for (const [token, id] of [...tokens]) if (id === account.id) tokens.delete(token);   // 吊销全部
        return send(res, 204, null, {origin});
    }

    if (req.method === "POST" && path === "/api/bind/qq/start") {
        const body = await readBody(req) || {};
        const qq = String(body.qq ?? "").trim();
        if (!/^\d{5,12}$/.test(qq)) return fail(res, 422, "unprocessable", "QQ 号看起来不对", origin);
        const holder = [...accounts.values()].find(a => String(a.qq) === qq && a.id !== account.id);
        if (holder) return fail(res, 409, "conflict", `这个 QQ 已经绑过账号「${holder.username}」了`, origin);
        const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");   // 可能以 0 开头
        bindCodes.set(code, {qq, accountId: account.id, expiresAt: now() + CODE_TTL, used: false});
        return send(res, 200, {code, expiresIn: CODE_TTL, hint: `在机器人里发：/on绑定网页 ${code}`}, {origin});
    }

    if (req.method === "POST" && path === "/api/bind/qq/remove") {
        account.qq = null;
        return send(res, 204, null, {origin});
    }

    // ---- 结果 ----
    if (path === "/api/results" && req.method === "GET") {
        const list = [...results.values()].filter(r => r.accountId === account.id)
            .sort((a, b) => b.createdAt - a.createdAt)
            .map(r => ({id: r.id, kind: sniffKind(r.payload), title: r.title, summary: r.summary,
                        version: r.version, createdAt: r.createdAt, updatedAt: r.updatedAt,
                        size: Buffer.byteLength(JSON.stringify(r.payload))}));
        return send(res, 200, list, {origin});
    }

    if (path === "/api/results" && req.method === "POST") {
        const body = await readBody(req);
        if (!body || typeof body.payload === "undefined") return fail(res, 422, "unprocessable", "缺少 payload", origin);
        const stripped = [];
        const payload = stripSensitive(JSON.parse(JSON.stringify(body.payload)), "payload", stripped);
        const size = Buffer.byteLength(JSON.stringify(payload));
        if (size > MAX_PAYLOAD) return fail(res, 413, "too_large", "单条上限 256 KB", origin);
        const mine = [...results.values()].filter(r => r.accountId === account.id);
        if (mine.length >= MAX_RESULTS) return fail(res, 422, "unprocessable", "单账号最多 200 条", origin);
        const id = "r_" + crypto.randomBytes(5).toString("hex");
        const stamp = now();
        results.set(id, {id, accountId: account.id, title: body.title || "", summary: body.summary || "",
                         payload, version: 1, createdAt: stamp, updatedAt: stamp});
        const extra = stripped.length
            ? {stripped, notice: "服务器只保存可公开的运算结果，已剔除鉴权类字段"} : {};
        return send(res, 201, {id, version: 1, ...extra}, {origin});
    }

    const match = /^\/api\/results\/([^/]+)$/.exec(path);
    if (match) {
        const id = decodeURIComponent(match[1]);
        const row = results.get(id);
        if (!row || row.accountId !== account.id) return fail(res, 404, "not_found", "没有这条结果", origin);
        if (req.method === "GET") return send(res, 200, {...row, kind: sniffKind(row.payload)}, {origin});
        if (req.method === "PUT") {
            const body = await readBody(req) || {};
            if (Number(body.version) !== row.version) {
                return fail(res, 409, "conflict", "另一端改过这条结果", origin);
            }
            const stripped = [];
            const payload = stripSensitive(JSON.parse(JSON.stringify(body.payload)), "payload", stripped);
            const size = Buffer.byteLength(JSON.stringify(payload));
            if (size > MAX_PAYLOAD) return fail(res, 413, "too_large", "单条上限 256 KB", origin);
            row.payload = payload;
            row.version += 1;
            row.updatedAt = now();
            const extra = stripped.length
                ? {stripped, notice: "服务器只保存可公开的运算结果，已剔除鉴权类字段"} : {};
            return send(res, 200, {version: row.version, ...extra}, {origin});
        }
        if (req.method === "DELETE") {
            results.delete(id);
            return send(res, 204, null, {origin});
        }
    }

    return fail(res, 404, "not_found", "没有这个接口：" + path, origin);
});

server.listen(PORT, "127.0.0.1", () => {
    console.log(`mock account api: http://127.0.0.1:${PORT}`);
});
