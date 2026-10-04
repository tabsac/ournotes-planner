# -*- coding: utf-8 -*-
"""从账号包里抽出「成绩 / B25」数据。

单独成模块，**不动 profile 的数据契约**（profile 会被配队程序的 normalizeImport 校验，
往里塞字段风险大）。这里产出的东西只挂在网页的账号面板上，用来画 B25 卡片。

数据来源（都是账号包里就有的）：
  * ``_player._liveMusicResults[]``   ← **卡片选谁只用它**
        {_mLiveMusicId, _highScore, _highScoreOn<Diff>, _<diff>ClearedStatus,
         _received<Diff>{Quarter,Half,ThreeQuarter,Full}ComboReward, ...}
        —— 每首打过的歌一条，**只增不减**（打过的歌不会被别的歌顶掉）。
  * ``_player._topHighScoreRatings[]``   ← 只用来算 HIGH SCORE RATING
        {_musicType, _bandId, _mstLiveMusicId, _difficulty, _highScoreRating}
        —— 游戏自己的 High Score Rating 榜。**每个 (曲型, 乐队) 格子只登记一首**
        （实测 19 行 / 19 个格子 / 每格 1 首），同一格打了分更高的歌，旧的那首就被挤下去。
        所以这个榜是**可变**的：账号玩得越多，榜上的歌反而可能变少 —— 它**不能**用来选卡片。
  * ``MasterLiveMusic``       曲名 / 所属乐队 / 各难度谱面 ID
  * ``MasterLiveMusicScore``  谱面等级（``_musicScoreDisplayLevel``）与总物量（``_fullComboCount``）
  * ``MasterText``            曲名的本地化文本
"""

from __future__ import annotations

import json
import os

DIFFICULTIES = ("easy", "normal", "hard", "expert")
DIFFICULTY_LABELS = {"easy": "EASY", "normal": "NORMAL", "hard": "HARD", "expert": "EXPERT"}

# ---------------------------------------------------------------------------
# FC / AP 判定 —— 唯一需要改的地方
#
# 账号包里**没有** `isFullCombo` 这样的布尔字段，游戏的持久化模型里只有
# `_<diff>ClearedStatus` 这个整数。从 IL2CPP 元数据里挖出来的相关信息：
#
#   * 类型 `MusicPlayStatusFilterType`（曲目列表的筛选器），成员正好三个：
#         NotSsCleared / NotFullCombo / NotAllPerfect
#     —— 说明游戏眼里的「演奏状态」就是这四档：未完成 / 完成 / FC / AP。
#   * 属性 `EasyClearedStatus` / `NormalClearedStatus` / `HardClearedStatus` /
#     `ExpertClearedStatus`，方法 `UpdateHighScoreAndClearStatus`、
#     `GetClearedStatusByDifficulty`。
#   * ``_received<Diff>FullComboReward`` 是**领没领过 FC 奖励**，不是「有没有 FC」，
#     达到但没领也算 false，只能当旁证。
#
# 实测到的取值只有 0 / 10 / 20，而且那条 20 以外的样本里
# `_receivedExpertFullComboReward` 是 false（Quarter/Half/ThreeQuarter 都是 true），
# 与「20 = FC」不矛盾 —— 但这**不足以证明** 10 一档的刻度。
#
# 所以：下面这组档位是**推断值**，会在界面上原样标出「未验证」，
# 并把每首歌的原始 `ClearedStatus` 一起显示出来，方便一眼核对。
# 如果实际刻度不同，只改这三个数就行。
# ---------------------------------------------------------------------------
STATUS_CLEARED = 10      # 完成（未 FC）
STATUS_FC = 20           # FULL COMBO
STATUS_AP = 30           # ALL PERFECT

# ---------------------------------------------------------------------------
# B25 的两件事：**选谁**（从哪 25 首）和**值是多少**。
#
# 值 = **谱面等级**，不是游戏自己算的那个 rating。
# `_topHighScoreRatings[]._highScoreRating` 看着像 rating，其实就是**分数除以 1000**
# **向下取整**。证据（同一首歌，同一个账号包里同时记录）：
#     _liveMusicResults :  {_mLiveMusicId: 100002, _highScore: 934031}
#     _topHighScoreRatings: {_mstLiveMusicId: 100002, _highScoreRating: 934}
#     934031 / 1000 = 934.031 -> 934   ← 对得上
# 更硬的证据（2026-10-04 的账号包，19 条榜单一首首对）：
#     round(分数/1000) 与榜上值有 13 条不符，floor(分数/1000) **0 条不符** —— 是整除。
# 拿它当 B25 值等于拿分数当值，而谱面等级只有 1~2 位（本快照 5.0 ~ 29.0）。
#
# 选谁 = `_liveMusicResults`（游玩记录，只增不减）里**计入值最高的 25 首**。
#
#   原来的做法是从 `_topHighScoreRatings` 选，那是**错的**，实测踩到过：
#   那个榜每个 (曲型, 乐队) 格子只留一首（19 格 19 首），同一格打了分更高的歌，
#   旧的那首就被顶掉 —— 于是「越玩，卡片上的歌反而越少」，
#   同一个号昨天 46 首有记录，今天榜上只剩 19 首，截图对比明显少歌。
#   游玩记录不会这样：打过就有记录，只增不减。
#
#   * 每首歌取它**打过的难度里计入值最高的那个**（同值取原值/更难的）；
#   * 按计入值从高到低取前 25 首，展示顺序也是这个顺序，第 1 名就是最值钱的那首；
#   * **全程不看分数**：入榜和名次只由「AP 记原值、FC 及其它记原值 − 1」的难度值决定。
#     分数（`_highScoreRating` = 分数 ÷ 1000 向下取整）只用来算游戏那个
#     HIGH SCORE RATING 合计，和「哪 25 首进榜」无关。
# ---------------------------------------------------------------------------

# 参考图上的换算规则（用户给的）：AP 记原值，FC（及其它）记原值 - 1。
FC_PENALTY = 1


def _int(value, default=None):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _row_list(table):
    """主数据表既可能是 list，也可能是 {"_allData": [...]}。"""
    if isinstance(table, list):
        return table
    if isinstance(table, dict):
        for key in ("_allData", "rows", "data"):
            if isinstance(table.get(key), list):
                return table[key]
    return []


def _safe_rows(value):
    """只认「一行一个 dict」的列表。

    账号包偶尔会缺字段或类型不对（尤其是被人手工改过的包）。这个模块的契约是
    「坏数据返回 available=False，绝不抛异常」，所以取值前统一过一道：
    `_liveMusicResults` 是字符串 / 数字 / dict 时一律当成空的，别让 `.get` 炸掉整条导入链路。
    """
    if not isinstance(value, (list, tuple)):
        return []
    return [row for row in value if isinstance(row, dict)]


def _safe_dict(value):
    """同上：不是 dict 就当空的。"""
    return value if isinstance(value, dict) else {}


def _text_map(tables):
    out = {}
    for row in _row_list(tables.get("MasterText")):
        key = row.get("_id")
        if isinstance(key, str):
            # 有些语言列是空的，这时候宁可返回 None，让调用方退回「乐曲 <id>」，
            # 也不要把 "Music_Tilte_100004" 这种内部 ID 当成曲名显示出去。
            out[key] = row.get("_simplifiedChinese") or row.get("_english")
    return out


def _rows_for(data, name):
    """取一张主数据表的行。

    `planner_core.Data.tables` 只装了配队用得到的那几十张表
    （实测 44 张，**不含 MasterLiveMusicScore**），所以缺表时直接去快照的
    raw/ 目录读原文件。这里读的是展示用数据（曲名、谱面等级），不参与计算，
    所以不复用 deck_power 的 sha256 校验 —— 配队结果的完整性校验不受影响。
    """
    rows = _row_list((getattr(data, "tables", {}) or {}).get(name))
    if rows:
        return rows
    snapshot = getattr(data, "snapshot", None)
    if snapshot is None:
        return []
    path = os.path.join(str(snapshot), "raw", name + ".json")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return _row_list(json.load(handle))
    except (OSError, ValueError):
        return []


def _song_catalog(data):
    """返回 {乐曲ID: {name, band_id, jacket, levels, notes}}。"""
    texts = _text_map(getattr(data, "tables", {}) or {})
    scores = {}
    for row in _rows_for(data, "MasterLiveMusicScore"):
        sid = _int(row.get("_id"))
        if sid is not None:
            scores[sid] = row

    out = {}
    for row in _rows_for(data, "MasterLiveMusic"):
        mid = _int(row.get("_id"))
        if mid is None:
            continue
        levels, notes, bases = {}, {}, {}
        for diff in DIFFICULTIES:
            chart_id = _int(row.get("_%sID" % diff))
            chart = scores.get(chart_id) or {}
            # `_musicScoreDisplayLevel` = 游戏里显示的那个（可能是 25.7 这种，不一定是 .5 的倍数）；
            # `_musicScoreLevel` = 定数（整数）。两个都留着，卡片显示前者。
            level = chart.get("_musicScoreDisplayLevel")
            if level is None:
                level = chart.get("_musicScoreLevel")
            levels[diff] = level
            bases[diff] = _int(chart.get("_musicScoreLevel"))
            notes[diff] = _int(chart.get("_fullComboCount"))
        band_ids = row.get("_bandIDs") or []
        out[mid] = {
            "name": texts.get(row.get("_titleTextID")) or ("乐曲 %d" % mid),
            "band_id": _int(band_ids[0]) if band_ids else None,
            "jacket": "song-%d.webp" % mid,
            "levels": levels,
            "level_bases": bases,
            "notes": notes,
        }
    return out


def build_scores(player, data):
    """从 `_player` 抽出 B25 需要的一切。失败时返回 available=False，绝不抛异常。"""
    empty = {"available": False, "entries": [], "songs": {}, "stats": {},
             "scale": {"cleared": STATUS_CLEARED, "fc": STATUS_FC, "ap": STATUS_AP},
             "fc_penalty": FC_PENALTY, "verified": False, "notes": []}
    if not isinstance(player, dict):
        return empty

    tables = getattr(data, "tables", {}) or {}
    try:
        songs = _song_catalog(data)
    except Exception:
        songs = {}

    # ---- 每首歌的分数 / 状态 ----
    results = {}
    for row in _safe_rows(player.get("_liveMusicResults")):
        mid = _int(row.get("_mLiveMusicId"))
        if mid is None:
            continue
        per = {}
        for diff in DIFFICULTIES:
            capital = diff.capitalize()
            per[diff] = {
                "score": _int(row.get("_highScoreOn%s" % capital), 0) or 0,
                "status": _int(row.get("_%sClearedStatus" % diff), 0) or 0,
                "fc_reward": bool(row.get("_received%sFullComboReward" % capital)),
            }
        results[mid] = {"high_score": _int(row.get("_highScore"), 0) or 0, "per": per}

    # ---- 游戏自己的榜单：只用来算 HIGH SCORE RATING 和标记「在榜」 ----
    # 每个 (曲型, 乐队) 格子只留一首，会被后来的歌挤掉，**不**拿来选卡片（见文件头注释）。
    board_ids, total_rating = set(), 0
    for row in _safe_rows(player.get("_topHighScoreRatings")):
        mid = _int(row.get("_mstLiveMusicId"))
        if mid is None:
            continue
        board_ids.add(mid)
        total_rating += _int(row.get("_highScoreRating"), 0) or 0

    # ---- 卡片选谁：游玩记录（只增不减）里计入值最高的那些 ----
    entries_all, played, missing_level, disagreements = [], set(), [], 0
    for mid, info in results.items():
        per_all = info.get("per") or {}
        scores = {diff: ((per_all.get(diff) or {}).get("score") or 0) for diff in DIFFICULTIES}
        # 「有记录」= 账号包里给这首歌留下了最高分。全 0 的行（只见过谱面没打过）不算。
        if not info.get("high_score") and not any(scores.values()):
            continue
        played.add(mid)

        song = songs.get(mid) or {}
        levels = song.get("levels") or {}
        candidates = []
        for index, diff in enumerate(DIFFICULTIES):
            score = scores[diff]
            if not score:
                continue
            level = levels.get(diff)
            if not isinstance(level, (int, float)):
                continue
            per = per_all.get(diff) or {}
            status = per.get("status", 0) or 0
            fc_reward = bool(per.get("fc_reward"))

            ap = status >= STATUS_AP
            fc = ap or status >= STATUS_FC
            value = float(level)
            entry = {
                "music_id": mid,
                "name": song.get("name") or ("乐曲 %d" % mid),
                "jacket": song.get("jacket") or "placeholder.webp",
                "band_id": song.get("band_id"),
                "difficulty": diff,
                "difficulty_label": DIFFICULTY_LABELS[diff],
                "level": level,                       # 谱面等级（游戏里显示的那个）= B25 的值
                "level_base": (song.get("level_bases") or {}).get(diff),   # 定数
                "notes": (song.get("notes") or {}).get(diff),
                "value": value,                       # 原值（AP 值）
                "value_fc": max(0.0, value - FC_PENALTY),
                # 计入 Rating 的值：AP 算原值，FC 及其它减 FC_PENALTY
                "counted": value if ap else max(0.0, value - FC_PENALTY),
                # 游戏自己算的 rating = 该难度分数 ÷ 1000 **向下取整**（榜单 19 条实测：
                # round 有 13 条不符、floor 0 条不符）。只在界面上做参考，**不参与排名**。
                "score_rating": score // 1000,
                "high_score": score,
                "status": status,
                "fc_reward": fc_reward,
                "fc": fc,
                "ap": ap,
                # 这首歌现在还在不在游戏那个榜上（纯参考，卡片不靠它选）
                "in_board": mid in board_ids,
            }
            # 同一首歌打过多个难度：取计入值最高的；同值取原值（更难）高的。
            candidates.append(((entry["counted"], entry["value"]), entry))
        if not candidates:
            # 有游玩记录，但快照里查不到这首歌（或这个难度）的谱面等级 —— 排不了序
            missing_level.append(mid)
            continue
        best = max(candidates, key=lambda item: item[0])[1]
        # 旁证：领过 FC 奖励却没被判成 FC —— 记一笔，界面上提示可能刻度不对
        if best["fc_reward"] and not best["fc"]:
            disagreements += 1
        entries_all.append(best)

    # 排序 / 选人：**只看「计入值」**（AP 记原值，FC 及其它记原值 − FC_PENALTY），
    # **不看分数**。分数只影响游戏的 HIGH SCORE RATING（= 分数 ÷ 1000 那个榜），
    # 和「哪 25 首进榜」没有关系。
    # 关键：28 级 FC 的歌实际算 27，就该按 27 排在 28 级 AP 的歌**后面**。
    # 用原始等级排会让 28-FC 压在 28-AP 前面，是错的。
    # 这个顺序同时决定：展示顺序、取哪 25 首、平均值算谁。
    # 计入值相同时按原值（更难的那张谱面）高的在前，再按乐曲 ID 保证顺序稳定。
    entries_all.sort(key=lambda e: (-e["counted"], -e["value"], e["music_id"]))
    entries = entries_all[:25]

    if not entries:
        empty["notes"].append(
            "账号包里没有 `_liveMusicResults`（游玩记录）：这个号还没打过歌，或者刚重置过。"
            "先在游戏里打几首歌再重新取包。")
        return empty

    levels = [e["value"] for e in entries]
    counted = [e["counted"] for e in entries]
    # 全服总评级 = 游戏那个榜（`_topHighScoreRatings`）里每首 `_highScoreRating` 的和。
    # 注意：它**只对榜上那几首求和**（那个榜每格只留一首），和上面 25 首不是同一套来源，
    # 两个数字不必相等。档位（铜/银/金 + 星）由前端拿 static-data/b25-extra.json 里的
    # MasterLiveTotalHighScoreRating 门槛换算。
    stats = {
        "count": len(entries),
        # Rating = 25 首「计入值」的平均（AP 记原值，FC 及其它 −FC_PENALTY）
        "rating_avg": round(sum(counted) / len(counted), 2) if counted else None,
        # 顺便给个不做任何减法的纯等级平均，方便对照
        "level_avg": round(sum(levels) / len(levels), 2) if levels else None,
        "level_min": min(levels) if levels else None,
        "level_max": max(levels) if levels else None,
        "fc_count": sum(1 for e in entries if e["fc"]),
        "ap_count": sum(1 for e in entries if e["ap"]),
        "status_values": sorted({e["status"] for e in entries}),
        "missing_level": len(missing_level),
        # 账号里「有游玩记录」的歌数 —— 界面上的「共 N 首有记录」写这个（只会增不会减）
        "total_songs": len(played),
        # 游戏那个榜的条数（= 格子数）：和 total_songs 对比，一眼能看出榜在挤歌
        "board_count": len(board_ids),
        # 榜单里所有歌的评级之和 —— 游戏里显示的 HIGH SCORE RATING
        "total_rating": total_rating,
    }

    # 用户信息区块要用到的原始字段（头像用卡面，等级由前端查表换算）
    # 头像的取法按优先级退：收藏卡 → 最后一场演出的队长卡 → 账号里第一张成员卡。
    # 实测很多号的 `_favoriteMemberCardId` 是 0（从没设置过收藏），
    # 这时 `_lastLiveDeckLeaderMemberCardId` 通常是有值的，能顶上。
    avatar_id = _int(player.get("_favoriteMemberCardId"))
    avatar_from = "favorite"
    if not avatar_id:
        avatar_id = _int(player.get("_lastLiveDeckLeaderMemberCardId"))
        avatar_from = "lastLiveLeader"
    if not avatar_id:
        for row in _safe_rows(player.get("_memberCards")):
            avatar_id = _int(row.get("_masterId"))
            if avatar_id:
                avatar_from = "firstMemberCard"
                break

    player_info = {
        "name": player.get("_name"),
        "account_id": None if player.get("_accountid") is None else str(player.get("_accountid")),
        "exp": _int(player.get("_exp"), 0) or 0,
        "favorite_card_id": _int(player.get("_favoriteMemberCardId")),
        "avatar_card_id": avatar_id,
        "avatar_from": avatar_from if avatar_id else None,
        "player_rank_raw": _int(player.get("_playerRank")),
        # 看板（profile card）设置：10 个 slot，没设置过的话 _list 是空的
        "profile_cards_set": sum(
            1 for c in _safe_rows(player.get("_playerProfileCards"))
            if _safe_dict(c.get("_profileObjectsByIndex")).get("_list")),
    }

    # 注意：这些文字会**原样**显示在卡片的「关于 FC / AP 的可靠性」列表里（前端只做转义，
    # 不渲染 Markdown），所以别写 `**` 或反引号 —— 会连着符号一起显示出来。
    notes = []
    if missing_level:
        listed = "、".join("乐曲 %d" % mid for mid in sorted(missing_level)[:5])
        if len(missing_level) > 5:
            listed += " 等"
        notes.append(
            "有 %d 首有游玩记录、但数据快照里查不到谱面等级，没法参与排序（%s）。"
            % (len(missing_level), listed))
    if disagreements:
        notes.append(
            "有 %d 首歌「领过 FC 奖励」但 ClearedStatus 没到 FC 档 —— "
            "可能档位判断不对，请把下面的原始值发我核对。" % disagreements)
    notes.append(
        "选曲来源：账号包里的游玩记录（_liveMusicResults，打过就有、只增不减）里"
        "「计入值」最高的 %d 首；每首歌取它打过的难度里计入值最高的那个。"
        "卡片只列这 %d 首，账号里一共 %d 首有记录。"
        % (len(entries), len(entries), len(played)))
    notes.append(
        "排名只看「计入值」（AP 记原值、FC 及其它记原值 − 1），不看分数："
        "第 1 名是计入值最高的那首；计入值相同时按原值（更难的那张谱面）高的在前，"
        "再相同按乐曲 ID 排。")
    notes.append(
        "右上角的 HIGH SCORE RATING 是另一套来源：它是游戏自己那个榜"
        "（_topHighScoreRatings，本次 %d 首）的评级之和，就等于每首分数 ÷ 1000 向下取整。"
        "那个榜每个（曲型, 乐队）格子只留一首，新歌会把旧歌挤掉，"
        "所以它的首数比「有记录」少是正常的 —— 卡片不靠它选曲。"
        % len(board_ids))
    notes.append(
        "Rating = 这 %d 首谱面等级按「AP 记原值、FC 及其它减 1」之后的平均。"
        "FC / AP 是根据账号包里的 ClearedStatus 整数推断的（账号包没有直接的 FC/AP 布尔值）。"
        "打一首 FC 和一首 AP 后重新取包，看这张表里对应歌曲的「原始状态」变成多少，就能确认刻度。"
        % len(entries))

    return {
        "available": True,
        "entries": entries,
        "songs": songs,
        "stats": stats,
        "player": player_info,
        "scale": {"cleared": STATUS_CLEARED, "fc": STATUS_FC, "ap": STATUS_AP},
        "fc_penalty": FC_PENALTY,
        "verified": False,
        "notes": notes,
    }
