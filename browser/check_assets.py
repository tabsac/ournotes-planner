# -*- coding: utf-8 -*-
"""列出「数据快照里有、但本地图片缺」的缺口。

新歌 / 新卡上线后必然出现这种情况（数据能一键刷新，图是本地生成的），
跑一下这个脚本就知道要补哪些图。

用法：
    python check_assets.py                    # 只看缺口
    python check_assets.py --wanted           # 顺便打印每张缺图的 CDN 包名

补图：把包名丢给 on-share/fix_jackets.js（或 export_icons.js）导出 PNG，
再转成 webp 放进 static-images/<目录>/<prefix>-<id>.webp。
"""
import io
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "snapshot-override", "research", "2026-10-01", "raw")
IMAGES = os.path.join(HERE, "static-images")
INVENTORY = os.environ.get(
    "ON_BUNDLE_INVENTORY",
    r"C:\Users\13766\dsh-workspace\on-share\bundle_inventory.json")

# 表 -> (资源名前缀, 图片子目录, 存 asset 名的字段)
JOBS = [
    ("MasterLiveMusic", "song", "jacket", "_jacketAssetName"),
    ("MasterCharacter", "character", "character", "_imageAssetName"),
    ("MasterBandItem", "facility", "facility", "_iconAssetName"),
]


def rows(name):
    path = os.path.join(RAW, name + ".json")
    if not os.path.exists(path):
        return []
    with io.open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    return data["_allData"] if isinstance(data, dict) else data


def main():
    wanted = "--wanted" in sys.argv
    inventory = []
    if wanted and os.path.exists(INVENTORY):
        with io.open(INVENTORY, "r", encoding="utf-8") as handle:
            inventory = json.load(handle).get("names", [])

    total_missing = 0
    for table, prefix, folder, key in JOBS:
        data = rows(table)
        directory = os.path.join(IMAGES, folder)
        have = {f[:-5] for f in os.listdir(directory)} if os.path.isdir(directory) else set()
        missing = [r for r in data
                   if r.get("_id") is not None and "%s-%s" % (prefix, r["_id"]) not in have]
        total_missing += len(missing)
        flag = "OK " if not missing else "缺口"
        print("[%s] %-18s 数据 %3d 行 / 本地 %3d 张 / 缺 %d"
              % (flag, table, len(data), len(have), len(missing)))
        for row in missing:
            asset = row.get(key) or "?"
            line = "        id=%-8s asset=%s" % (row["_id"], asset)
            if wanted and inventory:
                hit = next((n for n in inventory if "_%s_" % asset in n), None)
                line += "\n            CDN: " + (hit or "未在包名清单里找到")
            print(line)

    print()
    print("合计缺口：%d 张" % total_missing)
    return 1 if total_missing else 0


if __name__ == "__main__":
    raise SystemExit(main())
