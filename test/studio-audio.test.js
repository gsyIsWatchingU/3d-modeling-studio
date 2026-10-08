const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { waitFor, wavFixture } = require('../test-support/studio-fixture');

test('独立音效 Worker：恢复任务、失败不生成资源、成功仍待人工试听', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-audio-worker-'));
    process.env.DB_PATH = path.join(root, 'db.json'); process.env.UPLOAD_DIR = path.join(root, 'uploads'); process.env.MODEL_DIR = path.join(root, 'models');
    const { studioDb } = require('../server/db');
    const { startStudioWorker } = require('../server/studio-worker');
    const plan = studioDb.create('plans', { kind: 'sfx', name: '音效测试', prompt: 'test fixture', duration: 1 }, 1);
    const failure = studioDb.create('tasks', { plan_id: plan.id, name: '显存不足任务', status: 'queued' }, 1);
    const resumed = studioDb.create('tasks', { plan_id: plan.id, name: '重启恢复任务', status: 'running' }, 1);
    let calls = 0;
    // 仅模拟生成器输出，绝不执行真实推理或为生产提供合成回退。
    const worker = startStudioWorker({ generate: async (task, input, targetDir) => {
        calls++; assert.equal(input.id, plan.id);
        if (task.id === failure.id) throw new Error('GPU 空闲显存不足');
        const bytes = wavFixture(), filename = task.id + '.wav'; fs.mkdirSync(targetDir, { recursive: true }); fs.writeFileSync(path.join(targetDir, filename), bytes);
        return { filename, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), readiness: { backends: { sfx: { dependencies_ready: true, weights_cached: true, inference_verified: false } } }, evidence: { generation_status: 'generated', technical_status: 'passed', review_status: 'pending', fixture: true } };
    } });
    t.after(() => { worker.stop(); if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(root, { recursive: true, force: true }); });
    await waitFor(() => ['succeeded', 'failed'].includes(studioDb.get('tasks', resumed.id, 1).status));
    assert.equal(studioDb.get('tasks', resumed.id, 1).status, 'succeeded', studioDb.get('tasks', resumed.id, 1).error);
    assert.equal(calls, 2); assert.equal(studioDb.get('tasks', failure.id, 1).status, 'failed');
    assert.match(studioDb.get('tasks', failure.id, 1).error, /显存不足/);
    const assets = studioDb.list('assets', 1); assert.equal(assets.length, 1); assert.equal(assets[0].review, 'pending');
    assert.equal(assets[0].evidence.review_status, 'pending'); assert.equal(assets[0].readiness.backends.sfx.inference_verified, false);
    assert.equal(studioDb.list('assets', 2).length, 0); assert.equal(studioDb.list('shares').length, 0);
});
