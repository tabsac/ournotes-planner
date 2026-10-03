# -*- coding: utf-8 -*-
"""生成 B25 页要用的两张小表 —— 评级档位 + 玩家等级。

为什么要单独生成一份：`planner_core.Data.tables` 是配队程序**精选过的 71 张表**，
`MasterLiveTotalHighScoreRating` / `MasterLiveBandHighScoreRating` / `MasterPlayerRank`
都不在里面。往快照里塞新表会动到配队程序的完整性校验，所以这里把要用的十几行
抽成一个独立的小 JSON 随网页发布，不去碰快照。

数据来源（都是 master 包里的表，.bin 解密后是 {"_allData": [...]}）：

  MasterLiveTotalHighScoreRating   18 行，全服总评级的档位
      _rating  = 门槛值        _grade = 0 铜 / 1 银 / 2 金      _step = 0~5 星
      实测：银牌最低 105500、金牌最低 211000

  MasterLiveBandHighScoreRating    18 行，每个乐队各自的档位（多一个 _bandId）
      同结构，门槛更低（银 21100 / 金 42200）

  MasterPlayerRank                 500 行，玩家等级
      _rank = 等级 1~500        _exp = 升到该级所需经验

用法：
    python make_b25_extra.py <含 Master*.bin 的目录> [输出路径]
例：
    python make_b25_extra.py C:\\...\\_on_master_all
"""
import gzip
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))) + r"\masterdata")
sys.stdout.reconfigure(encoding="utf-8")

from rijndael import Rijndael  # noqa: E402

KEY = bytes.fromhex("0532791c510a08eb7ede6b46c6ba71ea9aa2a3cfb678a595f89d67c8a5e493b6")
A1 = bytes.fromhex("b50b23a5fd628c3dc386f7488f81d6b0450b8c89671574f55a3ad815f10b8e30")

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = os.path.join(HERE, "static-data", "b25-extra.json")

# _grade -> 牌子。0=铜 1=银 2=金（实测门槛 105500 / 211000，与用户口径一致）
MEDALS = {0: "bronze", 1: "silver", 2: "gold"}


def decrypt_bin(path):
    with io.open(path, "rb") as handle:
        blob = handle.read()
    if blob[:32] != A1:
        raise ValueError("不是 master .bin（A1 头不匹配）：" + path)
    plain = Rijndael(KEY, 256).decrypt_cbc(blob[64:], blob[32:64])
    pad = plain[-1]
    if 1 <= pad <= 32 and plain[-pad:] == bytes([pad]) * pad:
        plain = plain[:-pad]
    try:
        plain = gzip.decompress(plain)
    except Exception:
        pass
    return json.loads(plain.decode("utf-8"))


def rows_of(directory, name):
    return decrypt_bin(os.path.join(directory, name + ".bin"))["_allData"]


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    source = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUT

    total = rows_of(source, "MasterLiveTotalHighScoreRating")
    band = rows_of(source, "MasterLiveBandHighScoreRating")
    rank = rows_of(source, "MasterPlayerRank")

    # [门槛, grade, step]，按门槛升序
    total_tiers = sorted([[r["_rating"], r["_grade"], r["_step"]] for r in total])
    band_tiers = {}
    for r in band:
        band_tiers.setdefault(str(r.get("_bandId", 0)), []).append(
            [r["_rating"], r["_grade"], r["_step"]])
    for key in band_tiers:
        band_tiers[key].sort()

    payload = {
        "source": {
            "tables": ["MasterLiveTotalHighScoreRating", "MasterLiveBandHighScoreRating",
                       "MasterPlayerRank"],
            "note": "由 browser/make_b25_extra.py 从 master 包生成；改数据后重跑一次",
            "medal_grades": MEDALS,
        },
        # [rating, grade, step]
        "total_rating_tiers": total_tiers,
        "band_rating_tiers": band_tiers,
        # [rank, exp]
        "player_rank": sorted([[r["_rank"], r["_exp"]] for r in rank]),
    }

    os.makedirs(os.path.dirname(out), exist_ok=True)
    with io.open(out, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
        handle.write("\n")

    print("总评级档位 %d 条：%s" % (len(total_tiers),
          "  ".join("%d=%s★%d" % (t[0], MEDALS.get(t[1], t[1]), t[2]) for t in total_tiers)))
    print("乐队档位 %d 个乐队、玩家等级 %d 级" % (len(band_tiers), len(payload["player_rank"])))
    print("写出：%s（%d 字节）" % (out, os.path.getsize(out)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
