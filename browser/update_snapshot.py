#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""一键更新配队网页的数据快照。

为什么要这个：配队程序的数据是**固定快照**（上游 zip 里的 research/<日期>/raw/*.json）。
游戏每次开新活动，加成角色/加成率就变了 —— 这一块是**纯 master data**，
可以从公开接口直接拉到，不需要抓包、不需要登录、不需要手机。

流程：
  1. 问公开 gRPC 接口要 resourceVersion（5 字节空帧，无需登录）
  2. 下载 MasterManifest.json（明文），拿到每张表的 {name, hash, size}
  3. 跟本地 snapshot-override/index.json 里记录的 hash 比对 —— 只下载真正变了的
  4. .bin → Rijndael-256-CBC 解密 → gzip → JSON，写进 snapshot-override/<快照目录>/
  5. 记下新 hash，下次就能跳过

build_browser.py 会自动把 snapshot-override/ 覆盖到上游 zip 的同名文件上，
所以刷完重跑构建即可，**不必改上游 zip**（那个 zip 带 sha256 校验，是刻意设的保护）。

用法：
    python update_snapshot.py                 只报告哪些表变了
    python update_snapshot.py --apply         下载并写入 snapshot-override/
    python update_snapshot.py --apply --build 顺带重跑构建
    python update_snapshot.py --apply --force 无视 hash，全部重下
"""
import argparse
import base64
import gzip
import json
import os
import json
import os
import re
import struct
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
# Windows 控制台默认 GBK，中文脚本里带 ✓/✗ 这类字符会 UnicodeEncodeError
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
from rijndael import Rijndael  # noqa: E402

API_HOST = "https://l14-prod-hk-all-gs-sirius.gamerfusiontech.com"
BASE_ROOT = "https://l14-prod-hk-patch-sirius.gamerfusiontech.com/prod/hk_27f3c91e8b62d6056c7a19f2e83b6d10"
UA = "UnityPlayer/6000.3.12f1 (UnityWebRequest/1.0, libcurl/8.10.1-DEV)"


def _local_secret(name):
    """读取本机私密凭据。凭据不进仓库，按顺序找：

    ① 环境变量             OURNOTES_CDN_AUTH
    ② browser/secrets.local.json   （已被 .gitignore 挡住）

    以前这里把 CDN 的 Basic 凭据写死在常量里，仓库一公开就等于把凭据送出去了。
    """
    env = "OURNOTES_" + name.upper()
    v = os.environ.get(env)
    if v:
        return v.strip()
    f = HERE / "secrets.local.json"
    if f.exists():
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except Exception as e:
            raise SystemExit("%s 解析失败：%s" % (f, e))
        v = (data.get(name) or "").strip()
        if v:
            return v
    return None


# CDN 的 Basic 凭据：纯服务端凭据，只从环境变量/本机密文读，仓库里没有。
AUTH = _local_secret("cdn_auth")

# 账号包解密密钥。这个不是「秘密」：网页端 account-package.js 必须把它发给每个
# 访问者才能解密用户自己上传的账号包，所以它随构建产物本来就是公开的。
# 这里保留同一份，方便本地脚本解密账号包做自测。
KEY = bytes.fromhex("0532791c510a08eb7ede6b46c6ba71ea9aa2a3cfb678a595f89d67c8a5e493b6")

OVERRIDE = HERE / "snapshot-override"
INDEX = OVERRIDE / "index.json"


# ---------------------------------------------------------------- HTTP

def _get(url, auth=True, timeout=180):
    req = urllib.request.Request(url)
    req.add_header("User-Agent", UA)
    if auth:
        if not AUTH:
            raise SystemExit(
                "缺少 CDN 凭据，无法下载游戏资源。请任选一种方式配置：\n"
                "  ① 设环境变量  OURNOTES_CDN_AUTH=用户名:密码\n"
                "  ② 新建 browser/secrets.local.json，内容 {\"cdn_auth\": \"用户名:密码\"}\n"
                "（该文件已被 .gitignore 忽略，不会被提交。）"
            )
        req.add_header("Authorization", "Basic " + base64.b64encode(AUTH.encode()).decode())
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def grpc_body(raw):
    if len(raw) < 5:
        return raw
    flag, n = raw[0], struct.unpack(">I", raw[1:5])[0]
    body = raw[5:5 + n]
    return gzip.decompress(body) if flag else body


def proto_strings(buf):
    out, i = [], 0
    while i < len(buf):
        try:
            key = buf[i]; i += 1
            wt = key & 7
            if wt == 2:
                ln = buf[i]; i += 1
                if ln & 0x80:
                    shift, val = 7, ln & 0x7F
                    while True:
                        b = buf[i]; i += 1
                        val |= (b & 0x7F) << shift
                        if not (b & 0x80):
                            break
                        shift += 7
                    ln = val
                s = buf[i:i + ln]; i += ln
                try:
                    t = s.decode("utf-8")
                    if re.fullmatch(r"[\x20-\x7e]{3,80}", t):
                        out.append(t)
                except UnicodeDecodeError:
                    pass
            elif wt == 0:
                while buf[i] & 0x80:
                    i += 1
                i += 1
            elif wt == 5:
                i += 4
            elif wt == 1:
                i += 8
            else:
                break
        except IndexError:
            break
    return out


def fetch_version():
    raw = _post(VERSION_RPC_PATH)
    strings = proto_strings(grpc_body(raw))
    rv = next((s for s in strings if re.fullmatch(r"[0-9a-f]{16,64}", s)), None)
    cv = next((s for s in strings if re.fullmatch(r"\d+\.\d+\.\d+\.\d+", s)), None)
    if not rv:
        raise SystemExit("认不出 resourceVersion，响应 hex=%s" % raw.hex())
    return rv, cv


VERSION_RPC_PATH = "/app.masterdata.MasterdataService/Version"


def _post(path):
    req = urllib.request.Request(API_HOST + path, data=bytes([0, 0, 0, 0, 0]),
                                headers={"content-type": "application/grpc+proto",
                                         "grpc-accept-encoding": "identity,deflate,gzip"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


# ---------------------------------------------------------------- 解密

def pkcs7_strip(b, block=32):
    if not b:
        return b
    n = b[-1]
    if 1 <= n <= block and n <= len(b) and b[-n:] == bytes([n]) * n:
        return b[:-n]
    return b


def decrypt_master(raw):
    """master .bin = 64 字节头(A1‖IV) + Rijndael-256-CBC + PKCS#7 + gzip → JSON"""
    if len(raw) < 96:
        raise ValueError("文件太小（%d 字节）" % len(raw))
    iv, body = raw[32:64], raw[64:]
    if len(body) % 32:
        raise ValueError("体长度不是 32 的倍数（%d）" % len(body))
    plain = pkcs7_strip(Rijndael(KEY, 256).decrypt_cbc(body, iv))
    try:
        return json.loads(gzip.decompress(plain).decode("utf-8"))
    except Exception:
        return json.loads(plain.decode("utf-8"))


# ---------------------------------------------------------------- 基线

def update_manifest_hashes(src, prefix, dst_dir, resource_version, content_version):
    """同步刷新 source_manifest.json 里的逐表 sha256。

    配队程序启动时会校验（deck_power._snapshot）：
        entries = {row["local_path"]: row for row in manifest["files"]}
        if hashlib.sha256(payload).hexdigest() != entries[relative]["sha256"]: raise
    所以只换 raw/*.json 而不更新哈希，应用会直接拒绝加载 —— 这是它故意的完整性保护，
    不是我们要绕过的障碍：数据换了，记录的哈希就该跟着换。
    返回 (更新了哪些表, manifest 写到哪)。
    """
    import hashlib
    # prefix 形如 research/2026-10-01/raw/，而 source_manifest.json 在它的上一级
    snap_dir = prefix.rsplit("raw/", 1)[0]
    man_rel = snap_dir + "source_manifest.json"
    override_man = OVERRIDE.joinpath(*man_rel.split("/"))
    if override_man.is_file():
        manifest = json.loads(override_man.read_text("utf-8"))
    else:
        # zip 里的路径带顶层目录（OurNotes-配队程序-vX/），而 prefix 已经剥掉了它，
        # 所以这里按后缀找，不要拼路径。
        with zipfile.ZipFile(src) as z:
            hit = next((n for n in z.namelist() if n.endswith(man_rel)), None)
            if hit is None:
                raise SystemExit("zip 里找不到 %s" % man_rel)
            manifest = json.loads(z.read(hit).decode("utf-8"))

    by_path = {row["local_path"]: row for row in manifest["files"]}
    updated = []
    for p in sorted(dst_dir.glob("*.json")):
        rel = "raw/" + p.name
        row = by_path.get(rel)
        if row is None:
            continue
        payload = p.read_bytes()
        new_hash = hashlib.sha256(payload).hexdigest()
        # git 对象哈希 = sha1("blob <长度>\0" + 内容)。
        # 配队程序不只校验 sha256，research/manual_skill_contract.py 还校验这个
        # （Source Git blob mismatch），所以两个都得跟着更新。
        new_blob = hashlib.sha1(b"blob %d\0" % len(payload) + payload).hexdigest()
        changed = False
        if row.get("sha256") != new_hash:
            row["sha256"] = new_hash
            changed = True
        if "git_blob_sha" in row and row["git_blob_sha"] != new_blob:
            row["git_blob_sha"] = new_blob
            changed = True
        if "bytes" in row:
            row["bytes"] = len(payload)
        if changed:
            updated.append(p.stem)

    # 记录数据来源，免得以后分不清「这是上游快照」还是「我们刷的」
    manifest["browser_override"] = {
        "note": "raw 表由 update_snapshot.py 从官方 master 服务器刷新，sha256 已同步更新",
        "resource_version": resource_version,
        "content_version": content_version,
        "tables": len(list(dst_dir.glob("*.json"))),
    }
    override_man.parent.mkdir(parents=True, exist_ok=True)
    override_man.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), "utf-8", newline="\n")
    return updated, override_man


def upstream_baseline():
    """上游 zip 里的快照目录前缀 + 它包含的表名集合。"""
    up = json.loads((HERE / "upstream.json").read_text("utf-8"))
    src = HERE / "upstream" / up["archive"]
    if not src.is_file():
        src = ROOT / up["archive"]
    if not src.is_file():
        raise SystemExit("找不到上游 zip：%s" % src)
    with zipfile.ZipFile(src) as z:
        names = [n for n in z.namelist() if re.search(r"/raw/Master\w+\.json$", n)]
    prefix = re.match(r"(.*?/raw/)", names[0]).group(1).split("/", 1)[1]
    tables = sorted(os.path.basename(n)[:-5] for n in names)
    return src, prefix, tables


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="真的下载并写入 snapshot-override/")
    ap.add_argument("--build", action="store_true", help="写完顺带重跑构建")
    ap.add_argument("--force", action="store_true", help="无视本地 hash，全部重下")
    args = ap.parse_args()

    print("== 1. resourceVersion（公开接口，无需登录）==")
    rv, cv = fetch_version()
    print("   resourceVersion = %s" % rv)
    print("   contentVersion  = %s" % cv)

    print("\n== 2. MasterManifest.json ==")
    manifest = json.loads(_get("%s/master/%s/MasterManifest.json" % (BASE_ROOT, rv)).decode("utf-8"))
    files = manifest.get("files") or []
    remote = {}
    for f in files:
        nm = f.get("name") or ""
        if nm.startswith("Master") and nm.endswith(".bin"):
            remote[nm[:-4]] = f
    print("   manifest %d 个文件，其中 Master 表 %d 张" % (len(files), len(remote)))

    src, prefix, base_tables = upstream_baseline()
    base_tables = sorted(set(base_tables) | {"MasterVip", "MasterArenaMusic", "MasterMemoryMusicGroup", "MasterMemoryMusic", "MasterLiveJudgementTiming"})
    print("   当前快照：%s（%d 张表）" % (prefix, len(base_tables)))

    idx = {}
    if INDEX.is_file():
        try:
            idx = json.loads(INDEX.read_text("utf-8"))
        except Exception:
            idx = {}
    seen = idx.get("tables") or {}
    print("   上次同步：%s（记了 %d 张表的 hash）" % (idx.get("version") or "无", len(seen)))

    print("\n== 3. 比对（按 manifest 的 hash，只下真正变了的）==")
    todo, unchanged, not_remote = [], [], []
    for t in base_tables:
        f = remote.get(t)
        if not f:
            not_remote.append(t)
            continue
        if not args.force and seen.get(t) == f.get("hash"):
            unchanged.append(t)
        else:
            todo.append((t, f))

    print("   未变 %d 张" % len(unchanged))
    print("   需下载 %d 张：" % len(todo))
    for t, f in todo[:40]:
        print("      %-46s %8s 字节" % (t, f.get("size")))
    if len(todo) > 40:
        print("      …还有 %d 张" % (len(todo) - 40))
    if not_remote:
        print("   快照里有、远端清单没有 %d 张：%s" % (len(not_remote), not_remote[:20]))
    only_remote = sorted(set(remote) - set(base_tables))
    if only_remote:
        print("   远端有、当前快照没用到的 %d 张（配队程序暂不读，仅供了解）：%s"
              % (len(only_remote), only_remote[:20]))

    if not args.apply:
        print("\n（只报告。要真的下载并写入，加 --apply）")
        return 0

    if not todo:
        print("\n没有需要下载的表 —— 已经是最新。")
    else:
        print("\n== 4. 下载 + 解密 + 写入 ==")
        dst = OVERRIDE.joinpath(*prefix.split("/"))
        dst.mkdir(parents=True, exist_ok=True)
        ok = fail = 0
        for t, f in todo:
            url = "%s/master/%s/%s" % (BASE_ROOT, rv, f["name"])
            try:
                obj = decrypt_master(_get(url))
                rows = obj.get("_allData", obj) if isinstance(obj, dict) else obj
                (dst / (t + ".json")).write_text(json.dumps(obj, ensure_ascii=False, indent=1), "utf-8", newline="\n")
                seen[t] = f.get("hash")
                ok += 1
                print("   [OK] %-46s %6d 条" % (t, len(rows) if hasattr(rows, "__len__") else 0))
            except Exception as e:
                fail += 1
                print("   [X]  %-46s %s: %s" % (t, type(e).__name__, str(e)[:90]))
        print("   成功 %d，失败 %d" % (ok, fail))

    # 关键：同步刷新 source_manifest.json 的哈希，否则配队程序会拒绝加载
    dst_dir = OVERRIDE.joinpath(*prefix.split("/"))
    if dst_dir.is_dir():
        updated, man_path = update_manifest_hashes(src, prefix, dst_dir, rv, cv)
        print("\n== 4b. 同步 source_manifest.json 的哈希 ==")
        print("   更新了 %d 张表的 sha256" % len(updated))
        print("   写回：%s" % man_path)
        if not updated:
            print("   （没有变化 —— 可能哈希本来就对）")
    else:
        print("\n   ！覆盖目录不存在，跳过哈希同步")

    # 记 hash：只记真正写到磁盘上的那些表，避免「下载失败也记了 hash」导致下次跳过
    dst_dir = OVERRIDE.joinpath(*prefix.split("/"))
    written = {p.stem for p in dst_dir.glob("*.json")} if dst_dir.is_dir() else set()
    table_map = {t: h for t, h in seen.items() if t in written}
    INDEX.write_text(json.dumps({"version": rv, "content_version": cv,
                                 "snapshot_prefix": prefix, "tables": table_map},
                                ensure_ascii=False, indent=1, sort_keys=True), "utf-8", newline="\n")
    print("   覆盖目录：%s（%d 张）" % (dst_dir, len(written)))
    print("   索引：%s（记了 %d 张的 hash）" % (INDEX, len(table_map)))

    if args.build:
        print("\n== 5. 重新构建 ==")
        subprocess.run([sys.executable, "-B", str(HERE / "build_browser.py"), "--build"],
                       cwd=str(HERE), check=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
