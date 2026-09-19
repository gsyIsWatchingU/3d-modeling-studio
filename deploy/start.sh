#!/bin/bash
# 3D建模工作室启动脚本

cd /workspace/projects/3d-modeling-studio

# 加载环境变量
if [ -f .env ]; then
    export $(cat .env | xargs)
fi

# 默认配置
export PORT=${PORT:-3000}
export DB_PATH=${DB_PATH:-/workspace/data/3d-modeling-studio/db.json}
export UPLOAD_DIR=${UPLOAD_DIR:-/workspace/data/3d-modeling-studio/uploads}
export MODEL_DIR=${MODEL_DIR:-/workspace/data/3d-modeling-studio/models}

# 创建数据目录
mkdir -p /workspace/data/3d-modeling-studio/uploads
mkdir -p /workspace/data/3d-modeling-studio/models
mkdir -p /workspace/logs/3d-modeling-studio

# 重启服务
if command -v supervisorctl &> /dev/null; then
    supervisorctl restart 3d-modeling-studio || supervisorctl start 3d-modeling-studio
    echo "服务已通过supervisor重启"
else
    # 直接启动（开发模式）
    exec node server/index.js
fi
