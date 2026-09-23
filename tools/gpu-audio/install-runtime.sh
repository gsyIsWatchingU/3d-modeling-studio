#!/usr/bin/env bash
set -euo pipefail
BACKEND="${1:?usage: install-runtime.sh tts|sfx}"
FACTORY_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PYTHON="${AUDIO_BASE_PYTHON:-/workspace/.tools/python/cpython-3.11-linux-x86_64-gnu/bin/python3.11}"
case "$BACKEND" in tts|sfx) ;; *) echo 'backend must be tts or sfx' >&2; exit 2 ;; esac
VENV="/workspace/.envs/game-audio-$BACKEND"
if [ ! -x "$VENV/bin/python" ]; then "$PYTHON" -m venv "$VENV"; fi
"$VENV/bin/python" -m pip install --upgrade pip
if [ "$BACKEND" = tts ]; then
  "$VENV/bin/python" -m pip install torch==2.7.1 torchaudio==2.7.1 --index-url https://download.pytorch.org/whl/cu126
  "$VENV/bin/python" -m pip install qwen-tts==0.1.1 "$FACTORY_ROOT/production-skills/vendor/qwen3-tts-cli"
else
  # 固定源码，使用独立环境；不修改 Forge3D、ASR 或其他模型依赖。
  "$VENV/bin/python" -m pip install torch==2.7.1 torchaudio==2.7.1 --index-url https://download.pytorch.org/whl/cu126
  "$VENV/bin/python" -m pip install 'https://github.com/Stability-AI/stable-audio-3/archive/779434a908193105335fd8d833418603625b2859.zip'
  "$VENV/bin/python" -c 'from flash_attn import flash_attn_func' || { echo 'Stable Audio Medium 还需与当前 Python/PyTorch/CUDA 匹配的 Flash Attention 2；未就绪，禁止生成。' >&2; exit 1; }
fi
"$VENV/bin/python" -m pip check
echo '运行环境已安装；下一步 prepare-model.py，再执行 doctor 与试生成。'
