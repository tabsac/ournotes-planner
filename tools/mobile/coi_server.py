"""发真 COOP/COEP 头的最小静态服务，用来单独验证手机浏览器的跨源隔离能力。

    python -u on_cards/phone_verify/coi_server.py --port 8898
"""
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import argparse

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=8898)
parser.add_argument("--host", default="127.0.0.1")
args = parser.parse_args()
DIRECTORY = Path(__file__).resolve().parent / "coi"


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *a):
        pass


print(f"COI server: http://{args.host}:{args.port}/", flush=True)
ThreadingHTTPServer((args.host, args.port), partial(Handler, directory=str(DIRECTORY))).serve_forever()
