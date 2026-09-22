const fs = require('fs');
const path = require('path');
const { configDb, jobDb, modelDb, uploadDir, modelDir } = require('./db');
const { createReferenceBoard } = require('./image-board');
const { validateGlbBuffer } = require('./utils');
const { enqueueJobNotifications } = require('./notifier');
const { compileSkillPlan, SkillPlanError } = require('./skill-plan');

const MAX_MODEL_BYTES = 300 * 1024 * 1024;
const FORGE_READY_STATES = new Set(['review', 'completed', 'approved', 'succeeded', 'success']);
const FORGE_FAILED_STATES = new Set(['failed', 'error', 'cancelled', 'canceled']);

class PermanentJobError extends Error {}

function getProviderConfig() {
    const stored = configDb.get();
    return {
        provider: process.env.SPU_PROVIDER || stored.provider || 'forge3d',
        apiUrl: process.env.SPU_API_URL || stored.api_url || '',
        apiKey: process.env.SPU_API_KEY || stored.api_key || ''
    };
}

function authHeaders(config) {
    return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
}

async function parseProviderResponse(response) {
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { throw new Error('建模服务返回了无法解析的内容'); }
    if (!response.ok) {
        const message = data.detail ? JSON.stringify(data.detail) : data.error || data.message || `HTTP ${response.status}`;
        if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) throw new PermanentJobError(`建模服务拒绝请求：${message}`);
        throw new Error(`建模服务暂时不可用：${message}`);
    }
    return data;
}

async function submitJob(job, config) {
    let plan = job.execution_plan;
    if (!plan) {
        jobDb.update(job.id, { progress_message: '正在解析个人 Skill 与建模要求' });
        plan = await compileSkillPlan(job);
        jobDb.update(job.id, { execution_plan: plan });
    }
    const imagePaths = job.input.images.map(filename => path.join(uploadDir, path.basename(filename)));
    const boardPath = path.join(uploadDir, `reference-${job.id}.png`);
    // 单图生成器使用第一张作主参考，拼板仅保留为辅助证据，避免重复主体。
    await createReferenceBoard(imagePaths, boardPath);
    const sourcePath = imagePaths[0];
    const form = new FormData();
    const sourceBuffer = fs.readFileSync(sourcePath);
    const sourceName = path.basename(sourcePath);
    form.append('source', new Blob([sourceBuffer]), sourceName);
    form.append('asset_name', `studio-${job.id.toLowerCase()}`);
    form.append('asset_kind', job.input.asset_kind);
    form.append('profile', job.input.profile);
    form.append('prompt', `Skill 执行计划 ${plan.sha256}\n${JSON.stringify(plan.generation)}\n${job.input.prompt}\n待验收：${plan.review_requirements.join('；')}`.slice(0, 2000));
    form.append('seed', String(job.input.seed ?? 1234));
    form.append('skill_plan', JSON.stringify(plan));

    const response = await fetch(config.apiUrl, {
        method: 'POST',
        headers: authHeaders(config),
        body: form,
        signal: AbortSignal.timeout(120000)
    });
    const result = await parseProviderResponse(response);

    if (result.model_url) {
        if (result.provenance?.skill_plan_sha256 !== plan.sha256) throw new PermanentJobError('GPU 服务未确认执行 Skill 参数，请更新建模服务');
        jobDb.update(job.id, { status: 'downloading', progress_message: '正在保存模型文件' });
        await finishWithRemoteModel(job, result.model_url, result);
        return;
    }

    const taskId = result.job_id || result.task_id || result.id;
    if (!taskId) throw new PermanentJobError('建模服务没有返回任务编号或模型地址');
    const statusUrl = result.status_url || `${config.apiUrl.replace(/\/$/, '')}/${encodeURIComponent(taskId)}`;
    jobDb.update(job.id, {
        status: 'generating',
        progress_message: 'GPU 已接收，正在生成模型',
        provider: { name: config.provider, task_id: String(taskId), status_url: statusUrl },
        next_poll_at: new Date(Date.now() + 5000).toISOString()
    });
    if (result.provenance?.skill_plan_sha256 !== plan.sha256) throw new PermanentJobError('GPU 服务未确认执行 Skill 参数，请更新建模服务');
}

function findOutput(result) {
    return result.model_url || result.output?.model_url || result.outputs?.game_asset || result.outputs?.glb || result.outputs?.model;
}

function progressFromResult(result) {
    const runningStage = [...(result.stages || [])].reverse().find(stage => stage.state === 'running');
    const names = {
        prepare: '正在准备参考图',
        generate_mesh: '正在生成模型形体',
        generate_material: '正在生成 PBR 材质',
        normalize_mesh: '正在整理模型结构',
        render_preview: '正在生成预览',
        validate: '正在进行质量检查',
        shape: '正在生成模型形体',
        texture: '正在生成 PBR 材质',
        normalize: '正在整理模型结构',
        rig: '正在生成骨骼',
        animation: '正在处理动作',
        export: '正在导出 GLB',
        preview: '正在生成预览',
        quality: '正在进行质量检查'
    };
    if (String(result.state || result.status).toLowerCase() === 'queued') return 'GPU 排队中，等待空闲资源';
    return names[runningStage?.name] || 'GPU 正在生成模型';
}

function providerQuality(result = {}) {
    const state = String(result.state || result.status || '').toLowerCase();
    return {
        review_required: state !== 'approved',
        provider_state: state || 'unknown',
        quality_gates: result.quality_gates || {},
        metrics: result.metrics || {}
    };
}

async function pollProviderJob(job, config) {
    const response = await fetch(job.provider.status_url, {
        headers: authHeaders(config),
        signal: AbortSignal.timeout(30000)
    });
    const result = await parseProviderResponse(response);
    const state = String(result.state || result.status || '').toLowerCase();
    if (FORGE_FAILED_STATES.has(state)) throw new PermanentJobError(result.error || '远端建模任务失败');
    const output = findOutput(result);
    if (FORGE_READY_STATES.has(state) && output) {
        jobDb.update(job.id, { status: 'downloading', progress_message: '正在保存模型文件' });
        await finishWithRemoteModel(job, output, result);
        return;
    }
    jobDb.update(job.id, {
        status: 'generating',
        progress_message: progressFromResult(result),
        next_poll_at: new Date(Date.now() + 5000).toISOString()
    });
}

async function readModelSource(source) {
    if (typeof source !== 'string' || !source) throw new PermanentJobError('建模服务没有提供模型文件');
    if (path.isAbsolute(source)) {
        const allowedRoot = path.resolve(process.env.FORGE3D_ASSET_ROOT || '/workspace/3d-assets');
        const resolved = path.resolve(source);
        if (process.platform !== 'win32' && resolved !== allowedRoot && !resolved.startsWith(`${allowedRoot}${path.sep}`)) throw new PermanentJobError('模型文件不在允许的资产目录中');
        const stat = fs.statSync(resolved);
        if (stat.size > MAX_MODEL_BYTES) throw new PermanentJobError('模型文件超过 300 MB 限制');
        return fs.readFileSync(resolved);
    }
    const url = new URL(source);
    if (!['http:', 'https:'].includes(url.protocol)) throw new PermanentJobError('模型地址协议不受支持');
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`模型下载失败：HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_MODEL_BYTES) throw new PermanentJobError('模型文件超过 300 MB 限制');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_MODEL_BYTES) throw new PermanentJobError('模型文件超过 300 MB 限制');
    return buffer;
}

async function finishWithRemoteModel(job, source, result = {}) {
    const buffer = await readModelSource(source);
    jobDb.update(job.id, { status: 'validating', progress_message: '正在校验 GLB 文件' });
    const validation = validateGlbBuffer(buffer);
    const quality = providerQuality(result);
    const fileName = `model-${job.id}-${Date.now()}.glb`;
    fs.writeFileSync(path.join(modelDir, fileName), buffer);
    const model = modelDb.create({
        name: job.name,
        original_images: job.input.images.map(filename => `/uploads/${path.basename(filename)}`),
        prompt: job.input.prompt,
        skill_snapshot: job.skill_snapshot,
        job_id: job.id,
        status: 'completed',
        model_file: `/models/${fileName}`,
        file_size: validation.length,
        sha256: validation.sha256
    });
    modelDb.update(model.id, { quality });
    const completed = jobDb.update(job.id, {
        status: 'succeeded',
        progress_message: quality.review_required ? '模型已生成，文件校验通过；建模效果待验收' : '模型已生成，文件校验与效果验收通过',
        output: { model_id: model.id, model_file: model.model_file, file_size: validation.length, sha256: validation.sha256, validated: true, quality },
        completed_at: new Date().toISOString(),
        error: null
    });
    enqueueJobNotifications(completed, 'model.succeeded');
}

function failOrRetry(job, error) {
    const permanent = error instanceof PermanentJobError || error instanceof SkillPlanError;
    const exhausted = permanent || job.attempt >= job.max_attempts;
    const errorData = { code: permanent ? 'invalid_request' : 'provider_error', message: error.message };
    if (exhausted) {
        const failed = jobDb.update(job.id, {
            status: 'failed',
            progress_message: '建模失败',
            error: errorData,
            completed_at: new Date().toISOString()
        });
        enqueueJobNotifications(failed, 'model.failed');
        return;
    }
    jobDb.update(job.id, {
        status: 'retry_wait',
        progress_message: `暂时失败，准备第 ${job.attempt + 1} 次尝试`,
        next_run_at: new Date(Date.now() + Math.min(600000, 30000 * (2 ** Math.max(0, job.attempt - 1)))).toISOString(),
        error: errorData
    });
}

function startModelWorker() {
    const recovered = jobDb.recoverInterrupted();
    if (recovered) console.log(`[任务恢复] ${recovered} 个建模任务已重新入队`);
    let running = false;

    async function tick() {
        if (running) return;
        const config = getProviderConfig();
        if (!config.apiUrl) return;
        const duePoll = jobDb.list(100)
            .filter(job => job.status === 'generating' && job.provider?.task_id)
            .filter(job => !job.next_poll_at || new Date(job.next_poll_at) <= new Date())
            .sort((a, b) => new Date(a.updated_at) - new Date(b.updated_at))[0];
        const job = duePoll || jobDb.claimNext();
        if (!job) return;
        running = true;
        try {
            if (job.provider?.task_id) await pollProviderJob(job, config);
            else await submitJob(job, config);
        } catch (error) {
            console.error(`[建模任务 ${job.id}] ${error.message}`);
            failOrRetry(jobDb.findById(job.id) || job, error);
        } finally {
            running = false;
        }
    }

    const timer = setInterval(tick, 2000);
    timer.unref();
    tick();
    return { wake: tick, stop: () => clearInterval(timer) };
}

module.exports = { getProviderConfig, findOutput, progressFromResult, providerQuality, startModelWorker, PermanentJobError };
