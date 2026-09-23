---
name: game-production-workflow
description: 按固定规范编写游戏策划、剧本和分镜，设计角色、场景、道具、动画与音效，并交接建模、引擎集成和试玩验收。用于游戏制作与资产生产需求；普通应用开发不触发。
---

# 游戏制作全流程

先读 [制作通则](references/common/SKILL.md)，再按实际任务加载对应阶段，不把全部规范塞进每次任务。

| 当前任务 | 必读 |
|---|---|
| 策划、玩法、切片拆解 | [策划](references/design/SKILL.md) |
| 剧本、对白、分镜 | [叙事](references/narrative/SKILL.md) |
| 角色建模 | [建模](references/modeling/SKILL.md) + [角色](references/character/SKILL.md) |
| 场景、关卡 | [建模](references/modeling/SKILL.md) + [场景](references/environment/SKILL.md) |
| 道具 | [建模](references/modeling/SKILL.md) + [道具](references/prop/SKILL.md) |
| 绑定、动画 | [动画](references/animation/SKILL.md) |
| 音效、配音、配乐 | [声音](references/audio/SKILL.md) + [GPU 音频工位](references/gpu-audio/SKILL.md) |
| UI、特效、引擎与性能 | [集成](references/integration/SKILL.md) |
| 试玩、交付 | [验收](references/qa/SKILL.md) |

保留用户的引擎、平台、风格与原有工程。涉及《川流不息》时同时读取已安装的 chuanliu-creative-direction 及其对应领域参考；通用规范不覆盖该游戏的正史、风格、GPU 生产限制或人工 approved 门禁。

若已连接游戏工厂 MCP，先用 get_factory_capabilities 确认实际产线，再用 list_game_projects 查找项目。浏览器俯视探索游戏使用 create_game_project → start_game_production → get_game_project → get_game_artifacts / export_game；任务异步执行，超时重试复用 request_key。网站与 MCP 共享任务、版本和产物。完整生产可生成策划、剧本、矢量美术、程序合成声音、运行时动画与可玩工程；不要把这些说成扩散原画、骨骼动画或模型配音。

独立创作仍用 list_production_plans、create_production_plan、get_production_guide 读取固定规范。3D 资产用 get_game_model_plan 取得关联计划，再通过 create_model 提交并带 production_plan_id。3D 资产不自动进入当前 2D 探索引擎。具体工具以客户端当前实际提供的列表为准。

未连接 MCP 时按本地参考继续编写文本、规格和交接文档。不得因 Skill 已安装就声称 GPU、音频、绑定或引擎服务可调用；先核实实际工具。没有执行后端时交付可用的设计稿和生产规格，明确指出缺失能力，不伪造输出文件或完成状态。

生成完成后检查实际文件、自动检查报告和试玩结果。人工验收在网站完成，模型不得替代用户标记 approved。仅在用户明确要求公开时调用 publish_game；尚未批准时交付私有试玩与工程。未接入的游戏类型、原画、配音或引擎能力如实说明，不能把当前探索引擎包装成任意游戏生产能力。

每个阶段保留相同场景/资产/事件 ID，说明输入、输出、依赖和验证状态。正文与来源快照在 references；sources.lock.json 记录来源提交、MIT 许可及哈希。上游原文仅供追溯，实际使用的是经适配的中文规范，不执行 vendor 内的任何代码。
