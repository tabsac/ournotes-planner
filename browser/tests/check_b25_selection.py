# -*- coding: utf-8 -*-
"""B25 选曲来源的回归测试：卡片必须来自「只增不减」的游玩记录。

踩过的 bug：账号包里的 `_topHighScoreRatings` 是游戏自己的 High Score Rating 榜，
**每个 (曲型, 乐队) 格子只登记一首** —— 同一格子里打了分更高的歌，旧的那首就被挤掉。
于是「越玩，卡片上的歌反而越少」：实测一个号有 46 首游玩记录，榜上只剩 19 首，
同一天前后的两张截图一比，玩家会看到歌凭空消失（而游玩记录只可能变多）。

现在卡片改成从 `_liveMusicResults` 里选 25 首。这个测试把规则钉住：
**哪怕榜单被挤到只剩 1 首（甚至一首不剩），卡片照样是满的 25 首。**

    python -B browser/tests/check_b25_selection.py work/validation
"""
from pathlib import Path
import json
import sys
import types

DEST = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path("work/validation").resolve()
DEST.mkdir(parents=True, exist_ok=True)
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "browser"))                          # browser/account_scores.py

import account_scores                       # noqa: E402

DIFFS = account_scores.DIFFICULTIES
problems = []


def check(ok, label, detail=None):
    print("   %s %s%s" % ("[OK]  " if ok else "[FAIL]", label,
                          "" if detail is None else "  -> " + str(detail)))
    if not ok:
        problems.append(label)


# 用**应用真正加载的那份快照**（`browser/snapshot-override`，随站点一起打包），
# 不是 `load_baseline()` 解出来的公开基线：两者曲目数不一样（这里 87 首 / 基线 85 首，
# 应用快照多了 100107 与 100112），拿基线当数据源会让"哪些歌有谱面等级"的结论失真。
RAW = ROOT / "browser/snapshot-override/research/2026-10-01/raw"
NEEDED = ("MasterLiveMusic", "MasterLiveMusicScore", "MasterText", "MasterBand")
data = types.SimpleNamespace(
    tables={name: json.loads((RAW / (name + ".json")).read_text("utf-8")) for name in NEEDED},
    index={}, snapshot=RAW.parent)
catalog = account_scores._song_catalog(data)

# ---- 素材：挑几首快照里有谱面等级的歌 ----
usable = []
for mid in sorted(catalog):
    levels = {d: catalog[mid]["levels"].get(d) for d in DIFFS}
    if all(isinstance(v, (int, float)) for v in levels.values()):
        usable.append(mid)
if len(usable) < 32:
    raise SystemExit("快照里可用曲目太少（%d 首），没法造样本" % len(usable))
print("曲目目录 %d 首，可用的 %d 首" % (len(catalog), len(usable)))
check(100107 in catalog, "应用快照里带着 100107（离线基线里没有，别用错数据源）")
check(len(catalog) >= 87, "目录条数 = snapshot-override 的曲目数", len(catalog))

# 按 expert 等级挑：最高等级的歌**不放进榜单**，用来验证「不在榜也要上卡片」
by_expert = sorted(usable, key=lambda m: (-catalog[m]["levels"]["expert"], m))
top_song, low_song = by_expert[0], by_expert[-1]
others = [m for m in usable if m not in (top_song, low_song)][:32]
records_ids = [low_song, top_song] + others           # 34 首，低等级那首才在榜上

# 状态循环：4/5 是 FC 或 AP，1/5 只有「完成」—— 后者按规则**不计入**
STATUS_CYCLE = (20, 30, 20, 30, 10)


def record(mid, index, diff="expert"):
    """一条游玩记录：只写一个难度。"""
    status = STATUS_CYCLE[index % len(STATUS_CYCLE)]
    score = 900000 + index * 1379
    return {
        "_mLiveMusicId": mid,
        "_highScore": score,
        "_highScoreOn%s" % diff.capitalize(): score,
        "_%sClearedStatus" % diff: status,
        "_received%sFullComboReward" % diff.capitalize(): status >= 20,
    }


def board_row(mid, rating, difficulty=3):
    return {"_musicType": 1, "_bandId": 1, "_mstLiveMusicId": mid,
            "_difficulty": difficulty, "_highScoreRating": rating}


print("\n[1] 榜单被挤到只剩 1 首，卡片仍要是满的 25 首")
player = {
    "_name": "回归君",
    "_accountid": 1234,
    "_liveMusicResults": [record(mid, i) for i, mid in enumerate(records_ids)],
    # 只留一条（现实里是 19 个格子各一条），而且压在**等级最低**的那首上
    "_topHighScoreRatings": [board_row(low_song, 777)],
}
out = account_scores.build_scores(player, data)
stats = out["stats"]
check(out["available"] is True, "成绩可用")
check(len(out["entries"]) == 25, "取到 25 张卡（不是榜单的 1 张）", len(out["entries"]))
check(stats["count"] == 25, "stats.count = 25", stats["count"])
check(stats["total_songs"] == 34, "stats.total_songs = 34（有记录的歌数）", stats["total_songs"])
check(stats["fc_ap_songs"] == 28, "其中 28 首有 FC/AP（能进卡片）", stats["fc_ap_songs"])
check(stats["cleared_only_songs"] == 6, "6 首只完成过，不计入", stats["cleared_only_songs"])
check(stats["board_count"] == 1, "stats.board_count = 1（榜单条数）", stats["board_count"])
check(stats["total_rating"] == 777, "HIGH SCORE RATING = 榜单之和", stats["total_rating"])

print("\n[2] 被榜单挤掉的歌照样在卡片上")
ids = [e["music_id"] for e in out["entries"]]
check(len(set(ids)) == 25, "25 张卡是 25 首不同的歌")
check(all(mid in records_ids for mid in ids), "每张卡都对应一首有记录的歌")
check(top_song in ids, "快照里 expert 等级最高的那首在卡片上（它不在榜单里）",
      "乐曲 %d" % top_song)
check(out["entries"][0]["music_id"] == top_song, "它就是第 1 名（计入值最高）",
      "乐曲 %d" % out["entries"][0]["music_id"])
check(any(e["in_board"] is False for e in out["entries"]), "卡片里有「不在榜」的歌",
      sum(1 for e in out["entries"] if not e["in_board"]))
check(all(e["in_board"] == (e["music_id"] in {low_song}) for e in out["entries"]),
      "in_board 只标给榜单里那一首")

print("\n[3] 值和排序")
counted = [e["counted"] for e in out["entries"]]
check(all(counted[i - 1] >= counted[i] for i in range(1, len(counted))),
      "按计入值从高到低", " >= ".join("%g" % c for c in counted[:6]))
ok_value = all(
    isinstance(e["level"], (int, float))
    and abs(e["value"] - float(e["level"])) < 1e-9
    and abs(e["counted"] - (e["value"] if e["ap"] else e["value"] - account_scores.FC_PENALTY)) < 1e-9
    for e in out["entries"])
check(ok_value, "值 = 谱面等级；AP 记原值、FC 记原值 − 1")
check(all(e["status"] >= account_scores.STATUS_FC for e in out["entries"]),
      "卡片上不可能出现「完成」档（status 全部 ≥ FC）",
      sorted({e["status"] for e in out["entries"]}))
check(all(e["fc"] is True for e in out["entries"]), "每张卡都至少是 FC")
check(all(5 <= e["value"] <= 29 for e in out["entries"]),
      "值在谱面等级量纲上（5~29），不是分数派生的 rating",
      "%g ~ %g" % (stats["level_min"], stats["level_max"]))
check(all(e["score_rating"] == e["high_score"] // 1000 for e in out["entries"]),
      "score_rating = 分数 ÷ 1000 向下取整（仅参考）")
expect_order = sorted(out["entries"], key=lambda e: (-e["counted"], -e["value"], e["music_id"]))
check([e["music_id"] for e in expect_order] == ids,
      "顺序 = 计入值 ↓ → 原值 ↓ → 乐曲 ID ↑（规则里没有分数）")
check(all(e["name"] for e in out["entries"]), "每张卡都有曲名")

print("\n[4] 「有记录」的门槛：全 0 的行不算")
zero_song = by_expert[len(by_expert) // 2]
player2 = json.loads(json.dumps(player))
player2["_liveMusicResults"].append({"_mLiveMusicId": zero_song, "_highScore": 0,
                                     "_highScoreOnExpert": 0, "_expertClearedStatus": 0})
out2 = account_scores.build_scores(player2, data)
check(out2["stats"]["total_songs"] == 34, "没打过（全 0）的歌不算「有记录」",
      out2["stats"]["total_songs"])
check(all(e["music_id"] != zero_song for e in out2["entries"]) or zero_song in records_ids,
      "没打过的歌不会凭空变成一张卡")

print("\n[4b] 「完成」不计入：无论什么难度")
only_cleared = {
    "_name": "只完成君",
    "_liveMusicResults": [
        # 等级最高的那张谱面也只是「完成」—— 规则上不计入
        {"_mLiveMusicId": by_expert[0], "_highScore": 990000, "_highScoreOnExpert": 990000,
         "_expertClearedStatus": 10},
    ],
    "_topHighScoreRatings": [],
}
got_cleared = account_scores.build_scores(only_cleared, data)
check(got_cleared["entries"] == [], "只完成过的歌不进卡片", len(got_cleared["entries"]))
check(got_cleared["available"] is False, "没有可计入的歌 → available=False（走空状态引导）")
check(any("FC" in n for n in got_cleared["notes"]), "空状态的提示说明「完成不计入」",
      got_cleared["notes"][0] if got_cleared["notes"] else "(无)")

mixed = {
    "_name": "混合君",
    "_liveMusicResults": [{
        "_mLiveMusicId": by_expert[0],
        "_highScore": 990000,
        "_highScoreOnExpert": 990000, "_expertClearedStatus": 10,      # 高等级但只完成 → 不计入
        "_highScoreOnHard": 800000, "_hardClearedStatus": 30,          # 低等级 AP → 计入
    }],
    "_topHighScoreRatings": [],
}
got_mixed = account_scores.build_scores(mixed, data)["entries"]
check(len(got_mixed) == 1, "这首有一张 AP，所以还能进卡片", len(got_mixed))
if got_mixed:
    e = got_mixed[0]
    check(e["difficulty"] == "hard" and e["ap"] is True,
          "完成的那张 expert 被忽略，取 hard AP", "%s ap=%s" % (e["difficulty"], e["ap"]))
    check(abs(e["counted"] - float(catalog[by_expert[0]]["levels"]["hard"])) < 1e-9,
          "计入值 = hard 的谱面等级", e["counted"])

print("\n[5] 排名只看难度计入值，不看分数")
# 同一等级的兩首歌：id 大的那个分数更高。规则说排名不看分数，
# 那就必须按乐曲 ID 排（id 小的在前）；如果实现里掺了分数，这条会挂。
by_level = {}
for mid in usable:
    by_level.setdefault(catalog[mid]["levels"]["expert"], []).append(mid)
pair = next((ids for ids in by_level.values() if len(ids) >= 2), None)
if pair is None:
    print("   [SKIP] 快照里没有同级的两首歌，跳过并列检查")
else:
    small, big = sorted(pair)[0], sorted(pair)[-1]
    tie_player = {
        "_name": "并列君",
        "_liveMusicResults": [
            # id 小的分数**低**，id 大的分数**高** —— 按分数排会把它俩顺序调过来
            {"_mLiveMusicId": small, "_highScore": 900000, "_highScoreOnExpert": 900000,
             "_expertClearedStatus": 30},
            {"_mLiveMusicId": big, "_highScore": 2000000, "_highScoreOnExpert": 2000000,
             "_expertClearedStatus": 30},
        ],
        "_topHighScoreRatings": [board_row(big, 2000)],
    }
    tie_entries = account_scores.build_scores(tie_player, data)["entries"]
    check([e["music_id"] for e in tie_entries] == [small, big],
          "计入值相同时按乐曲 ID 排，分数高的不往前插",
          "%s(分低) 在 %s(分高) 前面" % (small, big))
    check({e["counted"] for e in tie_entries} == {float(catalog[small]["levels"]["expert"])},
          "两首计入值确实相同", sorted(e["counted"] for e in tie_entries))

print("\n[6] 同一首歌的多个难度：取计入值最高的（同值取更难的）")
real_catalog = account_scores._song_catalog
try:
    # 真实快照里没有「两个难度等级正好差 1」的歌，造一张合成谱面来测这条规则：
    # hard 26 打 AP = 26，expert 27 打 FC = 27 - 1 = 26 —— 计入值并列。
    account_scores._song_catalog = lambda data: {100001: {
        "name": "合成曲", "jacket": "song-100001.webp", "band_id": 1,
        "levels": {"easy": 8.0, "normal": 15.0, "hard": 26.0, "expert": 27.0},
        "level_bases": {"hard": 26, "expert": 27}, "notes": {"hard": 700, "expert": 900}}}
    twin = {
        "_name": "同一首",
        "_liveMusicResults": [{
            "_mLiveMusicId": 100001,
            "_highScore": 900000,
            # expert 的分数**低**、hard 的分数**高**：一条按分数选的实现会选 hard
            "_highScoreOnExpert": 500000, "_expertClearedStatus": 20,     # FC → 27 - 1 = 26
            "_highScoreOnHard": 900000, "_hardClearedStatus": 30,         # AP → 26
        }],
        "_topHighScoreRatings": [],
    }
    got = account_scores.build_scores(twin, data)["entries"]
    check(len(got) == 1, "一首歌一张卡", len(got))
    if got:
        e = got[0]
        check(e["difficulty"] == "expert", "计入值并列时取原值更高的那张谱面",
              "%s（原值 %s）" % (e["difficulty"], e["value"]))
        check(e["fc"] is True and e["ap"] is False and abs(e["counted"] - 26.0) < 1e-9,
              "expert 27 打 FC → 计入 26（和 hard 26 AP 并列）",
              "counted=%s fc=%s ap=%s" % (e["counted"], e["fc"], e["ap"]))
        check(e["score_rating"] == 500, "分数只作为参考字段留在卡片上", e["score_rating"])
finally:
    account_scores._song_catalog = real_catalog

print("\n[7] 没有榜单也行（新号 / 榜单被清空）")
no_board = dict(player)
no_board.pop("_topHighScoreRatings")
out3 = account_scores.build_scores(no_board, data)
check(out3["available"] is True and len(out3["entries"]) == 25,
      "没有 `_topHighScoreRatings` 也能出 25 张卡", len(out3["entries"]))
check(out3["stats"]["total_rating"] == 0, "这时 HIGH SCORE RATING = 0",
      out3["stats"]["total_rating"])

print("\n[8] 顺序稳定 + 坏数据不抛异常")
again = [e["music_id"] for e in account_scores.build_scores(player, data)["entries"]]
check(again == ids, "同样的输入两次跑出同样的顺序")
for bad in ({}, None, [], {"_liveMusicResults": [{"_mLiveMusicId": 999999, "_highScore": 5}]},
            {"_liveMusicResults": "坏了", "_topHighScoreRatings": "也坏了"}):
    try:
        r = account_scores.build_scores(bad, data)
        check(r["available"] in (True, False), "坏数据按 available=%s 返回，没抛异常" % r["available"])
    except Exception as exc:                                    # noqa: BLE001
        check(False, "坏数据不该抛异常", "%s: %s" % (type(exc).__name__, exc))

report = {
    "passed": not problems,
    "problems": problems,
    "catalog_songs": len(catalog),
    "cards_from_play_records": len(out["entries"]),
    "play_records": stats["total_songs"],
    "board_entries": stats["board_count"],
    "ranking_rule": "counted value (AP=level, FC=level-1) desc, then level desc, then music_id; score is not used",
    "note": "卡片选曲来自 _liveMusicResults（只增不减），不再受 _topHighScoreRatings 挤歌影响",
}
(DEST / "b25-selection-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), "utf-8")
print("\n%s" % ("全部通过" if not problems else "%d 项未通过：%s" % (len(problems), problems)))
sys.exit(1 if problems else 0)
