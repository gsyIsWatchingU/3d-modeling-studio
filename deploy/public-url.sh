#!/usr/bin/env bash
set -euo pipefail

LOG_DIR="/workspace/logs/3d-modeling-studio"
PUBLIC_URL="$(grep -Eho 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG_DIR"/cloudflared.out.log "$LOG_DIR"/cloudflared.err.log 2>/dev/null | tail -1 || true)"

if [[ -z "$PUBLIC_URL" ]]; then
  echo "尚未发现公网地址，请检查 cloudflared-3d-modeling-studio 状态和日志。" >&2
  exit 1
fi

echo "$PUBLIC_URL"
