"""真机验证用的静态服务：**不发跨源隔离头**，另加一个探针结果收集端点。

和仓库自带的 browser/tests/preview_server.py 同源同前缀，只是多了：
  POST {prefix}_probe-report   把浏览器里探针发来的 JSON 追加到 reports.jsonl
  GET  {prefix}_probe-report   把已收集到的报告整包返回（主机侧轮询用）

刻意不发 COOP/COEP —— 这正是要复现的「手机自带浏览器」环境。

用法：
    python -u on_cards/phone_verify/server.py --port 8899
"""
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import argparse
import json
import threading

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=8899)
parser.add_argument("--host", default="127.0.0.1")
parser.add_argument("--prefix", default="/ournotes-planner/")
parser.add_argument("--sink", default=str(Path(__file__).resolve().parent / "reports.jsonl"))
parser.add_argument("--dir", default=None, help="要服务的目录，默认 browser/dist")
args = parser.parse_args()

ROOT = Path(__file__).resolve().parents[2]      # tools/mobile -> 仓库根
DIRECTORY = Path(args.dir).resolve() if args.dir else ROOT / "browser" / "dist"
SINK = Path(args.sink)
_lock = threading.Lock()


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".mjs": "text/javascript",
        ".apk": "application/vnd.android.package-archive",
    }
    protocol_version = "HTTP/1.1"

    # 关键：一个隔离头都不发。显式覆盖 do_GET 的父类实现即可保证。
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _sink_path(self):
        return args.prefix + "_probe-report"

    def do_GET(self):
        if self.path.split("?")[0] == self._sink_path():
            with _lock:
                body = SINK.read_bytes() if SINK.exists() else b""
            payload = b"[" + body.replace(b"\n", b",")[:-1] + b"]" if body else b"[]"
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if self.path.startswith(args.prefix):
            self.path = "/" + self.path[len(args.prefix):]
            return super().do_GET()
        return self.send_error(404)

    def do_POST(self):
        if self.path.split("?")[0] != self._sink_path():
            return self.send_error(404)
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        line = raw.decode("utf-8", "replace").strip() or "{}"
        try:
            parsed = json.loads(line)
            kind = parsed.get("type")
            note = parsed.get("step") or parsed.get("error") or ""
        except Exception:
            kind, note = "unparsed", line[:200]
        with _lock:
            with SINK.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")
        print(f"[probe] {kind} {note}", flush=True)
        body = b'{"ok":true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    print(f"无隔离静态服务：http://{args.host}:{args.port}{args.prefix}", flush=True)
    print(f"结果落盘：{SINK}", flush=True)
    ThreadingHTTPServer((args.host, args.port), partial(Handler, directory=str(DIRECTORY))).serve_forever()
