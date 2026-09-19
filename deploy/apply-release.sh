#!/usr/bin/env bash
# 发布脚本 - 把 CI 上传的新版本覆盖到部署目录
# 用法：bash deploy/apply-release.sh <解压后的新版本目录> <部署目录>
#
# 关键约定：**被保护的路径必须显式写进 --exclude**。
# --delete 是按目标目录清理的：任何不在这个排除列表里、且新版本没有的目录都会被删掉，
# data/（上传的原图与生成的模型）、run/（部署标记 deployed-commit）、logs/ 一旦漏写
# 就是真实的线上数据丢失。
set -euo pipefail

RELEASE_DIR="$1"
DEPLOY_PATH="$2"

if [[ -z "${RELEASE_DIR:-}" || -z "${DEPLOY_PATH:-}" ]]; then
  echo "用法: $0 <新版本目录> <部署目录>" >&2
  exit 1
fi

echo "=== 应用新版本到 $DEPLOY_PATH ==="

mkdir -p "$DEPLOY_PATH"

# 复制代码（保留数据、日志、部署标记与环境变量）
# 服务器可能没装 rsync，有则用增量覆盖，没有就退回 tar 管道，不要因为缺 rsync 让部署失败
if command -v rsync >/dev/null 2>&1; then
  rsync -av --delete \
    --exclude='data/' \
    --exclude='logs/' \
    --exclude='run/' \
    --exclude='.env' \
    --exclude='node_modules/' \
    --exclude='.git/' \
    --exclude='.deploy-tmp/' \
    "$RELEASE_DIR/" "$DEPLOY_PATH/"
else
  echo "[warn] 未找到 rsync，改用 tar 覆盖（不会删除被保护目录之外的旧文件）"
  tar -C "$RELEASE_DIR" -cf - --exclude='./data' --exclude='./logs' \
    --exclude='./run' --exclude='./node_modules' --exclude='./.git' . \
    | tar -C "$DEPLOY_PATH" -xf -
fi

# 安装依赖 + 建目录（start.sh 里已含 node PATH、镜像与语法校验）
cd "$DEPLOY_PATH"
bash deploy/start.sh

echo "=== 新版本应用完成 ==="
