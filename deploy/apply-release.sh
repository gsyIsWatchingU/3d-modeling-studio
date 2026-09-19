#!/bin/bash
# 发布脚本 - 应用新版本到部署目录
set -euo pipefail

RELEASE_DIR="$1"
DEPLOY_PATH="$2"

echo "=== 应用新版本到 $DEPLOY_PATH ==="

# 复制代码（保留data目录和.env）
rsync -av --delete \
  --exclude='data/' \
  --exclude='.env' \
  --exclude='node_modules/' \
  --exclude='.deploy-tmp/' \
  --exclude='run/' \
  "$RELEASE_DIR/" "$DEPLOY_PATH/"

# 安装依赖
cd "$DEPLOY_PATH"
npm ci --production

# 创建必要目录
mkdir -p data/uploads data/models run logs

echo "=== 新版本应用完成 ==="
