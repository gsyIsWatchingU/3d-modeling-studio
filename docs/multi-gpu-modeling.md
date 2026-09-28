# 多节点并行游戏建模（Multi-GPU Forge3D）

> 现状基准：2026-09-28 实测。本文描述**实际采用**的调度、数据流、故障恢复与安全边界，并在实现中保持与代码一致。

## 1. 目标与范围

将现有串行 Forge3D 建模流程扩展为「父任务 + 阶段子任务」的可恢复并行工作流：

- **4×Tesla T4（新机 `gsy0930-b9b54d748-88kqg`）**：Shape 网格生成、多种子候选并行、UniRig 绑骨与蒙皮。
- **L20（`gsy013`，1×L20）**：Hunyuan Paint / PBR 贴图（只接收被选中的候选）、重型阶段兜底、串行生产兜底。
- **CPU（Blender 阶段）**：规范化、尺寸/朝向/枢轴、GLB 导出、预览渲染、自动质检。
  - **实测约束**：T4 为 Ubuntu 18.04（glibc 2.27），Blender 4.5.13 需要 glibc 2.28+，无法在 T4 运行；
    因此所有 Blender 类阶段（draft_preview/candidate_qc/normalize/export/preview/validate/retarget_animation）
    由 **gsy013 的 2 个 CPU Worker** 承担（gsy013 为 Ubuntu 22.04，Blender 4.5.13 正常）。T4 只跑 4 个 GPU Worker（shape/rig）。
- 两种并行模式：`parallel_assets`（多资产并行）、`candidate_race`（同资产多 seed 候选竞争，仅选中者进入 Paint）。
- 合并语义：**父任务聚合子任务 → 选择候选 → Blender 场景/动画组装 → manifest 聚合**，不是拆分单个角色焊接。

## 2. 网络拓扑（实测）

| 主机 | 集群 IP | 角色 | 服务 |
|---|---|---|---|
| mygpu（`gsy-5757878579-wsdv7`） | 10.42.0.166 | 控制面 | 3d-modeling-studio :3300（0.0.0.0）；本机 Forge3D :8091（2×L20，串行生产引擎，127.0.0.1 不变） |
| T4（`gsy0930-b9b54d748-88kqg`） | 10.42.9.119 | 4×T4 + 96 CPU | 4 个 GPU Worker（shape/rig），无 Forge3D API、无 Redis、无 Blender 能力 |
| gsy013（`gsy-s-9cff6dc4f-65m6j`） | 10.42.0.177 | L20 Paint + CPU Blender | Forge3D :8091（paint 端点，令牌鉴权）；2 个 CPU Worker（Blender 类阶段） |

实测连通性：`T4 → mygpu:3300 HTTP 200`；`mygpu → gsy013:10.42.0.177` 可达；`gsy013 → mygpu` **不可达**；
NAT 端口（31611/30660/30627）仅暴露 SSH。因此：

- T4 Worker **HTTP 拉取**控制面（集群内网 + 令牌）。
- Paint 由控制面 **HTTP 推送**到 gsy013 Forge3D（集群内网 + 令牌），并轮询其 `/v1/jobs/{id}`。
- 产物传输统一走控制面的「临时文件 → SHA-256 校验 → 原子改名」通道；跨主机不共享本地路径。

## 3. 任务模型

### 父任务（`mp_parent_jobs`）
`id`、`ownerId`、`mode`（single/parallel_assets/candidate_race）、`assetKind`、`profile`、`prompt`、
`seed`、`candidateCount`、`status`、`selectedCandidateId`、`humanReviewStatus`（not_performed/approved/rejected）、
`autoRank`（排序建议，不能代替批准）、`createdAt`、`updatedAt`。

### 阶段子任务（`mp_stage_tasks`）
`id`、`parentJobId`、`stage`、`capability`、`host`、`gpuUuid`、`gpuIndex`、`seed`、`attempt`、
`leaseOwner`、`leaseExpiresAt`、`heartbeatAt`、`inputArtifacts`、`outputArtifacts`、`status`、`error`、
`idempotencyKey`、`stageVersion`、`codeCommit`、`pipelineVersion`、`logs`、`metrics`（峰值显存/耗时）、
`inputShas`、`outputShas`、`preview`、`qcReport`、`createdAt`、`updatedAt`、`cancelledAt`。

### 状态机
`queued → leased → running → review → completed`；`retry_wait`（退避后回 queued）；
`failed → dead_letter`（重试耗尽）；`approved`（仅人工批准后由父任务持有，子任务不自动 approved）。

## 4. 能力队列

按能力调度，不按业务硬编码 GPU：

| capability | 执行方 | 阶段 |
|---|---|---|
| `shape:t4` | T4 GPU Worker 0..3（动态领取） | shape |
| `paint:l20` | gsy013 Forge3D worker（L20） | paint |
| `rig:t4` | T4 GPU Worker（UniRig，真实 GPU） | rig |
| `draft_preview:t4` / `candidate_qc:t4` | gsy013 CPU Worker（Blender） | draft_preview / candidate_qc |
| `normalize:t4` / `export:t4` / `preview:t4` / `validate:t4` | gsy013 CPU Worker（Blender） | normalize / export / render_preview / validate |
| `animation:t4` | gsy013 CPU Worker（Blender 重定向） | retarget_animation |

四个 GPU Worker 各自 `CUDA_VISIBLE_DEVICES=0..3`，用相同能力配置轮询；空闲 Worker 可接手任意兼容阶段，不写死“角色卡/道具卡”。
CPU Worker 用相同能力列表（`gsy013-launch.sh`），任意一个都可接手任何 Blender 阶段。

## 5. 阶段工作流

角色：`prepare → shape×N → draft_preview×N → candidate_qc → select → paint → normalize → rig → retarget_animation → export → render_preview → validate → review`
道具/场景：`prepare → shape×N → draft_preview×N → candidate_qc → select → paint → normalize → export → render_preview → validate → review`

规则：
1. `candidate_race` 默认并行 4 个 seed（每个 T4 一张卡）。
2. Shape 候选必须先生成预览与 QC，才进入选择。
3. 只把**选中**候选送到 L20 Paint。
4. Paint 产物传回 T4 做 UniRig 与动作。
5. 幂等键 = `parentId:stage:seed:inputSha:pipelineVersion:stageVersion`，完成阶段不重复执行、不重复消耗 GPU。
6. 自动评分只排序/拒绝明显失败项，**不能自动 approved**。
7. 动画基于同一已确认骨架，按动作片段并行，最终聚合为动画集（当前由 Blender retarget 全量执行）。
8. 统一单位/尺寸/朝向/枢轴/材质命名与连接点由 `normalize` 阶段保证。

## 6. 调度与故障恢复（控制面，mygpu 应用内）

- 领取：`queued` 且 `nextRunAt<=now` 的任务按能力+优先级原子置为 `leased`（`leaseOwner=workerId`、`leaseExpiresAt=now+TTL`）。
- 心跳：Worker 每 20s 上报（`worker.py` 心跳线程）；`leaseExpiresAt`（10min）到期未续 → 重新入队（`queued`，attempt 不变）。
- 重试：失败 → `retry_wait`，`nextRunAt = now + 30s * 2^(attempt-1)`（上限 10min）；`attempt >= maxAttempts` → `dead_letter`。
- 取消：父任务取消 → 所有非终态子任务 `cancelled`；Worker 通过轮询/心跳响应感知取消并中止命令。
- 幂等：创建子任务时按幂等键去重；`complete/fail` 校验 `leaseOwner` 与当前状态，过期租约的迟到上报被拒绝。
- 调度器与租约清扫循环独立于 HTTP 层；应用重启后 `running/leased` 任务按租约自动回收。
- Paint 阶段：任务标记为 `waiting_remote`，控制面轮询 gsy013 `/v1/jobs/{id}`；L20 忙则排队等待，不抢占。

## 7. 产物与来源追踪

每个子任务保存：参考图、`source/material_source`、prompt、seed、模型名与 revision、代码 commit、Pipeline 版本、
主机名、GPU UUID、输入/输出 SHA-256、阶段日志、峰值显存、耗时、预览、QC 报告、GLB/贴图/骨架/动画路径。
父 manifest 引用全部子 manifest；`completed`/QC 通过/人工审片/`approved` 是不同状态，只 `approved` 资产进入正式目录。

传输协议：
1. 先写 `.tmp` 文件 → 校验大小与 SHA-256 → 原子 rename 到正式任务目录。
2. 中断可续传/安全重传（上传接口幂等按任务+文件名去重）。
3. 不覆盖已 approved 的正式资产（写入失败即报错，不覆盖）。

## 8. 安全边界

- Redis、Forge3D、数据库、Worker 端口一律不开放公网；集群内网通信全部带令牌。
- gsy013 Forge3D 从 `127.0.0.1` 改绑 `0.0.0.0`（集群私有），新增中间件：非回环来源必须带 `X-Forge3D-Token`；127.0.0.1 本机调用（旧 `/v1/jobs` 串行流）行为不变。
- 控制面 Worker API（`/api/mp/worker/*`）要求 `MP_WORKER_TOKEN`；用户 API（`/api/mp/jobs/*`）要求登录会话。
- 不读取/输出 `.env`、私钥、API Key、Token；令牌只写入部署环境变量（supervisor/T4 worker 环境），不进入 git。
- 服务器间传输全部记录发送主机、接收主机、任务、时间与 SHA-256（manifest 中 `transfers[]`）。
- 三台机器不共享 `/workspace`；T4 运行环境由部署脚本从 gsy013 拷贝并记录 SHA-256。

## 9. 部署组件

- 控制面：`server/mp/`（constants / store / artifacts / scheduler / paint / worker-api），挂载于既有 Express 应用。
- T4：`/workspace/runtime` 独立 Python 3.10/3.11 + 模型（拷贝自 gsy013，SHA 记录）；4 个 GPU Worker（`deploy/mp/t4-launch.sh`，纯标准库）。
- gsy013：`/v1/stages/paint` 端点（`X-Forge3D-Token`），复用既有 worker 队列，旧 `/v1/jobs` 不变；
  2 个 CPU Worker（`deploy/mp/gsy013-launch.sh`，Blender 阶段 + animation:t4）。
- Paint 传输：控制面 scp（`paint.js`，**scp 参数只含选项 + [源,目标]**，避免多余 token 被当成源文件）→ gsy013 本机 curl 提交 → 轮询 → scp 拉回，全程 SHA-256 记录。

## 10. 回退

- 旧串行 `/api/jobs` + Forge3D `/v1/jobs` 完整流水线保持可用（默认提交仍走旧流程）。
- 配置开关：`MP_ENABLED=0` 时 mp 路由返回 503、调度器不启动，应用其余功能不变。
- 单 Worker 模式：T4 只启动 1 个 GPU Worker 即可按能力顺序执行。
