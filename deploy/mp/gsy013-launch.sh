#!/usr/bin/env bash
# gsy013 CPU Worker 启动脚本（幂等，可重复执行）。
# 6 × CPU Worker（数量可用 MP_CPU_WORKERS 调整）：Blender 类阶段。
# 背景：T4（Ubuntu 18.04 / glibc 2.27）无法运行 Blender 4.5.13（需 glibc 2.28+），
#       gsy013 为 Ubuntu 22.04 且 Blender 4.5.13 运行正常，故 CPU/Blender 阶段在此执行。
#       本机 128 核 / ~470GB 空闲内存，2 个 worker 会让 draft_preview/normalize/export/
#       validate 等阶段严重排队（实测 wall 是 run 的 7-16 倍），故扩容到 6 个。
# 能力：draft_preview / candidate_qc / normalize / export / preview / validate / retarget_animation
set -euo pipefail

TOKEN_FILE=/workspace/etc/mp-worker-token
[ -f "$TOKEN_FILE" ] || { echo "缺少 $TOKEN_FILE" >&2; exit 21; }
TOKEN=$(tr -d '\n' < "$TOKEN_FILE")
export MP_WORKER_TOKEN="$TOKEN"
export MP_API_URL="${MP_API_URL:-http://10.42.0.166:3300}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_DIR=/workspace/runtime/worker-pids
mkdir -p "$PID_DIR" /workspace/logs/mp /workspace/runtime/work

# gsy013 环境覆盖（worker.py env_base 的 T4 默认值不适用）
export FORGE3D_PROJECT_ROOT="${FORGE3D_PROJECT_ROOT:-/workspace/projects/forge3d}"
export FORGE3D_MODEL_ROOT="${FORGE3D_MODEL_ROOT:-/workspace/models/forge3d}"
export FORGE3D_DATA_ROOT="${FORGE3D_DATA_ROOT:-/workspace/3d-assets}"
export FORGE3D_BLENDER="${FORGE3D_BLENDER:-/workspace/.tools/blender/blender}"
export FORGE3D_HUNYUAN_PYTHON="${FORGE3D_HUNYUAN_PYTHON:-/workspace/.envs/hunyuan3d/bin/python}"
export FORGE3D_UNIRIG_PYTHON="${FORGE3D_UNIRIG_PYTHON:-/workspace/.envs/unirig/bin/python}"
export HF_HOME="${HF_HOME:-/workspace/models/forge3d/huggingface}"
export HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}"
export HY3DGEN_MODELS="${HY3DGEN_MODELS:-/workspace/models/forge3d/hy3dgen}"
export U2NET_HOME="${U2NET_HOME:-/workspace/models/forge3d/rembg}"
export FORGE3D_ENABLE_PBR="${FORGE3D_ENABLE_PBR:-0}"
export MP_PYTHON="${MP_PYTHON:-/workspace/.envs/hunyuan3d/bin/python}"

CPU_CAPS="draft_preview:t4,candidate_qc:t4,normalize:t4,export:t4,preview:t4,validate:t4,animation:t4"
# UniRig（rig）依赖 bpy/独立 Blender（需 glibc 2.28+），T4（glibc 2.27）不可运行，
# 由本机 L20 GPU Worker 执行（能力 rig:l20）。与 forge3d worker 并发使用 L20，
# 46GB 显存可容纳 paint+rig 同跑；若出现 OOM 需回退为排队串行。
RIG_CAPS="rig:l20"

start_worker() {
  local name="$1" caps="$2" gpu="$3"
  local pid_file="$PID_DIR/$name.pid"
  if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    echo "$name 已在运行 pid=$(cat "$pid_file")"
    return 0
  fi
  MP_WORKER_TAG="$name" nohup bash "$SCRIPT_DIR/worker.sh" "$caps" "$gpu" >/dev/null 2>&1 &
  echo $! > "$pid_file"
  echo "$name 已启动 pid=$! (gpu=$gpu)"
}

CPU_WORKERS="${MP_CPU_WORKERS:-6}"
for i in $(seq 0 $((CPU_WORKERS - 1))); do
  start_worker "worker-cpu$i" "$CPU_CAPS" -
done
start_worker worker-gpu0 "$RIG_CAPS" 0

echo "=== 进程 ==="
for f in "$PID_DIR"/*.pid; do
  echo "$(basename "$f"): $(cat "$f")"
done
