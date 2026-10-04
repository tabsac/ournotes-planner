# 云端（服务器）对接：现在做到了哪、怎么开、怎么测

> ⚠️ **判「有没有启用云端」永远用 `isConfigured()`（= `apiBase() !== null`）**，
> 不要写 `!!apiBase()`：同源部署时 `apiBase()` 返回**空串**（不是 `null`），
> 空串是 falsy → 整条功能会在同源形态下**静默失效**（v0.3.0 线上出现过，见 CHANGELOG v0.3.1 与设计笔记 2n）。
> 用地址的地方才用 `apiBase()`。
>
> **v0.3.0 起登录改成「账号 + 密码」，QQ 变成账号里的绑定项** ——
> 契约看 **《网页-服务器对接-账号系统变更.md》**（v2，本文的 v1 描述已过时；
> `/api/results` 那部分一个字没变）。正式站点：**`https://on.tabsac.com/`**，
> 前端用**同源空串**（`apiBase: ""`），请求就是 `/api/...`。
>
> 契约来源：**`服务器-网页对接说明.md`**（在 `C:\Users\13766\dsh-workspace\` 与 `on-share\`，
> ⚠️ 那份文档里有服务器地址等内部信息，**不要贴进任何仓库**）。本文只写网页这一侧。
>
> **反方向的那份（给服务器端）**：`网页-服务器对接说明.md` + `网页-服务器对接-参考实现.py`
> —— 逐条契约、错误码、CORS/缓存要求、SQLite 表结构、nginx 部署、curl 自测清单。

## 1. 已经落地的（B 最小版）

「把**算好的卡片结果**存到服务器、在别的设备上取回来」，服务器**只存不算**。

| 文件 | 作用 |
|---|---|
| `browser/remote-data.js` | 远端只读数据（`/data/*.json`）：字节校验 + 变更判断 + 与内置快照逐首比对 + 「数据状态」卡片 + 顶部陈旧提醒。 |
| `browser/cloud-api.js` | 接口客户端：地址解析、**注册/登录/me/改密/绑定 QQ**、结果 CRUD、敏感字段过滤、503 退避、错误归一。**没配置就一个请求都不发。** |
| `browser/cloud-ui.js` | 「账号」页签的全部界面：登录/注册、账号区（QQ 绑定/解绑/改密/退出）、绑定弹窗（一键复制 + 3 秒轮询）、结果列表、卡库同步状态。 |
| `browser/profile-cloud.js` | 卡库云同步：延迟合并推送（POST/PUT + version）、云端列表、恢复到本机。 |
| `browser/profile-storage.js` | 本地卡库读写；`setProfileCloudSync()` 挂上「本地保存成功后通知云端」的钩子。 |
| `browser/b25-ui.js` | B25 页底部的**窄条**（登录态 + 存到云端 + 去账号页）+ `saveRecord()`。 |
| `browser/main.js` | 挂载账号面板、接上卡库桥（`window.PlannerProfile`）、头部标识 `#cloudBadge`。 |
| `browser/build_browser.py` | 构建期读**可选**的 `api-config.local.json`，注入 `<meta name="ournotes-api-base">`（空串=同源）与跨源 CSP；「账号」页签/容器/头部标识的 HTML 补丁；卡库桥的代码补丁。 |
| `browser/service-worker.js` | 只缓存同源静态资源，**`/api/**` 与 `/data/**` 直连不拦**。 |
| `browser/tests/preview_server.py` | `--api-proxy` + `--api-prefix`：把某个路径前缀**同源**转发到后端（本地对接真实服务器/跑测试用）。 |
| `browser/tests/mock_account_api.cjs` | 按 v2 契约实现的本地替身（注册/登录/me/改密/绑定/结果/`stripped`/503/内部接口模拟机器人）。 |
| `browser/tests/check_cloud_sync.cjs` | 端到端检查（已进 `tools/run_checks.py`，10 组场景）。 |

**只上传展示用结果**：成绩卡（曲名、谱面等级、FC/AP、统计，约 10 KB）与个人卡库。
**不上传原始账号包**（那是整份账号数据，3 MB+）；服务器侧也没有任何计算。

## 2. 怎么开

地址**绝不硬编码**，三种来源（优先级从高到低）：

1. 用户在面板里填的（存 localStorage，键 `ournotes-cloud-api-base`）
2. 构建期注入 `<meta name="ournotes-api-base">`（**空串 = 与网页同源**，正式站点就是这个）
3. 都没有 → 云端功能关闭（面板显示「未启用」并给出官方站点网址）

构建期注入：把 `browser/api-config.example.json` 复制成 **`browser/api-config.local.json`**
（已被 `.gitignore` 忽略）：

```json
{"apiBase": ""}                          // 与网页同源（on.tabsac.com 就是这么构建的；CSP 只需 'self'，无 CORS）
{"apiBase": "https://api.example.com"}   // 跨源：构建会自动把该源加进 CSP 的 connect-src
```

```powershell
python -B browser/build_browser.py --build      # 之后 dist/ 就带着标记了
```

⚠️ **公开镜像（GitHub Pages）必须是「不带绝对地址」的构建**：`tools/verify_release.py` 会拦住
`content="https://…"` 这种**绝对地址**（红线：服务器地址不进公开仓库）；空串/相对路径不含地址，放行。
所以 `docs/` 那份镜像没有标记 → 面板显示「未启用」并指路官方站点。

## 3. 怎么测 / 怎么对着真实服务器调

```powershell
# 端到端（自己起 v2 替身后端 + 带代理的预览，跑完自己收工；默认**不**构建，验的是现成 dist）
python -B browser/build_browser.py --build      # 先构建（想让它顺手构建就 CLOUD_CHECK_BUILD=1）
$env:OURNOTES_BROWSER_CHANNEL='msedge'
node browser/tests/check_cloud_sync.cjs

# 对着真实服务器调页面（地址只在本机命令行出现，不进仓库）
#   注意：代理会**去掉** --api-prefix，所以上游 base 要带上对应的路径段
python -B browser/tests/preview_server.py --port 8877 --api-proxy https://on.tabsac.com --api-prefix /cloud-api
# 然后在账号页把地址填成 /cloud-api（同源/绝对地址都可以，只是本地调试用）
```

覆盖到的行为（10 组）：未启用时**零请求零报错**；注册→自动登录→刷新仍登录；
**绑定 QQ（发错 QQ 被拒且码不消耗 → 本人发送成功 → 3 秒轮询自动变「已绑定」）**；
成绩卡上传（**前端先剔敏感字段**）→ 换设备取回（25 张卡）；**卡库上传 → 换设备恢复**；
改密后旧 token 401 并回登录表；1 个 503 自动重试成功 / 连续 503 给限流提示；
无效 token 自动清掉；token 从不进 URL；**交付产物（同源空串）无需任何配置即可注册**；
**同源空串下卡库同步三连：状态「未同步」→ `POST /api/results` 201 → 本地改动自动 `PUT` 200**
（v0.3.1 新增 —— v0.3.0 就是漏了这三条，才会把「空串被当 falsy」的 bug 放过）。

## 4. 还没做的（下一轮）

1. ~~消费 `/data/*.json`~~ **✅ v0.3.2 做了「核对 + 陈旧提醒」这一层**（`browser/remote-data.js`：
   字节校验 `fileDigests`、变更判断 `contentDigests`、与内置快照逐首比对、顶部提醒）。
   真站点（2026-10-05）已按这个口径验过：服务器侧**真的重建了一次数据**，三个文件的字节与
   `fileDigests` 全变、`contentDigests` 不变 → 卡片如实报「与上次相同」+ 字节校验通过。
   **这就是「变更看 `contentDigests`、字节看 `fileDigests`」的理由**：拿 `fileDigests` 判变更会永远误报。
   * 尚未在真站点打到过的分支：**「不一致」那条**（线上远端与内置当前完全一致）。
     验法：临时把 `/data/songs.json` 里某首曲子某难度的 **`display`（显示等级）** 改掉
     —— 注意**不能只改 `charts[].level`（定数）**，代码取的是 `chart.display ?? chart.level`；
     只改 songs.json 不更新清单时，命中的是**校验失败**分支（顶部提醒「字节与清单不符…不做数据对比」），
     卡片里仍能看到差异明细；把 `version.json` 的 `fileDigests["songs.json"].sha256` 一起改对，
     才会走到正式的「线上曲目数据与内置快照不一致（1 处等级变化）……」那条提醒。
   * **改完要按「重新检查（强制拉一份）」**，别只刷新页面：本地缓存（`ournotes-remote-data-v1`）
     按 `contentDigests` 做备忘录，手工改字节而没动 `contentDigests` 时，刷新会**重放上一次的比对结论**。
     **已知小限制（不打算为它单独发版）**：校验失败那一轮也会写缓存，所以「手工改过又还原」之后
     如果只刷新页面，可能短暂看到上一次的「不一致」—— 按一次「重新检查」就回到一致。
     正规链路（服务器重建会同时更新 `contentDigests`）碰不到这条；真要根治就是「字节对不上的结论不入缓存」，
     留给下一版顺手做。
   **「把远端数据喂给求解」这一层分了两条路，选的是后者**：
   * ~~运行期消费（求解器直接读 `/data`）~~ **不做**：求解输入必须确定，否则「同一份输入」随数据版本漂移，
     而验收 oracle 是每次由 `browser/tests/make_fixtures.py` 从当前快照现算的，一漂就没意义。
   * **✅ 构建期同步**（`tools/sync_snapshot_from_data.py`）：发布前把 `/data/*.json` 的
     **谱面显示等级 / 定数 / 物量 + 活动窗口**同步进 `browser/snapshot-override/`（默认只报告，
     `--write` 才写；先按字节校验 `fileDigests`；写回格式逐字节可复现，`git diff` 只显示真改的行）。
     同步记录落在 `snapshot-override/data-sync.json`（来源 + `dataVersion` + 两类摘要 + 跳过了什么）。
     回归测试 `browser/tests/check_snapshot_sync.py` 已进全量验收。
   * **新歌仍不能自动跟上**：一首新歌还要谱面文件（note 数据）才算得出分，而 `/data/songs.json` 里没有
     → 走 `python browser/update_snapshot.py --apply`（从游戏 CDN 拉全量表 + 谱面，需要本机凭据）。
     要让它也自动化，得请服务器侧在 `/data` 里带上谱面数据（要重新谈契约）。
2. **多设备冲突**：v0.3.2 补了选择框（用云端覆盖本机 / 保留本机另存）。仍可改进：
   冲突时显示「云端那版是什么时候、多少张卡」，便于用户判断选哪个。
3. **忘记密码自助重置**：等机器人侧加命令（现在文案是「找管理员」）。
4. **图片**：曲绘/卡面是版权物，默认**不对网页开放**（`/img/**` 404）；要开放得先问用户。
5. **部署**：服务器上**不要构建**（内存不够），只上传 dist（见交付包里的 `DELIVERY.md`）。
