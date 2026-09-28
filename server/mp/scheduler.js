'use strict';

// ---------- 多节点并行建模（Multi-GPU）调度器 ----------
// 职责：按工作流创建阶段子任务、租约清扫、远端 Paint 轮询、候选选择与父任务状态聚合。
// 纯函数式推进：每 2s 对所有非终态父任务做一次「补齐缺失任务」的收敛，事件无外部依赖。

const path = require('path');
const {
    MP_STAGE_VERSION,
    MP_PIPELINE_VERSION,
    TASK_STATUS,
    PARENT_STATUS,
    stageCapability,
    stagesFor,
    DEFAULT_MAX_ATTEMPTS,
    PAINT_REMOTE_TIMEOUT_MS
} = require('./constants');

const TERMINAL_TASK = new Set([TASK_STATUS.COMPLETED, TASK_STATUS.DEAD_LETTER, TASK_STATUS.CANCELLED]);
const ACTIVE_TASK = new Set([TASK_STATUS.QUEUED, TASK_STATUS.LEASED, TASK_STATUS.RUNNING, TASK_STATUS.RETRY_WAIT, TASK_STATUS.WAITING_REMOTE]);

function sha256Hex(buffer) {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

class MpScheduler {
    constructor({ store, artifacts, paint, uploadDir }) {
        this.store = store;
        this.artifacts = artifacts;
        this.paint = paint;
        this.uploadDir = uploadDir;
        this.stopped = false;
        this.timers = [];
    }

    log(message) {
        console.log(`[MP调度] ${message}`);
    }

    start() {
        this.timers.push(setInterval(() => { try { this.tick(); } catch (e) { console.error(`[MP调度] tick 失败: ${e.message}`); } }, 2000));
        this.timers.push(setInterval(() => { try { this.sweep(); } catch (e) { console.error(`[MP调度] sweep 失败: ${e.message}`); } }, 10000));
        this.timers.push(setInterval(() => { try { this.pollPaints(); } catch (e) { console.error(`[MP调度] paint 轮询失败: ${e.message}`); } }, 5000));
        this.timers.forEach(timer => timer.unref());
        this.tick();
        this.log('调度器已启动');
        return this;
    }

    stop() {
        this.stopped = true;
        this.timers.forEach(timer => clearInterval(timer));
    }

    sweep() {
        const requeued = this.store.requeueExpiredLeases();
        const retried = this.store.dueRetriesToQueued();
        if (requeued + retried > 0) this.log(`回收 ${requeued} 个过期租约，${retried} 个重试到期重新入队`);
    }

    // ---------- 主推进 ----------
    tick() {
        if (this.stopped) return;
        const parents = this.store.listParents(undefined, 500);
        for (const parent of parents) {
            if ([PARENT_STATUS.CANCELLED, PARENT_STATUS.COMPLETED, PARENT_STATUS.FAILED].includes(parent.status)) continue;
            try {
                this.ensureTasks(parent);
            } catch (e) {
                console.error(`[MP调度] 父任务 ${parent.id} 推进失败: ${e.message}`);
            }
        }
    }

    // 补齐父任务缺失的阶段子任务（幂等收敛）
    ensureTasks(parent) {
        const tasks = this.store.tasksForParent(parent.id);
        const byStage = new Map();
        for (const task of tasks) {
            if (!byStage.has(task.stage)) byStage.set(task.stage, []);
            byStage.get(task.stage).push(task);
        }
        const stageTasks = stage => byStage.get(stage) || [];
        const hasCompleted = stage => stageTasks(stage).some(t => t.status === TASK_STATUS.COMPLETED);
        const first = stage => stageTasks(stage)[0] || null;

        // 失败聚合：任一 dead_letter 或不可恢复失败 → 父任务失败
        for (const task of tasks) {
            if (task.status === TASK_STATUS.DEAD_LETTER) {
                this.store.updateParent(parent.id, { status: PARENT_STATUS.FAILED, error: `阶段 ${task.stage} 重试耗尽: ${task.error?.message || '未知错误'}` });
                return;
            }
        }

        // 1. prepare（控制面即时完成）
        if (!stageTasks('prepare').length) {
            const prepare = this.store.createTask({
                parentJobId: parent.id,
                stage: 'prepare',
                capability: 'control',
                params: { name: parent.name, assetKind: parent.assetKind, profile: parent.profile, prompt: parent.prompt },
                inputShas: (parent.input?.imageShas || []).map(sha => ({ key: 'source', sha256: sha })),
                idempotencyKey: `${parent.id}:prepare:${MP_STAGE_VERSION}`,
                stageVersion: MP_STAGE_VERSION,
                pipelineVersion: MP_PIPELINE_VERSION
            });
            // 控制面任务也走租约：领取（control）后完成，与 Worker 流程一致
            this.store.claimNext('control', { id: 'control', host: 'control-plane', leaseTtlMs: 60000 });
            const prepareDone = this.store.completeTask(prepare.id, 'control', { metrics: { elapsed_seconds: 0 } });
            // 刷新本地阶段视图，使同一 tick 内 prepare 完成后即可推进后续阶段
            byStage.set('prepare', prepareDone ? [prepareDone] : []);
            this.log(`父任务 ${parent.id} prepare 完成`);
        }

        // 2. shape × candidateCount（每个 seed 一个，并行领取）
        if (hasCompleted('prepare') && !stageTasks('shape').length) {
            const base = Number(parent.seed) || 1234;
            const inputSha = (parent.input?.imageShas || [])[0]?.sha256 || 'unknown';
            for (let i = 0; i < parent.candidateCount; i += 1) {
                const seed = (base + i) >>> 0;
                const candidateKey = `c${i + 1}`;
                this.store.createTask({
                    parentJobId: parent.id,
                    stage: 'shape',
                    capability: 'shape:t4',
                    seed,
                    candidateKey,
                    maxAttempts: 3,
                    inputArtifacts: parent.input?.images?.length ? [{ key: 'source', fileName: parent.input.images[0], sha256: inputSha, origin: 'upload' }] : [],
                    params: { seed, prompt: parent.prompt, assetKind: parent.assetKind, profile: parent.profile, skillSha: parent.skillSnapshot?.sha256 || null },
                    idempotencyKey: `${parent.id}:shape:${seed}:${inputSha}:${MP_STAGE_VERSION}:${MP_PIPELINE_VERSION}`,
                    stageVersion: MP_STAGE_VERSION,
                    pipelineVersion: MP_PIPELINE_VERSION
                });
            }
            this.log(`父任务 ${parent.id} 创建 ${parent.candidateCount} 个 shape 候选`);
        }

        // 3. draft_preview：每个已完成的 shape 一个
        if (hasCompleted('prepare')) {
            for (const shapeTask of stageTasks('shape')) {
                if (shapeTask.status !== TASK_STATUS.COMPLETED) continue;
                if (stageTasks('draft_preview').some(t => t.params?.candidateKey === shapeTask.candidateKey)) continue;
                const glb = shapeTask.outputArtifacts.find(a => a.key === 'mesh');
                if (!glb) continue;
                this.store.createTask({
                    parentJobId: parent.id,
                    stage: 'draft_preview',
                    capability: 'draft_preview:t4',
                    seed: shapeTask.seed,
                    candidateKey: shapeTask.candidateKey,
                    maxAttempts: 3,
                    inputArtifacts: [{ key: 'mesh', fileName: glb.fileName, sha256: glb.sha256, origin: 'task', taskId: shapeTask.id }, ...(shapeTask.inputArtifacts.filter(a => a.key === 'source').map(a => ({ ...a })))],
                    params: { candidateKey: shapeTask.candidateKey, seed: shapeTask.seed, assetKind: parent.assetKind, profile: parent.profile },
                    idempotencyKey: `${parent.id}:draft_preview:${shapeTask.candidateKey}:${MP_STAGE_VERSION}:${MP_PIPELINE_VERSION}`,
                    stageVersion: MP_STAGE_VERSION,
                    pipelineVersion: MP_PIPELINE_VERSION
                });
            }
        }

        // 4. candidate_qc：所有 shape + draft 完成后单个任务
        const shapeDone = stageTasks('shape').length > 0 && stageTasks('shape').every(t => t.status === TASK_STATUS.COMPLETED);
        const draftsDone = stageTasks('draft_preview').length > 0 && stageTasks('draft_preview').every(t => t.status === TASK_STATUS.COMPLETED);
        if (shapeDone && draftsDone && !stageTasks('candidate_qc').length) {
            const candidates = stageTasks('shape').map(shapeTask => {
                const glb = shapeTask.outputArtifacts.find(a => a.key === 'mesh');
                const draftTask = stageTasks('draft_preview').find(t => t.candidateKey === shapeTask.candidateKey);
                const preview = draftTask?.outputArtifacts.find(a => a.key === 'preview');
                const draftManifest = draftTask?.outputArtifacts.find(a => a.key === 'preview_manifest');
                return {
                    candidateKey: shapeTask.candidateKey,
                    seed: shapeTask.seed,
                    glb: glb ? { fileName: glb.fileName, sha256: glb.sha256, taskId: shapeTask.id } : null,
                    preview: preview ? { fileName: preview.fileName, sha256: preview.sha256, taskId: draftTask.id } : null,
                    draft: draftManifest ? { fileName: draftManifest.fileName, sha256: draftManifest.sha256, taskId: draftTask.id } : null
                };
            }).filter(c => c.glb);
            const inputArtifacts = candidates.flatMap(c => [
                { key: `mesh-${c.candidateKey}`, fileName: c.glb.fileName, sha256: c.glb.sha256, origin: 'task', taskId: c.glb.taskId },
                ...(c.preview ? [{ key: `preview-${c.candidateKey}`, fileName: c.preview.fileName, sha256: c.preview.sha256, origin: 'task', taskId: c.preview.taskId }] : []),
                ...(c.draft ? [{ key: `draft-${c.candidateKey}`, fileName: c.draft.fileName, sha256: c.draft.sha256, origin: 'task', taskId: c.draft.taskId }] : [])
            ]);
            this.store.createTask({
                parentJobId: parent.id,
                stage: 'candidate_qc',
                capability: 'candidate_qc:t4',
                maxAttempts: 3,
                inputArtifacts,
                params: { candidates: candidates.map(c => ({ candidateKey: c.candidateKey, seed: c.seed })), assetKind: parent.assetKind, profile: parent.profile },
                idempotencyKey: `${parent.id}:candidate_qc:${MP_STAGE_VERSION}:${MP_PIPELINE_VERSION}`,
                stageVersion: MP_STAGE_VERSION,
                pipelineVersion: MP_PIPELINE_VERSION
            });
            this.log(`父任务 ${parent.id} 创建 candidate_qc`);
        }

        // 5. 候选选择
        const qcTask = first('candidate_qc');
        if (qcTask && qcTask.status === TASK_STATUS.COMPLETED) {
            this.applyAutoRank(parent, qcTask);
            parent = this.store.findParent(parent.id); // 刷新（自动选择可能已写入）
        }
        const hasSelection = Boolean(parent.selectedCandidateId);

        // 6. paint：选中后创建并推送远端 L20
        if (hasSelection && !stageTasks('paint').length) {
            const selected = stageTasks('shape').find(t => t.candidateKey === parent.selectedCandidateId);
            const glb = selected?.outputArtifacts.find(a => a.key === 'mesh');
            if (!glb) {
                this.store.updateParent(parent.id, { status: PARENT_STATUS.FAILED, error: '选中的候选缺少 shape 产物' });
                return;
            }
            const paintTask = this.store.createTask({
                parentJobId: parent.id,
                stage: 'paint',
                capability: 'paint:l20',
                seed: selected.seed,
                candidateKey: parent.selectedCandidateId,
                maxAttempts: 4,
                inputArtifacts: [{ key: 'mesh', fileName: glb.fileName, sha256: glb.sha256, origin: 'task', taskId: selected.id }],
                params: { candidateKey: parent.selectedCandidateId, assetKind: parent.assetKind, profile: parent.profile, prompt: parent.prompt, seed: selected.seed, materialImage: (parent.input?.images || [])[0] || null },
                idempotencyKey: `${parent.id}:paint:${parent.selectedCandidateId}:${MP_STAGE_VERSION}:${MP_PIPELINE_VERSION}`,
                stageVersion: MP_STAGE_VERSION,
                pipelineVersion: MP_PIPELINE_VERSION
            });
            this.log(`父任务 ${parent.id} 创建 paint（候选 ${parent.selectedCandidateId}）`);
        }

        // 6b. 启动 paint（远端提交）
        const paintTask = first('paint');
        if (paintTask && paintTask.status === TASK_STATUS.QUEUED) {
            // 幂等：若已有远端任务（应用重启/重试后任务重新入队），只恢复轮询，
            // 不重复提交远端 Paint，避免同一 mesh 在 L20 排队多次消耗 GPU。
            if (paintTask.remoteJobId) {
                this.store.startRemoteTask(paintTask.id, paintTask.remoteJobId);
                this.log(`父任务 ${parent.id} paint 恢复轮询远端任务 ${paintTask.remoteJobId}`);
            } else {
                this.startPaint(parent, paintTask).catch(e => {
                    console.error(`[MP调度] paint 提交失败 ${paintTask.id}: ${e.message}`);
                    this.retryPaint(paintTask, e);
                });
            }
        }

        // 7. 单轨阶段链（paint 之后）
        const order = stagesFor(parent.assetKind);
        const paintIdx = order.indexOf('paint');
        const afterPaint = order.slice(paintIdx + 1).filter(s => s !== 'select' && s !== 'review');
        for (const stage of afterPaint) {
            if (hasCompleted(stage)) continue;
            // validate 的网格输入取自 export（exported.glb），而非上一阶段
            // render_preview（只输出 preview，无 mesh），否则输入链断裂。
            const prevStage = stage === 'validate' ? 'export' : order[order.indexOf(stage) - 1];
            if (!prevStage) continue;
            const prevTask = prevStage === 'paint' ? paintTask : stageTasks(prevStage).find(t => t.status === TASK_STATUS.COMPLETED);
            if (prevStage === 'paint' && (!paintTask || paintTask.status !== TASK_STATUS.COMPLETED)) continue;
            if (prevStage !== 'paint' && !prevTask) continue;
            if (stageTasks(stage).length) continue;
            this.createDownstreamTask(parent, stage, prevTask, stageTasks);
        }

        // 8. review 入口
        if (hasCompleted('validate') && parent.status !== PARENT_STATUS.REVIEW && !hasCompleted('review')) {
            this.store.updateParent(parent.id, { status: PARENT_STATUS.REVIEW });
            this.log(`父任务 ${parent.id} 进入人工审片`);
        }

        // 9. 运行中聚合
        if (parent.status === PARENT_STATUS.QUEUED && tasks.some(t => ACTIVE_TASK.has(t.status))) {
            this.store.updateParent(parent.id, { status: PARENT_STATUS.RUNNING });
        }
    }

    createDownstreamTask(parent, stage, prevTask, stageTasks) {
        const capability = stageCapability(stage);
        const prevArtifact = (prevTask?.outputArtifacts || []).find(a => a.key === 'mesh');
        const inputArtifacts = prevArtifact ? [{ key: 'mesh', fileName: prevArtifact.fileName, sha256: prevArtifact.sha256, origin: 'task', taskId: prevTask.id }] : [];
        const params = {
            assetKind: parent.assetKind,
            profile: parent.profile,
            prompt: parent.prompt,
            seed: prevTask?.seed ?? parent.seed
        };
        if (stage === 'retarget_animation') params.animationLibrary = '/workspace/3d-assets/library/animations';
        const inputSha = inputArtifacts[0]?.sha256 || 'none';
        const task = this.store.createTask({
            parentJobId: parent.id,
            stage,
            capability,
            seed: prevTask?.seed ?? null,
            candidateKey: parent.selectedCandidateId || null,
            maxAttempts: 3,
            inputArtifacts,
            params,
            idempotencyKey: `${parent.id}:${stage}:${inputSha}:${MP_STAGE_VERSION}:${MP_PIPELINE_VERSION}`,
            stageVersion: MP_STAGE_VERSION,
            pipelineVersion: MP_PIPELINE_VERSION
        });
        this.log(`父任务 ${parent.id} 创建阶段 ${stage}`);
        return task;
    }

    // ---------- 候选评分排序（只排序，不批准） ----------
    applyAutoRank(parent, qcTask) {
        if (parent.autoRank) return;
        const qc = qcTask.outputArtifacts.find(a => a.key === 'qc');
        let report = null;
        if (qc) {
            const crypto = require('crypto');
            const fs = require('fs');
            try {
                const filePath = this.artifacts.artifactPath(parent.id, qcTask.id, qc.fileName);
                if (fs.existsSync(filePath)) report = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            } catch (e) {
                console.error(`[MP调度] 读取 QC 报告失败: ${e.message}`);
            }
        }
        const ranked = (report?.candidates || []).slice().sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
        this.store.updateParent(parent.id, { autoRank: ranked.map(r => ({ candidateKey: r.candidateKey, score: r.score, passed: r.passed })) });
        if (!parent.selectedCandidateId && parent.candidateCount === 1) {
            // 唯一候选无选择空间，自动选定（不等同于批准；后续仍需人工审片）
            const shapeTasks = this.store.tasksForParent(parent.id).filter(t => t.stage === 'shape');
            this.store.updateParent(parent.id, { selectedCandidateId: ranked[0]?.candidateKey || shapeTasks[0]?.candidateKey || null });
        }
    }

    // ---------- Paint 远端任务 ----------
    async startPaint(parent, paintTask) {
        // 先领取租约（control 持有），避免多次 tick 对同一任务重复提交远端任务
        const claimed = this.store.claimNext('paint:l20', { id: 'control', host: 'control-plane', leaseTtlMs: 60 * 60 * 1000 });
        if (!claimed || claimed.id !== paintTask.id) return; // 已被领取或状态已变化
        const mesh = paintTask.inputArtifacts.find(a => a.key === 'mesh');
        if (!mesh) throw new Error('paint 缺少输入 mesh');
        const meshPath = this.artifacts.artifactPath(parent.id, mesh.taskId, mesh.fileName);
        const fs = require('fs');
        if (!fs.existsSync(meshPath)) throw new Error(`paint 输入文件缺失: ${meshPath}`);
        let materialPath = null;
        if (paintTask.params.materialImage) {
            const candidate = path.join(this.uploadDir, path.basename(paintTask.params.materialImage));
            if (fs.existsSync(candidate)) materialPath = candidate;
        }
        try {
            const { jobId } = await this.paint.submitPaint({
                parentId: parent.id,
                taskId: paintTask.id,
                meshPath,
                materialPath,
                params: { assetKind: parent.assetKind, profile: parent.profile, prompt: parent.prompt, seed: paintTask.seed, skillPlan: null }
            });
            this.store.startRemoteTask(paintTask.id, jobId);
            this.log(`父任务 ${parent.id} paint 已提交远端任务 ${jobId}`);
        } catch (e) {
            // 提交失败：退还租约进入重试（attempt 已递增）
            throw e;
        }
    }

    retryPaint(paintTask, error) {
        const exhausted = paintTask.attempt >= paintTask.maxAttempts;
        this.store.updateTask(paintTask.id, {
            status: exhausted ? TASK_STATUS.DEAD_LETTER : TASK_STATUS.RETRY_WAIT,
            error: { code: 'paint_submit_error', message: String(error.message).slice(0, 800) },
            nextRunAt: exhausted ? undefined : new Date(Date.now() + Math.min(600000, 30000 * (2 ** Math.max(0, paintTask.attempt - 1)))).toISOString()
        });
    }

    // 连续轮询错误计数（瞬态 ssh/网络错误不立即判失败，避免重复提交远端任务）
    pollErrors = new Map();

    async pollPaints() {
        const parents = this.store.listParents(undefined, 500);
        for (const parent of parents) {
            const tasks = this.store.tasksForParent(parent.id);
            const paintTask = tasks.find(t => t.stage === 'paint' && t.status === TASK_STATUS.RUNNING && t.leaseOwner === 'control' && t.remoteJobId);
            if (!paintTask) continue;
            try {
                const remote = await this.paint.pollPaint(paintTask.remoteJobId);
                this.pollErrors.delete(paintTask.id);
                if (remote.done && remote.state === 'failed') {
                    // 远端任务已失败：清除 remoteJobId，按退避重试提交新远端任务（有限次）
                    const exhausted = paintTask.attempt >= paintTask.maxAttempts;
                    this.store.updateTask(paintTask.id, {
                        status: exhausted ? TASK_STATUS.DEAD_LETTER : TASK_STATUS.RETRY_WAIT,
                        remoteJobId: null,
                        error: { code: 'paint_remote_failed', message: String(remote.error || '远端 Paint 失败').slice(0, 800) },
                        nextRunAt: exhausted ? undefined : new Date(Date.now() + Math.min(600000, 30000 * (2 ** Math.max(0, paintTask.attempt - 1)))).toISOString()
                    });
                    this.log(`父任务 ${parent.id} paint 远端失败（${paintTask.remoteJobId}）${exhausted ? '，重试耗尽' : '，进入退避重试'}`);
                } else if (remote.done) {
                    const outputPath = this.artifacts.artifactPath(parent.id, paintTask.id, 'textured.glb');
                    const downloaded = await this.paint.downloadRemoteArtifact(remote.outputPath, outputPath);
                    this.store.finishRemoteTask(paintTask.id, {
                        outputArtifacts: [{ key: 'mesh', fileName: 'textured.glb', sha256: downloaded.sha256, bytes: downloaded.bytes, path: `/api/mp/artifacts/${parent.id}/${paintTask.id}/textured.glb` }],
                        outputShas: [downloaded.sha256],
                        metrics: { remoteState: remote.state, elapsed_seconds: 0, remoteMetrics: remote.metrics }
                    });
                    this.log(`父任务 ${parent.id} paint 完成（远端 ${paintTask.remoteJobId}，SHA ${downloaded.sha256.slice(0, 12)}）`);
                } else if (!['queued', 'pending'].includes(remote.state)
                    && Date.now() - new Date(paintTask.updated_at).getTime() > PAINT_REMOTE_TIMEOUT_MS) {
                    // 远端仍在队列等待 L20（不抢占既有任务）时不计算超时；只有已开始且超时才失败
                    this.store.failRemoteTask(paintTask.id, { code: 'paint_timeout', message: '远端 Paint 任务超时' });
                    this.log(`父任务 ${parent.id} paint 超时（远端 ${paintTask.remoteJobId}）`);
                }
            } catch (e) {
                console.error(`[MP调度] paint 轮询失败 ${paintTask.id}: ${e.message}`);
                const streak = (this.pollErrors.get(paintTask.id) || 0) + 1;
                if (streak >= 3) {
                    this.pollErrors.delete(paintTask.id);
                    this.store.failRemoteTask(paintTask.id, { code: 'paint_poll_error', message: String(e.message).slice(0, 800) });
                } else {
                    this.pollErrors.set(paintTask.id, streak);
                }
            }
        }
    }

    // ---------- 人工动作 ----------
    selectCandidate(parentId, candidateKey) {
        const parent = this.store.findParent(parentId);
        if (!parent) throw new Error('父任务不存在');
        if (parent.selectedCandidateId) throw new Error('已选定候选，不能更改');
        const tasks = this.store.tasksForParent(parentId);
        const shape = tasks.find(t => t.stage === 'shape' && t.candidateKey === candidateKey);
        if (!shape || shape.status !== TASK_STATUS.COMPLETED) throw new Error('候选不存在或尚未完成');
        return this.store.updateParent(parentId, { selectedCandidateId: candidateKey, status: PARENT_STATUS.RUNNING });
    }

    approveParent(parentId) {
        const parent = this.store.findParent(parentId);
        if (!parent) throw new Error('父任务不存在');
        if (parent.status !== PARENT_STATUS.REVIEW) throw new Error('只有进入审片状态后才能批准');
        const tasks = this.store.tasksForParent(parentId);
        const validate = tasks.find(t => t.stage === 'validate' && t.status === TASK_STATUS.COMPLETED);
        if (!validate) throw new Error('尚未通过自动质检，不能批准');
        return this.store.updateParent(parentId, { status: PARENT_STATUS.COMPLETED, humanReviewStatus: 'approved', approvedAt: new Date().toISOString() });
    }

    rejectParent(parentId, reason) {
        const parent = this.store.findParent(parentId);
        if (!parent) throw new Error('父任务不存在');
        if (parent.status !== PARENT_STATUS.REVIEW) throw new Error('只有进入审片状态后才能否决');
        return this.store.updateParent(parentId, { status: PARENT_STATUS.FAILED, humanReviewStatus: 'rejected', humanReviewReason: String(reason || '').slice(0, 500) });
    }
}

module.exports = { MpScheduler };
