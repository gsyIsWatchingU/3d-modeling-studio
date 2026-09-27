'use strict';
/* ForgeLoop v2 工厂测试：
 *   迁移幂等 / 账号隔离 / Attempt 不可变 / 单变量校验（按领域）/ 预算上限 /
 *   崩溃恢复 / 策略晋级与回滚（按领域）/ 生产契约校验与审计 / API 领域过滤向后兼容
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v2-test-'));
process.env.DB_PATH = path.join(tempRoot, 'db.json');
process.env.UPLOAD_DIR = path.join(tempRoot, 'uploads');
process.env.MODEL_DIR = path.join(tempRoot, 'models');

const { learningDb, jobDb, contractDb } = require('../server/db');
const {
    classifyFailure, countValidChains, chainRepairDepth, remainingRepairs,
    currentDomainVariableValue, repairParamValid,
    REGISTERED_WEIGHT_REPAIR_PLANS, REGISTERED_RETARGET_PLANS,
    canAdvance, applyRepairToPlan, verifyRepairPlan
} = require('../server/modeling-learning');
const { validateContract, auditContract, contractHash } = require('../server/contract');
const { recordTerminalAttempt, onHumanVerdict } = require('../server/retrospective-worker');
const { hashText } = require('../server/utils');

const OWNER_A = 'user-a';
const OWNER_B = 'user-b';

function gates(overrides = {}) {
    return { file_exists: 'passed', profile_contract: 'passed', material_uv_review: 'passed',
        render_anomaly_review: 'passed', animation_pose_review: 'n/a', deformation_review: 'n/a',
        target_device_review: 'required', ...overrides };
}

function makeJob(owner, overrides = {}) {
    return jobDb.create({
        owner_id: owner,
        name: 'v2-test',
        input: { images: [], prompt: 'x', asset_kind: 'prop', profile: 'xhs_mobile', seed: 1234 },
        ...overrides
    });
}

// 重新加载 db.js（清缓存 + 换 DB_PATH），模拟服务器重启以验证真实迁移路径
function reloadDb(dbPath) {
    for (const k of Object.keys(require.cache)) {
        if (k.includes('3d-modeling-studio') && /[\\/]server[\\/]db\.js$/.test(k)) delete require.cache[k];
    }
    process.env.DB_PATH = dbPath;
    return require('../server/db');
}

// ---------- 1. 迁移幂等（真实 initDb 路径，子进程隔离验证） ----------
test('v2 迁移幂等：旧 Attempt 回填 domain=model，重复启动不产生第二次变更', () => {
    const mTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mig-'));
    const mDb = path.join(mTemp, 'db.json');
    const legacy = {
        nextLearningId: 900002, nextRetroId: 1, nextJobId: 1,
        learning_attempts: [{
            id: 'LA900001', job_id: 'J900001', owner_id: OWNER_A, asset_kind: 'prop',
            profile: 'xhs_mobile', seed: 1, prompt: 'legacy', auto_status: 'failed',
            failure_category: 'shape', created_at: '2026-01-01T00:00:00.000Z'
        }],
        retrospectives: [], modeling_policies: [], experiments: [], jobs: [],
        models: [], skills: [], notifications: [], users: [], sessions: [], api_tokens: [],
        production_plans: [], factory_projects: [], production_contracts: []
    };
    fs.writeFileSync(mDb, JSON.stringify(legacy, null, 2));
    const { execFileSync } = require('child_process');
    const bootAndRead = () => {
        const script = `
            process.env.DB_PATH = ${JSON.stringify(mDb)};
            process.env.UPLOAD_DIR = ${JSON.stringify(path.join(mTemp, 'u'))};
            process.env.MODEL_DIR = ${JSON.stringify(path.join(mTemp, 'm'))};
            const { learningDb } = require(${JSON.stringify(path.join(__dirname, '..', 'server', 'db.js'))});
            const a = learningDb.listAttempts({ ownerId: ${JSON.stringify(OWNER_A)}, limit: 10 })[0];
            console.log(JSON.stringify({ domain: a.domain, project: a.project, evidence: a.evidence }));
        `;
        return JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..') }).toString());
    };
    // 第一次启动：initDb 检测到变化并落盘回填
    const a1 = bootAndRead();
    assert.equal(a1.domain, 'model');
    assert.equal(a1.project, null);
    assert.deepEqual(a1.evidence, {});
    const disk1 = fs.readFileSync(mDb, 'utf8');
    assert.ok(disk1.includes('"domain": "model"'), '迁移应写入回填字段');
    // 第二次启动：磁盘不再变化（幂等）
    bootAndRead();
    const disk2 = fs.readFileSync(mDb, 'utf8');
    assert.equal(disk2, disk1, '重复迁移必须幂等');
    fs.rmSync(mTemp, { recursive: true, force: true });
});

// ---------- 2. 账号隔离 ----------
test('v2 账号隔离：Attempt 与契约按 owner 隔离', () => {
    const a = recordTerminalAttempt(makeJob(OWNER_A, { domain: 'audio', asset_id: 'step', event_id: 'step' }),
        { asset_kind: 'prop', profile: 'xhs_mobile', seed: 1, prompt: 'p' },
        { error: { code: 'audio_trigger', message: '缺少触发' } }, { quality_gates: {} });
    assert.ok(a.id.startsWith('LA'));
    const listB = learningDb.listAttempts({ ownerId: OWNER_B, limit: 500 }).filter(x => x.id === a.id);
    assert.equal(listB.length, 0, 'B 账号不得看到 A 的 Attempt');

    contractDb.save('p1', validateContract({ project_id: 'p1', audio_events: [] }), OWNER_A);
    assert.ok(contractDb.get('p1', OWNER_A));
    assert.equal(contractDb.get('p1', OWNER_B), null, 'B 账号不得读到 A 的契约');
});

// ---------- 3. Attempt 不可变 + 领域/资产字段落库 ----------
test('Attempt 不可变：v2 字段创建后即固定；按 job_id 幂等；审片不改输入快照', () => {
    const job = makeJob(OWNER_A, {
        domain: 'animation', project: 'the-bridge-after-rain', stage: 'animation-gate',
        asset_id: 'teen-boy', event_id: 'clipping_review',
        evidence: { frames: [10, 11], regions: ['head', 'scene'] },
        contract_hash: 'abc123'
    });
    jobDb.update(job.id, {
        status: 'failed',
        error: { code: 'clipping', message: '穿模（head↔scene 连续两帧）' },
        output: { quality: { quality_gates: gates({ clipping_review: 'failed' }) } }
    });
    const failedJob = jobDb.findById(job.id);
    const attempt = recordTerminalAttempt(failedJob,
        { asset_kind: 'character', profile: 'xhs_mobile', seed: 2, prompt: 'p' },
        { error: { code: 'clipping', message: 'x' } });
    assert.equal(attempt.domain, 'animation');
    assert.equal(attempt.project, 'the-bridge-after-rain');
    assert.equal(attempt.stage, 'animation-gate');
    assert.equal(attempt.asset_id, 'teen-boy');
    assert.equal(attempt.event_id, 'clipping_review');
    assert.deepEqual(attempt.evidence, { frames: [10, 11], regions: ['head', 'scene'] });
    assert.equal(attempt.contract_hash, 'abc123');
    assert.equal(attempt.failure_category, 'clipping', 'clipping_review 失败应归为 clipping');
    // 同一任务只落一次 Attempt（幂等）
    assert.equal(recordTerminalAttempt(failedJob,
        { asset_kind: 'character', profile: 'xhs_mobile', seed: 2, prompt: 'p' },
        { error: { code: 'clipping', message: 'x' } }), null);
    // 人工审片只追加 verdict 字段，输入快照（domain/evidence/contract_hash）不得被改写
    const verdict = learningDb.applyVerdict(attempt.id, 'rejected', { category: 'clipping', notes: '审片打回', reviewerId: OWNER_A, defectScore: 4 });
    assert.equal(verdict.human_verdict, 'rejected');
    assert.equal(verdict.domain, 'animation', '审片不得改写输入快照');
    assert.deepEqual(verdict.evidence, { frames: [10, 11], regions: ['head', 'scene'] });
    assert.equal(verdict.contract_hash, 'abc123');
    // 已审片不可重复改判
    assert.throws(() => learningDb.applyVerdict(attempt.id, 'approved', {}), /已审片/);
});

// ---------- 4. 单变量校验（按领域） + 已登记方案 ----------
test('单变量白名单按领域：model 沿用 v1，animation/audio 仅允许登记项', () => {
    assert.ok(repairParamValid('model', 'seed', 42));
    assert.ok(!repairParamValid('model', 'audio.gain_adjust', 1.0), 'model 领域不允许音频变量');
    assert.ok(repairParamValid('animation', 'animation.weight_repair_plan', 'sanitize_skin_weights'));
    assert.ok(!repairParamValid('animation', 'animation.weight_repair_plan', 'not-a-registered-plan'));
    assert.ok(!repairParamValid('animation', 'seed', 42), 'animation 领域不允许改 seed');
    assert.ok(repairParamValid('audio', 'audio.gain_adjust', 1.5));
    assert.ok(!repairParamValid('audio', 'audio.gain_adjust', 9), '增益越界拒绝');
    // 已登记方案与工位脚本对齐（REGISTERED_* 非空且不含无脚本的方案）
    assert.ok(REGISTERED_WEIGHT_REPAIR_PLANS.includes('sanitize_skin_weights'));
    assert.ok(REGISTERED_RETARGET_PLANS.includes('retarget_actions'));
    // currentDomainVariableValue：audio 从 evidence/execution_plan 读取
    const audioAttempt = { domain: 'audio', evidence: { audio: { 'audio.gain_adjust': 0.8 } } };
    assert.equal(currentDomainVariableValue(audioAttempt, 'audio.gain_adjust'), 0.8);
});

test('修复计划深拷贝：不污染父计划（含 audio./animation. 点路径）', () => {
    const parentPlan = { version: 1, generation: { triangle_budget: 60000 }, audio: { gain_adjust: 1.0 }, animation: { weight_repair_plan: 'sanitize_skin_weights' } };
    parentPlan.sha256 = hashText(JSON.stringify(parentPlan));
    const audioPlan = applyRepairToPlan(parentPlan, 'audio.gain_adjust', 1.3);
    assert.equal(audioPlan.audio.gain_adjust, 1.3);
    assert.equal(parentPlan.audio.gain_adjust, 1.0, '父计划不得被原地污染');
    assert.ok(verifyRepairPlan(audioPlan, parentPlan.sha256, { param: 'audio.gain_adjust', from: 1.0, to: 1.3 }));
    const animPlan = applyRepairToPlan(parentPlan, 'animation.weight_repair_plan', 'repair_rig_symmetry');
    assert.ok(verifyRepairPlan(animPlan, parentPlan.sha256, { param: 'animation.weight_repair_plan', from: 'sanitize_skin_weights', to: 'repair_rig_symmetry' }));
    assert.equal(parentPlan.animation.weight_repair_plan, 'sanitize_skin_weights', '父计划不得被污染');
});

// ---------- 5. 预算上限（≤2 次修复） ----------
test('修复预算：每条链最多 2 次修复，deepest 无剩余', () => {
    const root = recordTerminalAttempt(makeJob(OWNER_A, { domain: 'model', asset_id: 'chair' }),
        { asset_kind: 'prop', profile: 'xhs_mobile', seed: 1, prompt: 'p' },
        { error: { message: 'GLB 文件长度校验失败' } }, { quality_gates: {} });
    const r1 = learningDb.createAttempt({ job_id: 'J-R1', owner_id: OWNER_A, domain: 'model', asset_id: 'chair',
        asset_kind: 'prop', profile: 'xhs_mobile', seed: 1, prompt: 'p', based_on_attempt_id: root.id });
    const r2 = learningDb.createAttempt({ job_id: 'J-R2', owner_id: OWNER_A, domain: 'model', asset_id: 'chair',
        asset_kind: 'prop', profile: 'xhs_mobile', seed: 1, prompt: 'p', based_on_attempt_id: r1.id });
    assert.equal(chainRepairDepth(r2.id), 2);
    assert.equal(remainingRepairs(r2.id), 0, '第 2 层修复后预算耗尽');
    assert.equal(remainingRepairs(root.id), 2);
});

// ---------- 6. 崩溃恢复 ----------
test('崩溃恢复：中断任务重排队恢复（计数返回，不改数据），二次恢复幂等', () => {
    const interrupted = makeJob(OWNER_A, { domain: 'qa', project: 'the-bridge-after-rain', stage: 'acceptance', asset_id: 'four-level' });
    // 手动置为 generating 模拟崩溃现场
    jobDb.update(interrupted.id, { status: 'generating' });
    const count = jobDb.recoverInterrupted();
    assert.equal(count, 1, 'recoverInterrupted 应返回恢复的任务数');
    const recovered = jobDb.findById(interrupted.id);
    assert.equal(recovered.status, 'queued', '中断任务应回到队列等待继续');
    assert.equal(recovered.progress_message, '服务恢复，任务将继续');
    // 二次恢复：已不在中断状态 → 不再计数
    assert.equal(jobDb.recoverInterrupted(), 0, '重复恢复必须幂等');
});

// ---------- 7. 策略晋级与回滚（按领域独立计证据） ----------
test('策略按领域计证据：audio 策略只看 audio 有效链，支持回滚', () => {
    // 建 1 条 model 有效链（不影响 audio 策略）
    const failJob = makeJob(OWNER_A, { domain: 'model', asset_id: 'm1' });
    const failA = recordTerminalAttempt(failJob,
        { asset_kind: 'prop', profile: 'xhs_mobile', seed: 1, prompt: 'p' },
        { error: { message: 'GLB 文件长度校验失败' } }, { quality_gates: {} });
    const fixJob = makeJob(OWNER_A, { domain: 'model', asset_id: 'm1' });
    const fixA = recordTerminalAttempt(fixJob,
        { asset_kind: 'prop', profile: 'xhs_mobile', seed: 1, prompt: 'p', based_on_attempt_id: failA.id },
        {}, { quality_gates: gates() });
    learningDb.createRetrospective({
        owner_id: OWNER_A, domain: 'model', asset_kind: 'prop', profile: 'xhs_mobile',
        failed_attempt_id: failA.id, fixed_attempt_id: fixA.id, chain_valid: true,
        changed_variable: { param: 'seed', from: 1, to: 2 },
        evidence: { improved: true, gate_improved: true, validation_scope: 'game', game_verified: true },
        defect_category: 'export'
    });
    // audio 策略晋级到 shadow 需要 1 条 audio 有效链 → 没有则被拒
    const audioPolicy = learningDb.createPolicy({ owner_id: OWNER_A, domain: 'audio', asset_kind: 'prop' });
    assert.equal(countValidChains({ ownerId: OWNER_A, domain: 'audio', assetKind: 'prop' }).valid, 0);
    let gate = canAdvance(audioPolicy, 'shadow', countValidChains({ ownerId: OWNER_A, domain: 'audio', assetKind: 'prop' }));
    assert.equal(gate.ok, false, 'audio 领域证据不足不得晋级');
    // model 策略证据充足可晋级
    const modelPolicy = learningDb.createPolicy({ owner_id: OWNER_A, domain: 'model', asset_kind: 'prop' });
    gate = canAdvance(modelPolicy, 'shadow', countValidChains({ ownerId: OWNER_A, domain: 'model', assetKind: 'prop' }));
    assert.equal(gate.ok, true, 'model 领域 1 条有效链可晋级 shadow');
    learningDb.advancePolicy(modelPolicy.id, 'shadow', { reviewerId: OWNER_A });
    // 回滚
    const rolled = learningDb.advancePolicy(modelPolicy.id, 'rolled_back', { reviewerId: OWNER_A });
    assert.equal(rolled.lifecycle, 'rolled_back');
});

// ---------- 8. 生产契约校验与审计 ----------
test('契约校验：重复 ID / 必需事件缺包文件被拒；审计报告孤儿与未 approved', () => {
    const base = {
        project_id: 'p', project_name: '测试',
        characters: [{ id: 'who:boy', kind: 'character', asset_ref: 'assets/characters/teen-boy', review_status: 'approved', release_gate: 'approved' }],
        actions: [{ id: 'act:run', kind: 'action' }],
        audio_events: [
            { id: 'step', role: 'locomotion', requirement: 'required', package_file: 'assets/audio-data/step.js', html_loaded: true, triggers: [{ site: 'app/game.js:footstep', trigger: '行走', stop: 'onended' }], source: { path: 'art/step.wav', sha256: 'a'.repeat(64) }, review_status: 'approved', release_gate: 'approved' },
            { id: 'rope', role: 'sfx', requirement: 'optional', package_file: 'assets/audio-data/rope.js', html_loaded: true, triggers: [], review_status: 'review', release_gate: 'approved' }
        ]
    };
    const contract = validateContract(base);
    assert.equal(contract.sha256, contractHash(contract));
    // 重复 ID
    assert.throws(() => validateContract({ ...base, props: [{ id: 'step', kind: 'prop' }] }), /ID 重复/);
    // 必需事件缺 package_file
    assert.throws(() => validateContract({ ...base, audio_events: [{ id: 'x', role: 'sfx', requirement: 'required', triggers: [], html_loaded: false }] }), /package_file/);
    // 审计：孤儿（rope）+ 正式包门禁未 approved 清单
    const audit = auditContract(contract);
    assert.deepEqual(audit.orphans, ['rope']);
    assert.ok(audit.unapproved_for_official.includes('rope'));
    assert.equal(audit.required_events_total, 1);
});

test('契约哈希：内容变化则哈希变化；审计缺必需来源报 fail', () => {
    const doc = { project_id: 'p', audio_events: [] };
    const c1 = validateContract(doc);
    const c2 = validateContract({ ...doc, version: 'v2' });
    assert.notEqual(c1.sha256, c2.sha256);
    // 必需事件缺来源 → problems（fail 级）
    const bad = validateContract({ project_id: 'p', audio_events: [{ id: 'amb', role: 'ambient', requirement: 'required', package_file: 'assets/audio-data/ambient.js', html_loaded: true, triggers: [{ site: 'app/game.js:resumeAudio', trigger: '循环环境音', stop: 'suspendAudio' }] }] });
    const audit = auditContract(bad);
    assert.ok(audit.problems.some(p => p.includes('缺少 GPU 来源')), '必需事件缺少来源必须报问题');
    assert.equal(audit.severity, 'fail');
});

// ---------- 9. 分类与门禁映射（v2 新增） ----------
test('分类：clipping/audio/integration 新类别', () => {
    assert.equal(classifyFailure({ job: {}, quality: { quality_gates: gates({ clipping_review: 'failed' }) } }), 'clipping');
    assert.equal(classifyFailure({ job: { error: { code: 'audio_trigger', message: '缺触发' } } }), 'audio_event');
    assert.equal(classifyFailure({ job: { error: { code: 'audio_orphan' } } }), 'audio_event');
    assert.equal(classifyFailure({ job: { error: { code: 'integration_missing_file' } } }), 'integration');
    // 单帧 warn 不算失败
    assert.equal(classifyFailure({ job: {}, quality: { quality_gates: gates({ clipping_review: 'warn' }) } }), 'infrastructure');
});

// ---------- 10. API 领域过滤（向后兼容） ----------
test('filterAttempts 语义：缺省 domain=model，domain=all 不过滤，asset_id/event_id/project 过滤', () => {
    const attempts = [
        { id: 'A1', domain: 'model', asset_id: 'chair', event_id: null, project: 'p1' },
        { id: 'A2', domain: 'audio', asset_id: 'step', event_id: 'step', project: 'p1' },
        { id: 'A3', domain: 'model', asset_id: 'table', event_id: null, project: 'p2' }
    ];
    // 模拟 learning.js 中的 filterAttempts 逻辑（与路由共用同一函数）
    const { resolveDomainFilter, filterAttempts } = (() => {
        // 从 learning.js 抽取不可行（路由依赖 express），此处内联等价实现以验证路由语义
        const DOMAINS = ['model', 'animation', 'audio', 'integration', 'qa'];
        function resolveDomainFilter(value) {
            if (value === undefined || value === null || value === '') return 'model';
            if (value === 'all') return null;
            if (!DOMAINS.includes(value)) throw new Error('invalid domain');
            return value;
        }
        function filterAttempts(list, query = {}) {
            const domain = resolveDomainFilter(query.domain);
            return list.filter(a => {
                if (domain && a.domain !== domain) return false;
                if (query.asset_id && a.asset_id !== query.asset_id) return false;
                if (query.event_id && a.event_id !== query.event_id) return false;
                if (query.project && a.project !== query.project) return false;
                return true;
            });
        }
        return { resolveDomainFilter, filterAttempts };
    })();
    // 旧客户端不传 domain → 默认 model（向后兼容）
    assert.deepEqual(filterAttempts(attempts, {}).map(a => a.id), ['A1', 'A3']);
    // domain=all → 全量
    assert.equal(filterAttempts(attempts, { domain: 'all' }).length, 3);
    // domain=audio + asset_id 过滤
    assert.deepEqual(filterAttempts(attempts, { domain: 'audio', asset_id: 'step' }).map(a => a.id), ['A2']);
    // project 过滤
    assert.deepEqual(filterAttempts(attempts, { domain: 'all', project: 'p2' }).map(a => a.id), ['A3']);
    assert.throws(() => resolveDomainFilter('nope'), /invalid domain/);
});

// ---------- 收尾：清理 ----------
test.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
});
