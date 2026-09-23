# MCP 建模接入

使用本地 stdio MCP，复用线上 GPU 建模、个人 Skill 和异步通知。需要 Node.js 20+。

## 首次配置

1. 登录建模平台，在「设置 → 结果通知」保存自己的飞书机器人 Webhook。
2. 在「设置 → AI 客户端接入」创建凭证并复制。凭证绑定当前账号，有效期 90 天。
3. 本机克隆本仓库并运行 `npm ci`，在 AI 客户端添加以下 stdio MCP（路径、地址和凭证替换为实际值）：

```json
{
  "mcpServers": {
    "modeling-studio": {
      "command": "node",
      "args": ["E:/prj-gsy/3d-modeling-studio/mcp/server.js"],
      "env": {
        "STUDIO_URL": "https://你的建模平台域名",
        "STUDIO_TOKEN": "网页登录后创建的凭证"
      }
    }
  }
}
```

不同客户端配置格式可能不同，对应填写 command、args 和环境变量即可。凭证只放在客户端本机配置或密钥管理中，不发给大模型、不提交 Git。不需要提供账号密码或复制网页登录 Cookie。

## 使用

完整游戏生产见[游戏工厂](game-factory.md)：支持创建项目、启动生产、查询版本、读取产物、下载工程和验收后发布；网站和 MCP 共用同一队列。下面保留独立 3D 建模工具说明。

> 使用 E:/references/chair.png 创建一个木椅模型，完成后通知飞书。

| 工具 | 功能 |
|---|---|
| `get_account` | 查看当前账号、固定 Skill、通知是否配置 |
| `list_production_skills` | 查看固定制作阶段与真实能力 |
| `list_production_plans` | 查看已有制作计划 |
| `create_production_plan` | 保存游戏目标及全流程规范快照 |
| `get_production_guide` | 读取阶段完整规范，提供 plan_id 可读取计划版本 |
| `list_skills` | 列出可用 Skill |
| `create_model` | 上传本机参考图，立即返回任务 ID |
| `get_job` | 查询进度、结果、通知状态 |
| `get_model` | 获取结果，可用 `download_path` 保存 GLB；不覆盖已有文件 |

提交默认开启飞书通知；未配置时会拒绝提交。用户明确无需通知时可传 `notify_feishu: false`。模型生成或失败后由后台发送通知，不需要保持 AI 会话在线。飞书机器人通知发送到其所属群，不会根据登录邮箱自动发送私信。

图片路径是运行 MCP 的电脑上的绝对路径，单张最多 10 MB、总计 30 MB，最多 6 张。第一张参与生成，其余作为留存参考。模型下载链接需要登录同一账号；`get_model` 下载时自动认证。

建模自动应用固定生产规范。关联游戏制作计划时，向 `create_model` 传 `production_plan_id`，并选择与计划一致的 `profile`。其他阶段见 [游戏制作流](game-production.md)。

## 账号与通知

- 任务归属由凭证决定，不能通过参数指定其他用户；固定 Skill 自动生效。
- 凭证可管理本人游戏项目、提交生产任务、导出产物及发布已人工验收的版本，不能代替人工验收或修改账号、通知、服务器配置。
- 凭证原文只显示一次，服务器只保存 SHA-256 摘要。在网页撤销后立即禁止新调用，已提交任务和通知继续执行。
- 旧版全站通知配置不自动分配给任何账号；升级后请登录各自账号重新保存通知设置。历史无归属任务仍使用旧配置。
- 远程连接必须使用 HTTPS；本机开发允许 localhost HTTP。Quick Tunnel 地址变化后需更新 `STUDIO_URL`。

实现使用 [MCP 官方 SDK](https://ts.sdk.modelcontextprotocol.io/server)。当前版本提供本地 stdio 接入，不提供远程 `/mcp` 或 OAuth 自动弹窗登录。
