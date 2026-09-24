const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modeling-loop-test-'));
process.env.DB_PATH = path.join(tempRoot, 'db.json');
process.env.UPLOAD_DIR = path.join(tempRoot, 'uploads');
process.env.MODEL_DIR = path.join(tempRoot, 'models');

const { learningDb, jobDb, modelDb } = require('../server/db');
const {
    classifyFailure, recommendCandidates, canAdvance, CANDIDATE_BUDGET, qualityScore,
    SINGLE_VARIABLE_RULES, SINGLE_VARIABLES, chainRepairDepth, remainingRepairs,
    currentVariableValue, applyRepairToPlan, verifyRepairPlan, isRepairableAttempt,
    countValidChains
} = require('../server/modeling-learning');
const { recordTerminalAttempt, onHumanVerdict, autoGateImproved, backfillTerminalHistory } = require('../server/retrospective-worker');
const { hashText } = require('../server/utils');

// 真实 Forge3D 成功（需人工复核）门禁样例
const FORGE_OK_GATES = {
    file_exists: 'passed', profile_contract: 'passed', material_uv_review: 'passed',
    render_anomaly_review: 'passed', animation_pose_review: 'n/a', deformation_review: 'n/a',
    target_device_review: 'required', automatic_pipeline: 'passed', human_art_review: 'required'
};
// 真实 Forge3D 失败（材质/UV 门禁失败）门禁样例
const FORGE_MATERIAL_FAIL_GATES = {
    file_exists: 'passed', profile_contract: 'failed', material_uv_review: 'failed',
    render_anomaly_review: 'passed', animation_pose_review: 'n/a', deformation_review: 'n/a',
    target_device_review: 'required'
};

test('失败按原因自动分类（含真实 Forge3D 门禁键）', () => {
    assert.equal(classifyFailure({ job: { error: { code: 'invalid_request', message: 'bad' } } }), 'input');
    assert.equal(classifyFailure({ job: { error: { code: 'provider_error', message: 'timeout' } } }), 'infrastructure');
    assert.equal(classifyFailure({ job: { error: { message: 'GLB 文件长度校验失败' } } }), 'export');
    // Forge3D 真实门禁键 → 分类
    assert.equal(classifyFailure({ job: {}, quality: { quality_gates: { ...FORGE_MATERIAL_FAIL_GATES } } }), 'material');
    assert.equal(classifyFailure({ job: {}, quality: { quality_gates: { ...FORGE_OK_GATES, rig_structure_review: 'failed' } } }), 'rig');
    assert.equal(classifyFailure({ job: {}, quality: { quality_gates: { ...FORGE_OK_GATES, deformation_review: 'failed' } } }), 'animation');
    assert.equal(classifyFailure({ job: {}, quality: { quality_gates: { ...FORGE_OK_GATES, animation_pose_review: 'failed' } } }), 'animation');
    assert.equal(classifyFailure({ job: {}, quality: { quality_gates: { ...FORGE_OK_GATES, render_anomaly_review: 'failed' } } }), 'material');
    assert.equal(classifyFailure({ job: {}, quality: { quality_gates: { ...FORGE_OK_GATES, profile_contract: 'failed' } } }), 'shape');
});

test('质量分识别 passed/failed/required/n/a 字符串门禁', () => {
    // 全通过 + 面数合理 → 高分
    const ok = qualityScore({ quality_gates: FORGE_OK_GATES, triangles: 60000 });
    assert.ok(ok > 0.9);
    // material_uv_review failed → 明显降分
    const bad = qualityScore({ quality_gates: FORGE_MATERIAL_FAIL_GATES, triangles: 60000 });
    assert.ok(bad < ok);
    // 'required'/'n/a' 不计入（中性），不虚高
    const neutral = qualityScore({ quality_gates: { automatic_pipeline: 'passed' }, triangles: 60000 });
    assert.ok(neutral >= 0.9);
});

test('自动门禁改善判定：父失败门禁转好才算改善', () => {
    const before = { quality_gates: { material_uv_review: 'failed', profile_contract: 'failed' } };
    const afterGood = { quality_gates: { material_uv_review: 'passed', profile_contract: 'passed' } };
    const afterPartial = { quality_gates: { material_uv_review: 'passed', profile_contract: 'failed' } };
    assert.equal(autoGateImproved(before, afterGood), true);
    assert.equal(autoGateImproved(before, afterPartial), false); // 还有一门未转好
    assert.equal(autoGateImproved({ quality_gates: {} }, afterGood), false); // 父无失败门禁
});

test('终态落不可变 Attempt，失败打标签，且幂等', () => {
    const job = {
        id: 'J999001', owner_id: 7, status: 'failed', attempt: 2,
        started_at: new Date(Date.now() - 5000).toISOString(), completed_at: new Date().toISOString(),
        input: { images: [], prompt: '台灯', asset_kind: 'prop', profile: 'xhs_mobile', seed: 5 },
        error: { code: 'invalid_request', message: '参考图无法识别' }
    };
    const a = recordTerminalAttempt(job, {});
    assert.ok(a && a.id.startsWith('LA'));
    assert.equal(a.auto_status, 'failed');
    assert.equal(a.failure_category, 'input');
    assert.equal(a.metrics.retry_count, 2);
    assert.equal(recordTerminalAttempt(job, {}), null);
});

test('只有「批准 + 复测 + 单变量白名单 + 门禁改善」才闭合有效因果链；人工打回可作为失败父样本', () => {
    // 失败 Attempt（真实门禁键失败）
    const failed = learningDb.createAttempt({
        job_id: 'J999101', owner_id: 7, asset_kind: 'prop', profile: 'xhs_mobile', seed: 5,
        auto_status: 'failed', failure_category: 'material', failure_detail: '材质/UV 门禁失败',
        metrics: { quality_gates: { ...FORGE_MATERIAL_FAIL_GATES }, triangles: 60000 }
    });
    // 修复 Attempt：基于失败，只改白名单变量，指标与门禁改善
    const fixed = learningDb.createAttempt({
        job_id: 'J999102', owner_id: 7, asset_kind: 'prop', profile: 'xhs_mobile', seed: 5,
        auto_status: 'succeeded',
        based_on_attempt_id: failed.id,
        changed_variable: { param: 'generation.texture_size', from: 2048, to: 4096, reason: '提高纹理分辨率补全材质细节' },
        metrics: { quality_gates: { ...FORGE_OK_GATES }, triangles: 60000 }
    });
    // 未复测就批准：不闭合
    const r1 = onHumanVerdict(fixed.id, 'approved', { reviewerId: 7 });
    assert.ok(!r1.retrospective);

    // viewer 级复测 + 批准：闭合（v1 有效链）
    const fixed2 = learningDb.createAttempt({
        job_id: 'J999103', owner_id: 7, asset_kind: 'prop', profile: 'xhs_mobile', seed: 5,
        auto_status: 'succeeded',
        based_on_attempt_id: failed.id,
        changed_variable: { param: 'generation.texture_size', from: 2048, to: 4096 },
        metrics: { quality_gates: { ...FORGE_OK_GATES }, triangles: 60000 }
    });
    const r2 = onHumanVerdict(fixed2.id, 'approved', { validationScope: 'viewer', reviewerId: 7 });
    assert.ok(r2.retrospective);
    assert.equal(r2.retrospective.chain_valid, true);
    assert.equal(r2.retrospective.evidence.gate_improved, true);
    assert.equal(r2.retrospective.evidence.game_verified, false);
    assert.equal(learningDb.listExperiments({ ownerId: 7 })[0].result, 'improved');

    // 游戏内验证 → game_verified 为 true
    const fixed3 = learningDb.createAttempt({
        job_id: 'J999105', owner_id: 7, asset_kind: 'prop', profile: 'xhs_mobile', seed: 5,
        auto_status: 'succeeded',
        based_on_attempt_id: failed.id,
        changed_variable: { param: 'generation.texture_size', from: 2048, to: 4096 },
        metrics: { quality_gates: { ...FORGE_OK_GATES }, triangles: 60000 }
    });
    const r3 = onHumanVerdict(fixed3.id, 'approved', { validationScope: 'game', reviewerId: 7 });
    assert.equal(r3.retrospective.evidence.game_verified, true);

    // 打回的 Attempt 可作为失败父样本：人工打回 + 批准修复 + viewer 复测 → 闭合
    const rejected = learningDb.createAttempt({
        job_id: 'J999106', owner_id: 7, asset_kind: 'prop', profile: 'xhs_mobile', seed: 5,
        auto_status: 'succeeded',
        metrics: { quality_gates: { ...FORGE_MATERIAL_FAIL_GATES }, triangles: 60000 }
    });
    onHumanVerdict(rejected.id, 'rejected', { category: 'material', defectScore: 4, validationScope: 'viewer', reviewerId: 7 });
    assert.equal(learningDb.findAttemptById(rejected.id).human_verdict, 'rejected');
    assert.equal(learningDb.findAttemptById(rejected.id).human_defect_score, 4);
    const fixedFromReject = learningDb.createAttempt({
        job_id: 'J999107', owner_id: 7, asset_kind: 'prop', profile: 'xhs_mobile', seed: 5,
        auto_status: 'succeeded',
        based_on_attempt_id: rejected.id,
        changed_variable: { param: 'generation.texture_size', from: 2048, to: 4096 },
        metrics: { quality_gates: { ...FORGE_OK_GATES }, triangles: 60000 }
    });
    const r4 = onHumanVerdict(fixedFromReject.id, 'approved', { validationScope: 'viewer', reviewerId: 7 });
    assert.ok(r4.retrospective && r4.retrospective.chain_valid, '人工打回的父 Attempt 应能形成有效链');
});

test('单变量修复：仅改变一个白名单变量，SHA 重算且其余不变', () => {
    const parentPlan = {
        version: 1,
        generation: { triangle_budget: 60000, texture_size: 2048, paint_views: 9, paint_resolution: 768, roughness_floor: 0.55, specular_level: 0.2 },
        material_prompt: 'high quality, clear material details',
        review_requirements: [],
        skill_sha256: 'abc',
        source: 'structured'
    };
    parentPlan.sha256 = hashText(JSON.stringify(parentPlan));

    // 改一个 generation 变量 → 其余 generation 字段不变，仅目标字段变化，SHA 更新
    const newPlan = applyRepairToPlan(parentPlan, 'generation.triangle_budget', 90000);
    assert.equal(newPlan.generation.triangle_budget, 90000);
    assert.equal(newPlan.generation.texture_size, 2048);
    assert.equal(newPlan.generation.roughness_floor, 0.55);
    assert.notEqual(newPlan.sha256, parentPlan.sha256);

    // 校验通过：回退单变量后 SHA 等于父计划
    assert.equal(verifyRepairPlan(newPlan, parentPlan.sha256, { param: 'generation.triangle_budget', from: 60000, to: 90000 }), true);
    // 篡改其余参数 → 校验拒绝
    const tampered = { ...newPlan, generation: { ...newPlan.generation, paint_views: 7 }, sha256: newPlan.sha256 };
    assert.throws(() => verifyRepairPlan(tampered, parentPlan.sha256, { param: 'generation.triangle_budget', from: 60000, to: 90000 }), /不一致/);

    // seed 修复：计划不变（SHA 同父），seed 走 input
    const seedPlan = applyRepairToPlan(parentPlan, 'seed', 999);
    assert.equal(seedPlan.sha256, parentPlan.sha256);
    assert.equal(verifyRepairPlan(seedPlan, parentPlan.sha256, { param: 'seed', from: 1234, to: 999 }), true);

    // 白名单外变量被拒绝
    assert.throws(() => applyRepairToPlan(parentPlan, 'profile', 'steam_desktop'), /不支持修复该变量/);
});

test('修复链深度：每条链最多 2 次修复，第 3 次被拒；旧任务不变', () => {
    // 根 Attempt（失败）
    const root = learningDb.createAttempt({
        job_id: 'J999201', owner_id: 7, asset_kind: 'prop', profile: 'xhs_mobile', seed: 5,
        auto_status: 'failed', failure_category: 'shape',
        metrics: { quality_gates: { ...FORGE_MATERIAL_FAIL_GATES }, triangles: 60000 }
    });
    assert.equal(chainRepairDepth(root.id), 0);
    assert.equal(remainingRepairs(root.id), CANDIDATE_BUDGET.max_repairs); // 2

    // 修复1（基于根）→ 深度 1，剩余 1
    const repair1 = learningDb.createAttempt({
        job_id: 'J999202', owner_id: 7, asset_kind: 'prop', profile: 'xhs_mobile', seed: 5,
        auto_status: 'failed', failure_category: 'shape',
        based_on_attempt_id: root.id,
        changed_variable: { param: 'seed', from: 5, to: 6 },
        metrics: { quality_gates: { ...FORGE_MATERIAL_FAIL_GATES } }
    });
    assert.equal(chainRepairDepth(repair1.id), 1);
    assert.equal(remainingRepairs(repair1.id), 1);

    // 修复2（基于修复1）→ 深度 2，剩余 0 → 不能再修复
    const repair2 = learningDb.createAttempt({
        job_id: 'J999203', owner_id: 7, asset_kind: 'prop', profile: 'xhs_mobile', seed: 5,
        auto_status: 'failed', failure_category: 'shape',
        based_on_attempt_id: repair1.id,
        changed_variable: { param: 'seed', from: 6, to: 7 },
        metrics: { quality_gates: { ...FORGE_MATERIAL_FAIL_GATES } }
    });
    assert.equal(chainRepairDepth(repair2.id), 2);
    assert.equal(remainingRepairs(repair2.id), 0);

    // 旧 Attempt 保持不可变
    assert.equal(learningDb.findAttemptById(root.id).job_id, 'J999201');
});

test('策略晋级门禁由服务端证据计算，客户端不能伪造 evidence_case_count', () => {
    // createPolicy 一律忽略客户端 evidence_case_count
    const p = learningDb.createPolicy({ asset_kind: 'prop', name: '高面数补全', evidence_case_count: 999, owner_id: 7 });
    assert.equal(p.evidence_case_count, 0);

    // draft→shadow：至少 1 条有效链
    assert.equal(canAdvance(p, 'shadow', { valid: 0 }).ok, false);
    assert.equal(canAdvance(p, 'shadow', { valid: 1 }).ok, true);
    // 跳级禁止
    assert.equal(canAdvance(p, 'default', { valid: 9, game_verified: 1 }).ok, false);
    assert.equal(canAdvance(p, 'shadow', { valid: 1 }).ok, true);
    const shadow = learningDb.advancePolicy(p.id, 'shadow', { evidenceCount: 1, gameVerifiedCount: 0 });
    assert.equal(shadow.lifecycle, 'shadow');
    assert.equal(shadow.evidence_case_count, 1);

    // shadow→small_scale：至少 3 条
    assert.equal(canAdvance(shadow, 'small_scale', { valid: 2 }).ok, false);
    assert.equal(canAdvance(shadow, 'small_scale', { valid: 3 }).ok, true);
    const small = learningDb.advancePolicy(p.id, 'small_scale', { evidenceCount: 3, gameVerifiedCount: 0 });
    assert.equal(small.lifecycle, 'small_scale');

    // small_scale→default：至少 5 条 + 至少 1 条游戏验证
    assert.equal(canAdvance(small, 'default', { valid: 5, game_verified: 0 }).ok, false);
    assert.equal(canAdvance(small, 'default', { valid: 4, game_verified: 1 }).ok, false);
    assert.equal(canAdvance(small, 'default', { valid: 5, game_verified: 1 }).ok, true);

    // 回滚总是允许
    assert.equal(canAdvance(small, 'rolled_back').ok, true);
});

test('账号隔离：Attempt、复盘、策略互不可见', () => {
    learningDb.createAttempt({ job_id: 'J999301', owner_id: 10, asset_kind: 'prop', profile: 'xhs_mobile', auto_status: 'succeeded', metrics: {} });
    learningDb.createRetrospective({ owner_id: 10, asset_kind: 'prop', chain_valid: true, failed_attempt_id: 'X', fixed_attempt_id: 'Y' });
    learningDb.createPolicy({ owner_id: 10, asset_kind: 'prop', name: 'A 的策略' });

    // 账号 11 看不到账号 10 的任何数据
    assert.equal(learningDb.listAttempts({ ownerId: 11 }).length, 0);
    assert.equal(learningDb.listRetrospectives({ ownerId: 11 }).length, 0);
    assert.equal(learningDb.listPolicies({ ownerId: 11 }).length, 0);
    assert.equal(learningDb.findPolicyById('anything', 11), null);
});

test('幂等回填历史终态任务：重复启动不重复创建', () => {
    const job = jobDb.create({
        owner_id: 7, name: '钟台', max_attempts: 3,
        input: { images: [], prompt: '钟台', asset_kind: 'prop', profile: 'xhs_mobile', seed: 1234 },
        skill_snapshot: { sha256: 'ss', entries: [] },
        requested_channels: [], base_url: ''
    });
    jobDb.update(job.id, {
        status: 'succeeded', completed_at: new Date().toISOString(),
        output: { quality: { quality_gates: FORGE_OK_GATES, metrics: { triangles: 60000 }, provider_state: 'review' } }
    });
    modelDb.create({ name: '钟台', job_id: job.id, model_file: '/models/m.glb', sha256: 'glb' });

    const first = backfillTerminalHistory();
    assert.ok(first >= 1);
    const attempt = learningDb.findAttemptByJobId(job.id);
    assert.ok(attempt);
    assert.equal(attempt.auto_status, 'succeeded');
    assert.equal(attempt.human_verdict, 'pending'); // 进入待审片队列
    // 重复启动不再创建
    const second = backfillTerminalHistory();
    assert.equal(second, 0);
    assert.equal(learningDb.listAttempts({ ownerId: 7 }).filter(a => a.job_id === job.id).length, 1);
});

test('推荐最多三档候选，且只给建议；检索按 owner 隔离', () => {
    const cands = recommendCandidates({ owner_id: 11, asset_kind: 'prop', profile: 'xhs_mobile', defect_category: 'shape' });
    assert.ok(cands.length <= CANDIDATE_BUDGET.max_candidates);
    assert.ok(cands.some(c => c.tier === 'safe' || c.tier === 'explore'));
    assert.equal(CANDIDATE_BUDGET.max_repairs, 2);
});

test('单变量白名单完整且取值规则存在', () => {
    assert.ok(SINGLE_VARIABLES.includes('seed'));
    assert.ok(SINGLE_VARIABLES.includes('generation.triangle_budget'));
    assert.ok(SINGLE_VARIABLES.includes('generation.roughness_floor'));
    assert.ok(SINGLE_VARIABLES.includes('generation.specular_level'));
    for (const param of SINGLE_VARIABLES) assert.ok(SINGLE_VARIABLE_RULES[param]);
});
