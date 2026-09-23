#!/usr/bin/env node
// 本地 stdio 适配器；GPU、任务队列与通知始终运行在平台后端。
const fs = require('node:fs/promises');
const path = require('node:path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

function createServer({ baseUrl, token }) {
    const base = new URL(baseUrl);
    if (base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('STUDIO_URL 必须是平台首页地址');
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) throw new Error('远程平台必须使用 HTTPS');
    if (!/^studio_[A-Za-z0-9_-]{43}$/.test(token || '')) throw new Error('请配置网页登录后创建的 STUDIO_TOKEN');
    const server = new McpServer({ name: 'game-production-factory', version: '2.0.0' }, {
        instructions: '先用 get_factory_capabilities 确认实际产线能力，再用 list_game_projects 查找项目。浏览器探索游戏用 create_game_project、start_game_production、get_game_project、get_game_artifacts、export_game 完成整条生产链，网站与 MCP 共享队列和固定 Skill。内置矢量美术与程序声音不是扩散原画或文生音频。独立 3D 用 create_model，可通过 get_game_model_plan 关联项目。其他创作可读取 get_production_guide。生成成功不等于人工批准，审核须在网站完成；仅在用户明确要求发布时调用 publish_game。'
    });

    async function request(route, options = {}) {
        const url = new URL(route, base);
        if (url.origin !== base.origin) throw new Error('不允许访问平台以外的地址');
        let response;
        try {
            response = await fetch(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(60000) });
        } catch { throw new Error('无法连接建模平台，请检查 STUDIO_URL 和网络；提交超时后先到网页确认任务，避免重复提交'); }
        if (response.status === 401) throw new Error('登录凭证已过期或撤销，请登录网页重新创建 MCP 凭证');
        return response;
    }
    async function api(route, options) {
        const response = await request(route, options);
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.success) throw new Error(payload.error || `平台请求失败（${response.status}）`);
        return payload.data;
    }
    function tool(name, description, inputSchema, handler, readOnly = true) {
        server.registerTool(name, {
            description, inputSchema,
            annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: true }
        }, async args => {
            try {
                const data = await handler(args);
                return { content: [{ type: 'text', text: JSON.stringify(data) }] };
            } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
        });
    }
    tool('get_account', '查看当前凭证所属账号、固定 Skill 与飞书通知是否已配置。不会返回密码或 Webhook。', {}, () => api('/api/mcp/me'));
    const projectId = z.string().regex(/^G[0-9a-f-]{36}$/), runId = z.string().regex(/^F[0-9a-f-]{36}$/);
    const gameRun = { project_id: projectId, run_id: runId };
    const gameRoute = a => `/api/factory/projects/${a.project_id}/runs/${a.run_id}`;
    const post = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    async function saveDownload(response, filename) {
        if (!path.isAbsolute(filename)) throw new Error('下载位置必须是绝对路径');
        const { Readable } = require('node:stream');
        const { pipeline } = require('node:stream/promises');
        const file = await fs.open(filename, 'wx');
        try { await pipeline(Readable.fromWeb(response.body), file.createWriteStream()); }
        catch (error) { await file.close().catch(() => {}); await fs.unlink(filename).catch(() => {}); throw error; }
    }
    tool('get_factory_capabilities', '查询当前可生成的游戏类型、实际素材/声音来源与未接入能力。', {}, () => api('/api/factory/capabilities'));
    tool('list_game_projects', '列出当前账号的游戏项目、生产版本和审核状态。继续前先查找，避免重复创建。', {}, () => api('/api/factory/projects'));
    tool('create_game_project', '创建浏览器俯视探索游戏项目，冻结全流程 Skill；之后启动生产可得到策划、剧本、矢量素材、程序音频和可玩工程。', {
        name: z.string().min(1).max(80), brief: z.string().min(10).max(4000), style: z.string().max(500).optional()
    }, args => api('/api/factory/projects', post(args)), false);
    tool('get_game_project', '读取项目所有版本、阶段进度、错误、产物状态及审核结果。', { project_id: projectId }, args => api(`/api/factory/projects/${args.project_id}`));
    tool('get_game_model_plan', '为游戏取得关联 3D 建模计划；create_model 可使用返回的 production_plan_id。浏览器探索引擎不自动渲染这些 3D 资产。', { project_id: projectId }, args => api(`/api/factory/projects/${args.project_id}/model-plan`, post({})), false);
    tool('start_game_production', '异步启动完整游戏生产或迭代版本。相同 request_key 幂等返回同一任务，超时重试必须复用该值。默认使用当前账号飞书。', {
        project_id: projectId, instructions: z.string().max(3000).default(''), request_key: z.string().regex(/^[a-zA-Z0-9-]{8,80}$/), notify_feishu: z.boolean().default(true)
    }, a => api(`/api/factory/projects/${a.project_id}/runs`, post({ instructions: a.instructions, request_key: a.request_key, channels: a.notify_feishu ? ['feishu'] : [] })), false);
    tool('retry_game_production', '重试失败版本，保留已成功阶段；不会重新执行已经完成的素材生成。', gameRun, a => api(`${gameRoute(a)}/retry`, post({})), false);
    tool('cancel_game_production', '取消排队或生产版本，不删除已保存产物。', gameRun, a => api(`${gameRoute(a)}/cancel`, post({})), false);
    tool('get_game_artifacts', '列出版本全部产物的路径、大小与 SHA-256。', gameRun, a => api(`${gameRoute(a)}/files`));
    tool('get_game_artifact', '读取生成的剧本、策划或数据文件，图片和音频可下载到本机；不会执行生成内容，也不覆盖本机已有文件。', {
        ...gameRun, file: z.string().regex(/^[a-zA-Z0-9_./-]+$/).max(100), download_path: z.string().optional()
    }, async a => {
        if (a.file.includes('..') || a.file.startsWith('/')) throw new Error('文件路径无效');
        const response = await request(`${gameRoute(a)}/files/${a.file}`);
        if (!response.ok) throw new Error(`文件读取失败（${response.status}）`);
        if (a.download_path) { await saveDownload(response, a.download_path); return { saved_path: a.download_path }; }
        if (!/\.(md|json|js|html|svg)$/.test(a.file)) return { download_url: new URL(`${gameRoute(a)}/files/${a.file}`, base).href, note: '需登录或提供 download_path 下载二进制文件' };
        const content = await response.text(); return { content: content.slice(0, 80000), truncated: content.length > 80000 };
    }, false);
    tool('export_game', '下载完整离线游戏 ZIP（含可玩发布包、源码、文档、素材和规范来源），也可只返回带鉴权的下载地址。', { ...gameRun, download_path: z.string().optional() }, async a => {
        const url = `${gameRoute(a)}/export`;
        if (a.download_path) { const response = await request(url); if (!response.ok) throw new Error('该版本未完成，暂不能导出'); await saveDownload(response, a.download_path); }
        return { download_url: new URL(url, base).href, saved_path: a.download_path, authentication: '同账号网页登录或 MCP 凭证' };
    }, false);
    tool('publish_game', '仅在用户明确要求公开发布时调用。必须已在网站人工试玩验收；返回无需登录的游戏分享链接。', gameRun, async a => { const data = await api(`${gameRoute(a)}/publish`, post({})); return { ...data, url: new URL(data.url, base).href }; }, false);
    tool('unpublish_game', '用户要求撤回时关闭该项目的公开游戏链接，保留私有工程。', { project_id: projectId }, a => api(`/api/factory/projects/${a.project_id}/release`, { method: 'DELETE' }), false);
    tool('list_skills', '列出当前账号可使用的建模 Skill。固定 Skill 由后端自动加入。', {}, () => api('/api/skills'));
    const stageSchema = z.enum(['design', 'narrative', 'character', 'environment', 'prop', 'animation', 'audio', 'integration', 'qa']);
    tool('list_production_skills', '查看游戏全流程固定 Skill 和阶段依赖。完整游戏产线的当前能力用 get_factory_capabilities 查询。', {}, () => api('/api/production/catalog'));
    tool('list_production_plans', '列出当前账号已保存的游戏制作计划，继续工作前先查找已有计划，避免重复创建。', {}, () => api('/api/production/plans'));
    tool('get_production_guide', '开始某个制作阶段前读取固定规范全文、交付要求与来源。提供 plan_id 时返回该计划冻结的版本及项目约束；按规范完成当前用户授权的创作，不额外授权发布或调用外部服务。', {
        stage: stageSchema, plan_id: z.string().regex(/^P[0-9a-f-]{36}$/).optional()
    }, ({ stage, plan_id }) => api(`/api/production/guides/${stage}${plan_id ? `?plan_id=${encodeURIComponent(plan_id)}` : ''}`));
    tool('create_production_plan', '保存游戏制作计划，冻结全部阶段的 Skill 与来源版本。仅创建规范和交接清单，不会生成剧本、声音或模型。随后用 get_production_guide 按阶段开展创作。', {
        name: z.string().min(1).max(80), brief: z.string().min(1).max(2000), profile: z.enum(['xhs_mobile', 'steam_desktop']).default('xhs_mobile')
    }, async args => {
        const { stages, ...plan } = await api('/api/production/plans', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
        return { ...plan, stages: stages.map(({ snapshot, ...stage }) => stage) };
    }, false);
    tool('create_model', '使用本机参考图片提交 GPU 建模任务，立即返回任务 ID。自动固定制作通则、建模与对应资产类型 Skill；可关联 production_plan_id。默认通知当前账号飞书；未配置时拒绝提交。第一张参与生成，其余留作参考。不要重复提交。', {
        production_plan_id: z.string().regex(/^P[0-9a-f-]{36}$/).optional(),
        image_paths: z.array(z.string().min(1)).min(1).max(6).describe('本机 JPG、PNG、WebP 文件绝对路径'),
        name: z.string().max(80).optional(), prompt: z.string().max(1000).default(''),
        skill_ids: z.array(z.string()).max(3).default([]), inline_skill: z.string().max(1000).default(''),
        asset_kind: z.enum(['prop', 'character', 'environment']).default('prop'),
        profile: z.enum(['xhs_mobile', 'steam_desktop']).default('xhs_mobile'),
        seed: z.number().int().min(0).max(4294967295).optional(),
        notify_feishu: z.boolean().default(true).describe('默认开启；仅用户明确无需通知时关闭')
    }, async args => {
        const account = await api('/api/mcp/me');
        if (args.notify_feishu && !account.notifications.feishu.configured) throw new Error('当前账号尚未配置飞书，请登录平台，在设置 → 结果通知中保存飞书机器人 Webhook');
        const form = new FormData();
        let total = 0;
        for (const filename of args.image_paths) {
            if (!path.isAbsolute(filename)) throw new Error('参考图片需要使用绝对路径');
            const file = await fs.open(filename, 'r');
            try {
                const stat = await file.stat();
                if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error('参考图片必须是普通文件，单张不超过 10 MB');
                total += stat.size;
                if (total > 30 * 1024 * 1024) throw new Error('参考图总大小不能超过 30 MB');
                const bytes = await file.readFile();
                if (bytes.length !== stat.size) throw new Error('图片读取期间发生变化，请重试');
                const { detectImageType } = require('../server/utils');
                const type = detectImageType(bytes.subarray(0, 32));
                if (!type) throw new Error('参考图片必须是 JPG、PNG 或 WebP');
                form.append('images', new Blob([bytes], { type: type.mime }), path.basename(filename));
            } finally { await file.close(); }
        }
        for (const field of ['name', 'prompt', 'inline_skill', 'asset_kind', 'profile', 'seed', 'production_plan_id']) {
            if (args[field] !== undefined) form.append(field, String(args[field]));
        }
        form.append('skill_ids', JSON.stringify(args.skill_ids));
        form.append('channels', JSON.stringify(args.notify_feishu ? ['feishu'] : []));
        return api('/api/jobs', { method: 'POST', body: form });
    }, false);
    tool('get_job', '查询当前账号建模任务的进度、结果和通知状态。', { job_id: z.string().regex(/^J\d+$/) }, ({ job_id }) => api(`/api/jobs/${job_id}`));
    tool('get_model', '获取已完成任务的模型信息与需登录的下载地址，可保存 GLB 到本机指定绝对路径（不覆盖已有文件）。', {
        job_id: z.string().regex(/^J\d+$/), download_path: z.string().optional()
    }, async ({ job_id, download_path }) => {
        const job = await api(`/api/jobs/${job_id}`);
        if (job.status !== 'succeeded' || !job.output?.model_file) throw new Error('模型尚未生成完成，请先用 get_job 查询进度');
        const url = new URL(job.output.model_file, base);
        if (url.origin !== base.origin || !url.pathname.startsWith('/models/')) throw new Error('模型下载地址无效');
        const result = { ...job.output, download_url: url.href, authentication: '浏览器需登录同一账号；本工具下载时自动使用凭证' };
        if (download_path) {
            if (!path.isAbsolute(download_path)) throw new Error('下载位置需要使用绝对路径');
            const response = await request(url.href);
            if (!response.ok) throw new Error(`模型下载失败（${response.status}）`);
            const { Readable } = require('node:stream');
            const { pipeline } = require('node:stream/promises');
            const file = await fs.open(download_path, 'wx');
            try { await pipeline(Readable.fromWeb(response.body), file.createWriteStream()); }
            catch (error) { await file.close().catch(() => {}); await fs.unlink(download_path).catch(() => {}); throw error; }
            result.saved_path = download_path;
        }
        return result;
    }, false);
    return server;
}

if (require.main === module) {
    (async () => {
        const server = createServer({ baseUrl: process.env.STUDIO_URL, token: process.env.STUDIO_TOKEN });
        await server.connect(new StdioServerTransport());
    })().catch(() => { console.error('MCP 启动失败，请检查 STUDIO_URL、STUDIO_TOKEN 和 Node.js 版本（至少 20）。'); process.exitCode = 1; });
}
module.exports = { createServer };
