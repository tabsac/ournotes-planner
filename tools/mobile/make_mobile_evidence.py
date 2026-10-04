"""把云手机真机验证的产出整理成一份**入库的凭据**，供 tools/run_checks.py 诚实引用。

背景：`tools/run_checks.py` 里的 `real_mobile_device_verified` 以前是写死的 False ——
CI 上确实没有真机，可脚本也就没法表达「真机上验过了」这件事。
现在改成：**读一份入库的凭据**（`browser/tests/mobile-verification.json`）。
这份凭据由本脚本生成，而本脚本只认**真实跑出来的结果文件**：

  * 每个用例都必须能让 `compare.js` 对着原生 oracle 逐条比过（PASSED），否则 verified=False；
  * `app.browser_version` 取自 app 自己的 build-info（改版之后旧凭据自动失效）；
  * 设备/浏览器/环境事实全部由命令行**显式**给出，不给默认值 —— 不给「忘记填就当成验过」的机会。

用法（见 tools/mobile/README.md，跑完 watch.js 之后）：

  python tools/mobile/make_mobile_evidence.py ^
    --serial 103.36.194.17:495 --model PCHM30 --android 11 --sdk 30 ^
    --webview 124.0.6367.179 --browser-package com.mmbox.xbrowser ^
    --cross-origin-isolated false --shared-array-buffer false --navigator-locks true ^
    --case solver-ap --case solver-mixed-rounding ^
    --cancel-result result-after-cancel-solver-ap.json

⚠️ 每次都**覆盖**凭据，失败的运行也会落成 verified=false —— 这是有意的：
   凭据记的是「最近一次真机验证」，这次没过就不该继续挂着一个旧的 true。
"""
from pathlib import Path
from datetime import datetime, timezone
import argparse
import json
import os
import subprocess
import sys

HERE = Path(__file__).resolve().parent          # tools/mobile
REPO_ROOT = HERE.parents[1]                     # 仓库根
OUT_DIR = Path(os.environ.get("MOBILE_OUT_DIR") or REPO_ROOT / "work" / "mobile")
DEFAULT_REPO = REPO_ROOT

parser = argparse.ArgumentParser()
parser.add_argument("--app-dir", default=str(DEFAULT_REPO), help="ournotes-team-planner-web 目录")
parser.add_argument("--out", default=None, help="凭据输出路径，默认 <app>/browser/tests/mobile-verification.json")
parser.add_argument("--serial", required=True)
parser.add_argument("--model", required=True)
parser.add_argument("--android", required=True)
parser.add_argument("--sdk", required=True)
parser.add_argument("--webview", required=True)
parser.add_argument("--browser-package", required=True)
parser.add_argument("--cross-origin-isolated", required=True, choices=["true", "false"])
parser.add_argument("--shared-array-buffer", required=True, choices=["true", "false"])
parser.add_argument("--navigator-locks", required=True, choices=["true", "false"])
parser.add_argument("--case", action="append", default=[], help="用例名，如 solver-ap（可多次）")
parser.add_argument("--cancel-result", default=None,
                    help="取消后重跑的结果文件（相对 phone_verify），会额外比一次 solver-ap 的 oracle")
parser.add_argument("--fixture-for-cancel", default="solver-ap")
parser.add_argument("--notes", default="")
args = parser.parse_args()

APP = Path(args.app_dir)
OUT = Path(args.out) if args.out else APP / "browser/tests/mobile-verification.json"

build_info = json.loads((APP / "browser/dist/build-info.json").read_text("utf-8"))


def compare(name, result_path, fixture=None):
    """跑 compare.js（与 check_browser.cjs 同一套判据）并保留原文。"""
    fixture = fixture or name
    proc = subprocess.run(["node", str(HERE / "compare.js"), fixture, str(result_path)],
                          cwd=HERE, capture_output=True, text=True, encoding="utf-8")
    lines = [line.rstrip() for line in (proc.stdout or "").strip().splitlines() if line.strip()]
    if proc.returncode != 0:
        err = [line.rstrip() for line in (proc.stderr or "").strip().splitlines() if line.strip()]
        lines = lines + err
    return proc.returncode == 0, lines


def summarize(result_path):
    payload = json.loads(Path(result_path).read_text("utf-8"))
    result = payload.get("result") or {}
    search = result.get("search") or {}
    plans = result.get("plans") or {}
    totals = {key: (plans.get(key) or {}).get("totals") for key in ("event_pt", "shop_pt")}
    return {"algorithm": search.get("algorithm"), "optimality_proven": search.get("optimality_proven"),
            "complete": search.get("complete"), "totals": totals}


cases = []
for name in args.case:
    result_path = OUT_DIR / f"result-{name}.json"
    case = {"name": name, "result_file": result_path.name}
    if not result_path.exists():
        case.update(compare="MISSING", ok=False, detail=["结果文件不存在，先跑 watch.js " + name])
    else:
        ok, lines = compare(name, result_path)
        case.update(compare="PASSED" if ok else "FAILED", ok=ok, compare_output=lines)
        case.update(summarize(result_path))
    cases.append(case)

if args.cancel_result:
    result_path = OUT_DIR / args.cancel_result
    case = {"name": f"after-cancel:{args.fixture_for_cancel}", "result_file": Path(args.cancel_result).name}
    if not result_path.exists():
        case.update(compare="MISSING", ok=False, detail=["取消后重跑的结果不存在，先跑 cancel_test.js"])
    else:
        ok, lines = compare(args.fixture_for_cancel, result_path)
        case.update(compare="PASSED" if ok else "FAILED", ok=ok, compare_output=lines)
        case.update(summarize(result_path))
    cases.append(case)

verified = bool(cases) and all(case["ok"] for case in cases)
evidence = {
    "schema": "ournotes-mobile-verification/1",
    "verified": verified,
    "checked_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
    "device": {"serial": args.serial, "model": args.model, "android": args.android, "sdk": int(args.sdk)},
    "browser": {"package": args.browser_package, "webview_version": args.webview},
    # 这三项是「手机自带浏览器」这件事本身：拿不到跨源隔离、没有 SharedArrayBuffer
    "environment": {
        "cross_origin_isolated": args.cross_origin_isolated == "true",
        "shared_array_buffer": args.shared_array_buffer == "true",
        "navigator_locks": args.navigator_locks == "true",
    },
    "app": {"browser_version": build_info.get("browser_version"), "core_version": build_info.get("core_version")},
    "cases": cases,
    "notes": args.notes or "云手机（无跨源隔离）上走应用自己的路径「导入 → 计算 → 导出」，与原生 oracle 逐条比对",
}

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), "utf-8")

for case in cases:
    print(f"{case['compare']:<8} {case['name']}  ({case['result_file']})")
    if case.get("compare_output"):
        for line in case["compare_output"]:
            print("    " + line)
print(f"\nverified={verified}  ->  {OUT}")
sys.exit(0 if verified else 1)
