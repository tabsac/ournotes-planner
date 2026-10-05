"""Prepare a static browser build from the already sanitized public release.

Never copies the owner's profile, private SQLite cache, or screenshot receipts.
The original application and its Windows packages are not changed.
"""
from pathlib import Path
import hashlib
import io
import json
import re
import shutil
import zipfile
import argparse
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
PUBLIC = HERE / "public"
VERSION = json.loads((HERE / "package.json").read_text("utf-8"))["version"]
# 内置快照的标识（曲目/谱面/活动都在 snapshot-override 里，随网页一起发布）
SNAPSHOT_INDEX = json.loads((HERE / "snapshot-override" / "index.json").read_text("utf-8"))
SNAPSHOT_NAME = Path(SNAPSHOT_INDEX["snapshot_prefix"]).parts[1]        # research/2026-10-01/raw/ → 2026-10-01
DIFFICULTIES = ("easy", "normal", "hard", "expert")


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise ValueError(f"UI source changed: {old[:70]}")
    return text.replace(old, new)


# ---------------------------------------------------------------------------
# 云端（服务器）配置 —— **可选、且只在本机构建时生效**
#
# 私密约束（服务器对接说明 §6）：**服务器地址绝不能进公开仓库，也不能进前端源码**。
# 所以这里读的是一个**被 .gitignore 忽略**的本机文件 `browser/api-config.local.json`：
#
#     {"apiBase": ""}                       ← 与网页同源（服务器自己托管网页时用这个）
#     {"apiBase": "https://api.xxxx.com"}   ← 跨源，会把源站加进 connect-src
#
# 没有这个文件（CI / 公开仓库 / GitHub Pages 的构建）时**什么都不做**：
# 页面照旧只有 `connect-src 'self' blob:`，云端功能在界面上显示「未配置」并且**一个请求都不发**。
# 另外 `tools/verify_release.py` 会拦住「把带地址的 index.html 发布出去」→ 见那里的
# `ournotes-api-base` 检查。
# ---------------------------------------------------------------------------
CLOUD_CONFIG = HERE / "api-config.local.json"


def cloud_api_base():
    """返回本机配置的 API base（None = 没配置）。值不合法就直接报错，别悄悄降级。"""
    if not CLOUD_CONFIG.is_file():
        return None
    try:
        # utf-8-sig：本机 PowerShell 的 Set-Content -Encoding UTF8 会写 BOM，别被它绊倒
        raw = json.loads(CLOUD_CONFIG.read_text("utf-8-sig"))
    except ValueError as error:
        raise SystemExit(f"{CLOUD_CONFIG.name} 不是合法 JSON：{error}")
    if not isinstance(raw, dict) or not isinstance(raw.get("apiBase"), str):
        raise SystemExit(f'{CLOUD_CONFIG.name} 需要形如 {{"apiBase": "https://…"}}')
    base = raw["apiBase"].strip().rstrip("/")
    # 只允许「空（同源）」/「/相对路径」/「http(s) 绝对地址」——这个值要进 HTML 属性，别让引号进来
    if base and not (base.startswith("/") or base.startswith("http://") or base.startswith("https://")):
        raise SystemExit(f"apiBase 只接受空值、/开头相对路径或 http(s) 绝对地址，收到：{base!r}")
    if any(ch in base for ch in '"\'<> \\\n\r\t'):
        raise SystemExit(f"apiBase 里有非法字符：{base!r}")
    return base


def inject_cloud_config(html):
    """把本机的 API base 写进页面：一个 <meta>（运行时读）+ CSP 的 connect-src（跨源时才加）。"""
    base = cloud_api_base()
    if base is None:
        return html
    if base.startswith("http"):
        # CSP 是按**源**放行的（connect-src 允许 https://host:port 就行）
        match = re.match(r"^(https?://[^/]+)", base)
        if not match:
            raise SystemExit(f"apiBase 无法解析出源：{base!r}")
        html = replace_once(html, "connect-src 'self' blob:;",
                            f"connect-src 'self' blob: {match.group(1)};")
    # ⚠️ 不能注入 <script>：本页 CSP 的 script-src 是 'self'，内联脚本会被拒。
    #    用 <meta> 传值，前端 document.querySelector 读它。
    html = replace_once(html, "<head>", f'<head><meta name="ournotes-api-base" content="{base}">')
    print(f"cloud api base injected: {base or '(same origin)'}", flush=True)
    return html


def add_runtime(archive, name, raw):
    entry = zipfile.ZipInfo(name, date_time=(2026, 10, 1, 0, 0, 0))
    entry.compress_type = zipfile.ZIP_DEFLATED
    entry.external_attr = 0o644 << 16
    archive.writestr(entry, raw)


def patch_runtime_source(relative, raw):
    """给上游只读的 Python 模块打补丁：让「乐队道具未解锁」成为合法状态。

    上游把「未填写」和「未解锁」混为一谈：只接受 1..cap，且缺条目直接 raise
    （"no zero is assumed"）。结果是任何还没解锁/没升级过乐队道具的账号
    —— 新号基本都是 —— 永远过不了校验，也就永远算不出结果。

    这里把 level 0 定义为「未解锁 = 不加成」，null/缺条目仍然是「未填写」。
    游戏侧依据：MasterBandItemSkillEffect 里等级 1 的 _effectValue 是 10（=0.1%，
    UNIT=10000），未解锁的道具游戏不给任何加成，所以 0 才是它的真实加成。
    """
    if not relative.endswith(".py"):
        return raw
    # 注意：上面这个判断不能写成 startswith("research/")。
    # research/ 下面既有 .py 也有数据（research/<日期>/raw/*.json 等），
    # 对数据做 decode→replace→encode 会改掉字节，
    # 而配队程序会逐表校验 sha256（deck_power._snapshot）→ 启动直接失败。
    # （Windows 上 write_text 默认写 CRLF，正好会被这一步"吃掉"，所以症状是校验不过。）
    text = raw.decode("utf-8").replace("\r\n", "\n")
    if relative == "planner_core.py":
        # 养成校验：道具等级下界 1 -> 0
        text = replace_once(text, '· 道具等级",\n              1, cap, "facility"',
                                  '· 道具等级",\n              0, cap, "facility"')
        # 实际计算前的入参校验：道具等级下界 1 -> 0
        text = replace_once(text, '的等级", 1, max_level)', '的等级", 0, max_level)')
    elif relative == "research/deck_power.py":
        # 0 级没有 MasterBandItemLevel 行，跳过存在性校验
        text = replace_once(
            text,
            '        level = _required(owned, "level", f"facility {identifier}", minimum=1)\n'
            '        _unique(tables["MasterBandItemLevel"], f"facility {identifier} level",\n'
            '                _bandItemId=identifier, _level=level)\n',
            '        level = _required(owned, "level", f"facility {identifier}", minimum=0)\n'
            '        if level:   # 0 = 未解锁，没有等级行可查\n'
            '            _unique(tables["MasterBandItemLevel"], f"facility {identifier} level",\n'
            '                    _bandItemId=identifier, _level=level)\n')
        # 未解锁的道具不加成
        text = replace_once(
            text,
            '        level = facilities[identifier]["level"]\n'
            '        effects = [row for row in tables["MasterBandItemSkillEffect"]\n',
            '        level = facilities[identifier]["level"]\n'
            '        if level == 0:\n'
            '            continue   # 未解锁：不加成\n'
            '        effects = [row for row in tables["MasterBandItemSkillEffect"]\n')
    return text.encode("utf-8")


def snapshot_digest():
    """把内置快照里「曲目 / 谱面显示等级 / 物量」与「当前活动」摘成一个小 JSON。

    目的：网页端能拿服务器 `/data/*.json` 跟**这份网页真正在用的数据**比 ——
    相等就说「一致」，不等就提醒用户「线上数据已更新，本页计算仍用内置快照」。
    ⚠️ 这只用于**比对与提醒**，绝不拿去替换求解用的快照：那份由 `upstream.json` 的 sha256 钉住，
    验收 oracle 也依赖它（见设计笔记「数据可变的门禁」一节）。
    """
    raw = HERE / "snapshot-override" / "research" / SNAPSHOT_NAME / "raw"
    music = read_snapshot_table(raw, "MasterLiveMusic")
    scores = {row.get("_id"): row for row in read_snapshot_table(raw, "MasterLiveMusicScore")}
    by_id = {}
    for row in music:
        mid = row.get("_id")
        if not isinstance(mid, int):
            continue
        parts = []
        for diff in DIFFICULTIES:
            chart = scores.get(row.get("_%sID" % diff)) or {}
            level = chart.get("_musicScoreDisplayLevel")
            if level is None:
                level = chart.get("_musicScoreLevel")
            combo = chart.get("_fullComboCount")
            parts.append("%s/%s" % (format_level(level), "" if combo is None else int(combo)))
        by_id[str(mid)] = "|".join(parts)
    canonical = "\n".join("%s:%s" % (key, by_id[key]) for key in sorted(by_id, key=int))
    digest = hashlib.sha256(("songs=%d\n%s" % (len(by_id), canonical)).encode("utf-8")).hexdigest()

    event = {}
    events = read_snapshot_table(raw, "MasterEvent")
    if events:
        row = events[0]
        event = {"id": row.get("_id"),
                 "startAt": str(row.get("_startAt") or ""),
                 "endAt": str(row.get("_endAt") or "")}
    return {"snapshot": SNAPSHOT_NAME, "songs": len(by_id), "songsDigest": digest,
            "songsById": by_id, "event": event,
            # 顺带带上三张源表的 sha256（来自 snapshot-override/index.json），
            # 出问题时能一眼看出「这份网页用的是哪一版数据」
            "tables": {name: SNAPSHOT_INDEX["tables"].get(name)
                       for name in ("MasterLiveMusic", "MasterLiveMusicScore", "MasterEvent")}}


def read_snapshot_table(raw, name):
    path = raw / (name + ".json")
    if not path.is_file():
        raise ValueError("快照里缺少 %s（%s）" % (name, path))
    rows = json.loads(path.read_text("utf-8"))
    if isinstance(rows, dict):
        for key in ("_allData", "rows", "data"):
            if isinstance(rows.get(key), list):
                return rows[key]
    return rows if isinstance(rows, list) else []


def format_level(value):
    if not isinstance(value, (int, float)):
        return ""
    text = ("%.2f" % float(value)).rstrip("0").rstrip(".")
    return text


def main():
    upstream = json.loads((HERE / "upstream.json").read_text("utf-8"))
    core_version = upstream["version"]
    source = HERE / "upstream" / upstream["archive"]
    if not source.is_file():
        source = ROOT / upstream["archive"]
    if hashlib.sha256(source.read_bytes()).hexdigest() != upstream["sha256"]:
        raise ValueError("Public baseline archive has changed; update and revalidate upstream.json explicitly")
    prefix = f"OurNotes-配队程序-v{core_version}/"
    # This is exclusively a generated directory. An old asset or accidental
    # profile file must never enter the next Vite build through public/.
    if PUBLIC.resolve() != HERE / "public":
        raise ValueError("Generated public directory points outside the build directory")
    if PUBLIC.exists():
        shutil.rmtree(PUBLIC)
    PUBLIC.mkdir()
    payload = io.BytesIO()
    included = []
    overridden = []
    added = []                      # 覆盖层里新增（上游 zip 里没有）的文件，见下面的新增循环
    with zipfile.ZipFile(source) as archive, zipfile.ZipFile(payload, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as runtime:
        # 统一成 LF：上游包里的 html 是 CRLF，而 `write_text` 在 Windows 上会把 \n 再翻成 \r\n
        # → 产物变成 `\r\r\n`（每行多一个 CR）。浏览器不在乎，但会让「两份产物逐字节对比」
        # 看着像有差异，交付/验收时白白多核一遍。app.js 早就做过同样的归一化（下一行），html 漏了。
        html = archive.read(prefix + "web/index.html").decode("utf-8").replace("\r\n", "\n")
        app = archive.read(prefix + "web/app.js").decode("utf-8").replace("\r\n", "\n")
        css = archive.read(prefix + "web/style.css")
        for info in archive.infolist():
            relative = info.filename.removeprefix(prefix)
            if relative == info.filename or ".." in Path(relative).parts:
                raise ValueError("Invalid public archive path")
            if any(word in relative for word in ("player_growth_observations", "party_sample", "challenge_receipt", "private", ".sqlite", "ui-exported")):
                raise ValueError("Private file in public release")
            if relative in ("planner_core.py", "search_cache.py", "solver_search.py", "score_bounds.py") or relative.startswith("research/"):
                raw = archive.read(info)
                # 数据快照覆盖层：活动加成/新卡这类只改数据的更新，不必动上游 zip
                # （那个 zip 带 sha256 校验，是刻意设的保护，不该绕过）。
                # 只要 snapshot-override/<zip 内相对路径> 存在，就用本地这份。
                override = HERE / "snapshot-override" / relative
                if override.is_file():
                    raw = override.read_bytes()
                    overridden.append(relative)
                raw = patch_runtime_source(relative, raw)
                add_runtime(runtime, relative, raw)
                included.append(relative)
            elif relative.startswith("web/card-images/"):
                target = PUBLIC / relative.removeprefix("web/")
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(info))
            elif relative.startswith("licenses/") or relative == "THIRD-PARTY-NOTICES.txt":
                target = PUBLIC / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(info))
        for name in ("browser_runtime.py", "cp_model.py", "account_import.py", "account_scores.py"):
            add_runtime(runtime, name, (HERE / name).read_bytes())
            included.append(name)
        # 覆盖层里**新增**的文件（上游 zip 里本来没有的）。
        # 为什么必须支持：新曲目的谱面 `normalized/converted_charts/<id>/<难度>.json` 与补齐后的
        # 转换报告就是「新文件」——只替换同名条目的话，报告会说这首可玩、谱面却不在包里，
        # 用户选中它就炸（tools/sync_charts_from_data.py 生成的正是不存在的文件）。
        snapshot_root = Path(SNAPSHOT_INDEX["snapshot_prefix"]).parent.as_posix() + "/"
        for path in sorted((HERE / "snapshot-override" / snapshot_root).rglob("*")):
            if not path.is_file():
                continue
            relative = path.relative_to(HERE / "snapshot-override").as_posix()
            if relative in included:
                continue
            if ".." in Path(relative).parts:
                raise ValueError("Invalid override path")
            if any(word in relative for word in ("player_growth_observations", "party_sample", "challenge_receipt", "private", ".sqlite", "ui-exported")):
                raise ValueError("Private file in override")
            add_runtime(runtime, relative, patch_runtime_source(relative, path.read_bytes()))
            included.append(relative)
            added.append(relative)
    (PUBLIC / "planner-runtime.zip").write_bytes(payload.getvalue())
    # 角色立绘 / 道具图标（本地生成，随网页提供，无外链）
    for image_dir, src_dir in (("character-images", "character"), ("item-images", "facility"),
                               ("jacket-images", "jacket"), ("ui-images", "ui"), ("avatar-images", "avatar")):
        images = sorted((HERE / "static-images" / src_dir).glob("*.webp"))
        if not images:
            raise ValueError(f"缺少图片资源 static-images/{src_dir}，请先跑 on_cards/make_web_assets.py")
        destination = PUBLIC / image_dir
        destination.mkdir(parents=True, exist_ok=True)
        for image in images:
            shutil.copyfile(image, destination / image.name)
    # 取包工具下载（网页里的教程直接链到 downloads/）
    # 注意：PUBLIC 每次构建都会被整个删除重建，所以这些文件必须走这一步，
    # 手动往 dist/ 里丢是一次性的，下次构建就没了。
    downloads = sorted((HERE / "downloads").glob("*")) if (HERE / "downloads").is_dir() else []
    if not downloads:
        raise ValueError("缺少 browser/downloads/，取包工具下载链接会 404")
    download_dir = PUBLIC / "downloads"
    download_dir.mkdir(parents=True, exist_ok=True)
    for item in downloads:
        if item.is_file():
            shutil.copyfile(item, download_dir / item.name)
    # B25 页要用的两张小表（评级档位 / 玩家等级）。
    # 这几张表不在配队程序的 71 张快照里，所以单独放 static-data/ 随网页发布，
    # 由 make_b25_extra.py 从 master 包生成；数据更新后要重跑那个脚本。
    static_data = HERE / "static-data"
    if not (static_data / "b25-extra.json").is_file():
        raise ValueError("缺少 browser/static-data/b25-extra.json，请先运行 make_b25_extra.py")
    static_dir = PUBLIC / "static-data"
    static_dir.mkdir(parents=True, exist_ok=True)
    for item in sorted(static_data.glob("*")):
        if item.is_file():
            shutil.copyfile(item, static_dir / item.name)
    # 「内置快照摘要」：把**这份网页实际用的**曲目/谱面等级/物量与活动摘出来随站发布，
    # 好让「账号」页能拿它跟服务器 /data/*.json 比 —— 数据变了就能提醒用户
    # （求解仍用内置快照，那个由 upstream.json 的 sha256 钉住，不能悄悄换）。
    (static_dir / "snapshot-digest.json").write_text(
        json.dumps(snapshot_digest(), ensure_ascii=False, indent=1, sort_keys=True), "utf-8")
    pyodide = HERE / "node_modules/pyodide"
    destination = PUBLIC / "vendor/pyodide"
    destination.mkdir(parents=True, exist_ok=True)
    for name in ("pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"):
        shutil.copyfile(pyodide / name, destination / name)
    licenses = PUBLIC / "licenses"
    for package, name in (("or-tools-wasm", "OR-Tools-WASM-LICENSE.txt"), ("protobufjs", "protobufjs-LICENSE.txt"), ("long", "long-LICENSE.txt")):
        shutil.copyfile(HERE / "node_modules" / package / "LICENSE", licenses / name)
    for license_file in (HERE / "license-source").glob("*.txt"):
        shutil.copyfile(license_file, licenses / license_file.name)
    shutil.copyfile(ROOT / "LICENSE", licenses / "project-LICENSE.txt")
    with (PUBLIC / "THIRD-PARTY-NOTICES.txt").open("a", encoding="utf-8") as notices:
        notices.write("\n\n===== BROWSER RUNTIME =====\n")
        notices.write("Pyodide 314.0.7 (MPL-2.0 and bundled component notices): https://github.com/pyodide/pyodide/tree/314.0.7\n")
        notices.write("or-tools-wasm 0.9.1 (Apache-2.0): https://github.com/Axelwickm/or-tools-wasm\n")
        notices.write("protobufjs 7.5.4 (BSD-3-Clause): https://github.com/protobufjs/protobuf.js\n")
        notices.write("long 5.3.2 (Apache-2.0): https://github.com/dcodeIO/long.js\n")
        notices.write("Full added license texts are in licenses/. Runtime assets are self-hosted; no cloud solving is used.\n")
    shutil.copyfile(HERE / "service-worker.js", PUBLIC / "service-worker.js")
    (PUBLIC / ".nojekyll").write_text("", "utf-8")
    html = replace_once(html, '<link rel="stylesheet" href="/style.css"><script src="/app.js" defer></script>',
                        '<link rel="stylesheet" href="./style.css"><script type="module" src="./main.js"></script>')
    # ⚠️ connect-src 里的 `blob:` 不是可有可无的（v0.1.3 加回来的）：
    #    手机自带浏览器（实测 X 浏览器）把「下载」挂在自己注入页面的脚本上 —— 页面 `a.click()`
    #    一个 blob: 链接之后，它用 `fetch(blob:...)` 取字节、再交给原生层落盘。
    #    少了 blob: 这句 fetch 会被本页 CSP 拒掉（`Refused to connect to 'blob:...'`），
    #    紧接着 `TypeError: Failed to fetch`，表现为**点了「导出本次结果」没有任何文件落地**。
    #    真机取证与复现步骤见 tools/mobile/README.md 与设计笔记 2j④。
    html = replace_once(html, '<head>', '<head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\' \'unsafe-eval\'; worker-src \'self\' blob:; img-src \'self\' data:; connect-src \'self\' blob:; object-src \'none\'; base-uri \'self\';">')
    html = inject_cloud_config(html)
    html = replace_once(html, '<title>', '<link rel="icon" href="./favicon.svg"><title>')
    (PUBLIC / "favicon.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#7667de"/><path d="M32 8 38 26 56 32 38 38 32 56 26 38 8 32 26 26Z" fill="white"/></svg>', "utf-8")
    html = html.replace("OUR NOTES / LOCAL PLANNER", "OUR NOTES / BROWSER PLANNER").replace("本地运行", "浏览器计算")
    html = replace_once(html, '<div id="loadError"', '<div id="browserLoading" class="notice" role="status" aria-live="polite">正在准备浏览器计算组件，首次打开需要下载，请稍候…</div>\n <div id="loadError"')
    html = html.replace('data-tab="software">软件更新', 'data-tab="software">关于网页版')
    start = html.index(' <section id="software"')
    end = html.index('</section>', start) + len('</section>')
    html = html[:start] + f''' <section id="software" class="tab-page" hidden><div class="panel">
<div class="section-kicker">无需安装 / 浏览器计算</div><h2>Our Notes 配队网页版 v{VERSION}</h2>
<p>计算在你自己的设备上运行，无需登录或安装程序。个人卡库保存在当前浏览器，计算输入不会上传到计算服务器。</p>
<p>可以导入本地版导出的卡库。换设备、换浏览器或清理网站数据之前，请先导出卡库。</p>
<p>计算时请保持页面打开。手机切到后台或关闭页面可能中断；已保存的完整步骤可在下次继续。</p>
<p>当前沿用本地版 v{core_version} 的公式和 2026-10-01 数据，只支持对应活动、普通单人自由演出及撃奏关闭的计算范围。</p>
<p>大卡库的速度和可用内存取决于设备。只有完成完整搜索与最优验证后才展示方案和前三首乐曲。</p>
<p>网页更新后刷新即可使用；自己的卡库仍保存在同一网址和浏览器。发生加载问题时，可用电脑的近期 Chrome 或 Edge 重新打开。</p>
<a href="./THIRD-PARTY-NOTICES.txt" target="_blank" rel="noopener">数据与第三方软件说明</a>
</div></section>''' + html[end:]
    html = html.replace("卡图已保存在本地", "卡图随网页提供")
    html = html.replace('id="profileBadge" class="badge">截图示例', 'id="profileBadge" class="badge">个人卡库')
    html = replace_once(html, f'Our Notes 配队与收益 · v{core_version}', f'Our Notes 配队网页版 · v{VERSION} · 模型 v{core_version}')

    # ---- 「账号包导入」页：一个 tab 按钮 + 一个容器 section（内容由 account-ui.js 渲染）----
    # ---- 「B25 成绩」页：独立页签，内容由 b25-ui.js 渲染（数据由账号页存进 localStorage）----
    # ---- 「账号」页：云端账号 + 结果 + 卡库同步（cloud-ui.js 渲染）----
    html = replace_once(
        html,
        '<button data-tab="software">关于网页版</button>',
        '<button data-tab="account">账号包导入</button><button data-tab="b25">B25 成绩</button>'
        '<button data-tab="cloud">账号</button>'
        '<button data-tab="software">关于网页版</button>')
    html = replace_once(
        html,
        ' <section id="software"',
        ' <section id="account" class="tab-page" hidden><div id="accountImportRoot"></div></section>\n'
        ' <section id="b25" class="tab-page" hidden><div id="b25Root"></div></section>\n'
        ' <section id="cloud" class="tab-page" hidden><div id="cloudRoot"></div></section>\n'
        ' <section id="software"')
    # 头部小标识：未登录 / 用户名 / 同步状态，点它跳到「账号」页（main.js 里绑事件）。
    # ⚠️ 必须做成 `#profileBadge` 的**兄弟节点**：generated-app.js 会 `profileBadge.textContent = …`，
    #    那一下会把所有子节点清掉（踩过）。
    html = replace_once(
        html,
        '<div id="profileHint"',
        '<span id="cloudBadge" class="badge cloud-badge" role="button" tabindex="0">云端未启用</span>'
        '<div id="profileHint"')
    # 「关于网页版」页尾部加一个「数据状态」容器（由 remote-data.js 渲染）
    html = replace_once(
        html,
        '<a href="./THIRD-PARTY-NOTICES.txt" target="_blank" rel="noopener">数据与第三方软件说明</a>',
        '<div id="dataStatusRoot" class="data-status-box"></div>\n'
        '<a href="./THIRD-PARTY-NOTICES.txt" target="_blank" rel="noopener">数据与第三方软件说明</a>')

    (HERE / "index.html").write_text(html, "utf-8", newline="\n")
    (HERE / "style.css").write_bytes(css + b"\n" + (HERE / "account.css").read_bytes())
    app = replace_once(app, 'const STORE = "ournotes-local-planner-v1-profile";', 'const STORE = "ournotes-browser-planner-v1-profile:" + window.Planner.scope;')
    # 深链接白名单：上游只列了自己那几页，账号页 / B25 页 / 账号页要补上，否则 #b25 打不开
    app = replace_once(
        app,
        'if (["plan","inventory","growth","evidence","software"].includes(tab)) showTab(tab);',
        'if (["plan","inventory","growth","evidence","account","b25","cloud","software"].includes(tab)) showTab(tab);')
    profile_code = '''import {createProfileStorage} from './profile-storage.js';
function profileWarning(id, text) {
  let panel = document.getElementById(id);
  if (!panel) {
    panel = document.createElement('div'); panel.id = id;
    panel.className = 'notice error'; panel.setAttribute('role', 'status');
    document.getElementById('browserLoading').after(panel);
  }
  panel.textContent = text;
}
const profileStore = createProfileStorage(STORE, () => {
  document.getElementById('inputArea').disabled = true;
  ['demo','new','import'].forEach(id => document.getElementById(id).disabled = true);
  profileWarning('browserProfileConflict', '另一标签页已更新卡库。请刷新本页读取最新卡库；若要保留本页输入，请先导出卡库。');
}, () => profileWarning('browserProfileStorageError', '浏览器无法保存卡库，本次输入仅在当前页面。请使用「导出卡库」备份后再关闭网页。'));
'''
    app = replace_once(app, 'const STORE = "ournotes-browser-planner-v1-profile:" + window.Planner.scope;',
                       'const STORE = "ournotes-browser-planner-v1-profile:" + window.Planner.scope;\n' + profile_code)
    save_start = app.index('function save() {')
    save_end = app.index('function changed()', save_start)
    app = app[:save_start] + 'function save() {profileStore.save(JSON.stringify(state));}\n' + app[save_end:]
    # 卡库的云端同步桥：让「账号」页能拿到当前卡库、并把云端那份装回来。
    # 装回走 replaceState（它会跑 normalizeImport 校验 + 重画输入区）；
    # 正在计算或本页已经不是最新卡库时**拒绝**安装，避免把用户正在填的东西冲掉。
    app = replace_once(
        app,
        'function save() {profileStore.save(JSON.stringify(state));}',
        '''function save() {profileStore.save(JSON.stringify(state));}
window.PlannerProfile = {
  document: () => clone(state),
  install: (document) => {
    if (jobId || profileStore.outOfDate) return false;
    try {replaceState(document);} catch {return false;}
    return true;
  },
  storage: profileStore,
};''')
    app = replace_once(app, 'const saved = localStorage.getItem(STORE);', 'const saved = profileStore.load();')
    app = replace_once(app, 'function replaceState(x) { if (jobId) return;', 'function replaceState(x) { if (jobId || profileStore.outOfDate) return;')
    app = replace_once(app, '$("inputArea").disabled = on;', '$("inputArea").disabled = on || profileStore.outOfDate;')
    app = replace_once(app, '$(id).disabled = on);', '$(id).disabled = on || profileStore.outOfDate);')
    app = replace_once(app, 'if (jobId || startingJob || updatingSoftware) return;', 'if (jobId || startingJob || updatingSoftware || profileStore.outOfDate) return;')
    app = app.replace("fetch(", "window.plannerFetch(")
    app = replace_once(app, 'if (e.target.matches?.(".card-art img")) e.target.parentElement.classList.add("image-failed");', '''if (e.target.matches?.(".card-art img")) {
    const image = e.target;
    // 已经退到卡图占位图就别再碰它：占位图是 data: URI，往它后面拼 ?image_retry=N
    // 会把 SVG 内容弄坏（实测 0x0、直接 error），兜底反而变成破图。
    if (image.dataset.cardFallback) return;
    const retries = Number(image.dataset.imageRetries || 0);
    if (retries < 2) {
      image.dataset.imageRetries = String(retries + 1);
      setTimeout(() => {
        if (!image.isConnected || image.dataset.cardFallback) return;
        if (!/card-images\\//.test(image.getAttribute("src") || "")) return;
        const url = new URL(image.src); url.searchParams.set('image_retry', String(retries + 1));
        image.src = url.href;
      }, 750 * (retries + 1));
    } else image.parentElement.classList.add("image-failed");
  }''')
    app = replace_once(app, '启动时重新运行校准，已通过综合力与两组结算收益检查。新队伍和推荐乐曲仍属于模型估算。',
                       '${calibration.power_recomputed ? "启动时已重新核对综合力与两组收益。" : "已重新核对公共收益公式；综合力展示历史截图校准记录，当前分享包不含原个人养成。"}新队伍和推荐乐曲仍属于模型估算。')
    start = app.index("function softwareMessage(")
    end = app.index("async function calculate(", start)
    app = app[:start] + app[end:]
    # 进度里的「已等待 N 秒」不能只靠后端发来的 elapsed_seconds：求解阶段后端不再发
    # 进度事件，那个值会一直停在最后一次事件上。手机上一轮求解要等 1~2 分钟，
    # 用户看到的就是一个不动的计数器 —— 「卡住了」和「正在算第 38 秒」是两种体验。
    # 这里本地再走一只秒表，与后端值取较大者：计数只增不减，且求解期间也在动。
    app = replace_once(
        app, 'async function calculate(existingJob=null) {',
        '''let jobStartedAt = 0;
/** 「已等待」秒数：以后端 elapsed_seconds 为准，但它只在有进度事件时才更新，
 *  所以与本地秒表取较大者 —— 单调，且在求解期间照样走。 */
function waitedSeconds(job) {
  return Math.floor(Math.max(job.elapsed_seconds || 0, (performance.now() - jobStartedAt) / 1000));
}
async function calculate(existingJob=null) {''')
    app = replace_once(
        app, 'startingJob = true; cancelRequested = false; clearTimeout(growthTimer);',
        'startingJob = true; jobStartedAt = performance.now(); cancelRequested = false; clearTimeout(growthTimer);')
    app = replace_once(app, '已等待 ${fmt(Math.floor(job.elapsed_seconds || 0))} 秒',
                            '已等待 ${fmt(waitedSeconds(job))} 秒')
    app = replace_once(app, "${job.elapsed_seconds ? ` · 已等待 ${fmt(Math.floor(job.elapsed_seconds))} 秒` : ''}",
                            "${waitedSeconds(job) ? ` · 已等待 ${fmt(waitedSeconds(job))} 秒` : ''}")
    for line in ('  $("updateControls").disabled = on || updatingSoftware || !softwareInfo?.supported;\n',
                 '  $("exitSoftware").disabled = on || updatingSoftware;\n',
                 '    await initSoftwareUpdate();\n', '    softwareBusy(updatingSoftware);\n'):
        app = replace_once(app, line, "")
    # ---- 乐队道具：0 = 未解锁（见 patch_runtime_source 的说明）----
    app = replace_once(app, 'min="1" max="${f.max_level}" data-facility="${f.id}"',
                             'min="0" max="${f.max_level}" data-facility="${f.id}"')
    app = replace_once(app, '乐队道具 · 所属乐队的全部道具共同提供加成',
                             '乐队道具 · 所属乐队的全部道具共同提供加成（未解锁填 0）')

    # ---- 「角色与道具」页加上立绘与道具图标 ----
    # 只有文字标签时，用户没法确认哪个道具是哪件乐器、也没法一眼认出角色。
    # 图来自游戏资源（见 on_cards/make_web_assets.py），随网页本地提供，不走外链。
    app = replace_once(
        app,
        '<label>${esc(c.name)}<input type="number" min="1" max="1000" data-rank="${c.id}"',
        '<label class="growth-item"><img class="growth-art" src="./character-images/character-${c.id}.webp"'
        ' alt="" loading="lazy" decoding="async" width="40" height="40">${esc(c.name)}'
        '<input type="number" min="1" max="1000" data-rank="${c.id}"')
    app = replace_once(
        app,
        '<label>${esc(f.name)}<input type="number" min="0" max="${f.max_level}" data-facility="${f.id}"',
        '<label class="growth-item"><img class="growth-art growth-art-item" src="./item-images/facility-${f.id}.webp"'
        ' alt="" loading="lazy" decoding="async" width="40" height="40">${esc(f.name)}'
        '<input type="number" min="0" max="${f.max_level}" data-facility="${f.id}"')

    # ---- 「收益规划」结果里的队伍：给 5 位成员与 5 张 Snap 配上卡图 ----
    # 原来 deckHtml 只有一行行文字（[标题] 名字 / Lv... / Snap ...），
    # 5 套队伍全靠读名字辨认，很容易看错。cardArt() 已经存在（「我的卡库」在用），
    # 这里直接复用，只是外面套一层限定宽度的 .deck-art 容器，
    # 因为 .card-art 本身是 width:100% + aspect-ratio:3/4，直接放进队伍行会撑爆。
    app = replace_once(
        app,
        'return `<div class="deck-slot"><b>[${esc(m.title)}] ${esc(m.name)}</b>',
        'return `<div class="deck-slot"><span class="deck-art deck-art-member">${cardArt(m,"members")}</span>'
        '<div class="deck-body"><b>[${esc(m.title)}] ${esc(m.name)}</b>')
    app = replace_once(
        app,
        '<br><span class="muted">Snap [${esc(s.title)}] ${esc(s.name)} · Lv.${support.level} / 突破 ${support.limit_break_count} 次</span></div>`;',
        '<br><span class="deck-snap"><span class="deck-art deck-art-snap">${cardArt(s,"snaps")}</span>'
        '<span class="muted">Snap [${esc(s.title)}] ${esc(s.name)} · Lv.${support.level} / 突破 ${support.limit_break_count} 次</span>'
        '</span></div></div>`;')

    # ---- 「前三首最佳收益乐曲」：给每首歌配封面 ----
    # 封面文件名 jkt_<乐队>_<乐曲ID>.jpg，乐曲 ID 直接从文件名取，
    # MasterLiveMusic 全 84 首都有封面，不会缺图。
    app = replace_once(
        app,
        '<article class="song-rank"><div class="position">0${i+1}${tied ? " · 平手" : ""}</div>'
        '<strong>${esc(song(row.song_id).title)}</strong>',
        '<article class="song-rank"><div class="song-head">'
        '<img class="song-cover" src="./jacket-images/song-${row.song_id}.webp" alt="" loading="lazy" decoding="async" width="56" height="56">'
        '<div><div class="position">0${i+1}${tied ? " · 平手" : ""}</div>'
        '<strong>${esc(song(row.song_id).title)}</strong></div></div>')

    # ---- 账号包导入桥接：把生成的 App 内部函数暴露给 account-ui.js ----
    # 追加在模块末尾，这样 replaceState / normalizeImport / state / catalog / notice 都在作用域里。
    app += '''

/* ===== 账号包导入桥接（build_browser.py 注入）===== */
// 乐曲封面缺失时退回占位图。用内联 onerror 会被这里的 CSP
// (script-src 'self' 'unsafe-eval'，没有 'unsafe-inline') 拦掉，所以在捕获阶段挂监听。
// 封面是按配队程序快照的乐曲表预生成的，正常情况下不会走到这里；
// 万一以后快照新增了乐曲，也只是显示占位图而不是破图。
document.addEventListener("error", (event) => {
  const el = event.target;
  if (!(el instanceof HTMLImageElement)) return;
  if (!el.classList.contains("song-cover")) return;
  if (el.dataset.coverFallback) return;
  el.dataset.coverFallback = "1";
  el.src = "./jacket-images/placeholder.webp";
}, true);

// 卡图缺失的兜底。卡图 (card-images/members-*.webp / snaps-*.webp) 来自配队程序的
// 固定快照，而主数据是可以一键更新的 —— 所以「数据里有这张卡、但图还没跟上」是
// 正常会发生的（实测刷到 1.0.0.300 时 members-64 / snaps-70 就是这样）。
// 这里用一个内联 SVG 占位（CSP 的 img-src 允许 data:），别让它变成破图。
const CARD_PLACEHOLDER = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160" viewBox="0 0 120 160">'
  + '<rect width="120" height="160" rx="10" fill="#e8e7f4"/>'
  + '<text x="60" y="86" font-size="34" text-anchor="middle" fill="#9d9bb8">?</text>'
  + '<text x="60" y="112" font-size="12" text-anchor="middle" fill="#9d9bb8">暂无卡图</text>'
  + '</svg>');
document.addEventListener("error", (event) => {
  const el = event.target;
  if (!(el instanceof HTMLImageElement)) return;
  if (el.dataset.cardFallback) return;
  if (!/card-images\\//.test(el.getAttribute("src") || "")) return;
  // 归重试逻辑管的卡图，要等它把两次重试用完再上占位图 —— 用完的标志就是它给父元素
  // 加了 image-failed（imageRetries 只是「已经排了几次重试」，第二次出错时就已经是 2，
  // 拿它当判据会早一轮换掉 src，重试请求就发不出去了）。
  // 不在重试管辖范围内的（不是 .card-art img）当场兜底。
  if (el.matches(".card-art img") && !el.parentElement.classList.contains("image-failed")) return;
  el.dataset.cardFallback = "1";
  el.src = CARD_PLACEHOLDER;
}, true);

window.PlannerAccount = {
  // 走 App 自己的 normalizeImport + replaceState，保证与「导入卡库」走同一条校验路径
  apply(wrapper, message) {
    replaceState(normalizeImport(wrapper));
    if (message) notice(message, "success");
  },
  current() { return state; },
  catalog() { return catalog; },
  notify(text, type) { notice(text, type); },
};
'''
    (HERE / "generated-app.js").write_text(app, "utf-8")
    report = {"browser_version": VERSION, "core_version": core_version,
              "public_source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
              "runtime_sha256": hashlib.sha256(payload.getvalue()).hexdigest(),
              "python_runtime": "Pyodide 314.0.7", "solver": "or-tools-wasm 0.9.1",
              "payload_files": included, "private_files_included": False,
              "snapshot_overrides": sorted(overridden),
              "snapshot_added": sorted(added),
              "static_files": {p.relative_to(PUBLIC).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                               for p in sorted(PUBLIC.rglob("*")) if p.is_file() and p.name != "build-info.json"}}
    (PUBLIC / "build-info.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), "utf-8")
    print(json.dumps({k: v for k, v in report.items() if k not in ("payload_files", "static_files")}, ensure_ascii=False))


def patch_solver_runtime(dist):
    """把 or-tools-wasm 的浏览器运行时改成「不建 pthread 线程池」。

    or-tools-wasm 的浏览器构建是 emscripten 的 pthread 构建：模块初始化时**无条件**
    先建一个 4 个 worker 的线程池（`PThread.initMainThread`），把 wasm 的
    SharedArrayBuffer 内存 transfer 给它们，并把 `loading-workers` 记成一道 run
    dependency。没有跨源隔离的浏览器（手机自带浏览器 / WebView —— 实测即使服务端
    发真 COOP+COEP，`crossOriginIsolated` 仍是 false）在这一步必抛：

        DataCloneError: Failed to execute 'postMessage' on 'Worker':
        SharedArrayBuffer transfer requires self.crossOriginIsolated.

    然后模块永远卡在那道 run dependency 上，求解器再也回不了消息 ——
    表现是「精确求解中…」之后彻底不动。or-tools-wasm 自己的 README 也写着
    *"Browser builds require cross-origin isolation headers for WebAssembly threads."*

    本项目的求解一律 `numSearchWorkers=1`（见 browser_runtime.native_solve），
    用不到真线程。把池子开成 0 之后 `loadWasmModuleToAllWorkers()` 变成
    `Promise.all([])`：不建 worker、不 transfer、也就没有那道 dependency。

    真机实测（Android 11 / WebView 124，`crossOriginIsolated=false`、无 SAB）：
        池=4 → 求解请求 90 秒无任何响应（模块卡死）；
        池=0 → 38 秒返回 status=4（OPTIMAL）。

    上游一旦改掉这段写法，这里会直接报错，而不是悄悄放过一个跑不动的构建。
    """
    assets = dist / "assets"
    patched = []
    for path in sorted(assets.glob("cp_sat_runtime*.js")):
        text = path.read_text("utf-8")
        if "var pthreadPoolSize=0;" in text:
            patched.append(path.name)
            continue
        if "var pthreadPoolSize=4;" not in text:
            raise ValueError(f"求解器运行时里找不到 pthread 池定义，or-tools-wasm 可能已升级：{path.name}")
        path.write_text(text.replace("var pthreadPoolSize=4;", "var pthreadPoolSize=0;"), "utf-8")
        patched.append(path.name)
    if not patched:
        raise ValueError("dist/assets 下没有 cp_sat_runtime*.js，求解器补丁没能生效")
    print("solver runtime patched (pthread pool -> 0): " + ", ".join(patched))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--build", action="store_true", help="Also build the prepared site with Vite")
    args = parser.parse_args()
    main()
    if args.build:
        subprocess.run(["node", str(HERE / "node_modules/vite/bin/vite.js"), "build"], cwd=HERE, check=True)
        patch_solver_runtime(HERE / "dist")
