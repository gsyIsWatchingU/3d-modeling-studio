# 3D 建模工作室

全栈3D建模工具，支持CI/CD自动部署到GPU服务器，公网可访问。

## CI/CD 自动部署

**推送代码到 main 分支即可自动部署：**

```bash
git add .
git commit -m "你的更新"
git push origin main
```

**前提**：GPU 服务器上要有本仓库专属的 self-hosted runner（标签 `3d-modeling-studio`）。
没有 runner 时 workflow 会一直排队到被取消。

**自动流程：**
1. GitHub Actions 触发 CI 构建检查（`ubuntu-latest`：装依赖、语法检查、打发布包）
2. 部署 job 在自己服务器的 runner 上跑：下载发布包
3. `deploy/apply-release.sh` 覆盖代码（`data/`、`logs/`、`run/`、`.env` 被保留）
4. `node --check` + 必要时装依赖
5. supervisor 重启 `3d-modeling-studio` 与 `cloudflared-3d-modeling-studio`
6. `deploy/verify-public.sh` 做健康检查，最后写 `run/deployed-commit`

**部署是否成功，只看这一个文件：**

```bash
ssh mygpu 'cat /workspace/projects/3d-modeling-studio/run/deployed-commit'
```

它等于本地 `HEAD` 就说明两个 job 都通过了。

## 部署架构

```
GitHub Push → CI 检查打包 → 专属 runner → apply-release → supervisor 重启 → cloudflared 隧道 → 公网
```

**服务器路径：**
- 代码：`/workspace/projects/3d-modeling-studio/`
- 数据：`/workspace/projects/3d-modeling-studio/data/`（db.json、uploads、models，发布时被保留）
- 日志：`/workspace/logs/3d-modeling-studio/`
- 监听端口：`3300`（仅本机，公网走 cloudflared Quick Tunnel）
- supervisor 配置：`deploy/supervisor.conf` 与 `deploy/cloudflared.conf`，由 `/workspace/etc/supervisord.conf` 的 `[include]` 引入

公网域名随隧道重启变化，取当前域名：

```bash
ssh mygpu 'cd /workspace/projects/3d-modeling-studio && bash deploy/public-url.sh'
```

## 项目结构

```
3d-modeling-studio/
├── .github/
│   └── workflows/
│       └── deploy.yml      # CI/CD配置
├── server/
│   ├── index.js            # Express服务器
│   └── db.js               # 数据库操作
├── public/
│   ├── index.html          # 前端页面
│   ├── style.css           # 样式
│   └── main.js              # Three.js逻辑
├── deploy/
│   ├── start.sh            # 启动脚本
│   ├── apply-release.sh    # 发布脚本
│   ├── verify-public.sh    # 公网验证脚本
│   ├── supervisor.conf     # supervisor配置
│   └── .env.example        # 环境变量模板
├── uploads/                # 上传图片
├── models/                 # 生成模型
├── db.json                 # 数据库
└── package.json
```

## 常用命令

```bash
# 查看服务状态（socket 不在默认路径，必须带 -c；服务器是 root，不用 sudo）
supervisorctl -c /workspace/etc/supervisord.conf status 3d-modeling-studio cloudflared-3d-modeling-studio

# 重启服务
supervisorctl -c /workspace/etc/supervisord.conf restart 3d-modeling-studio cloudflared-3d-modeling-studio

# 查看日志
tail -f /workspace/logs/3d-modeling-studio/out.log
tail -f /workspace/logs/3d-modeling-studio/err.log
```

## SPU服务配置

在网页左侧填入SPU API地址和Key，或者在 `.env` 文件中配置：

```env
SPU_API_URL=http://your-spu-service:8000/api/generate
SPU_API_KEY=your-api-key
```

## 本地开发

```bash
npm install
npm start
# 访问 http://localhost:3000
```
