# 真机（手机自带浏览器）验证工具链

这里的脚本用来回答一个**桌面验不出来**的问题：

> 手机自带浏览器拿不到跨源隔离、没有 `SharedArrayBuffer`，我们的配队搜索还能不能跑完，
> 结果与原生 oracle 是不是**逐条一致**？

跑完一次会产出两样东西：

| 产出 | 位置 | 说明 |
|---|---|---|
| 原始结果 + 进度轨迹 | `work/mobile/`（已 gitignore） | `result-<fixture>.json` / `watch-<fixture>.jsonl` |
| **入库凭据** | `browser/tests/mobile-verification.json` | 给 `tools/run_checks.py` 读，决定 `real_mobile_device_verified` |

`tools/run_checks.py` 里的 `real_mobile_device_verified` **不是写死的**：它读上面那份凭据，
并且要求凭据里的 `app.browser_version` 与当前 `browser/package.json` 一致 —— 改了版本，旧凭据自动失效。

## 为什么需要一个「凭据」，而不是在 CI 里跑

CI 上没有手机（也没有能装 X 浏览器/WebView 的宿主），所以真机这件事没法在流水线上诚实表达。
凭据就是把「有人在真机上跑过、并且逐条比对通过」这件事**固化成一个可审阅的文件**：
谁都能看它验的是哪台机器、什么浏览器、什么版本、哪些用例、比对的原文是什么。

凭据只由 `make_mobile_evidence.py` 生成，而它**只认真实跑出来的结果文件**：
任何一个用例 `compare.js` 比不过，`verified` 就是 `false`。设备/浏览器/环境事实都必须显式传参，没有默认值 ——
不给「忘了填就当成验过」的机会。

## 复现步骤

前置：一台开了 adb 调试的手机（或云手机），手机上装了会用**系统 WebView** 的浏览器。
本仓库验证过的是 Android 11 + WebView 124 + X 浏览器（`com.mmbox.xbrowser`）。

```powershell
# 0. 起一个**不发跨源隔离头**的静态服务（这正是要复现的环境）
python -u tools/mobile/server.py --port 8899          # 服务 <repo>/browser/dist

# 1. 一条命令跑完「导入 → 计算 → 导出 → 与原生 oracle 逐条比」
$env:MOBILE_SERIAL = '103.36.194.17:495'              # 或 emulator-5554
& tools/mobile/driver.ps1 -Steps 'watch.js solver-ap','compare.js solver-ap'

# 2. 验「求解期间『已等待 N 秒』没有冻住」（第 14 轮的修复，桌面验不出来）
python tools/mobile/elapsed_trace.py work/mobile/watch-solver-ap.jsonl

# 3. 验取消通道 + 取消后重跑（结果会与 oracle 再比一次）
& tools/mobile/driver.ps1 -Steps 'cancel_test.js solver-ap','compare.js solver-ap work/mobile/result-after-cancel-solver-ap.json'

# 4. 生成入库凭据（compare 不过就不给 verified）
python tools/mobile/make_mobile_evidence.py `
  --serial $env:MOBILE_SERIAL --model PCHM30 --android 11 --sdk 30 `
  --webview 124.0.6367.179 --browser-package com.mmbox.xbrowser `
  --cross-origin-isolated false --shared-array-buffer false --navigator-locks true `
  --case solver-ap --cancel-result result-after-cancel-solver-ap.json

# 5. 全量验收（会读到第 4 步的凭据）
python -B tools/run_checks.py
```

## 文件一览

| 文件 | 作用 |
|---|---|
| `driver.ps1` | 一体化驱动：连接设备 → 建 reverse/forward → 打开应用页 → 依次跑步骤。隧道由本进程持有，另有 watchdog 每 3 秒补 |
| `watch.js` | 走应用自己的路径「塞 `#import` → 点 `#calculate` → 等 `#results` → 导出」，并抓页面 + 所有 Worker 的 console/异常 |
| `compare.js` | 真机导出结果 vs 原生 oracle，判据与 `browser/tests/check_browser.cjs` 的 `compare()` 一致 |
| `cancel_test.js` | 取消通道 + 取消后重跑（顺带验证取消结果没进缓存） |
| `cdp.js` | 裸 CDP 小工具（`dump` / `eval` / `listen` / `reload`） |
| `cdp_probe.js` | 分层探针：`/json` → WebSocket 握手 → 浏览器进程命令 → 渲染器命令，用来判断「卡在哪一层」 |
| `ws_probe.js` | 手工发 Upgrade、把服务端回的状态行/响应头原样打出来 |
| `elapsed_trace.py` | 分析进度轨迹，判「同一阶段里秒数是否在推进」 |
| `make_mobile_evidence.py` | 把一次真机跑动的产出整理成 `browser/tests/mobile-verification.json` |
| `check_evidence_gate.py` | 门禁诚实性小测：正常 / 版本不符 / 自称未通过 / 缺文件，四种情况各应得到什么 |
| `server.py` | 不发隔离头的静态服务（复现手机自带浏览器的环境） |
| `coi_server.py` | 发真 COOP/COEP 的对照服务，用来单独验证「这个浏览器到底能不能隔离」 |

## 环境等价性：别把「代码相同」当成「环境相同」

`browser/dist` 与线上 `docs/` 可以逐字节相同，但那**只说明代码一样**，
不说明**服务环境**一样 —— 而这件事的关键恰恰在环境上：

- 拿得到跨源隔离 → 有 `SharedArrayBuffer` → 走老路径；
- 拿不到 → 只能走本轮改造出来的无 SAB 路径。

真正让「本地验收 == 线上验收」成立的，是**两边都不发 COOP/COEP、都不是隔离环境**：

| 环境 | 跨源隔离 | 有无 SAB |
|---|---|---|
| `http://localhost:8899`（`server.py`） | 否 | 无 |
| `https://tabsac.github.io/ournotes-planner/`（GitHub Pages） | 否 | 无 |

所以正确的说法是「**两者都不隔离，所以验收条件等价**」。
逐字节相同是另一条（更弱的）保证：它只保证跑的是同一份代码。
**换托管、上 HTTPS 反代、或者哪天给页面加上 COOP/COEP，这个等价性就没了** ——
那时必须重新确认环境事实（`cdp.js dump` 会把 `crossOriginIsolated` / `typeof SharedArrayBuffer` 打出来）。

## 踩过的坑（省下一次）

1. **反诈弹窗**：X 浏览器首次打开会弹「防止诈骗提醒」模态框。它挡住页面，而且会让 devtools
   **完全不应答**（`/json` 一直超时）。用 `uiautomator dump` 读真实 bounds 再点，别拿截图估坐标。
2. **别用 BACK 关弹条**：用 `keyevent BACK` 关「5 星好评」弹条会让 WebView 的 page target 换掉，
   紧接着 `ws error`。
3. **`adb forward --remove-all` 会掐断正在用的连接**：watchdog 补隧道时只能「缺了再加」，
   绝不能先 remove-all —— 否则 CDP 的 WebSocket 会「连上之后每条命令都超时」。
4. **手机侧 `curl` 不能当隧道健康探针**：应用正通过**同一条 reverse 隧道**下载十几 MB 的 wasm，
   探针要么排在后面超时、要么被饿死返回 `000`，全是误报。反向隧道通不通，看应用能不能 boot 出来最准。
5. **云手机会周期性掉线**（`device offline`），一掉线 forward/reverse 全没，页面会显示
   「网页未能加载: Failed to fetch」。所以 `watch.js` 发现加载失败就整页重来（最多 4 次）。
6. **`Runtime.enable` / `Log.enable` 会重放历史 console**，时间戳是接收时间 ——
   必须等 `Page.reload` 之后再开始记录，否则会把上一轮的报错误当成这一轮的。
7. **同一台手机上别同时跑两个驱动**：残留的 `watch.js` 会不停 reload 页面，
   让别的 CDP 会话里每条命令都超时（这个假象很容易被当成「渲染器卡死」）。
