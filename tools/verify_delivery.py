# -*- coding: utf-8 -*-
"""交付构建的双向护栏：正式站那份**必须带**同源标记，公开镜像那份**必须不带**。

为什么需要它（2026-10-05 的真实事故）
------------------------------------------------------------------
把**镜像构建**的 `index.html` 发到了正式站 → 页面读不到 `<meta name="ournotes-api-base">`
→ `apiBase()` 为 null → 云端功能**静默失效**（角标「云端未启用」、账号面板打不开、
一个 `/api` 请求都不发），而且**从部署那一刻起就是坏的**。
两份产物逐字符 diff 后，**唯一差异就是这 42 字节**：

    交付构建 13968 B（带标记）  vs  镜像构建 13926 B（不带标记）

在此之前仓库里唯一的断言是 `tools/verify_release.py` 的
「**要发布的站点不许带**这个标记」—— 它默认查 `docs/`，
于是「交付构建**必须带**」这件事**没有任何地方管**。
阿里云的 `web_release_guard.sh` 只在**发上去之后 / 部署前**兜住线上那一侧，
构建与打包这一步是空的 —— 本工具补的就是这一步。

用法
------------------------------------------------------------------
    python -B tools/verify_delivery.py                     # 交付=browser/dist，镜像=docs
    python -B tools/verify_delivery.py --delivery <目录> --mirror <目录>
    python -B tools/verify_delivery.py --no-mirror         # 只查交付那一份
    python -B tools/verify_delivery.py --structural        # 再叠一遍 verify_release 的结构化校验
    python -B tools/verify_delivery.py --self-test         # 门禁自己的诚实性测试

退出码 0 = 通过，1 = 有任何一条不过。

⚠️ 红线（§0.1）：**服务器地址不进日志、不进报告**。所以标记的 `content` 一旦不是空串，
本工具只报「非空 + 字符数」，**从不回显那个值**。
"""
from pathlib import Path
import argparse
import hashlib
import json
import re
import shutil
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]

# 交付构建里**必须**逐字出现的那 42 字节（13968 - 13926 = 42）。
SAME_ORIGIN_META = '<meta name="ournotes-api-base" content="">'
# 认标记时容忍属性顺序/大小写变化，但**只**用于诊断 —— 通过与否以 SAME_ORIGIN_META 逐字为准。
MARKER_TAG = re.compile(r'<meta[^>]*name="ournotes-api-base"[^>]*>', re.I)
MARKER_TAG_BYTES = re.compile(rb'<meta[^>]*name="ournotes-api-base"[^>]*>', re.I)
CONTENT_ATTR = re.compile(r'content="([^"]*)"', re.I)
CONNECT_SRC = re.compile(r"connect-src[^;\"]*")


def _redact(tag):
    """把一个 <meta> 标签描述成人能看、但不泄漏地址的形式。"""
    match = CONTENT_ATTR.search(tag)
    if not match:
        return "（这个标记没有可解析的 content 属性）"
    value = match.group(1)
    if value == "":
        return 'content=""（同源）'
    return "content=<非空，%d 字符，按红线不在此回显>" % len(value)


def _load(site):
    """返回 (index.html 路径, 文本, 字节, 错误说明)。"""
    site = Path(site)
    path = site / "index.html"
    if not path.is_file():
        return site, None, None, "没有 index.html：%s" % path
    raw = path.read_bytes()
    return site, raw.decode("utf-8"), raw, None


def check_delivery(site):
    """交付构建（正式站）：必须带、且只带一个、内容必须是空串（同源）。"""
    site, html, raw, error = _load(site)
    checks = []
    if error:
        return {"passed": False, "site": str(site), "checks": [
            {"name": "index.html 存在", "ok": False, "detail": error}]}

    tags = MARKER_TAG.findall(html)
    checks.append({"name": "带 api-base 标记", "ok": bool(tags), "detail": (
        "找到 %d 个" % len(tags) if tags else
        "**没有**这个标记 → 这份是「镜像构建」。发到正式站会让云端功能静默失效"
        "（角标「云端未启用」、账号面板打不开、零 /api 请求）")})
    checks.append({"name": "标记只出现一次", "ok": len(tags) == 1,
                   "detail": "实际 %d 个" % len(tags)})
    exact = SAME_ORIGIN_META in html
    checks.append({"name": '内容逐字是 content=""（同源）', "ok": exact, "detail": (
        "正是 " + SAME_ORIGIN_META if exact else
        ("；".join(_redact(tag) for tag in tags) if tags else "没有标记"))})

    # 跨源构建会把源站追加进 CSP 的 connect-src —— 那等于把服务器地址写进了产物（红线 §0.1）。
    connect = CONNECT_SRC.search(html)
    csp_ok = bool(connect) and "http" not in connect.group(0)
    checks.append({"name": "CSP connect-src 没被跨源放行", "ok": csp_ok, "detail": (
        connect.group(0) if connect else "没找到 connect-src 指令")})

    version = json.loads((ROOT / "browser/package.json").read_text("utf-8"))["version"]
    info_path = site / "build-info.json"
    if info_path.is_file():
        built = json.loads(info_path.read_text("utf-8")).get("browser_version")
        checks.append({"name": "产物版本与 package.json 一致", "ok": built == version,
                       "detail": "产物 %s / 源码 %s" % (built, version)})
    else:
        checks.append({"name": "产物版本与 package.json 一致", "ok": False,
                       "detail": "没有 build-info.json：%s" % info_path})

    return {"passed": all(item["ok"] for item in checks), "site": str(site),
            "index_html_bytes": len(raw),
            "index_html_sha256": hashlib.sha256(raw).hexdigest(),
            "checks": checks}


def check_mirror(site):
    """公开镜像（GitHub Pages）：**一个标记都不许有**。"""
    site, html, raw, error = _load(site)
    if error:
        return {"passed": False, "site": str(site), "checks": [
            {"name": "index.html 存在", "ok": False, "detail": error}]}
    tags = MARKER_TAG.findall(html)
    checks = [{"name": "不带 api-base 标记", "ok": not tags, "detail": (
        "干净" if not tags else
        "带了 %d 个标记（%s）：镜像站上没有 /api，带上它只会让云端面板去打必然 404 的同源接口，"
        "而且公开仓库的产物里不该出现这个配置"
        % (len(tags), "；".join(_redact(tag) for tag in tags)))}]
    return {"passed": all(item["ok"] for item in checks), "site": str(site),
            "index_html_bytes": len(raw),
            "index_html_sha256": hashlib.sha256(raw).hexdigest(), "checks": checks}


def check_pair(delivery_site, mirror_site):
    """两份产物必须是「同一个构建、只换了云端配置」—— 即**只差这 42 字节**。

    这是最强的一条：它同时证明
      * 交付那份是在**同一份源码/同一份数据**上构建的（不是隔了一轮、数据不同的旧构建）；
      * 镜像那份没有被误当成交付、反之亦然。
    """
    _, delivery_html, delivery_raw, error_a = _load(delivery_site)
    _, mirror_html, mirror_raw, error_b = _load(mirror_site)
    if error_a or error_b:
        return {"passed": False, "checks": [{"name": "两份产物可比较", "ok": False,
                                             "detail": "; ".join(filter(None, [error_a, error_b]))}]}
    stripped = MARKER_TAG_BYTES.sub(b"", delivery_raw)
    same = stripped == mirror_raw
    delta = len(delivery_raw) - len(mirror_raw)
    return {"passed": same, "checks": [{
        "name": "交付与镜像只差 api-base 标记",
        "ok": same,
        "detail": ("交付 %d B / 镜像 %d B（差 %d B，剥掉标记后逐字节一致）"
                   % (len(delivery_raw), len(mirror_raw), delta)) if same else
                  ("剥掉标记后仍不一致：交付 %d B / 镜像 %d B（差 %d B）—— "
                   "两张产物不是同一次构建，别拿它们互相比对"
                   % (len(delivery_raw), len(mirror_raw), delta))}]}


# ---------------------------------------------------------------------------
# 门禁自己的诚实性测试
#
# 照 `tools/mobile/check_evidence_gate.py` 的先例：只测「好输入能过」的门禁等于橡皮章
# （见交接文档 §11.4「假绿灯」清单）。这里喂它各种**错形态**，每一种都必须被拦下。
# ---------------------------------------------------------------------------
FIXTURE_HEAD = ('<head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; '
                'connect-src \'self\' blob:; object-src \'none\';"><title>t</title></head><body>x</body>')


def _write_site(directory, html, build_info=True):
    """造一个最小产物：index.html（+ 默认补一份版本正确的 build-info.json）。

    交付产物**必须**带 build-info.json（打包脚本与 nginx 都依赖它），所以夹具默认也给一份，
    否则测的就不是"正常交付"，而是"缺文件的交付"。
    """
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "index.html").write_text(html, "utf-8", newline="\n")
    if build_info:
        version = json.loads((ROOT / "browser/package.json").read_text("utf-8"))["version"]
        (directory / "build-info.json").write_text(
            json.dumps({"browser_version": version}), "utf-8")
    return directory


def self_test():
    """返回 (是否全部符合预期, [每条用例的结果])。"""
    results = []

    def case(name, expected, actual, note=""):
        results.append({"case": name, "expected": expected, "actual": actual,
                        "ok": expected == actual, "note": note})

    workdir = Path(tempfile.mkdtemp(prefix="verify-delivery-selftest-"))
    try:
        mirror_html = FIXTURE_HEAD
        delivery_html = mirror_html.replace("<head>", "<head>" + SAME_ORIGIN_META)
        mirror = _write_site(workdir / "mirror", mirror_html)
        delivery = _write_site(workdir / "delivery", delivery_html)

        # ① 正常交付 → 必须过
        case("交付构建带同源标记", True, check_delivery(delivery)["passed"])
        # ② 正常镜像 → 必须过
        case("镜像构建不带标记", True, check_mirror(mirror)["passed"])
        # ③ 一对正常的产物 → 只差 42 字节
        pair = check_pair(delivery, mirror)
        case("交付与镜像只差 42 字节", True, pair["passed"],
             pair["checks"][0]["detail"])
        case("差值实测为 42 字节", 42, len(delivery_html.encode()) - len(mirror_html.encode()))

        # ④ 把镜像那份当交付发 → 必须拦下（这正是 2026-10-05 的事故形态）
        case("镜像构建冒充交付 → 拦下", False, check_delivery(mirror)["passed"])
        # ⑤ 交付那份混进镜像站 → 必须拦下
        case("交付构建混进镜像 → 拦下", False, check_mirror(delivery)["passed"])

        # ⑥ 绝对地址（跨源）→ 必须拦下，且**不得回显**那个地址
        secret = "https://example.invalid"
        absolute = delivery_html.replace(SAME_ORIGIN_META,
                                         '<meta name="ournotes-api-base" content="%s">' % secret)
        absolute_dir = _write_site(workdir / "absolute", absolute)
        verdict = check_delivery(absolute_dir)
        case("绝对地址标记 → 拦下", False, verdict["passed"])
        leaked = secret in json.dumps(verdict, ensure_ascii=False)
        case("绝对地址不回显（红线 1）", False, leaked)

        # ⑦ 标记出现两次 → 必须拦下
        twice = delivery_html.replace("<head>", "<head>" + SAME_ORIGIN_META)
        case("标记重复 → 拦下", False, check_delivery(_write_site(workdir / "twice", twice))["passed"])

        # ⑧ 跨源时 CSP 被放行 → 必须拦下
        widened = delivery_html.replace("connect-src 'self' blob:;",
                                        "connect-src 'self' blob: %s;" % secret)
        case("CSP 被跨源放行 → 拦下",
             False, check_delivery(_write_site(workdir / "widened", widened))["passed"])

        # ⑨ 两份产物不是同一次构建 → 必须拦下
        other = _write_site(workdir / "other", mirror_html.replace(">x<", ">y<"))
        case("两份产物不同源 → 拦下", False, check_pair(delivery, other)["passed"])

        # ⑩ 完全空目录 → 必须拦下（而不是默默 PASS）
        empty = workdir / "empty"
        empty.mkdir(parents=True, exist_ok=True)
        case("空目录 → 拦下", False, check_delivery(empty)["passed"])

        # ⑪ 缺 build-info.json → 必须拦下（打包脚本与 nginx 都依赖它）
        case("缺 build-info.json → 拦下", False,
             check_delivery(_write_site(workdir / "noinfo", delivery_html, build_info=False))["passed"])

        # ⑫ 版本对不上 → 必须拦下（避免把上一版的产物当成这一版发出去）
        stale = _write_site(workdir / "stale", delivery_html)
        (stale / "build-info.json").write_text(
            json.dumps({"browser_version": "0.0.0-stale"}), "utf-8")
        case("版本与源码不一致 → 拦下", False, check_delivery(stale)["passed"])
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    return all(item["ok"] for item in results), results


def _print(result, indent="  "):
    for item in result.get("checks", []):
        print("%s%s %s" % (indent, "OK  " if item["ok"] else "FAIL", item["name"]), flush=True)
        if item.get("detail"):
            print("%s     %s" % (indent, item["detail"]), flush=True)


def main():
    # 被管道/文件捕获时（CI、run_checks.py、给协作方贴证据）强制 UTF-8：
    # 否则 Windows PowerShell 5.1 下 Python 会按本地代码页 GBK 编码，中文全成乱码。
    # 交互式控制台保持原生行为，不碰。
    if not sys.stdout.isatty():
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:                                           # noqa: BLE001
            pass
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--delivery", type=Path, default=ROOT / "browser/dist",
                        help="交付构建目录（默认 browser/dist）")
    parser.add_argument("--mirror", type=Path, default=ROOT / "docs",
                        help="公开镜像目录（默认 docs）")
    parser.add_argument("--no-mirror", action="store_true", help="只查交付那一份")
    parser.add_argument("--no-pair", action="store_true", help="不比对两份产物的差异")
    parser.add_argument("--structural", action="store_true",
                        help="再叠一遍 verify_release 的结构化校验（含运行时包与静态资源哈希）")
    parser.add_argument("--self-test", action="store_true", help="只跑门禁自己的诚实性测试")
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    args = parser.parse_args()

    if args.self_test:
        passed, results = self_test()
        for item in results:
            print("%s %-28s 期望=%s 实际=%s%s" % (
                "OK  " if item["ok"] else "FAIL", item["case"], item["expected"], item["actual"],
                ("  " + item["note"]) if item["note"] else ""), flush=True)
        print("\n%s 诚实性测试（%d 条）" % ("PASS" if passed else "FAIL", len(results)), flush=True)
        return 0 if passed else 1

    report = {"delivery": check_delivery(args.delivery)}
    if not args.no_mirror:
        report["mirror"] = check_mirror(args.mirror)
        if not args.no_pair:
            report["pair"] = check_pair(args.delivery, args.mirror)
    if args.structural:
        sys.path.insert(0, str(ROOT / "tools"))
        from verify_release import verify
        try:
            report["structural"] = {"passed": True, "result": verify(args.delivery, expect_api_base=True)}
        except Exception as error:                                  # noqa: BLE001
            report["structural"] = {"passed": False, "detail": str(error)}
    report["passed"] = all(section.get("passed") for key, section in report.items()
                           if isinstance(section, dict) and "passed" in section)

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print("交付构建（正式站，必须带同源标记）：%s" % report["delivery"]["site"], flush=True)
        _print(report["delivery"])
        if "mirror" in report:
            print("公开镜像（必须不带）：%s" % report["mirror"]["site"], flush=True)
            _print(report["mirror"])
        if "pair" in report:
            print("两份产物的关系：", flush=True)
            _print(report["pair"])
        if "structural" in report:
            print("结构化校验（verify_release）：", flush=True)
            print("  %s %s" % ("OK  " if report["structural"]["passed"] else "FAIL",
                               report["structural"].get("detail")
                               or json.dumps(report["structural"]["result"], ensure_ascii=False)),
                  flush=True)
        print("\n%s 交付护栏" % ("PASS" if report["passed"] else "FAIL"), flush=True)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
