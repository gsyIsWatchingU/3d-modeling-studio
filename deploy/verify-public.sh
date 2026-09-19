#!/bin/bash
# 验证脚本 - 检查服务是否正常运行
set -euo pipefail

PORT=${PORT:-3000}
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"

echo "=== 验证服务健康状态 ==="

# 等待服务启动
for i in {1..30}; do
    if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
        echo "✅ 服务健康检查通过: $HEALTH_URL"
        curl -s "$HEALTH_URL" | jq .
        exit 0
    fi
    echo "等待服务启动... ($i/30)"
    sleep 1
done

echo "❌ 服务健康检查失败"
exit 1
