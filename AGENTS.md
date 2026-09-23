# 项目约定

- 简洁中文，保留已有数据与其他任务的改动。
- 游戏音频生产先读 `production-skills/audio/SKILL.md` 与 `production-skills/gpu-audio/SKILL.md`，使用自有 GPU 工位。禁止商业生成 API 或本地合成回退。
- Skill 已安装、依赖就绪、权重已缓存、推理成功、人工试听通过分别记录；不能混写。GPU 产物默认待审核。
- 2D 一键生产在 `FACTORY_GPU_SFX=1` 时自动生成并组装三个 GPU 事件音效；程序配乐须如实标注，整版仍经人工试玩后才能发布。
