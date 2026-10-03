"""Static preview without APIs or isolation headers, including a Pages subpath."""
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import argparse

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=8877)
parser.add_argument("--prefix", default="/ournotes-planner/")
# 默认只监听本机；传 --host 0.0.0.0 可以让同一局域网里的手机访问（例如直接下载取包工具的 APK）
parser.add_argument("--host", default="127.0.0.1")
args = parser.parse_args()
directory = Path(__file__).resolve().parents[1] / "dist"


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm", ".mjs": "text/javascript", ".apk": "application/vnd.android.package-archive"}

    def do_GET(self):
        if self.path.startswith(args.prefix):
            self.path = "/" + self.path[len(args.prefix):]
            return super().do_GET()
        return self.send_error(404)

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer((args.host, args.port), partial(Handler, directory=str(directory)))
print(f"Static preview: http://{args.host}:{args.port}{args.prefix}", flush=True)
server.serve_forever()
