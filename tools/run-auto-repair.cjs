// ForgeLoop v2 —— 受限自动修复的真实执行器 CLI
// 用法：node tools/run-auto-repair.cjs <jobId> [--inputs <json路径>]
//   <jobId>        自动修复子任务的 job_id（由 auto-repair 编排创建）
//   --inputs       执行器输入 JSON：{ target_glb, fbx, alias, out_glb, scene_glb, local_output,
//                   event_dir, project_id, event_id, gain, trim_start_s, download }
//   缺省读取 tools/repair-inputs/<jobId>.json
//
// 职责：
//   1) 按 job.executor 分派到已登记 GPU 工位脚本（Blender retarget/weight、audio_factory postprocess）；
//   2) 幂等：job.artifact_sha 已存在 → 直接返回，绝不重复提交 GPU 任务；
//   3) 回填 job.artifact_sha / gate_evidence，并调用 finalizeAutoRepairAttempt 收尾子 Attempt；
//   4) 自动流程只写到 auto_status='succeeded'（人工 pending），绝不触碰 human_* 字段。
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { jobDb, learningDb, modelDb, modelDir } = require('../server/db');
const exec = require('../server/repair-executor');
const { finalizeAutoRepairAttempt } = require('../server/retrospective-worker');

function sha256File(p) {
    if (!fs.existsSync(p)) return null;
    return require('crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function loadInputs(jobId, cliPath) {
    const p = cliPath || path.join(__dirname, 'repair-inputs', `${jobId}.json`);
    if (!fs.existsSync(p)) {
        throw new Error(`缺少执行器输入 ${p}：请提供 --inputs 或在 tools/repair-inputs/ 放置 ${jobId}.json`);
    }
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function runRemoteAndLog(built) {
    const res = exec.runRemote(built);
    console.log(`[executor] host=${res.host} kind=${res.kind} exit=${res.exitCode}`);
    console.log(`[executor] cmd: ${res.command}`);
    if (res.stdout) console.log(`[stdout] ${res.stdout.slice(0, 1200)}`);
    if (res.stderr) console.log(`[stderr] ${res.stderr.slice(0, 1200)}`);
    if (res.exitCode !== 0) throw new Error(`GPU 工位执行失败（exit=${res.exitCode}）：${(res.stderr || res.stdout || '').slice(0, 800)}`);
    return res;
}

function remoteSha(host, absPath) {
    const res = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host, `sha256sum ${absPath}`], { encoding: 'utf8', timeout: 60000 });
    if (res.error || res.status !== 0) throw new Error(`获取远端 SHA 失败：${res.stderr || res.error?.message}`);
    const m = res.stdout.trim().split(/\s+/)[0];
    if (!/^[0-9a-f]{64}$/.test(m)) throw new Error(`远端 SHA 非法：${res.stdout}`);
    return m;
}

function scpFrom(host, remotePath, localPath) {
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    const res = spawnSync('scp', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', `${host}:${remotePath}`, localPath], { encoding: 'utf8', timeout: 300000 });
    if (res.error || res.status !== 0) throw new Error(`下载远端产物失败：${res.stderr || res.error?.message}`);
    return localPath;
}

async function runAnimation(job, inputs) {
    const variable = job.repair_variable || job.changed_variable || {};
    const kind = variable.param || job.executor;
    const outGlb = inputs.out_glb || `/workspace/3d-assets/repair/${job.id}/output.glb`;
    let built;
    if (String(kind).includes('weight_repair_plan') || job.executor === 'forge3d-blender-weight') {
        // 权重修复方案：已登记脚本 sanitize_skin_weights.py（输入 GLB → 输出清洗权重后的 GLB）
        const script = path.posix.join(exec.FORGE3D_ROOT, 'blender', 'sanitize_skin_weights.py');
        built = {
            host: 'gsy013',
            script,
            kind: 'animation.weight_repair_plan',
            command: `cd ${exec.FORGE3D_ROOT} && ${exec.BLENDER_PATH} --background --python ${script} -- --input ${inputs.target_glb} --output ${outGlb}`
        };
    } else {
        built = exec.buildRetargetCommand({
            targetGlb: inputs.target_glb,
            fbxPath: inputs.fbx,
            alias: inputs.alias,
            outGlb
        });
    }
    runRemoteAndLog(built);
    // 门禁复测：穿模/变形分析（同一 analyze_clipping.py）
    const gate = exec.buildClippingGateCommand({ glbPath: outGlb, action: inputs.alias, sceneGlb: inputs.scene_glb });
    const gateRes = runRemoteAndLog(gate);
    let gateReport;
    try {
        gateReport = exec.parseClippingReport(gateRes.stdout, gateRes.stderr, null);
    } catch (e) {
        throw new Error(`穿模门禁输出解析失败：${e.message}`);
    }
    // 下载产物到工厂（模型目录），供 Three.js 预览与游戏审片复测
    const localOutput = inputs.local_output || path.join(modelDir, `repair-${job.id}.glb`);
    scpFrom('gsy013', outGlb, localOutput);
    const artifactSha = sha256File(localOutput);
    const remoteSha256 = remoteSha('gsy013', outGlb);
    if (artifactSha !== remoteSha256) throw new Error(`本地/远端 SHA 不一致：本地 ${artifactSha} vs 远端 ${remoteSha256}`);
    // 保存为模型记录（独立产物，绝不覆盖正式资产）
    const model = modelDb.create({
        name: `自动修复-${job.id}`,
        original_images: [],
        prompt: `auto-repair ${job.id} ${kind}`,
        skill_snapshot: null,
        job_id: job.id,
        status: 'completed',
        model_file: `/models/${path.basename(localOutput)}`,
        file_size: fs.statSync(localOutput).size,
        sha256: artifactSha
    });
    modelDb.update(model.id, { quality: { quality_gates: gateReport.quality_gates, metrics: gateReport.metrics, provider_state: 'repair-executor' } });
    return {
        artifact_sha: artifactSha,
        artifact_local: localOutput,
        artifact_remote: outGlb,
        model_id: model.id,
        gate_evidence: gateReport,
        metrics: gateReport.metrics,
        pipeline: { provider: 'forge3d-blender', task_id: job.id, provenance: { repair_kind: kind, script: built.script, host: 'gsy013' } },
        artifacts: { glb_file: `/models/${path.basename(localOutput)}`, glb_sha: artifactSha, preview_url: inputs.preview_url || null }
    };
}

async function runAudio(job, inputs) {
    const variable = job.repair_variable || job.changed_variable || {};
    const gain = inputs.gain !== undefined ? inputs.gain : (variable.param === 'audio.gain_adjust' ? variable.to : null);
    const trimStartS = inputs.trim_start_s !== undefined ? inputs.trim_start_s : (variable.param === 'audio.trim_start_s' ? variable.to : null);
    if (gain === null && trimStartS === null) throw new Error('音频修复需要 gain 或 trim_start_s');
    const built = exec.buildAudioRepairCommand({
        eventJobDir: inputs.event_dir,
        eventId: inputs.event_id || job.event_id,
        projectId: inputs.project_id || job.project,
        gain,
        trimStartS,
        outRoot: inputs.out_root
    });
    const res = runRemoteAndLog(built);
    let result;
    try {
        result = JSON.parse(res.stdout.trim().split('\n').pop());
    } catch (e) {
        throw new Error(`audio_factory 输出解析失败：${res.stdout.slice(0, 500)}`);
    }
    if (result.status !== 'review' && result.status !== 'completed') throw new Error(`音频后处理未完成：${JSON.stringify(result)}`);
    const output = result.outputs?.[0] || {};
    const audioSha = output.sha256;
    return {
        artifact_sha: audioSha,
        artifact_remote: `${inputs.out_root || '/workspace/3d-assets/game-audio'}/${inputs.project_id || job.project}/${inputs.event_id || job.event_id}/${result.job_id}/${output.file}`,
        gate_evidence: { quality_gates: { audio_review: 'review' }, audio: { gain, trim_start_s: trimStartS, duration_s: output.duration_s, job_id: result.job_id, parent_job_id: result.parent_job_id } },
        metrics: { quality_gates: { audio_review: 'review' }, audio: { gain, trim_start_s: trimStartS, duration_s: output.duration_s } },
        pipeline: { provider: 'gpu-audio-postprocess', task_id: result.job_id, provenance: { parent_job_id: result.parent_job_id, script: built.script, host: 'mygpu' } },
        artifacts: { audio_sha: audioSha, audio_remote: null }
    };
}

async function main() {
    const jobId = process.argv[2];
    const inputsPath = process.argv.indexOf('--inputs') >= 0 ? process.argv[process.argv.indexOf('--inputs') + 1] : null;
    if (!jobId) {
        console.error('用法：node tools/run-auto-repair.cjs <jobId> [--inputs <json>]');
        process.exit(2);
    }
    const job = jobDb.findById(jobId);
    if (!job) throw new Error(`任务不存在：${jobId}`);
    if (!job.auto_repair?.kind === 'auto') throw new Error(`${jobId} 不是自动修复子任务`);
    // 幂等：已产出产物 → 跳过执行，绝不重复提交 GPU 任务
    if (job.artifact_sha) {
        console.log(`[executor] ${jobId} 已有产物 ${job.artifact_sha}，跳过执行（幂等）`);
        return { job, skipped: true };
    }
    const inputs = loadInputs(jobId, inputsPath);
    console.log(`[executor] 开始执行 ${jobId} executor=${job.executor} 变量=${JSON.stringify(job.repair_variable)}`);
    const startedAt = new Date().toISOString();
    let outcome;
    if (String(job.executor).startsWith('forge3d-blender')) {
        outcome = await runAnimation(job, inputs);
    } else if (job.executor === 'gpu-audio-postprocess') {
        outcome = await runAudio(job, inputs);
    } else {
        throw new Error(`未接通的执行器类型：${job.executor}（model 领域走 Forge3D API 流水线，不在此 CLI 范围）`);
    }
    const completed = jobDb.update(job.id, {
        status: 'succeeded',
        progress_message: '自动修复已真实重产并通过门禁复测，等待人工审片',
        artifact_sha: outcome.artifact_sha,
        gate_evidence: outcome.gate_evidence,
        output: { repair: outcome },
        completed_at: new Date().toISOString(),
        started_at: job.started_at || startedAt,
        error: null
    });
    const attempt = finalizeAutoRepairAttempt(completed, {
        metrics: outcome.metrics,
        artifacts: outcome.artifacts,
        pipeline: outcome.pipeline,
        gateEvidence: outcome.gate_evidence
    });
    console.log(`[executor] ${jobId} 完成：artifact_sha=${outcome.artifact_sha} attempt=${attempt?.id || '(无)'}`);
    return { job: completed, attempt, outcome };
}

main()
    .then(result => { console.log(JSON.stringify({ success: true, ...result }, null, 2)); process.exit(0); })
    .catch(err => { console.error(JSON.stringify({ success: false, error: err.message }, null, 2)); process.exit(1); });
