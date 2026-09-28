#!/usr/bin/env node
/* run-v31-pilot.cjs — ForgeLoop v3.1 真实缺陷自动修复闭环驱动（服务器端）
 *
 * 用法：
 *   node tools/run-v31-pilot.cjs --phase parent  --evidence <parent-evidence.json> [--out <report.json>]
 *   node tools/run-v31-pilot.cjs --phase continue --attempt <attemptId> --evidence <child-evidence.json> [--out <report.json>]
 *   node tools/run-v31-pilot.cjs --state <attemptId>
 *
 * 两阶段设计（真实链）：
 *   parent 阶段：用真实证据（原始 GLB root drift 86.8% + desktop-boy-02 VLM 0.2 critical）自动评估 → auto_rejected；
 *                然后自动创建独立子 Attempt/新 Job，经 gsy013 真实 Blender 执行 normalize_root_translation.py
 *                生成新 GLB；因游戏侧 staging 证据（无 rotation-only 补丁）未就绪，子 Attempt 停在 auto_evaluating。
 *   continue 阶段：游戏侧 staging 烘焙 + 四关回归 + 多视角截图完成后，带全量外部证据继续评估子 Attempt
 *                → auto_accepted（全部硬门禁 + vlm_mean/min 达标 + 优于真实父候选）或 auto_rejected → exhausted。
 *
 * 环境变量：DB_PATH（默认工厂仓库根 db.json）。服务器部署环境由 supervisor 注入 data/db.json。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
process.env.DB_PATH = process.env.DB_PATH || path.join(REPO_ROOT, 'data', 'db.json');

const { ensurePolicies, POLICY_V1 } = require(path.join(REPO_ROOT, 'server', 'auto-policy'));
const learningDb = require(path.join(REPO_ROOT, 'server', 'db')).learningDb;
const autoLoop = require(path.join(REPO_ROOT, 'server', 'auto-loop'));
const { buildRootNormalizeCommand, parseRootNormalizeReport, runRemote, BLENDER_PATH } = require(path.join(REPO_ROOT, 'server', 'repair-executor'));

// 简单参数解析（不引入额外依赖）
const _argv = process.argv.slice(2);
function argVal(name) {
    const i = _argv.indexOf(`--${name}`);
    return i >= 0 && _argv[i + 1] !== undefined ? _argv[i + 1] : null;
}
const phase = argVal('phase') || 'parent';
const evidencePath = argVal('evidence');
const attemptId = argVal('attempt') || argVal('state');
const outPath = argVal('out');

// ---------- 真实 gsy013 修复执行器：animation.root_translation_normalization → normalize_root_translation.py ----------
async function realRepair(child, variable, job) {
    if (!variable || variable.param !== 'animation.root_translation_normalization') {
        return { error: { message: `v3.1 真实链仅支持 root_translation_normalization，实际 ${variable && variable.param}` } };
    }
    const inputGlb = child.evidence?.raw_generic_glb?.glb_file
        || child.evidence?.artifacts?.glb_file
        || '/workspace/3d-assets/repair/J000001/output-hang.glb';
    const action = child.evidence?.raw_generic_glb?.action || 'hang';
    const outRoot = `/workspace/3d-assets/repair/${job.id}`;
    const outGlb = `${outRoot}/output-hang-normalized.glb`;
    const normReportPath = `${outRoot}/root-norm-report.json`;
    const animReportPath = `${outRoot}/v3-anim-report.json`;

    const built = buildRootNormalizeCommand({ targetGlb: inputGlb, action, outGlb, reportOut: normReportPath });
    const normRes = runRemote(built);
    if (normRes.exitCode !== 0) {
        return { error: { message: `normalize_root_translation 失败 exit=${normRes.exitCode}: ${String(normRes.stderr || '').slice(0, 900)}` } };
    }
    let rootNorm = null;
    try { rootNorm = parseRootNormalizeReport(normRes.stdout, normRes.stderr, normReportPath); }
    catch (e) { return { error: { message: `解析 root-norm 报告失败: ${e.message}` } }; }

    // 完整动画门禁复测（gsy013 真实 analyze_animation.py）
    const animCmd = `cd /workspace/projects/forge3d && ${BLENDER_PATH} --background --python blender/analyze_animation.py -- --input ${outGlb} --action ${action} --output ${animReportPath}`;
    const animRes = runRemote({ host: 'gsy013', command: animCmd });
    let animReport = null;
    if (animRes.exitCode === 0) {
        try { animReport = JSON.parse(runRemote({ host: 'gsy013', command: `cat ${animReportPath}` }).stdout); } catch (_) { /* 报告解析失败不致命 */ }
    }

    const shaRes = runRemote({ host: 'gsy013', command: `sha256sum ${outGlb}` });
    const glbSha = shaRes.exitCode === 0 ? String(shaRes.stdout || '').trim().split(/\s+/)[0] : null;
    if (!glbSha) return { error: { message: '无法取得新 GLB SHA-256' } };

    const pq = animReport?.pose_quality || {};
    const afterRatio = pq.max_root_translation_ratio ?? rootNorm.after?.max_root_translation_ratio ?? null;
    return {
        job_id: job.id,
        job_status: 'succeeded',
        provider: 'forge3d-blender-root-normalize',
        artifacts: { glb_file: outGlb, glb_sha: glbSha },
        metrics: { root_norm: rootNorm, animation_after: pq, input_glb_sha: child.evidence?.artifacts?.glb_sha || null, executor: 'gsy013 blender 4.5.13' },
        animationEvidence: { ...pq, root_translation_ratio: afterRatio, root_translation_ratio_before: rootNorm.before?.max_root_translation_ratio ?? null, root_translation_ratio_after: afterRatio },
        evidence: {
            raw_generic_glb: {
                glb_file: outGlb, glb_sha: glbSha, action,
                report_path: animReportPath, root_norm_report: normReportPath,
                root_translation_ratio: afterRatio,
                before_root_translation_ratio: rootNorm.before?.max_root_translation_ratio ?? null,
                rig_height: rootNorm.rig_height ?? pq.rig_height ?? null,
                clamped: rootNorm.clamped ?? null,
                loop_seam_enforced: rootNorm.loop_seam_enforced ?? null
            },
            animation: { root_translation_ratio: afterRatio }
        },
        pending_external: true
    };
}

// ---------- 证据加载 ----------
function loadEvidence(p) {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
}

// evaluate 回调：优先读取该 Attempt 已上传的最新外部证据，否则回退父证据中的 external
function makeEvaluate(evidenceJson, attemptId) {
    const evPath = `/tmp/v31-evidence/${attemptId}.json`;
    return async (attempt) => {
        const ext = { ...(evidenceJson.external || {}), samples: undefined };
        // 外部证据（游戏侧 staging 结果）若已上传则覆盖
        if (fs.existsSync(evPath)) {
            const up = JSON.parse(fs.readFileSync(evPath, 'utf8'));
            return { ...ext, ...(up.external || {}), ...up };
        }
        return ext;
    };
}

function createOrGetParent(evidenceJson) {
    const existing = learningDb.listAttempts({ ownerId: evidenceJson.owner_id || 'forge-loop-v31', limit: 200 })
        .find(a => a.job_id === evidenceJson.job_id && a.based_on_attempt_id === null);
    if (existing) return existing;
    const attempt = learningDb.createAttempt({
        job_id: evidenceJson.job_id,
        asset_id: evidenceJson.asset_id || 'hang',
        domain: evidenceJson.domain || 'animation',
        profile: evidenceJson.profile || 'xhs_mobile',
        owner_id: evidenceJson.owner_id || 'forge-loop-v31',
        based_on_attempt_id: null,
        evidence: evidenceJson.evidence || {},
        artifacts: evidenceJson.artifacts || {},
        metrics: evidenceJson.metrics || {},
        intent: 'repair'
    });
    return learningDb.findAttemptById(attempt.id);
}

function printAttempt(id) {
    const a = learningDb.findAttemptById(id);
    if (!a) { console.log(JSON.stringify({ error: 'attempt not found', id })); return; }
    console.log(JSON.stringify({
        id: a.id, job_id: a.job_id, state: a.auto_flow_state, chain_index: a.auto_chain_index,
        changed_variable: a.changed_variable, based_on_attempt_id: a.based_on_attempt_id,
        score: a.auto_evaluation?.score, passed: a.auto_evaluation?.passed,
        score_vector: a.auto_evaluation?.score_vector || null,
        defects: a.auto_evaluation?.defects || [],
        artifacts: a.artifacts || {},
        animationEvidence: a.animationEvidence || null,
        created_at: a.created_at, updated_at: a.updated_at
    }, null, 2));
}

async function main() {
    ensurePolicies();
    const policy = POLICY_V1.animation;
    console.log(JSON.stringify({ policy: { domain: 'animation', version: policy.version, scoring: policy.scoring, critical_labels: policy.critical_labels, thresholds: policy.thresholds } }));

    if (attemptId && phase !== 'parent' && phase !== 'continue') { printAttempt(attemptId); return; }

    if (phase === 'parent') {
        const evidenceJson = loadEvidence(evidencePath);
        const parent = createOrGetParent(evidenceJson);
        // 父 Attempt：用真实证据评估（reopen 强制重评，防止复用旧 auto_evaluation）
        learningDb.saveAutoEvaluation(parent.id, { external: evidenceJson.external || {}, reopen: true });
        const result = await autoLoop.runAutoIteration(parent.id, {
            ownerId: evidenceJson.owner_id || 'forge-loop-v31',
            evaluate: makeEvaluate(evidenceJson, parent.id),
            repair: realRepair
        });
        printAttempt(parent.id);
        if (result.child) printAttempt(result.attempt.id);
        const report = {
            phase: 'parent', ok: result.ok, state: result.state, reason: result.reason || null,
            pending_external: !!result.pending_external,
            parent_attempt_id: parent.id,
            child_attempt_id: result.attempt?.id || null,
            child_job_id: result.job?.id || null,
            result
        };
        console.log('---V31-REPORT---');
        console.log(JSON.stringify(report, null, 2));
        if (outPath) fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
        return;
    }

    if (phase === 'continue') {
        const targetAttemptId = attemptId;
        const evidenceJson = loadEvidence(evidencePath);
        const attempt = learningDb.findAttemptById(targetAttemptId);
        if (!attempt) { console.log(JSON.stringify({ error: 'attempt not found', attemptId: targetAttemptId })); process.exit(1); }
        // 子 Attempt：写入游戏侧 staging 外部证据（reopen 强制重评）
        learningDb.saveAutoEvaluation(targetAttemptId, { external: evidenceJson.external || {}, reopen: true, game_side_evidence: evidenceJson.evidence || {} });
        fs.mkdirSync('/tmp/v31-evidence', { recursive: true });
        fs.writeFileSync(`/tmp/v31-evidence/${targetAttemptId}.json`, JSON.stringify(evidenceJson, null, 2));
        const result = await autoLoop.runAutoIteration(targetAttemptId, {
            ownerId: attempt.owner_id,
            evaluate: makeEvaluate(evidenceJson, targetAttemptId),
            repair: null
        });
        printAttempt(targetAttemptId);
        const report = { phase: 'continue', ok: result.ok, state: result.state, reason: result.reason || null, attempt_id: targetAttemptId, result };
        console.log('---V31-REPORT---');
        console.log(JSON.stringify(report, null, 2));
        if (outPath) fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
        return;
    }
    console.log(JSON.stringify({ error: '未知 phase: ' + phase }));
    process.exit(1);
}

main().catch(e => { console.error(JSON.stringify({ fatal: e.message, stack: e.stack }, null, 2)); process.exit(1); });
