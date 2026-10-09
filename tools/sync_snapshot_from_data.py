#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把服务器 `/data/*.json` 的游戏数据**同步进内置快照**（方案 A：构建期同步）。

## 它解决什么问题

网页的配队求解读的是**随网页发布的内置快照**（`browser/snapshot-override/` 覆盖到上游 zip 上，
由 `browser/upstream.json` 的 sha256 钉住）。这份快照是冻结的：游戏哪天**改了谱面等级/物量、
开了新活动**，网页仍然拿旧数据算 —— 而现在「发现数据变了」这件事服务器侧已经在做
（`/data/version.json` 的 `contentDigests`），只差「把它搬进构建」这一步。

**刻意不做运行期消费**：求解的输入必须是确定的，否则「同一份输入」会随数据版本漂移，
验收 oracle（每次由 `browser/tests/make_fixtures.py` 从当前快照现算）也就没意义了。
所以同步发生在**构建前**，运行期照旧读内置快照：离线可用、结果可复现、oracle 与线上严格一致。

## 能同步什么、不能同步什么（重要）

| 面 | 能不能 | 说明 |
|---|---|---|
| 已有曲目的**显示等级 / 定数 / 物量** | ✅ | 写 `MasterLiveMusicScore` 的 `_musicScoreDisplayLevel` / `_musicScoreLevel` / `_fullComboCount` |
| 当前**活动窗口** | ✅ | 写 `MasterEvent` 的 `_startAt` / `_endAt`（同 id 才写） |
| **新增曲目** | ❌ | 一首新歌光有等级不够：还要谱面文件（`_musicScoreTextFileName` 指向的 note 数据）
才能算分，而 `/data/songs.json` 里没有。**这时请用 `python browser/update_snapshot.py --apply`**
（从游戏 CDN 拉全量表 + 谱面），本工具会拒绝写入并提示 |
| 加成角色 / 技能 / 卡池等其它 master 表 | ❌ | `/data/*` 里没有，同上走 `update_snapshot.py` |
| `cards.json` | ❌ | 网页不用它（数据状态卡片里如实写着「未使用」） |

## 用法

```bash
python tools/sync_snapshot_from_data.py                      # 只报告差异（默认，不写盘）
python tools/sync_snapshot_from_data.py --base http://127.0.0.1:8907   # 对着替身后端练手
python tools/sync_snapshot_from_data.py --write              # 真的写进 snapshot-override/
python tools/sync_snapshot_from_data.py --write --ignore-unsupported   # 新增/缺曲目也照写（会列出来）
```

退出码：`0` 一致 或 写入成功；`1` 有差异（只读模式）；`2` 遇到它做不了的改动（新增/缺曲目）而拒绝写。

写完之后的闭环（**别跳步**）：

```bash
git diff browser/snapshot-override/                          # 先看一眼改了什么
python -B browser/build_browser.py --build                   # 重建（会重算 snapshot-digest.json）
python -B tools/run_checks.py                                # 验收：oracle 由当前快照现算，会跟着一起变
python -B tools/publish_site.py                              # 镜像站；交付包另走 work/package_delivery.py
```

`index.json` 里的 `tables` 哈希**故意不动**：那是游戏 CDN 声明的表哈希，`update_snapshot.py`
靠它判断「哪张表变了、要不要重下」。本工具的改动记在旁边的 `snapshot-override/data-sync.json` 里。
"""
import argparse
import hashlib
import json
import sys
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0,str(ROOT / "browser"))
OVERRIDE = ROOT / "browser" / "snapshot-override"
INDEX = OVERRIDE / "index.json"
SYNC_RECORD = OVERRIDE / "data-sync.json"
DEFAULT_BASE = "https://on.tabsac.com"
DIFFICULTIES = ("easy", "normal", "hard", "expert")
REMOTE_CHART_NAME = {"easy": "EASY", "normal": "NORMAL", "hard": "HARD", "expert": "EXPERT"}
MUSIC_ID_FIELD = {"easy": "_easyID", "normal": "_normalID", "hard": "_hardID", "expert": "_expertID"}

# 快照根（research/<日期>/）与上游 zip 的前缀 —— 改 raw 母表时要回头去更新 manifest
SNAPSHOT_REL = json.loads(INDEX.read_text("utf-8"))["snapshot_prefix"].rsplit("raw/", 1)[0]
_UPSTREAM = json.loads((ROOT / "browser/upstream.json").read_text("utf-8"))
UPSTREAM_ZIP = ROOT / "browser" / "upstream" / _UPSTREAM["archive"]
UPSTREAM_PREFIX = "OurNotes-配队程序-v%s/" % _UPSTREAM["version"]

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:                                     # 老 Python / 非 TTY
    pass


# ------------------------------------------------------------------ 读

def fetch(base, path, timeout):
    """取一份 JSON 的**原始字节**（要按字节校验 fileDigests，不能先 parse 再 dump）。"""
    url = base.rstrip("/") + path
    request = urllib.request.Request(url)
    request.add_header("Cache-Control", "no-cache")
    request.add_header("User-Agent", "ournotes-snapshot-sync/1")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return url, response.read()


def sha256_hex(raw):
    return hashlib.sha256(raw).hexdigest()


def format_level(value):
    """与 `build_browser.format_level()` / 前端 `formatLevel()` 完全一致（判据是两边摘要相等）。"""
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return ""
    text = ("%.2f" % float(value)).rstrip("0").rstrip(".")
    return text


def verify_integrity(digests, items):
    """按字节校验：不跟「半写/坏掉」的数据同步（与前端 `remote-data.js` 同一套判据）。

    `items` 是 `(文件名, 原始字节 or None)`；清单里没写 sha256 的文件按「无法校验」放行。
    单独抽成函数是为了能被 `browser/tests/check_snapshot_sync.py` 直接测。
    """
    results = []
    for name, raw in items:
        if raw is None:
            continue
        want = (digests.get(name) or {}).get("sha256")
        got = sha256_hex(raw)
        results.append({"file": name, "expected": want, "actual": got, "ok": (want is None or want == got)})
    return results


def snapshot_raw_dir():
    index = json.loads(INDEX.read_text("utf-8"))
    return OVERRIDE / index["snapshot_prefix"], index


def load_table(raw_dir, name):
    """读一张 master 表，返回 `(包装对象, 行列表)` —— 包装对象要留着原样写回去。"""
    path = raw_dir / (name + ".json")
    if not path.is_file():
        raise SystemExit("快照里缺少 %s（%s）" % (name, path))
    wrapper = json.loads(path.read_text("utf-8"))
    if isinstance(wrapper, dict):
        for key in ("_allData", "rows", "data"):
            if isinstance(wrapper.get(key), list):
                return wrapper, wrapper[key]
        return wrapper, []
    return None, wrapper if isinstance(wrapper, list) else []


def bundled_view(raw_dir):
    """内置快照里的「曲目 → 各难度（显示等级, 定数, 物量）」与活动窗口。"""
    _, music_rows = load_table(raw_dir, "MasterLiveMusic")
    _, score_rows = load_table(raw_dir, "MasterLiveMusicScore")
    scores = {row.get("_id"): row for row in score_rows}
    songs = {}
    for row in music_rows:
        music_id = row.get("_id")
        if not isinstance(music_id, int):
            continue
        charts = {}
        for diff in DIFFICULTIES:
            score = scores.get(row.get(MUSIC_ID_FIELD[diff])) or {}
            charts[diff] = {
                "display": score.get("_musicScoreDisplayLevel", score.get("_musicScoreLevel")),
                "level": score.get("_musicScoreLevel"),
                "combo": score.get("_fullComboCount"),
            }
        songs[str(music_id)] = {"charts": charts}
    event = {}
    _, event_rows = load_table(raw_dir, "MasterEvent")
    if event_rows:
        from snapshot_release import current_event
        row = current_event(event_rows)
        event = {"id": row.get("_id"), "startAt": str(row.get("_startAt") or ""),
                 "endAt": str(row.get("_endAt") or "")}
    return songs, event


def remote_view(songs_payload):
    """服务器 `/data/songs.json` 侧的同一套视图。"""
    songs = songs_payload.get("songs") if isinstance(songs_payload, dict) else songs_payload
    view = {}
    for song in songs or []:
        charts = {}
        for chart in song.get("charts") or []:
            name = str(chart.get("name") or "").upper()
            diff = next((d for d, n in REMOTE_CHART_NAME.items() if n == name), None)
            if diff is None:
                continue
            charts[diff] = {"display": chart.get("display", chart.get("level")),
                            "level": chart.get("level"), "combo": chart.get("combo")}
        view[str(song.get("id"))] = {"title": song.get("title") or "", "charts": charts}
    return view


# ------------------------------------------------------------------ 比

def diff_views(bundled, remote, bundled_event, remote_event):
    """逐首 × 逐难度比。判据与前端 `remote-data.js` 的 `diffSongs()` 一致。"""
    changed, added, removed = [], [], []
    counts = {"display": 0, "level": 0, "combo": 0}
    for song_id, remote_song in remote.items():
        mine = bundled.get(song_id)
        if mine is None:
            added.append({"id": song_id, "title": remote_song.get("title", "")})
            continue
        diffs = []
        for diff in DIFFICULTIES:
            before = mine["charts"].get(diff) or {}
            after = remote_song["charts"].get(diff) or {}
            for field, label in (("display", "显示等级"), ("level", "定数"), ("combo", "物量")):
                old, new = before.get(field), after.get(field)
                if field == "display":
                    same = format_level(old) == format_level(new)
                else:
                    same = old == new
                if same or (old is None and new is None):
                    continue
                counts[field] += 1
                if field == "combo":
                    diffs.append("%s 物量 %s → %s" % (REMOTE_CHART_NAME[diff], old if old is not None else "-",
                                                     int(new) if isinstance(new, (int, float)) else "-"))
                else:
                    diffs.append("%s %s %s → %s" % (REMOTE_CHART_NAME[diff], label,
                                                    format_level(old) or "-", format_level(new) or "-"))
        if diffs:
            changed.append({"id": song_id, "title": remote_song.get("title", ""), "diffs": diffs})
    for song_id in bundled:
        if song_id not in remote:
            removed.append({"id": song_id})

    event_changed = None
    if remote_event and bundled_event:
        if str(bundled_event.get("startAt") or "") != str(remote_event.get("startAt") or "") or \
           str(bundled_event.get("endAt") or "") != str(remote_event.get("endAt") or ""):
            event_changed = {"before": bundled_event, "after": remote_event}
    elif remote_event and not bundled_event:
        event_changed = {"before": {}, "after": remote_event}

    return {"changed": changed, "added": added, "removed": removed,
            "counts": counts, "event": event_changed,
            "identical": not changed and not added and not removed and not event_changed}


# ------------------------------------------------------------------ 写

def write_table(raw_dir, name, wrapper, rows):
    """按快照里既有的格式写回。

    实测：`json.dumps(..., ensure_ascii=False, indent=1)` 的字节与现有文件**完全相同**
    —— 且**结尾没有换行**（多加一个 `\\n` 就会让每个文件差 1 字节，`git diff` 上看着像整篇改了）。
    `browser/tests/check_snapshot_sync.py` 第 4 组就是盯着这一条的。
    """
    payload = dict(wrapper) if isinstance(wrapper, dict) else rows
    if isinstance(payload, dict):
        for key in ("_allData", "rows", "data"):
            if isinstance(payload.get(key), list):
                payload[key] = rows
                break
    target=raw_dir / (name + '.json')
    if target.exists() and json.loads(target.read_text('utf-8'))==payload:return
    text = json.dumps(payload, ensure_ascii=False, indent=1)
    (raw_dir / (name + ".json")).write_text(text, encoding="utf-8", newline="\n")


def apply_changes(raw_dir, remote_songs, report):
    """把等级/定数/物量写进 MasterLiveMusicScore，活动窗口写进 MasterEvent。"""
    _, music_rows = load_table(raw_dir, "MasterLiveMusic")
    score_wrapper, score_rows = load_table(raw_dir, "MasterLiveMusicScore")
    music_by_id = {row.get("_id"): row for row in music_rows}
    scores_by_id = {row.get("_id"): row for row in score_rows}
    touched = 0
    for item in report["changed"]:
        music = music_by_id.get(int(item["id"]))
        if music is None:
            continue
        for diff in DIFFICULTIES:
            after = (remote_songs.get(item["id"]) or {}).get("charts", {}).get(diff) or {}
            score = scores_by_id.get(music.get(MUSIC_ID_FIELD[diff]))
            if score is None:
                continue
            # 只数**真的变了**的字段：整首歌的 4 个难度都会被写一遍（值相同的写回去等于没改），
            # 报「改了 4 处」会让人以为动得比实际多。
            if after.get("display") is not None:
                new_display = float(after["display"])
                if format_level(score.get("_musicScoreDisplayLevel")) != format_level(new_display):
                    touched += 1
                score["_musicScoreDisplayLevel"] = new_display
            if after.get("level") is not None:
                new_level = int(after["level"]) if float(after["level"]).is_integer() else after["level"]
                if score.get("_musicScoreLevel") != new_level:
                    touched += 1
                score["_musicScoreLevel"] = new_level
            if after.get("combo") is not None:
                new_combo = int(after["combo"])
                if score.get("_fullComboCount") != new_combo:
                    touched += 1
                score["_fullComboCount"] = new_combo
    if touched:
        write_table(raw_dir, "MasterLiveMusicScore", score_wrapper, score_rows)

    event_rows = []; changed_events=0
    if report["event"]:
        event_wrapper, event_rows = load_table(raw_dir, "MasterEvent")
        after = report["event"]["after"]
        for row in event_rows:
            if str(row.get("_id")) == str(after.get("id")) or len(event_rows) == 1:
                changed_events += 1
                row["_startAt"] = after.get("startAt")
                row["_endAt"] = after.get("endAt")
        write_table(raw_dir, "MasterEvent", event_wrapper, event_rows)
    # ⚠️ 改了 raw 母表就必须同步更新 source_manifest.json 里记的 sha256 —— 运行期
    # `manual_score_reference._checked_inputs()` 会逐张比对（不符直接拒绝加载整个快照：
    # "Source checksum mismatch: raw/<表>.json"）。上游的 `update_snapshot.py` 就是这么做的
    # （见 manifest 的 `browser_override` 说明），这里照同一条规矩。
    patched = []
    if touched:
        patched.append("MasterLiveMusicScore")
    if report["event"]:
        patched.append("MasterEvent")
    if patched:
        update_manifest(raw_dir, patched)
    return touched, changed_events


def update_manifest(raw_dir, table_names):
    """把被改过的 raw 表的新 sha256 写回 `source_manifest.json`（否则运行期会拒绝加载）。"""
    manifest_rel = raw_dir.parent / "source_manifest.json"
    if manifest_rel.is_file():
        manifest = json.loads(manifest_rel.read_text("utf-8"))
    else:                                   # 覆盖层里还没有：从上游 zip 取一份当底
        archive = zipfile.ZipFile(UPSTREAM_ZIP)
        manifest = json.loads(archive.read(UPSTREAM_PREFIX + SNAPSHOT_REL + "source_manifest.json").decode("utf-8"))
    updated = []
    for name in table_names:
        path = raw_dir / (name + ".json")
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        for entry in manifest["files"]:
            if entry.get("local_path") == "raw/%s.json" % name:
                if entry.get("sha256") != digest:
                    entry["sha256"] = digest
                    entry["bytes"] = path.stat().st_size
                    updated.append(entry["local_path"])
                break
    override = manifest.get("browser_override") or {}
    override["note"] = ("raw 表由 update_snapshot.py / sync_snapshot_from_data.py 刷新，sha256 已同步更新"
                        "（运行期 _checked_inputs() 会逐张核对这些 sha256）")
    override["tables"] = len([e for e in manifest["files"]
                              if str(e.get("local_path", "")).startswith("raw/")
                              and (OVERRIDE / SNAPSHOT_REL / e["local_path"]).is_file()])
    manifest["browser_override"] = override
    manifest_rel.parent.mkdir(parents=True, exist_ok=True)
    manifest_rel.write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n",
                            encoding="utf-8", newline="\n")
    return updated


def write_record(base, version, report, touched):
    """把「这次同步从哪来、改了什么」记在快照旁边（人可读、可审）。"""
    payload = {
        "schema": "ournotes-snapshot-sync/1",
        "synced_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "source": base.rstrip("/"),
        "data_version": version.get("dataVersion"),
        "updated_at": version.get("updatedAt"),
        "contentDigests": version.get("contentDigests"),
        "fileDigests": version.get("fileDigests"),
        "content_version": json.loads(INDEX.read_text("utf-8")).get("content_version"),
        "changed_songs": len(report["changed"]),
        "changed_fields": report["counts"],
        "touched_score_rows": touched,
        "event": report["event"],
        "skipped": {"added": report["added"], "removed": report["removed"]},
    }
    SYNC_RECORD.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n",
                           encoding="utf-8", newline="\n")
    return SYNC_RECORD


# ------------------------------------------------------------------ 主流程

def main():
    parser = argparse.ArgumentParser(description="把 /data/*.json 的游戏数据同步进内置快照（构建期）")
    parser.add_argument("--base", default=DEFAULT_BASE, help="站点基址（默认 %s）" % DEFAULT_BASE)
    parser.add_argument("--write", action="store_true", help="真的写进 snapshot-override/（默认只报告）")
    parser.add_argument("--ignore-unsupported", action="store_true",
                        help="有新增/缺失曲目时也照写（会列出来；新增曲目的谱面数据仍要自己补）")
    parser.add_argument("--json", action="store_true", help="输出机器可读的 JSON")
    parser.add_argument("--timeout", type=int, default=60)
    args = parser.parse_args()

    raw_dir, index = snapshot_raw_dir()
    bundled, bundled_event = bundled_view(raw_dir)

    urls = {}
    urls["version"], version_raw = fetch(args.base, "/data/version.json", args.timeout)
    version = json.loads(version_raw.decode("utf-8"))
    urls["songs"], songs_raw = fetch(args.base, "/data/songs.json", args.timeout)
    songs_payload = json.loads(songs_raw.decode("utf-8"))
    try:
        urls["events"], events_raw = fetch(args.base, "/data/events.json", args.timeout)
        events_payload = json.loads(events_raw.decode("utf-8"))
    except Exception as error:                                  # 活动取不到不算致命
        events_raw, events_payload = None, None
        print("· /data/events.json 取不到（%s），这次不比活动" % error, file=sys.stderr)

    # ① 先按字节校验：不跟「半写/坏掉」的数据同步（与前端 remote-data.js 同一套判据）
    integrity = verify_integrity(version.get("fileDigests") or {},
                                 (("songs.json", songs_raw), ("events.json", events_raw)))
    if any(item["ok"] is False for item in integrity):
        for item in integrity:
            if item["ok"] is False:
                print("✗ 字节校验不通过：%s\n   清单 %s\n   实际 %s" % (item["file"], item["expected"], item["actual"]),
                      file=sys.stderr)
        raise SystemExit("服务器数据与清单不符 —— 这次不同步（等下一次重建后再来）")

    remote = remote_view(songs_payload)
    remote_event = {}
    if events_payload:
        events = events_payload.get("events") or []
        current = next((e for e in events if str(e.get("id")) == str(events_payload.get("currentEventId"))), None)
        current = current or (events[0] if events else None)
        if current:
            remote_event = {"id": current.get("id"), "startAt": current.get("startAt"), "endAt": current.get("endAt")}

    report = diff_views(bundled, remote, bundled_event, remote_event)

    if args.json:
        print(json.dumps({"base": args.base, "dataVersion": version.get("dataVersion"),
                          "bundled_songs": len(bundled), "remote_songs": len(remote),
                          "integrity": integrity, "report": report}, ensure_ascii=False, indent=2))
    else:
        print("源：%s" % urls["version"].rsplit("/data/", 1)[0])
        print("线上数据版本 dataVersion=%s（更新于 %s）" % (version.get("dataVersion"), version.get("updatedAt")))
        print("字节校验：" + "，".join("%s %s" % (i["file"], "通过 ✓" if i["ok"] else "失败 ✗") for i in integrity))
        print("曲目：内置 %d 首 / 线上 %d 首" % (len(bundled), len(remote)))
        if report["identical"]:
            print("\n✓ 完全一致：内置快照就是线上这份数据，不需要同步。")
        else:
            print("\n差异（显示等级 %d / 定数 %d / 物量 %d 处）："
                  % (report["counts"]["display"], report["counts"]["level"], report["counts"]["combo"]))
            for item in report["changed"][:40]:
                print("  · %s（%s）：%s" % (item["title"] or "?", item["id"], "；".join(item["diffs"])))
            if len(report["changed"]) > 40:
                print("  · …还有 %d 首" % (len(report["changed"]) - 40))
            for item in report["added"]:
                print("  + 线上新增：%s（%s）—— 谱面数据要另拉，见下" % (item["title"] or "?", item["id"]))
            for item in report["removed"]:
                print("  - 内置有、线上没有：%s" % item["id"])
            if report["event"]:
                print("  · 活动窗口：%s ~ %s → %s ~ %s"
                      % (report["event"]["before"].get("startAt"), report["event"]["before"].get("endAt"),
                         report["event"]["after"].get("startAt"), report["event"]["after"].get("endAt")))

    unsupported = bool(report["added"] or report["removed"])
    if unsupported and not args.ignore_unsupported:
        print("\n✗ 有本工具做不了的改动（新增/缺失曲目）：新增一首歌还要它的**谱面文件**才能算分，"
              "而 /data/songs.json 里没有。请改用：\n    python browser/update_snapshot.py --apply   "
              "（从游戏 CDN 拉全量表 + 谱面）\n"
              "确认要只同步能同步的部分，就加 --ignore-unsupported。", file=sys.stderr)
        return 2

    if report["identical"] or not args.write:
        return 0 if report["identical"] else 1

    touched, event_rows = apply_changes(raw_dir, remote, report)
    record = write_record(args.base, version, report, touched)
    print("\n✓ 已写入内置快照：%d 处谱面字段（%d 行），活动 %d 行" % (touched, touched, event_rows))
    print("  记录：%s" % record.relative_to(ROOT))
    print("  注意 index.json 的 tables 哈希**故意没动**（那是 CDN 的表哈希，update_snapshot.py 靠它判断要不要重下）。")
    print("\n接下来（别跳步）：")
    print("  git diff browser/snapshot-override/            # 先看改了什么")
    print("  python -B browser/build_browser.py --build     # 重建（重算 snapshot-digest.json）")
    print("  python -B tools/run_checks.py                  # 验收：oracle 会按新快照现算")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
