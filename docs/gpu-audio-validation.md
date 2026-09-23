# GPU 音频工位验收（2026-09-23）

- 音效改用 MOSS-SoundEffect v2.0（代码与权重 Apache-2.0），匿名下载官方公开权重，无需 Hugging Face 账号。中文对白使用 Qwen3-TTS 1.7B。
- 全局 `gpu-game-audio`、`qwen3-tts` 与 `game-production-workflow` 已配置；工厂音频规范 v4，26 项来源文件固定版本及 SHA-256。
- 全部 26 项 Node 测试通过；GPU 工位 7 项测试通过，覆盖无回退、请求边界、缓存完整性、项目隔离、繁忙拒绝与显存余量。
- MOSS 的独立 Python 3.12 / PyTorch 2.9.0 CUDA 12.6 环境安装、重复执行安装脚本、147 项依赖检查通过。
- MOSS 在 `mygpu` L20 上生成 3 段木桥脚步候选：每段 6 秒、48 kHz、单声道。扩散模型、文本编码器、VAE 均为 `cuda:0`；峰值显存约 14.51 GiB，工位预留门槛设为 20 GiB。
- 音效任务：`7e1765337c787ace8092f682`，目录 `/workspace/3d-assets/game-audio/bridge-after-rain/footstep_wood_walk/7e1765337c787ace8092f682/`。
- 第一段 SHA-256：`f6576d8ddddd93c368b297976f03fa919842098126a50771821bfdb81e894682`；3 段 RMS 均非静音，无非有限样本，超过 0.95 的峰值仅作衰减。
- 模型固定 revision：`e35df4d82fbe87fcd5d14e5d100e349c0c3c076d`；权重和配置哈希、种子、代码及 Skill 哈希均保存在任务清单。
- Qwen3-TTS 的真实 CUDA 配音任务：`ac9602f1399a0b6ec35752b3`；“别怕，拉住我的手。我们一起过桥。”，24 kHz、单声道、3.04 秒，本机 ASR 回读内容一致。
- 对白 SHA-256：`5ab8c0c14992b291e5ff3fa8a67383113100bbdd87e5a5e2fe00d0f2328988a7`。
- 所有样本保持 `review/pending`，技术检查不代表听感、表演或循环验收。正式素材接入须完成试听、裁切与事件绑定。
- 未修改《仙境之桥》运行素材或 ZIP。旧 Stable Audio 依赖环境保留，已退出默认音效路由；旧 2D 一键生产也不会自动调用本工位。
