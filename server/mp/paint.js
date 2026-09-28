'use strict';

// ---------- Paint 客户端：SSH 命令适配器 + SCP 产物传输 ----------
// 集群内网到 gsy013:8091 的 pod 网络不通（TCP 被拒），但 mygpu→gsy013:22 SSH 可达。
// 因此 Paint 走：scp 上传选中候选 mesh → ssh 本地 curl 提交 paint-only 任务 →
//            ssh 轮询 /v1/jobs/{id} → scp 拉回 textured.glb（控制面校验 SHA-256）。
// 不开放 Redis/Forge3D 公网端口；gsy013 侧 8091 仍只监听其 pod 内 127.0.0.1（回环）。

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { recordPush } = require('./artifacts');

function gsy013Cfg() {
    const host = process.env.MP_GSY013_SSH_HOST || '192.168.88.122';
    const port = String(process.env.MP_GSY013_SSH_PORT || '30660');
    const user = process.env.MP_GSY013_SSH_USER || 'root';
    const apiUrl = process.env.MP_GSY013_API_URL || 'http://127.0.0.1:8091';
    const token = process.env.MP_PAINT_TOKEN || '';
    return { host, port, user, apiUrl, token };
}

function isConfigured() {
    return Boolean(process.env.MP_GSY013_SSH_HOST);
}

function sshArgs() {
    const cfg = gsy013Cfg();
    return ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=yes',
            '-p', cfg.port, `${cfg.user}@${cfg.host}`];
}

function scpArgs() {
    const cfg = gsy013Cfg();
    // 只返回选项；调用方自行追加 [源, 目标] 两个位置参数。
    // 切勿在此带上 user@host 或其它尾部 token：会被 scp 当成多余的源文件，
    // 产生 "Not a directory" / "No such file or directory"。
    return ['scp', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=yes',
            '-P', cfg.port];
}

function runCmd(cmd, args, { timeoutMs = 120000, maxOutput = 4 * 1024 * 1024 } = {}) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout: timeoutMs, maxBuffer: maxOutput }, (error, stdout, stderr) => {
            if (error) {
                const message = `${error.message}${stderr ? `: ${String(stderr).slice(0, 500)}` : ''}`;
                return reject(new Error(message));
            }
            resolve(stdout);
        });
    });
}

// 远端执行单条命令并返回 stdout
async function remoteExec(command) {
    return runCmd(sshArgs()[0], [...sshArgs().slice(1), command], { timeoutMs: 180000 });
}

// 提交 paint-only 远端任务（mesh 先 scp 到 gsy013 临时目录，再本地 curl）
async function submitPaint({ parentId, taskId, meshPath, materialPath, params }) {
    const cfg = gsy013Cfg();
    if (!cfg.host) throw new Error('MP_GSY013_SSH_HOST 未配置');
    const remoteDir = `/tmp/mp-paint-${taskId.toLowerCase()}`;
    const meshName = path.basename(meshPath);
    await remoteExec(`mkdir -p '${remoteDir}'`);
    await runCmd(scpArgs()[0], [...scpArgs().slice(1), meshPath, `${cfg.user}@${cfg.host}:${remoteDir}/${meshName}`]);
    let materialArg = '';
    if (materialPath && fs.existsSync(materialPath)) {
        const matName = path.basename(materialPath);
        await runCmd(scpArgs()[0], [...scpArgs().slice(1), materialPath, `${cfg.user}@${cfg.host}:${remoteDir}/${matName}`]);
        materialArg = ` -F material_source=@${remoteDir}/${matName}`;
    }
    const curl = [
        'curl', '-sS', '-X', 'POST', `${cfg.apiUrl}/v1/stages/paint`,
        '-F', `mesh=@${remoteDir}/${meshName}`,
        '-F', `asset_name=mp-${parentId.toLowerCase()}-${taskId.toLowerCase()}`,
        '-F', `asset_kind=${params.assetKind}`,
        '-F', `profile=${params.profile}`,
        '-F', `prompt=${String(params.prompt || '').slice(0, 1500)}`,
        '-F', `seed=${params.seed ?? 1234}`,
        ...(cfg.token ? [`-H`, `'X-Forge3D-Token: ${cfg.token}'`] : [])
    ].join(' ');
    const full = `${curl}${materialArg}`;
    const stdout = await remoteExec(full);
    let data;
    try { data = JSON.parse(stdout); } catch { throw new Error(`Paint 创建失败（远端返回非 JSON）: ${String(stdout).slice(0, 300)}`); }
    if (!data.job_id) throw new Error(`Paint 创建失败: ${JSON.stringify(data).slice(0, 300)}`);
    const meshBuffer = fs.readFileSync(meshPath);
    recordPush({
        parentId, taskId,
        fileName: `mesh-${taskId}.glb`,
        toHost: `gsy013-l20(${cfg.host}:${cfg.port})`,
        bytes: meshBuffer.length,
        sha256: crypto.createHash('sha256').update(meshBuffer).digest('hex'),
        note: 'paint push via scp'
    });
    return { jobId: data.job_id };
}

// 轮询远端任务；state ∈ completed/approved → 取输出路径；failed → 抛错
async function pollPaint(jobId) {
    const cfg = gsy013Cfg();
    const stdout = await remoteExec(`curl -sS ${cfg.apiUrl}/v1/jobs/${jobId}`);
    let data;
    try { data = JSON.parse(stdout); } catch { throw new Error('Paint 轮询返回了无法解析的内容'); }
    const state = String(data.state || data.status || '').toLowerCase();
    if (['failed', 'error'].includes(state)) {
        // 远端任务已确定失败：返回 done+failed，由调度器决定重试（会清除 remoteJobId 重新提交）
        return { done: true, state, error: data.error || '远端 Paint 任务失败' };
    }
    if (['review', 'completed', 'approved'].includes(state)) {
        const outputKey = ['pbr_mesh', 'generated_mesh', 'game_asset'].find(k => data.outputs?.[k]);
        if (!outputKey) throw new Error('远端 Paint 完成但没有输出产物');
        return { done: true, state, outputKey, outputPath: data.outputs[outputKey], stages: data.stages || [], metrics: data.metrics || {} };
    }
    const runningStage = [...(data.stages || [])].reverse().find(s => s.state === 'running');
    return { done: false, state, currentStage: runningStage?.name || state, stages: data.stages || [] };
}

// scp 拉回远端产物（临时文件 → 大小/SHA 校验 → 原子改名）
async function downloadRemoteArtifact(remotePath, targetPath, maxBytes = 300 * 1024 * 1024) {
    const cfg = gsy013Cfg();
    const tmpLocal = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    const tmpRemote = path.join(os.tmpdir() === '' ? '/tmp' : '/tmp', `mp-dl-${crypto.randomBytes(6).toString('hex')}`);
    // 先复制到远端 /tmp 再 scp，避免路径中有特殊字符时 scp 解析歧义
    await remoteExec(`cp '${String(remotePath).replace(/'/g, "'\\''")}' ${tmpRemote}`);
    await runCmd(scpArgs()[0], [...scpArgs().slice(1), `${cfg.user}@${cfg.host}:${tmpRemote}`, tmpLocal], { timeoutMs: 300000 });
    await remoteExec(`rm -f ${tmpRemote}`);
    const stat = fs.statSync(tmpLocal);
    if (stat.size > maxBytes) { fs.unlinkSync(tmpLocal); throw new Error('远端产物超过大小限制'); }
    const sha = crypto.createHash('sha256').update(fs.readFileSync(tmpLocal)).digest('hex');
    fs.renameSync(tmpLocal, targetPath);
    return { bytes: stat.size, sha256: sha };
}

module.exports = { config: gsy013Cfg, isConfigured, submitPaint, pollPaint, downloadRemoteArtifact };
