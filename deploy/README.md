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
# 查看状态
sudo supervisorctl status 3d-modeling-studio

# 重启
sudo supervisorctl restart 3d-modeling-studio

# 查看日志
tail -f /workspace/logs/3d-modeling-studio/out.log
tail -f /workspace/logs/3d-modeling-studio/err.log
```

## 访问地址

服务启动后，通过服务器IP + 端口访问：
```
http://<gpu-server-ip>:3000
```

## 目录结构（服务器上）

```
/workspace/
├── projects/
│   └── 3d-modeling-studio/     # 代码
│       ├── server/
│       ├── public/
│       ├── deploy/
│       └── package.json
├── data/
│   └── 3d-modeling-studio/     # 数据存储
│       ├── db.json
│       ├── uploads/
│       └── models/
└── logs/
    └── 3d-modeling-studio/     # 日志
        ├── out.log
        └── err.log
```
