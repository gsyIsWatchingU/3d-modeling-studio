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
| 音效、配音、配乐 | [声音](references/audio/SKILL.md) |
| UI、特效、引擎与性能 | [集成](references/integration/SKILL.md) |
| 试玩、交付 | [验收](references/qa/SKILL.md) |

保留用户的引擎、平台、风格与原有工程。涉及《川流不息》时同时读取已安装的 chuanliu-creative-direction 及其对应领域参考；通用规范不覆盖该游戏的正史、风格、GPU 生产限制或人工 approved 门禁。

若已连接建模平台 MCP，先用 list_production_plans 找已有计划；需要新计划时用 create_production_plan 保存目标和规范版本，再用 get_production_guide 读取对应计划的完整 Skill。MCP 提交模型时带 production_plan_id，平台会自动注入固定建模规范及计划目标。具体工具以客户端当前实际提供的列表为准。

未连接 MCP 时按本地参考继续编写文本、规格和交接文档。不得因 Skill 已安装就声称 GPU、音频、绑定或引擎服务可调用；先核实实际工具。没有执行后端时交付可用的设计稿和生产规格，明确指出缺失能力，不伪造输出文件或完成状态。

剧本、音效提示词、动作规格可由当前 AI 编写；音频和动画文件必须通过可用的生产工具生成并验收。建模网站当前只执行静态 3D 建模，音频生成、绑定动画、引擎集成未通过该网站执行。

每个阶段保留相同场景/资产/事件 ID，说明输入、输出、依赖和验证状态。正文与来源快照在 references；sources.lock.json 记录来源提交、MIT 许可及哈希。上游原文仅供追溯，实际使用的是经适配的中文规范，不执行 vendor 内的任何代码。
