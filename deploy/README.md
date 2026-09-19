# 3D建模工作室 - 部署指南

按照公司GPU服务器标准部署流程：

## 部署步骤

### 1. 上传代码到服务器

```bash
# 代码放在这个路径
/workspace/projects/3d-modeling-studio/
```

把项目所有文件上传到这个目录。

### 2. 安装依赖

```bash
cd /workspace/projects/3d-modeling-studio
npm install --production
```

### 3. 配置环境变量

```bash
cd deploy
cp .env.example .env
# 编辑 .env 填入你的SPU服务地址
vi .env
```

### 4. 配置supervisor

```bash
# 把supervisor.conf加到supervisor配置中
sudo cp supervisor.conf /etc/supervisor/conf.d/3d-modeling-studio.conf

# 重新加载supervisor
sudo supervisorctl update
sudo supervisorctl start 3d-modeling-studio
```

### 5. 创建日志和数据目录

```bash
sudo mkdir -p /workspace/logs/3d-modeling-studio
sudo mkdir -p /workspace/data/3d-modeling-studio/uploads
sudo mkdir -p /workspace/data/3d-modeling-studio/models
```

## 常用命令

```bash
# 查看状态（socket 不在默认路径，必须带 -c；服务器是 root，不用 sudo）
supervisorctl -c /workspace/etc/supervisord.conf status 3d-modeling-studio

# 重启
supervisorctl -c /workspace/etc/supervisord.conf restart 3d-modeling-studio

# 查看日志
tail -f /workspace/logs/3d-modeling-studio/out.log
tail -f /workspace/logs/3d-modeling-studio/err.log
```

## 访问地址

服务只监听本机 `127.0.0.1:3300`，公网入口是 cloudflared Quick Tunnel，**域名是随机的、隧道每次重启都会变**：

```bash
cd /workspace/projects/3d-modeling-studio && bash deploy/public-url.sh
# 或跑完整验收：进程状态 + 本机/公网健康检查 + 打印地址
bash deploy/verify-public.sh
```

它输出形如 `https://xxxx.trycloudflare.com`。不要用「服务器 IP + 端口」这种方式对外访问。

## 目录结构（服务器上）

```
/workspace/
├── projects/
│   └── 3d-modeling-studio/     # 代码
│       ├── server/
│       ├── public/
│       ├── deploy/
│       │   ├── supervisor.conf     # 被主配置的 [include] 引入
│       │   └── cloudflared.conf    # 公网隧道
│       ├── data/               # 数据存储（发布时被 --exclude 保护）
│       │   ├── db.json
│       │   ├── uploads/
│       │   └── models/
│       └── run/                # deployed-commit 等部署标记
└── logs/
    └── 3d-modeling-studio/     # 日志
        ├── out.log
        └── err.log
```
