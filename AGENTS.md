# 项目约定

- 简洁中文，保留已有数据与其他任务的改动。
- 游戏音频生产先读 `production-skills/audio/SKILL.md` 与 `production-skills/gpu-audio/SKILL.md`，使用自有 GPU 工位。禁止商业生成 API 或本地合成回退。
- Skill 已安装、依赖就绪、权重已缓存、推理成功、人工试听通过分别记录；不能混写。GPU 产物默认待审核。
- 2D 一键生产在 `FACTORY_GPU_SFX=1` 时自动生成并组装三个 GPU 事件音效；程序配乐须如实标注，整版仍经人工试玩后才能发布。
- 首页是 3D 建模工位：`server/index.js` 的 `/` 直接返回 `public/modeling.html`；资源工作室 / 游戏工厂 / 模型进化是 modeling.html 内同页 tab，经 iframe 以 `?embed=1` 嵌入 `index.html` / `game-factory.html` / `evolution.html`（嵌入时隐藏各自顶栏，`studio-embed` 类控制）。改首页默认内容改 modeling.html，不要改 index.html；独立访问三个子页仍有效。
