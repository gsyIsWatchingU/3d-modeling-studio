#!/usr/bin/env bash
# 部署后的验收脚本：进程状态 → 本机健康检查 → 公网健康检查 → 打印公网地址
# 不做 set -e：每一步都要跑完并汇总，中途失败也要给出明确原因。
set -uo pipefail

PORT=${PORT:-3300}
APP_NAME=3d-modeling-studio
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"
SUPERVISOR="supervisorctl -c /workspace/etc/supervisord.conf"
FAIL=0

echo "=== 1. supervisor 进程状态 ==="
# 服务器 socket 不在 /var/run，必须带 -c 指定配置，否则报 no such file
for svc in "$APP_NAME" "cloudflared-$APP_NAME"; do
  status="$($SUPERVISOR status "$svc" 2>&1 | awk '{print $2}')"
  echo "$svc: ${status:-未知}"
  [[ "$status" == "RUNNING" ]] || FAIL=1
done

echo ""
echo "=== 2. 本机健康检查 ($HEALTH_URL) ==="
local_ok=0
for i in $(seq 1 30); do
  if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
    local_ok=1
    break
  fi
  echo "等待服务启动... ($i/30)"
  sleep 1
done
if [[ $local_ok -eq 1 ]]; then
  echo "本机健康检查通过：$(curl -s "$HEALTH_URL")"
else
  echo "本机健康检查失败：30 秒内 $HEALTH_URL 未响应"
  FAIL=1
fi

echo ""
echo "=== 3. 公网地址 ==="
PUBLIC_URL="$(bash "$(dirname "$0")/public-url.sh" 2>/dev/null || true)"
if [[ -z "$PUBLIC_URL" ]]; then
  echo "未取到公网地址：cloudflared 隧道可能尚未产出域名"
  FAIL=1
else
  echo "公网地址：$PUBLIC_URL"
  echo ""
  echo "=== 4. 公网可达性 ==="
  # 本机 WebFetch 常被沙箱拦，判定要看服务器侧的 curl 结果
  code="$(curl -sS -o /dev/null -m 20 -w '%{http_code}' "$PUBLIC_URL/" 2>/dev/null || echo 000)"
  health_code="$(curl -sS -o /dev/null -m 20 -w '%{http_code}' "$PUBLIC_URL/api/health" 2>/dev/null || echo 000)"
  echo "GET /          -> $code"
  echo "GET /api/health -> $health_code"
  [[ "$code" == "200" && "$health_code" == "200" ]] || FAIL=1
fi

echo ""
if [[ $FAIL -eq 0 ]]; then
  echo "$APP_NAME 部署验证通过"
else
  echo "$APP_NAME 部署验证未通过，见上方失败项" >&2
  exit 1
fi
