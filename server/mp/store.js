'use strict';

// ---------- 多节点并行建模（Multi-GPU）任务存储 ----------
// 独立 JSON 存储（data/mp-jobs.json），避免与既有 db.json 的他人改动耦合。
// 原子写：临时文件 → fsync → rename。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TASK_STATUS, TASK_TRANSITIONS } = require('./constants');

const mpDbPath = process.env.MP_DB_PATH || path.join(__dirname, '..', '..', 'data', 'mp-jobs.json');
const mpAssetDir = process.env.MP_ASSET_DIR || path.join(__dirname, '..', '..', 'data', 'mp-assets');

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureDir(path.dirname(mpDbPath));
ensureDir(mpAssetDir);

function initialData() {
    return {
        parents: [],
        tasks: [],
        transfers: [],
        nextParentId: 1,
        nextTaskId: 1,
        schemaVersion: '1.0'
    };
}

function normalize(data) {
    const db = data && typeof data === 'object' ? data : {};
    db.parents = Array.isArray(db.parents) ? db.parents : [];
    db.tasks = Array.isArray(db.tasks) ? db.tasks : [];
    db.transfers = Array.isArray(db.transfers) ? db.transfers : [];
    db.nextParentId = Number.isInteger(db.nextParentId) ? db.nextParentId : 1;
    db.nextTaskId = Number.isInteger(db.nextTaskId) ? db.nextTaskId : 1;
    db.schemaVersion = db.schemaVersion || '1.0';
    return db;
}

function readDb() {
    return normalize(JSON.parse(fs.readFileSync(mpDbPath, 'utf8')));
}

function writeDb(db) {
    const temp = `${mpDbPath}.${process.pid}.${Date.now()}.tmp`;
    const fd = fs.openSync(temp, 'w', 0o600);
    try {
        fs.writeFileSync(fd, `${JSON.stringify(db, null, 2)}\n`, 'utf8');
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(temp, mpDbPath);
}

function mutate(mutator) {
    const db = readDb();
    const result = mutator(db);
    writeDb(db);
    return result;
}

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sha256Hex(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

// ---------- 父任务 ----------

function createParent(data) {
    return mutate(db => {
        const now = new Date().toISOString();
        const id = `MP-${String(db.nextParentId++).padStart(6, '0')}`;
        const parent = {
            id,
            ownerId: data.ownerId ?? null,
            name: String(data.name || '并行建模任务').slice(0, 80),
            mode: data.mode || 'candidate_race',
            assetKind: data.assetKind || 'prop',
            profile: data.profile || 'xhs_mobile',
            prompt: data.prompt || '',
            seed: data.seed ?? 1234,
            candidateCount: Math.max(1, Math.min(Number(data.candidateCount) || 1, 4)),
            input: data.input || {},              // { images: [], skill_sha256 }
            skillSnapshot: data.skillSnapshot || null,
            status: 'queued',
            selectedCandidateId: null,
            humanReviewStatus: 'not_performed',
            autoRank: null,
            error: null,
            baseUrl: data.baseUrl || '',
            created_at: now,
            updated_at: now
        };
        db.parents.push(parent);
        return clone(parent);
    });
}

function updateParent(id, patch) {
    return mutate(db => {
        const parent = db.parents.find(p => p.id === id);
        if (!parent) return null;
        Object.assign(parent, patch, { updated_at: new Date().toISOString() });
        return clone(parent);
    });
}

function findParent(id) {
    return clone(readDb().parents.find(p => p.id === id) || null);
}

function listParents(ownerId, limit = 50) {
    return clone(readDb().parents
        .filter(p => ownerId === undefined || p.ownerId === ownerId)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, Math.max(1, Math.min(Number(limit) || 50, 200))));
}

// ---------- 子任务 ----------

function createTask(data) {
    return mutate(db => {
        // 幂等键去重：同一输入/seed/阶段/版本只创建一个任务
        if (data.idempotencyKey) {
            const existing = db.tasks.find(t => t.idempotencyKey === data.idempotencyKey);
            if (existing) return clone(existing);
        }
        const now = new Date().toISOString();
        const id = `T${String(db.nextTaskId++).padStart(7, '0')}`;
        const task = {
            id,
            parentJobId: data.parentJobId,
            stage: data.stage,
            capability: data.capability,
            host: data.host || null,
            gpuUuid: data.gpuUuid || null,
            gpuIndex: data.gpuIndex ?? null,
            seed: data.seed ?? null,
            candidateKey: data.candidateKey || null,     // candidate_race 中的候选标识（如 seed）
            attempt: 0,
            maxAttempts: data.maxAttempts ?? 3,
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            status: TASK_STATUS.QUEUED,
            nextRunAt: now,
            inputArtifacts: data.inputArtifacts || [],
            outputArtifacts: [],
            params: data.params || {},
            error: null,
            idempotencyKey: data.idempotencyKey || null,
            stageVersion: data.stageVersion || '1.0',
            codeCommit: data.codeCommit || null,
            pipelineVersion: data.pipelineVersion || 'mp-1.0',
            logs: null,
            metrics: {},
            inputShas: data.inputShas || [],
            outputShas: [],
            preview: null,
            qcReport: null,
            remoteJobId: null,
            cancelledAt: null,
            created_at: now,
            updated_at: now
        };
        db.tasks.push(task);
        return clone(task);
    });
}

function findTask(id) {
    return clone(readDb().tasks.find(t => t.id === id) || null);
}

function findTaskByIdempotency(key) {
    return clone(readDb().tasks.find(t => t.idempotencyKey === key) || null);
}

function tasksForParent(parentId) {
    return clone(readDb().tasks
        .filter(t => t.parentJobId === parentId)
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at)));
}

function updateTask(id, patch) {
    return mutate(db => {
        const task = db.tasks.find(t => t.id === id);
        if (!task) return null;
        Object.assign(task, patch, { updated_at: new Date().toISOString() });
        return clone(task);
    });
}

function transitionTask(id, to, patch = {}) {
    return mutate(db => {
        const task = db.tasks.find(t => t.id === id);
        if (!task) return null;
        const allowed = TASK_TRANSITIONS[task.status] || [];
        if (!allowed.includes(to)) throw new Error(`非法子任务状态迁移: ${task.status} → ${to}`);
        Object.assign(task, patch, { status: to, updated_at: new Date().toISOString() });
        return clone(task);
    });
}

// 原子领取：queued/retry_wait 到期任务 → leased
function claimNext(capability, worker, now = new Date()) {
    return mutate(db => {
        const task = db.tasks
            .filter(t => t.status === TASK_STATUS.QUEUED && t.capability === capability)
            .filter(t => !t.nextRunAt || new Date(t.nextRunAt) <= now)
            .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0];
        if (!task) return null;
        task.status = TASK_STATUS.LEASED;
        task.leaseOwner = worker.id;
        task.host = worker.host || task.host;
        task.gpuUuid = worker.gpuUuid || task.gpuUuid;
        task.gpuIndex = worker.gpuIndex ?? task.gpuIndex;
        task.leaseExpiresAt = new Date(now.getTime() + worker.leaseTtlMs).toISOString();
        task.attempt += 1;
        task.updated_at = now.toISOString();
        return clone(task);
    });
}

function heartbeat(id, workerId, now = new Date()) {
    return mutate(db => {
        const task = db.tasks.find(t => t.id === id);
        if (!task) return null;
        if (task.status !== TASK_STATUS.LEASED && task.status !== TASK_STATUS.RUNNING) return null;
        if (task.leaseOwner !== workerId) return null;
        task.heartbeatAt = now.toISOString();
        task.leaseExpiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
        task.updated_at = now.toISOString();
        return clone(task);
    });
}

// 租约过期回收：leased/running 且租约过期 → queued（attempt 保留）
function requeueExpiredLeases(now = new Date()) {
    return mutate(db => {
        let count = 0;
        for (const task of db.tasks) {
            if ((task.status === TASK_STATUS.LEASED || task.status === TASK_STATUS.RUNNING) &&
                task.leaseExpiresAt && new Date(task.leaseExpiresAt) <= now) {
                task.status = TASK_STATUS.QUEUED;
                task.leaseOwner = null;
                task.leaseExpiresAt = null;
                task.nextRunAt = now.toISOString();
                task.error = { code: 'lease_expired', message: '租约过期，重新入队' };
                task.updated_at = now.toISOString();
                count += 1;
            }
        }
        return count;
    });
}

// 重试等待到期 → queued
function dueRetriesToQueued(now = new Date()) {
    return mutate(db => {
        let count = 0;
        for (const task of db.tasks) {
            if (task.status === TASK_STATUS.RETRY_WAIT && task.nextRunAt && new Date(task.nextRunAt) <= now) {
                task.status = TASK_STATUS.QUEUED;
                task.leaseOwner = null;
                task.nextRunAt = now.toISOString();
                task.updated_at = now.toISOString();
                count += 1;
            }
        }
        return count;
    });
}

function completeTask(id, workerId, data, now = new Date()) {
    return mutate(db => {
        const task = db.tasks.find(t => t.id === id);
        if (!task) return null;
        if (task.status !== TASK_STATUS.LEASED && task.status !== TASK_STATUS.RUNNING) return null;
        if (task.leaseOwner !== workerId) return null;
        task.status = TASK_STATUS.COMPLETED;
        task.outputArtifacts = data.outputArtifacts || [];
        task.outputShas = data.outputShas || [];
        task.metrics = { ...(task.metrics || {}), ...(data.metrics || {}) };
        task.preview = data.preview || task.preview;
        task.qcReport = data.qcReport || task.qcReport;
        task.logs = data.logs || null;
        task.leaseOwner = null;
        task.leaseExpiresAt = null;
        task.error = null;
        task.updated_at = now.toISOString();
        return clone(task);
    });
}

function failTask(id, workerId, error, now = new Date()) {
    return mutate(db => {
        const task = db.tasks.find(t => t.id === id);
        if (!task) return null;
        if (task.status !== TASK_STATUS.LEASED && task.status !== TASK_STATUS.RUNNING) return null;
        if (task.leaseOwner !== workerId) return null;
        const isExhausted = task.attempt >= task.maxAttempts;
        task.status = isExhausted ? TASK_STATUS.DEAD_LETTER : TASK_STATUS.RETRY_WAIT;
        task.error = error;
        task.leaseOwner = null;
        task.leaseExpiresAt = null;
        if (!isExhausted) {
            const delay = Math.min(10 * 60 * 1000, 30 * 1000 * (2 ** Math.max(0, task.attempt - 1)));
            task.nextRunAt = new Date(now.getTime() + delay).toISOString();
        }
        task.updated_at = now.toISOString();
        return clone(task);
    });
}

// 控制面自身驱动的任务（paint：远端 Forge3D 任务）
function startRemoteTask(id, remoteJobId) {
    return transitionTask(id, TASK_STATUS.RUNNING, {
        remoteJobId,
        leaseOwner: 'control',
        leaseExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        startedAt: new Date().toISOString()
    });
}

function finishRemoteTask(id, data) {
    return mutate(db => {
        const task = db.tasks.find(t => t.id === id);
        if (!task) return null;
        if (task.status !== TASK_STATUS.RUNNING || task.leaseOwner !== 'control') return null;
        task.status = TASK_STATUS.COMPLETED;
        task.outputArtifacts = data.outputArtifacts || [];
        task.outputShas = data.outputShas || [];
        task.metrics = { ...(task.metrics || {}), ...(data.metrics || {}) };
        task.logs = data.logs || null;
        task.error = null;
        task.leaseOwner = null;
        task.updated_at = new Date().toISOString();
        return clone(task);
    });
}

function failRemoteTask(id, error) {
    return mutate(db => {
        const task = db.tasks.find(t => t.id === id);
        if (!task) return null;
        if (task.status !== TASK_STATUS.RUNNING || task.leaseOwner !== 'control') return null;
        const isExhausted = task.attempt >= task.maxAttempts;
        task.status = isExhausted ? TASK_STATUS.DEAD_LETTER : TASK_STATUS.RETRY_WAIT;
        task.error = error;
        task.leaseOwner = null;
        if (!isExhausted) {
            const delay = Math.min(10 * 60 * 1000, 30 * 1000 * (2 ** Math.max(0, task.attempt - 1)));
            task.nextRunAt = new Date(Date.now() + delay).toISOString();
        }
        task.updated_at = new Date().toISOString();
        return clone(task);
    });
}

function cancelParent(id, ownerId) {
    return mutate(db => {
        const parent = db.parents.find(p => p.id === id && (ownerId === undefined || p.ownerId === ownerId));
        if (!parent) return null;
        const now = new Date().toISOString();
        parent.status = 'cancelled';
        parent.updated_at = now;
        for (const task of db.tasks) {
            if (task.parentJobId !== id) continue;
            if ([TASK_STATUS.COMPLETED, TASK_STATUS.DEAD_LETTER, TASK_STATUS.CANCELLED].includes(task.status)) continue;
            task.status = TASK_STATUS.CANCELLED;
            task.cancelledAt = now;
            task.updated_at = now;
        }
        return clone(parent);
    });
}

function recordTransfer(data) {
    return mutate(db => {
        const record = { ...data, at: new Date().toISOString() };
        db.transfers.push(record);
        if (db.transfers.length > 20000) db.transfers = db.transfers.slice(-20000);
        return clone(record);
    });
}

function listTransfers(parentId, limit = 200) {
    return clone(readDb().transfers
        .filter(t => parentId === undefined || t.parentJobId === parentId)
        .reverse()
        .slice(0, Math.max(1, Math.min(Number(limit) || 200, 1000))));
}

function stats() {
    const db = readDb();
    const taskCounts = {};
    const parentCounts = {};
    for (const task of db.tasks) taskCounts[task.status] = (taskCounts[task.status] || 0) + 1;
    for (const parent of db.parents) parentCounts[parent.status] = (parentCounts[parent.status] || 0) + 1;
    return {
        parents: parentCounts,
        tasks: taskCounts,
        transfers: db.transfers.length,
        totalParents: db.parents.length,
        totalTasks: db.tasks.length
    };
}

function resetForTest() {
    if (process.env.NODE_ENV === 'test') {
        writeDb(initialData());
        // 同时清空产物目录，避免跨测试用例残留文件污染
        if (fs.existsSync(mpAssetDir)) fs.rmSync(mpAssetDir, { recursive: true, force: true });
        ensureDir(mpAssetDir);
    } else {
        throw new Error('resetForTest 仅允许测试环境');
    }
}

if (!fs.existsSync(mpDbPath)) writeDb(initialData());

module.exports = {
    mpDbPath,
    mpAssetDir,
    sha256Hex,
    createParent,
    updateParent,
    findParent,
    listParents,
    createTask,
    findTask,
    findTaskByIdempotency,
    tasksForParent,
    updateTask,
    transitionTask,
    claimNext,
    heartbeat,
    requeueExpiredLeases,
    dueRetriesToQueued,
    completeTask,
    failTask,
    startRemoteTask,
    finishRemoteTask,
    failRemoteTask,
    cancelParent,
    recordTransfer,
    listTransfers,
    stats,
    resetForTest
};
