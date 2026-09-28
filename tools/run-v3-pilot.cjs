// ForgeLoop v3 真实无人试点驱动（服务端模块直连）
// 用法：node tools/run-v3-pilot.cjs --evidence <evidence.json>
// evidence.json 由游戏侧试点脚本组装（硬门禁矩阵 + 动画门禁报告 + GPU 审查 + release 元数据）。
// 流程：创建 Attempt(generated, automatic) → 上报外部评估 → runAutoIteration
//      → auto_accepted → autoIntegrate（staging 报告 + release ZIP 元数据记录）
// 不自动上传、不部署、不公开发布；机器通过只标 auto_accepted。
'use strict';
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--evidence' && argv[i + 1]) args.evidence = argv[i + 1];
        else if (argv[i] === '--project') args.project = argv[i + 1];
        else if (argv[i] === '--asset-id') args.assetId = argv[i + 1];
        else if (argv[i] === '--domain') args.domain = argv[i + 1];
    }
    return args;
}

(async () => {
    const args = parseArgs(process.argv.slice(2));
    if (!args.evidence || !fs.existsSync(args.evidence)) {
        console.error('缺少 --evidence <json>');
        process.exit(2);
    }
    const evidence = JSON.parse(fs.readFileSync(args.evidence, 'utf8'));
    const { learningDb, championDb } = require('../server/db');
    const { ensurePolicies } = require('../server/auto-policy');
    const { runAutoIteration, autoIntegrate } = require('../server/auto-loop');

    ensurePolicies();
    const jobId = evidence.job_id || `JV3-${Date.now()}`;
    const existing = learningDb.findAttemptByJobId(jobId);
    const attempt = existing || learningDb.createAttempt({
        job_id: jobId,
        owner_id: evidence.owner_id || 'v3-auto-pilot',
        domain: args.domain || evidence.domain || 'animation',
        project: args.project || evidence.project || 'the-bridge-after-rain',
        stage: evidence.stage || null,
        asset_id: args.assetId || evidence.asset_id || null,
        event_id: evidence.event_id || null,
        evidence: evidence.evidence || {},
        contract_hash: evidence.contract_hash || null,
        asset_kind: evidence.asset_kind || 'character',
        profile: evidence.profile || 'xhs_mobile',
        seed: evidence.seed ?? 1234,
        execution_plan: evidence.execution_plan || null,
        pipeline: evidence.pipeline || { provider: 'forge3d', task_id: evidence.job_id || jobId },
        metrics: evidence.metrics || {},
        artifacts: evidence.artifacts || {},
        auto_flow_state: 'generated',
        acceptance_mode: 'automatic',
        human_review: 'not_performed',
        auto_chain_index: evidence.auto_chain_index ?? 0
    });

    // 上报外部评估（游戏/资产侧硬门禁矩阵）
    learningDb.saveAutoEvaluation(attempt.id, {
        external: {
            hard_gates: evidence.hard_gates || {},
            defects: evidence.defects || [],
            metrics: evidence.metrics || {},
            gpu_review: evidence.gpu_review || null,
            gpu_prompt: evidence.gpu_prompt || null,
            gpu_images: evidence.gpu_images || []
        },
        reopen: true
    });

    // 无人循环迭代（evaluate 读取 external；repair=null：候选本身无需 GPU 重产）
    const evaluate = async (a) => a.auto_evaluation?.external || null;
    const result = await runAutoIteration(attempt.id, { ownerId: evidence.owner_id || 'v3-auto-pilot', evaluate });

    let integration = null;
    if (result.state === 'auto_accepted') {
        integration = await autoIntegrate(attemptIdOrJob(result.attempt.id), {
            project: args.project || evidence.project || 'the-bridge-after-rain',
            asset_id: args.assetId || evidence.asset_id || null,
            domain: args.domain || evidence.domain || 'animation',
            verifyStaging: async () => evidence.staging_report || { ok: false, report: 'missing_staging_report' },
            buildReleaseZip: async () => evidence.release_zip || null
        });
    }

    const finalAttempt = learningDb.findAttemptById(result.attempt ? result.attempt.id : attempt.id);
    const report = {
        acceptance_mode: 'automatic',
        human_review: 'not_performed',
        published: false,
        job_id: jobId,
        attempt_id: finalAttempt.id,
        auto_flow_state: finalAttempt.auto_flow_state,
        auto_chain_index: finalAttempt.auto_chain_index,
        based_on_attempt_id: finalAttempt.based_on_attempt_id,
        changed_variable: finalAttempt.changed_variable,
        evaluation: finalAttempt.auto_evaluation ? {
            score: finalAttempt.auto_evaluation.score,
            passed: finalAttempt.auto_evaluation.passed,
            comparison: finalAttempt.auto_evaluation.comparison,
            hard_gates: finalAttempt.auto_evaluation.hard_gates,
            defects: finalAttempt.auto_evaluation.defects,
            gpu_review: finalAttempt.auto_evaluation.gpu_review
        } : null,
        integration: integration ? { ok: integration.ok, champion: integration.champion, reason: integration.reason || null } : null,
        iteration: { state: result.state, reason: result.reason || null, child: Boolean(result.child) }
    };
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
})().catch(err => { console.error('PILOT-FAIL ' + err.message); process.exit(1); });

function attemptIdOrJob(id) {
    if (String(id).startsWith('LA')) return id;
    return id;
}
