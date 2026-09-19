# 3D 建模工作室

全栈3D建模工具，支持CI/CD自动部署到GPU服务器，公网可访问。

## CI/CD 自动部署

**推送代码到 main 分支即可自动部署：**

```bash
git add .
git commit -m "你的更新"
git push origin main
```

**自动流程：**
1. GitHub Actions 触发 CI 构建检查
2. 安装依赖、语法检查
3. 打包部署文件
4. 自动部署到 GPU 服务器
5. 健康检查验证服务正常

## 部署架构

```
GitHub Push → GitHub Actions CI → 打包 → GPU服务器部署 → 公网访问
```

**服务器路径：**
- 代码：`/workspace/projects/3d-modeling-studio/`
- 数据：`/workspace/data/3d-modeling-studio/`
- 日志：`/workspace/logs/3d-modeling-studio/`

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
# 查看服务状态
sudo supervisorctl status 3d-modeling-studio

# 重启服务
sudo supervisorctl restart 3d-modeling-studio

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
