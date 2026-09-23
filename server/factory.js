const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { z } = require('zod');
const { factoryDb, productionPlanDb, jobDb, notificationDb } = require('./db');
const { requireModelUser, requireUser } = require('./auth');
const { getCatalog, getGuide, catalogVersion } = require('./production-skills');
const { getChannelStatus } = require('./notifier');
const { stages, runDir } = require('./factory-worker');
const { inventory, exportZip, audit } = require('./factory-build');
const { validateGame } = require('./factory-spec');
const input = z.object({ name: z.string().trim().min(1).max(80), brief: z.string().trim().min(10).max(4000), style: z.string().trim().max(500).default('清晰、克制、色彩统一的矢量风格') });
const allowedFiles = /^(index\.html|runtime\.js|game\.json|qa\.json|animation\.json|assets\/(player\.svg|npc\.svg|item\.svg|collect\.wav|danger\.wav|win\.wav|music\.wav)|docs\/(design\.md|narrative\.md|art\.md|audio\.md|skill-snapshot\.json))$/;
function summary(project) {
    const { guides, owner_id, ...rest } = project;
    return { ...rest, runs: project.runs.map(r => ({ ...r, notifications: notificationDb.listForJob(r.id).map(({ channel, status, last_error }) => ({ channel, status, last_error })) })) };
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
function createFactoryRouter() {
    const router = express.Router({ strict: true });
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
    const ok = (res, data, code = 200) => res.status(code).json({ success: true, data });
    router.get('/capabilities', (req, res) => ok(res, { engine: 'browser-exploration-v1', delivery: '离线浏览器探索游戏', stages: stages.map(([id, name]) => ({ id, name })),
        supported: ['AI 策划、剧本、对白与关卡数据', '矢量角色、场景、道具', '程序合成音效与循环配乐', '移动、碰撞、危险物、收集与对话', '多关卡、暂停、失败重试、触屏操作', '在线试玩、版本迭代、ZIP 工程与公开分享', '独立 GPU 3D 建模资产库'],
        unavailable: ['任意游戏类型或 3D 玩法自动组装', '扩散模型原画（现有脚本缺失）', '真人配音与文生音乐模型', '联网对战、支付、商店上架'], notifications: getChannelStatus(req.user.id) }));
    router.get('/projects', (req, res) => ok(res, factoryDb.list(req.user.id).map(summary)));
    router.post('/projects', action((req, res) => {
        const data = input.parse(req.body);
        const guides = getCatalog().stages.map(s => getGuide(s.id));
        const p = factoryDb.create({ ...data, engine: 'browser-exploration-v1', catalog_version: catalogVersion, guides }, req.user.id);
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
        ok(res, { production_plan_id: p.production_plan_id, url: `/modeling.html?plan=${p.production_plan_id}` });
    }));
    router.post('/projects/:id/runs', action((req, res) => {
        const data = z.object({ instructions: z.string().trim().max(3000).default(''), channels: z.array(z.enum(['feishu', 'email', 'wecom'])).max(3).default([]), request_key: z.string().regex(/^[a-zA-Z0-9-]{8,80}$/) }).parse(req.body);
        const p = projectFor(req), duplicate = p.runs.find(r => r.request_key === data.request_key);
        if (duplicate) return ok(res, duplicate);
        for (const channel of data.channels) if (!getChannelStatus(req.user.id)[channel].configured) throw new Error(`请先在设置中配置${channel}通知`);
        let result;
        factoryDb.change(p.id, req.user.id, (q, all) => {
            if (q.runs.some(r => ['queued', 'running'].includes(r.status))) throw new Error('本项目已有生产任务，请等待完成或取消');
            if (q.runs.length >= 30) throw new Error('每个项目最多保留 30 个版本');
            if (all.flatMap(p => p.runs).filter(r => ['queued', 'running'].includes(r.status)).length >= 6) throw new Error('当前生产队列已满，请稍后再试');
            if (all.filter(p => p.owner_id === req.user.id).flatMap(p => p.runs).filter(r => Date.now() - Date.parse(r.created_at) < 6 * 3600000).length >= 12) throw new Error('6 小时内最多生成 12 个版本');
            result = { ...data, channels: [...new Set(data.channels)], id: `F${crypto.randomUUID()}`, version: q.runs.length + 1, status: 'queued', stages: stages.map(([id, name]) => ({ id, name, status: 'pending' })), review: { status: 'pending' }, base_url: process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`, created_at: new Date().toISOString() };
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
