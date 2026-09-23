const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { atomicFile } = require('./factory-build');

const root = path.resolve(__dirname, '..');
const events = [
    { id: 'collect', duration: 0.8, description: 'a clean short collectible pickup shimmer, one-shot, gentle bright attack and quick decay' },
    { id: 'danger', duration: 1.2, description: 'a short danger impact warning, one-shot, tense low hit and dry tail' },
    { id: 'win', duration: 2.4, description: 'a concise level-complete success flourish, one-shot, warm rising chime and resolved ending' }
];
function fileDigest(filename) { return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex'); }

function gpuSfxEnabled(env = process.env) {
    return /^(1|true|yes)$/i.test(String(env.FACTORY_GPU_SFX || ''));
}

function projectAudioId(projectId) {
    return `factory-${crypto.createHash('sha256').update(String(projectId)).digest('hex').slice(0, 20)}`;
}

function buildSfxRequests(project, spec) {
    const mood = String(spec.audio?.mood || 'restrained atmospheric exploration').replace(/[\r\n\t]+/g, ' ').slice(0, 300);
    return events.map((event, index) => ({
        id: event.id,
        request: {
            project_id: projectAudioId(project.id), event_id: event.id, backend: 'sfx',
            prompt: `${event.description}. Mood and world context: ${mood}. Dry foreground game sound, no music, no speech, no ambience, no reverb.`,
            duration: event.duration, variants: 1, seed: 92301 + index, loop: false
        }
    }));
}

function inside(parent, child) {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function validateGeneratedItem(item, outputRoot) {
    const manifest = item.manifest;
    if (manifest?.status !== 'review' || manifest.review !== 'pending') throw new Error(`${item.id} GPU 音效未进入待审核状态`);
    if (manifest.device !== 'cuda:0' || !Array.isArray(manifest.outputs) || !manifest.outputs.length) throw new Error(`${item.id} 缺少 CUDA 生成证据或音频产物`);
    const manifestPath = path.resolve(item.manifestPath || manifest.manifest || '');
    if (!inside(outputRoot, manifestPath)) throw new Error(`${item.id} 音频清单不在受控产物目录`);
    const output = manifest.outputs[0], source = path.resolve(path.dirname(manifestPath), output.file || '');
    if (!inside(path.dirname(manifestPath), source) || !fs.existsSync(source)) throw new Error(`${item.id} 音频产物路径无效`);
    const bytes = fs.readFileSync(source);
    if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${item.id} 不是有效 WAV 音频`);
    if (!/^[a-f0-9]{64}$/.test(output.sha256 || '') || fileDigest(source) !== output.sha256) throw new Error(`${item.id} 音频哈希校验失败`);
    if (!(Number(output.duration) > 0) || !(Number(output.sample_rate) > 0) || !(Number(output.source_rms) > 0)) throw new Error(`${item.id} 音频技术检查未通过`);
    return { manifestPath, source, output };
}

function installGeneratedSfx(dir, items, outputRoot) {
    const expected = events.map(event => event.id);
    if (items.length !== expected.length || items.some((item, index) => item.id !== expected[index])) throw new Error('GPU 音效事件不完整');
    const validated = items.map(item => ({ item, ...validateGeneratedItem(item, outputRoot) }));
    const temporary = [];
    try {
        for (const { item, source } of validated) {
            const target = path.join(dir, 'assets', `${item.id}.wav`), temp = `${target}.tmp`;
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(source, temp);
            temporary.push({ temp, target });
        }
        for (const file of temporary) fs.renameSync(file.temp, file.target);
    } catch (error) {
        for (const file of temporary) { try { fs.unlinkSync(file.temp); } catch {} }
        throw error;
    }
    return validated.map(({ item, manifestPath, output }) => ({
        event_id: item.id, file: `assets/${item.id}.wav`, job_id: item.manifest.job_id,
        model: item.manifest.model, model_revision: item.manifest.model_revision || null,
        backend_version: item.manifest.backend_version || null,
        manifest_sha256: fileDigest(manifestPath), content_sha256: output.sha256,
        sample_rate: output.sample_rate, channels: output.channels, duration: output.duration,
        source_peak: output.source_peak, source_rms: output.source_rms,
        generation_status: 'generated', technical_status: 'passed', review_status: 'pending'
    }));
}

function runFactory(args, options) {
    return new Promise((resolve, reject) => {
        execFile(options.python, args, { timeout: options.timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) return reject(new Error(`GPU 音效生成失败：${String(stderr || error.message).trim().slice(-600)}`));
            try {
                const line = String(stdout).trim().split(/\r?\n/).filter(Boolean).at(-1);
                resolve(JSON.parse(line));
            } catch { reject(new Error('GPU 音效工位未返回有效清单')); }
        });
    });
}

async function generateGpuSfx(project, spec, dir, signal) {
    const outputRoot = path.resolve(process.env.FACTORY_GPU_AUDIO_ROOT || '/workspace/3d-assets/game-audio');
    const requestRoot = path.resolve(process.env.FACTORY_GPU_AUDIO_REQUEST_DIR || path.join(path.dirname(process.env.DB_PATH || path.join(root, 'data', 'db.json')), 'gpu-audio-requests'));
    const python = process.env.FACTORY_GPU_AUDIO_PYTHON || 'python3';
    const script = path.resolve(process.env.FACTORY_GPU_AUDIO_SCRIPT || path.join(root, 'tools', 'gpu-audio', 'audio_factory.py'));
    const gpu = String(Math.max(0, Math.min(7, Number.parseInt(process.env.FACTORY_GPU_AUDIO_GPU || '1', 10) || 0)));
    const timeout = Math.max(330000, Math.min(1830000, Number.parseInt(process.env.FACTORY_GPU_AUDIO_TIMEOUT_MS || '330000', 10) || 330000));
    fs.mkdirSync(requestRoot, { recursive: true });
    const generated = [];
    for (const item of buildSfxRequests(project, spec)) {
        if (signal?.aborted) throw new Error('任务已取消');
        const requestFile = path.join(requestRoot, `${projectAudioId(project.id)}-${item.id}-${crypto.randomUUID()}.json`);
        try {
            atomicFile(requestFile, JSON.stringify(item.request, null, 2));
            const manifest = await runFactory([script, 'generate', '--request', requestFile, '--output-root', outputRoot, '--gpu', gpu], { python, timeout });
            generated.push({ id: item.id, manifest, manifestPath: manifest.manifest });
        } finally { try { fs.unlinkSync(requestFile); } catch {} }
    }
    if (signal?.aborted) throw new Error('任务已取消');
    const installed = installGeneratedSfx(dir, generated, outputRoot);
    return {
        mode: 'gpu-sfx', generation_status: 'generated', technical_status: 'passed', review_status: 'pending',
        effects: installed, music: { file: 'assets/music.wav', source: 'procedural', review_status: 'pending' }
    };
}

module.exports = { gpuSfxEnabled, buildSfxRequests, installGeneratedSfx, generateGpuSfx };
