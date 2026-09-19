#!/bin/bash
# 验证脚本 - 检查服务是否正常运行
set -euo pipefail

PORT=${PORT:-3000}
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"

echo "=== 验证本地服务健康状态 ==="

# 等待服务启动
for i in {1..30}; do
    if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
        echo "✅ 本地服务健康检查通过: $HEALTH_URL"
        curl -s "$HEALTH_URL" | jq .
        break
    fi
    echo "等待服务启动... ($i/30)"
    sleep 1
done

echo ""
echo "=== 获取公网访问地址 ==="
bash "$(dirname "$0")/public-url.sh"
