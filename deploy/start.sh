#!/usr/bin/env bash
# 部署入口：**只做「装依赖 + 建目录」，不重启任何 supervisor 服务。**
#
# 为什么这里绝不能出现 supervisorctl restart：
# 之前 supervisor.conf 的 command 指向的就是本脚本，脚本一进来又去 restart 自己，
# supervisor 认为进程退出并重新拉起 → 无限自我重启。现在 command 直接是 node，
# 本脚本退化为纯「准备运行环境」，重启由部署流程显式执行。
set -euo pipefail

APP=/workspace/projects/3d-modeling-studio
PORT=${PORT:-3300}

cd "$APP"

# 服务器上 node 不在默认 PATH，必须显式前置，
# 否则 npm wrapper 的 #!/usr/bin/env node 会报 "env: node: No such file or directory"
export PATH=/workspace/.tools/node-v20/bin:$PATH
export NODE_ENV=production
export PORT

# 可选：项目自带的 .env（Forge3D 与通知配置等）。要求是 KEY=VALUE，等号两侧不要留空格。
if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

export DB_PATH="${DB_PATH:-$APP/data/db.json}"
export UPLOAD_DIR="${UPLOAD_DIR:-$APP/data/uploads}"
export MODEL_DIR="${MODEL_DIR:-$APP/data/models}"

# 数据与日志目录。data/ 必须在发布时被保留（见 apply-release.sh 的 --exclude），
# 否则每次部署都会把上传的原图和生成的模型删掉。
mkdir -p "$UPLOAD_DIR" "$MODEL_DIR" /workspace/logs/3d-modeling-studio

# 依赖目录缺失，或 package-lock 更新后依赖不完整时安装（走国内镜像）
if [ ! -d node_modules ] || [ -z "$(ls -A node_modules 2>/dev/null)" ] || ! npm ls --omit=dev --depth=0 >/dev/null 2>&1; then
  npm ci --omit=dev --registry=https://registry.npmmirror.com
fi

# 语法校验：改动一多，最容易漏的是语法错，起不来才知道就晚了
node --check server/index.js
node --check server/db.js
node --check server/utils.js
node --check server/image-board.js
node --check server/model-worker.js
node --check server/notifier.js
node --check server/auth.js
node --check server/skill-plan.js
node --check public/main.js
node --check public/auth.js

echo "依赖与目录就绪，端口 $PORT。"
echo "重启请用（必须带 -c，服务器 socket 不在默认路径）："
echo "  supervisorctl -c /workspace/etc/supervisord.conf restart 3d-modeling-studio"
