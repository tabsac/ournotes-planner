# 云端（服务器）对接：现在做到了哪、怎么开、怎么测

> 契约来源：**`服务器-网页对接说明.md`**（在 `C:\Users\13766\dsh-workspace\` 与 `on-share\`，
> ⚠️ 那份文档里有服务器地址等内部信息，**不要贴进任何仓库**）。本文只写网页这一侧。
>
> **反方向的那份（给服务器端）**：`网页-服务器对接说明.md` + `网页-服务器对接-参考实现.py`
> —— 逐条契约、错误码、CORS/缓存要求、SQLite 表结构、nginx 部署、curl 自测清单，
> 以及一份**已经用本页这套检查跑通**的最小后端实现。

## 1. 已经落地的（B 最小版）

「把**算好的卡片结果**存到服务器、在别的设备上取回来」，服务器**只存不算**。

| 文件 | 作用 |
|---|---|
| `browser/cloud-api.js` | 接口客户端：地址解析、登录、结果 CRUD、错误归一、体积/超时预检查。**没配置地址就一个请求都不发。** |
| `browser/cloud-ui.js` | B25 页上的「云端同步（可选）」面板：地址、登录码、上传/取回/删除、同步状态。 |
| `browser/b25-ui.js` | 面板挂载（**空状态也挂** —— 换设备的人第一眼是空的，得能在那儿登录取回）+ `saveRecord()`。 |
| `browser/build_browser.py` | 构建期读**可选**的 `api-config.local.json`，把地址注入 `<meta name="ournotes-api-base">` 与 CSP。 |
| `browser/tests/preview_server.py` | `--api-proxy`：把 `/cloud-api/**` **同源**转发到后端（对接真实服务器时最省事）。 |
| `browser/tests/mock_api_server.cjs` | 按契约实现的本地替身（登录/结果/ETag/401/409/413/422/CORS）。 |
| `browser/tests/check_cloud_sync.cjs` | 端到端检查（已进 `tools/run_checks.py`）。 |

**只上传展示用结果**：曲名、谱面等级、FC/AP、统计（约 10 KB）。
**不上传原始账号包**（那是整份账号数据，3 MB+）；服务器侧也没有任何计算。

## 2. 怎么开

地址**绝不硬编码**，三种来源（优先级从高到低）：

1. 用户在面板里填的（存 localStorage，键 `ournotes-cloud-api-base`）
2. 构建期注入 `<meta name="ournotes-api-base">`
3. 都没有 → 云端功能关闭

构建期注入：把 `browser/api-config.example.json` 复制成 **`browser/api-config.local.json`**
（已被 `.gitignore` 忽略）：

```json
{"apiBase": ""}                          // 与网页同源（服务器自己托管网页，CSP 只需 'self'，无 CORS）
{"apiBase": "https://api.example.com"}   // 跨源：构建会自动把该源加进 CSP 的 connect-src
```

```powershell
python -B browser/build_browser.py --build      # 之后 dist/ 就带着地址了
```

⚠️ **公开发布必须是「不带地址」的构建**：`tools/verify_release.py` 会检查 index.html 里
有没有 `ournotes-api-base`，有就直接拒绝（红线：服务器地址不进公开仓库）。
所以 GitHub Pages 上那一份**永远是离线版**；要云端就在自己服务器上托管一份带地址的构建
（同源模式最省事，`apiBase: ""`）。

## 3. 怎么测 / 怎么对着真实服务器调

```powershell
# 端到端（自动起替身服务器 + 带代理的预览，跑完自己收工）
node browser/tests/check_cloud_sync.cjs

# 拿同一套检查去打**真实/自研的后端**（把 reference 指到那个实现）
#   CLOUD_CHECK_SERVER=reference  CLOUD_CHECK_REFERENCE=<你的实现.py>
# 文档 §9 那份参考实现就是这么验的（全绿），可以直接当起点改
$env:CLOUD_CHECK_SERVER='reference'
$env:CLOUD_CHECK_REFERENCE='C:\Users\13766\dsh-workspace\网页-服务器对接-参考实现.py'
node browser/tests/check_cloud_sync.cjs

# 对着真实服务器调页面（地址只在本机命令行出现，不进仓库）
python -B browser/tests/preview_server.py --port 8877 --api-proxy https://<真实地址>
# 然后在页面的云端面板里把地址填成 /cloud-api
```

覆盖到的行为：未配置时**零请求零报错**、错登录码被挡、上传、**换设备取回（卡片完整还原）**、
覆盖更新走 PUT、旧版本号写回被 409 挡、服务器挂掉时本地卡片照常显示且只给提示。

## 4. 还没做的（下一轮）

1. **只读数据接口（§3）**：`/data/version.json`、`/data/songs.json`、`/data/events.json`、
   `/data/cards.json` —— 让谱面等级、封面、活动加成能自动更新。客户端已经有 `dataVersion()`
   这个探针（面板的「测试连接」用的就是它），接下来是把 `snapshot-override` / `b25-extra.json`
   改成「先读远端 manifest、失败就退回内置」。**门禁要一起改**：数据也要有版本 + sha256。
2. **卡库（profile）云同步（§5）**：同一条 results 通道再加一种 payload 类型即可。
   现在是「本地先写、失败不阻塞」，多设备冲突提示还没做（服务端已有 version 语义）。
3. **图片**：曲绘/卡面是版权物，默认**不对网页开放**（§6.1）；要开放得先问用户。
4. **部署**：服务器上**不要构建**（内存不够），只上传 dist；nginx 反代 `/api`、`/data` 到本地后端。
