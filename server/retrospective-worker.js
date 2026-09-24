// ForgeLoop 复盘 worker：
//  - 任务到达终态（成功/失败）时，落一条不可变 Attempt（数据采集 + 失败标签）。
//  - 人工审片后，若这是一次「基于前次失败、只改一个变量」的修复且被批准，
//    则闭合一条因果链：写复盘 + 受控实验记录。未通过审片绝不污染经验库。
//
// 本模块全部 best-effort：任何学习侧异常都不得反过来阻断建模生产。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { learningDb, jobDb, modelDb, uploadDir } = require('./db');
const { classifyFailure, qualityScore, gateValueFails, gateValuePasses, SINGLE_VARIABLE_RULES } = require('./modeling-learning');

function hashFileSafe(absPath) {
    try {
        if (!absPath || !fs.existsSync(absPath)) return null;
        return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
    } catch {
        return null;
    }
}

function durationMs(job) {
    if (!job?.started_at || !job?.completed_at) return null;
    return Math.max(0, new Date(job.completed_at).getTime() - new Date(job.started_at).getTime());
}

// 任务终态 → 不可变 Attempt。成功与失败都记录；失败按原因打标签。
function recordTerminalAttempt(job, { model = null, result = null, error = null } = {}) {
    if (!job) return null;
    if (learningDb.findAttemptByJobId(job.id)) return null; // 幂等：一个任务只落一次
    try {
        const input = job.input || {};
        const referenceShas = (input.images || [])
            .map(filename => hashFileSafe(path.join(uploadDir, path.basename(filename))))
            .filter(Boolean);
        // 质量门与指标优先取 GPU 返回；回填场景下回退到模型上保存的 quality。
        const quality = model?.quality || job.output?.quality || {};
        const resultMetrics = result?.metrics || model?.quality?.metrics || {};
        const failed = job.status === 'failed';
        const autoStatus = failed ? 'failed' : (job.status === 'succeeded' ? 'succeeded' : job.status);

        const attempt = learningDb.createAttempt({
            job_id: job.id,
            owner_id: job.owner_id,
            asset_kind: input.asset_kind || 'prop',
            profile: input.profile || 'xhs_mobile',
            seed: input.seed ?? 1234,
            reference_shas: referenceShas,
            prompt: input.prompt || '',
            skill_snapshot_sha: job.skill_snapshot?.sha256 || null,
            execution_plan: job.execution_plan || null,
            pipeline: {
                provider: job.provider?.name || result?.provider || 'forge3d',
                task_id: job.provider?.task_id || null,
                provenance: result?.provenance || null
            },
            metrics: {
                duration_ms: durationMs(job),
                retry_count: job.attempt || 1,
                vram_mb: resultMetrics?.vram_mb ?? null,
                triangles: resultMetrics?.triangles ?? resultMetrics?.face_count ?? null,
                materials: resultMetrics?.materials ?? null,
                has_skeleton: Boolean(resultMetrics?.has_skeleton ?? resultMetrics?.bones),
                has_skinning: Boolean(resultMetrics?.has_skinning ?? resultMetrics?.max_weights_per_vertex),
                has_animation: Boolean(resultMetrics?.has_animation ?? resultMetrics?.animations?.length),
                runtime: resultMetrics?.runtime || null,
                quality_gates: quality.quality_gates || result?.quality_gates || {},
                provider_state: quality.provider_state || null
            },
            artifacts: {
                preview_url: result?.outputs?.preview_url || result?.preview_url || null,
                glb_file: model?.model_file || null,
                glb_sha: model?.sha256 || null,
                qc_report_sha: quality.quality_gates ? crypto.createHash('sha256').update(JSON.stringify(quality.quality_gates)).digest('hex') : null
            },
            auto_status: autoStatus,
            failure_category: failed ? classifyFailure({ job, quality }) : null,
            failure_detail: failed ? (error?.message || job.error?.message || '未知失败') : null,
            based_on_attempt_id: job.based_on_attempt_id || null,
            changed_variable: job.changed_variable || null
        });
        return attempt;
    } catch (err) {
        console.error(`[ForgeLoop] 记录 Attempt 失败（不影响生产）: ${err.message}`);
        return null;
    }
}

// 判断自动质量门是否「确有改善」：父 Attempt 有失败门禁，且修复 Attempt 在该维度转好。
function autoGateImproved(beforeMetrics = {}, afterMetrics = {}) {
    const before = beforeMetrics.quality_gates || {};
    const after = afterMetrics.quality_gates || {};
    let beforeHasFailure = false;
    for (const [key, value] of Object.entries(before)) {
        if (!gateValueFails(value)) continue;
        beforeHasFailure = true;
        // 该失败门禁在修复 Attempt 中必须转好（通过），才算这门禁被真正改善
        if (!gateValuePasses(after[key])) return false;
    }
    // 父 Attempt 没有任何自动门禁失败 → 不构成「门禁改善」
    return beforeHasFailure;
}

// 人工审片。批准且形成「失败→单变量修复→指标改善→门禁改善→复测通过」时，闭合因果链。
function onHumanVerdict(attemptId, verdict, { category, notes, retestedInGame = false, validationScope = null, defectScore = null, reviewerId } = {}) {
    const attempt = learningDb.applyVerdict(attemptId, verdict, {
        category,
        notes,
        reviewerId,
        defectScore,
        validationScope: validationScope || (retestedInGame ? 'game' : null)
    });
    if (!attempt) return null;

    // 只有「批准 + 基于前次失败修复 + 至少 viewer 级复测」才可能形成经验闭环
    if (verdict !== 'approved' || !attempt.based_on_attempt_id) return { attempt };
    const scope = validationScope || (retestedInGame ? 'game' : null);
    if (scope !== 'viewer' && scope !== 'game') return { attempt };

    const parent = learningDb.findAttemptById(attempt.based_on_attempt_id);
    const failedSample = parent && (parent.auto_status === 'failed' || parent.human_verdict === 'rejected');
    if (!failedSample) return { attempt };

    const before = qualityScore(parent.metrics);
    const after = qualityScore(attempt.metrics);
    const improved = after !== null && (before === null || after > before);
    const gateImproved = autoGateImproved(parent.metrics, attempt.metrics);
    const variable = attempt.changed_variable;
    const singleVariable = Boolean(variable?.param && SINGLE_VARIABLE_RULES[variable.param]);
    const gameVerified = scope === 'game';

    const chainValid = improved && gateImproved && singleVariable && scope !== null;

    const experiment = learningDb.createExperiment({
        owner_id: attempt.owner_id,
        asset_kind: attempt.asset_kind,
        hypothesis: variable ? `将 ${variable.param} 从 ${JSON.stringify(variable.from)} 改为 ${JSON.stringify(variable.to)} 以修复 ${parent.human_category || parent.failure_category}` : '',
        variable,
        baseline_attempt_id: parent.id,
        candidate_attempt_id: attempt.id,
        metrics_delta: { before_score: before, after_score: after, improved, gate_improved: gateImproved },
        human_decision: 'approved'
    });
    learningDb.updateExperiment(experiment.id, { result: improved ? 'improved' : 'inconclusive' });

    if (chainValid) {
        const retro = learningDb.createRetrospective({
            owner_id: attempt.owner_id,
            asset_kind: attempt.asset_kind,
            profile: attempt.profile,
            scope: { profile: attempt.profile },
            defect_category: parent.human_category || parent.failure_category,
            defect_detail: parent.failure_detail || '',
            failed_attempt_id: parent.id,
            fixed_attempt_id: attempt.id,
            changed_variable: variable,
            evidence: {
                before_metrics: parent.metrics,
                after_metrics: attempt.metrics,
                improved,
                gate_improved: gateImproved,
                validation_scope: scope,
                game_verified: gameVerified
            },
            chain_valid: true
        });
        learningDb.linkExperiment(attempt.id, experiment.id, variable);
        return { attempt, retrospective: retro, experiment };
    }
    return { attempt, experiment, retrospective: null };
}

// 启动时幂等回填：把历史已到终态、但尚未记录 Attempt 的任务补记，
// 使线上已完成的模型进入待审片队列。重复调用不会重复创建（recordTerminalAttempt 幂等）。
function backfillTerminalHistory() {
    let created = 0;
    for (const job of jobDb.listAll()) {
        if (job.status !== 'succeeded' && job.status !== 'failed') continue;
        const model = job.status === 'succeeded'
            ? modelDb.list().find(m => m.job_id === job.id) || null
            : null;
        const attempt = recordTerminalAttempt(job, {
            model,
            result: { metrics: model?.quality?.metrics || {}, outputs: {} }
        });
        if (attempt) {
            created += 1;
            console.log(`[ForgeLoop] 回填历史 Attempt ${attempt.id} <- ${job.id}（${job.status}，owner=${job.owner_id}）`);
        }
    }
    return created;
}

module.exports = { recordTerminalAttempt, onHumanVerdict, autoGateImproved, backfillTerminalHistory, hashFileSafe };
