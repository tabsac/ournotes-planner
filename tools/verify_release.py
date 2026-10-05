"""Verify that a static site contains exactly generated public assets."""
from pathlib import Path
import argparse
import hashlib
import json
import re
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def verify(site, expect_api_base=False):
    site = Path(site).resolve()
    config = json.loads((ROOT / "browser/upstream.json").read_text("utf-8"))
    package = json.loads((ROOT / "browser/package.json").read_text("utf-8"))
    info = json.loads((site / "build-info.json").read_text("utf-8"))
    archive = ROOT / "browser/upstream" / config["archive"]
    if hashlib.sha256(archive.read_bytes()).hexdigest() != config["sha256"]:
        raise ValueError("Public baseline SHA-256 mismatch")
    if (info["browser_version"], info["core_version"], info["public_source_sha256"]) != (package["version"], config["version"], config["sha256"]):
        raise ValueError("Site version or baseline differs from source")
    files = {p.relative_to(site).as_posix(): p for p in site.rglob("*") if p.is_file()}
    for name, digest in info["static_files"].items():
        if name not in files or hashlib.sha256(files[name].read_bytes()).hexdigest() != digest:
            raise ValueError(f"Static asset missing or modified: {name}")
    extra = set(files) - set(info["static_files"]) - {"index.html", "build-info.json"}
    if any(not re.fullmatch(r"assets/[A-Za-z0-9_-]+\.(js|css|wasm)", name) for name in extra):
        raise ValueError(f"Unexpected static files: {sorted(extra)}")
    forbidden = ("player_growth_observations", "party_sample", "challenge_receipt", "ui-exported", ".sqlite", ".env")
    runtime = site / "planner-runtime.zip"
    if hashlib.sha256(runtime.read_bytes()).hexdigest() != info["runtime_sha256"]:
        raise ValueError("Runtime archive SHA-256 mismatch")
    with zipfile.ZipFile(runtime) as payload:
        if payload.testzip() is not None or sorted(payload.namelist()) != sorted(info["payload_files"]):
            raise ValueError("Runtime payload differs from manifest")
        if any(word in name for name in payload.namelist() for word in forbidden):
            raise ValueError("Private state path in runtime")
        for name in ("browser_runtime.py", "cp_model.py"):
            if payload.read(name) != (ROOT / "browser" / name).read_bytes():
                raise ValueError("Runtime contains an outdated browser adapter")
    if any(word in name for name in files for word in forbidden):
        raise ValueError("Private state path in site")
    if any(p.stat().st_size >= 100 * 1024 * 1024 for p in files.values()):
        raise ValueError("A static file exceeds GitHub's individual file limit")
    html = (site / "index.html").read_text("utf-8")
    # 两种产物在 api-base 标记上**互为反面**，所以由调用方声明手里这份是哪一种。
    #
    # expect_api_base=False（默认；`docs/` 公开镜像站）：**必须不带**。
    #   * 带绝对地址 → 等于把服务器地址写进公开仓库（红线 §0.1）；
    #   * 即使是空串（同源）：镜像站上没有 `/api`，带上它只会让云端面板去打必然 404 的
    #     同源接口，体验更糟。
    #
    # expect_api_base=True（正式站交付构建）：**必须带**，且必须是逐字的同源空串。
    #   这一侧以前**没有任何地方断言**，正是 2026-10-05 事故的成因：镜像构建发到正式站 →
    #   页面读不到这个 meta → `apiBase()` 为 null → 云端功能静默失效（零 `/api` 请求）、
    #   从部署那一刻起就是坏的。两份产物唯一差异就是这 42 字节（13968 ↔ 13926 B）。
    #   构建期与打包期由 `tools/verify_delivery.py` 双向把住（它还比对两份产物只差这 42 字节）。
    same_origin = '<meta name="ournotes-api-base" content="">'
    if expect_api_base:
        if same_origin not in html:
            raise ValueError(
                "Delivery build must carry exactly %s (same origin). Build it with "
                'browser/api-config.local.json = {"apiBase": ""}; a mirror build shipped to the '
                "real site makes the cloud features fail silently (not one /api request)."
                % same_origin)
    elif "ournotes-api-base" in html:
        raise ValueError("Published site must be built WITHOUT browser/api-config.local.json "
                         "(found an ournotes-api-base meta tag)")
    for relative in re.findall(r'(?:src|href)="(\./assets/[^\"]+)"', html):
        if not (site / relative).is_file():
            raise ValueError(f"Missing entry asset: {relative}")
    return {"passed": True, "browser_version": info["browser_version"], "core_version": info["core_version"],
            "runtime_sha256": info["runtime_sha256"], "static_files": len(files),
            "static_bytes": sum(p.stat().st_size for p in files.values())}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--site", type=Path, default=ROOT / "docs")
    parser.add_argument("--expect-api-base", action="store_true",
                        help="这份是**正式站交付构建**：必须带同源 api-base 标记（默认按公开镜像查，必须不带）")
    args = parser.parse_args()
    # 从命令行跑时给一行干净的 FAIL，而不是 traceback（`verify()` 本身仍然抛异常，
    # 供 package_release.py / publish_site.py 这些调用方按老样子捕获）。
    try:
        result = verify(args.site, expect_api_base=args.expect_api_base)
    except (ValueError, OSError) as error:
        print("FAIL %s: %s" % (args.site, error))
        raise SystemExit(1)
    print(json.dumps(result, ensure_ascii=False))
