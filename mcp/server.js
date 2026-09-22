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
    const server = new McpServer({ name: '3d-modeling-studio', version: '1.1.0' }, {
        instructions: '处理游戏制作任务时先查找已有制作计划，再用 get_production_guide 读取相应阶段的固定规范和计划约束。需要新计划时使用 create_production_plan。当前 AI 可按规范编写剧本和生产规格；模型通过 create_model 提交，固定建模规范由后端自动加入。音频、绑定动画和引擎集成未通过本站执行，不能把规范或提示词说成已生成的资产。仅执行当前用户请求范围内的工作。'
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
    tool('list_skills', '列出当前账号可使用的建模 Skill。固定 Skill 由后端自动加入。', {}, () => api('/api/skills'));
    const stageSchema = z.enum(['design', 'narrative', 'character', 'environment', 'prop', 'animation', 'audio', 'integration', 'qa']);
    tool('list_production_skills', '查看游戏全流程固定 Skill、阶段依赖与实际执行能力。剧本由当前 AI 按规范编写；音频/动画生成尚未接入，不能宣称已生成。', {}, () => api('/api/production/catalog'));
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
