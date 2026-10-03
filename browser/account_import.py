"""把账号包里的 `_player` 映射成配队程序要的卡库（profile）。

字段对应关系（依据 research/card_power.py，不是猜的）：

    成员卡 profile.inventory.members[]   {id, level, training_count, awakening_count,
                                          live_skill_level, gekisou_skill_level}
        游戏 _memberCards[]._masterId            -> id
        游戏 _memberCards[]._exp                 -> level   （查 MasterMemberCardLevel._group = 卡的 _memberCardLevelGroup）
        游戏 _memberCards[]._awakeCount - 1      -> training_count   （card_power: MasterMemberCardAwake._awakeCount = training+1）
        游戏 _memberCards[]._rank - 1            -> awakening_count  （card_power: MasterMemberCardRank._rank = awakening+1）
        游戏 _memberCards[]._liveSkillLevel      -> live_skill_level        （1..5）
        游戏 _memberCards[]._performanceSkillLevel -> gekisou_skill_level   （1..5，本版配队程序不参与计算）
        ^ live_skill_level 只在「手动 AP」模式下才被要求（app.js missingGrowth），
          但账号包里一直有，所以一律填上，免得用户还要手填 5 张卡。

    留影卡 profile.inventory.snaps[]     {id, level, limit_break_count}
        游戏 _supportCards[]._masterId       -> id
        游戏 _supportCards[]._exp            -> level   （MasterSupportCardLevel._group = 卡的 _supportCardLevelGroup）
        游戏 _supportCards[]._rank - 1       -> limit_break_count（MasterSupportCardRank._rank = limit_break+1）

    角色 profile.character_ranks[]       {character_id, rank}
        ^ 字段名是 **rank**，不是 level！
          依据：app.js 的 rankValue() 读 `?.rank`；_planner_core.py 读
          `ranks.get(cid, {}).get("rank")`。写成 level 会让角色等级全部显示「未填写」。
        游戏 _characters[]._masterId         -> character_id
        游戏 _characters[]._exp              -> rank   （MasterCharacterRank，全局表，取 _exp 不超过的最大 _rank）

    profile.character_total_rank          = 25 个角色等级之和
        （MasterCharacterTotalRank 首行 _totalRank = 25，正好是 25 角色 × 1 级，与 deck_power 的用法一致）

    profile.facilities[]                  {id, level}   游戏 _bandItems[]
        ^ level 同时表达三种状态（配队程序侧已按此打补丁，见 build_browser.py）：
            0        = 未解锁（游戏不给任何加成）
            1..cap   = 实际等级
            缺这一条 = 未填写（仍然会报「未填写」，要求用户处理）
          游戏 _bandItems 只记录已升级的道具，所以这里对全部 MasterBandItem 都输出一条，
          没有记录的写 0。只输出有记录的那几条会让未解锁的号永远过不了校验。
    profile.tgw_card_rank                 T.G.W CARD（付费会员）等级 1..21，未订阅时为 1
"""

MAX_TRAINING = 4
MAX_AWAKENING = 4
MAX_LIMIT_BREAK = 4


def level_from_exp(tables, table, exp, group_key=None, group=None, level_key="_level"):
    """按经验取等级：在该组里找 _exp <= exp 的最大 _level。"""
    rows = tables.get(table) or []
    best = None
    for row in rows:
        if group_key is not None and row.get(group_key) != group:
            continue
        if row.get("_exp", 0) > exp:
            continue
        if best is None or row.get(level_key, 0) > best.get(level_key, 0):
            best = row
    return None if best is None else best.get(level_key)


def _int(value, default=None):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def build_profile(player, data):
    """把 `_player` 转成 profile。返回 (profile, report)。"""
    index = data.index
    tables = data.tables
    report = {"warnings": [], "skipped_members": [], "skipped_snaps": [], "skipped_characters": []}

    # ---- 成员卡 ----
    members = []
    for row in player.get("_memberCards") or []:
        cid = _int(row.get("_masterId"))
        card = index.get("MasterMemberCard", {}).get(cid)
        if card is None:
            report["skipped_members"].append(cid)
            continue
        level = level_from_exp(tables, "MasterMemberCardLevel", _int(row.get("_exp"), 0),
                               "_group", card.get("_memberCardLevelGroup"))
        if level is None:
            report["skipped_members"].append(cid)
            continue
        training = (_int(row.get("_awakeCount"), 1) or 1) - 1
        awakening = (_int(row.get("_rank"), 1) or 1) - 1

        def _skill(key):
            v = _int(row.get(key))
            return None if v is None else max(1, min(5, v))

        members.append({
            "id": cid, "level": level,
            "training_count": max(0, min(MAX_TRAINING, training)),
            "awakening_count": max(0, min(MAX_AWAKENING, awakening)),
            # 账号包里一直有这两个技能等级，填上可以省掉用户手填 5 张卡
            "live_skill_level": _skill("_liveSkillLevel"),
            "gekisou_skill_level": _skill("_performanceSkillLevel"),
        })

    # ---- 留影卡（Snap）----
    snaps = []
    for row in player.get("_supportCards") or []:
        cid = _int(row.get("_masterId"))
        card = index.get("MasterSupportCard", {}).get(cid)
        if card is None:
            report["skipped_snaps"].append(cid)
            continue
        level = level_from_exp(tables, "MasterSupportCardLevel", _int(row.get("_exp"), 0),
                               "_group", card.get("_supportCardLevelGroup"))
        if level is None:
            report["skipped_snaps"].append(cid)
            continue
        limit_break = (_int(row.get("_rank"), 1) or 1) - 1
        snaps.append({
            "id": cid, "level": level,
            "limit_break_count": max(0, min(MAX_LIMIT_BREAK, limit_break)),
        })

    # ---- 角色等级 ----
    character_ranks = []
    for row in player.get("_characters") or []:
        cid = _int(row.get("_masterId"))
        if cid not in index.get("MasterCharacter", {}):
            report["skipped_characters"].append(cid)
            continue
        level = level_from_exp(tables, "MasterCharacterRank", _int(row.get("_exp"), 0), level_key="_rank")
        if level is None:
            report["skipped_characters"].append(cid)
            continue
        character_ranks.append({"character_id": cid, "rank": level})

    total_rank = sum(r["rank"] for r in character_ranks)

    # ---- 乐队道具 ----
    # 关键：游戏里 _bandItems 只记录「已经升级过」的道具，没记录的 = 未解锁。
    # 而未解锁和等级 0 是同一个意思（游戏不给未解锁的道具任何加成），
    # 所以这里把全部道具都写出来：有记录的用实际等级，没有的写 0。
    # 写成「只输出有记录的」会让未解锁的号永远卡在「道具等级 未填写」上。
    owned_facilities = {}
    for row in player.get("_bandItems") or []:
        fid = _int(row.get("_masterId", row.get("_id")))
        level = _int(row.get("_level"))
        if fid is None or level is None:
            continue
        owned_facilities[fid] = level

    facilities = []
    for item in tables.get("MasterBandItem") or []:
        fid = _int(item.get("_id"))
        if fid is None:
            continue
        facilities.append({"id": fid, "level": owned_facilities.get(fid, 0)})
    if not facilities:                       # 主数据表缺失时退回旧行为
        facilities = [{"id": k, "level": v} for k, v in sorted(owned_facilities.items())]

    # ---- T.G.W CARD（付费会员）等级 ----
    tgw = 1
    for key in ("_vipRank", "_vip_rank", "_tgwCardRank"):
        if _int(player.get(key)) is not None:
            tgw = _int(player.get(key))
            break
    else:
        passes = (player.get("_monthlyPass") or {}).get("_passes") or []
        if passes:
            report["warnings"].append("账号有付费会员记录，但 T.G.W CARD 等级未在本地数据里，暂按 1 级处理，请在「角色与道具」里手动确认。")

    profile = {
        "schema_version": 1,
        "inventory": {"members": sorted(members, key=lambda r: r["id"]),
                      "snaps": sorted(snaps, key=lambda r: r["id"])},
        "facilities": facilities,
        "character_ranks": sorted(character_ranks, key=lambda r: r["character_id"]),
        "character_total_rank": max(1, total_rank),
        "tgw_card_rank": max(1, min(21, tgw)),
    }

    report.update({
        "member_count": len(members),
        "snap_count": len(snaps),
        "character_count": len(character_ranks),
        "character_total_rank": profile["character_total_rank"],
        "facility_count": len(facilities),
        "facility_unlocked_count": sum(1 for f in facilities if f["level"] > 0),
        "player_name": player.get("_name"),
        "account_id": player.get("_accountid"),
        # `_accountid` 是 int64（例如 7445432298994985508），超过 JS 的安全整数范围，
        # 直接走 JSON 到前端会被四舍五入成 7445432298994986000。界面上显示这个文本版。
        "account_id_text": None if player.get("_accountid") is None else str(player.get("_accountid")),
    })
    if facilities and report["facility_unlocked_count"] == 0:
        report["warnings"].append(
            "账号包里没有任何已升级的乐队道具：%d 项全部按「未解锁 = 不加成」处理。"
            "如果游戏里实际有等级，请先在手机上打开一次游戏再重新取包。" % len(facilities))
    elif facilities:
        report["warnings"].append(
            "乐队道具：%d 项已解锁、%d 项未解锁（未解锁按 0 加成处理）。"
            % (report["facility_unlocked_count"], len(facilities) - report["facility_unlocked_count"]))
    if report["skipped_members"]:
        report["warnings"].append(
            "有 %d 张成员卡不在当前数据快照里（可能是比快照新的卡），已跳过：%s"
            % (len(report["skipped_members"]), report["skipped_members"][:12]))
    if report["skipped_snaps"]:
        report["warnings"].append(
            "有 %d 张留影卡不在当前数据快照里，已跳过：%s"
            % (len(report["skipped_snaps"]), report["skipped_snaps"][:12]))
    return profile, report
