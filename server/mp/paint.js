'use strict';

// ---------- Paint 客户端：向 L20（gsy013）Forge3D 推送 paint-only 任务并轮询 ----------
// 只访问集群内网 API；非回环来源要求 X-Forge3D-Token（部署环境变量 FORGE3D_API_TOKEN）。

const fs = require('fs');
const { recordPush } = require('./artifacts');

function config() {
    return {
        baseUrl: (process.env.MP_PAINT_API_URL || '').replace(/\/$/, ''),
        token: process.env.MP_PAINT_TOKEN || ''
    };
}

function headers(extra = {}) {
    const out = { ...extra };
    if (config().token) out['X-Forge3D-Token'] = config().token;
    return out;
}

function isConfigured() {
    return Boolean(config().baseUrl);
}

// 上传 mesh → 创建 paint-only 远端任务，返回 { jobId, statusUrl }
async function submitPaint({ parentId, taskId, meshPath, materialPath, params }) {
    const cfg = config();
    if (!cfg.baseUrl) throw new Error('MP_PAINT_API_URL 未配置');
    const form = new FormData();
    const meshBuffer = fs.readFileSync(meshPath);
    form.append('mesh', new Blob([meshBuffer]), `mesh-${taskId.toLowerCase()}.glb`);
    if (materialPath && fs.existsSync(materialPath)) {
        const materialBuffer = fs.readFileSync(materialPath);
        form.append('material_source', new Blob([materialBuffer]), `material-${taskId.toLowerCase()}.png`);
    }
    form.append('asset_name', `mp-${parentId.toLowerCase()}-${taskId.toLowerCase()}`);
    form.append('asset_kind', params.assetKind);
    form.append('profile', params.profile);
    form.append('prompt', String(params.prompt || '').slice(0, 1500));
    form.append('seed', String(params.seed ?? 1234));
    form.append('skill_plan', JSON.stringify(params.skillPlan || {}));
    form.append('stop_after', 'generate_material');

    recordPush({ parentId, taskId, fileName: `mesh-${taskId}.glb`, toHost: 'gsy013-l20', bytes: meshBuffer.length, sha256: require('./store').sha256Hex(meshBuffer), note: 'paint push' });

    const response = await fetch(`${cfg.baseUrl}/v1/stages/paint`, {
        method: 'POST',
        headers: headers(),
        body: form,
        signal: AbortSignal.timeout(120000)
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { throw new Error('Paint 服务返回了无法解析的内容'); }
    if (!response.ok) throw new Error(`Paint 创建失败 HTTP ${response.status}: ${data.detail || data.error || text.slice(0, 300)}`);
    const jobId = data.job_id || data.jobId;
    if (!jobId) throw new Error('Paint 服务没有返回任务编号');
    return { jobId };
}

// 轮询远端任务；state ∈ review/completed/approved → 取输出；failed → 抛错
async function pollPaint(jobId) {
    const cfg = config();
    const response = await fetch(`${cfg.baseUrl}/v1/jobs/${encodeURIComponent(jobId)}`, {
        headers: headers(),
        signal: AbortSignal.timeout(30000)
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { throw new Error('Paint 轮询返回了无法解析的内容'); }
    if (!response.ok) throw new Error(`Paint 轮询失败 HTTP ${response.status}`);
    const state = String(data.state || data.status || '').toLowerCase();
    if (['failed', 'error'].includes(state)) throw new Error(data.error || '远端 Paint 任务失败');
    if (['review', 'completed', 'approved'].includes(state)) {
        const outputKey = ['pbr_mesh', 'generated_mesh', 'game_asset'].find(k => data.outputs?.[k]);
        if (!outputKey) throw new Error('远端 Paint 完成但没有输出产物');
        return {
            done: true,
            state,
            outputKey,
            downloadUrl: `${cfg.baseUrl}/v1/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(outputKey)}`,
            stages: data.stages || [],
            metrics: data.metrics || {}
        };
    }
    const runningStage = [...(data.stages || [])].reverse().find(s => s.state === 'running');
    return { done: false, state, currentStage: runningStage?.name || state, stages: data.stages || [] };
}

// 下载远端产物到本地任务目录（临时文件 → 校验 → 原子改名），返回 { fileName, bytes, sha256 }
async function downloadRemoteArtifact(url, targetPath, maxBytes = 300 * 1024 * 1024) {
    const response = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`远端产物下载失败 HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > maxBytes) throw new Error('远端产物超过大小限制');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error('远端产物超过大小限制');
    const crypto = require('crypto');
    const sha = crypto.createHash('sha256').update(buffer).digest('hex');
    const fs = require('fs');
    const tmp = `${targetPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, targetPath);
    return { bytes: buffer.length, sha256: sha };
}

module.exports = { config, isConfigured, submitPaint, pollPaint, downloadRemoteArtifact };
