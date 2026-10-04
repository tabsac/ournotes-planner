"""分析 watch.js 记下来的进度轨迹（watch-<fixture>.jsonl），验「已等待 N 秒」有没有在求解期间继续走。

第 14 轮修的问题：进度里的秒数只取后端发来的 elapsed_seconds，而**求解阶段后端一次进度事件都不发**，
于是手机首轮求解（1~2 分钟）里那个计数器是冻住的。修法是本地再走一只秒表、与后端值取较大者。

判据（桌面**验不出来**：用例只有 5 秒、每个阶段活不到 1 秒，窗口根本不存在）：
  同一段进度标题（stage）里，「已等待 N 秒」必须出现过**多个不同的秒数**且**单调不减**。

  python elapsed_trace.py watch-solver-ap.jsonl [更多 jsonl ...]
"""
from pathlib import Path
import json
import re
import sys

SECONDS = re.compile(r"已等待\s*(\d+)\s*秒")


def analyze(path):
    rows = []
    for line in Path(path).read_text("utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        ts, label = json.loads(line)
        title, _, count = label.partition(" || ")
        match = SECONDS.search(count)
        rows.append({"ts": ts, "title": title.strip(), "count": count.strip(),
                     "seconds": int(match.group(1)) if match else None})
    if not rows:
        print(f"{path}: 轨迹是空的")
        return False

    # 按标题切成连续段（同一个阶段可能被别的阶段打断，所以看「连续段」而不是全局分组）
    segments, current = [], None
    for row in rows:
        if current is None or row["title"] != current["title"]:
            current = {"title": row["title"], "rows": []}
            segments.append(current)
        current["rows"].append(row)

    advancing = []
    for seg in segments:
        values = [r["seconds"] for r in seg["rows"] if r["seconds"] is not None]
        distinct = sorted(set(values))
        monotonic = all(b >= a for a, b in zip(values, values[1:]))
        span = (distinct[-1] - distinct[0]) if len(distinct) > 1 else 0
        seg.update(distinct=distinct, monotonic=monotonic, span=span,
                   advancing=len(distinct) > 1 and monotonic and span > 0)
        # 只有「同一个阶段里秒数在走」才算证明了这个修复
        if seg["advancing"]:
            advancing.append(seg)

    print(f"== {Path(path).name} ==  段数 {len(segments)}，秒数在推进的段 {len(advancing)}")
    for seg in segments:
        mark = "ADVANCING" if seg["advancing"] else "         "
        first, last = seg["rows"][0], seg["rows"][-1]
        print(f"  {mark} 阶段「{seg['title'][:28]}」 样本 {len(seg['rows'])}"
              f" 秒数 {seg['distinct'][:6]}{'...' if len(seg['distinct']) > 6 else ''}"
              f" 跨度 {seg['span']}s 单调={seg['monotonic']}")
        print(f"             首条 {first['count'][:60]!r}")
        print(f"             末条 {last['count'][:60]!r}")
        print(f"             墙钟 {round((last['ts'] - first['ts']) / 1000)}s")
    return bool(advancing)


if __name__ == "__main__":
    paths = sys.argv[1:] or ["watch-solver-ap.jsonl"]
    ok = True
    for path in paths:
        if not Path(path).exists():
            print(f"{path}: 不存在")
            ok = False
            continue
        ok = analyze(path) and ok
    print("\nPROVEN" if ok else "\nNOT PROVEN")
    sys.exit(0 if ok else 1)
