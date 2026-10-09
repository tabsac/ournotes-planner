# Our Notes planner

正式站：[on.tabsac.com](https://on.tabsac.com/)。主页提供网页登录、QQ 关联和多游戏账号管理，组卡及其他功能放在侧边圆形菜单中。上传账号包时按 UID 新增或更新，支持切换、排序和删除对应数据；详见[多游戏账号说明](guides/GAME-ACCOUNTS.md)。

[打开网页版](https://doublequiet-on.github.io/ournotes-team-planner-web/) · [使用说明](guides/USAGE.md) · [开发入门](guides/DEVELOPMENT.md)

在浏览器中录入 BanG Dream! Our Notes 日服卡库，计算普通演出与挑战演出的队伍、活动 PT、商店 PT 和不同歌曲前三名。Python 公式与完整搜索在访问者的设备上运行，网站只提供静态文件，适合 GitHub Pages，无需维护计算服务器。

当前网页版 **v0.3.2**，模型固定为公开源码 **v0.2.5**，数据快照 **2026-10-01**。初次使用为空白卡库，可导入本地版导出的 JSON。个人卡库和续算进度保存在同一网址、同一浏览器；换设备或清理网站数据之前请导出备份。

**v0.1.3 修好了两处手机浏览器上的问题**：① 点「导出」没有文件落地（页面 CSP 挡住了这类浏览器把文件交给系统保存用的那句请求；现在已放行，真机上已验证文件确实落到 `Download/`）；② 首次打开可能永远停在「正在准备首次运行」（Service Worker 等待没有超时）。⚠️ 部分手机浏览器（实测 X 浏览器）每次下载会弹一次确认框、并把文件名换成它自己的时间戳名 —— 这是浏览器行为，不是网页的问题。详见 [变更记录](CHANGELOG.md)。

**v0.1.2 修正了普通单人演出误用挑战参数加成的计算错误。请刷新网页并重新计算旧结果。** 普通与挑战现在分别计算综合力，活动 PT / 商店 PT 加成仍按各自结算保留。[规则、影响与修复说明](guides/POWER-MODES.md)。

![使用合成养成完成 AP 计算的网页示例](guides/images/preview.png)

目前按固定活动 ID 1、普通单人自由演出、撃奏关闭计算。AP 使用模型的最不利技能顺序评级；推荐结果属于模型估算。普通与挑战阶段各使用固定队伍和歌曲，完整比较资源循环，不计算逐场混队或混歌。新活动、撃奏和未验证技能需要先补充模型与证据。

## 本地构建

需要 Node.js 22 或更新版本、Python 3.12 和 Git。本次验证使用 Node.js 24；使用网页的人无需安装开发工具。

```powershell
git clone https://github.com/doublequiet-on/ournotes-team-planner-web.git
cd ournotes-team-planner-web/browser
npx pnpm@11.19.0 install --frozen-lockfile
npx pnpm@11.19.0 build
python -B tests/preview_server.py
```

通过 [本机预览](http://127.0.0.1:8877/ournotes-planner/) 打开。必须通过 HTTP/HTTPS 访问；首次打开可能自动刷新一次。建议使用电脑的近期 Chrome 或 Edge。首次下载运行组件需要网络，本版不承诺完整离线运行。

## 源码与说明

| 内容 | 入口 |
| --- | --- |
| 录入、计算、保存与续算 | [使用说明](guides/USAGE.md) |
| 独立构建、修改源码、测试 | [开发说明](guides/DEVELOPMENT.md) |
| 浏览器 Worker、模型桥接与存储 | [架构说明](guides/ARCHITECTURE.md) |
| 数据来源、固定基准与升级步骤 | [数据说明](guides/DATA.md) |
| GitHub Pages 发布、更新与回退 | [部署说明](guides/DEPLOYMENT.md) |
| 验收命令与证据边界 | [验证说明](guides/VALIDATION.md) |
| 加载、保存、性能问题 | [故障排查](guides/TROUBLESHOOTING.md) |
| 提交修改 | [贡献说明](CONTRIBUTING.md) |
| 版本变化 | [变更记录](CHANGELOG.md) |

`browser/` 包含可编辑的网页与 Python/WASM 适配源码、锁定依赖、测试和公开基准 ZIP。`docs/` 是已经构建的 Pages 网站，不需要服务器程序。开发指南提供展开基准 Python 公式与研究数据的命令，构建不依赖作者机器上的其他目录。

本项目新增代码采用 [MIT 许可证](LICENSE)。原模型、转换工具和运行组件保留各自许可证；游戏数据、卡图和谱面不由本项目授予版权许可。来源与完整说明见 [第三方说明](THIRD-PARTY-NOTICES.txt)、[许可证目录](licenses/) 和 [数据说明](guides/DATA.md)。这是非官方工具。


## 同步发布与验收规则（2026-10-06）

任何靠重试才成功的现象，都要先当作待修 bug；重试只是兜底，不是通过标准。卡库同步必须等待 generated-app 的 PlannerProfile.ready；生成桥的变更需修改 build_browser.py。部署后先确认首次安装，再测试自动往返和冲突处理，双机产物一致及护栏通过后才宣告发布完成。

仓库内回归：`node tools/test_profile_sync.cjs`。隔离 UI 夹具：`node tools/test_profile_ui_server.cjs`，再访问 localhost:8766；该夹具使用模拟后端，不能代替生产 API 的冲突验收。

目前已关联账号每设备每60秒读取一条卡库，目标为活跃页面≤60秒发现远端更改；60秒不是协议要求，是当前体验取舍。10台活跃设备约10请求/分钟，按每条1.4KB gzip估算约14KB/分钟、19.7MiB/天响应正文，不包含TLS/HTTP头。未配置/未登录不轮询，冲突停自动读写；页面聚焦和网络恢复另可触发一次读取。尚未实现ETag/304或后台页面停轮询，也未声称后台暂停的手机有严格60秒承诺。若规模增长，应在保持首次恢复正确的前提下改版本/ETag与可见性触发。

内容指纹是preparePayload清理后的完整document的JSON.stringify，不含外层savedAt，敏感字段由sanitizePayload删除。对象按JS枚举顺序、数组保留原顺序；不排序、不作浮点容差、数字字符串与数值不同；遵守JSON数值序列化规则（-0为0）。同一个归一化导入/导出流程目前保证通常稳定，但任意重排对象键会造成保守的假冲突；指纹不是通用语义等价比较或加密摘要。未来改算法要同时迁移已持久化的共同指纹，不能仅一端更改。
