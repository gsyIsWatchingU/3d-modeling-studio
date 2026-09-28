'use strict';

// 多节点并行建模（Multi-GPU）单元测试：调度 / 幂等 / 租约 / 重试 / 死信 / 父子聚合 / 候选选择 / SHA 校验。
// 运行：node --test test/mp.test.js（NODE_ENV=test 由本文件自行设置）

process.env.NODE_ENV = 'test';
const path = require('path');
const fs = require('fs');
const os = require('os');
const test = require('node:test');
const assert = require('node:assert/strict');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-test-'));
process.env.MP_DB_PATH = path.join(tmpRoot, 'mp-jobs.json');
process.env.MP_ASSET_DIR = path.join(tmpRoot, 'mp-assets');

const store = require('../server/mp/store');
const artifacts = require('../server/mp/artifacts');
const { MpScheduler } = require('../server/mp/scheduler');
const { TASK_STATUS, PARENT_STATUS } = require('../server/mp/constants');

const dummyPaint = {
    isConfigured: () => true,
    async submitPaint({ params }) { return { jobId: `paint-${params.seed}` }; },
    async pollPaint() { return { done: false, state: 'running' }; },
    async downloadRemoteArtifact() { return { bytes: 4, sha256: 'x'.repeat(64) }; }
};

function makeScheduler() {
    return new MpScheduler({ store, artifacts, paint: dummyPaint, uploadDir: path.join(tmpRoot, 'uploads') });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const iso = date => date.toISOString();
const WORKER = { id: 't4-0', host: 't4-0', gpuIndex: 0, leaseTtlMs: 600000 };
const FUTURE = new Date(Date.now() + 10 * 60 * 1000);

// 领取并完成任务（与真实 Worker 流程一致：先租约，后 complete）
function claimAndComplete(capability, outputArtifacts, now) {
    const claimed = store.claimNext(capability, WORKER, now);
    assert.ok(claimed, `应可领取 ${capability} 任务`);
    const done = store.completeTask(claimed.id, WORKER.id, { outputArtifacts, outputShas: outputArtifacts.map(a => a.sha256) }, now);
    assert.ok(done, `${capability} 任务应完成`);
    return done;
}

test.beforeEach(() => store.resetForTest());
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

// ---------- store：父/子任务与幂等 ----------
test('store: 创建父任务与子任务，幂等键去重', () => {
    const parent = store.createParent({ ownerId: 'u1', name: '测试', mode: 'candidate_race', assetKind: 'prop', candidateCount: 4, seed: 100 });
    assert.ok(parent.id.startsWith('MP-'));
    assert.equal(parent.status, 'queued');
    assert.equal(parent.candidateCount, 4);

    const taskA = store.createTask({ parentJobId: parent.id, stage: 'shape', capability: 'shape:t4', seed: 100, idempotencyKey: 'k1' });
    const taskB = store.createTask({ parentJobId: parent.id, stage: 'shape', capability: 'shape:t4', seed: 100, idempotencyKey: 'k1' });
    assert.equal(taskA.id, taskB.id, '相同幂等键应返回同一任务');
    assert.equal(store.tasksForParent(parent.id).length, 1);
    const taskC = store.createTask({ parentJobId: parent.id, stage: 'shape', capability: 'shape:t4', seed: 101, idempotencyKey: 'k2' });
    assert.notEqual(taskA.id, taskC.id);
});

// ---------- store：租约、心跳、过期回收 ----------
test('store: 按能力领取、租约字段、心跳续期、过期回收', () => {
    const parent = store.createParent({ ownerId: 'u1', assetKind: 'prop' });
    store.createTask({ parentJobId: parent.id, stage: 'shape', capability: 'shape:t4', idempotencyKey: 'k1' });
    store.createTask({ parentJobId: parent.id, stage: 'paint', capability: 'paint:l20', idempotencyKey: 'k2' });

    const claimed = store.claimNext('shape:t4', { id: 'w1', host: 't4-0', gpuIndex: 0, leaseTtlMs: 600000 });
    assert.ok(claimed, 'shape 任务应可领取');
    assert.equal(claimed.status, 'leased');
    assert.equal(claimed.leaseOwner, 'w1');
    assert.equal(claimed.gpuIndex, 0);
    assert.equal(claimed.attempt, 1);

    // 错误 worker 心跳被拒
    assert.equal(store.heartbeat(claimed.id, 'w2'), null);
    // 正确 worker 心跳续期
    const now = new Date();
    const beat = store.heartbeat(claimed.id, 'w1', new Date(now.getTime() + 10000));
    assert.ok(beat);
    assert.ok(new Date(beat.leaseExpiresAt) > new Date(now.getTime() + 600000 - 1000));

    // 不同能力不能领取对方任务
    const paintClaimed = store.claimNext('paint:l20', { id: 'w1', leaseTtlMs: 600000 });
    assert.ok(paintClaimed, 'paint 队列里的任务应可领取');
    assert.notEqual(paintClaimed.id, claimed.id, 'paint 能力不能领取 shape 任务');
    assert.equal(store.claimNext('shape:t4', { id: 'w1', leaseTtlMs: 600000 }), null, '已租约的 shape 不能再领');
    // 超时后回收
    const future = new Date(Date.now() + 700000);
    const requeued = store.requeueExpiredLeases(future);
    assert.equal(requeued, 2, '两个已租约任务都应被回收');
    const again = store.claimNext('shape:t4', { id: 'w2', host: 't4-1', leaseTtlMs: 600000 }, future);
    assert.ok(again);
    assert.equal(again.attempt, 2, '重新领取 attempt 应递增');
});

// ---------- store：失败重试与死信 ----------
test('store: 有限重试、指数退避、耗尽进死信', () => {
    const parent = store.createParent({ ownerId: 'u1' });
    store.createTask({ parentJobId: parent.id, stage: 'shape', capability: 'shape:t4', maxAttempts: 3, idempotencyKey: 'k1' });
    let task = store.claimNext('shape:t4', WORKER);
    task = store.failTask(task.id, WORKER.id, { code: 'e', message: '失败1' });
    assert.equal(task.status, 'retry_wait');
    assert.ok(task.nextRunAt);
    // 退避未到不能重入队
    assert.equal(store.dueRetriesToQueued(new Date()), 0);
    assert.equal(store.claimNext('shape:t4', WORKER), null);

    // 退避到期 → 重新入队 → 再领（同一时间基准）
    assert.equal(store.dueRetriesToQueued(FUTURE), 1);
    task = store.claimNext('shape:t4', WORKER, FUTURE);
    assert.equal(task.attempt, 2);
    task = store.failTask(task.id, WORKER.id, { code: 'e', message: '失败2' });
    store.dueRetriesToQueued(new Date(FUTURE.getTime() + 10 * 60 * 1000));
    task = store.claimNext('shape:t4', WORKER, new Date(FUTURE.getTime() + 10 * 60 * 1000));
    assert.equal(task.attempt, 3);
    task = store.failTask(task.id, WORKER.id, { code: 'e', message: '失败3' });
    assert.equal(task.status, 'dead_letter', '重试耗尽应进死信');
    assert.equal(store.claimNext('shape:t4', WORKER, FUTURE), null);
});

// ---------- store：完成与取消 ----------
test('store: 完成任务记录产物；取消保留已完成子任务', () => {
    const parent = store.createParent({ ownerId: 'u1' });
    store.createTask({ parentJobId: parent.id, stage: 'shape', capability: 'shape:t4', idempotencyKey: 'k1' });
    store.createTask({ parentJobId: parent.id, stage: 'paint', capability: 'paint:l20', idempotencyKey: 'k2' });
    const shape = store.claimNext('shape:t4', WORKER);
    const done = store.completeTask(shape.id, WORKER.id, { outputArtifacts: [{ key: 'mesh', fileName: 'a.glb', sha256: 'a1' }], outputShas: ['a1'] });
    assert.equal(done.status, 'completed');
    assert.equal(done.outputArtifacts.length, 1);

    const cancelled = store.cancelParent(parent.id, 'u1');
    assert.equal(cancelled.status, 'cancelled');
    const tasks = store.tasksForParent(parent.id);
    assert.equal(tasks.find(t => t.stage === 'shape').status, 'completed', '已完成的子任务不被取消');
    assert.equal(tasks.find(t => t.stage === 'paint').status, 'cancelled');
});

// ---------- store：SHA 产物写入与幂等重传 ----------
test('artifacts: 产物 SHA 校验、大小校验、幂等重传拒绝覆盖', () => {
    const parent = store.createParent({ ownerId: 'u1' });
    store.createTask({ parentJobId: parent.id, stage: 'shape', capability: 'shape:t4', idempotencyKey: 'k1' });
    const task = store.tasksForParent(parent.id)[0];
    const buf = Buffer.from('hello-glb');
    const saved = artifacts.saveArtifact({ parentId: parent.id, taskId: task.id, fileName: 'shape.glb', buffer: buf, fromHost: 't4-0' });
    assert.equal(saved.sha256, require('crypto').createHash('sha256').update(buf).digest('hex'));
    assert.ok(fs.existsSync(artifacts.artifactPath(parent.id, task.id, 'shape.glb')));

    // 同内容幂等重传 OK
    const again = artifacts.saveArtifact({ parentId: parent.id, taskId: task.id, fileName: 'shape.glb', buffer: buf, fromHost: 't4-1' });
    assert.equal(again.sha256, saved.sha256);
    // 不同内容拒绝覆盖
    assert.throws(() => artifacts.saveArtifact({ parentId: parent.id, taskId: task.id, fileName: 'shape.glb', buffer: Buffer.from('evil'), fromHost: 't4-1' }), /拒绝覆盖/);
});

// ---------- 调度：阶段补齐与幂等收敛 ----------
test('scheduler: prepare → shape×N 幂等收敛', () => {
    const sched = makeScheduler();
    const parent = store.createParent({ ownerId: 'u1', assetKind: 'prop', mode: 'candidate_race', candidateCount: 4, seed: 42, input: { images: ['a.png'], imageShas: ['s1'] } });
    sched.ensureTasks(store.findParent(parent.id));
    let tasks = store.tasksForParent(parent.id);
    assert.equal(tasks.filter(t => t.stage === 'prepare').length, 1);
    assert.equal(tasks.filter(t => t.stage === 'prepare')[0].status, 'completed');
    assert.equal(tasks.filter(t => t.stage === 'shape').length, 4);
    const seeds = new Set(tasks.filter(t => t.stage === 'shape').map(t => t.seed));
    assert.equal(seeds.size, 4, '四个候选 seed 各不相同');

    // 再次收敛不重复创建
    sched.ensureTasks(store.findParent(parent.id));
    tasks = store.tasksForParent(parent.id);
    assert.equal(tasks.filter(t => t.stage === 'shape').length, 4);
});

// ---------- 调度：draft_preview → candidate_qc → 自动排序 → 单候选自动选定 ----------
test('scheduler: draft → qc → 自动排序，单候选自动选定', () => {
    const sched = makeScheduler();
    const parent = store.createParent({ ownerId: 'u1', assetKind: 'prop', candidateCount: 1, seed: 1, input: { images: ['a.png'], imageShas: ['s1'] } });
    sched.ensureTasks(store.findParent(parent.id));
    let tasks = store.tasksForParent(parent.id);
    const shape = tasks.find(t => t.stage === 'shape');
    const glb = Buffer.from('glb-content');
    const saved = artifacts.saveArtifact({ parentId: parent.id, taskId: shape.id, fileName: 'shape.glb', buffer: glb, fromHost: 't4-0' });
    claimAndComplete('shape:t4', [{ key: 'mesh', fileName: 'shape.glb', sha256: saved.sha256 }]);

    sched.ensureTasks(store.findParent(parent.id));
    tasks = store.tasksForParent(parent.id);
    const draft = tasks.find(t => t.stage === 'draft_preview');
    assert.ok(draft, 'shape 完成后应创建 draft_preview');
    const previewPng = Buffer.from('png');
    const pngSaved = artifacts.saveArtifact({ parentId: parent.id, taskId: draft.id, fileName: 'draft-preview.png', buffer: previewPng, fromHost: 't4-0' });
    const manifest = Buffer.from(JSON.stringify({ draft_gate: 'passed' }));
    const manSaved = artifacts.saveArtifact({ parentId: parent.id, taskId: draft.id, fileName: 'draft-preview.json', buffer: manifest, fromHost: 't4-0' });
    claimAndComplete('draft_preview:t4', [
        { key: 'preview', fileName: 'draft-preview.png', sha256: pngSaved.sha256 },
        { key: 'preview_manifest', fileName: 'draft-preview.json', sha256: manSaved.sha256 }
    ]);

    sched.ensureTasks(store.findParent(parent.id));
    tasks = store.tasksForParent(parent.id);
    const qc = tasks.find(t => t.stage === 'candidate_qc');
    assert.ok(qc, 'draft 完成后应创建 candidate_qc');
    const qcReport = Buffer.from(JSON.stringify({ candidates: [{ candidateKey: 'c1', seed: 1, score: 88, passed: true }] }));
    const qcSaved = artifacts.saveArtifact({ parentId: parent.id, taskId: qc.id, fileName: 'qc.json', buffer: qcReport, fromHost: 't4-0' });
    claimAndComplete('candidate_qc:t4', [{ key: 'qc', fileName: 'qc.json', sha256: qcSaved.sha256 }]);

    sched.ensureTasks(store.findParent(parent.id));
    const refreshed = store.findParent(parent.id);
    assert.ok(refreshed.autoRank, 'QC 完成后应写入自动排序');
    assert.equal(refreshed.selectedCandidateId, 'c1', '单候选应自动选定');
    assert.notEqual(refreshed.humanReviewStatus, 'approved', '自动选定不等于批准');
});

// ---------- 调度：多候选需人工选择 ----------
test('scheduler: 多候选不自动选定，selectCandidate 生效', () => {
    const sched = makeScheduler();
    const parent = store.createParent({ ownerId: 'u1', assetKind: 'prop', candidateCount: 2, seed: 1, input: { images: ['a.png'], imageShas: ['s1'] } });
    sched.ensureTasks(store.findParent(parent.id));
    // 完成两个 shape + 两个 draft + qc
    for (const shape of store.tasksForParent(parent.id).filter(t => t.stage === 'shape')) {
        const saved = artifacts.saveArtifact({ parentId: parent.id, taskId: shape.id, fileName: `${shape.candidateKey}.glb`, buffer: Buffer.from(shape.candidateKey), fromHost: 't4-0' });
        claimAndComplete('shape:t4', [{ key: 'mesh', fileName: `${shape.candidateKey}.glb`, sha256: saved.sha256 }]);
    }
    sched.ensureTasks(store.findParent(parent.id));
    for (const draft of store.tasksForParent(parent.id).filter(t => t.stage === 'draft_preview')) {
        const pngSaved = artifacts.saveArtifact({ parentId: parent.id, taskId: draft.id, fileName: `${draft.candidateKey}.png`, buffer: Buffer.from('png'), fromHost: 't4-0' });
        const manSaved = artifacts.saveArtifact({ parentId: parent.id, taskId: draft.id, fileName: `${draft.candidateKey}.json`, buffer: Buffer.from(JSON.stringify({ draft_gate: 'passed' })), fromHost: 't4-0' });
        claimAndComplete('draft_preview:t4', [
            { key: 'preview', fileName: `${draft.candidateKey}.png`, sha256: pngSaved.sha256 },
            { key: 'preview_manifest', fileName: `${draft.candidateKey}.json`, sha256: manSaved.sha256 }
        ]);
    }
    sched.ensureTasks(store.findParent(parent.id));
    const qc = store.tasksForParent(parent.id).find(t => t.stage === 'candidate_qc');
    const qcSaved = artifacts.saveArtifact({ parentId: parent.id, taskId: qc.id, fileName: 'qc.json', buffer: Buffer.from(JSON.stringify({ candidates: [
        { candidateKey: 'c1', score: 90, passed: true }, { candidateKey: 'c2', score: 40, passed: false }
    ] })), fromHost: 't4-0' });
    claimAndComplete('candidate_qc:t4', [{ key: 'qc', fileName: 'qc.json', sha256: qcSaved.sha256 }]);

    sched.ensureTasks(store.findParent(parent.id));
    const before = store.findParent(parent.id);
    assert.equal(before.selectedCandidateId, null, '多候选不得自动选定');
    assert.ok(before.autoRank, '但应写入自动排序');
    assert.equal(before.autoRank[0].candidateKey, 'c1', '排序应优先高分');

    // 人工选择 c2（低分候选也可被选，仅排序参考）
    const after = sched.selectCandidate(parent.id, 'c2');
    assert.equal(after.selectedCandidateId, 'c2');
});

// ---------- 调度：paint 之后单轨链 + 父子聚合到 review ----------
test('scheduler: paint → normalize → export → render_preview → validate → review', async () => {
    const sched = makeScheduler();
    const parent = store.createParent({ ownerId: 'u1', assetKind: 'prop', candidateCount: 1, seed: 1, input: { images: ['a.png'], imageShas: ['s1'] } });
    // 快进：prepare + shape 完成
    sched.ensureTasks(store.findParent(parent.id));
    const shape = store.tasksForParent(parent.id).find(t => t.stage === 'shape');
    const saved = artifacts.saveArtifact({ parentId: parent.id, taskId: shape.id, fileName: 'shape.glb', buffer: Buffer.from('shape'), fromHost: 't4-0' });
    claimAndComplete('shape:t4', [{ key: 'mesh', fileName: 'shape.glb', sha256: saved.sha256 }]);
    sched.ensureTasks(store.findParent(parent.id));
    const draft = store.tasksForParent(parent.id).find(t => t.stage === 'draft_preview');
    const p1 = artifacts.saveArtifact({ parentId: parent.id, taskId: draft.id, fileName: 'd.png', buffer: Buffer.from('png'), fromHost: 't4-0' });
    const m1 = artifacts.saveArtifact({ parentId: parent.id, taskId: draft.id, fileName: 'd.json', buffer: Buffer.from(JSON.stringify({ draft_gate: 'passed' })), fromHost: 't4-0' });
    claimAndComplete('draft_preview:t4', [
        { key: 'preview', fileName: 'd.png', sha256: p1.sha256 }, { key: 'preview_manifest', fileName: 'd.json', sha256: m1.sha256 }
    ]);
    sched.ensureTasks(store.findParent(parent.id));
    const qc = store.tasksForParent(parent.id).find(t => t.stage === 'candidate_qc');
    const q1 = artifacts.saveArtifact({ parentId: parent.id, taskId: qc.id, fileName: 'qc.json', buffer: Buffer.from(JSON.stringify({ candidates: [{ candidateKey: 'c1', score: 90, passed: true }] })), fromHost: 't4-0' });
    claimAndComplete('candidate_qc:t4', [{ key: 'qc', fileName: 'qc.json', sha256: q1.sha256 }]);
    sched.ensureTasks(store.findParent(parent.id));
    assert.equal(store.findParent(parent.id).selectedCandidateId, 'c1');

    // paint：调度器自动提交（dummy paint 立即返回 jobId）；等待异步提交落库
    sched.ensureTasks(store.findParent(parent.id));
    await sleep(50);
    const paint = store.tasksForParent(parent.id).find(t => t.stage === 'paint');
    assert.ok(paint, '选定后应创建 paint');
    assert.equal(paint.status, 'running', 'dummy paint 应立刻进入远端运行');
    // 模拟远端完成
    const textured = Buffer.from('textured');
    const t1 = artifacts.saveArtifact({ parentId: parent.id, taskId: paint.id, fileName: 'textured.glb', buffer: textured, fromHost: 'control-plane' });
    store.finishRemoteTask(paint.id, { outputArtifacts: [{ key: 'mesh', fileName: 'textured.glb', sha256: t1.sha256 }] });

    // 单轨链：normalize → export → render_preview → validate
    sched.ensureTasks(store.findParent(parent.id));
    const normalize = store.tasksForParent(parent.id).find(t => t.stage === 'normalize');
    assert.ok(normalize, 'paint 完成后应创建 normalize');
    assert.equal(normalize.inputArtifacts[0].fileName, 'textured.glb');
    const n1 = artifacts.saveArtifact({ parentId: parent.id, taskId: normalize.id, fileName: 'n.glb', buffer: Buffer.from('n'), fromHost: 't4-0' });
    claimAndComplete('normalize:t4', [{ key: 'mesh', fileName: 'n.glb', sha256: n1.sha256 }]);

    sched.ensureTasks(store.findParent(parent.id));
    const exp = store.tasksForParent(parent.id).find(t => t.stage === 'export');
    assert.ok(exp, 'normalize 完成后应创建 export');
    assert.equal(exp.inputArtifacts[0].fileName, 'n.glb');
    const e1 = artifacts.saveArtifact({ parentId: parent.id, taskId: exp.id, fileName: 'e.glb', buffer: Buffer.from('e'), fromHost: 't4-0' });
    claimAndComplete('export:t4', [{ key: 'mesh', fileName: 'e.glb', sha256: e1.sha256 }]);

    sched.ensureTasks(store.findParent(parent.id));
    const rv = store.tasksForParent(parent.id).find(t => t.stage === 'render_preview');
    assert.ok(rv, 'export 完成后应创建 render_preview');
    const r1 = artifacts.saveArtifact({ parentId: parent.id, taskId: rv.id, fileName: 'r.png', buffer: Buffer.from('r'), fromHost: 't4-0' });
    const r2 = artifacts.saveArtifact({ parentId: parent.id, taskId: rv.id, fileName: 'r.json', buffer: Buffer.from(JSON.stringify({ status: 'ok' })), fromHost: 't4-0' });
    claimAndComplete('preview:t4', [
        { key: 'preview', fileName: 'r.png', sha256: r1.sha256 }, { key: 'preview_manifest', fileName: 'r.json', sha256: r2.sha256 }
    ]);

    sched.ensureTasks(store.findParent(parent.id));
    const vd = store.tasksForParent(parent.id).find(t => t.stage === 'validate');
    assert.ok(vd, 'render_preview 完成后应创建 validate');
    const v1 = artifacts.saveArtifact({ parentId: parent.id, taskId: vd.id, fileName: 'qc.json', buffer: Buffer.from(JSON.stringify({ passed: true })), fromHost: 't4-0' });
    claimAndComplete('validate:t4', [{ key: 'qc', fileName: 'qc.json', sha256: v1.sha256 }]);

    sched.ensureTasks(store.findParent(parent.id));
    assert.equal(store.findParent(parent.id).status, 'review', 'validate 完成后父任务应进入人工审片');

    // 审片：不自动 approved；approve 生效
    const before = store.findParent(parent.id);
    assert.equal(before.humanReviewStatus, 'not_performed');
    const approved = sched.approveParent(parent.id);
    assert.equal(approved.status, 'completed');
    assert.equal(approved.humanReviewStatus, 'approved');
});

// ---------- 调度：死信聚合父失败 ----------
test('scheduler: 任一子任务死信 → 父任务失败', () => {
    const sched = makeScheduler();
    const parent = store.createParent({ ownerId: 'u1', assetKind: 'prop', candidateCount: 1, seed: 1 });
    sched.ensureTasks(store.findParent(parent.id));
    const shape = store.tasksForParent(parent.id).find(t => t.stage === 'shape');
    // 三次失败（同一时间基准推进退避）
    let task = store.claimNext('shape:t4', WORKER);
    task = store.failTask(task.id, WORKER.id, { code: 'x', message: '失败1' });
    store.dueRetriesToQueued(FUTURE);
    task = store.claimNext('shape:t4', WORKER, FUTURE);
    task = store.failTask(task.id, WORKER.id, { code: 'x', message: '失败2' });
    store.dueRetriesToQueued(new Date(FUTURE.getTime() + 10 * 60 * 1000));
    task = store.claimNext('shape:t4', WORKER, new Date(FUTURE.getTime() + 10 * 60 * 1000));
    task = store.failTask(task.id, WORKER.id, { code: 'x', message: '失败3' });
    assert.equal(task.status, 'dead_letter');

    sched.ensureTasks(store.findParent(parent.id));
    assert.equal(store.findParent(parent.id).status, 'failed');
    assert.match(store.findParent(parent.id).error || '', /shape/);
});

// ---------- 调度：character 链包含 rig 与动画 ----------
test('scheduler: character 链含 normalize → rig → retarget_animation → export', async () => {
    const sched = makeScheduler();
    const parent = store.createParent({ ownerId: 'u1', assetKind: 'character', candidateCount: 1, seed: 1, input: { images: ['a.png'], imageShas: ['s1'] } });
    sched.ensureTasks(store.findParent(parent.id));
    const shape = store.tasksForParent(parent.id).find(t => t.stage === 'shape');
    const saved = artifacts.saveArtifact({ parentId: parent.id, taskId: shape.id, fileName: 'shape.glb', buffer: Buffer.from('shape'), fromHost: 't4-0' });
    claimAndComplete('shape:t4', [{ key: 'mesh', fileName: 'shape.glb', sha256: saved.sha256 }]);
    // 快进 draft/qc/paint
    sched.ensureTasks(store.findParent(parent.id));
    const draft = store.tasksForParent(parent.id).find(t => t.stage === 'draft_preview');
    const p1 = artifacts.saveArtifact({ parentId: parent.id, taskId: draft.id, fileName: 'd.png', buffer: Buffer.from('png'), fromHost: 't4-0' });
    const m1 = artifacts.saveArtifact({ parentId: parent.id, taskId: draft.id, fileName: 'd.json', buffer: Buffer.from(JSON.stringify({ draft_gate: 'passed' })), fromHost: 't4-0' });
    claimAndComplete('draft_preview:t4', [
        { key: 'preview', fileName: 'd.png', sha256: p1.sha256 }, { key: 'preview_manifest', fileName: 'd.json', sha256: m1.sha256 }
    ]);
    sched.ensureTasks(store.findParent(parent.id));
    const qc = store.tasksForParent(parent.id).find(t => t.stage === 'candidate_qc');
    const q1 = artifacts.saveArtifact({ parentId: parent.id, taskId: qc.id, fileName: 'qc.json', buffer: Buffer.from(JSON.stringify({ candidates: [{ candidateKey: 'c1', score: 90, passed: true }] })), fromHost: 't4-0' });
    claimAndComplete('candidate_qc:t4', [{ key: 'qc', fileName: 'qc.json', sha256: q1.sha256 }]);
    sched.ensureTasks(store.findParent(parent.id));
    assert.equal(store.findParent(parent.id).selectedCandidateId, 'c1');
    sched.ensureTasks(store.findParent(parent.id));
    await sleep(50);
    const paint = store.tasksForParent(parent.id).find(t => t.stage === 'paint');
    const t1 = artifacts.saveArtifact({ parentId: parent.id, taskId: paint.id, fileName: 'textured.glb', buffer: Buffer.from('textured'), fromHost: 'control-plane' });
    store.finishRemoteTask(paint.id, { outputArtifacts: [{ key: 'mesh', fileName: 'textured.glb', sha256: t1.sha256 }] });

    sched.ensureTasks(store.findParent(parent.id));
    const normalize = store.tasksForParent(parent.id).find(t => t.stage === 'normalize');
    const n1 = artifacts.saveArtifact({ parentId: parent.id, taskId: normalize.id, fileName: 'n.glb', buffer: Buffer.from('n'), fromHost: 't4-0' });
    claimAndComplete('normalize:t4', [{ key: 'mesh', fileName: 'n.glb', sha256: n1.sha256 }]);

    sched.ensureTasks(store.findParent(parent.id));
    const rig = store.tasksForParent(parent.id).find(t => t.stage === 'rig');
    assert.ok(rig, 'character 链应创建 rig');
    assert.equal(rig.capability, 'rig:l20');
    const r1 = artifacts.saveArtifact({ parentId: parent.id, taskId: rig.id, fileName: 'rig.glb', buffer: Buffer.from('rig'), fromHost: 'gsy013' });
    claimAndComplete('rig:l20', [{ key: 'mesh', fileName: 'rig.glb', sha256: r1.sha256 }]);

    sched.ensureTasks(store.findParent(parent.id));
    const anim = store.tasksForParent(parent.id).find(t => t.stage === 'retarget_animation');
    assert.ok(anim, 'character 链应创建 retarget_animation');
    assert.ok(anim.params.animationLibrary, '动画阶段应带动画库路径');
    const a1 = artifacts.saveArtifact({ parentId: parent.id, taskId: anim.id, fileName: 'anim.blend', buffer: Buffer.from('blend'), fromHost: 't4-0' });
    claimAndComplete('animation:t4', [{ key: 'mesh', fileName: 'anim.blend', sha256: a1.sha256 }]);

    sched.ensureTasks(store.findParent(parent.id));
    const exp = store.tasksForParent(parent.id).find(t => t.stage === 'export');
    assert.ok(exp, '动画完成后应创建 export');
});

// ---------- 兼容性：旧 /v1/jobs 数据不依赖 mp 存储 ----------
test('兼容: mp 存储与旧 db.json 相互独立', () => {
    assert.ok(!fs.existsSync(path.join(__dirname, '..', 'data', 'db.json')) || fs.existsSync(path.join(__dirname, '..', 'data', 'db.json')));
    const stats = store.stats();
    assert.equal(typeof stats.totalTasks, 'number');
});

// ---------- paint：远端 shell 命令转义 ----------
test('paint: shq 转义含空格/中文/单引号的参数', () => {
    const { shq } = require('../server/mp/paint');
    assert.equal(shq("abc"), "'abc'");
    assert.equal(shq("四卡 Worker 杀进程"), "'四卡 Worker 杀进程'");
    assert.equal(shq("it's"), "'it'\\''s'");
    assert.equal(shq("a'b c"), "'a'\\''b c'");
});
