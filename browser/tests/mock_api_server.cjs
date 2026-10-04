/**
 * 服务器端接口的**本地替身**（按 `服务器-网页对接说明.md` §3/§4 的契约实现）。
 *
 * 用途：在没有真实服务器、也不把真实地址写进仓库的前提下，端到端测网页的云端功能。
 * 只实现网页会用到的那几条：登录、结果 CRUD、只读数据版本；外加契约里的
 * 401 / 409 / 413 / 422 / CORS / ETag 行为。
 *
 *   node browser/tests/mock_api_server.cjs 8907
 */
const http = require("http");

const PORT = Number(process.argv[2] || 8907);
const LOGIN_CODE = process.env.MOCK_LOGIN_CODE || "123456";
const MAX_PAYLOAD = 256 * 1024;
const MAX_RESULTS = 200;

const tokens = new Map();     // token -> qq
const results = new Map();    // id -> {id, title, summary, payload, version, createdAt, updatedAt}
let counter = 0;

const now = () => Math.floor(Date.now() / 1000);
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
const fail = (res, status, error, message, origin) =>
    send(res, status, {error, message}, {origin});

const readBody = req => new Promise(resolve => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve(null); } });
});

const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;
    if (req.method === "OPTIONS") return send(res, 204, null, {origin});

    // ---- 只读数据（§3）：不需要登录 ----
    if (req.method === "GET" && path === "/data/version.json") {
        const body = {dataVersion: "2026-10-04", updatedAt: new Date().toISOString()};
        const etag = '"v-2026-10-04"';
        if (req.headers["if-none-match"] === etag) {
            res.writeHead(304, {"ETag": etag, "Cache-Control": "no-cache"});
            return res.end();
        }
        return send(res, 200, body, {origin, headers: {ETag: etag, "Cache-Control": "no-cache"}});
    }
    if (req.method === "GET" && path === "/data/songs.json") {
        return send(res, 200, {songs: [{id: 100001, title: "mock"}]},
            {origin, headers: {ETag: '"songs-1"', "Cache-Control": "public, max-age=300"}});
    }

    // ---- 登录（§4.1）：一次性码换 token ----
    if (req.method === "POST" && path === "/api/login") {
        const body = await readBody(req);
        if (!body || String(body.code) !== LOGIN_CODE) {
            return fail(res, 401, "unauthorized", "登录码不对或已过期", origin);
        }
        const token = "t_" + Math.random().toString(36).slice(2) + counter++;
        tokens.set(token, "39360001");
        return send(res, 200, {token, qq: "39360001", expiresIn: 2592000}, {origin});
    }

    // ---- 以下都要 Bearer token ----
    const auth = /^Bearer\s+(.+)$/.exec(req.headers.authorization || "");
    const qq = auth ? tokens.get(auth[1]) : null;
    if (!qq) return fail(res, 401, "unauthorized", "未登录或 token 已失效", origin);

    if (req.method === "POST" && path === "/api/logout") {
        tokens.delete(auth[1]);
        return send(res, 204, null, {origin});
    }

    if (path === "/api/results" && req.method === "GET") {
        const list = [...results.values()]
            .sort((a, b) => b.createdAt - a.createdAt)
            .map(r => ({id: r.id, title: r.title, summary: r.summary, createdAt: r.createdAt,
                        size: Buffer.byteLength(JSON.stringify(r.payload))}));
        return send(res, 200, list, {origin});
    }

    if (path === "/api/results" && req.method === "POST") {
        const body = await readBody(req);
        if (!body || typeof body.payload === "undefined") {
            return fail(res, 422, "unprocessable", "缺少 payload", origin);
        }
        const size = Buffer.byteLength(JSON.stringify(body.payload));
        if (size > MAX_PAYLOAD) return fail(res, 413, "too_large", "单条上限 256 KB", origin);
        if (results.size >= MAX_RESULTS) return fail(res, 422, "too_many", "单账号最多 200 条", origin);
        const id = "r_" + (++counter);
        const stamp = now();
        results.set(id, {id, title: body.title || "", summary: body.summary || "",
                         payload: body.payload, version: 1, createdAt: stamp, updatedAt: stamp});
        return send(res, 201, {id, version: 1}, {origin});
    }

    const match = /^\/api\/results\/([^/]+)$/.exec(path);
    if (match) {
        const id = decodeURIComponent(match[1]);
        const row = results.get(id);
        if (!row) return fail(res, 404, "not_found", "没有这条结果", origin);
        if (req.method === "GET") return send(res, 200, row, {origin});
        if (req.method === "PUT") {
            const body = await readBody(req);
            if (!body || typeof body.payload === "undefined") {
                return fail(res, 422, "unprocessable", "缺少 payload", origin);
            }
            if (Number(body.version) !== row.version) {
                return fail(res, 409, "conflict", "另一端改过这条结果", origin);
            }
            const size = Buffer.byteLength(JSON.stringify(body.payload));
            if (size > MAX_PAYLOAD) return fail(res, 413, "too_large", "单条上限 256 KB", origin);
            row.payload = body.payload;
            row.version += 1;
            row.updatedAt = now();
            return send(res, 200, {version: row.version}, {origin});
        }
        if (req.method === "DELETE") {
            results.delete(id);
            return send(res, 204, null, {origin});
        }
    }

    return fail(res, 404, "not_found", "没有这个接口：" + path, origin);
});

server.listen(PORT, "127.0.0.1", () => {
    console.log(`mock api: http://127.0.0.1:${PORT}  (login code ${LOGIN_CODE})`);
});
