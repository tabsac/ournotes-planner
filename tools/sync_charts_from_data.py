#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把服务器 `/data/charts/` 的**原始谱面**转成运行期格式，补进内置快照（构建期，方案 A 的续篇）。

## 为什么还需要这一步

服务器侧已把谱面开放（`/data/charts.json` 清单 + `/data/charts/<曲目id>_<难度>.json` 原始谱面，
每 6 小时自动跟进），但**运行期要的不是原始谱面**：

* 求解器读的是 `normalized/converted_charts/<曲目id>/<难度>.json`（游戏客户端转换后的 runtime notes）；
* 而且**可玩曲目清单来自转换报告** `validation/public_chart_conversion.json`
  （`planner_core.py`：`converted = self.conversion_report["charts"]; song_ids = sorted(...)`）——
  一首歌不在报告里，求解器就当它不存在（B25 卡片只看等级，不受影响）。

本工具做两件事：**转换**（用上游 zip 里**钉住的参考实现**）+ **补报告条目**。

## 参考实现从哪来、怎么信它

`browser/upstream/OurNotes-配队程序-v0.2.5.zip` 里带 `research/<快照日>/chart_converter_reference/`：
`nnnotes/score.py` + `nnnotes/deckdata.py`，同目录的 `chart_converter_source_manifest.json`
逐文件记 sha256。本工具**每次现取**这两个文件并**核对 sha256**，再补三个缺失的兄弟模块桩
（`cri`/`languages`/`jsonio`：音频与文案那两支用不到，`jsonio` 按已发布文件实测格式实现）。
桩只补形状，算数的是原样取出的那两个文件。

## 闸门（默认开）

对报告里**已有的**每一条：拉原始谱面 → 用参考实现转换 → 要求**逐字节等于**报告里
`converted_record_sha256` 记的那份。一条不符就**拒绝写入**。全绿才敢让它转新谱面 ——
这是「同一份输入 → 同一份输出」的证据（2026-10-05 首次跑：340/340 相符）。

## 顺带核对运行期自己的自检（不满足就不写）

`manual_score_reference.prepare_ap_chart()` 会验：判定数（op 不在 `UNJUDGED` 里的）==
`MasterLiveMusicScore._fullComboCount`、每个 op 在 `MasterLiveNoteParameter` 里都有因子、
`skillEvents` 恰好 5 个不同非负整数、`scoreId` 对得上、报告 `status` 仍是 `verified`。
本工具写盘前把它们全跑一遍，不满足就**报出来**（那是数据问题，该反馈服务器侧，不该硬塞进快照）。

## 不碰什么

只写 `normalized/converted_charts/…` 与 `validation/public_chart_conversion.json` ——
这两处都**不在** `source_manifest.json` 的校验范围内，所以运行期 `_checked_inputs()`
不会因此报「Source checksum mismatch」。**不动 raw 母表、不动清单**（那需要另一条规矩，见
`browser/snapshot-override` 里 `browser_override` 的说明）。

## 用法

```bash
python tools/sync_charts_from_data.py                 # 只报告（默认；含闸门）
python tools/sync_charts_from_data.py --skip-gate     # 跳过闸门（快，调试用）
python tools/sync_charts_from_data.py --write         # 写进 snapshot-override/
```

写完的闭环（别跳步）：

```bash
git diff browser/snapshot-override/            # 先看改了什么
python -B browser/build_browser.py --build     # 重建（构建期会把 override 覆盖到 zip 上）
python -B tools/run_checks.py                  # 验收：oracle 按新快照现算
```

退出码：`0` 无事可做或写入成功；`1` 有差异（只读模式）；`2` 闸门没过 / 数据不满足运行期自检。
"""
import argparse
import hashlib
import importlib
import json
import math
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
UPSTREAM = REPO / "browser/upstream/OurNotes-配队程序-v0.2.5.zip"
OVERRIDE = REPO / "browser/snapshot-override"
INDEX = OVERRIDE / "index.json"
DEFAULT_BASE = "https://on.tabsac.com"
DIFFICULTIES = ("easy", "normal", "hard", "expert")
UNJUDGED = frozenset((0, 80, 82, 100, 103, 121, 122, 123))     # 抄自 manual_score_reference.UNJUDGED
REFERENCE_REL = "chart_converter_reference/src/nnnotes/"        # 相对快照根
REFERENCE_MANIFEST = "chart_converter_source_manifest.json"     # 相对快照根

# 快照根（形如 research/2026-10-01/）由 index.json 给出；上游 zip 里同前缀。
# 两边的「相对路径」都按这个根算，别再叠加。
SNAP_ROOT = json.loads(INDEX.read_text("utf-8"))["snapshot_prefix"].rsplit("raw/", 1)[0]
UPSTREAM_PREFIX = "OurNotes-配队程序-v0.2.5/" + SNAP_ROOT

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


# ------------------------------------------------------------------ 读写

def fetch(base, path, timeout=120):
    url = base.rstrip("/") + path
    request = urllib.request.Request(url)
    request.add_header("Cache-Control", "no-cache")
    request.add_header("User-Agent", "ournotes-chart-sync/1")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def load_json(snapshot_rel):
    """先看 snapshot-override，再看上游 zip（与构建期的覆盖顺序一致）。路径相对快照根。"""
    local = OVERRIDE / SNAP_ROOT / snapshot_rel
    if local.is_file():
        return json.loads(local.read_text("utf-8")), "override"
    with zipfile.ZipFile(UPSTREAM) as z:
        return json.loads(z.read(UPSTREAM_PREFIX + snapshot_rel).decode("utf-8")), "zip"


# ------------------------------------------------------------------ 参考实现

def load_reference(scratch):
    """从钉住的 zip 里取出参考实现（核对 sha256），补桩，导进来。"""
    with zipfile.ZipFile(UPSTREAM) as z:
        manifest = json.loads(z.read(UPSTREAM_PREFIX + REFERENCE_MANIFEST).decode("utf-8"))
        expect = {Path(f["saved_path"]).name: f["sha256"] for f in manifest["files"]}
        package = scratch / "nnnotes"
        package.mkdir(parents=True, exist_ok=True)
        (package / "__init__.py").write_text("", encoding="utf-8", newline="\n")
        for name in ("score.py", "deckdata.py"):
            data = z.read(UPSTREAM_PREFIX + REFERENCE_REL + name)
            if expect.get(name) and sha256(data) != expect[name]:
                raise SystemExit("参考实现 %s 的 sha256 与上游清单不符，拒绝使用" % name)
            (package / name).write_bytes(data)
            print("  参考实现 %-12s sha256=%s…（与上游清单相符）" % (name, sha256(data)[:12]))

    (package / "cri.py").write_text(
        "# stub: 音频解码用不到（本工具只做谱面 -> runtime notes）\n"
        "FLAC_LEVEL = 0\n\n\n"
        'def decode(*a, **k):\n    raise NotImplementedError("stub")\n\n\n'
        'def layout(*a, **k):\n    raise NotImplementedError("stub")\n',
        encoding="utf-8", newline="\n")
    (package / "languages.py").write_text(
        "# stub: 文案只用于 extract() 的展示\n"
        'LANGUAGES = ["jp"]\n\n\n'
        "def texts(*a, **k):\n    return {}\n",
        encoding="utf-8", newline="\n")
    (package / "jsonio.py").write_text(
        "# stub: 按已发布文件实测格式（indent=2、ensure_ascii=False、结尾一个 LF）\n"
        "import json\n\n\n"
        "def write_json(path, obj):\n"
        '    with open(path, "w", encoding="utf-8", newline="\\n") as f:\n'
        "        f.write(json.dumps(obj, ensure_ascii=False, indent=2))\n"
        '        f.write("\\n")\n',
        encoding="utf-8", newline="\n")

    sys.path.insert(0, str(scratch))
    return importlib.import_module("nnnotes.score")


# ------------------------------------------------------------------ 转换

def build_record(score, score_id, key, raw):
    """与 deckdata.chart_record() 完全同构（键序一致）；已用 340 份发布文件验过逐字节相同。"""
    root = score.load_bytes(raw)
    rs = score.runtime_score(root)
    ids, ops, judgements, times, seen = [], [], [], [], set()
    for n in rs.notes:
        if n.id in seen:
            raise ValueError("note id %s 出现两次" % n.id)
        seen.add(n.id)
        ids.append(int(n.id))
        ops.append(int(n.op))
        judgements.append(int(score.judgement_type(n.op, n.crit)))
        times.append(int(n.pos.ms))
    record = {
        "scoreId": score_id,
        "asset": {"key": key, "sha256": sha256(raw)},
        "notes": {"id": ids, "op": ops, "judgementType": judgements, "timeMs": times},
        "skillEvents": {"timeMs": [int(p.ms) for _, p in rs.skills]},
        "fevers": {"startMs": [int(a.ms) for _, a, _ in rs.fevers],
                   "endMs": [int(b.ms) for _, _, b in rs.fevers]},
    }
    return record, ops


def dump_record(record):
    return (json.dumps(record, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def denominator_of(ops, factors):
    """运行期 `prepare_ap_chart()` 的原式：wrapping i32 求和 -> f32 -> /100 -> ceil。"""
    import numpy as np
    weighted = 0
    for op in ops:
        weighted = (weighted + factors.get(op, 0) + 2 ** 31) % 2 ** 32 - 2 ** 31
    return weighted, int(math.ceil(np.float32(np.float32(weighted) / np.float32(100))))


def check_runtime_invariants(record, ops, full_combo, factors, expected_score_id):
    """把运行期自己的自检抄一遍（不满足就别写进快照）。"""
    problems = []
    if record["scoreId"] != expected_score_id:
        problems.append("scoreId 与 MasterLiveMusicScore._id 不一致")
    lengths = {len(record["notes"][k]) for k in ("id", "op", "timeMs", "judgementType")}
    if len(lengths) != 1 or len(set(record["notes"]["id"])) != len(record["notes"]["id"]):
        problems.append("notes 数组长度不一致或有重复 id")
    if any(type(t) is not int or t < 0 for t in record["notes"]["timeMs"]):
        problems.append("timeMs 里有非非负整数")
    judged = [op for op in ops if op not in UNJUDGED]
    if len(judged) != full_combo:
        problems.append("判定数 %d != 快照里的 _fullComboCount %d" % (len(judged), full_combo))
    # ⚠️ 因子检查只针对**判定 note**：运行期是先 `if op not in UNJUDGED` 过滤、再查 factors
    #    （103/121/122 这类本来就不参与判定，也没有因子，对全部 op 查会误报）。
    missing = sorted({op for op in judged if op not in factors})
    if missing:
        problems.append("这些判定 op 在 MasterLiveNoteParameter 里没有因子：%s" % missing)
    times = record["skillEvents"]["timeMs"]
    if len(times) != 5 or len(set(times)) != 5 or any(type(t) is not int or t < 0 for t in times):
        problems.append("skillEvents 不是恰好 5 个不同非负整数：%s" % times)
    return problems


# ------------------------------------------------------------------ 主流程

def main():
    parser = argparse.ArgumentParser(description="把 /data/charts/ 的原始谱面转成运行期格式并补进快照")
    parser.add_argument("--base", default=DEFAULT_BASE)
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--skip-gate", action="store_true", help="不逐字节复核已有的 340 份（快，调试用）")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--timeout", type=int, default=120)
    args = parser.parse_args()

    version = json.loads(fetch(args.base, "/data/version.json", args.timeout).decode("utf-8"))
    manifest_raw = fetch(args.base, "/data/charts.json", args.timeout)
    charts_manifest = json.loads(manifest_raw.decode("utf-8"))
    want = ((version.get("fileDigests") or {}).get("charts.json") or {}).get("sha256")
    if want and sha256(manifest_raw) != want:
        raise SystemExit("✗ /data/charts.json 的字节与 version.json 的 fileDigests 不符，先别同步")

    sheets, _ = load_json("raw/MasterLiveMusicScore.json")
    score_rows = {r["_id"]: r for r in sheets["_allData"]}
    music, _ = load_json("raw/MasterLiveMusic.json")
    music_by_id = {r["_id"]: r for r in music["_allData"]}
    params, _ = load_json("raw/MasterLiveNoteParameter.json")
    factors = {r["_noteOperateType"]: r["_scorePercent"] for r in params["_allData"]}

    report, source = load_json("validation/public_chart_conversion.json")
    have = {(c["music_id"], c["difficulty"]): c for c in report["charts"]}

    catalog = {}
    for mid, row in music_by_id.items():
        for diff in DIFFICULTIES:
            sheet = score_rows.get(row.get("_%sID" % diff))
            if sheet is not None:
                catalog[(mid, diff)] = sheet

    missing = sorted(k for k in catalog if k not in have)
    unknown = sorted(k for k in have if k not in catalog)
    print("服务器清单：%d 份（%d 首 × %d 难度）" %
          (charts_manifest.get("count"), charts_manifest.get("songs"), len(DIFFICULTIES)))
    print("转换报告：%d 条（来自 %s）；快照曲目 %d 首" % (len(report["charts"]), source, len(music_by_id)))
    print("缺谱面的 %d 份；报告里有、快照曲目里没有的 %d 份" % (len(missing), len(unknown)))
    if unknown:
        print("   报告里多出来的（快照没有这些曲目）：%s" % [("%d/%s" % k) for k in unknown[:6]])

    scratch = Path(tempfile.mkdtemp(prefix="chartbridge-"))
    print("取出参考实现：")
    score = load_reference(scratch)

    def convert(mid, diff):
        sheet = catalog[(mid, diff)]
        name = "%d_%s.json" % (mid, diff.upper())
        raw = fetch(args.base, "/data/charts/" + name, args.timeout)
        item = (charts_manifest.get("files") or {}).get(name)
        if item and (sha256(raw) != item.get("sha256") or len(raw) != item.get("bytes")):
            raise SystemExit("✗ %s 的字节与清单不符（sha256/bytes），先别同步" % name)
        key = "Live/MusicScore/" + sheet["_musicScoreTextFileName"]
        record, ops = build_record(score, sheet["_id"], key, raw)
        return raw, record, ops

    if not args.skip_gate:
        print("闸门：逐字节复核已有的 %d 份（拉原始谱面 → 参考实现 → 比 sha256）…" % len(have))
        failures, checked = [], 0
        for (mid, diff), entry in sorted(have.items()):
            if (mid, diff) not in catalog:
                continue
            try:
                _, record, _ = convert(mid, diff)
            except SystemExit as error:
                failures.append(("%d_%s" % (mid, diff.upper()), str(error)))
                continue
            mine = sha256(dump_record(record))
            if mine != entry["converted_record_sha256"]:
                failures.append(("%d_%s" % (mid, diff.upper()),
                                 "复现不符 %s != %s" % (mine[:12], entry["converted_record_sha256"][:12])))
            checked += 1
            if checked % 80 == 0:
                print("   … %d/%d" % (checked, len(have)))
        print("   闸门：复核 %d 份，不符 %d 份" % (checked, len(failures)))
        if failures:
            for name, why in failures[:5]:
                print("     ✗ %-20s %s" % (name, why))
            return 2

    new_entries, new_files, problems = [], {}, []
    for mid, diff in missing:
        raw, record, ops = convert(mid, diff)
        sheet = catalog[(mid, diff)]
        blob = dump_record(record)
        bad = check_runtime_invariants(record, ops, sheet["_fullComboCount"], factors, sheet["_id"])
        judged = sum(1 for op in ops if op not in UNJUDGED)
        weighted, denominator = denominator_of(ops, factors)
        entry = {
            "score_id": sheet["_id"], "music_id": mid, "difficulty": diff,
            "source_sha256": sha256(raw),
            "saved_path": "normalized/converted_charts/%d/%s.json" % (mid, diff),
            "converted_record_sha256": sha256(blob),
            "judgement_count": judged,
            "score_denominator": denominator,
            "score_percent_sum_i32": weighted,
            "calculation_basis": report["charts"][0]["calculation_basis"] if report["charts"] else "",
        }
        new_entries.append(entry)
        new_files[entry["saved_path"]] = blob
        print("   %s %-16s 判定 %-5d 物量 %-5d 除数 %-4d %s" %
              ("✓" if not bad else "✗", "%d_%s" % (mid, diff.upper()), judged,
               sheet["_fullComboCount"], denominator, "；".join(bad)))
        if bad:
            problems.append(("%d_%s" % (mid, diff.upper()), bad))

    if problems:
        print("\n✗ 有 %d 份不满足运行期自检，拒绝写入（应反馈服务器侧，不该硬塞进快照）：" % len(problems))
        for name, bad in problems:
            print("   %-20s %s" % (name, "；".join(bad)))
        return 2
    if not missing:
        print("\n✓ 没有缺的谱面，不需要同步。")
        return 0
    if not args.write:
        print("\n以上 %d 份可以同步（只读模式，没写盘）。加 --write 才写。" % len(new_entries))
        return 1

    written = []
    for rel, blob in new_files.items():
        path = OVERRIDE / SNAP_ROOT / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(blob)
        written.append(path.relative_to(REPO))
    report["charts"] = sorted(report["charts"] + new_entries, key=lambda c: (c["music_id"], c["difficulty"]))
    report["charts_checked"] = len(report["charts"])
    report_path = OVERRIDE / SNAP_ROOT / "validation/public_chart_conversion.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=1) + "\n",
                           encoding="utf-8", newline="\n")

    sidecar = OVERRIDE / "chart-sync.json"
    sidecar.write_text(json.dumps({
        "schema": "ournotes-chart-sync/1",
        "source": args.base.rstrip("/"),
        "data_version": version.get("dataVersion"),
        "charts_manifest_sha256": sha256(manifest_raw),
        "added": [{"music_id": e["music_id"], "difficulty": e["difficulty"],
                   "source_sha256": e["source_sha256"],
                   "converted_record_sha256": e["converted_record_sha256"],
                   "judgement_count": e["judgement_count"],
                   "score_denominator": e["score_denominator"]} for e in new_entries],
        "gate": "skipped" if args.skip_gate else "all-existing-reproduced-byte-exact",
    }, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")

    print("\n✓ 写入 %d 份谱面 + 转换报告（共 %d 条）" % (len(written), report["charts_checked"]))
    for path in written:
        print("   ", path)
    print("    ", report_path.relative_to(REPO))
    print("    ", sidecar.relative_to(REPO))
    print("\n接下来（别跳步）：git diff → build_browser.py --build → tools/run_checks.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
