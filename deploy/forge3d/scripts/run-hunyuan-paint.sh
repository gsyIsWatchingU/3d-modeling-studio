#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "用法: $0 <mesh.glb> <reference.png> <output.glb> [views] [resolution] [asset-kind] [roughness-floor] [specular-level]" >&2
  exit 2
fi

project_root="${FORGE3D_PROJECT_ROOT:-/workspace/projects/forge3d}"
repo_root="$project_root/vendor/Hunyuan3D-2.1"
python_bin="/workspace/.envs/hunyuan3d/bin/python"

export HF_HOME="${HF_HOME:-/workspace/models/forge3d/huggingface}"
export HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}"
export CUDA_HOME="${CUDA_HOME:-/usr/local/cuda-12.4}"
export PATH="$CUDA_HOME/bin:$PATH"
export PYTHONPATH="$repo_root/hy3dpaint:$repo_root/hy3dpaint/custom_rasterizer${PYTHONPATH:+:$PYTHONPATH}"

exec "$python_bin" "$project_root/scripts/hunyuan_paint.py" \
  --repo "$repo_root" \
  --mesh "$1" \
  --image "$2" \
  --output "$3" \
  --views "${4:-8}" \
  --resolution "${5:-768}" \
  --asset-kind "${6:-prop}" \
  --roughness-floor "${7:-0.32}" \
  --specular-level "${8:-0.35}" \
  --prompt "${9:-high quality}" \
  "${10:---remesh}"
