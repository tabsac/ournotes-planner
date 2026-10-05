"""门禁诚实性小测：把 run_checks.py 里的 load_mobile_evidence 单独抽出来跑几种情况。

不改动仓库文件，只在内存里 exec 那个函数体（它只依赖 os/json/Path/ROOT/MOBILE_EVIDENCE 这几个全局，
其余全靠参数传进来）。

  python tools/mobile/check_evidence_gate.py

⚠️ 第二种情况（「版本号没动但构建变了」）是 2026-10-05 补的：那天在同一个 0.3.2 下改了三次构建，
   旧门禁只比版本号 → 一份**旧构建**的凭据继续冒充「这份验过了」。现在凭据里钉了构建摘要，
   摘要不符必须判 False。
"""
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]      # tools/mobile -> 仓库根
sys.path.insert(0, str(ROOT / "tools" / "mobile"))
from build_digest import build_digest           # noqa: E402

src = (ROOT / "tools/run_checks.py").read_text("utf-8")
body = re.search(r"def load_mobile_evidence.*?(?=\nfor name in )", src, re.S).group(0)

ns = {"os": os, "json": json, "Path": Path, "ROOT": ROOT, "MOBILE_EVIDENCE": None}
exec(body, ns)
load = ns["load_mobile_evidence"]

real = ROOT / "browser/tests/mobile-verification.json"
tmp = ROOT / "work/mobile"                       # 沙箱只允许写 workspace 里的路径
tmp.mkdir(parents=True, exist_ok=True)

# 「当前版本」从 package.json 读，别写死：写死的话每发一版这个小测自己就烂掉
# （0.3.2 那次就是——凭据刷新后第一条报 BAD，其实是这里还停在 0.1.2）。
version = json.loads((ROOT / "browser/package.json").read_text("utf-8"))["version"]
build = build_digest(json.loads((ROOT / "browser/dist/build-info.json").read_text("utf-8")))
stale = "0.0.0-not-a-real-build"

cases = []

# ① 正常：入库凭据 + 版本一致 + 构建摘要一致
ns["MOBILE_EVIDENCE"] = real
cases.append((f"真凭据 / 版本一致（{version}）+ 摘要一致", load(version, build)))

# ② 版本不一致：凭据是旧版本的，就不能再声称「验过了」
doctored = tmp / "mismatch.json"
evidence = json.loads(real.read_text("utf-8"))
evidence["app"]["browser_version"] = stale
doctored.write_text(json.dumps(evidence, ensure_ascii=False), "utf-8")
ns["MOBILE_EVIDENCE"] = doctored
cases.append((f"凭据版本 {stale} vs 当前 {version}", load(version, build)))

# ③ 构建摘要不一致：**同一个版本号下换了构建**，旧凭据必须作废（这是新加的那道门）
doctored_build = tmp / "stale-build.json"
evidence_build = json.loads(real.read_text("utf-8"))
evidence_build.setdefault("app", {})["build"] = {
    "runtime_sha256": "0" * 64, "manifest_sha256": "1" * 64, "static_file_count": 0}
doctored_build.write_text(json.dumps(evidence_build, ensure_ascii=False), "utf-8")
ns["MOBILE_EVIDENCE"] = doctored_build
cases.append(("凭据是旧构建（摘要不符）", load(version, build)))

# ④ 旧格式凭据（没有构建摘要）：没法确认它对应哪份构建，一样不能算数
doctored_old = tmp / "no-build.json"
evidence_old = json.loads(real.read_text("utf-8"))
evidence_old.setdefault("app", {}).pop("build", None)
doctored_old.write_text(json.dumps(evidence_old, ensure_ascii=False), "utf-8")
ns["MOBILE_EVIDENCE"] = doctored_old
cases.append(("凭据没有构建摘要（旧格式）", load(version, build)))

# ⑤ 凭据自己说没通过
doctored2 = tmp / "failed.json"
evidence2 = json.loads(real.read_text("utf-8"))
evidence2["verified"] = False
doctored2.write_text(json.dumps(evidence2, ensure_ascii=False), "utf-8")
ns["MOBILE_EVIDENCE"] = doctored2
cases.append(("凭据自称未通过", load(version, build)))

# ⑥ 凭据根本不存在
ns["MOBILE_EVIDENCE"] = tmp / "nope.json"
cases.append(("凭据缺失", load(version, build)))

print(f"{'情况':<34} {'可信':<6} 依据")
ok = True
expect = [True, False, False, False, False, False]
for (name, (verified, detail)), want in zip(cases, expect):
    flag = "OK " if verified == want else "BAD"
    if verified != want:
        ok = False
    print(f"{flag} {name:<32} {str(verified):<6} {detail['reason']}")

print("\n门禁诚实性：" + ("全部符合预期" if ok else "有不符合预期的情况"))
raise SystemExit(0 if ok else 1)
