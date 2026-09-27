// ForgeLoop v2 —— 受限自动修复的真实执行器
//
// 职责：把子 Attempt 的修复计划翻译成对"已登记 GPU 工位脚本"的真实调用，回填产物 SHA 与门禁证据。
//  - animation：通过 SSH 调用 gsy013 上的 Blender 运行 deploy/forge3d/blender/ 下已登记的脚本
//    （retarget_hy.py 重定向、analyze_clipping.py 穿模门禁），与本机 code 同源的脚本必须已部署并核验 SHA。
//  - audio：通过 SSH 调用工厂（mygpu）tools/gpu-audio/audio_factory.py 的 postprocess 子命令
//    （增益/截取起点后处理），产出独立新任务目录，不覆盖原产物。
//  - model：沿用 model-worker 的 Forge3D API 流水线（本模块只负责动画/音频两个新执行器）。
//
// 幂等：以 job_id + artifact_sha 为锚点 —— 已产出产物则跳过执行，绝不为同一 job_id 重复提交 GPU 任务。
// 安全：执行器只写独立产物目录；绝不覆盖父产物、原 manifest 或正式资产。

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const BLENDER_PATH = '/workspace/.tools/blender-4.5.13-linux-x64/blender';
const FORGE3D_ROOT = '/workspace/projects/forge3d';
const FACTORY_ROOT = '/workspace/projects/3d-modeling-studio';

function sha256File(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
}

// 可注入传输层（测试用 fake；生产用 ssh）
function sshTransport(host) {
    return (remoteCmd, opts = {}) => {
        const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host, remoteCmd];
        const res = spawnSync('ssh', args, { encoding: 'utf8', timeout: (opts.timeoutMs || 15 * 60) * 1000, maxBuffer: 64 * 1024 * 1024 });
        if (res.error) throw new Error(`SSH ${host} 失败: ${res.error.message}`);
        return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
    };
}

// ---------- 动画：构建 gsy013 Blender 重定向命令（纯函数，可测） ----------
// retarget_hy.py 参数：--input 目标角色 GLB --fbx 源动作 FBX --alias 动作别名 --output 输出 GLB
function buildRetargetCommand({ targetGlb, fbxPath, alias, outGlb }) {
    if (!targetGlb || !fbxPath || !alias || !outGlb) throw new Error('重定向参数不完整：需要 targetGlb/fbxPath/alias/outGlb');
    const script = path.posix.join(FORGE3D_ROOT, 'blender', 'retarget_hy.py');
    const cmd = [
        `cd ${FORGE3D_ROOT}`,
        `${BLENDER_PATH} --background --python ${script} --`,
        `--input ${targetGlb} --fbx ${fbxPath} --alias ${alias} --output ${outGlb}`
    ].join(' && ');
    return { host: 'gsy013', command: cmd, script, kind: 'animation.retarget_plan' };
}

// ---------- 动画：构建穿模/变形门禁复测命令 ----------
function buildClippingGateCommand({ glbPath, action, sceneGlb }) {
    if (!glbPath) throw new Error('穿模门禁缺少 GLB 路径');
    const script = path.posix.join(FORGE3D_ROOT, 'blender', 'analyze_clipping.py');
    let extra = `--action ${action}`;
    if (sceneGlb) extra += ` --scene-glb ${sceneGlb}`;
    const cmd = [
        `cd ${FORGE3D_ROOT}`,
        `${BLENDER_PATH} --background --python ${script} -- --glb ${glbPath} ${extra} --report /tmp/clip-report-${path.basename(glbPath)}.json`
    ].join(' && ');
    return { host: 'gsy013', command: cmd, script, kind: 'clipping_gate' };
}

// ---------- 音频：构建工厂 postprocess 命令（gain / trim_start_s） ----------
function buildAudioRepairCommand({ eventJobDir, eventId, projectId, gain, trimStartS, outRoot }) {
    if (!eventJobDir || !eventId || !projectId) throw new Error('音频修复参数不完整：需要 eventJobDir/eventId/projectId');
    const script = path.posix.join(FACTORY_ROOT, 'tools/gpu-audio/audio_factory.py');
    const flags = [];
    if (gain !== undefined && gain !== null) flags.push(`--gain ${gain}`);
    if (trimStartS !== undefined && trimStartS !== null) flags.push(`--trim-start-s ${trimStartS}`);
    if (!flags.length) throw new Error('音频修复至少需要 gain 或 trim_start_s 之一');
    const cmd = [
        `cd ${FACTORY_ROOT}`,
        `python3 ${script} postprocess --event-dir ${eventJobDir} --project ${projectId} --event ${eventId} ${flags.join(' ')} ${outRoot ? `--out-root ${outRoot}` : ''}`
    ].join(' && ');
    return { host: 'mygpu', command: cmd, script, kind: 'audio_postprocess' };
}

// 解析 analyze_clipping.py 的报告 JSON（兼容 stdout 输出与 --report 文件）
function parseClippingReport(stdout, stderr, reportPath) {
    let raw = stdout || stderr || '';
    if (reportPath && fs.existsSync(reportPath)) raw = fs.readFileSync(reportPath, 'utf8');
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`无法解析穿模门禁输出：${raw.slice(0, 500)}`);
    const report = JSON.parse(m[0]);
    const status = report.status || report.clipping_review || 'unknown';
    return {
        quality_gates: {
            clipping_review: status,
            ...(report.detail ? { clipping_detail: report.detail } : {})
        },
        clipping: report.clipping || {},
        metrics: {
            triangles: report.mesh?.triangles ?? undefined,
            vertices: report.mesh?.vertices ?? undefined,
            actions: report.actions ?? undefined,
            quality_gates: { clipping_review: status }
        },
        raw: raw.slice(0, 4000)
    };
}

// 执行一个已构建的远端命令并返回 { exitCode, stdout, stderr }
function runRemote(built, transport) {
    const t = transport || sshTransport(built.host);
    const res = t(built.command, {});
    return { exitCode: res.code ?? -1, stdout: res.stdout, stderr: res.stderr, host: built.host, command: built.command, script: built.script, kind: built.kind };
}

module.exports = {
    sshTransport,
    buildRetargetCommand,
    buildClippingGateCommand,
    buildAudioRepairCommand,
    parseClippingReport,
    runRemote,
    sha256File,
    BLENDER_PATH,
    FORGE3D_ROOT,
    FACTORY_ROOT
};
