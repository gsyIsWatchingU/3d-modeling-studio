#!/usr/bin/env bash
set -euo pipefail
BACKEND="${1:?usage: install-runtime.sh tts|sfx}"
FACTORY_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PYTHON="${AUDIO_BASE_PYTHON:-/workspace/.tools/python/cpython-3.11-linux-x86_64-gnu/bin/python3.11}"
case "$BACKEND" in tts|sfx) ;; *) echo 'backend must be tts or sfx' >&2; exit 2 ;; esac
if [ "$BACKEND" = tts ]; then
  VENV=/workspace/.envs/game-audio-tts
  if [ ! -x "$VENV/bin/python" ]; then "$PYTHON" -m venv "$VENV"; fi
  "$VENV/bin/python" -m pip install torch==2.7.1 torchaudio==2.7.1 --index-url https://download.pytorch.org/whl/cu126
  "$VENV/bin/python" -m pip install qwen-tts==0.1.1 "$FACTORY_ROOT/production-skills/vendor/qwen3-tts-cli"
  "$VENV/bin/python" -m pip check
else
  # MOSS v2 使用独立 Python3.12 环境，保留既有 TTS / Forge3D 依赖。
  BOOTSTRAP=/workspace/.envs/game-audio-bootstrap
  if [ ! -x "$BOOTSTRAP/bin/python" ]; then "$PYTHON" -m venv "$BOOTSTRAP"; fi
  "$BOOTSTRAP/bin/python" -m pip install uv==0.12.18
  export UV_PYTHON_INSTALL_DIR=/workspace/.tools/python
  "$BOOTSTRAP/bin/uv" python install 3.12.14
  VENV=/workspace/.envs/game-audio-moss
  if [ ! -x "$VENV/bin/python" ]; then "$BOOTSTRAP/bin/uv" venv --python 3.12.14 "$VENV"; fi
  # 官方 PyTorch wheel；依赖从 PyPI 解析，避免 NVIDIA 索引重定向超时。
  "$BOOTSTRAP/bin/uv" pip install --python "$VENV/bin/python" --index-url https://pypi.org/simple \
    'https://download.pytorch.org/whl/cu126/torch-2.9.0%2Bcu126-cp312-cp312-manylinux_2_28_x86_64.whl' \
    'https://download.pytorch.org/whl/cu126/torchaudio-2.9.0%2Bcu126-cp312-cp312-manylinux_2_28_x86_64.whl' \
    'https://download.pytorch.org/whl/cu126/torchvision-0.24.0%2Bcu126-cp312-cp312-manylinux_2_28_x86_64.whl'
  SOURCE_ROOT=/workspace/models/game-audio/source
  COMMIT=934d6826b084c46a0d033402174d5f8ac4ed2519
  ARCHIVE="$SOURCE_ROOT/moss-$COMMIT.zip"
  mkdir -p "$SOURCE_ROOT"
  if [ ! -f "$ARCHIVE" ]; then
    curl -fL --retry 3 --max-time 180 "https://codeload.github.com/OpenMOSS/MOSS-TTS/zip/$COMMIT" -o "$ARCHIVE.part"
    mv "$ARCHIVE.part" "$ARCHIVE"
  fi
  printf '%s  %s\n' a0d3c10d24161eb7283dc5d88c10a164ca42c0e8d21e943a126403c18a598f09 "$ARCHIVE" | sha256sum -c -
  "$PYTHON" -m zipfile -e "$ARCHIVE" "$SOURCE_ROOT"
  "$BOOTSTRAP/bin/uv" pip install --python "$VENV/bin/python" "$SOURCE_ROOT/MOSS-TTS-$COMMIT/moss_soundeffect_v2"
  "$BOOTSTRAP/bin/uv" pip check --python "$VENV/bin/python"
fi
echo '运行环境已安装；下一步 prepare-model.py，再执行 doctor 与试生成。'
