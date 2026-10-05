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

# 构建摘要：与生产者（tools/mobile/make_mobile_evidence.py）共用同一份实现。
sys.path.insert(0, str(ROOT / "tools" / "mobile"))
sys.path.insert(0, str(ROOT / "tools"))
from build_digest import build_digest  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=8878)
parser.add_argument("--delivery", action="store_true",
                    help="额外跑交付护栏（tools/verify_delivery.py）：browser/dist 必须是**交付构建**"
                         "（带同源 api-base 标记）。发正式站前用；镜像发版流程默认不跑，"
                         "因为镜像构建本来就不许带那个标记。")
args = parser.parse_args()
dest = ROOT / "work/validation"
dest.mkdir(parents=True, exist_ok=True)
env = dict(os.environ, OURNOTES_BROWSER_URL=f"http://127.0.0.1:{args.port}/ournotes-planner/", PYTHONIOENCODING="utf-8")


def run(command):
    subprocess.run(command, cwd=ROOT, env=env, check=True)


def load_mobile_evidence(browser_version, build):
    """返回 (是否可信, 明细)。明细里永远带一个 reason 说明依据。

    ⚠️ 两道门都要过：**版本号** + **构建摘要**。
    为什么非要第二道：门禁原来只比 `browser_version`，而 2026-10-05 在同一个 0.3.2 下改了三次构建
    （运行期数据补谱面、JS 缓存键、APK）—— 于是凌晨那份 `verified=true` 继续冒充「线上这份验过了」，
    版本号对得上，谁也不会发现。摘要（`runtime_sha256` + 静态文件清单哈希）一改就变，
    「换了构建就得重跑真机」这件事才真的被强制住。
    """
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
    recorded_build = (evidence.get("app") or {}).get("build")
    if not recorded_build:
        evidence["reason"] = ("凭据里没有构建摘要（旧格式）—— 无法确认它对应的是当前这份构建，"
                              "需要按 tools/mobile/README.md 重跑一次真机")
        return False, evidence
    for key, label in (("runtime_sha256", "运行期数据"), ("manifest_sha256", "静态文件清单")):
        if recorded_build.get(key) != (build or {}).get(key):
            evidence["reason"] = (f"凭据的{label}摘要与当前构建不一致"
                                  f"（凭据 {str(recorded_build.get(key))[:16]}… vs "
                                  f"当前 {str((build or {}).get(key))[:16]}…）"
                                  "—— 「版本号没动但构建变了」，需要重跑一次真机")
            return False, evidence
    evidence["reason"] = "凭据与当前 browser 版本、构建摘要都一致"
    return True, evidence


for name in ("check_power_modes.py", "make_fixtures.py", "make_extra_fixtures.py", "make_judgement_fixture.py",
             "check_b25_selection.py", "check_snapshot_sync.py", "check_chart_sync.py"):
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
    current_build = build_digest(json.loads((ROOT / "browser/dist/build-info.json").read_text("utf-8")))
    mobile_verified, mobile_detail = load_mobile_evidence(browser_version, current_build)
    # 交付护栏：只在明确要发正式站时跑（见 --delivery 的说明）。
    # 放在这里而不是更早，是因为它检查的是**产物形态**，与前面那些功能检查互不相干；
    # 没过就当场抛错，别让它混进「全部通过」里（§11.1 那个"静默降级"的教训）。
    delivery = None
    if args.delivery:
        import verify_delivery
        delivery = verify_delivery.check_delivery(ROOT / "browser/dist")
        if not delivery["passed"]:
            raise RuntimeError("交付护栏没过 —— browser/dist 不是交付构建（发正式站会让云端功能静默失效）：\n"
                               + "\n".join("  FAIL %s: %s" % (item["name"], item["detail"])
                                           for item in delivery["checks"] if not item["ok"]))
        print("交付护栏 PASS：browser/dist 带同源 api-base 标记（index.html %d B, sha256 %s…）"
              % (delivery["index_html_bytes"], delivery["index_html_sha256"][:16]), flush=True)
    summary = {"passed": True, "browser_version": browser_version,
               "current_build": current_build,
               "core_version": reports["score-oracle"]["core_version"],
               "browser_checks": reports["browser"]["reports"], "lifecycle_checks": reports["lifecycle"]["reports"],
               "review_checks": reports["review"]["reports"], "image_checks": reports["images"]["reports"],
               "int64": reports["int64"], "score_oracle": reports["score-oracle"],
               "power_modes": reports["power-modes"],
               "b25_selection": reports["b25-selection"],
               "real_mobile_device_verified": mobile_verified,
               "real_mobile_device": mobile_detail,
               "delivery": delivery}
    (dest / "validation-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), "utf-8")
    print("All native/browser checks passed", flush=True)
    print(f"real_mobile_device_verified = {mobile_verified}  ({mobile_detail.get('reason')})", flush=True)
finally:
    preview.terminate()
    try: preview.wait(timeout=10)
    except subprocess.TimeoutExpired: preview.kill(); preview.wait(timeout=10)
