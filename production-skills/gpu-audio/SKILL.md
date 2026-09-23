---
name: gpu-game-audio
description: 通过自有 GPU 游戏工厂生产脚步、环境音、动作音效与中文角色对白，保留任务与来源记录。用于游戏音频生成和工位检查，不用于商业音频 API 或浏览器合成。
---

# GPU 游戏音频

## 执行位置

- 工厂仓库：`E:/prj-gsy/3d-modeling-studio`。
- 远端：`ssh mygpu`，根目录 `/workspace/projects/3d-modeling-studio`，入口 `tools/gpu-audio/audio_factory.py`。
- 素材只在自有服务器 CUDA 模型上生成。Codex 负责编排、代码和验收；不使用 Codex/ImageGen、豆包、ElevenLabs 等生成额度，也不退回 CPU/浏览器合成。
- 脚步、雨声、木响等：MOSS-SoundEffect v2.0；中文对白：Qwen3-TTS 1.7B CustomVoice。模型环境分别位于 `/workspace/.envs/game-audio-moss` 与 `/workspace/.envs/game-audio-tts`。
- 固定来源在工厂 `production-skills/sources.lock.json`；上游 Skill 与许可证在 `production-skills/vendor`。执行上游代码前按锁定版本核验，不任意更新。

## 准备与检查

```bash
cd /workspace/projects/3d-modeling-studio
python3 tools/gpu-audio/audio_factory.py doctor
bash tools/gpu-audio/install-runtime.sh tts
# MOSS v2 使用独立 Python 3.12 环境，无需注册账号。
bash tools/gpu-audio/install-runtime.sh sfx
/workspace/.envs/game-audio-tts/bin/python tools/gpu-audio/prepare-model.py tts
/workspace/.envs/game-audio-moss/bin/python tools/gpu-audio/prepare-model.py sfx
```

MOSS v2 官方公开权重无需账号或 Token，固定模型 revision，匿名下载。网络需要时，可用 HF_ENDPOINT=https://hf-mirror.com 下载这些公开、非门控权重；生成时只读本地缓存。旧 Stable Audio 环境保留但不再作为生成入口。依赖安装、权重缓存、CUDA 推理验证、人工试听是不同状态。`doctor` 不会伪称已试听或推理成功。

新推理前检查 `nvidia-smi` 与 Forge3D 队列，选择空闲卡；不停止其他服务。工位使用串行锁，音效至少预留 20 GiB、配音至少预留 12 GiB 显存，并拒绝繁忙 GPU；它不能替代全服务器调度。

## 生产

为每个事件建立 JSON 请求。`project_id`、`event_id` 仅用小写字母、数字、下划线和连字符；`backend` 为 `tts` 或 `sfx`。音效填中文或英文 `prompt`、`duration`（0.5～30 秒）、`variants`（1～8）、`seed`、`loop`；配音填中文 `text`、`speaker`、`instruct`、`seed`。示例在 `tools/gpu-audio/examples/`。

```bash
python3 tools/gpu-audio/audio_factory.py generate \
  --request tools/gpu-audio/examples/footsteps.json --gpu 0
python3 tools/gpu-audio/audio_factory.py generate \
  --request tools/gpu-audio/examples/dialogue.json --gpu 0
```

同请求与同版本流水线复用已校验产物；不同项目、事件、参数、代码或规范进入独立任务目录。产物在 `/workspace/3d-assets/game-audio/<project>/<event>/<job>/`，含 WAV、请求、manifest、推理证据与日志。失败不生成假音频、不覆盖旧交付。

产物记录 CUDA 设备、模型快照与权重哈希、Skill/代码哈希、种子、采样率、时长、峰值和 RMS。完成状态为 `review`，人工试听状态为 `pending`；不得自动标记 approved。

## 制作与接入

每个事件先明确材质、声源、距离、触发点、时长和变体；脚步按实际落脚触发，停止行走即停止调度。对白逐句绑定角色与台词 ID，音色稳定，跳过和切场停止旧句。音景保留前景细节和安静空间，避免持续铺满恐怖低频。

生成后先试听候选，再在服务器裁切、处理响度和循环、导出目标编码。未经试听不宣称高质量；未通过人工验收不接入正式游戏。旧版 2D 一键生产仍是程序声音；GPU 工位为独立资产生产入口，需要按各游戏事件接入。

自检：干声和混音均试听；手机外放与耳机可辨认；无削波、爆音、错误发音和明显循环接缝；暂停、静音、切关、跳过对话均正确停止声音。
