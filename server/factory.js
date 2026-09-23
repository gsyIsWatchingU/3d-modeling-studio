const express = require('express');
const multer = require('multer');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { z } = require('zod');
const { factoryDb, productionPlanDb, jobDb, notificationDb } = require('./db');
const { requireModelUser, requireUser } = require('./auth');
const { getCatalog, getGuide, catalogVersion } = require('./production-skills');
const { getChannelStatus } = require('./notifier');
const { stages, runDir } = require('./factory-worker');
const { atomicFile, inventory, exportZip, audit } = require('./factory-build');
const { validateGame } = require('./factory-spec');
const { detectImageType } = require('./utils');
const { generatedStageIds, publicWorkflowStages, stageDefinition } = require('./stage-workflow');
const { stageRunDir } = require('./stage-worker');
const { gpuSfxEnabled } = require('./gpu-audio');
const input = z.object({ name: z.string().trim().min(1).max(80), brief: z.string().trim().min(10).max(4000), style: z.string().trim().max(500).default('清晰、克制、色彩统一的矢量风格') });
const allowedFiles = /^(index\.html|runtime\.js|game\.json|qa\.json|animation\.json|assets\/(player\.svg|npc\.svg|item\.svg|collect\.wav|danger\.wav|win\.wav|music\.wav)|docs\/(design\.md|narrative\.md|art\.md|audio\.md|audio-source\.json|skill-snapshot\.json))$/;
function summary(project) {
    const { guides, owner_id, ...rest } = project;
    return { ...rest, stage_runs: project.stage_runs || [], runs: project.runs.map(r => ({ ...r, notifications: notificationDb.listForJob(r.id).map(({ channel, status, last_error }) => ({ channel, status, last_error })) })) };
}
function serveFile(res, dir, filename, isPublic = false) {
    if (!allowedFiles.test(filename) || (isPublic && !/^(index\.html|runtime\.js|assets\/)/.test(filename))) return res.status(404).end();
    const target = path.join(dir, filename);
    if (!fs.existsSync(target)) return res.status(404).end();
    res.setHeader('Cache-Control', 'no-store');
    if (filename === 'index.html') {
        // 沙箱为独立源，子资源请求不能依赖登录 Cookie。打包内联可信引擎和本版本素材。
        const assets = {};
        for (const name of ['player.svg', 'npc.svg', 'item.svg', 'collect.wav', 'danger.wav', 'win.wav', 'music.wav']) {
            assets[name] = `data:${name.endsWith('.svg') ? 'image/svg+xml' : 'audio/wav'};base64,${fs.readFileSync(path.join(dir, 'assets', name)).toString('base64')}`;
        }
        const runtime = fs.readFileSync(path.join(dir, 'runtime.js'), 'utf8');
        const html = fs.readFileSync(target, 'utf8').replace('<script src="runtime.js"></script>', () => `<script>window.GAME_ASSETS=${JSON.stringify(assets)};</script><script>${runtime}</script>`);
        res.setHeader('Content-Security-Policy', "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'");
        return res.type('html').send(html);
    }
    if (filename.endsWith('.md')) res.type('text/plain');
    res.sendFile(target);
}
function serveStageFile(res, project, run, filename) {
    if (!/^(output\.md|manifest\.json|previews\/[a-zA-Z0-9-]+\.(png|jpg|webp))$/.test(filename)) return res.status(404).end();
    const target = path.join(stageRunDir(project, run), filename);
    if (!fs.existsSync(target)) return res.status(404).end();
    res.setHeader('Cache-Control', 'private, no-store');
    if (filename.endsWith('.md')) res.type('text/plain');
    return res.sendFile(target);
}
function createFactoryRouter() {
    const router = express.Router({ strict: true });
    const previewUpload = multer({
        storage: multer.memoryStorage(),
        limits: { files: 6, fileSize: 10 * 1024 * 1024, fields: 5 },
        fileFilter: (req, file, callback) => callback(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype))
    });
    router.get('/play/:token', (req, res) => res.redirect(`/api/factory/play/${encodeURIComponent(req.params.token)}/`));
    router.get('/play/:token/{*file}', (req, res) => {
        if (!/^[a-f0-9]{48}$/.test(req.params.token)) return res.status(404).end();
        const p = factoryDb.all().find(p => p.release?.token === req.params.token);
        const run = p?.runs.find(r => r.id === p.release.run_id && r.review?.status === 'approved');
        if (!run) return res.status(404).end();
        return serveFile(res, runDir(p, run), (req.params.file || ['index.html']).join('/'), true);
    });
    router.use(requireModelUser);
    router.use((req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin) {
            let origin;
            try { origin = new URL(req.headers.origin); } catch {}
            if (!origin || origin.host !== req.get('host')) return res.status(403).json({ success: false, error: '不允许跨站修改游戏项目' });
        }
        next();
    });
    const action = fn => async (req, res) => {
        try { await fn(req, res); }
        catch (error) { res.status(error.status || 400).json({ success: false, error: error instanceof z.ZodError ? '输入内容不符合要求，请检查名称、目标和长度' : error.message }); }
    };
    const projectFor = req => { const p = factoryDb.get(req.params.id, req.user.id); if (!p) throw Object.assign(new Error('游戏项目不存在'), { status: 404 }); return p; };
    const runFor = (req, p) => { const r = p.runs.find(r => r.id === req.params.run); if (!r) throw Object.assign(new Error('生产版本不存在'), { status: 404 }); return r; };
    const stageRunFor = (req, p) => { const r = (p.stage_runs || []).find(item => item.id === req.params.stageRun); if (!r) throw Object.assign(new Error('阶段版本不存在'), { status: 404 }); return r; };
    const ok = (res, data, code = 200) => res.status(code).json({ success: true, data });
    router.get('/capabilities', (req, res) => ok(res, { engine: 'browser-exploration-v1', delivery: '离线浏览器探索游戏', stages: stages.map(([id, name]) => ({ id, name })),
        workflow_stages: publicWorkflowStages(),
        supported: ['AI 策划、剧本、对白与关卡数据', '矢量角色、场景、道具', gpuSfxEnabled() ? 'GPU 事件音效与程序循环配乐' : '程序合成音效与循环配乐', '移动、碰撞、危险物、收集与对话', '多关卡、暂停、失败重试、触屏操作', '在线试玩、版本迭代、ZIP 工程与公开分享', '独立 GPU 3D 建模资产库'],
        audio_workflow: { mode: gpuSfxEnabled() ? 'automatic-gpu-sfx' : 'external-gpu-cli', guide: 'audio', backends: ['moss-soundeffect-v2.0', 'qwen3-tts-1.7b'], readiness: 'run-doctor-on-gpu-host', automatic_game_integration: gpuSfxEnabled() },
        unavailable: ['任意游戏类型或 3D 玩法自动组装', '扩散模型原画（现有脚本缺失）', '联网对战、支付、商店上架'], notifications: getChannelStatus(req.user.id) }));
    router.get('/projects', (req, res) => ok(res, factoryDb.list(req.user.id).map(summary)));
    router.post('/projects', action((req, res) => {
        const data = input.parse(req.body);
        const guides = getCatalog().stages.map(s => getGuide(s.id));
        const p = factoryDb.create({ ...data, engine: 'browser-exploration-v1', catalog_version: catalogVersion, guides, stage_runs: [] }, req.user.id);
        ok(res, summary(p), 201);
    }));
    router.get('/projects/:id', action((req, res) => {
        const p = projectFor(req);
        ok(res, { ...summary(p), model_jobs: jobDb.list(100, req.user.id).filter(j => j.production_plan_id === p.production_plan_id && p.production_plan_id).map(j => ({ id: j.id, name: j.name, status: j.status, output: j.output })) });
    }));
    router.post('/projects/:id/model-plan', action((req, res) => {
        const p = projectFor(req);
        if (!p.production_plan_id) {
            const plan = productionPlanDb.create({ name: p.name, brief: p.brief.slice(0, 2000), profile: 'xhs_mobile', catalog_version: p.catalog_version, status: 'planned', stages: p.guides }, req.user.id);
            factoryDb.change(p.id, req.user.id, q => { q.production_plan_id = plan.id; }); p.production_plan_id = plan.id;
        }
        const concept = (p.stage_runs || []).filter(run => run.stage_id === 'concept' && run.review?.status === 'approved').at(-1);
        const preview_files = (concept?.artifacts || []).filter(item => item.type === 'image').map(item => ({
            url: `/api/factory/projects/${p.id}/stage-runs/${concept.id}/files/${item.path}`,
            name: item.original_name || path.basename(item.path), sha256: item.sha256
        }));
        ok(res, { production_plan_id: p.production_plan_id, url: `/modeling.html?plan=${p.production_plan_id}`, preview_files });
    }));
    router.post('/projects/:id/workflow-stages/modeling/review', requireUser, action((req, res) => {
        const p = projectFor(req);
        const review = z.object({ status: z.enum(['approved', 'changes_requested']), notes: z.string().trim().min(5).max(2000), confirmed: z.literal(true), reference_id: z.string().regex(/^J\d+$/) }).parse(req.body);
        const job = jobDb.list(100, req.user.id).find(item => item.id === review.reference_id && item.production_plan_id === p.production_plan_id);
        if (!job || job.status !== 'succeeded') throw new Error('请先在关联的 3D 建模工位完成并检查模型');
        const next = factoryDb.change(p.id, req.user.id, project => {
            project.stage_reviews ||= {}; project.stage_reviews.modeling = { ...review, reviewer: req.user.id, reviewed_at: new Date().toISOString() };
        });
        ok(res, summary(next));
    }));
    router.post('/projects/:id/stage-runs', action((req, res) => {
        const data = z.object({
            stage_id: z.string().refine(id => generatedStageIds.has(id), '此阶段不能在独立生成工位启动'),
            instructions: z.string().trim().max(3000).default(''),
            request_key: z.string().regex(/^[a-zA-Z0-9-]{8,80}$/)
        }).parse(req.body);
        const p = projectFor(req), duplicate = (p.stage_runs || []).find(run => run.request_key === data.request_key);
        if (duplicate) return ok(res, duplicate);
        const definition = stageDefinition(data.stage_id);
        let result;
        factoryDb.change(p.id, req.user.id, (project, all) => {
            project.stage_runs ||= [];
            if (project.stage_runs.some(run => ['queued', 'running'].includes(run.status))) throw new Error('本项目已有独立阶段任务，请等待完成');
            if (project.runs.some(run => ['queued', 'running'].includes(run.status))) throw new Error('本项目正在进行完整生产，请等待完成');
            if (project.stage_runs.length >= 80) throw new Error('每个项目最多保留 80 个阶段版本');
            if (all.flatMap(item => item.stage_runs || []).filter(run => ['queued', 'running'].includes(run.status)).length >= 8) throw new Error('阶段生产队列已满，请稍后再试');
            const inputs = [], missing = [];
            for (const dependency of definition.depends_on) {
                const approved = project.stage_runs.filter(run => run.stage_id === dependency && run.review?.status === 'approved').at(-1);
                if (approved) inputs.push(approved.id); else missing.push(dependency);
            }
            result = {
                ...data, id: `S${crypto.randomUUID()}`, stage_name: definition.name,
                version: project.stage_runs.filter(run => run.stage_id === data.stage_id).length + 1,
                input_run_ids: inputs, missing_approved_inputs: missing,
                status: 'queued', review: { status: 'pending' }, artifacts: [], created_at: new Date().toISOString()
            };
            project.stage_runs.push(result);
        });
        ok(res, result, 202);
    }));
    router.get('/projects/:id/stage-runs/:stageRun/files', action((req, res) => {
        const p = projectFor(req), run = stageRunFor(req, p); ok(res, run.artifacts || []);
    }));
    router.get('/projects/:id/stage-runs/:stageRun/files/{*file}', action((req, res) => {
        const p = projectFor(req), run = stageRunFor(req, p);
        return serveStageFile(res, p, run, (req.params.file || []).join('/'));
    }));
    router.post('/projects/:id/stage-runs/:stageRun/previews', requireUser, previewUpload.array('images', 6), action((req, res) => {
        const p = projectFor(req), run = stageRunFor(req, p), files = req.files || [];
        if (run.stage_id !== 'concept' || run.status !== 'succeeded') throw new Error('请先完成预览图制作单');
        if (!files.length) throw new Error('请选择需要保存的预览图');
        if (files.reduce((sum, file) => sum + file.size, 0) > 30 * 1024 * 1024) throw new Error('预览图总大小不能超过 30 MB');
        if ((run.artifacts || []).filter(item => item.type === 'image').length + files.length > 6) throw new Error('每个预览图版本最多保存 6 张图片');
        const validated = files.map(file => {
            const type = detectImageType(file.buffer.subarray(0, 32));
            if (!type) throw new Error(`${file.originalname} 不是有效的 JPG、PNG 或 WebP 图片`);
            return { file, type };
        });
        const saved = validated.map(({ file, type }) => {
            const name = `${crypto.randomUUID()}${type.ext}`, relative = `previews/${name}`, target = path.join(stageRunDir(p, run), relative);
            fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, file.buffer);
            return { path: relative, type: 'image', bytes: file.size, sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'), original_name: path.basename(file.originalname).slice(0, 120), created_at: new Date().toISOString() };
        });
        const manifestPath = path.join(stageRunDir(p, run), 'manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); manifest.artifacts = [...(run.artifacts || []), ...saved];
        atomicFile(manifestPath, JSON.stringify(manifest, null, 2));
        const next = factoryDb.change(p.id, req.user.id, project => {
            const item = project.stage_runs.find(value => value.id === run.id); item.artifacts.push(...saved); item.deliverable_status = 'assets_ready';
        });
        ok(res, (next.stage_runs.find(item => item.id === run.id).artifacts || []), 201);
    }));
    router.post('/projects/:id/stage-runs/:stageRun/review', requireUser, action((req, res) => {
        const p = projectFor(req), run = stageRunFor(req, p);
        const review = z.object({ status: z.enum(['approved', 'changes_requested']), notes: z.string().trim().min(5).max(2000), confirmed: z.literal(true) }).parse(req.body);
        if (run.status !== 'succeeded') throw new Error('阶段版本尚未生成完成');
        if (run.stage_id === 'concept' && review.status === 'approved' && !(run.artifacts || []).some(item => item.type === 'image')) throw new Error('请先上传实际预览图，再进行人工批准');
        const next = factoryDb.change(p.id, req.user.id, project => {
            project.stage_runs.find(item => item.id === run.id).review = { ...review, reviewer: req.user.id, reviewed_at: new Date().toISOString() };
        });
        const manifestPath = path.join(stageRunDir(p, run), 'manifest.json');
        if (fs.existsSync(manifestPath)) { const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); manifest.review = next.stage_runs.find(item => item.id === run.id).review; atomicFile(manifestPath, JSON.stringify(manifest, null, 2)); }
        ok(res, summary(next));
    }));
    router.post('/projects/:id/runs', action((req, res) => {
        const data = z.object({ instructions: z.string().trim().max(3000).default(''), channels: z.array(z.enum(['feishu', 'email', 'wecom'])).max(3).default([]), request_key: z.string().regex(/^[a-zA-Z0-9-]{8,80}$/) }).parse(req.body);
        const p = projectFor(req), duplicate = p.runs.find(r => r.request_key === data.request_key);
        if (duplicate) return ok(res, duplicate);
        for (const channel of data.channels) if (!getChannelStatus(req.user.id)[channel].configured) throw new Error(`请先在设置中配置${channel}通知`);
        let result;
        factoryDb.change(p.id, req.user.id, (q, all) => {
            if (q.runs.some(r => ['queued', 'running'].includes(r.status))) throw new Error('本项目已有生产任务，请等待完成或取消');
            if ((q.stage_runs || []).some(r => ['queued', 'running'].includes(r.status))) throw new Error('本项目正在进行独立阶段任务，请等待完成');
            if (q.runs.length >= 30) throw new Error('每个项目最多保留 30 个版本');
            if (all.flatMap(p => p.runs).filter(r => ['queued', 'running'].includes(r.status)).length >= 6) throw new Error('当前生产队列已满，请稍后再试');
            if (all.filter(p => p.owner_id === req.user.id).flatMap(p => p.runs).filter(r => Date.now() - Date.parse(r.created_at) < 6 * 3600000).length >= 12) throw new Error('6 小时内最多生成 12 个版本');
            result = { ...data, channels: [...new Set(data.channels)], id: `F${crypto.randomUUID()}`, version: q.runs.length + 1, status: 'queued', stages: stages.map(([id, name]) => ({ id, name, status: 'pending' })), review: { status: 'pending' }, base_url: process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`, created_at: new Date().toISOString() };
            result.stage_input_ids = (q.stage_runs || []).filter(stageRun => stageRun.review?.status === 'approved')
                .filter((stageRun, index, list) => list.findLastIndex(item => item.stage_id === stageRun.stage_id) === index).map(stageRun => stageRun.id);
            q.runs.push(result);
        });
        ok(res, result, 202);
    }));
    router.post('/projects/:id/runs/:run/cancel', action((req, res) => {
        const p = projectFor(req), run = runFor(req, p);
        if (!['queued', 'running'].includes(run.status)) throw new Error('只能取消排队或生产中的版本');
        const next = factoryDb.change(p.id, req.user.id, q => { const r = q.runs.find(r => r.id === run.id); r.status = 'cancelled'; r.stages.filter(s => ['pending', 'running'].includes(s.status)).forEach(s => { s.status = 'cancelled'; }); });
        ok(res, summary(next));
    }));
    router.post('/projects/:id/runs/:run/retry', action((req, res) => {
        const p = projectFor(req), run = runFor(req, p);
        if (run.status !== 'failed') throw new Error('只能重试失败版本');
        const next = factoryDb.change(p.id, req.user.id, (q, all) => {
            if (q.runs.some(r => ['queued', 'running'].includes(r.status)) || all.flatMap(p => p.runs).filter(r => ['queued', 'running'].includes(r.status)).length >= 6) throw new Error('已有生产任务或队列已满');
            const r = q.runs.find(r => r.id === run.id);
            if ((r.retries || 0) >= 3) throw new Error('此版本已重试 3 次，请调整要求后创建新版本');
            r.retries = (r.retries || 0) + 1; r.status = 'queued'; r.error = null; r.stages.filter(s => s.status === 'failed').forEach(s => { s.status = 'pending'; });
        }); ok(res, summary(next));
    }));
    router.get('/projects/:id/runs/:run/files', action((req, res) => {
        const p = projectFor(req), r = runFor(req, p), dir = runDir(p, r);
        ok(res, fs.existsSync(dir) ? inventory(dir) : []);
    }));
    router.get('/projects/:id/runs/:run/files/{*file}', action((req, res) => { const p = projectFor(req), r = runFor(req, p); serveFile(res, runDir(p, r), (req.params.file || ['index.html']).join('/')); }));
    router.get('/projects/:id/runs/:run/export', action((req, res) => {
        const p = projectFor(req), r = runFor(req, p); if (r.status !== 'succeeded') throw new Error('请等待生产和自动检查完成');
        res.type('application/zip').attachment(`${p.id}-v${r.version}.zip`).send(exportZip(runDir(p, r), p, r));
    }));
    // 人工审核只接受网页登录，MCP 不能把模型自检冒充人的验收。
    router.post('/projects/:id/runs/:run/review', requireUser, action((req, res) => {
        const p = projectFor(req), r = runFor(req, p);
        const review = z.object({ status: z.enum(['approved', 'changes_requested']), notes: z.string().trim().min(5).max(2000), played: z.literal(true) }).parse(req.body);
        if (r.status !== 'succeeded') throw new Error('版本未生成完成');
        if (review.status === 'approved') audit(runDir(p, r), validateGame(JSON.parse(fs.readFileSync(path.join(runDir(p, r), 'game.json'), 'utf8'))));
        const next = factoryDb.change(p.id, req.user.id, q => {
            q.runs.find(x => x.id === r.id).review = { ...review, reviewer: req.user.id, reviewed_at: new Date().toISOString() };
            if (review.status !== 'approved' && q.release?.run_id === r.id) q.release = null;
        }); ok(res, summary(next));
    }));
    router.post('/projects/:id/runs/:run/publish', action((req, res) => {
        const p = projectFor(req), r = runFor(req, p);
        if (r.status !== 'succeeded' || r.review?.status !== 'approved') throw new Error('请先在网站试玩并人工验收该版本');
        const next = factoryDb.change(p.id, req.user.id, q => { q.release = { run_id: r.id, token: crypto.randomBytes(24).toString('hex'), published_at: new Date().toISOString() }; });
        ok(res, { url: `/api/factory/play/${next.release.token}/`, run_id: r.id });
    }));
    router.delete('/projects/:id/release', action((req, res) => { const p = projectFor(req); factoryDb.change(p.id, req.user.id, q => { q.release = null; }); ok(res, { unpublished: true }); }));
    return router;
}
module.exports = { createFactoryRouter };
