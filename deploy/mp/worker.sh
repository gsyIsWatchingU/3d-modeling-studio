#!/usr/bin/env bash
# 启动单个 Multi-GPU 阶段 Worker（T4 或 CPU）。
# 用法:
#   worker.sh <capabilities(逗号分隔)> <gpu-index|-> [--stage-timeout S]
#   capabilities 示例: GPU -> shape:t4,rig:t4,animation:t4
#                     CPU -> draft_preview:t4,candidate_qc:t4,normalize:t4,export:t4,preview:t4,validate:t4
set -euo pipefail

CAPS="$1"
GPU_INDEX="${2:--}"
API_URL="${MP_API_URL:-http://10.42.0.166:3300}"
TOKEN="${MP_WORKER_TOKEN:-}"
STAGE_TIMEOUT="${MP_STAGE_TIMEOUT:-3600}"
WORK_DIR="${MP_WORK_DIR:-/workspace/runtime/work}"
LOG_DIR="${MP_LOG_DIR:-/workspace/logs/mp}"

if [[ -z "$TOKEN" ]]; then
  echo "缺少 MP_WORKER_TOKEN" >&2
  exit 21
fi

mkdir -p "$WORK_DIR" "$LOG_DIR"
PY="${MP_PYTHON:-/workspace/runtime/hunyuan3d/bin/python}"
WORKER_PY="$(dirname "$0")/worker.py"

GPU_ARGS=()
GPU_TAG="cpu"
if [[ "$GPU_INDEX" != "-" ]]; then
  GPU_ARGS=(--gpu-index "$GPU_INDEX")
  GPU_TAG="gpu$GPU_INDEX"
fi

HOST="$(hostname)"
WORKER_TAG="${MP_WORKER_TAG:-}"
LOG_NAME="${CAPS%%:*}.$GPU_TAG${WORKER_TAG:+.$WORKER_TAG}.log"
exec "$PY" "$WORKER_PY" \
  --capabilities "$CAPS" \
  --api-url "$API_URL" \
  --token "$TOKEN" \
  --host "$HOST" \
  --work-dir "$WORK_DIR" \
  --stage-timeout "$STAGE_TIMEOUT" \
  ${GPU_ARGS[@]+"${GPU_ARGS[@]}"} \
  > "$LOG_DIR/$LOG_NAME" 2>&1
