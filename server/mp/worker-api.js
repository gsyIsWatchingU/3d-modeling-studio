'use strict';

// ---------- 多节点并行建模（Multi-GPU）HTTP 层 ----------
// 用户端：/api/mp/jobs*（登录会话）；Worker 端：/api/mp/worker*（MP_WORKER_TOKEN）。

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { requireUser, requireModelUser } = require('../auth');
const {
    MODES, ASSET_KINDS, PROFILES, TASK_STATUS, LEASE_TTL_MS
} = require('./constants');
const store = require('./store');
const artifacts = require('./artifacts');
const { sha256Hex } = store;

function workerTokenOk(req) {
    const expected = process.env.MP_WORKER_TOKEN || '';
    if (!expected) return false;
    const provided = req.get('X-MP-Token') || '';
    return provided.length > 0 && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

function requireWorker(req, res, next) {
    if (!workerTokenOk(req)) return res.status(401).json({ success: false, error: 'Worker 令牌无效' });
    next();
}

function requireMpEnabled(req, res, next) {
    if (String(process.env.MP_ENABLED || '1') !== '1') return res.status(503).json({ success: false, error: '并行建模已停用（MP_ENABLED=0）' });
    next();
}

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { files: 30, fileSize: artifacts.MAX_ARTIFACT_BYTES, fields: 20 }
});

// Worker 产物上传：字段名为 "key:filename"（如 mesh:shape.glb），用 any() 接收全部文件部件，
// 由处理器从 fieldname 解析 key；同时兼容旧字段名 "artifacts"。
const uploadArtifacts = upload.any();

// 父任务详情：父 + 全部子任务（含产物、失败原因、重试状态）
function publicParent(parent, tasks) {
    const byStage = new Map();
    for (const task of tasks) {
        if (!byStage.has(task.stage)) byStage.set(task.stage, []);
        byStage.get(task.stage).push(task);
    }
    const children = Array.from(byStage.entries()).map(([stage, list]) => ({
        stage,
        tasks: list.map(t => ({
            id: t.id,
            status: t.status,
            capability: t.capability,
            host: t.host,
            gpuUuid: t.gpuUuid,
            gpuIndex: t.gpuIndex,
            seed: t.seed,
            candidateKey: t.candidateKey,
            attempt: t.attempt,
            maxAttempts: t.maxAttempts,
            error: t.error,
            leaseOwner: t.leaseOwner,
            heartbeatAt: t.heartbeatAt,
            nextRunAt: t.nextRunAt,
            inputArtifacts: t.inputArtifacts.map(a => ({ key: a.key, fileName: a.fileName, sha256: a.sha256 })),
            outputArtifacts: t.outputArtifacts.map(a => ({ key: a.key, fileName: a.fileName, sha256: a.sha256, bytes: a.bytes, path: a.path })),
            metrics: t.metrics,
            remoteJobId: t.remoteJobId,
            createdAt: t.created_at,
            updatedAt: t.updated_at
        }))
    }));
    const candidates = tasks.filter(t => t.stage === 'shape' && t.status === TASK_STATUS.COMPLETED).map(t => {
        const draftTask = tasks.find(d => d.stage === 'draft_preview' && d.candidateKey === t.candidateKey && d.status === TASK_STATUS.COMPLETED);
        const previewArt = draftTask?.outputArtifacts.find(a => a.key === 'preview') || t.outputArtifacts.find(a => a.key === 'preview');
        const qcTask = tasks.find(q => q.stage === 'candidate_qc' && q.status === TASK_STATUS.COMPLETED);
        return {
            candidateKey: t.candidateKey,
            seed: t.seed,
            preview: previewArt ? `/api/mp/artifacts/${parent.id}/${draftTask?.id || t.id}/${encodeURIComponent(previewArt.fileName)}` : null,
            mesh: t.outputArtifacts.find(a => a.key === 'mesh') ? `/api/mp/artifacts/${parent.id}/${t.id}/${encodeURIComponent(t.outputArtifacts.find(a => a.key === 'mesh').fileName)}` : null,
            qc: qcTask?.qcReport ? `/api/mp/artifacts/${parent.id}/${qcTask.id}/${encodeURIComponent(qcTask.qcReport.fileName)}` : null
        };
    });
    return { ...parent, children, candidates };
}

function createMpRouter({ uploadDir }) {
    const router = express.Router();

    // ---------- 用户端 ----------
    router.post('/jobs', requireModelUser, requireMpEnabled, upload.array('images', 6), (req, res) => {
        let imageNames = [];
        try {
            const mode = MODES.includes(req.body.mode) ? req.body.mode : 'candidate_race';
            const assetKind = ASSET_KINDS.includes(req.body.asset_kind) ? req.body.asset_kind : 'prop';
            const profile = PROFILES.includes(req.body.profile) ? req.body.profile : 'xhs_mobile';
            const files = req.files || [];
            if (files.length < 1) throw new Error('请上传至少一张参考图');
            if (files.length > 6) throw new Error('最多上传 6 张参考图');
            const total = files.reduce((sum, f) => sum + f.size, 0);
            if (total > 30 * 1024 * 1024) throw new Error('参考图总大小不能超过 30 MB');
            for (const file of files) {
                const header = file.buffer.subarray(0, 12);
                const isPng = header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
                const isJpg = header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
                const isWebp = header.length >= 12 && header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP';
                if (!isPng && !isJpg && !isWebp) throw new Error(`${file.originalname} 不是有效的 JPG、PNG 或 WebP 图片`);
            }
            // 保存参考图到 uploads（与旧流程同目录）
            const saved = [];
            for (const file of files) {
                const ext = file.mimetype === 'image/png' ? '.png' : file.mimetype === 'image/webp' ? '.webp' : '.jpg';
                const name = `${crypto.randomUUID()}${ext}`;
                fs.writeFileSync(path.join(uploadDir, name), file.buffer);
                saved.push(name);
            }
            imageNames = saved;
            const candidateCount = Math.max(1, Math.min(Number(req.body.candidate_count) || 4, 4));
            const seed = Number(req.body.seed);
            if (!Number.isInteger(seed) || seed < 0 || seed > 2 ** 32 - 1) throw new Error('随机种子必须为 0～4294967295 的整数');
            const prompt = String(req.body.prompt || '').trim().slice(0, 1000);
            const name = String(req.body.name || '并行建模任务').trim().slice(0, 80);
            const imageShas = saved.map(n => sha256Hex(fs.readFileSync(path.join(uploadDir, n))));
            const parent = store.createParent({
                ownerId: req.user.id,
                name,
                mode,
                assetKind,
                profile,
                prompt,
                seed,
                candidateCount,
                input: { images: saved, imageShas },
                baseUrl: process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`
            });
            res.status(202).json({ success: true, data: publicParent(store.findParent(parent.id), store.tasksForParent(parent.id)) });
        } catch (error) {
            if (imageNames.length) {
                for (const name of imageNames) { try { fs.unlinkSync(path.join(uploadDir, name)); } catch {} }
            }
            res.status(400).json({ success: false, error: error.message });
        }
    });

    router.get('/jobs', requireModelUser, (req, res) => {
        const list = store.listParents(req.user.id, req.query.limit).map(p => publicParent(p, store.tasksForParent(p.id)));
        res.json({ success: true, data: list });
    });

    router.get('/jobs/:id', requireModelUser, (req, res) => {
        const parent = store.findParent(req.params.id);
        if (!parent || parent.ownerId !== req.user.id) return res.status(404).json({ success: false, error: '任务不存在' });
        res.json({ success: true, data: publicParent(parent, store.tasksForParent(parent.id)) });
    });

    router.post('/jobs/:id/select', requireModelUser, (req, res) => {
        const parent = store.findParent(req.params.id);
        if (!parent || parent.ownerId !== req.user.id) return res.status(404).json({ success: false, error: '任务不存在' });
        try {
            const updated = req.mpScheduler.selectCandidate(parent.id, String(req.body.candidateKey || ''));
            res.json({ success: true, data: publicParent(updated, store.tasksForParent(updated.id)) });
        } catch (e) {
            res.status(400).json({ success: false, error: e.message });
        }
    });

    router.post('/jobs/:id/cancel', requireModelUser, (req, res) => {
        const parent = store.findParent(req.params.id);
        if (!parent || parent.ownerId !== req.user.id) return res.status(404).json({ success: false, error: '任务不存在' });
        const updated = store.cancelParent(parent.id, req.user.id);
        res.json({ success: true, data: publicParent(updated, store.tasksForParent(parent.id)) });
    });

    // 候选选择：由调用方传入已初始化的 scheduler（避免循环依赖）
    router.post('/jobs/:id/approve', requireModelUser, (req, res) => {
        const parent = store.findParent(req.params.id);
        if (!parent || parent.ownerId !== req.user.id) return res.status(404).json({ success: false, error: '任务不存在' });
        try {
            const updated = req.mpScheduler.approveParent(parent.id);
            res.json({ success: true, data: publicParent(updated, store.tasksForParent(updated.id)) });
        } catch (e) {
            res.status(400).json({ success: false, error: e.message });
        }
    });

    router.post('/jobs/:id/reject', requireModelUser, (req, res) => {
        const parent = store.findParent(req.params.id);
        if (!parent || parent.ownerId !== req.user.id) return res.status(404).json({ success: false, error: '任务不存在' });
        try {
            const updated = req.mpScheduler.rejectParent(parent.id, req.body.reason);
            res.json({ success: true, data: publicParent(updated, store.tasksForParent(updated.id)) });
        } catch (e) {
            res.status(400).json({ success: false, error: e.message });
        }
    });

    // ---------- Worker 端 ----------
    router.get('/worker/poll', requireWorker, (req, res) => {
        // capabilities: 逗号分隔的能力列表（如 shape:t4,rig:t4,animation:t4），按顺序尝试领取
        const capabilities = String(req.query.capabilities || req.query.capability || '')
            .split(',').map(s => s.trim()).filter(Boolean);
        if (!capabilities.length) return res.status(400).json({ success: false, error: '缺少 capabilities' });
        const worker = {
            id: String(req.query.worker || 'unknown'),
            host: String(req.query.host || 'unknown'),
            gpuUuid: req.query.gpu_uuid ? String(req.query.gpu_uuid) : null,
            gpuIndex: req.query.gpu_index !== undefined ? Number(req.query.gpu_index) : null,
            leaseTtlMs: LEASE_TTL_MS
        };
        for (const capability of capabilities) {
            const task = store.claimNext(capability, worker);
            if (task) return res.json({ success: true, data: publicTask(task) });
        }
        res.json({ success: true, data: null });
    });

    router.post('/worker/tasks/:id/heartbeat', requireWorker, (req, res) => {
        const task = store.heartbeat(req.params.id, String(req.body?.worker || ''));
        if (!task) return res.status(409).json({ success: false, error: '心跳失败：任务不在租约内' });
        res.json({ success: true, data: { status: task.status, cancel: task.status === TASK_STATUS.CANCELLED } });
    });

    router.post('/worker/tasks/:id/complete', requireWorker, uploadArtifacts, (req, res) => {
        const task = store.findTask(req.params.id);
        if (!task) return res.status(404).json({ success: false, error: '任务不存在' });
        const workerId = String(req.body?.worker || '');
        try {
            const outputArtifacts = [];
            const outputShas = [];
            for (const file of req.files || []) {
                const key = String(file.fieldname.split(':')[0] || 'mesh');
                const fileName = String(file.originalname || file.fieldname.split(':').slice(1).join(':') || key).replace(/[^\w.\-]/g, '_');
                const saved = artifacts.saveArtifact({
                    parentId: task.parentJobId,
                    taskId: task.id,
                    fileName,
                    buffer: file.buffer,
                    fromHost: task.host || workerId,
                    transferNote: `stage:${task.stage}`
                });
                outputArtifacts.push({ key, fileName: saved.fileName, sha256: saved.sha256, bytes: saved.bytes, path: saved.path });
                outputShas.push(saved.sha256);
            }
            let metrics = {};
            let preview = null;
            let qcReport = null;
            let logs = null;
            try { metrics = req.body.metrics ? JSON.parse(req.body.metrics) : {}; } catch {}
            if (req.body.preview) {
                const p = outputArtifacts.find(a => a.fileName === String(req.body.preview));
                if (p) preview = p;
            }
            if (req.body.qc_report) {
                const q = outputArtifacts.find(a => a.fileName === String(req.body.qc_report));
                if (q) qcReport = q;
            }
            logs = String(req.body.logs || '').slice(0, 20000) || null;
            const updated = store.completeTask(task.id, workerId, { outputArtifacts, outputShas, metrics, preview, qcReport, logs });
            if (!updated) return res.status(409).json({ success: false, error: '任务不在租约内或已完成' });
            res.json({ success: true, data: publicTask(updated) });
        } catch (e) {
            res.status(400).json({ success: false, error: e.message });
        }
    });

    router.post('/worker/tasks/:id/fail', requireWorker, (req, res) => {
        const task = store.findTask(req.params.id);
        if (!task) return res.status(404).json({ success: false, error: '任务不存在' });
        const workerId = String(req.body?.worker || '');
        const error = { code: String(req.body?.code || 'worker_error'), message: String(req.body?.error || '未知错误').slice(0, 800) };
        const updated = store.failTask(task.id, workerId, error);
        if (!updated) return res.status(409).json({ success: false, error: '任务不在租约内' });
        res.json({ success: true, data: publicTask(updated) });
    });

    // 产物下载：任务作用域内按 key 解析，禁止任意路径
    router.get('/artifacts/:parentId/:taskId/:fileName', (req, res) => {
        const { parentId, taskId, fileName } = req.params;
        const task = store.findTask(taskId);
        if (!task || task.parentJobId !== parentId) return res.status(404).end();
        const parent = store.findParent(parentId);
        const authed = workerTokenOk(req) || (req.user && parent && parent.ownerId === req.user.id);
        if (!authed) return res.status(401).end();
        const safeName = path.basename(fileName);
        // 1. 任务自身输出
        const ownPath = artifacts.artifactPath(parentId, taskId, safeName);
        if (fs.existsSync(ownPath)) return res.sendFile(ownPath);
        // 2. 上传来源输入（uploads/）
        const uploadInput = task.inputArtifacts.find(a => a.fileName === safeName && a.origin === 'upload');
        if (uploadInput) {
            const p = path.join(uploadDir, safeName);
            if (fs.existsSync(p)) return res.sendFile(p);
        }
        // 3. 其它任务产物输入
        const taskInput = task.inputArtifacts.find(a => a.fileName === safeName && a.origin === 'task' && a.taskId);
        if (taskInput) {
            const p = artifacts.artifactPath(parentId, taskInput.taskId, safeName);
            if (fs.existsSync(p)) return res.sendFile(p);
        }
        res.status(404).end();
    });

    return router;
}

function publicTask(task) {
    return {
        id: task.id,
        parentJobId: task.parentJobId,
        stage: task.stage,
        capability: task.capability,
        seed: task.seed,
        candidateKey: task.candidateKey,
        params: task.params,
        inputArtifacts: task.inputArtifacts,
        status: task.status,
        attempt: task.attempt,
        maxAttempts: task.maxAttempts,
        leaseExpiresAt: task.leaseExpiresAt
    };
}

module.exports = { createMpRouter, publicParent, workerTokenOk };
