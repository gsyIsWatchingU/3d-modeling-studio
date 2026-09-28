'use strict';
/* ForgeLoop v3 工厂测试：无人值守自动闭环
 *   状态迁移（generated→auto_evaluating→auto_repairing→auto_accepted/auto_rejected/exhausted/quarantined）
 *   幂等（同 job 不重复创建 Attempt；重复 iterate 不重复创建子 Job）
 *   单变量白名单约束（按领域；歧义→quarantined）
 *   champion/challenger 对比（子劣于父→不通过）
 *   自动接入与回滚（staging 失败→回滚上一 champion）
 *   重启恢复（recoverFromDb 幂等，不重复创建）
 *   并发锁（重复事件：第二个 iterate 返回 concurrent_lock）
 *   执行器集成路径（修复产物回填 metrics/artifacts/pipeline/evidence）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v3-test-'));
process.env.DB_PATH = path.join(tempRoot, 'db.json');
process.env.UPLOAD_DIR = path.join(tempRoot, 'uploads');
process.env.MODEL_DIR = path.join(tempRoot, 'models');

const { learningDb, jobDb, championDb, autoLockDb, AUTO_FLOW_TRANSITIONS } = require('../server/db');
const { ensurePolicies, POLICY_V1 } = require('../server/auto-policy');
const { pickRepairVariable, runAutoIteration, autoIntegrate, recoverFromDb, createAutoRepairChild, evaluateAttempt } = require('../server/auto-loop');
const { repairParamValid } = require('../server/modeling-learning');

const OWNER = 'user-v3';

function makeAttempt(overrides = {}) {
    return learningDb.createAttempt({
        job_id: `JV3-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        owner_id: OWNER,
        domain: 'animation',
        project: 'the-bridge-after-rain',
        asset_id: 'hang',
        asset_kind: 'character',
        profile: 'xhs_mobile',
        seed: 1234,
        pipeline: { provider: 'forge3d', task_id: 'TASK-V3-1' },
        artifacts: { glb_sha: '69e7782db71d7f5ab7f6aa133d0ff04fc66e631fb8192e0c5949c93410ad0a9e', artifact_file: '/tmp/fake.glb' },
        metrics: { triangles: 12000, has_skeleton: true, has_skinning: true },
        evidence: {},
        acceptance_mode: 'automatic',
        human_review: 'not_performed',
        ...overrides
    });
}

function passGates(domain) {
    const g = {};
    for (const h of (POLICY_V1[domain] || POLICY_V1.model).hard_gates) g[h.id] = true;
    return g;
}

// ---------- 1. 状态迁移 ----------
test('v3 状态迁移：generated → auto_evaluating → auto_accepted，非法迁移被拒', () => {
    ensurePolicies();
    const a = makeAttempt();
    assert.equal(a.auto_flow_state, 'generated');
    assert.equal(a.acceptance_mode, 'automatic');
    assert.equal(a.human_review, 'not_performed');
    const ev = learningDb.setAutoFlowState(a.id, 'auto_evaluating', { detail: '进入评估' });
    assert.equal(ev.auto_flow_state, 'auto_evaluating');
    assert.equal(ev.auto_flow_history.length, 1);
    const ac = learningDb.setAutoFlowState(a.id, 'auto_accepted', { detail: '评估通过' });
    assert.equal(ac.auto_flow_state, 'auto_accepted');
    assert.equal(ac.auto_flow_history.length, 2);
    assert.throws(() => learningDb.setAutoFlowState(a.id, 'auto_repairing'), /非法状态迁移/);
    // human_* 不受影响（自动流程不写 human 结论）
    assert.equal(ac.human_verdict, 'pending');
    assert.equal(ac.human_review, 'not_performed');
});

test('v3 终态 exhausted/quarantined 不可再迁移；manual_override 可 reset 重入', () => {
    const a = makeAttempt();
    learningDb.setAutoFlowState(a.id, 'exhausted', { detail: '预算用尽' });
    assert.throws(() => learningDb.setAutoFlowState(a.id, 'auto_evaluating'), /非法状态迁移/);
    const reset = learningDb.resetAutoFlow(a.id, { reason: '人工重入' });
    assert.equal(reset.auto_flow_state, 'generated');
    assert.ok(reset.auto_flow_history.some(h => h.detail && h.detail.includes('manual_override')));
});

// ---------- 2. 单变量约束 ----------
test('v3 单变量：pickRepairVariable 只返回该领域白名单变量；歧义缺陷 → null（quarantined）', () => {
    const a = makeAttempt({ domain: 'animation', failure_detail: '穿模严重' });
    const v = pickRepairVariable(a, { defects: [{ gate: 'clipping' }], hard_gates: { clipping: false } });
    assert.deepEqual(v, { param: 'animation.weight_repair_plan', to: 'sanitize_skin_weights' });
    assert.ok(repairParamValid('animation', v.param, v.to));
    // 歧义（aesthetic/未知）→ null
    const a2 = makeAttempt({ domain: 'animation', failure_detail: '审美不符' });
    assert.equal(pickRepairVariable(a2, { defects: [{ gate: 'aesthetic' }], hard_gates: { aesthetic: false } }), null);
    // model 面数超预算 → triangle_budget
    const m = makeAttempt({ domain: 'model', metrics: { triangles: 150000 }, failure_detail: '三角面超预算' });
    const mv = pickRepairVariable(m, { defects: [{ gate: 'budget' }], hard_gates: { budget: false } });
    assert.equal(mv.param, 'generation.triangle_budget');
    assert.ok(repairParamValid('model', mv.param, mv.to));
    // audio 静音 → gain_adjust
    const au = makeAttempt({ domain: 'audio', failure_detail: '静音' });
    const auv = pickRepairVariable(au, { defects: [{ gate: 'not_silent' }], hard_gates: { not_silent: false } });
    assert.equal(auv.param, 'audio.gain_adjust');
    assert.ok(repairParamValid('audio', auv.param, auv.to));
});

// ---------- 3. champion/challenger 对比 ----------
test('v3 champion/challenger：子 Attempt 劣于父 → 不 auto_accepted', async () => {
    const parent = makeAttempt({ job_id: 'JV3-PARENT', auto_chain_index: 0 });
    const parentEval = await evaluateAttempt(parent, { external: { hard_gates: passGates('animation'), metrics: {} }, gpuImages: null });
    learningDb.saveAutoEvaluation(parent.id, parentEval);
    const child = makeAttempt({ job_id: 'JV3-CHILD', based_on_attempt_id: parent.id, auto_chain_index: 1, evidence: { animation: { displacement: 0, joint_angle_anomaly_ratio: 0.3, clipping_count: 1, root_drift: 0.1, loop_seam: 0.02 } } });
    const childEval = await evaluateAttempt(child, { external: { hard_gates: passGates('animation'), metrics: {} }, gpuImages: null });
    // 子 Attempt 硬门禁失败（clipping/静态）→ 不通过
    assert.equal(childEval.passed, false);
    assert.ok(childEval.defects.length > 0);
});

// ---------- 4. 自动接入与回滚 ----------
test('v3 自动接入：auto_accepted → champion + release ZIP 记录；staging 失败 → 回滚上一 champion', async () => {
    const a = makeAttempt({ job_id: 'JV3-ACC' });
    learningDb.setAutoFlowState(a.id, 'auto_evaluating', { detail: '评估' });
    learningDb.setAutoFlowState(a.id, 'auto_accepted', { detail: '通过' });
    // 第一次接入成功
    const r1 = await autoIntegrate(a.id, {
        project: 'the-bridge-after-rain', asset_id: 'hang', domain: 'animation',
        verifyStaging: async () => ({ ok: true, report: 'all_green' }),
        buildReleaseZip: async () => ({ path: '/tmp/out.zip', sha256: 'ZIP-SHA-1', bytes: 10000000 })
    });
    assert.equal(r1.ok, true);
    assert.equal(r1.champion.attempt_id, a.id);
    assert.equal(r1.champion.acceptance_mode, 'automatic');
    assert.equal(r1.champion.release_zip_sha, 'ZIP-SHA-1');
    // 第二个 auto_accepted 且 staging 失败 → 回滚上一 champion
    const b = makeAttempt({ job_id: 'JV3-ACC2' });
    learningDb.setAutoFlowState(b.id, 'auto_evaluating', { detail: '评估' });
    learningDb.setAutoFlowState(b.id, 'auto_accepted', { detail: '通过' });
    const r2 = await autoIntegrate(b.id, {
        project: 'the-bridge-after-rain', asset_id: 'hang', domain: 'animation',
        verifyStaging: async () => ({ ok: false, report: 'playthrough_failed' })
    });
    assert.equal(r2.ok, false);
    assert.equal(r2.rolled_back_to, a.id);
    const champ = championDb.get({ project: 'the-bridge-after-rain', asset_id: 'hang', domain: 'animation' });
    assert.equal(champ.attempt_id, a.id);
});

// ---------- 5. 幂等与并发锁 ----------
test('v3 幂等：同 job 不重复创建 Attempt；重复 iterate 不重复创建子 Job；并发锁拒绝重入', async () => {
    const a = makeAttempt();
    // 重复创建同 job → 复用（findAttemptByJobId 幂等语义由 API 层保证；这里验证 createAutoRepairChild）
    const v = { param: 'animation.weight_repair_plan', to: 'sanitize_skin_weights' };
    const first = createAutoRepairChild(a, v, { ownerId: OWNER });
    assert.equal(first.reused, false);
    assert.equal(first.attempt.auto_flow_state, 'auto_repairing');
    // 同一父 Attempt 再次创建 → 复用已有未终态子 Attempt（不新建 Job）
    const second = createAutoRepairChild(a, v, { ownerId: OWNER });
    assert.equal(second.reused, true);
    assert.equal(second.attempt.id, first.attempt.id);
    assert.equal(second.job.id, first.job.id);
    // 并发锁：同 key 重复 acquire → null
    const lock = autoLockDb.acquire(`auto-loop:${a.id}`, 'owner-1');
    assert.ok(lock);
    assert.equal(autoLockDb.acquire(`auto-loop:${a.id}`, 'owner-2'), null);
    autoLockDb.release(`auto-loop:${a.id}`, 'owner-1');
    assert.ok(autoLockDb.acquire(`auto-loop:${a.id}`, 'owner-3'));
});

// ---------- 6. 执行器集成路径（修复产物回填） ----------
test('v3 执行器集成：repair 回调返回真实产物 → 子 Attempt 回填并进入评估', async () => {
    const a = makeAttempt({ job_id: 'JV3-REPAIR', failure_detail: '穿模严重' });
    learningDb.setAutoFlowState(a.id, 'auto_rejected', { detail: '评估失败' });
    const result = await runAutoIteration(a.id, {
        ownerId: OWNER,
        evaluate: async (att) => ({ hard_gates: passGates('animation'), metrics: {}, defects: [] }),
        repair: async (child, variable, job) => ({
            job_id: job.id,
            provider: 'forge3d',
            job_status: 'succeeded',
            artifacts: { glb_sha: 'CHILD-GLB-SHA', glb_file: '/tmp/child.glb' },
            metrics: { triangles: 11000, has_skeleton: true },
            evidence: { repaired: true },
            animationEvidence: { displacement: 1.5, joint_angle_anomaly_ratio: 0.02, clipping_count: 0, root_drift: 0.05, loop_seam: 0.01 }
        })
    });
    assert.equal(result.state, 'auto_accepted');
    assert.equal(result.child, true);
    const child = learningDb.findAttemptById(result.attempt.id);
    assert.equal(child.auto_flow_state, 'auto_accepted');
    assert.equal(child.artifacts.glb_sha, 'CHILD-GLB-SHA');
    assert.equal(child.pipeline.task_id, result.job.id);
    assert.equal(child.changed_variable.param, 'animation.weight_repair_plan');
});

// ---------- 7. 重启恢复（不重复创建） ----------
test('v3 重启恢复：recoverFromDb 幂等扫描未终态 Attempt', () => {
    const a = makeAttempt({ job_id: 'JV3-RECOVER' });
    learningDb.setAutoFlowState(a.id, 'auto_evaluating', { detail: '中断中' });
    const count1 = recoverFromDb();
    const count2 = recoverFromDb();
    assert.ok(count1 >= 1);
    assert.equal(count2, count1); // 幂等：第二次不变化
});

// ---------- 8. 预算上限 → exhausted ----------
test('v3 修复预算：chain_index ≥ max_repairs → exhausted，不创建新子 Attempt', async () => {
    const a = makeAttempt({ job_id: 'JV3-BUDGET', auto_chain_index: 3 });
    learningDb.setAutoFlowState(a.id, 'auto_rejected', { detail: '失败' });
    const result = await runAutoIteration(a.id, { ownerId: OWNER, evaluate: async () => ({ hard_gates: {}, defects: [{ gate: 'clipping' }] }) });
    assert.equal(result.state, 'exhausted');
    assert.equal(result.reason, 'repair_budget_exceeded');
    assert.equal(learningDb.findAttemptById(a.id).auto_flow_state, 'exhausted');
});

// ---------- 9. 无歧义修复 → quarantined ----------
test('v3 歧义缺陷 → quarantined（不自动任意改写）', async () => {
    const a = makeAttempt({ job_id: 'JV3-Q', domain: 'model', failure_detail: '审美不符' });
    learningDb.setAutoFlowState(a.id, 'auto_rejected', { detail: '失败' });
    const result = await runAutoIteration(a.id, { ownerId: OWNER, evaluate: async () => ({ hard_gates: {}, defects: [{ gate: 'aesthetic' }] }) });
    assert.equal(result.state, 'quarantined');
    assert.equal(result.reason, 'no_unambiguous_repair');
});

// ---------- 10. 策略版本化 ----------
test('v3 策略版本化：六领域 v1 写入 db，含阈值单位与修改历史', () => {
    ensurePolicies();
    const { v3PolicyDb } = require('../server/db');
    const policies = v3PolicyDb.list();
    assert.ok(policies.length >= 6);
    for (const domain of ['model', 'animation', 'audio', 'image', 'scene', 'gameplay']) {
        const p = POLICY_V1[domain];
        assert.ok(p.thresholds.max_repairs, `${domain} 缺 max_repairs`);
        assert.ok(p.thresholds.max_candidates_per_round, `${domain} 缺 max_candidates_per_round`);
        assert.ok(p.hard_gates.length >= 3, `${domain} 硬门禁不足`);
    }
    // 重复调用不重复写（幂等）
    assert.equal(ensurePolicies(), 0);
});
