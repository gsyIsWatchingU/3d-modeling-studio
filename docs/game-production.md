# 固定游戏制作 Skill

## 使用

- 首页是[游戏生产工厂](game-factory.md)，可生产完整浏览器探索游戏。3D 建模工位右上角「游戏制作流」保留规范查看与独立计划。
- 建模无需手动选择：后端始终加入制作通则、通用建模、角色/场景/道具规范，个人固定 Skill 同时生效。
- 关联制作计划后自动带入项目约束，并使用该计划保存时的 Skill；不能引用其他账号的计划。
- MCP：`list_production_skills`、`list_production_plans`、`create_production_plan`、`get_production_guide`；提交模型时带 `production_plan_id`，质量档位与计划保持一致。
- 全局 Skill：`game-production-workflow`；安装后下一轮对话可用。重装到其他环境可运行 `node scripts/install-production-skill.js`，不会覆盖现有目录。

## 阶段与能力

| 阶段 | 固定内容 | 当前执行方式 |
|---|---|---|
| 策划 | 核心循环、GDD、预算、切片 | AI 按规范编写 |
| 剧本 | 世界观、人物、分支、分镜、事件 | AI 按规范编写 |
| 角色 | 比例、剪影、材质、变形准备 | GPU 静态模型；绑定另行执行 |
| 场景 | 布局、模块、尺度、路线、环境叙事 | GPU 场景资产；关卡另行搭建 |
| 道具 | 用途、结构、材质、枢轴、交互件 | GPU 静态模型 |
| 动画 | 骨架、蒙皮、动作、状态、事件 | 工厂含 2D 运行时动画，3D 绑定另行执行 |
| 音效 | 声源、触发、变体、循环、混音 | 完整生产自动组装三个 GPU 事件音效，程序配乐保留原方案 |
| 集成 | 引擎、UI、特效、碰撞、性能 | 工厂组装 2D 探索游戏，其他引擎另行执行 |
| 验收 | 试玩、复测、证据、发布清单 | 实际观察与人工验收 |

制作计划是目标与规范快照，不是已经完成的剧本或资产。每个建模任务保留完整 Skill 与来源，文件生成成功不代表质量通过。

## 来源筛选

采用 8 个 Skill 与 3 份补充领域手册：

- [skills-gamedev](https://github.com/poorvith-mp/skills-gamedev)：game-design、narrative-design、blender-modeling、blender-animation、level-design、game-audio、tech-art、playtesting。
- [agency-agents](https://github.com/msitarzewski/agency-agents/tree/main/game-development)：narrative-designer、level-designer、game-audio-engineer。

筛选依据是可执行的输入、交付和验收要求。保留剧本因果、网格/UV/枢轴检查、动画交接、声音事件、试玩观察；移除强制中间件、统一 60 帧、固定 LOD 数量、未经验证的成功率等过度约束。上游示例不作为本平台的实测成绩。

规范已整理为中文，原文与 MIT 许可存于 `production-skills/vendor`，提交和 SHA-256 固定在 `sources.lock.json`。运行时校验来源，不联网更新或执行上游代码。修改规范需提交新版本；历史计划不会自动迁移。

《川流不息》仍叠加独立的专属创作 Skill，其他游戏不会自动套用其风格。
