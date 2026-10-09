# -*- coding: utf-8 -*-
"""`tools/sync_snapshot_from_data.py`（构建期把 /data 同步进内置快照）的回归测试。

**不联网**：全用合成载荷 + 只读真实快照，所以能进全量验收（`tools/run_checks.py`）。
真联网那一段（对着线上站点/替身后端跑）在 README 里手工做，见设计笔记 2p。

判据（每一条都对着一个具体的坑）：
  1. `format_level` 与 `build_browser.format_level` 逐值一致 —— 两边口径一飘，摘要就对不上；
  2. 内置快照视图 == **构建产物里的** `snapshot-digest.json`（有 dist 时才比）—— 证明工具看到的
     和网页真正在用的是同一份数据；
  3. `diff_views`：一致 / 改一处显示等级 / 新增 / 缺失 四种情况各给出正确结论（文案要能一眼看懂）；
  4. `write_table` 写出**逐字节相同**的文件 —— 格式一飘，`git diff` 会整篇变红，没法审；
  5. `verify_integrity`：清单与字节不符时必须判 False（不跟坏数据同步）。
"""
import hashlib
import importlib.util
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "browser"))

spec = importlib.util.spec_from_file_location("sync_snapshot_from_data",
                                              ROOT / "tools/sync_snapshot_from_data.py")
sync = importlib.util.module_from_spec(spec)
sys.modules["sync_snapshot_from_data"] = sync
spec.loader.exec_module(sync)

import build_browser  # noqa: E402

problems = []
total = 0


def check(name, ok, detail=""):
    global total
    total += 1
    print(("   [OK]   " if ok else "   [!!]   ") + name + (("  -> " + str(detail)) if detail else ""))
    if not ok:
        problems.append(name)


print("[1] format_level 与构建期口径一致（判据是两边摘要相等）")
for value in (9, 9.0, 13.5, 25, 26.0, 29.7, None, "", 0, 12.25):
    mine = sync.format_level(value)
    theirs = build_browser.format_level(value)
    if mine != theirs:
        check("format_level(%r)" % (value,), False, "%r vs %r" % (mine, theirs))
        break
else:
    check("10 个取值两边完全一致", True)

print("[2] 内置快照视图")
raw_dir, index = sync.snapshot_raw_dir()
bundled, bundled_event = sync.bundled_view(raw_dir)
check("曲目数与快照标识", len(bundled) == len(sync.load_table(raw_dir, "MasterLiveMusic")[1]), "%d 首 / %s" % (len(bundled), raw_dir.parent.name))
check("每首都有 4 个难度且带显示等级", all(
    len(song["charts"]) == 4 and all(c.get("display") is not None for c in song["charts"].values())
    for song in bundled.values()))
check("活动窗口读到了", bool(bundled_event.get("startAt") and bundled_event.get("endAt")), bundled_event)

digest_path = ROOT / "browser/dist/static-data/snapshot-digest.json"
if digest_path.is_file():
    digest = json.loads(digest_path.read_text("utf-8"))
    same = 0
    for song_id, text in digest.get("songsById", {}).items():
        mine = bundled.get(song_id)
        mine_text = "|".join(
            "%s/%s" % (sync.format_level((mine["charts"][d] or {}).get("display")),
                       "" if (mine["charts"][d] or {}).get("combo") is None
                       else int(mine["charts"][d]["combo"]))
            for d in sync.DIFFICULTIES) if mine else None
        if mine_text == text:
            same += 1
    check("与构建产物 snapshot-digest.json 逐首一致", same == len(digest.get("songsById", {})),
          "%d / %d" % (same, len(digest.get("songsById", {}))))
else:
    print("   [--]   没有构建产物，跳过这一条（先跑 browser/build_browser.py --build）")

print("[3] diff_views 四种情况")
remote = {song_id: {"title": "曲 %s" % song_id,
                    "charts": {d: dict(c) for d, c in song["charts"].items()}}
          for song_id, song in bundled.items()}
report = sync.diff_views(bundled, remote, bundled_event, dict(bundled_event))
check("完全一致 → identical", report["identical"] is True and not report["changed"])

first_id = sorted(remote)[0]
remote[first_id]["charts"]["expert"] = dict(remote[first_id]["charts"]["expert"], display=99)
report = sync.diff_views(bundled, remote, bundled_event, dict(bundled_event))
ok = (not report["identical"] and len(report["changed"]) == 1
      and "EXPERT 显示等级" in report["changed"][0]["diffs"][0] and "→ 99" in report["changed"][0]["diffs"][0])
check("改一处显示等级 → 精确报出那一处", ok, report["changed"][0]["diffs"] if report["changed"] else None)

remote[first_id]["charts"]["expert"] = dict(bundled[first_id]["charts"]["expert"])
remote["999999"] = {"title": "新曲", "charts": dict(remote[first_id]["charts"])}
report = sync.diff_views(bundled, remote, bundled_event, dict(bundled_event))
check("多一首 → added", [item["id"] for item in report["added"]] == ["999999"])
check("added 会让 identical 变 False", report["identical"] is False)

del remote["999999"]
del remote[first_id]
report = sync.diff_views(bundled, remote, bundled_event, dict(bundled_event))
check("少一首 → removed", [item["id"] for item in report["removed"]] == [first_id])

moved = dict(bundled_event, startAt="2030/01/01 00:00:00")
report = sync.diff_views(bundled, {k: {"title": "", "charts": {d: dict(c) for d, c in v["charts"].items()}}
                                   for k, v in bundled.items()}, moved, bundled_event)
check("活动窗口变了 → event", bool(report["event"]) and report["identical"] is False)

print("[4] write_table 逐字节复现现有格式")
for table in ("MasterLiveMusicScore", "MasterLiveMusic", "MasterEvent"):
    path = raw_dir / (table + ".json")
    original = path.read_bytes()
    wrapper, rows = sync.load_table(raw_dir, table)
    sync.write_table(raw_dir, table, wrapper, rows)
    again = path.read_bytes()
    check(table + " 写回后逐字节相同", original == again,
          "%d → %d 字节" % (len(original), len(again)))
    if original != again:                      # 别把仓库改坏
        path.write_bytes(original)

print("[5] verify_integrity：清单与字节不符必须判 False")
payload = b'{"songs": []}'
good = {"songs.json": {"sha256": sync.sha256_hex(payload)}}
bad = {"songs.json": {"sha256": "0" * 64}}
check("相符 → ok", all(item["ok"] for item in sync.verify_integrity(good, (("songs.json", payload),))))
check("不符 → 不 ok", not all(item["ok"] for item in sync.verify_integrity(bad, (("songs.json", payload),))))
check("取不到的文件（None）跳过", sync.verify_integrity(bad, (("events.json", None),)) == [])
check("清单里没写 sha256 → 放行（无法校验≠不符）",
      all(item["ok"] for item in sync.verify_integrity({}, (("songs.json", payload),))))

print("[6] apply_changes 端到端（在 work/ 下的**副本**里写，绝不碰真快照）")
import shutil  # noqa: E402

# 沙箱要照**真实目录形状**摆：<沙箱>/research/<日期>/raw/ —— 因为 update_manifest() 会写到
# raw 的同级（source_manifest.json）。平铺的副本会让它写进 work/ 根，测试就测不到那条了。
sandbox_root = ROOT / "work/snapshot-sync-test"
if sandbox_root.exists():
    shutil.rmtree(sandbox_root)
sandbox = sandbox_root / Path(raw_dir).relative_to(Path(raw_dir).parents[2])   # .../research/<日期>/raw
sandbox.parent.mkdir(parents=True, exist_ok=True)
shutil.copytree(raw_dir, sandbox)
before = {p.name: p.read_bytes() for p in sandbox.glob("*.json")}
scores_before = {row["_id"]: row for row in sync.load_table(raw_dir, "MasterLiveMusicScore")[1]}
music_before = {row["_id"]: row for row in sync.load_table(raw_dir, "MasterLiveMusic")[1]}

target_id = sorted(bundled)[0]
remote_songs = {song_id: {"title": "曲 %s" % song_id,
                          "charts": {d: dict(c) for d, c in song["charts"].items()}}
                for song_id, song in bundled.items()}
remote_songs[target_id]["charts"]["expert"] = dict(
    remote_songs[target_id]["charts"]["expert"], display=99, combo=1234)
moved_event = dict(bundled_event, startAt="2030/01/01 00:00:00", endAt="2030/01/08 23:59:59")
report = sync.diff_views(bundled, remote_songs, bundled_event, moved_event)
touched, event_rows = sync.apply_changes(sandbox, remote_songs, report)
check("计数 = 真变的字段数（显示等级 + 物量 = 2）", touched == 2, touched)
check("活动行写到了", event_rows == 1, event_rows)

scores_after = {row["_id"]: row for row in sync.load_table(sandbox, "MasterLiveMusicScore")[1]}
music = music_before[int(target_id)]
patched = scores_after[music["_expertID"]]
check("显示等级写成了 99", patched["_musicScoreDisplayLevel"] == 99.0, patched["_musicScoreDisplayLevel"])
check("物量写成了 1234", patched["_fullComboCount"] == 1234, patched["_fullComboCount"])
check("定数没被动（线上没给新定数时不该瞎改）",
      patched["_musicScoreLevel"] == scores_before[music["_expertID"]]["_musicScoreLevel"],
      patched["_musicScoreLevel"])
others = [d for d in ("easy", "normal", "hard")]
check("同一首的其它难度一个字节都没改", all(
    scores_after[music[sync.MUSIC_ID_FIELD[d]]] == scores_before[music[sync.MUSIC_ID_FIELD[d]]] for d in others))
target_score_ids = {music[sync.MUSIC_ID_FIELD[d]] for d in sync.DIFFICULTIES}
check("别的歌也没被改",
      all(scores_after[key] == value for key, value in scores_before.items()
          if key not in target_score_ids))

event_after = [r for r in sync.load_table(sandbox, "MasterEvent")[1] if r["_id"]==bundled_event["id"]]
check("活动窗口写成了新时间", event_after[0]["_startAt"] == "2030/01/01 00:00:00"
      and event_after[0]["_endAt"] == "2030/01/08 23:59:59", event_after[0])
check("没碰过的表逐字节不变", all(
    (sandbox / name).read_bytes() == raw
    for name, raw in before.items()
    if name not in ("MasterLiveMusicScore.json", "MasterEvent.json")))
check("真快照没被这次测试改动（副本里写，原目录不动）", all(
    (raw_dir / name).read_bytes() == raw for name, raw in before.items()))

# ⚠️ 改 raw 母表必须同步更新 source_manifest.json 的 sha256，否则运行期
#    `manual_score_reference._checked_inputs()` 会拒绝加载整个快照（Source checksum mismatch）。
print("[7] 清单同步：改了 raw 表就要把新 sha256 写回 source_manifest.json")
manifest_path = sandbox.parent / "source_manifest.json"
check("沙箱里生成了 source_manifest.json", manifest_path.is_file(), manifest_path)
if manifest_path.is_file():
    manifest = json.loads(manifest_path.read_text("utf-8"))
    entries = {e["local_path"]: e for e in manifest["files"]}
    for table in ("raw/MasterLiveMusicScore.json", "raw/MasterEvent.json"):
        want = hashlib.sha256((sandbox / Path(table).name).read_bytes()).hexdigest()
        check("%s 的 sha256 已更新为改后的字节" % table,
              entries.get(table, {}).get("sha256") == want, (entries.get(table) or {}).get("sha256", "缺失")[:16])
    with zipfile.ZipFile(sync.UPSTREAM_ZIP) as archive:
        original = json.loads(archive.read(sync.UPSTREAM_PREFIX + sync.SNAPSHOT_REL + "source_manifest.json").decode("utf-8"))
    original_digest = {e["local_path"]: e["sha256"] for e in original["files"]}["raw/MasterLiveMusicScore.json"]
    check("确实与上游清单里的旧值不同（不是没改）",
          entries["raw/MasterLiveMusicScore.json"]["sha256"] != original_digest,
          "%s → %s" % (original_digest[:12], entries["raw/MasterLiveMusicScore.json"]["sha256"][:12]))
    check("browser_override 的说明提到了 sha256 已同步",
          "sha256" in (manifest.get("browser_override") or {}).get("note", ""))
shutil.rmtree(sandbox_root, ignore_errors=True)

print()
if problems:
    print("有 %d 项不通过：" % len(problems))
    for name in problems:
        print("  -", name)
    raise SystemExit(1)
print("check_snapshot_sync: 全部通过（%d 项）" % total)
