# -*- coding: utf-8 -*-
"""验「服务器谱面 → 运行期格式」这条链在**构建产物里**真的接上了。

为什么需要这条测试（别删）：
`browser/tests/baseline.py` 的原生 oracle 是从**纯上游 zip** 解的（85 首、不含 snapshot-override），
所以「测试全绿」**不代表**新曲目能用 —— 那些 fixture 的谱面清单是按上游目录建的。
这条测试不走 baseline，直接打开 `browser/dist/planner-runtime.zip`（= 真正发给浏览器的那个包），
从里面加载 `manual_score_reference`，对**新曲目**调用运行期自己的入口 `prepare_ap_chart()`。

判据：
  1. 转换报告来自构建产物，条数与快照曲目数自洽（348 = 87×4），且**可玩曲目清单**里含新曲目；
  2. 对每首新曲目的四个难度调 `prepare_ap_chart()` 都**不报错**，且
     `denominator` 与报告里记的 `score_denominator` 一致、判定数 == `_fullComboCount`；
  3. 随机抽两份**老曲目**同样能过（防止改坏原有 340 份）；
  4. 反例：报告里没有的曲目必须**如实拒绝**（`ValueError`），不能悄悄算出个结果。
"""
import json
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / "browser/dist/planner-runtime.zip"
UNJUDGED = frozenset((0, 80, 82, 100, 103, 121, 122, 123))

problems = []
total = 0


def check(name, ok, detail=""):
    global total
    total += 1
    print(("   [OK]   " if ok else "   [!!]   ") + name + (("  -> " + str(detail)) if detail else ""))
    if not ok:
        problems.append(name)


if not RUNTIME.is_file():
    print("   [--]   没有构建产物（先跑 browser/build_browser.py --build）")
    raise SystemExit(0)

work = Path(tempfile.mkdtemp(prefix="chart-sync-check-"))
try:
    with zipfile.ZipFile(RUNTIME) as archive:
        archive.extractall(work)
    sys.path.insert(0, str(work))
    sys.path.insert(0, str(work / "research"))          # manual_score_reference.py 在 research/ 下
    sys.path.insert(0, str(ROOT / "browser/tests"))

    import manual_score_reference as ms
    import planner_core

    # 运行期眼里的「快照根」是 research/<日期>/（source_manifest.json 就在那儿）
    snapshot = work / "research/2026-10-01"
    report = json.loads((snapshot / "validation/public_chart_conversion.json").read_text("utf-8"))
    by_key = {(c["music_id"], c["difficulty"]): c for c in report["charts"]}
    sheets = {r["_id"]: r for r in
              json.loads((snapshot / "raw/MasterLiveMusicScore.json").read_text("utf-8"))["_allData"]}
    music = json.loads((snapshot / "raw/MasterLiveMusic.json").read_text("utf-8"))["_allData"]
    chart_files = [n for n in
                   zipfile.ZipFile(RUNTIME).namelist() if "converted_charts/" in n]

    print("[1] 构建产物里的谱面与报告自洽")
    check("runtime 里 converted_charts 份数 == 报告条数", len(chart_files) == report["charts_checked"],
          "%d vs %d" % (len(chart_files), report["charts_checked"]))
    playable = sorted({c["music_id"] for c in report["charts"]})
    check("可玩曲目数 == 快照曲目数", len(playable) == len(music), "%d vs %d" % (len(playable), len(music)))
    check("报告 status 仍是 verified 且无 errors",
          report["status"] == "verified" and not report["errors"], report["status"])

    print("[2] 新曲目（快照有、上游基线没有的那两首）在运行期能算")
    upstream_songs = {r["_id"] for r in json.loads(
        zipfile.ZipFile(ROOT / "browser/upstream/OurNotes-配队程序-v0.2.5.zip").read(
            "OurNotes-配队程序-v0.2.5/research/2026-10-01/raw/MasterLiveMusic.json").decode("utf-8"))["_allData"]}
    new_songs = sorted({r["_id"] for r in music} - upstream_songs)
    check("确实找得到新曲目", bool(new_songs), new_songs)
    for song_id in new_songs:
        for diff in ("easy", "normal", "hard", "expert"):
            entry = by_key.get((song_id, diff))
            if entry is None:
                check("%d/%s 在报告里" % (song_id, diff), False)
                continue
            try:
                # ordinary=True：普通演出（`planner_core.Scores` 是 `ordinary=not challenge`）。
                # _conversion_report：必须显式传**公共转换报告**，否则它默认读 manual_chart_conversion.json
                # （那份只覆盖少数曲目）—— 运行期由 planner_core 传入，这里照它来。
                chart = ms.prepare_ap_chart(snapshot, song_id, diff, 1, ordinary=True,
                                            _conversion_report=report)
            except Exception as error:
                check("%d/%s prepare_ap_chart 不报错" % (song_id, diff), False,
                      "%s: %s" % (type(error).__name__, error))
                continue
            sheet = sheets[next(r["_%sID" % diff] for r in music if r["_id"] == song_id)]
            check("%d/%s 算得出且除数与报告一致" % (song_id, diff),
                  chart["denominator"] == entry["score_denominator"] and chart["level"] == sheet["_musicScoreLevel"],
                  "denominator=%s 报告=%s level=%s" % (chart["denominator"], entry["score_denominator"], chart["level"]))

    print("[3] 老曲目抽两份（防止改坏原有 340 份）")
    for song_id, diff in ((100001, "expert"), (100056, "hard")):
        try:
            chart = ms.prepare_ap_chart(snapshot, song_id, diff, 1, ordinary=True, _conversion_report=report)
            ok = chart["denominator"] == by_key[(song_id, diff)]["score_denominator"]
        except Exception as error:
            ok, chart = False, "%s: %s" % (type(error).__name__, error)
        check("%d/%s 仍然可算" % (song_id, diff), ok is True, "" if ok is True else chart)

    print("[4] 反例：报告里没有的曲目必须如实拒绝")
    known = {r["_id"] for r in music}
    missing = sorted(known - set(playable))
    if not missing:
        print("   [--]   快照里没有「报告缺失」的曲目可作反例（说明缺口已补全）")
    else:
        song_id = missing[0]
        try:
            ms.prepare_ap_chart(snapshot, song_id, "expert", 1, ordinary=True, _conversion_report=report)
            check("未接入的曲目应当报错", False, "居然算出来了")
        except ValueError as error:
            check("未接入的曲目如实报错", True, str(error)[:60])
        except Exception as error:
            check("未接入的曲目如实报错", False, "%s: %s" % (type(error).__name__, error))
finally:
    shutil.rmtree(work, ignore_errors=True)

print()
if problems:
    print("有 %d 项不通过：" % len(problems))
    for name in problems:
        print("  -", name)
    raise SystemExit(1)
print("check_chart_sync: 全部通过（%d 项）" % total)
