#!/usr/bin/env bash
# 启动单个 Multi-GPU 阶段 Worker（T4 或 CPU）。
# 用法:
#   worker.sh <capability> <gpu-index|-> [--api-url URL] [--token TOK] [--stage-timeout S]
set -euo pipefail

CAP="$1"
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
PY="${MP_PYTHON:-/workspace/runtime/python/bin/python3}"
WORKER_PY="$(dirname "$0")/worker.py"

GPU_ARGS=()
GPU_TAG="cpu"
if [[ "$GPU_INDEX" != "-" ]]; then
  GPU_ARGS=(--gpu-index "$GPU_INDEX")
  GPU_TAG="gpu$GPU_INDEX"
fi

HOST="$(hostname)"
exec "$PY" "$WORKER_PY" \
  --capability "$CAP" \
  --api-url "$API_URL" \
  --token "$TOKEN" \
  --host "$HOST" \
  --work-dir "$WORK_DIR" \
  --stage-timeout "$STAGE_TIMEOUT" \
  ${GPU_ARGS[@]+"${GPU_ARGS[@]}"} \
  > "$LOG_DIR/${CAP//:/_}.$GPU_TAG.log" 2>&1
