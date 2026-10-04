"""门禁诚实性小测：把 run_checks.py 里的 load_mobile_evidence 单独抽出来跑四种情况。

不改动仓库文件，只在内存里 exec 那个函数体（它只依赖 os/json/Path/ROOT/MOBILE_EVIDENCE）。

  python tools/mobile/check_evidence_gate.py
"""
import json
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]      # tools/mobile -> 仓库根
src = (ROOT / "tools/run_checks.py").read_text("utf-8")
body = re.search(r"def load_mobile_evidence.*?(?=\nfor name in )", src, re.S).group(0)

ns = {"os": os, "json": json, "Path": Path, "ROOT": ROOT, "MOBILE_EVIDENCE": None}
exec(body, ns)
load = ns["load_mobile_evidence"]

real = ROOT / "browser/tests/mobile-verification.json"
tmp = ROOT / "work/mobile"                       # 沙箱只允许写 workspace 里的路径
tmp.mkdir(parents=True, exist_ok=True)

cases = []

# ① 正常：入库凭据 + 版本一致
ns["MOBILE_EVIDENCE"] = real
cases.append(("真凭据 / 版本一致", load("0.1.2")))

# ② 版本不一致：凭据是旧版本的，就不能再声称「验过了」
doctored = tmp / "mismatch.json"
evidence = json.loads(real.read_text("utf-8"))
evidence["app"]["browser_version"] = "0.1.1"
doctored.write_text(json.dumps(evidence, ensure_ascii=False), "utf-8")
ns["MOBILE_EVIDENCE"] = doctored
cases.append(("凭据版本 0.1.1 vs 当前 0.1.2", load("0.1.2")))

# ③ 凭据自己说没通过
doctored2 = tmp / "failed.json"
evidence2 = json.loads(real.read_text("utf-8"))
evidence2["verified"] = False
doctored2.write_text(json.dumps(evidence2, ensure_ascii=False), "utf-8")
ns["MOBILE_EVIDENCE"] = doctored2
cases.append(("凭据自称未通过", load("0.1.2")))

# ④ 凭据根本不存在
ns["MOBILE_EVIDENCE"] = tmp / "nope.json"
cases.append(("凭据缺失", load("0.1.2")))

print(f"{'情况':<26} {'可信':<6} 依据")
ok = True
expect = [True, False, False, False]
for (name, (verified, detail)), want in zip(cases, expect):
    flag = "OK " if verified == want else "BAD"
    if verified != want:
        ok = False
    print(f"{flag} {name:<24} {str(verified):<6} {detail['reason']}")

print("\n门禁诚实性：" + ("全部符合预期" if ok else "有不符合预期的情况"))
raise SystemExit(0 if ok else 1)
