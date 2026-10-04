"""Static preview without APIs or isolation headers, including a Pages subpath.

`--api-proxy <base>` 会把 `/cloud-api/**` 的请求**同源**转发到 `<base>/**`（例如真实的
服务器地址，或 tests/mock_api_server.cjs）。这样本地（甚至线上）都不用碰 CORS，页面的
CSP 也只需要 `'self'` —— 对接服务器时最省事的一条路。
"""
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import argparse

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=8877)
parser.add_argument("--prefix", default="/ournotes-planner/")
# 默认只监听本机；传 --host 0.0.0.0 可以让同一局域网里的手机访问（例如直接下载取包工具的 APK）
parser.add_argument("--host", default="127.0.0.1")
# 同源 API 代理：把 --api-prefix 开头的请求转发到 --api-proxy（末尾不要带斜杠）
parser.add_argument("--api-proxy", default=None, help="例如 http://127.0.0.1:8901")
parser.add_argument("--api-prefix", default="/cloud-api")
args = parser.parse_args()
directory = Path(__file__).resolve().parents[1] / "dist"


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm", ".mjs": "text/javascript", ".apk": "application/vnd.android.package-archive"}

    def _proxy(self):
        """把 /cloud-api/xxx 转发成 <api-proxy>/xxx，原样带回状态码、头与正文。"""
        target = args.api_proxy.rstrip("/") + self.path[len(args.api_prefix):]
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        headers = {k: v for k, v in self.headers.items()
                   if k.lower() not in ("host", "connection", "content-length")}
        request = Request(target, data=body, headers=headers, method=self.command)
        try:
            with urlopen(request, timeout=30) as response:
                payload, status, response_headers = response.read(), response.status, response.headers
        except HTTPError as error:
            payload, status, response_headers = error.read(), error.code, error.headers
        except URLError as error:
            payload = ('{"error":"upstream_unreachable","message":"%s"}'
                       % str(error.reason).replace('"', "'")).encode("utf-8")
            status, response_headers = 502, {}
        self.send_response(status)
        for key, value in (response_headers.items() if response_headers else []):
            if key.lower() in ("content-length", "transfer-encoding", "connection"):
                continue
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(payload)))
        # 同源请求本来不需要 CORS，但带上无害，方便顺便测跨源分支
        self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin") or "*")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def _proxy_preflight(self):
        self.send_response(204)
        origin = self.headers.get("Origin") or "*"
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, If-None-Match")
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _route(self):
        path = self.path.split("?", 1)[0]
        # ⚠️ 先判 API 代理：前端用的是 `/cloud-api/api/...` 这种**根路径**，
        #    不带 Pages 的 `/ournotes-planner/` 前缀，顺序反了就会被当成 404。
        if args.api_proxy and (path == args.api_prefix or path.startswith(args.api_prefix + "/")):
            if self.command == "OPTIONS":
                return self._proxy_preflight()
            return self._proxy()
        if not path.startswith(args.prefix):
            return self.send_error(404)
        self.path = "/" + self.path[len(args.prefix):]
        if self.command not in ("GET", "HEAD"):
            return self.send_error(405)
        return super().do_GET()

    do_GET = do_HEAD = do_POST = do_PUT = do_DELETE = do_OPTIONS = _route

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer((args.host, args.port), partial(Handler, directory=str(directory)))
print(f"Static preview: http://{args.host}:{args.port}{args.prefix}", flush=True)
if args.api_proxy:
    print(f"API proxy: {args.api_prefix}/** -> {args.api_proxy.rstrip('/')}/**", flush=True)
server.serve_forever()
