const express = require('express');
const multer = require('multer');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { studioDb, modelDb, jobDb, factoryDb, dbPath, modelDir, uploadDir, resourceDb } = require('./db');
const { requireUser, requireModelUser } = require('./auth');
const { detectImageType, validateGlbBuffer } = require('./utils');
const { getProviderConfig } = require('./model-worker');
const { runDir } = require('./factory-worker');
const { stageRunDir } = require('./stage-worker');
const { makePlan, plannerConfig } = require('./studio-planner');

const assetRoot = path.join(path.dirname(dbPath), 'resource-studio');
const now = () => new Date().toISOString();
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const kinds = { '.png': '2d', '.jpg': '2d', '.webp': '2d', '.svg': '2d', '.glb': '3d', '.wav': 'sfx', '.mp3': 'sfx', '.ogg': 'sfx' };

function resources(ownerId) {
    const result = studioDb.list('assets', ownerId).map(item => ({ ...item, file: path.join(assetRoot, item.filename) }));
    const jobs = new Map(jobDb.listAll().map(job => [job.id, job]));
    for (const model of modelDb.list()) {
        const job = jobs.get(model.job_id);
        if (job?.owner_id !== ownerId || !model.model_file) continue;
        result.push({ id: `model-${model.id}`, name: model.name, kind: '3d', file: path.join(modelDir, path.basename(model.model_file)), reference: model.original_image ? path.join(uploadDir, path.basename(model.original_image)) : null, source: 'GPU · Forge3D', review: 'pending', created_at: model.created_at, bytes: model.file_size, sha256: model.sha256 });
    }
    for (const project of factoryDb.list(ownerId)) {
        for (const run of project.runs) {
            for (const name of ['player.svg', 'npc.svg', 'item.svg', 'collect.wav', 'danger.wav', 'win.wav', 'music.wav']) {
                const file = path.join(runDir(project, run), 'assets', name);
                if (!fs.existsSync(file)) continue;
                const kind = kinds[path.extname(name)], gpu = kind === 'sfx' && name !== 'music.wav' && run.audio?.mode === 'gpu-sfx';
                result.push({ id: `${project.id}-${run.id}-${name}`, name: `${project.name} / ${name}`, kind, file, source: gpu ? 'GPU · MOSS' : kind === '2d' ? '矢量素材' : '程序音频', review: run.review?.status || 'pending', created_at: run.created_at, bytes: fs.statSync(file).size });
            }
        }
        for (const run of project.stage_runs || []) {
            for (const artifact of run.artifacts || []) {
                if (!/^previews\/[a-zA-Z0-9-]+\.(png|jpg|webp)$/.test(artifact.path)) continue;
                result.push({ id: `${project.id}-${run.id}-${path.basename(artifact.path)}`, name: `${project.name} / 预览图`, kind: '2d', file: path.join(stageRunDir(project, run), artifact.path), source: '上传图片', review: run.review?.status || 'pending', created_at: run.created_at, bytes: artifact.bytes });
            }
        }
    }
    // 共享资产库（GPU/本机扫描入库、云上传）：跨账号可见的同一份资产清单
    const resourceDir = path.join(path.dirname(dbPath), 'resources');
    const kindMap = { model: '3d', reference: '2d', image: '2d', texture: '2d', audio: 'sfx', archive: '2d', other: '2d' };
    for (const r of resourceDb.list()) {
        const kind = kindMap[r.kind];
        if (!kind) continue;
        let file;
        if (r.source === 'upload' && r.file_path) file = path.join(resourceDir, path.basename(r.file_path));
        else if (r.file_path && path.isAbsolute(r.file_path)) file = r.file_path;
        else continue;
        if (!fs.existsSync(file)) continue;
        result.push({
            id: `asset-${r.id}`,
            name: r.name || path.basename(file),
            kind,
            file,
            source: r.source === 'gpu' ? 'GPU · 共享资产' : r.source === 'upload' ? '云上传' : '本机登记',
            review: 'approved',
            created_at: r.created_at,
            bytes: r.size,
            sha256: r.sha256,
            note: r.note || undefined
        });
    }
    return result.filter(item => fs.existsSync(item.file)).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function publicResource(item) {
    const { file, reference, filename, owner_id, ...data } = item;
    return { ...data, url: `/api/studio/resources/${encodeURIComponent(item.id)}/file`, thumbnail: reference ? `/api/studio/resources/${encodeURIComponent(item.id)}/reference` : null };
}

function publicPlan(plan) {
    const { owner_id, skill_snapshot, ...data } = plan;
    return data;
}

function createStudioRouter({ wakeAudio }) {
    const router = express.Router();
    const publicShares = () => studioDb.list('shares').filter(item => item.enabled);
    const sharedResource = share => resources(share.owner_id).find(item => item.id === share.resource_id);
    router.get('/showcase', (req, res) => {
        const ownerResources = new Map();
        const result = publicShares().map(share => {
            if (!ownerResources.has(share.owner_id)) ownerResources.set(share.owner_id, resources(share.owner_id));
            const item = ownerResources.get(share.owner_id).find(value => value.id === share.resource_id);
            return item ? { id: share.id, name: item.name, kind: item.kind, source: item.source, bytes: item.bytes, review: 'approved', created_at: share.created_at, url: `/api/studio/showcase/${share.id}/file` } : null;
        }).filter(Boolean);
        res.set('Cache-Control', 'no-store').json({ success: true, data: result });
    });
    router.get('/showcase/:id/file', (req, res) => {
        const share = publicShares().find(item => item.id === req.params.id), item = share && sharedResource(share);
        if (!item) return res.status(404).end();
        res.set('Cache-Control', 'no-store');
        if (path.extname(item.file) === '.svg') res.set('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'");
        res.sendFile(path.resolve(item.file));
    });
    router.use(requireModelUser);
    router.use((req, res, next) => {
        res.set('Cache-Control', 'private, no-store');
        if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin) {
            try { if (new URL(req.headers.origin).host !== req.get('host')) return res.status(403).json({ success: false, error: '不允许跨站修改资源' }); }
            catch { return res.status(403).end(); }
        }
        next();
    });
    const action = fn => async (req, res) => {
        try { await fn(req, res); }
        catch (error) { res.status(error.status || 400).json({ success: false, error: error.name === 'ZodError' ? '请检查输入内容与长度' : error.message }); }
    };
    const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
    router.get('/resources', (req, res) => {
        const shares = studioDb.list('shares', req.user.id);
        ok(res, resources(req.user.id).map(item => {
            const share = shares.find(value => value.resource_id === item.id);
            return { ...publicResource(item), review: share?.reviewed_at ? 'approved' : item.review, shared: Boolean(share?.enabled) };
        }));
    });
    router.post('/resources/:id/share', requireUser, action((req, res) => {
        if (req.body.reviewed !== true) throw new Error('请先预览或试听并确认当前资源');
        if (!resources(req.user.id).some(item => item.id === req.params.id)) throw new Error('资源不存在');
        const existing = studioDb.list('shares', req.user.id).find(item => item.resource_id === req.params.id);
        const share = existing ? studioDb.change('shares', existing.id, req.user.id, item => { item.enabled = true; item.reviewed_at = now(); }) : studioDb.create('shares', { resource_id: req.params.id, enabled: true, reviewed_at: now() }, req.user.id);
        ok(res, { shared: true, id: share.id });
    }));
    router.delete('/resources/:id/share', requireUser, action((req, res) => {
        const share = studioDb.list('shares', req.user.id).find(item => item.resource_id === req.params.id);
        if (share) studioDb.change('shares', share.id, req.user.id, item => { item.enabled = false; });
        ok(res, { shared: false });
    }));
    for (const mode of ['file', 'reference']) router.get(`/resources/:id/${mode}`, (req, res) => {
        const item = resources(req.user.id).find(value => value.id === req.params.id);
        const filename = mode === 'file' ? item?.file : item?.reference;
        if (!filename || !fs.existsSync(filename)) return res.status(404).end();
        if (path.extname(filename) === '.svg') res.set('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'");
        res.sendFile(path.resolve(filename));
    });
    const upload = multer({ storage: multer.memoryStorage(), limits: { files: 1, fileSize: 50 * 1024 * 1024, fields: 3 } });
    router.post('/resources', requireUser, upload.single('file'), action(async (req, res) => {
        const file = req.file;
        if (!file) throw new Error('请选择 PNG、JPG、WebP、GLB 或 WAV 文件');
        let ext, kind;
        const image = detectImageType(file.buffer.subarray(0, 32));
        if (image) {
            if (file.size > 10 * 1024 * 1024) throw new Error('图片不能超过 10 MB');
            await sharp(file.buffer, { limitInputPixels: 40000000 }).metadata();
            ext = image.ext; kind = '2d';
        } else if (file.buffer.toString('ascii', 0, 4) === 'glTF') {
            validateGlbBuffer(file.buffer);
            const jsonLength = file.buffer.readUInt32LE(12);
            if (file.buffer.readUInt32LE(16) !== 0x4e4f534a || jsonLength > file.size - 20) throw new Error('GLB JSON 块无效');
            const json = JSON.parse(file.buffer.toString('utf8', 20, 20 + jsonLength));
            if ([...(json.buffers || []), ...(json.images || [])].some(item => item.uri && !item.uri.startsWith('data:'))) throw new Error('请上传包含全部贴图和网格的 GLB 文件');
            ext = '.glb'; kind = '3d';
        } else if (file.buffer.length >= 44 && file.buffer.toString('ascii', 0, 4) === 'RIFF' && file.buffer.toString('ascii', 8, 12) === 'WAVE' && file.buffer.readUInt32LE(4) + 8 === file.size) { ext = '.wav'; kind = 'sfx'; }
        else throw new Error('文件格式无效；支持 PNG、JPG、WebP、GLB 2.0 与 WAV');
        fs.mkdirSync(assetRoot, { recursive: true });
        const filename = `${crypto.randomUUID()}${ext}`;
        fs.writeFileSync(path.join(assetRoot, filename), file.buffer);
        let item;
        try { item = studioDb.create('assets', { name: String(req.body.name || path.parse(file.originalname).name).trim().slice(0, 80) || '未命名资源', kind, filename, bytes: file.size, sha256: digest(file.buffer), source: '上传资源', review: 'pending' }, req.user.id); }
        catch (error) { fs.unlinkSync(path.join(assetRoot, filename)); throw error; }
        ok(res, publicResource(item), 201);
    }));
    router.get('/config', requireUser, (req, res) => {
        const config = plannerConfig(req.user.id);
        ok(res, { url: config.url, model: config.model, api_key_configured: Boolean(config.key), custom: Boolean(studioDb.config(req.user.id).url), modeling_configured: Boolean(getProviderConfig().apiUrl), audio_configured: fs.existsSync(process.env.FACTORY_GPU_AUDIO_SCRIPT || path.join(__dirname, '../tools/gpu-audio/audio_factory.py')) && process.platform !== 'win32', image_generation_configured: false });
    });
    router.put('/config', requireUser, action((req, res) => {
        const url = String(req.body.url || '').trim(), model = String(req.body.model || '').trim();
        if (!url || !model || model.length > 120 || url.length > 2048) throw new Error('请填写模型接口地址和模型名称');
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('接口地址须为 HTTP(S)，密钥请填写在 API Key 字段');
        const apiKey = String(req.body.api_key || '').trim();
        if (apiKey.length > 2048 || /[\r\n]/.test(apiKey)) throw new Error('API Key 格式无效');
        studioDb.saveConfig(req.user.id, { url, model, ...(apiKey ? { api_key: apiKey } : {}), ...(req.body.clear_key === true ? { api_key: '' } : {}) });
        ok(res, { saved: true });
    }));
    const planning = new Set();
    router.post('/plans', action(async (req, res) => {
        if (planning.has(req.user.id)) throw new Error('正在解析上一条指令，请稍候');
        const recent = studioDb.list('plans', req.user.id).filter(item => Date.now() - Date.parse(item.created_at) < 60 * 60 * 1000);
        if (recent.length >= 30) throw new Error('每小时最多解析 30 条指令');
        planning.add(req.user.id);
        try { ok(res, publicPlan(await makePlan(req.body, req.user.id)), 201); }
        finally { planning.delete(req.user.id); }
    }));
    router.post('/plans/:id/execute', action((req, res) => {
        const plan = studioDb.get('plans', req.params.id, req.user.id);
        if (!plan || plan.kind !== 'sfx') throw new Error('音效制作计划不存在');
        if (plan.status === 'submitted') return ok(res, studioDb.get('tasks', plan.task_id, req.user.id), 202);
        if (process.platform === 'win32') throw new Error('音效须在自有 GPU 服务器执行，请使用线上工作室');
        if (studioDb.list('tasks').filter(item => ['queued', 'running'].includes(item.status)).length >= 8) throw new Error('音效队列已满，请稍后再试');
        const task = studioDb.create('tasks', { plan_id: plan.id, name: plan.name, kind: 'sfx', status: 'queued', progress_message: '等待自有 GPU 音效工位', review: 'pending' }, req.user.id);
        studioDb.change('plans', plan.id, req.user.id, item => { item.status = 'submitted'; item.task_id = task.id; });
        wakeAudio(); ok(res, task, 202);
    }));
    router.get('/tasks', (req, res) => ok(res, studioDb.list('tasks', req.user.id).reverse().map(({ owner_id, ...item }) => item)));
    return router;
}

module.exports = { createStudioRouter, resources, assetRoot, publicPlan, now };
