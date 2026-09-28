#!/usr/bin/env node
/* run-v31-pilot.cjs 鈥?ForgeLoop v3.1 鐪熷疄缂洪櫡鑷姩淇闂幆椹卞姩锛堟湇鍔″櫒绔級
 *
 * 鐢ㄦ硶锛? *   node tools/run-v31-pilot.cjs --phase parent  --evidence <parent-evidence.json> [--out <report.json>]
 *   node tools/run-v31-pilot.cjs --phase continue --attempt <attemptId> --evidence <child-evidence.json> [--out <report.json>]
 *   node tools/run-v31-pilot.cjs --state <attemptId>
 *
 * 涓ら樁娈佃璁★紙鐪熷疄閾撅級锛? *   parent 闃舵锛氱敤鐪熷疄璇佹嵁锛堝師濮?GLB root drift 86.8% + desktop-boy-02 VLM 0.2 critical锛夎嚜鍔ㄨ瘎浼?鈫?auto_rejected锛? *                鐒跺悗鑷姩鍒涘缓鐙珛瀛?Attempt/鏂?Job锛岀粡 gsy013 鐪熷疄 Blender 鎵ц normalize_root_translation.py
 *                鐢熸垚鏂?GLB锛涘洜娓告垙渚?staging 璇佹嵁锛堟棤 rotation-only 琛ヤ竵锛夋湭灏辩华锛屽瓙 Attempt 鍋滃湪 auto_evaluating銆? *   continue 闃舵锛氭父鎴忎晶 staging 鐑樼剻 + 鍥涘叧鍥炲綊 + 澶氳瑙掓埅鍥惧畬鎴愬悗锛屽甫鍏ㄩ噺澶栭儴璇佹嵁缁х画璇勪及瀛?Attempt
 *                鈫?auto_accepted锛堝叏閮ㄧ‖闂ㄧ + vlm_mean/min 杈炬爣 + 浼樹簬鐪熷疄鐖跺€欓€夛級鎴?auto_rejected 鈫?exhausted銆? *
 * 鐜鍙橀噺锛欴B_PATH锛堥粯璁ゅ伐鍘備粨搴撴牴 db.json锛夈€傛湇鍔″櫒閮ㄧ讲鐜鐢?supervisor 娉ㄥ叆 data/db.json銆? */
'use strict';
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
process.env.DB_PATH = process.env.DB_PATH || path.join(REPO_ROOT, 'data', 'db.json');

const { ensurePolicies, POLICY_V1 } = require(path.join(REPO_ROOT, 'server', 'auto-policy'));
const learningDb = require(path.join(REPO_ROOT, 'server', 'db')).learningDb;
const autoLoop = require(path.join(REPO_ROOT, 'server', 'auto-loop'));
const { buildRootNormalizeCommand, parseRootNormalizeReport, runRemote, BLENDER_PATH } = require(path.join(REPO_ROOT, 'server', 'repair-executor'));

// 绠€鍗曞弬鏁拌В鏋愶紙涓嶅紩鍏ラ澶栦緷璧栵級
const _argv = process.argv.slice(2);
function argVal(name) {
    const i = _argv.indexOf(`--${name}`);
    return i >= 0 && _argv[i + 1] !== undefined ? _argv[i + 1] : null;
}
const phase = argVal('phase') || 'parent';
const evidencePath = argVal('evidence');
const attemptId = argVal('attempt') || argVal('state');
const outPath = argVal('out');

// ---------- 鐪熷疄 gsy013 淇鎵ц鍣細animation.root_translation_normalization 鈫?normalize_root_translation.py ----------
async function realRepair(child, variable, job) {
    if (!variable || variable.param !== 'animation.root_translation_normalization') {
        return { error: { message: `v3.1 鐪熷疄閾句粎鏀寔 root_translation_normalization锛屽疄闄?${variable && variable.param}` } };
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
        return { error: { message: `normalize_root_translation 澶辫触 exit=${normRes.exitCode}: ${String(normRes.stderr || '').slice(0, 900)}` } };
    }
    let rootNorm = null;
    try { rootNorm = parseRootNormalizeReport(normRes.stdout, normRes.stderr, normReportPath); }
    catch (e) { return { error: { message: `瑙ｆ瀽 root-norm 鎶ュ憡澶辫触: ${e.message}` } }; }

    // 瀹屾暣鍔ㄧ敾闂ㄧ澶嶆祴锛坓sy013 鐪熷疄 analyze_animation.py锛?    const animCmd = `cd /workspace/projects/forge3d && ${BLENDER_PATH} --background --python blender/analyze_animation.py -- --input ${outGlb} --action ${action} --output ${animReportPath}`;
    const animRes = runRemote({ host: 'gsy013', command: animCmd });
    let animReport = null;
    if (animRes.exitCode === 0) {
        try { animReport = JSON.parse(runRemote({ host: 'gsy013', command: `cat ${animReportPath}` }).stdout); } catch (_) { /* 鎶ュ憡瑙ｆ瀽澶辫触涓嶈嚧鍛?*/ }
    }

    const shaRes = runRemote({ host: 'gsy013', command: `sha256sum ${outGlb}` });
    const glbSha = shaRes.exitCode === 0 ? String(shaRes.stdout || '').trim().split(/\s+/)[0] : null;
    if (!glbSha) return { error: { message: '鏃犳硶鍙栧緱鏂?GLB SHA-256' } };

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

// ---------- 璇佹嵁鍔犺浇 ----------
function loadEvidence(p) {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
}

// evaluate 鍥炶皟锛氫紭鍏堣鍙栬 Attempt 宸蹭笂浼犵殑鏈€鏂板閮ㄨ瘉鎹紝鍚﹀垯鍥為€€鐖惰瘉鎹腑鐨?external
function makeEvaluate(evidenceJson, attemptId) {
    const evPath = `/tmp/v31-evidence/${attemptId}.json`;
    return async (attempt) => {
        const ext = { ...(evidenceJson.external || {}), samples: undefined };
        // 澶栭儴璇佹嵁锛堟父鎴忎晶 staging 缁撴灉锛夎嫢宸蹭笂浼犲垯瑕嗙洊
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

    const phase = phase || 'parent';
    if (attemptId) { printAttempt(attemptId); return; }

    if (phase === 'parent') {
        const evidenceJson = loadEvidence(evidencePath);
        const parent = createOrGetParent(evidenceJson);
        // 鐖?Attempt锛氱敤鐪熷疄璇佹嵁璇勪及锛坮eopen 寮哄埗閲嶈瘎锛岄槻姝㈠鐢ㄦ棫 auto_evaluation锛?        learningDb.saveAutoEvaluation(parent.id, { external: evidenceJson.external || {}, reopen: true });
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
        return;
    }

    if (phase === 'continue') {
        const attemptId = attemptId;
        const evidenceJson = loadEvidence(evidencePath);
        const attempt = learningDb.findAttemptById(attemptId);
        if (!attempt) { console.log(JSON.stringify({ error: 'attempt not found', attemptId })); process.exit(1); }
        // 瀛?Attempt锛氬啓鍏ユ父鎴忎晶 staging 澶栭儴璇佹嵁锛坮eopen 寮哄埗閲嶈瘎锛?        learningDb.saveAutoEvaluation(attemptId, { external: evidenceJson.external || {}, reopen: true, game_side_evidence: evidenceJson.evidence || {} });
        // 涓婁紶鐨勫閮ㄨ瘉鎹枃浠朵篃钀界洏锛屼緵 evaluate 鍥炶皟璇诲彇
        fs.mkdirSync('/tmp/v31-evidence', { recursive: true });
        fs.writeFileSync(`/tmp/v31-evidence/${attemptId}.json`, JSON.stringify(evidenceJson, null, 2));
        const result = await autoLoop.runAutoIteration(attemptId, {
            ownerId: attempt.owner_id,
            evaluate: makeEvaluate(evidenceJson, attemptId),
            repair: null
        });
        printAttempt(attemptId);
        const report = { phase: 'continue', ok: result.ok, state: result.state, reason: result.reason || null, attempt_id: attemptId, result };
        console.log('---V31-REPORT---');
        console.log(JSON.stringify(report, null, 2));
        if (outPath) fs.writeFileSync(outPath, JSON.stringify({ phase, report, attempt: attemptId }, null, 2));
        return;
    }
    console.log(JSON.stringify({ error: '鏈煡 phase: ' + phase }));
    process.exit(1);
}

main().catch(e => { console.error(JSON.stringify({ fatal: e.message, stack: e.stack }, null, 2)); process.exit(1); });
