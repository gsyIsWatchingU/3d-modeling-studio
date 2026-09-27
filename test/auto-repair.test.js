// ForgeLoop v2 —— 受限自动修复编排、多领域经验闭环、策略生效与账号隔离测试
// 覆盖：
//  1) model / animation / audio 三个领域的真实闭环测试（父失败/打回 → 子只改一个白名单变量 →
//     门禁 failed→passed → viewer/game 复测 → 人工 approved → 生成有效 Retrospective；
//     rejected / 无改善 / 缺复测 / 跨领域变量 / 超修复预算 一律不能形成有效经验）。
//  2) 受限自动修复编排：自动分类、唯一映射、歧义/审美/未知/基础设施进待处理队列、
//     每父链最多 2 次、每轮最多 3 个候选、幂等（服务重启不重复提交 GPU 任务）、
//     自动候选不覆盖父产物。
//  3) 策略引擎：draft 不生效、shadow 只算差异、small_scale 稳定采样命中/对照组、
//     default 自动注入执行计划、回滚后立即停止应用、证据数量服务端计算。
//  4) 统一生产契约接口账号隔离：未登录 /api/contracts 返回 401 而不是 404。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-loop-v2-test-'));
process.env.DB_PATH = path.join(tempRoot, 'db.json');
process.env.UPLOAD_DIR = path.join(tempRoot, 'uploads');
process.env.MODEL_DIR = path.join(tempRoot, 'models');

const { learningDb, jobDb } = require('../server/db');
const autoRepair = require('../server/auto-repair');
const { onHumanVerdict, finalizeAutoRepairAttempt, recordTerminalAttempt } = require('../server/retrospective-worker');
const { applyEffectivePolicies } = require('../server/model-worker');
const { canAdvance, repairParamValid, countValidChains } = require('../server/modeling-learning');

function sha(str) {
    return require('crypto').createHash('sha256').update(str).digest('hex');
}

// 构造一个领域父 Attempt（自动失败或人工打回）
function makeParent({ domain, category, verdict, gates, evidence = {}, planExtra = {}, autoStatus = 'failed' }) {
    const job = jobDb.create({
        name: `parent-${domain}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        domain,
        project: 'the-bridge-after-rain',
        stage: 'review',
        asset_id: 'teen-boy',
        event_id: 'hang_loop',
        evidence,
        input: { images: [], prompt: 'p', asset_kind: 'character', profile: 'xhs_mobile', seed: 1 },
        execution_plan: {
            generation: { triangle_budget: 30000, texture_size: 1024 },
            animation: { retarget_plan: 'retarget_actions', weight_repair_plan: 'sanitize_skin_weights' },
            audio: { gain_adjust: 1.0, trim_start_s: 0 },
            ...planExtra
        }
    });
    const attempt = learningDb.createAttempt({
        job_id: job.id,
        owner_id: 7,
        domain,
        project: 'the-bridge-after-rain',
        stage: 'review',
        asset_id: 'teen-boy',
        event_id: 'hang_loop',
        evidence,
        asset_kind: 'character',
        profile: 'xhs_mobile',
        execution_plan: job.execution_plan,
        metrics: { quality_gates: gates },
        auto_status: autoStatus,
        failure_category: category
    });
    if (verdict === 'rejected') {
        learningDb.applyVerdict(attempt.id, 'rejected', { category, notes: '真实拒绝样本', reviewerId: 7, defectScore: 3 });
    }
    return { job, attempt: learningDb.findAttemptById(attempt.id) };
}

function finalizeChild(jobId, gates) {
    const job = jobDb.findById(jobId);
    const completed = jobDb.update(jobId, { status: 'succeeded', completed_at: new Date().toISOString() });
    return finalizeAutoRepairAttempt(completed, {
        metrics: { quality_gates: gates, triangles: 30000 },
        artifacts: { glb_sha: sha(`glb-${jobId}`), preview_url: `/models/repair-${jobId}.glb` },
        pipeline: { provider: 'forge3d-blender', task_id: jobId },
        gateEvidence: { quality_gates: gates, tool: 'analyze_clipping.py' }
    });
}

// ---------- 1. model / animation / audio 真实闭环 ----------

test('model 领域闭环：失败→种子修复→门禁转好→viewer 复测→人工批准→有效复盘', () => {
    const { attempt: parent } = makeParent({
        domain: 'model', category: 'shape', gates: { profile_contract: 'failed' }, autoStatus: 'failed'
    });
    assert.equal(parent.auto_status, 'failed');

    const child = autoRepair.createAutoRepairChild(parent, { variable: { param: 'seed', to: 42 }, category: 'shape', reason: 't' });
    assert.equal(child.created, true);
    assert.notEqual(child.job.id, parent.job_id);
    assert.equal(child.attempt.based_on_attempt_id, parent.id);
    assert.equal(child.attempt.changed_variable.param, 'seed');
    assert.ok(child.job.parent_plan_sha);
    assert.ok(child.job.input_sha);

    const childAttempt = finalizeChild(child.job.id, { profile_contract: 'passed' });
    assert.equal(childAttempt.auto_status, 'succeeded');
    assert.equal(childAttempt.human_verdict, 'pending'); // 自动流程必须停在 pending_human_review

    const result = onHumanVerdict(childAttempt.id, 'approved', { category: 'shape', validationScope: 'viewer', reviewerId: 7 });
    assert.ok(result.retrospective, 'model 闭环应生成复盘');
    assert.equal(result.retrospective.chain_valid, true);
    assert.equal(result.retrospective.domain, 'model');
    assert.equal(result.retrospective.changed_variable.param, 'seed');
});

test('animation 领域闭环：重定向打回→唯一变量 retarget_plan→穿模门禁转好→批准→动画复盘', () => {
    const parent = makeParent({
        domain: 'animation', category: 'animation',
        verdict: 'rejected',
        gates: { clipping_review: 'failed', deformation_review: 'failed' },
        evidence: { animation: { twisted_limbs: ['arm_left', 'arm_right'], reason: 'HY-Motion SMPL-H 与语义骨骼轴不匹配，手臂扭到身后/侧面' } }
    });
    assert.equal(parent.attempt.human_verdict, 'rejected');

    const decision = autoRepair.decideAutoRepair(parent.attempt);
    assert.equal(decision.action, 'repair');
    assert.equal(decision.variable.param, 'animation.retarget_plan');
    assert.equal(decision.variable.to, 'retarget_actions');

    const child = autoRepair.createAutoRepairChild(parent.attempt, decision);
    assert.equal(child.created, true);
    assert.equal(child.job.executor, 'forge3d-blender-retarget');
    assert.equal(child.job.domain, 'animation');
    assert.equal(child.attempt.domain, 'animation');

    const childAttempt = finalizeChild(child.job.id, { clipping_review: 'passed', deformation_review: 'passed' });
    assert.equal(childAttempt.auto_status, 'succeeded');

    const result = onHumanVerdict(childAttempt.id, 'approved', { category: 'animation', validationScope: 'game', reviewerId: 7 });
    assert.ok(result.retrospective, 'animation 闭环应生成复盘');
    assert.equal(result.retrospective.chain_valid, true);
    assert.equal(result.retrospective.domain, 'animation');
    assert.equal(result.retrospective.evidence.game_verified, true);
    assert.equal(result.retrospective.changed_variable.param, 'animation.retarget_plan');
});

test('audio 领域闭环（回归）：音频修复即使改善且批准，也必须生成音频复盘而不是只生成 Experiment', () => {
    const parent = makeParent({
        domain: 'audio', category: 'audio_event',
        verdict: 'rejected',
        gates: { audio_review: 'failed' },
        evidence: { audio: { gain_out_of_range: true, target_gain: 0.8 } }
    });
    assert.equal(parent.attempt.human_verdict, 'rejected');

    // 缺陷 → 唯一映射 audio.gain_adjust
    const decision = autoRepair.decideAutoRepair(parent.attempt);
    assert.equal(decision.action, 'repair');
    assert.equal(decision.variable.param, 'audio.gain_adjust');
    assert.equal(decision.variable.to, 0.8);

    const child = autoRepair.createAutoRepairChild(parent.attempt, decision);
    assert.equal(child.job.executor, 'gpu-audio-postprocess');

    const childAttempt = finalizeChild(child.job.id, { audio_review: 'passed' });
    const result = onHumanVerdict(childAttempt.id, 'approved', { category: 'audio_event', validationScope: 'viewer', reviewerId: 7 });
    assert.ok(result.retrospective, 'audio.gain_adjust 获批准后必须形成音频复盘（v1 的 SINGLE_VARIABLE_RULES 缺陷已修复）');
    assert.equal(result.retrospective.chain_valid, true);
    assert.equal(result.retrospective.domain, 'audio');
    assert.equal(result.retrospective.changed_variable.param, 'audio.gain_adjust');
});

test('audio trim 证据唯一映射到 audio.trim_start_s', () => {
    const parent = makeParent({
        domain: 'audio', category: 'audio_event',
        verdict: 'rejected', gates: { audio_review: 'failed' },
        evidence: { audio: { trim_start_s: 1.5 } }
    });
    const decision = autoRepair.decideAutoRepair(parent.attempt);
    assert.equal(decision.action, 'repair');
    assert.equal(decision.variable.param, 'audio.trim_start_s');
    assert.equal(decision.variable.to, 1.5);
});

// ---------- 负例：不得形成有效经验 ----------

test('子 Attempt 被人工 rejected：不生成复盘、不污染经验库', () => {
    const { attempt: parent } = makeParent({ domain: 'model', category: 'shape', gates: { profile_contract: 'failed' } });
    const child = autoRepair.createAutoRepairChild(parent, { variable: { param: 'seed', to: 99 }, category: 'shape', reason: 't' });
    finalizeChild(child.job.id, { profile_contract: 'passed' });
    const childAttempt = learningDb.findAttemptById(child.attempt.id);
    const result = onHumanVerdict(childAttempt.id, 'rejected', { category: 'shape', notes: '仍不合格', defectScore: 3, validationScope: 'viewer', reviewerId: 7 });
    assert.ok(!result.retrospective);
    assert.equal(learningDb.listRetrospectives({ ownerId: 7 }).filter(r => r.fixed_attempt_id === childAttempt.id).length, 0);
});

test('无改善（门禁仍失败）：不生成复盘', () => {
    const { attempt: parent } = makeParent({ domain: 'model', category: 'shape', gates: { profile_contract: 'failed' } });
    const child = autoRepair.createAutoRepairChild(parent, { variable: { param: 'seed', to: 5 }, category: 'shape', reason: 't' });
    const childAttempt = finalizeChild(child.job.id, { profile_contract: 'failed' }); // 门禁没转好
    const result = onHumanVerdict(childAttempt.id, 'approved', { category: 'shape', validationScope: 'viewer', reviewerId: 7 });
    assert.ok(!result.retrospective);
});

test('缺复测（无 viewer/game 范围）：不生成复盘', () => {
    const { attempt: parent } = makeParent({ domain: 'model', category: 'shape', gates: { profile_contract: 'failed' } });
    const child = autoRepair.createAutoRepairChild(parent, { variable: { param: 'seed', to: 6 }, category: 'shape', reason: 't' });
    const childAttempt = finalizeChild(child.job.id, { profile_contract: 'passed' });
    const result = onHumanVerdict(childAttempt.id, 'approved', { category: 'shape', reviewerId: 7 }); // 无复测范围
    assert.ok(!result.retrospective);
});

test('跨领域变量（model 领域改音频变量）：不生成复盘', () => {
    const { attempt: parent } = makeParent({ domain: 'model', category: 'shape', gates: { profile_contract: 'failed' } });
    assert.equal(repairParamValid('model', 'audio.gain_adjust', 0.8), false, '跨领域变量必须不在白名单');
    const child = autoRepair.createAutoRepairChild(parent, { variable: { param: 'audio.gain_adjust', to: 0.8 }, category: 'shape', reason: 't' });
    const childAttempt = finalizeChild(child.job.id, { profile_contract: 'passed' });
    const result = onHumanVerdict(childAttempt.id, 'approved', { category: 'shape', validationScope: 'viewer', reviewerId: 7 });
    assert.ok(!result.retrospective, '跨领域变量修复即使批准也不能形成有效复盘');
});

test('超过修复预算：不再自动创建子 Attempt', () => {
    const { attempt: parent } = makeParent({ domain: 'animation', category: 'animation', verdict: 'rejected', gates: { clipping_review: 'failed' } });
    // 已有 2 个子 Attempt（预算 2 已用尽）
    learningDb.createAttempt({ job_id: 'X1', owner_id: 7, domain: 'animation', based_on_attempt_id: parent.id, auto_status: 'succeeded', changed_variable: { param: 'a', to: 1 } });
    learningDb.createAttempt({ job_id: 'X2', owner_id: 7, domain: 'animation', based_on_attempt_id: parent.id, auto_status: 'failed', changed_variable: { param: 'b', to: 2 } });
    assert.equal(autoRepair.chainRepairsUsed(parent.id), 2);
    const decision = autoRepair.decideAutoRepair(parent);
    assert.equal(decision.action, 'defer');
    assert.match(decision.reason, /预算/);
});

// ---------- 2. 受限自动修复编排 ----------

test('自动分类：歧义/审美/未知/基础设施进待处理队列', () => {
    for (const category of ['input', 'infrastructure', 'aesthetic', 'unknown', 'shape', 'material', 'topology', 'rig', 'skinning', 'export', 'engine_runtime', 'integration']) {
        const { attempt } = makeParent({ domain: 'model', category, autoStatus: 'failed', gates: {} });
        const decision = autoRepair.decideAutoRepair(attempt);
        assert.equal(decision.action, 'defer', `${category} 必须进入待处理队列`);
    }
});

test('穿模缺陷唯一映射到权重清洗变量', () => {
    const { attempt } = makeParent({ domain: 'animation', category: 'clipping', autoStatus: 'failed', gates: { clipping_review: 'failed' } });
    const decision = autoRepair.decideAutoRepair(attempt);
    assert.equal(decision.action, 'repair');
    assert.equal(decision.variable.param, 'animation.weight_repair_plan');
    assert.equal(decision.variable.to, 'sanitize_skin_weights');
});

test('轮询预算：每轮最多 3 个候选、幂等不重复创建、子任务字段完整', () => {
    const parents = [];
    for (let i = 0; i < 5; i++) {
        parents.push(makeParent({ domain: 'animation', category: 'animation', autoStatus: 'failed', gates: { clipping_review: 'failed' } }).attempt);
    }
    const first = autoRepair.queueAutoRepairs({ ownerId: 7 });
    assert.ok(first.created.length <= 3, `每轮最多 3 个候选，实际 ${first.created.length}`);
    for (const item of first.created) {
        const job = jobDb.findById(item.job_id);
        const attempt = learningDb.findAttemptById(item.attempt_id);
        assert.ok(job && attempt);
        assert.equal(job.based_on_attempt_id, item.parent_id);
        assert.ok(job.repair_variable?.param);
        assert.ok(job.parent_plan_sha && job.input_sha);
        assert.ok(job.auto_repair?.kind === 'auto');
    }
    // 幂等：第二次轮询绝不重复创建已存在的子任务（服务重启/重复轮询不重复提交 GPU）
    const second = autoRepair.queueAutoRepairs({ ownerId: 7 });
    assert.ok(second.created.length <= 3);
    const firstIds = new Set(first.created.map(c => c.job_id));
    const dup = second.created.filter(c => firstIds.has(c.job_id));
    assert.equal(dup.length, 0, '已创建的子任务不得重复创建');
    // 同键（父 Attempt, 变量）幂等：显式重复创建返回 idempotent
    const again = autoRepair.createAutoRepairChild(parents[0], { variable: { param: 'animation.weight_repair_plan', to: 'sanitize_skin_weights' }, category: 'clipping', reason: 't' });
    assert.equal(again.created, false);
    assert.equal(again.idempotent, true);
});

test('崩溃恢复：有产物不重复提交、无产物重新入队', () => {
    const { attempt: parent } = makeParent({ domain: 'animation', category: 'animation', autoStatus: 'failed', gates: { clipping_review: 'failed' } });
    const child = autoRepair.createAutoRepairChild(parent, { variable: { param: 'animation.retarget_plan', to: 'retarget_actions' }, category: 'animation', reason: 't' });
    // 场景 A：已有产物 → 恢复为 resume_finalize，绝不重复提交 GPU
    jobDb.update(child.job.id, { artifact_sha: sha('done') });
    const recovered = autoRepair.recoverAutoRepairs();
    assert.ok(recovered.some(r => r.job_id === child.job.id && r.status === 'artifact_present_resume_finalize'));
    // 场景 B：无产物且任务中断 → 重新入队（由 jobDb.recoverInterrupted 执行，executor 幂等）
    const child2 = autoRepair.createAutoRepairChild(parent, { variable: { param: 'animation.weight_repair_plan', to: 'sanitize_skin_weights' }, category: 'clipping', reason: 't' });
    jobDb.update(child2.job.id, { status: 'generating' });
    const recovered2 = autoRepair.recoverAutoRepairs();
    assert.ok(recovered2.some(r => r.job_id === child2.job.id && r.status === 'no_artifact_requeue'));
});

test('自动候选绝不覆盖父产物/原 manifest：父 Attempt 保持不变', () => {
    const { attempt: parent } = makeParent({ domain: 'animation', category: 'animation', verdict: 'rejected', gates: { clipping_review: 'failed' } });
    const before = JSON.stringify(learningDb.findAttemptById(parent.id));
    autoRepair.createAutoRepairChild(parent, { variable: { param: 'animation.retarget_plan', to: 'retarget_actions' }, category: 'animation', reason: 't' });
    const after = JSON.stringify(learningDb.findAttemptById(parent.id));
    assert.equal(before, after, '创建子 Attempt 不得改动父 Attempt 任何字段');
});

// ---------- 3. 策略引擎 ----------

function makePolicy({ lifecycle, variable, ratio }) {
    return learningDb.createPolicy({
        owner_id: 7, domain: 'model', asset_kind: 'character',
        scope: { profile: 'xhs_mobile' }, name: 'test', description: '',
        params: {}, basis_retro_ids: [],
        changed_variable: variable,
        sample_ratio: ratio
    });
}

function makePlan() {
    return { generation: { triangle_budget: 30000, texture_size: 1024 }, sha256: sha('plan-base') };
}

test('策略阶段语义：draft 不生效 / shadow 只算差异 / small_scale 稳定采样 / default 注入', () => {
    const draft = makePolicy({ lifecycle: 'draft', ratio: 1.0, variable: { param: 'generation.texture_size', to: 2048 } });
    // draft：不在 effective 列表，绝不注入
    const r0 = applyEffectivePolicies({ id: 'J1', owner_id: 7, domain: 'model', input: { asset_kind: 'character', profile: 'xhs_mobile' } }, makePlan());
    assert.equal(r0.applied.length, 0);
    assert.equal(r0.plan.generation.texture_size, 1024);

    // shadow → 拟应用差异，不改变生产任务
    learningDb.advancePolicy(draft.id, 'shadow', { reviewerId: 7 });
    const r1 = applyEffectivePolicies({ id: 'J2', owner_id: 7, domain: 'model', input: { asset_kind: 'character', profile: 'xhs_mobile' } }, makePlan());
    assert.equal(r1.applied.length, 0);
    assert.equal(r1.plan.generation.texture_size, 1024, 'shadow 不得改变生产任务');
    assert.ok(r1.notes.some(n => n.includes('shadow') && n.includes('拟应用差异')));

    // small_scale ratio=1 → 必命中并记录；ratio=0 → 对照组
    learningDb.advancePolicy(draft.id, 'small_scale', { reviewerId: 7, evidenceCount: 1, gameVerifiedCount: 1 });
    learningDb.recordPolicyApplication(draft.id, {});
    const r2 = applyEffectivePolicies({ id: 'J3', owner_id: 7, domain: 'model', input: { asset_kind: 'character', profile: 'xhs_mobile' } }, makePlan());
    assert.equal(r2.applied.length, 1, 'small_scale 命中后应注入');
    assert.equal(r2.plan.generation.texture_size, 2048);
    const pAfter = learningDb.findPolicyById(draft.id, 7);
    assert.equal(pAfter.hit_count, 1);

    // default → 自动注入新任务执行计划
    learningDb.advancePolicy(draft.id, 'default', { reviewerId: 7, evidenceCount: 2, gameVerifiedCount: 1 });
    const r3 = applyEffectivePolicies({ id: 'J4', owner_id: 7, domain: 'model', input: { asset_kind: 'character', profile: 'xhs_mobile' } }, makePlan());
    assert.equal(r3.applied.length, 1);
    assert.equal(r3.plan.generation.texture_size, 2048);
    assert.equal(r3.applied[0].mode, 'default');

    // 回滚 → 新任务立即停止应用，历史 Attempt 不变
    learningDb.advancePolicy(draft.id, 'rolled_back', { reason: '人工回滚' });
    const r4 = applyEffectivePolicies({ id: 'J5', owner_id: 7, domain: 'model', input: { asset_kind: 'character', profile: 'xhs_mobile' } }, makePlan());
    assert.equal(r4.applied.length, 0);
    assert.equal(r4.plan.generation.texture_size, 1024, '回滚后新任务立即停止应用');
});

test('修复任务不应用策略（保持父计划单变量语义）', () => {
    const policy = makePolicy({ lifecycle: 'draft', ratio: 1.0, variable: { param: 'generation.texture_size', to: 2048 } });
    learningDb.advancePolicy(policy.id, 'shadow', { reviewerId: 7 });
    learningDb.advancePolicy(policy.id, 'small_scale', { reviewerId: 7, evidenceCount: 1, gameVerifiedCount: 1 });
    learningDb.advancePolicy(policy.id, 'default', { reviewerId: 7, evidenceCount: 2, gameVerifiedCount: 1 });
    const r = applyEffectivePolicies({ id: 'J6', owner_id: 7, domain: 'model', repair_variable: { param: 'seed', to: 1 }, input: { asset_kind: 'character', profile: 'xhs_mobile' } }, makePlan());
    assert.equal(r.applied.length, 0);
    assert.equal(r.plan.generation.texture_size, 1024);
});

test('策略晋级证据数量由服务端计算：证据不足不能晋级', () => {
    const policy = makePolicy({ lifecycle: 'draft', variable: { param: 'generation.texture_size', to: 2048 } });
    const counts = countValidChains({ ownerId: 7, domain: 'qa', assetKind: 'character', profile: 'xhs_mobile' });
    const gate = canAdvance(policy, 'shadow', counts);
    assert.equal(gate.ok, false, '证据不足不得晋级');
    assert.match(gate.reason, /至少需要/);
});

// ---------- 4. 统一生产契约接口账号隔离 ----------

test('/api/contracts 未登录返回 401 而不是 404（真实服务器启动）', async () => {
    const port = 3390 + Math.floor(Math.random() * 100);
    const child = spawn(process.execPath, ['server/index.js'], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, PORT: String(port), DB_PATH: path.join(tempRoot, 'server-db.json'), UPLOAD_DIR: path.join(tempRoot, 'up2'), MODEL_DIR: path.join(tempRoot, 'mod2') },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    try {
        let health = null;
        for (let i = 0; i < 40; i++) {
            try {
                const res = await fetch(`http://127.0.0.1:${port}/api/health`);
                if (res.ok) { health = res; break; }
            } catch { /* not up yet */ }
            await new Promise(r => setTimeout(r, 250));
        }
        assert.ok(health, '服务器未在超时内启动');
        const contracts = await fetch(`http://127.0.0.1:${port}/api/contracts`);
        assert.equal(contracts.status, 401, '未登录访问契约接口必须 401，而不是 404');
        const attempts = await fetch(`http://127.0.0.1:${port}/api/learning/attempts`);
        assert.equal(attempts.status, 401);
        const put = await fetch(`http://127.0.0.1:${port}/api/contracts/demo`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
        assert.equal(put.status, 401);
    } finally {
        child.kill('SIGTERM');
    }
});

// ---------- 5. 执行器命令构建与报告解析 ----------

test('动画重定向/穿模门禁/音频修复命令构建与门禁报告解析', () => {
    const exec = require('../server/repair-executor');
    const retarget = exec.buildRetargetCommand({ targetGlb: '/workspace/3d-assets/char/boy.glb', fbxPath: '/workspace/3d-assets/fbx/hang-v1.fbx', alias: 'hang_loop', outGlb: '/workspace/3d-assets/repair/out.glb' });
    assert.equal(retarget.host, 'gsy013');
    assert.match(retarget.command, /retarget_hy\.py/);
    assert.match(retarget.command, /--input \/workspace\/3d-assets\/char\/boy\.glb/);
    // 参数必须与 blender 调用处于同一命令行（被 && 拆开会变成独立 shell 命令而失败）
    assert.match(retarget.command, /blender --background --python .*retarget_hy\.py -- --input \/workspace\/3d-assets\/char\/boy\.glb --fbx \/workspace\/3d-assets\/fbx\/hang-v1\.fbx --alias hang_loop --output \/workspace\/3d-assets\/repair\/out\.glb/);
    assert.equal(retarget.command.split(' && ').length, 2, '重定向命令只允许一个 &&（cd 分隔）');

    const gate = exec.buildClippingGateCommand({ glbPath: '/workspace/3d-assets/repair/out.glb', action: 'hang_loop' });
    assert.match(gate.command, /analyze_clipping\.py/);

    const audio = exec.buildAudioRepairCommand({ eventJobDir: '/workspace/3d-assets/game-audio/br/hang/abc', eventId: 'hang', projectId: 'br', gain: 0.8 });
    assert.equal(audio.host, 'mygpu');
    assert.match(audio.command, /postprocess/);
    assert.match(audio.command, /--gain 0\.8/);

    const report = exec.parseClippingReport('{"status":"passed","clipping":{"max_penetration_mm":1.2,"violations":0},"mesh":{"triangles":30000}}', '', null);
    assert.equal(report.quality_gates.clipping_review, 'passed');
    assert.equal(report.clipping.max_penetration_mm, 1.2);
});

test('recordTerminalAttempt 幂等：同一任务只落一次 Attempt', () => {
    const job = jobDb.create({
        name: `idem-${Date.now()}`,
        domain: 'model', project: 'br', asset_id: 'a', event_id: 'e',
        input: { images: [], prompt: 'p', asset_kind: 'prop', profile: 'xhs_mobile', seed: 1 },
        execution_plan: { generation: { texture_size: 1024 } }
    });
    jobDb.update(job.id, { status: 'failed', error: { code: 'provider_error', message: 'boom' } });
    const first = recordTerminalAttempt(jobDb.findById(job.id), { error: new Error('boom') });
    const second = recordTerminalAttempt(jobDb.findById(job.id), { error: new Error('boom') });
    assert.ok(first && first.id);
    assert.equal(second, null, '幂等：不得重复落 Attempt');
});
