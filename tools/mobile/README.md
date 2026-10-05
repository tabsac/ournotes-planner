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
#    第三个参数按 work/mobile/ 解析；driver 的 cwd 是 tools/mobile，别写仓库相对路径
#    ⚠️ 必须清缓存：否则会命中续算缓存、8 秒算完，用例直接报「还没点取消就结束了」
$env:MOBILE_CLEAR_STORAGE = '1'
& tools/mobile/driver.ps1 -Steps 'cancel_test.js solver-ap','compare.js solver-ap result-after-cancel-solver-ap.json'
Remove-Item Env:\MOBILE_CLEAR_STORAGE

# 3b. 换一个 fixture（另一个被上游路由给求解器的用例）
& tools/mobile/driver.ps1 -Steps 'watch.js solver-mixed-rounding','compare.js solver-mixed-rounding'

# 4. 导出到底有没有真的落盘（设计笔记 2j① / 2j②）
#    设备侧的取证必须走 `adb` 步骤 —— 隧道在本进程手里，别的 shell 里敲 adb 会把它弄没
#    `-Reopen` 先重启浏览器：手机上一个用例跑完就多一个同 URL 的 page target，
#    攒到 4~5 个时驱动很容易连到「后台那个」，而在后台页面上点导出**不算数**（见第 13 条坑）
& tools/mobile/driver.ps1 -Reopen -Steps `
    'adb shell ls -la /sdcard/Download/', `
    'download_test.js solver-ap', `
    'adb shell ls -la /sdcard/Download/', `
    'adb shell find /sdcard -name *OurNotes*'

# 5. 生成入库凭据（compare 不过就不给 verified）
python tools/mobile/make_mobile_evidence.py `
  --serial $env:MOBILE_SERIAL --model PCHM30 --android 11 --sdk 30 `
  --webview 124.0.6367.179 --browser-package com.mmbox.xbrowser `
  --cross-origin-isolated false --shared-array-buffer false --navigator-locks true `
  --case solver-ap --case solver-mixed-rounding `
  --cancel-result result-after-cancel-solver-ap.json

# 5b. 门禁诚实性小测（换了凭据就顺带跑一次；它从 package.json 读当前版本，别写死）
python tools/mobile/check_evidence_gate.py

# 6. 全量验收（会读到第 5 步的凭据）
python -B tools/run_checks.py
```

## 环境开关（都用环境变量，不用改脚本）

| 变量 | 作用 |
|---|---|
| `MOBILE_SERIAL` | adb 串号；也可以给 `driver.ps1 -Serial` |
| `MOBILE_OUT_DIR` | 产出目录（默认 `<repo>/work/mobile`）；`driver.ps1` 会自己设好并传给 node |
| `CDP_PORT` | devtools 转发端口（默认 9222），由 `driver.ps1` 设置 |
| `MOBILE_CLEAR_STORAGE=1` | **每次 boot 前清空该源的全部存储**（IndexedDB 卡库 + 续算缓存 + Cache Storage）。要验「搜索本身能跑」就必须开；不开就会命中缓存，8 秒出结果（假绿灯） |
| `MOBILE_FIXTURES` | 指定 fixture 目录，覆盖默认的 `work/validation` → `browser/work/fixtures` 查找顺序 |
| `WATCH_URL` | 应用地址（默认 `http://localhost:8899/ournotes-planner/`）；`driver.ps1 -Url` 会自动把它设成同一个值 |
| `WATCH_NO_RELOAD=1` | 不 reload，直接连现在的页面（调试用） |
| `MOBILE_RELOAD_BYPASS_CACHE=1` | reload 时**绕过 HTTP 缓存**（`ignoreCache:true`）。默认**不绕过**——理由见坑 27：一次冷启动要下 ~27 MB，绕过缓存等于每次 reload 重下一遍，窄链路下永远下不完。要验冷启动/资源新鲜度时才开 |
| `MOBILE_JSON_TRIES` | `/json` 的重试次数（默认 240 次 × 2.5 秒 = 10 分钟），见坑 26 |
| `DOWNLOAD_WAIT_MS` | `download_test.js` 点了导出之后等多久看反应（默认 20000） |

`driver.ps1` 的开关：`-Reopen`（先强杀浏览器再起来，**用例之间建议开**，见坑 13）、
`-Offline`（不重建隧道，调试用）、`-StepRetries`（node 步骤失败后重试几次，默认 1；重试前会硬刷隧道）、
`-WebPort` / `-CdpPort` / `-Url` / `-BrowserPkg` / `-BrowserAct`。

## 文件一览

| 文件 | 作用 |
|---|---|
| `driver.ps1` | 一体化驱动：连接设备 → 建 reverse/forward → 打开应用页 → 依次跑步骤。隧道由本进程持有，另有 watchdog 每 3 秒补。步骤除了 `xxx.js` 还支持 **`adb <参数...>`**（在持有隧道的本进程里敲一次 adb，用来做设备侧取证） |
| `app-client.js` | **共用的 CDP 客户端**（`watch.js` / `cancel_test.js` / `download_test.js` 都用它）：`/json`＋WS 重试、每条命令带超时、只读求值可重试 / 有副作用的动作只发一次、attach·reload·boot·导入·点计算轮询·导出。选 target 的逻辑也在这里（见下面第 8 条坑） |
| `watch.js` | 走应用自己的路径「塞 `#import` → 点 `#calculate` → 等 `#results` → 导出」，并抓页面 + 所有 Worker 的 console/异常 |
| `compare.js` | 真机导出结果 vs 原生 oracle，判据与 `browser/tests/check_browser.cjs` 的 `compare()` 一致。第三个参数可比对**指定**结果文件（相对路径按 `work/mobile/` 解析） |
| `cancel_test.js` | 取消通道 + 取消后重跑：**等进入「精确求解中…」再点取消**，等 `#message` 出现「计算已取消」，然后重跑一次完整计算；明细落 `work/mobile/cancel-<fixture>.json` |
| `download_test.js` | 导出落盘检查：**真点**一次导出（不拦 `URL.createObjectURL`、不改写任何东西），记录控制台/异常/CDP 下载事件；文件到底有没有落盘由前后的 `adb` 步骤回答 |
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
8. **同一台手机上可能有两个同 URL 的 page target**：实测 `/ournotes-planner/` 与
   `.../ournotes-planner/#plan` 同时存在。老写法「取第一个匹配的 target」可能连到那个
   空壳/后台的，于是「点了计算页面毫无反应」——看起来像应用坏了，其实是驱动连错了页面。
   `app-client.js` 的做法是**连上先探测**（`document.visibilityState` / 是否已 boot / 是否在算），
   前台可见或已 boot 的优先，都没有才退回第一个能连上的。
9. **`driver.ps1` 必须带 UTF-8 BOM**：本机的 `pwsh` 实际是 **Windows PowerShell 5.1**，
   没有 BOM 的脚本它会按 ANSI(GBK) 读 —— 中文注释被拆成乱码，紧接着就是语法错误
   （`函数参数列表中缺少"）"`）。用编辑器改完这个文件，**确认 BOM 还在**：
   `[System.IO.File]::ReadAllBytes($p)[0..2]` 应当是 `239,187,191`。
10. **`compare.js` 的第三个参数按 `work/mobile/` 解析**，不是按仓库根：驱动是
    `cwd=tools/mobile` 跑 node 的，写 `work/mobile/xxx.json` 会指向不存在的路径。
11. **`cancel_test.js` 原来那个等待条件本身是错的**（第 15 轮它没验成的一半原因）：
   它等「标题或提示里出现『取消』」，而点下取消的**那一刻**应用就把标题写成「正在取消…」，
    条件立刻满足 —— 于是它在什么结果都没等到的情况下继续往下跑
    （真机日志里正是「`resultsHidden=true` 但 message 为空」）。现在等的是终态
    `#message` 里的「计算已取消」；另外**必须先等应用 boot 完**再点计算，
    否则点下去根本没反应（第 15 轮的另一半原因）。
12. **「导出成功」不能只看页面 —— 必须看设备侧**：页面自己不会报错，
   下载是**浏览器**去做的。X 浏览器把下载挂在自己注入页面的脚本上
   （`downloadBlobUrl: fetch(blob:...)` → FileReader → `window.mbrowser.getBase64FromBlobData`），
   这一句 `fetch(blob:...)` 会被页面的 CSP `connect-src 'self'` 拒掉，随后
   `TypeError: Failed to fetch` —— **点了导出什么都不会发生**，而 Playwright 的
   download 事件、页面 DOM 全都正常。判据只能来自设备侧（`adb` 步骤列目录 / `find`），
   配合 `download_test.js` 记下的控制台与异常栈（它还会用 `Debugger.getScriptSource`
   把出错那段代码抓出来，证明**不是应用自己的代码**）。修复见 v0.1.3（`connect-src 'self' blob:`）。

13. **在后台页面上点导出不算数**：手机上一个用例跑完就多一个同 URL 的 page target，攒到 4~5 个时
    驱动很容易连到 `visible=hidden` 的那个**后台 WebView**。在后台页面上 `a.click()`，
    浏览器**根本不会走下载那条路** —— **既不报错也不落盘**，很容易被误读成「修好了」。
    `download_test.js` 现在把「必须连到前台可见的页面」写成硬前置（连不到就直接失败）；
    另外用例之间建议用 `driver.ps1 -Reopen`，从干净浏览器开始。
14. **续算缓存会让绿灯变成假的**：应用的 `search-v1.sqlite3` 存在 IndexedDB 里、跨刷新保留，
    于是「再跑一次」常常只是**复用缓存**（实测 8 秒出结果、计数里写着 `复用 2 项`）——
    那证明不了搜索本身能跑。要验搜索就 `MOBILE_CLEAR_STORAGE=1`。
    另外：CDP 的 `Storage.clearDataForOrigin`（`storageTypes:'all'`）在实测的这台手机上
    **什么都没清掉**，所以 `clearStorage()` 会清完再回头看一眼，还剩就自己用页面 API 删。
15. **换了构建之后必须处理 Service Worker**：资源文件名带哈希，SW 缓存里的 `index.html`
    指向新哈希而它手上没有 → 每个资源都 `net::ERR_FAILED`，页面永远 boot 不出来，
    而 DOM 层毫无线索（`#loadError` / `#message` 全是空的）。
    `bootOnce` 见到 `net::ERR_*` 且 60 秒没 boot 就整页重来。
    ⚠️ **但别默认 unregister SW**（只在 `MOBILE_CLEAR_SW=1` 时清）：实测只要 worker 是新装的，
    应用启动时那句 `await navigator.serviceWorker.ready` 就永远不 resolve，页面停死在
    「正在准备首次运行，页面会自动刷新一次…」—— 看起来像链路卡死，其实是注册流程卡住
    （v0.1.3 给 `ready` 补了 5 秒上限；默认不动 SW 仍然更稳）。
16. **fixture 从哪读**：优先 `work/validation/`（验收流水线 `run_checks.py` 生成的那份），
    其次 `browser/work/fixtures/`；实际用的是哪份会打进日志。以前硬写后者，
    两边一旦不同（实测只差 `elapsed_seconds` 这类字段）手机会**对着过期 oracle 比对**且毫无提示。
17. **X 浏览器注入脚本会刷屏**：每加载一次页面就几百行 `auto fill` / `extract text content`，
    把 CSP 报错和异常全埋掉。`app-client.js` 只滤它那几类固定噪音，应用自己的日志照旧。
18. **链路差的时候别指望一轮跑完三个用例**：实测云手机对宿主的上行只有 ~130 KB/s
    （手机侧 `curl` 拉 `planner-runtime.zip`：20 秒只下 2.7 MB），而一次冷启动要下 ~40 MB。
    这种时候要一个用例一轮，并且把「加载失败就整页重来」当常态。19. **「点了导出没反应」的最后一块拼图是浏览器自己的确认框**：v0.1.3 修掉 CSP 之后，点导出会弹出
    X 浏览器自己的「文件下载 / 您确认要下载此文件么？/ [取消][复制链接][确定]」——
    **必须点「确定」文件才会落盘**。`driver.ps1` 新增了 `tap <文本>` 步骤专门干这个：
    ```powershell
    & tools/mobile/driver.ps1 -Steps 'download_test.js solver-ap','tap 确定','adb shell ls -la /sdcard/Download/'
    ```
20. **别按应用给的文件名去找落盘的文件**：X 浏览器会**换掉文件名**（变成 `1635702473.json` 这种时间戳名）。
    找文件用 `ls -la /sdcard/Download/` 或按 `*.json` 找，**不要** `find -name '*OurNotes*'`
    （本轮前半程就被这条骗过一次，把「落盘了但名字变了」误判成「没落盘」）。
21. **验证下载不需要卡库**：「导出卡库」`#export` 与「导出本次结果」`#exportResult` 走的是**同一段
    `download()`**（`URL.createObjectURL` → `<a download>` → `a.click()`），所以拿前者就能验整条下载链路，
    **不用先导入卡库、也不用跑一次搜索**。这是本轮把「导出落盘」验通的关键一步。
22. **WebView devtools 挂掉时改用 UI 驱动**（`adb shell input tap` + `uiautomator dump` + `screencap`）：
    原生控件（系统对话框、文件选择器）有无障碍树、能精确定位；**WebView 里的内容一个节点都不暴露**，
    只能看截图按坐标点（坐标 = 截图像素 ÷ 屏幕尺寸）。首次启动/`pm clear` 之后会弹
    「服务协议和隐私政策」（同意）与「防止诈骗提醒」（我已了解），用 `tap <文本>` 点掉即可。
23. **不清存储的那一次可能把页面卡在「正在加载…」，而且 CDP 连上不答**（0.3.2 复验时观察到一次）：
    现象是 `watch.js` / `download_test.js` 一直报 `CDP Runtime.enable 超时 30000ms` 并循环，
    而同时：

    * 渲染进程**活着**（`ps -A` 里有 `com.google.android.webview:sandboxed_process0…`，状态 `do_epoll_wait`）；
    * 系统 CPU 几乎全空闲（`top -n 1 -b` 里 396%/400% idle）—— 不是在算；
    * `logcat -b events` 里**没有** `am_crash` / `am_anr`；
    * 屏幕上**没有弹窗**，页面停在「正在加载… / 正在核对游戏数据与公式…」。

    `am force-stop com.mmbox.xbrowser` 之后**带上 `MOBILE_CLEAR_STORAGE=1` 重跑就正常**（同一台机器同一次会话里，
    前后两次带清存储的用例都 40 秒左右 boot 成功）。
    ⚠️ 只记「观察到一次、原因未定性」——**别拿它当结论**；它和第 1 条的反诈弹窗表现很像，
    先看屏幕有没有模态框。另外 `-Reopen` 之后首次还会弹**「服务协议和隐私政策」**（拒绝/同意），
    `driver.ps1` 只自动点掉「我已了解」「不再提醒」这两类，这个得自己 `tap 同意`（或 force-stop 重来）。
    ⚠️ 更要先排除**第 25 条**：`Runtime.enable 超时` 也可能是主机端口被别的程序占着，
    那样连的根本不是手机 —— 一句 `curl 127.0.0.1:<port>/json/version` 就能定性，比在手机上找快得多。
24. **`/json` 通不代表 WS 通，反过来也一样**：`driver.ps1` 一被 Ctrl-C/被杀，它持有的
    `adb forward tcp:9222` 与 `reverse tcp:8899` 会立刻消失（watchdog 也随进程没了），于是
    `cdp.js dump` 报 `ws error: unknown`、`/json` 直接连不上 —— 这**不是**页面坏了。
    手动补回来即可（**只加不删，别 `--remove-all`**，见第 3 条）：
    ```powershell
    adb -s <serial> forward tcp:9222 localabstract:webview_devtools_remote_<pid>
    adb -s <serial> reverse tcp:8899 tcp:8899
    ```
    `webview_devtools_remote_<pid>` 里的 `<pid>` 就是 `pidof com.mmbox.xbrowser` 的输出。

25. **默认端口 9222 可能被本机别的程序占着 —— 而且它装得比手机还像**（2026-10-05 卡了一整轮的元凶）：
    **Adobe After Effects 的 UXP 调试端口默认就是 9222**（`curl 127.0.0.1:9222/json/version`
    → `{"Browser":"Adobe UXP"}`）。这时 `adb forward tcp:9222 localabstract:…` 只回一句
    `cannot bind listener: … 10048`，**forward 根本没建上**；而旧版 `driver.ps1` 照样打印
    「forward tcp:9222 -> sock」，紧接着 `Wait-Cdp` 去 curl 9222 —— After Effects 的 devtools
    **也回 `webSocketDebuggerUrl`、也列一个 `type=page` 的 target**，于是脚本大喊 `CDP READY`，
    node 却连到了 After Effects 上：症状是 target 的 `url` 是**空串**、`document` 里什么都没有、
    `Cannot find default execution context` / `Storage.clearDataForOrigin -32601` / 随后 WS「连不上」。
    ⚠️ 这一整套看起来和「手机没导航」「模态框挡着」「WebView 卡死」**一模一样**，
    当时连着几轮都在手机上找原因（`pm clear`、点弹窗、重启浏览器、换浏览器）——全是**查错了机器**。
    现在 `driver.ps1` 的 `Ensure-Forward`：先探主机端口是否被占（`Test-HostPortBusy`），
    建完再用 `forward --list` **核对 `tcp:<port> -> localabstract:<sock>` 这条映射真的在**，
    不在就往后换端口（最多 12 个），实际端口写进 `CDP_PORT`；`Wait-Cdp` 也把 `Adobe UXP`
    这个串当假货拒掉；watchdog 同样按整条映射核对，而不是只看端口出现过。
    手动排查同理：**先 `curl 127.0.0.1:<port>/json/version`**，自称 `Adobe UXP` 就说明连的不是手机；
    `/json` 里 target 的 `url` 是空串 = 十有八九是这个坑，真手机的 WebView 一定列出
    `http://localhost:8899/ournotes-planner/`。

26. **「映射在」≠「能用」；`/json` 超时别急着怪手机**（2026-10-05 云手机那轮的第二个坑）：
    云手机掉线时 adb 会把本地监听**留着**、绑在已经死掉的 transport 上 —— `forward --list`
    照样列出这条映射，可连进去只会 `socket hang up`，而「缺了再加一条」是**无效的**
    （加的是同一条，adb 幂等忽略）。症状是 watchdog 每 3 秒补一次、CDP 十五分钟没应答。
    现在 watchdog 每轮都**探一下** `/json`，探不通且设备在线满 ~60 秒就**硬重建** forward
    （`forward --remove-all` + 重加；**只动 forward，绝不动 reverse** —— 页面可能正通过它下载）。
    另外 `/json` 的重试窗口放宽到 10 分钟（`MOBILE_JSON_TRIES`）：云手机掉线是**成串**来的
    （实测一分钟能掉 20 次），150 秒的窗口撑不过一串掉线，前面下的东西全白费。

27. **一次冷启动要下 ~27 MB，别让 `reload` 每次都重下一遍**：
    `pyodide.asm.wasm` 9.6 MB + ortools wasm 7~11 MB + stdlib + 运行时包。原来 `reloadPage()`
    写死 `ignoreCache:true`，等于**每次 reload 都重下这 27 MB**；而测试服务器
    （`tools/mobile/server.py`）又刻意发 `Cache-Control: no-store`，缓存一点都留不下 ——
    窄链路（宿主机↔云手机实测 ~180 KB/s）下永远下不完，boot 次次超时。
    现在 reload **默认不绕过** HTTP 缓存（`MOBILE_RELOAD_BYPASS_CACHE=1` 才绕过）。
    这样做是安全的：资源名都带内容哈希（`assets/*-<hash>.wasm`），应用自己取的运行时 URL
    也带 `?v=<runtime_sha256>` —— 换了构建就是**另一个 URL**，缓存里拿不到旧货。

28. **真机上「取第一个 devtools socket」必然连错**：设备上同时开着别的 WebView
    （实测用户手机上有一个「NapCat 监控」页面的 WebView）。而且**各家 socket 名不一样**：
    云手机 X 浏览器是 `webview_devtools_remote_<pid>`，真机夸克是
    `huawei_webview_devtools_remote_<pid>`。现在 `Find-AppDevtools()` 按
    `*devtools_remote_<pid>` 收全集，逐个 forward 上去 **看 `/json` 里有没有应用页**，
    认错了就把那条映射撤掉。

29. **不是每台手机都能自动驱动**：实测 HUAWEI HBN-AL80（HarmonyOS / Android 12）上
    **自带浏览器（华为浏览器 17.0.8.310，ArkWeb）和 Via 都不开 WebView 调试口**
    （`setWebContentsDebuggingEnabled` 没开，socket 根本不存在）；夸克虽然开，
    但它把页面渲染在**自家内核**里，系统 WebView 那个 target 的 `description` 是
    `"visible":false`、DOM 里没有应用的元素 —— 连上去只会「探测：hasApp=false」。
    **这种机器只能走「人工操作 + 主机侧取证」**：人点，主机负责 push 测试卡库、
    截图、拉导出结果，再拿 `compare.js` 对原生 oracle 比对。判据一个字不变，
    只是「谁点的」从 CDP 变成人；凭据里的 `notes` 要如实写明。

30. **把卡库 JSON 送进手机，光 `adb push` 不够**：应用对导入文件限定了
    `accept=".json,application/json"`，而华为文件选择器的「下载」根目录是按
    **MediaStore 的 mime** 判断的 —— adb 推的文件没登记，它显示成「**BIN 文件**」并**灰掉**。
    两件事都要做：① 文件名用 **ASCII**（中文名在「下载」根目录里会被截断、mime 也认不出）；
    ② 推完补一发 `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///…`
    （之后 `content query --uri content://media/external/file` 里就是 `mime_type=application/json`）。
    放在 `/sdcard/Documents/` 也有一份（那个根目录按扩展名认类型）。

31. **息屏会让 WebView 冻结，CDP 全线 30 秒超时**：驱动跑着的时候如果手机自己息屏，
    页面变 `hidden`，Chromium 把标签冻住，于是每条 `Runtime.evaluate` 都
    `超时 30000ms`（而 CPU 是闲的 —— 这两件事一起出现就是这个坑，不是应用卡死）。
    跑之前先 `adb shell svc power stayon true`（插着 USB 时会保持常亮）+
    `input keyevent KEYCODE_WAKEUP`；测试期间也别切走页面。

32. **不是所有手机都有 `curl`**：HarmonyOS（HBN-AL80）只有 toybox，`driver.ps1` 里
    「手机侧 curl 拉 index.html」那条自检会拿到 `inaccessible or not found` ——
    现在这种输出**只记一行、不当失败**（真正准的判据是应用能不能 boot 出来）。