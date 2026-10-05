"""构建摘要：给「真机验证凭据」钉一个**能分辨构建**的指纹。

为什么需要它（2026-10-05 亲历）：凭据门禁原来只比 `browser_version`，而当天在**同一个 0.3.2**
下改了三次构建（运行期数据补谱面、JS 缓存键、APK）。于是凌晨那份 `verified=true` 的凭据
继续冒充「线上这份构建验过了」—— 版本号对得上，谁也不会发现它其实指的是 11:xx 那份。

摘要取 dist 的 `build-info.json` 里两样最硬的东西：
  * `runtime_sha256` —— 运行期数据（谱面/运行时包）的内容哈希；
  * `manifest_sha256` —— `static_files`（所有静态文件的路径 → 内容哈希）规范化后的哈希，
    代码和数据**任何一处改动**都会让它变。

两个脚本共用这一个实现，免得两边算法悄悄分叉：
  * 生产者 `make_mobile_evidence.py` 把摘要写进凭据；
  * 消费者 `tools/run_checks.py` 用当前 dist 重算摘要并比对。
"""
from hashlib import sha256
import json


def build_digest(build_info):
    """从 build-info.json 的内容算出构建摘要（纯函数，输入相同则输出相同）。"""
    files = (build_info or {}).get("static_files") or {}
    # 规范化：键排序 + 固定分隔符，行尾/空格差异不会造成假的不一致
    blob = json.dumps(sorted(files.items()), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return {
        "runtime_sha256": (build_info or {}).get("runtime_sha256"),
        "manifest_sha256": sha256(blob).hexdigest(),
        "static_file_count": len(files),
    }


def describe(digest):
    """给日志用的一行人话。"""
    digest = digest or {}
    return (f"runtime={str(digest.get('runtime_sha256'))[:16]}… "
            f"manifest={str(digest.get('manifest_sha256'))[:16]}… "
            f"files={digest.get('static_file_count')}")
