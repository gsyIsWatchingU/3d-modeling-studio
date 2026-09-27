// ForgeLoop v2 —— 受限自动修复编排
//
// 目标：真实失败或人工 rejected → 自动归因 → 选择一个白名单修复变量 →
//       创建独立子 Attempt → 调用正确 GPU 工位重产 → 重跑同一自动门禁 →
//       对比父子指标 → Three.js 预览或游戏内复测 → 停在 pending_human_review →
//       用户明确 approved 后才沉淀有效经验和策略。
//
// 硬约束（本文件只做"编排"，不做任何"结论"）：
//  - 绝不自动 approved、绝不自动正式发布、绝不绕过人工审片。
//  - 只有缺陷能唯一映射到安全白名单修复时才自动创建子 Attempt；
//    歧义 / 审美问题 / 未知输入 / 基础设施问题一律进入待处理队列（defer）。
//  - 每条父链最多修复 MAX_REPAIRS_PER_CHAIN 次，每轮最多 MAX_CANDIDATES_PER_ROUND 个候选。
//  - 幂等、可恢复：以 (parent_attempt_id + repair_variable) 为唯一键；
//    服务重启后不会重复创建子任务，也不会重复提交 GPU 任务。
//  - 每个子 Attempt 拥有独立 job_id、attempt_id、父 ID、修改变量、执行计划 SHA、
//    输入 SHA、产物 SHA 和门禁证据。
//  - 自动候选无论是否通过，都不得覆盖父产物、原 manifest 或正式资产。
//  - 通过自动门禁后必须停在 pending_human_review（子 Attempt 的 human_verdict 保持 pending）。

const crypto = require('crypto');
const { jobDb, learningDb } = require('./db');
const { hashText } = require('./utils');
const {
    repairParamValid,
    currentDomainVariableValue,
    applyRepairToPlan,
    classifyFailure,
    CANDIDATE_BUDGET
} = require('./modeling-learning');

const MAX_REPAIRS_PER_CHAIN = CANDIDATE_BUDGET?.max_repairs || 2;
const MAX_CANDIDATES_PER_ROUND = CANDIDATE_BUDGET?.max_candidates || 3;

// ---------- 自动修复决策表（缺陷 → 唯一安全白名单修复变量） ----------
// 只有表内命中才允许自动创建子 Attempt；其余一律 defer 进待处理队列。
// 每个 (category, evidenceSubSignal) 只映射到一个变量，保证"唯一映射"。
const AUTO_REPAIR_TABLE = {
    // 穿模：唯一的低风险白名单修复是"清洗皮肤权重"（已在工位登记脚本）
    clipping: {
        variable: { param: 'animation.weight_repair_plan', to: 'sanitize_skin_weights' },
        reason: '穿模缺陷唯一映射到已登记的权重清洗方案'
    },
    // 动画缺陷（重定向导致的手臂扭转等）：唯一修复是重跑已登记重定向方案
    animation: {
        variable: { param: 'animation.retarget_plan', to: 'retarget_actions' },
        reason: '动画缺陷唯一映射到已登记的重定向方案'
    },
    // 音频事件：按证据细分到唯一参数；触发器/孤儿/停止类缺陷不是白名单可修，走 defer
    audio_event: {
        variable: evidence => {
            const audio = evidence?.audio || {};
            if (typeof audio.trim_start_s === 'number') {
                return { param: 'audio.trim_start_s', to: audio.trim_start_s };
            }
            if (audio.gain_out_of_range || audio.peak_clip) {
                return { param: 'audio.gain_adjust', to: audio.target_gain ?? 1.0 };
            }
            return null;
        },
        reason: '音频事件按证据唯一映射到增益或截取起点修复'
    }
};

// 这些失败类别明确"不可自动修复"：歧义 / 审美 / 未知输入 / 基础设施 / 集成触发类
const DEFER_CATEGORIES = new Set([
    'input', 'infrastructure', 'aesthetic', 'unknown', 'shape', 'material',
    'topology', 'rig', 'skinning', 'export', 'engine_runtime', 'integration',
    'audio_trigger', 'audio_orphan', 'audio_unstopped'
]);

function sha256Of(obj) {
    return crypto.createHash('sha256').update(typeof obj === 'string' ? obj : JSON.stringify(obj)).digest('hex');
}

// 归一化自动归因：优先用人工类别/证据，其次用自动分类
function autoClassify(attempt) {
    if (attempt.human_category && attempt.human_verdict === 'rejected') {
        return { category: attempt.human_category, evidence: attempt.evidence || {} };
    }
    const jobLike = {
        quality: attempt.metrics?.quality_gates || {},
        error: attempt.failure_detail || ''
    };
    const category = classifyFailure({ job: jobLike, quality: attempt.metrics || {} });
    return { category, evidence: attempt.evidence || {} };
}

// 判断一个 Attempt 是否处于"可修复"终态：自动失败，或人工 rejected
function isRepairableTerminal(attempt) {
    if (!attempt) return false;
    if (attempt.human_verdict === 'rejected') return true;
    if (attempt.human_verdict === 'approved') return false;
    return attempt.auto_status === 'failed';
}

// 计算该 Attempt 的父链已用掉的修复次数（子 Attempt 全部计入预算，深度 ≤2）
function chainRepairsUsed(attemptId) {
    const all = learningDb.listAttempts({ limit: 500 });
    const children = all.filter(a => a.based_on_attempt_id === attemptId);
    let count = children.length;
    for (const child of children) {
        count += all.filter(a => a.based_on_attempt_id === child.id).length;
    }
    return count;
}

// 幂等键：同一父 Attempt + 同一修复变量 只允许一个子任务
function findChildJob(parentAttemptId, variable) {
    return jobDb.listAll().find(job =>
        job.based_on_attempt_id === parentAttemptId &&
        job.repair_variable?.param === variable.param &&
        job.repair_variable?.to === variable.to) || null;
}

function findChildAttempt(parentAttemptId, variable) {
    return learningDb.listAttempts({ limit: 500 }).find(a =>
        a.based_on_attempt_id === parentAttemptId &&
        a.changed_variable?.param === variable.param &&
        a.changed_variable?.to === variable.to) || null;
}

// ---------- 决策：只创建"缺陷能唯一映射到白名单修复"的子任务 ----------
// 返回 { action: 'repair', variable } 或 { action: 'defer', reason }
function decideAutoRepair(parentAttempt) {
    if (!isRepairableTerminal(parentAttempt)) {
        return { action: 'defer', reason: 'Attempt 不处于可修复终态（未失败且未被拒绝）' };
    }
    const domain = parentAttempt.domain || 'model';
    const { category, evidence } = autoClassify(parentAttempt);
    if (DEFER_CATEGORIES.has(category)) {
        return { action: 'defer', reason: `失败类别「${category}」不可自动修复（歧义/审美/未知输入/基础设施/触发类），需人工待处理` };
    }
    const entry = AUTO_REPAIR_TABLE[category];
    if (!entry) {
        return { action: 'defer', reason: `失败类别「${category}」无自动修复映射，进入待处理队列` };
    }
    let variable;
    try {
        variable = typeof entry.variable === 'function' ? entry.variable(evidence) : entry.variable;
    } catch (err) {
        return { action: 'defer', reason: `自动修复参数解析失败：${err.message}` };
    }
    if (!variable) {
        return { action: 'defer', reason: `失败类别「${category}」证据不足以唯一映射到白名单变量` };
    }
    // 修复变量必须属于父 Attempt 领域白名单（跨领域变量一律拒绝）
    if (!repairParamValid(domain, variable.param, variable.to)) {
        return { action: 'defer', reason: `变量 ${variable.param}=${variable.to} 不属于领域 ${domain} 白名单（跨领域或值非法）` };
    }
    const used = chainRepairsUsed(parentAttempt.id);
    if (used >= MAX_REPAIRS_PER_CHAIN) {
        return { action: 'defer', reason: `父链已用 ${used}/${MAX_REPAIRS_PER_CHAIN} 次修复预算，超出预算不再自动修复` };
    }
    return { action: 'repair', variable, category, reason: entry.reason };
}

// ---------- 创建子 Attempt（幂等） ----------
// 创建 Job + Attempt 记录；不提交 GPU 任务（提交由执行器负责，且以 job_id 为幂等锚点）。
function createAutoRepairChild(parentAttempt, { variable, category, reason }) {
    // 幂等：已存在同键子任务/子 Attempt 直接返回，绝不重复创建
    const existingJob = findChildJob(parentAttempt.id, variable);
    if (existingJob) {
        const existingAttempt = learningDb.findAttemptByJobId(existingJob.id);
        return { job: existingJob, attempt: existingAttempt, created: false, idempotent: true };
    }
    const from = currentDomainVariableValue(parentAttempt, variable.param);
    const parentPlan = parentAttempt.execution_plan || {};
    const parentPlanSha = hashText(JSON.stringify(parentPlan));
    const childPlan = applyRepairToPlan(parentPlan, variable.param, variable.to);

    // 输入 SHA = 父计划 SHA + 资产/事件 + 参考图 SHA + 修复变量（确定性，服务重启可复算）
    const inputSha = sha256Of({
        parent_plan_sha: parentPlanSha,
        project: parentAttempt.project,
        asset_id: parentAttempt.asset_id,
        event_id: parentAttempt.event_id,
        reference_shas: parentAttempt.reference_shas || [],
        variable,
        from
    });

    const job = jobDb.create({
        name: `自动修复-${category}-${parentAttempt.id}`,
        input: { parent_attempt_id: parentAttempt.id },
        domain: parentAttempt.domain || 'model',
        project: parentAttempt.project,
        stage: parentAttempt.stage,
        asset_id: parentAttempt.asset_id,
        event_id: parentAttempt.event_id,
        evidence: parentAttempt.evidence || {},
        contract_hash: parentAttempt.contract_hash,
        based_on_attempt_id: parentAttempt.id,
        changed_variable: { param: variable.param, from, to: variable.to, reason },
        repair_variable: { param: variable.param, from, to: variable.to },
        parent_plan_sha: parentPlanSha,
        execution_plan: childPlan,
        input_sha: inputSha,
        executor: executorForDomain(parentAttempt.domain || 'model', variable.param),
        auto_repair: { kind: 'auto', category, round: chainRepairsUsed(parentAttempt.id) + 1 },
        owner_id: parentAttempt.owner_id ?? null,
        max_attempts: 1
    });

    const attempt = learningDb.createAttempt({
        job_id: job.id,
        owner_id: parentAttempt.owner_id ?? null,
        domain: parentAttempt.domain || 'model',
        project: parentAttempt.project,
        stage: parentAttempt.stage,
        asset_id: parentAttempt.asset_id,
        event_id: parentAttempt.event_id,
        evidence: { ...(parentAttempt.evidence || {}), auto_repair: { parent_attempt_id: parentAttempt.id, variable, input_sha: inputSha } },
        contract_hash: parentAttempt.contract_hash,
        asset_kind: parentAttempt.asset_kind || 'prop',
        profile: parentAttempt.profile || 'xhs_mobile',
        seed: parentAttempt.seed ?? 1234,
        reference_shas: parentAttempt.reference_shas || [],
        prompt: parentAttempt.prompt || '',
        skill_snapshot_sha: parentAttempt.skill_snapshot_sha,
        execution_plan: childPlan,
        pipeline: parentAttempt.pipeline || {},
        auto_status: 'unknown',
        based_on_attempt_id: parentAttempt.id,
        changed_variable: { param: variable.param, from, to: variable.to, reason }
    });

    // 自动候选绝不覆盖父 Attempt 的产物/原 manifest：子 Attempt 是独立快照，不改父行
    return { job, attempt, created: true, idempotent: false };
}

function executorForDomain(domain, param) {
    if (domain === 'audio') return 'gpu-audio-postprocess';
    if (param && param.startsWith('animation.weight_repair_plan')) return 'forge3d-blender-weight';
    if (param && param.startsWith('animation.retarget_plan')) return 'forge3d-blender-retarget';
    return 'forge3d-model'; // model 领域走原 Forge3D 建模流水线
}

// ---------- 自动修复轮询（服务端可周期调用） ----------
// 每轮最多创建 MAX_CANDIDATES_PER_ROUND 个候选；每个父 Attempt 每轮最多创建 1 个子任务。
function queueAutoRepairs({ limit = MAX_CANDIDATES_PER_ROUND, ownerId } = {}) {
    const attempts = learningDb.listAttempts({ ownerId, limit: 500 });
    const created = [];
    let roundCandidates = 0;
    for (const parent of attempts) {
        if (roundCandidates >= limit) break;
        if (!isRepairableTerminal(parent)) continue;
        const decision = decideAutoRepair(parent);
        if (decision.action !== 'repair') continue;
        const result = createAutoRepairChild(parent, decision);
        if (result.created) {
            roundCandidates += 1;
            created.push({ parent_id: parent.id, job_id: result.job.id, attempt_id: result.attempt.id });
        }
    }
    return { created, round_limit: limit, max_repairs_per_chain: MAX_REPAIRS_PER_CHAIN };
}

// 待处理队列（歧义/审美/未知/基础设施等不可自动修复项），供人工 triage 使用
function listPendingTriage({ ownerId } = {}) {
    return learningDb.listAttempts({ ownerId, limit: 500 })
        .filter(a => isRepairableTerminal(a))
        .map(a => ({ attempt: a, decision: decideAutoRepair(a) }))
        .filter(item => item.decision.action === 'defer');
}

// 崩溃恢复：服务重启时检查子任务是否已产生产物，防止重复提交 GPU 任务。
// 有产物（artifact_sha）的子任务保持终态；无产物且未提交的任务由 jobDb.recoverInterrupted
// 统一恢复为 queued，执行器按 job_id 幂等执行（先查 artifact_sha 再决定是否重跑）。
function recoverAutoRepairs() {
    const jobs = jobDb.listAll().filter(j => j.auto_repair?.kind === 'auto');
    const recovered = [];
    for (const job of jobs) {
        const attempt = learningDb.findAttemptByJobId(job.id);
        if (!attempt) continue;
        const hasArtifact = Boolean(job.artifact_sha || attempt.artifacts?.glb_sha || attempt.artifacts?.audio_sha);
        if (hasArtifact && attempt.auto_status === 'unknown') {
            // 已产出但 Attempt 尚未收尾：标记恢复状态，避免重复提交；收尾仍由复盘 worker 完成
            recovered.push({ job_id: job.id, status: 'artifact_present_resume_finalize' });
        } else if (!hasArtifact && ['generating', 'downloading', 'validating'].includes(job.status)) {
            recovered.push({ job_id: job.id, status: 'no_artifact_requeue' });
        }
    }
    return recovered;
}

module.exports = {
    AUTO_REPAIR_TABLE,
    DEFER_CATEGORIES,
    decideAutoRepair,
    createAutoRepairChild,
    queueAutoRepairs,
    listPendingTriage,
    recoverAutoRepairs,
    chainRepairsUsed,
    findChildJob,
    isRepairableTerminal,
    MAX_REPAIRS_PER_CHAIN,
    MAX_CANDIDATES_PER_ROUND
};
