# 浏览器本地多目标组卡 — 维护说明

网页复选框的开始按钮使用 window.Planner.request('/api/local-deck-batch')，这是 main.js 内部路由，没有发出 HTTP 计算请求。状态来自浏览器 Worker。

计算分工：
- 活动收益、清火和活动歌榜：deck_local.py 复用 browser_runtime 的 planner_core、activity_goals、team_options，以及本机搜索缓存。
- 自由、歌曲和激奏：deck-native-worker.js 加载同源 Rust WebAssembly，通过 batch 方法使用与服务器相同的 recommend / evaluate_fixed 函数。Python 与 Worker 的桥负责顺序计算与候选队伍跨曲评估。
- 激奏保留原来的实验性单人任务模型限制，不能预测多人连胜。

本地结果存在现有 IndexedDB state 仓库中，键为 deck-batches:<账号或local>。完整结果按实际卡库、条件、runtime_sha256 和 local_deck_engine 哈希复用。取消只取消本批浏览器计算；其他用户、旧服务器任务不受影响。

登录时完成计算会调用已有 /api/results 保存 kind=deck-batch 的结果，不调用 /api/deck-jobs 创建计算任务。未登录可计算和导出；登录后可用“同步结果到云端”上传。上传失败保留本机结果，可重试。上传卡牌展示目录仅保留本批实际使用的成员和留影，沿用256KB上限及敏感字段过滤。

浏览器首次使用自由/歌曲/激奏时需要加载独立的计分组件与数据，加载后在 Worker 中复用。计算期间保持网页打开。

构建：python -B build_browser.py --build。deck-native-assets 是经过验证的分发资产，build_browser.py 自动复制至 public/deck-local/<内容哈希>/，并将哈希写入 build-info.json。不可只替换固定URL资产，否则旧浏览器可能保留缓存。

更新 native 资产时，应从同一引擎源码构建 wasm/recommend（wasm32-unknown-unknown），用 wasm-bindgen 0.2.127 --target web 生成分发文件，将同一代游戏主数据及谱面 deck-data.json 放入 deck-native-assets；Apache/MIT许可一并保留。已有工作区生成/补齐数据工具在 work/unified-decks 下。更新后检查浏览器与 native 固定队伍得分、综合力一致，以及87曲/64成员/65留影/348谱面的当前基线或新的官方基线。

服务器 Bot 指定歌曲计算仍使用现有 /api/internal/deck-jobs，此次未修改 Bot 或 API。

发布遵循原有双机流程：Tokyo 主站先发布、Aliyun镜像同步、文件哈希比较、web_release_guard。镜像同步工具已由未压缩tar改成gzip tar，仍有路径校验、哈希校验、备份和index最后切换。
