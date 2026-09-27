// ForgeLoop v2 真实闭环试点驱动 ——《仙境之桥》HY-Motion hang 重定向拒绝样本
// 流程：真实 rejected 父 Attempt → decideAutoRepair 唯一白名单变量 → createAutoRepairChild
//       → 写 repair-inputs → 由 run-auto-repair.cjs 在 gsy013 真实 Blender 重产 + 穿模门禁复测
// 用法：node tools/run-hy-motion-pilot.cjs [--parent-only]
const fs = require('fs');
const path = require('path');
const { jobDb, learningDb, modelDb } = require('../server/db');
const autoRepair = require('../server/auto-repair');

const GAME_REPO = path.resolve(__dirname, '..', '..', 'the-bridge-after-rain');
const MANIFEST = path.join(GAME_REPO, 'art', 'animations', 'hy-motion-story-actions-v1', 'manifest.json');
const REVIEW_DIR = path.join(GAME_REPO, 'review', 'hy-motion-v1-retarget-repair');

function main() {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    if (manifest.status !== 'gpu_generated_retarget_rejected') {
        throw new Error(`父样本状态非 rejected：${manifest.status}`);
    }
    const project = 'bridge-after-rain';
    const assetId = manifest.asset || 'bridge-story-hang-climb-v1';
    const outputs = manifest.outputs.map(o => ({ id: o.id, kind: o.kind, remote_path: o.remote_path, sha256: o.sha256 }));

    // 1) 父 Attempt：真实失败 + 人工 rejected（来自游戏的审片记录）
    const parent = learningDb.createAttempt({
        job_id: null,
        domain: 'animation',
        project,
        stage: 'animation-retarget',
        asset_id: assetId,
        event_id: 'hang',
        asset_kind: 'character',
        profile: 'xhs_mobile',
        evidence: {
            retarget: {
                source_motion: manifest.review.source_motion,
                reason: manifest.review.reason,
                attempts_failed: 2
            },
            outputs
        },
        pipeline: { provider: 'hy-motion', model: manifest.model, code_commit: manifest.code_commit, checkpoint_sha256: manifest.checkpoint_sha256, gpu_host: manifest.gpu_host },
        metrics: { quality_gates: { retarget_review: 'failed' }, retarget: { status: 'rejected', attempts_failed: 2 } },
        auto_status: 'failed',
        failure_category: 'animation',
        failure_detail: manifest.review.reason,
        execution_plan: { animation: { retarget_plan: null, source_fbx: outputs.find(o => o.kind === 'hang_loop_source')?.sha256 } },
        artifacts: {}
    });
    learningDb.applyVerdict(parent.id, 'rejected', {
        category: 'animation',
        notes: manifest.review.reason,
        reviewerId: 'game-review-v1',
        validationScope: 'game'
    });
    console.log(`[pilot] 父 Attempt=${parent.id} 状态=gpu_generated_retarget_rejected domain=animation`);

    // 2) 受限自动修复决策：必须唯一映射到 animation.retarget_plan=retarget_actions
    //    注意：createAttempt 返回的是克隆，applyVerdict 后需重读真实记录（含 human_verdict=rejected）
    const parentReal = learningDb.listAttempts({ limit: 200 }).find(a => a.id === parent.id);
    const decision = autoRepair.decideAutoRepair(parentReal);
    console.log(`[pilot] decideAutoRepair -> ${JSON.stringify(decision)}`);
    if (decision.action !== 'repair') {
        throw new Error(`试点决策未命中白名单修复：${decision.reason || decision.action}`);
    }
    if (decision.variable.param !== 'animation.retarget_plan' || decision.variable.to !== 'retarget_actions') {
        throw new Error(`试点修改变量非预期：${JSON.stringify(decision.variable)}`);
    }

    // 3) 创建独立子 Attempt（幂等）
    const { job, attempt, created, idempotent } = autoRepair.createAutoRepairChild(parentReal, decision);
    console.log(`[pilot] 子 Job=${job.id} Attempt=${attempt ? attempt.id : '(无)'} created=${created} idempotent=${idempotent} variable=${JSON.stringify(job.repair_variable)}`);

    // 4) 写 repair-inputs（真实资产路径，供 run-auto-repair 执行）
    const inputs = {
        target_glb: '/workspace/3d-assets/bridge-after-rain/v3/boy-runtime.glb',
        fbx: '/workspace/3d-assets/bridge-after-rain/hy-motion-story-actions-v1/00000041_000.fbx',
        alias: 'hang',
        out_glb: `/workspace/3d-assets/repair/${job.id}/output-hang.glb`,
        scene_glb: null,
        local_output: path.join(REVIEW_DIR, job.id, 'hang-repaired.glb'),
        preview_url: null
    };
    const inputsPath = path.join(__dirname, 'repair-inputs', `${job.id}.json`);
    fs.mkdirSync(path.dirname(inputsPath), { recursive: true });
    fs.writeFileSync(inputsPath, JSON.stringify(inputs, null, 2));
    console.log(`[pilot] inputs 写入 ${inputsPath}`);

    console.log(`[pilot] 下一步：node tools/run-auto-repair.cjs ${job.id}`);
    return { parent_id: parent.id, job_id: job.id, attempt_id: attempt && attempt.id, inputs_path: inputsPath };
}

const result = main();
console.log(JSON.stringify({ success: true, ...result }, null, 2));
