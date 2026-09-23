#!/usr/bin/env bash
set -euo pipefail

input_path="$1"
output_path="$2"
rig_limits_json="${3:-}"
if [[ -z "$rig_limits_json" ]]; then
  rig_limits_json='{}'
fi
repo="${FORGE3D_UNIRIG_REPO:-/workspace/projects/forge3d/vendor/UniRig}"
python_bin="${FORGE3D_UNIRIG_PYTHON:-/workspace/.envs/unirig/bin/python}"

export PYOPENGL_PLATFORM="${PYOPENGL_PLATFORM:-osmesa}"
export HF_HOME="${HF_HOME:-/workspace/models/forge3d/huggingface}"
export HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}"

if [[ ! -f "$repo/launch/inference/generate_skeleton.sh" ]]; then
  echo "UniRig 推理入口不存在" >&2
  exit 20
fi

exec "$python_bin" "$FORGE3D_PROJECT_ROOT/scripts/unirig_generate.py" \
  --repo "$repo" \
  --input "$input_path" \
  --output "$output_path" \
  --python "$python_bin" \
  --blender "${FORGE3D_BLENDER:-/workspace/.tools/blender/blender}" \
  --rig-analyzer "$FORGE3D_PROJECT_ROOT/blender/analyze_rig_structure.py" \
  --rig-limits-json "$rig_limits_json"
