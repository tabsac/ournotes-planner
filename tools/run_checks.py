"""Run synthetic native references and real-browser static-site checks."""
from pathlib import Path
import argparse
import json
import os
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]

# 真机验证凭据（入库跟踪）：由 tools/mobile/ 那套真机工具链跑完后生成 ——
# 生产者是 tools/mobile/make_mobile_evidence.py，复现步骤见 tools/mobile/README.md。
# CI 上没有真机，所以这里**不猜**：凭据缺失 / 自称未通过 / 不是针对当前 browser 版本的，
# 一律如实报 False，并在 real_mobile_device.reason 里写清楚为什么。
MOBILE_EVIDENCE = Path(os.environ.get("OURNOTES_MOBILE_EVIDENCE")
                       or ROOT / "browser/tests/mobile-verification.json")

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=8878)
args = parser.parse_args()
dest = ROOT / "work/validation"
dest.mkdir(parents=True, exist_ok=True)
env = dict(os.environ, OURNOTES_BROWSER_URL=f"http://127.0.0.1:{args.port}/ournotes-planner/", PYTHONIOENCODING="utf-8")


def run(command):
    subprocess.run(command, cwd=ROOT, env=env, check=True)


def load_mobile_evidence(browser_version):
    """返回 (是否可信, 明细)。明细里永远带一个 reason 说明依据。"""
    if not MOBILE_EVIDENCE.exists():
        return False, {"verified": False, "evidence_file": str(MOBILE_EVIDENCE.relative_to(ROOT)),
                       "reason": "没有入库的真机验证凭据"}
    try:
        evidence = json.loads(MOBILE_EVIDENCE.read_text("utf-8"))
    except Exception as error:  # 凭据坏了就当没有，别让它把验收带崩
        return False, {"verified": False, "evidence_file": str(MOBILE_EVIDENCE.relative_to(ROOT)),
                       "reason": f"凭据无法解析：{error}"}
    evidence["evidence_file"] = str(MOBILE_EVIDENCE.relative_to(ROOT))
    if not evidence.get("verified"):
        evidence["reason"] = "凭据自己标记为未通过"
        return False, evidence
    recorded = (evidence.get("app") or {}).get("browser_version")
    if recorded != browser_version:
        evidence["reason"] = (f"凭据是针对 browser {recorded} 的真机验证，"
                              f"当前 browser 是 {browser_version} —— 需要重跑一次真机")
        return False, evidence
    evidence["reason"] = "凭据与当前 browser 版本一致"
    return True, evidence


for name in ("check_power_modes.py", "make_fixtures.py", "make_extra_fixtures.py", "make_judgement_fixture.py",
             "check_b25_selection.py", "check_snapshot_sync.py"):
    run([sys.executable, "-B", str(ROOT / "browser/tests" / name), str(dest)])
preview = subprocess.Popen([sys.executable, "-B", str(ROOT / "browser/tests/preview_server.py"), "--port", str(args.port)],
    cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
try:
    line = preview.stdout.readline()
    if not line.startswith("Static preview:"):
        raise RuntimeError("Static preview did not start: " + preview.stderr.read())
    print(line.strip(), flush=True)
    for name in ("check_browser.cjs", "check_lifecycle.cjs", "check_int64.cjs", "check_review.cjs",
                 "check_images.cjs", "check_cloud_sync.cjs"):
        run(["node", str(ROOT / "browser/tests" / name), str(dest)])
    run([sys.executable, "-B", str(ROOT / "browser/tests/check_score_oracles.py"), str(dest)])
    reports = {name: json.loads((dest / f"{name}-report.json").read_text("utf-8"))
               for name in ("browser", "lifecycle", "int64", "review", "images", "score-oracle", "power-modes",
                            "b25-selection")}
    if not all(report["passed"] for report in reports.values()):
        raise RuntimeError("One or more checks failed")
    browser_version = json.loads((ROOT / "browser/package.json").read_text("utf-8"))["version"]
    mobile_verified, mobile_detail = load_mobile_evidence(browser_version)
    summary = {"passed": True, "browser_version": browser_version,
               "core_version": reports["score-oracle"]["core_version"],
               "browser_checks": reports["browser"]["reports"], "lifecycle_checks": reports["lifecycle"]["reports"],
               "review_checks": reports["review"]["reports"], "image_checks": reports["images"]["reports"],
               "int64": reports["int64"], "score_oracle": reports["score-oracle"],
               "power_modes": reports["power-modes"],
               "b25_selection": reports["b25-selection"],
               "real_mobile_device_verified": mobile_verified,
               "real_mobile_device": mobile_detail}
    (dest / "validation-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), "utf-8")
    print("All native/browser checks passed", flush=True)
    print(f"real_mobile_device_verified = {mobile_verified}  ({mobile_detail.get('reason')})", flush=True)
finally:
    preview.terminate()
    try: preview.wait(timeout=10)
    except subprocess.TimeoutExpired: preview.kill(); preview.wait(timeout=10)
