# 游戏生产工厂

首页创建游戏项目 → 开始完整生产 → 在线试玩 → 填写验收记录 → 下载或公开发布。

## 当前产线

交付 **2D 俯视探索收集游戏**：键盘/触屏移动、墙体碰撞、收集、巡逻危险物、NPC 对话、1～5 关、暂停、失败重试和结局。

| 工位 | 实际产物 |
|---|---|
| 策划、剧本、关卡 | 服务器 Qwen 生成结构化玩法、角色设定、剧本、对白、地图与结局 |
| 美术 | AI 配色与内置矢量模板；SVG 角色/道具，运行时绘制场景 |
| 声音 | 程序合成 WAV 提示音与 8 秒循环音符配乐 |
| 动画、交互 | 位移动画、悬浮、受伤闪烁、收集、出口与对白事件 |
| 集成、检查 | HTML/JS 可玩包、关卡可达性与文件校验报告 |
| 交付 | 在线试玩、完整源码 ZIP、人工验收、可撤回的公开链接 |
| 3D 工位 | 项目关联 Forge3D 建模；不自动进入当前 2D 引擎 |

**尚未支持**任意游戏类型、3D 玩法自动组装、扩散原画、GPU 音频自动组装进 2D 产线、联网对战与商店上架。程序素材不宣称为 GPU 扩散模型产物。

## 独立 GPU 音频工位

已配置 [GPU 音频 Skill](../production-skills/gpu-audio/SKILL.md) 与 `tools/gpu-audio/audio_factory.py`：Stable Audio 3 Medium 用于音效、环境声，Qwen3-TTS 用于中文对白。跨游戏复用同一入口，按项目和声音事件保存请求、母版、模型/代码/Skill 哈希与技术检查结果，不使用商业生成 API。

服务端先运行 `python3 tools/gpu-audio/audio_factory.py doctor` 核实环境。Stable Audio 3 需要官方模型访问权限及 Flash Attention 2；Skill 已安装不代表权重已下载或推理已验证。生成结果统一待人工试听。旧版 2D 一键生产仍使用程序声音，GPU-only 项目须走独立音频工位并另行接入事件。

## 版本与账号

- 每次迭代保留新版本，固定 Skill 快照、输入、阶段和文件哈希可追溯。
- 单项目串行生产，失败可重试未完成阶段；服务恢复后继续未完成版本。
- 已发布版本不会被新生产覆盖；重新发布会替换分享链接，撤回后旧链接失效。
- 游戏完成或失败通过独立通知队列发送到账号自己的飞书/邮箱/企微。通知失败不重跑生产。
- 自动检查通过不等于试玩通过。人工验收只允许网页登录操作；MCP 可在通过后按用户明确要求发布。
- 私有工程按账号鉴权；试玩以沙箱运行，模型只输出经验证的数据，不执行模型生成代码。

## MCP

`get_factory_capabilities` → `list_game_projects` → `create_game_project` → `start_game_production` → `get_game_project` → `get_game_artifacts` / `export_game`。

生产提交必传 `request_key`，重试同一次提交时复用；飞书默认开启，用户明确无需通知可关闭。

更多工具：`get_game_artifact`、`retry_game_production`、`cancel_game_production`、`get_game_model_plan`、`publish_game`、`unpublish_game`。

## 服务配置

- 默认复用 `SKILL_PLANNER_URL/MODEL`；可用 `FACTORY_PLANNER_URL/MODEL` 单独指定文字模型。
- `FACTORY_DIR` 默认位于 `DB_PATH` 同级的 `game-factory/`，与业务数据一起备份、保留。
- ZIP 解压后可直接打开 `index.html`。修改 `game.json` 后用 `node rebuild.cjs` 更新页面；`runtime.js` 为完整引擎源码。
