'use strict';
/* ForgeLoop v3.1 工厂测试：真实缺陷自动修复闭环与评分防稀释
 *   1. 单样本低分不能被平均分稀释（vlm_min 双达标）
 *   2. critical 标签硬失败（比例失调/骨架断裂/严重穿模/跑出画面/僵硬失真等）
 *   3. raw_generic_glb / runtime_rotation_only 证据隔离，不混合平均
 *   4. parent=null 基线不得 better_than_parent=true
 *   5. score 各层一致（deterministic_score/vlm_mean/vlm_min/regression_score/overall_score 可追溯向量）
 *   6. defect 自动生成（desktop-boy-02 = 0.2 → 结构化缺陷，非 defects=[]）
 *   7. 独立子 Attempt/新 Job ID
 *   8. 单变量约束 + animation.root_translation_normalization 白名单
 *   9. champion 保护与失败回滚
 *  10. exhausted/quarantined（同变量无改善停止）
 *  11. 重启续跑（recoverFromDb 幂等 + pending_external 子 Attempt 可续评）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v31-test-'));
process.env.DB_PATH = path.join(tempRoot, 'db.json');
process.env.UPLOAD_DIR = path.join(tempRoot, 'uploads');
process.env.MODEL_DIR = path.join(tempRoot, 'models');

const { learningDb, jobDb, championDb, autoLockDb } = require('../server/db');
const { ensurePolicies, POLICY_V1 } = require('../server/auto-policy');
const { pickRepairVariable, runAutoIteration, autoIntegrate, recoverFromDb, createAutoRepairChild, evaluateAttempt, buildVlmSamples, computeScoreVector, parseGpuVlmText, CRITICAL_LABELS, EVIDENCE_MODES } = require('../server/auto-loop');
const { repairParamValid } = require('../server/modeling-learning');
const { buildRootNormalizeCommand } = require('../server/repair-executor');

const OWNER = 'user-v31';
const REAL_GLB_SHA = '69e7782db71d7f5ab7f6aa133d0ff04fc66e631fb8192e0c5949c93410ad0a9e';

function makeAttempt(overrides = {}) {
    return learningDb.createAttempt({
        job_id: `JV31-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        owner_id: OWNER,
        domain: 'animation',
        project: 'the-bridge-after-rain',
        asset_id: 'hang',
        asset_kind: 'character',
        profile: 'xhs_mobile',
        seed: 1234,
        pipeline: { provider: 'forge3d', task_id: 'TASK-V31-1' },
        artifacts: { glb_sha: REAL_GLB_SHA, artifact_file: '/tmp/fake.glb' },
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

const REAL_DESKTOP_REVIEW = '评分：0.2 角色比例失调严重，动作僵硬，身体结构崩塌，绳索与角色互动不自然，存在明显穿模和几何形变问题。';

function realDefectAttempt(overrides = {}) {
    return makeAttempt({
        job_id: `JV31-REAL-${Date.now()}`,
        evidence: {
            scope: 'runtime_rotation_only_gameplay',
            viewport: 'desktop',
            animation: { root_translation_ratio: 0.8675535, displacement: 1.52, joint_angle_anomaly_ratio: 0, clipping_count: 0, root_drift: 0.001, loop_seam: 0 },
            raw_generic_glb: { glb_file: '/workspace/3d-assets/repair/J000001/output-hang.glb', glb_sha: REAL_GLB_SHA, action: 'hang', root_translation_ratio: 0.8675535 },
            samples: [
                { image: '/tmp/v3-gatei/desktop-boy-02.png', mode: 'runtime_rotation_only', viewport: 'desktop', camera: 'game-camera', animation_time: 0.5, artifact_sha: REAL_GLB_SHA, vlm_score: 0.2, vlm_text: REAL_DESKTOP_REVIEW, vlm_labels: ['比例失调', '动作僵硬', '结构崩塌', '穿模', '几何形变'] },
                { image: '/tmp/v3-gatei/mobile-boy-03.png', mode: 'runtime_rotation_only', viewport: 'mobile', camera: 'game-camera', animation_time: 0.8, artifact_sha: REAL_GLB_SHA, vlm_score: 0.95, vlm_text: '评分：0.95 画面来自游戏《OMORI》，非本项目画面（VLM 误判样本）。', vlm_labels: [] }
            ]
        },
        ...overrides
    });
}

// ---------- 1. 单样本低分不能被平均分稀释 ----------
test('v3.1 平均分不得掩盖局部严重失败：mean=0.575 但 min=0.2 → auto_rejected', async () => {
    ensurePolicies();
    const a = realDefectAttempt();
    learningDb.setAutoFlowState(a.id, 'auto_evaluating', { detail: '评估' });
    const ext = { hard_gates: passGates('animation'), metrics: {}, defects: [], regression: {} };
    const ev = await evaluateAttempt(a, { external: ext });
    assert.equal(ev.passed, false);
    assert.equal(ev.score_vector.vlm_mean, 0.575);   // 平均分高于阈值
    assert.equal(ev.score_vector.vlm_min, 0.2);      // 但最低分暴露失败
    assert.ok(ev.defects.some(d => d.gate === 'vlm_min' && d.severity === 'critical'));
    assert.equal(ev.score_vector.overall_score, 0.2); // overall 反映最差层，不被稀释
    const r = await runAutoIteration(a.id, { ownerId: OWNER, evaluate: async () => ext, repair: async (child, variable, job) => ({
        job_id: job.id, job_status: 'succeeded', provider: 'forge3d-blender-root-normalize',
        artifacts: { glb_file: '/workspace/3d-assets/repair/' + job.id + '/output-hang-normalized.glb', glb_sha: 'CHILD-SHA' },
        metrics: {}, animationEvidence: { root_translation_ratio: 0.05, displacement: 1.5 }, evidence: { raw_generic_glb: { root_translation_ratio: 0.05, glb_sha: 'CHILD-SHA' } }
    }) });
    assert.equal(r.state, 'auto_rejected'); // 父被真实证据拒 + 子因 runtime 0.2 样本继续被拒，不得被平均稀释通过
    assert.equal(r.attempt.based_on_attempt_id, a.id); // 子 Attempt 独立
});

// ---------- 1b. 子 Attempt 继承的旧样本不得覆盖 continue 阶段上传的新样本 ----------
test('v3.1 证据隔离：continue 上传的新样本优先，继承自父的 0.2 旧样本不得毒化子评估', async () => {
    ensurePolicies();
    const a = realDefectAttempt();
    learningDb.setAutoFlowState(a.id, 'auto_rejected', { detail: '父被拒' });
    const v = { param: 'animation.root_translation_normalization', to: 'normalize_root_translation' };
    const { attempt: child } = createAutoRepairChild(a, v, { ownerId: OWNER });
    // 修复产物回填（新 SHA），子 Attempt 继承的 evidence.samples 仍是父的 0.2/0.95 旧样本
    learningDb.updateAttemptTerminal(child.job_id, {
        auto_status: 'succeeded',
        artifacts: { glb_file: '/workspace/3d-assets/repair/JV31-NEW/output-hang-normalized.glb', glb_sha: 'CHILD-NORM-SHA' },
        evidence: { animation: { root_translation_ratio: 0.05 }, raw_generic_glb: { glb_file: '/workspace/3d-assets/repair/JV31-NEW/output-hang-normalized.glb', glb_sha: 'CHILD-NORM-SHA', root_translation_ratio: 0.05 } }
    });
    learningDb.setAutoFlowState(child.id, 'auto_evaluating', { detail: '等 staging 证据' });
    const ext = {
        hard_gates: passGates('animation'),
        regression: { playthrough: true, audio_trace: true },
        defects: [],
        samples: [
            { image: '/tmp/v31-staging/desktop-boy-02.png', mode: 'runtime_rotation_only', viewport: 'desktop', camera: 'game-camera', animation_time: 0.5, artifact_sha: 'CHILD-NORM-SHA', vlm_score: 0.85, vlm_text: '评分：0.85 动作自然、手绳接触良好、比例正常。', vlm_labels: [] },
            { image: '/tmp/v31-staging/mobile-boy-03.png', mode: 'runtime_rotation_only', viewport: 'mobile', camera: 'game-camera', animation_time: 0.8, artifact_sha: 'CHILD-NORM-SHA', vlm_score: 0.8, vlm_text: '评分：0.8 动作自然。', vlm_labels: [] }
        ]
    };
    const r = await runAutoIteration(child.id, { ownerId: OWNER, evaluate: async () => ext, repair: null });
    assert.equal(r.state, 'auto_accepted');
    assert.equal(r.evaluation.score_vector.vlm_min, 0.8); // 0.2 旧样本未混入
    assert.equal(r.evaluation.comparison.better_than_parent, true);
});
// ---------- 2. critical 标签硬失败 ----------
test('v3.1 critical 标签（比例失调/僵硬/结构崩塌/穿模）→ 硬失败缺陷', async () => {
    const a = realDefectAttempt();
    learningDb.setAutoFlowState(a.id, 'auto_evaluating', { detail: '评估' });
    const ev = await evaluateAttempt(a, { external: { hard_gates: passGates('animation'), metrics: {}, defects: [], regression: {} } });
    const crit = ev.defects.filter(d => d.gate === 'critical_label');
    assert.ok(crit.length >= 1);
    assert.ok(crit.some(d => /比例失调|僵硬|结构崩塌|穿模/.test(d.desc)));
    // 纯 critical 命中即使分数不低也失败
    const b = makeAttempt({ job_id: `JV31-CRIT-${Date.now()}`, evidence: { samples: [{ image: '/tmp/x.png', mode: 'runtime_rotation_only', vlm_score: 0.7, vlm_text: '评分：0.7 但角色骨架断裂。', vlm_labels: ['骨架断裂'] }] } });
    learningDb.setAutoFlowState(b.id, 'auto_evaluating', { detail: '评估' });
    const evB = await evaluateAttempt(b, { external: { hard_gates: passGates('animation'), defects: [], regression: {} } });
    assert.equal(evB.passed, false);
    assert.ok(evB.defects.some(d => d.gate === 'critical_label'));
});

// ---------- 3. raw/runtime 证据隔离 ----------
test('v3.1 raw_generic_glb 与 runtime_rotation_only 分别评分、不混合平均；root_translation_ratio 门禁按 raw 模式判定', async () => {
    const a = realDefectAttempt();
    learningDb.setAutoFlowState(a.id, 'auto_evaluating', { detail: '评估' });
    const ev = await evaluateAttempt(a, { external: { hard_gates: passGates('animation'), defects: [], regression: {} } });
    // 两模式各自独立聚合
    assert.ok(ev.vlm.per_mode.raw_generic_glb.count === 0);       // raw 模式无图像样本（只有报告）
    assert.equal(ev.vlm.per_mode.runtime_rotation_only.mean, 0.575);
    assert.equal(ev.vlm.per_mode.runtime_rotation_only.min, 0.2);
    // raw GLB 门禁（root_translation_ratio）独立失败，不被 runtime 证据掩盖
    assert.equal(ev.hard_gates.root_translation_ratio, false);
    assert.ok(ev.defects.some(d => d.gate === 'root_translation_ratio' && d.mode === 'raw_generic_glb'));
    // 修复后 raw 比率达标 → 门禁通过
    const b = makeAttempt({ job_id: `JV31-ISO-${Date.now()}`, evidence: { animation: { root_translation_ratio: 0.05, displacement: 1.5 }, samples: [] } });
    learningDb.setAutoFlowState(b.id, 'auto_evaluating', { detail: '评估' });
    const evB = await evaluateAttempt(b, { external: { hard_gates: passGates('animation'), defects: [], regression: {} } });
    assert.equal(evB.hard_gates.root_translation_ratio, true);
});

// ---------- 4. parent=null 基线不得 better_than_parent ----------
test('v3.1 parent=null 基线：comparison.baseline=true 且 better_than_parent=false', async () => {
    const a = makeAttempt({ job_id: `JV31-BASE-${Date.now()}`, evidence: { animation: { root_translation_ratio: 0.02, displacement: 1.2 }, samples: [] } });
    learningDb.setAutoFlowState(a.id, 'auto_evaluating', { detail: '评估' });
    const ev = await evaluateAttempt(a, { external: { hard_gates: passGates('animation'), defects: [], regression: {} } });
    assert.equal(ev.comparison.baseline, true);
    assert.equal(ev.comparison.better_than_parent, false);
    assert.equal(ev.comparison.parent_attempt_id, null);
});

// ---------- 5. score 各层一致 ----------
test('v3.1 可追溯评分向量：deterministic/vlm_mean/vlm_min/regression/overall 各层一致且公式版本化', async () => {
    const a = makeAttempt({ job_id: `JV31-VEC-${Date.now()}`, evidence: { animation: { root_translation_ratio: 0.03, displacement: 1.2 }, samples: [{ image: '/tmp/a.png', mode: 'runtime_rotation_only', vlm_score: 0.7, vlm_text: '评分：0.7 正常' }, { image: '/tmp/b.png', mode: 'runtime_rotation_only', vlm_score: 0.9, vlm_text: '评分：0.9 正常' }] } });
    learningDb.setAutoFlowState(a.id, 'auto_evaluating', { detail: '评估' });
    const ev = await evaluateAttempt(a, { external: { hard_gates: passGates('animation'), defects: [], regression: { playthrough: true, audio_trace: true } } });
    assert.equal(ev.score_vector.deterministic_score, 1.0);
    assert.equal(ev.score_vector.vlm_mean, 0.8);
    assert.equal(ev.score_vector.vlm_min, 0.7);
    assert.equal(ev.score_vector.regression_score, 1.0);
    assert.equal(ev.score_vector.overall_score, 0.7); // min(...) 保守聚合
    assert.equal(ev.score, ev.score_vector.overall_score);
    assert.equal(ev.passed, true);
    assert.ok(/min\(deterministic_score/.test(POLICY_V1.animation.scoring.formula));
    // 证据标记齐全（每份证据含 mode/viewport/camera/animation_time/artifact_sha）
    for (const s of ev.vlm.samples) {
        assert.ok(EVIDENCE_MODES.includes(s.mode));
        assert.ok(s.viewport && s.camera);
        assert.ok(s.artifact_sha);
    }
});

// ---------- 6. defect 自动生成 ----------
test('v3.1 defect 自动生成：0.2 证据必须形成结构化 defect，不得仍返回 defects=[]', async () => {
    const a = realDefectAttempt();
    learningDb.setAutoFlowState(a.id, 'auto_evaluating', { detail: '评估' });
    const ev = await evaluateAttempt(a, { external: { hard_gates: passGates('animation'), defects: [], regression: {} } });
    assert.ok(Array.isArray(ev.defects) && ev.defects.length >= 3, `期望结构化缺陷，实际 ${JSON.stringify(ev.defects)}`);
    assert.ok(ev.defects.some(d => d.gate === 'vlm_min'));
    assert.ok(ev.defects.some(d => d.gate === 'critical_label'));
    assert.ok(ev.defects.some(d => d.gate === 'root_translation_ratio'));
    // 旧证据（仅 precomputed gpu_review 文本含 critical 标签）也不能被接受
    const b = makeAttempt({ job_id: `JV31-OLDDEF-${Date.now()}`, evidence: {} });
    learningDb.setAutoFlowState(b.id, 'auto_evaluating', { detail: '评估' });
    const evB = await evaluateAttempt(b, { external: { hard_gates: passGates('animation'), gpu_review: { score: 0.575, text: REAL_DESKTOP_REVIEW }, defects: [], regression: {} } });
    assert.ok(evB.defects.some(d => d.gate === 'critical_label'), '旧式 precomputed gpu_review 文本含 critical 标签也必须失败');
    assert.equal(evB.passed, false);
});

// ---------- 7. 独立子 Attempt/新 Job ID ----------
test('v3.1 独立子 Attempt + 新 Job ID（不复用父 Job），子 Attempt 单变量记录', async () => {
    const a = realDefectAttempt();
    learningDb.setAutoFlowState(a.id, 'auto_rejected', { detail: '真实缺陷被拒' });
    const v = { param: 'animation.root_translation_normalization', to: 'normalize_root_translation' };
    const { attempt: child, job, reused } = createAutoRepairChild(a, v, { ownerId: OWNER });
    assert.equal(reused, false);
    assert.notEqual(child.id, a.id);
    assert.notEqual(child.job_id, a.job_id);
    assert.equal(job.id, child.job_id);
    assert.deepEqual(child.changed_variable, v);
    assert.equal(child.based_on_attempt_id, a.id);
    assert.equal(child.auto_chain_index, a.auto_chain_index + 1);
});

// ---------- 8. 单变量约束 + 白名单 ----------
test('v3.1 单变量约束：root_translation_normalization 入白名单，非法值被拒', async () => {
    assert.equal(repairParamValid('animation', 'animation.root_translation_normalization', 'normalize_root_translation'), true);
    assert.equal(repairParamValid('animation', 'animation.root_translation_normalization', 'hide_model'), false);
    assert.equal(repairParamValid('animation', 'animation.root_translation_normalization', 'shrink_character'), false);
    assert.equal(repairParamValid('animation', 'animation.root_translation_normalization', 'static_pose'), false);
    // 修复选择：root_drift/root_translation_ratio 缺陷 → 唯一变量
    const a = realDefectAttempt();
    learningDb.setAutoFlowState(a.id, 'auto_rejected', { detail: '真实缺陷' });
    const ev = await evaluateAttempt(a, { external: { hard_gates: passGates('animation'), defects: [], regression: {} } });
    const v = pickRepairVariable(a, ev);
    assert.deepEqual(v, { param: 'animation.root_translation_normalization', to: 'normalize_root_translation' });
    // 执行器命令包含真实 gsy013 Blender 与输出路径（不覆盖输入）
    const built = buildRootNormalizeCommand({ targetGlb: '/workspace/3d-assets/repair/J000001/output-hang.glb', action: 'hang', outGlb: '/workspace/3d-assets/repair/JV31-N1/output-hang-normalized.glb' });
    assert.equal(built.host, 'gsy013');
    assert.ok(built.command.includes('normalize_root_translation.py'));
    assert.ok(built.command.includes('--input /workspace/3d-assets/repair/J000001/output-hang.glb'));
    assert.ok(built.command.includes('--output /workspace/3d-assets/repair/JV31-N1/output-hang-normalized.glb'));
});

// ---------- 9. champion 保护与失败回滚 ----------
test('v3.1 champion 保护：未 auto_accepted 不得覆盖；staging 失败回滚上一 champion', async () => {
    // 首次接入
    const a = makeAttempt({ job_id: `JV31-ACC-${Date.now()}` });
    learningDb.setAutoFlowState(a.id, 'auto_evaluating', { detail: '评估' });
    learningDb.setAutoFlowState(a.id, 'auto_accepted', { detail: '通过' });
    const r1 = await autoIntegrate(a.id, { project: 'the-bridge-after-rain', asset_id: 'hang', domain: 'animation', verifyStaging: async () => ({ ok: true, report: 'ok' }), buildReleaseZip: async () => ({ path: '/tmp/rel.zip', sha256: 'ZIP-SHA-1' }) });
    assert.equal(r1.ok, true);
    assert.equal(r1.champion.release_zip_sha, 'ZIP-SHA-1');
    // 未 auto_accepted 的 Attempt 不得接入（champion 保护）
    const c = makeAttempt({ job_id: `JV31-NOACC-${Date.now()}` });
    const rNo = await autoIntegrate(c.id, { project: 'the-bridge-after-rain', asset_id: 'hang', domain: 'animation' });
    assert.equal(rNo.ok, false);
    assert.match(rNo.reason, /not_auto_accepted/);
    // 第二个 auto_accepted 但 staging 失败 → 回滚上一 champion
    const b = makeAttempt({ job_id: `JV31-ROLL-${Date.now()}` });
    learningDb.setAutoFlowState(b.id, 'auto_evaluating', { detail: '评估' });
    learningDb.setAutoFlowState(b.id, 'auto_accepted', { detail: '通过' });
    const r2 = await autoIntegrate(b.id, { project: 'the-bridge-after-rain', asset_id: 'hang', domain: 'animation', verifyStaging: async () => ({ ok: false, report: 'no_rotation_only_regression' }) });
    assert.equal(r2.ok, false);
    assert.equal(r2.rolled_back_to, a.id);
    const champ = championDb.get({ project: 'the-bridge-after-rain', asset_id: 'hang', domain: 'animation' });
    assert.equal(champ.attempt_id, a.id);
});

// ---------- 10. exhausted / quarantined ----------
test('v3.1 同变量连续无改善 → quarantined；预算耗尽 → exhausted', async () => {
    // 同变量无改善：子 Attempt 用 root_translation_normalization 修复失败且不优于父 → quarantined
    const parent = realDefectAttempt({ job_id: `JV31-Q-${Date.now()}` });
    learningDb.setAutoFlowState(parent.id, 'auto_rejected', { detail: '真实缺陷被拒' });
    const evP = await evaluateAttempt(parent, { external: { hard_gates: passGates('animation'), defects: [], regression: {} } });
    learningDb.saveAutoEvaluation(parent.id, evP);
    // 手动创建子 Attempt 并置为 auto_rejected、记录同变量与劣化分数
    const v = { param: 'animation.root_translation_normalization', to: 'normalize_root_translation' };
    const { attempt: child } = createAutoRepairChild(parent, v, { ownerId: OWNER });
    learningDb.setAutoFlowState(child.id, 'auto_evaluating', { detail: '评估' });
    learningDb.saveAutoEvaluation(child.id, { score: 0.05, score_vector: { overall_score: 0.05 }, hard_gates: { root_translation_ratio: false }, defects: [{ gate: 'root_translation_ratio', severity: 'hard' }] });
    learningDb.setAutoFlowState(child.id, 'auto_rejected', { detail: '未改善' });
    const r = await runAutoIteration(child.id, { ownerId: OWNER, evaluate: async () => ({ hard_gates: {}, defects: [{ gate: 'root_translation_ratio' }] }), repair: null });
    assert.equal(r.state, 'quarantined');
    assert.equal(r.reason, 'same_variable_no_improvement');
    // 预算耗尽 → exhausted
    const b = makeAttempt({ job_id: `JV31-EXH-${Date.now()}`, auto_chain_index: 3 });
    learningDb.setAutoFlowState(b.id, 'auto_rejected', { detail: '失败' });
    const r2 = await runAutoIteration(b.id, { ownerId: OWNER, evaluate: async () => ({ hard_gates: {}, defects: [] }), repair: null });
    assert.equal(r2.state, 'exhausted');
    assert.equal(r2.reason, 'repair_budget_exceeded');
});

// ---------- 11. 重启续跑（含 pending_external） ----------
test('v3.1 重启续跑：recoverFromDb 幂等；pending_external 子 Attempt 停 auto_evaluating 并可带外部证据续评', async () => {
    const a = realDefectAttempt({ job_id: `JV31-RES-${Date.now()}` });
    learningDb.setAutoFlowState(a.id, 'auto_rejected', { detail: '真实缺陷被拒' });
    // 子 Attempt 创建后 GPU 产物已生成但 staging 证据未就绪 → 停在 auto_evaluating（pending_external）
    const v = { param: 'animation.root_translation_normalization', to: 'normalize_root_translation' };
    const { attempt: child } = createAutoRepairChild(a, v, { ownerId: OWNER });
    learningDb.updateAttemptTerminal(child.job_id, {
        auto_status: 'succeeded',
        artifacts: { glb_file: '/workspace/3d-assets/repair/JV31-RES/output-hang-normalized.glb', glb_sha: 'CHILD-NORM-SHA' },
        evidence: { animation: { root_translation_ratio: 0.05 }, raw_generic_glb: { glb_file: '/workspace/3d-assets/repair/JV31-RES/output-hang-normalized.glb', glb_sha: 'CHILD-NORM-SHA', root_translation_ratio: 0.05 } }
    });
    learningDb.setAutoFlowState(child.id, 'auto_evaluating', { detail: '修复产物已生成，等待游戏侧 staging 证据后评估', evidence: { variable: v, pending_external: true } });
    // 重启：recoverFromDb 幂等（两次相同）
    const c1 = recoverFromDb();
    const c2 = recoverFromDb();
    assert.equal(c2, c1);
    // 续评：带游戏侧 staging 外部证据（新截图 + 四关回归通过）
    const ext = {
        hard_gates: passGates('animation'),
        regression: { playthrough: true, audio_trace: true },
        defects: [],
        samples: [
            { image: '/tmp/v31-staging/desktop-boy-02.png', mode: 'runtime_rotation_only', viewport: 'desktop', camera: 'game-camera', animation_time: 0.5, artifact_sha: 'CHILD-NORM-SHA', vlm_score: 0.85, vlm_text: '评分：0.85 动作自然、手绳接触良好、比例正常。', vlm_labels: [] },
            { image: '/tmp/v31-staging/mobile-boy-03.png', mode: 'runtime_rotation_only', viewport: 'mobile', camera: 'game-camera', animation_time: 0.8, artifact_sha: 'CHILD-NORM-SHA', vlm_score: 0.8, vlm_text: '评分：0.8 动作自然。', vlm_labels: [] }
        ]
    };
    const r = await runAutoIteration(child.id, { ownerId: OWNER, evaluate: async () => ext, repair: null });
    assert.equal(r.state, 'auto_accepted');
    assert.equal(r.attempt.auto_flow_state, 'auto_accepted');
    assert.ok(r.evaluation.score_vector.vlm_min >= 0.4);
    assert.equal(r.evaluation.comparison.better_than_parent, true);
});

// ---------- 版本化审计 ----------
test('v3.1 策略审计：animation@2 写入 db，阈值/标签/公式版本化且 change_log 有 v2 记录', () => {
    ensurePolicies();
    const policy = POLICY_V1.animation;
    assert.equal(policy.version, 2);
    assert.ok(policy.critical_labels.includes('比例失调'));
    assert.ok(policy.scoring.formula.includes('vlm_min'));
    assert.ok(policy.thresholds.vlm_min_min.value >= 0.4);
    assert.ok(policy.evidence_modes.includes('raw_generic_glb'));
    const { v3PolicyDb } = require('../server/db');
    const stored = v3PolicyDb.latest('animation');
    assert.ok(stored && stored.version === 2);
    assert.ok(Array.isArray(stored.change_log) && stored.change_log.some(c => c.version === 2));
});
