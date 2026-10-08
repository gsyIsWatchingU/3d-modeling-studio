# 资源工作室

展示和管理 2D 图像、3D 模型与事件音效，支持在线查看图片、旋转模型、试听和下载。首页以独立资源创作为核心。

资源默认私有；预览或试听后，明确勾选确认才公开给访客，可随时撤回。原有模型、工厂素材与阶段预览图自动进入当前账号资源库，不迁移或删除原文件。

自然语言创作：描述需求 → 大模型解析并展示制作计划 → 用户确认 → 自有 GPU 后台执行 → 资源库预览。大模型接口、模型名称与 API Key 按账号保存，密钥不回传浏览器；也可复用 `SKILL_PLANNER_URL`、`SKILL_PLANNER_MODEL` 与 `SKILL_PLANNER_API_KEY`。

当前能力：3D 使用参考图与 Forge3D；事件音效使用自有 GPU 的 MOSS。2D 图像支持上传预览，GPU 出图接口尚未接入。GPU 音效依赖、权重、推理证据和人工试听状态分别记录，产物默认待审核。

原有游戏项目和生产接口保留，旧界面位于 `/game-factory.html`，详见[历史游戏工厂](docs/game-factory.md)。

支持 [MCP 接入](docs/mcp.md)：网页登录后创建个人凭证，网站与模型共用项目、固定 Skill、生产队列与产物，完成后通知当前账号的飞书群。

内置 [游戏制作全流程 Skill](docs/game-production.md)：按阶段固定规范，保存制作计划和来源快照，建模自动应用对应规范。

## 3D 建模工位

专业多参考图 Forge3D 建模位于 `/modeling.html`，可从资源库进入。

1. 上传参考图并填写建模要求。第一张用于生成，其余图片保留为辅助参考。
2. 选择模型类型、质量档位和本次附加 Skill。个人每次必用 Skill 由后端自动加入。
3. 选择已配置的通知通道并提交。刷新或关闭页面不会中断任务。

右上角“设置”集中管理：

- Forge3D 服务地址；
- 固定 Skill、默认 Skill；
- 邮箱、飞书机器人、企业微信机器人通知。

密钥为只写字段，配置接口不会把 API Key、SMTP 密码或 Webhook 原文返回浏览器。

## 任务状态

```text
queued → generating → downloading → validating → succeeded
                         └──────────────→ failed / retry_wait
```

- 任务和通知均写入 JSON 数据库，服务重启后会恢复。
- 每个任务在提交时冻结 Skill 快照，后续修改默认 Skill 不影响旧任务。
- 通知独立重试；通知失败不会重新执行建模。
- 成功前校验 GLB 2.0 文件头、声明长度、大小和 SHA-256。

## 本地运行

```bash
npm ci
npm run check
npm test
npm start
```

默认访问 `http://localhost:3000`。生产环境使用端口 `3300`。

## 主要环境变量

```env
SPU_PROVIDER=forge3d
SPU_API_URL=http://127.0.0.1:8091/v1/jobs
SPU_API_KEY=
FORGE3D_ASSET_ROOT=/workspace/3d-assets
FACTORY_GPU_SFX=1
FACTORY_GPU_AUDIO_GPU=1

NOTIFY_EMAIL_TO=
SMTP_HOST=
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=
SMTP_PASS=
FEISHU_WEBHOOK=
WECOM_WEBHOOK=
```

建模服务环境变量优先于网页配置。通知按登录账号分别保存；上述通知环境变量仅用于无归属的历史任务。不要把真实密钥提交到 Git。

## 上传限制

- 1～6 张 JPG、PNG 或 WebP；
- 单张不超过 10 MB，总计不超过 30 MB；
- 服务端同时检查 MIME 与文件头；
- Skill 文件不超过 64 KB；
- Skill 与提示词合并后最多 12000 字，先由后端解析为执行计划。

个人 Skill 的用法与参数见 [说明](docs/personal-skills.md)；GPU 需安装 [执行适配](deploy/forge3d/README.md)。

## 部署验证

推送 `main` 后由 GPU 自托管 Runner 自动部署。完成判据：

```bash
ssh mygpu 'cat /workspace/projects/3d-modeling-studio/run/deployed-commit'
ssh mygpu 'cd /workspace/projects/3d-modeling-studio && bash deploy/verify-public.sh'
```

`run/deployed-commit` 必须等于当前 `HEAD`，同时服务、本机健康检查和公网检查都通过。
