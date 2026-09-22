# 3D建模工作室 - 部署指南

按照公司GPU服务器标准部署流程：

## 统一账号 SSO 接入说明

本站使用 Algorithm Lab 统一账号中心（`SSO_AUTH_BASE_URL=https://gsy-gpu.tail660bdf.ts.net`，client_id `3d-modeling-studio`）：

- 后端认证在 `server/auth.js`：JSON 代理（`/auth/register-code|register|login`）+ SSO 跳转（`/auth/sso/start|callback`，OAuth2 授权码 + PKCE）+ 本地会话（`/me`、`/logout`）。密码只存在账号中心，本地 `db.json` 的 `users.password` 是 `sso:` 占位符。
- 前端：`public/login.html` 登录/注册页 + `public/auth.js` + `main.js` 启动守卫。Skill、个人设置、任务和模型下载要求登录，并校验所属用户；健康检查公开。
- `SSO_CLIENTS_JSON` 在账号中心 `/workspace/algorithm-lab/.env` 注册，`redirectUri` 必须与本站 `PUBLIC_URL`（`deploy/supervisor.conf` 的 environment）**完全一致**。

> **注意：Quick Tunnel 地址每次隧道重启都会变**。隧道地址变了之后，必须同时更新两处再重启，否则 SSO 跳转失效：
> 1. 账号中心 `.env` 的 `SSO_CLIENTS_JSON` → `3d-modeling-studio.redirectUris`（改完 `supervisorctl -c /workspace/etc/supervisord.conf restart web`）
> 2. 本仓库 `deploy/supervisor.conf` 的 `PUBLIC_URL`（改完 `supervisorctl reread && update && restart 3d-modeling-studio`，**不要重启 cloudflared**）

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
# 编辑 .env 填入 Forge3D 与通知配置
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
