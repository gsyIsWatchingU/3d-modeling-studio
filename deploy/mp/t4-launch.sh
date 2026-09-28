#!/usr/bin/env bash
# T4 四卡 Worker 启动脚本（幂等，可重复执行）。
# 4 × GPU Worker：CUDA_VISIBLE_DEVICES=0..3，能力 shape:t4
# 说明：T4 为 Ubuntu 18.04（glibc 2.27），UniRig 依赖的 bpy/独立 Blender 需要 glibc 2.28+，
#       故 rig 由 gsy013 L20 Worker 承担（rig:l20，见 gsy013-launch.sh）；Blender 类 CPU 阶段
#       （draft_preview/candidate_qc/normalize/export/preview/validate/retarget_animation）
#       同样由 gsy013 的 CPU Worker 承担。
set -euo pipefail

TOKEN_FILE=/workspace/etc/mp-worker-token
[ -f "$TOKEN_FILE" ] || { echo "缺少 $TOKEN_FILE" >&2; exit 21; }
TOKEN=$(tr -d '\n' < "$TOKEN_FILE")
export MP_WORKER_TOKEN="$TOKEN"
export MP_API_URL="${MP_API_URL:-http://10.42.0.166:3300}"

# Shape 质量参数（T4 单卡探针实测，red-sweater-boy 参考图，seed 20260928）：
#   steps 30→50：模型自带默认值，+52s，峰值显存不变（8873MiB），表面保真更好。
#   octree 384→512：峰值 10025MiB < 15360MiB（T4 安全），面数 274k→488k，几何更锐；+210s/候选。
# shape 仅占总耗时小头且 4 卡并行，多出的时间被 Blender CPU 扩容省下的排队远超抵消。
# 想让 shape 更快可用环境变量覆盖：FORGE3D_SHAPE_OCTREE=384 / FORGE3D_SHAPE_STEPS=30。
export FORGE3D_SHAPE_STEPS="${FORGE3D_SHAPE_STEPS:-50}"
export FORGE3D_SHAPE_OCTREE="${FORGE3D_SHAPE_OCTREE:-512}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_DIR=/workspace/runtime/worker-pids
mkdir -p "$PID_DIR" /workspace/logs/mp /workspace/runtime/work

GPU_CAPS="shape:t4"

start_worker() {
  local name="$1" caps="$2" gpu="$3"
  local pid_file="$PID_DIR/$name.pid"
  if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    echo "$name 已在运行 pid=$(cat "$pid_file")"
    return 0
  fi
  nohup bash "$SCRIPT_DIR/worker.sh" "$caps" "$gpu" >/dev/null 2>&1 &
  echo $! > "$pid_file"
  echo "$name 已启动 pid=$! (gpu=$gpu)"
}

start_worker worker-gpu0 "$GPU_CAPS" 0
start_worker worker-gpu1 "$GPU_CAPS" 1
start_worker worker-gpu2 "$GPU_CAPS" 2
start_worker worker-gpu3 "$GPU_CAPS" 3

echo "=== 进程 ==="
for f in "$PID_DIR"/*.pid; do
  echo "$(basename "$f"): $(cat "$f")"
done
