const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const {
    modelDb,
    skillDb,
    settingsDb,
    jobDb,
    notificationDb,
    configDb,
    getStats,
    uploadDir,
    modelDir
} = require('./db');
const {
    detectImageType,
    parseSkillDocument,
    createSkillSnapshot,
    buildProviderPrompt,
    safeStringList,
    publicJob
} = require('./utils');
const { parseSeed } = require('./utils');
const { getProviderConfig, startModelWorker } = require('./model-worker');
const { getChannelStatus, sendChannel, startNotificationWorker } = require('./notifier');
const { createAuthRouter, requireUser } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_TOTAL_SIZE = 30 * 1024 * 1024;
const MAX_IMAGES = 6;
const MAX_SKILL_SIZE = 64 * 1024;
const ASSET_KINDS = ['prop', 'character', 'environment'];
const PROFILES = ['xhs_mobile', 'steam_desktop'];
const CHANNELS = ['email', 'feishu', 'wecom'];
const jobSubmissionBuckets = new Map();

app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
});
// 统一账号认证：/auth/*、/me、/logout
app.use(createAuthRouter());
app.use('/vendor/three', express.static(path.join(__dirname, '..', 'node_modules', 'three')));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/models', requireUser, (req, res, next) => {
    const model = modelDb.list().find(item => item.model_file === '/models' + req.path);
    if (!model || jobDb.findById(model.job_id)?.owner_id !== req.user.id) return res.status(404).end();
    next();
}, express.static(modelDir, { fallthrough: false, maxAge: 0 }));

const uploadStorage = multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, callback) => callback(null, `${crypto.randomUUID()}.upload`)
});
const imageUpload = multer({
    storage: uploadStorage,
    limits: { files: MAX_IMAGES, fileSize: MAX_IMAGE_SIZE, fields: 20 },
    fileFilter: (req, file, callback) => callback(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype))
});
const skillUpload = multer({ storage: multer.memoryStorage(), limits: { files: 1, fileSize: MAX_SKILL_SIZE, fields: 5 } });

function removeFiles(files = []) {
    for (const file of files) {
        try { if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path); } catch {}
    }
}

function normalizeUploadedImages(files = []) {
    if (files.length < 1 || files.length > MAX_IMAGES) throw new Error(`请上传 1～${MAX_IMAGES} 张参考图`);
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (total > MAX_TOTAL_SIZE) throw new Error('参考图总大小不能超过 30 MB');
    const names = [];
    try {
        for (const file of files) {
            const header = fs.readFileSync(file.path).subarray(0, 32);
            const type = detectImageType(header);
            if (!type) throw new Error(`${file.originalname} 不是有效的 JPG、PNG 或 WebP 图片`);
            const nextName = `${path.basename(file.filename, '.upload')}${type.ext}`;
            fs.renameSync(file.path, path.join(uploadDir, nextName));
            file.path = path.join(uploadDir, nextName);
            names.push(nextName);
        }
        return names;
    } catch (error) {
        removeFiles(files);
        throw error;
    }
}

function providerPublicConfig() {
    const stored = configDb.get();
    const effective = getProviderConfig();
    return {
        provider: effective.provider,
        api_url: process.env.SPU_API_URL || stored.api_url || '',
        api_key_configured: Boolean(effective.apiKey),
        configured: Boolean(effective.apiUrl),
        managed_by_environment: Boolean(process.env.SPU_API_URL)
    };
}

function notificationPublicConfig() {
    const stored = configDb.getNotifications();
    return {
        status: getChannelStatus(),
        editable: {
            email: {
                recipient_configured: Boolean(process.env.NOTIFY_EMAIL_TO || stored.email.recipient),
                smtp_host_configured: Boolean(process.env.SMTP_HOST || stored.email.smtp_host),
                smtp_port: stored.email.smtp_port || 465,
                smtp_secure: stored.email.smtp_secure !== false,
                smtp_user_configured: Boolean(process.env.SMTP_USER || stored.email.smtp_user),
                smtp_pass_configured: Boolean(process.env.SMTP_PASS || stored.email.smtp_pass)
            },
            feishu: { webhook_configured: Boolean(process.env.FEISHU_WEBHOOK || stored.feishu.webhook) },
            wecom: { webhook_configured: Boolean(process.env.WECOM_WEBHOOK || stored.wecom.webhook) }
        }
    };
}

function jobWithNotifications(job) {
    return publicJob(job, notificationDb.listForJob(job.id));
}

function limitJobSubmissions(req, res, next) {
    const key = String(req.get('cf-connecting-ip') || req.ip || 'unknown');
    const now = Date.now();
    const recent = (jobSubmissionBuckets.get(key) || []).filter(timestamp => now - timestamp < 6 * 60 * 60 * 1000);
    if (recent.length >= 12) return res.status(429).json({ success: false, error: '6 小时内最多提交 12 个任务，请稍后再试' });
    const stats = getStats().jobs;
    const active = ['queued', 'retry_wait', 'generating', 'downloading', 'validating'].reduce((sum, status) => sum + (stats[status] || 0), 0);
    if (active >= 8) return res.status(429).json({ success: false, error: '当前已有 8 个任务等待处理，请完成后再提交' });
    recent.push(now);
    jobSubmissionBuckets.set(key, recent);
    next();
}

app.get('/api/bootstrap', requireUser, (req, res) => {
    res.json({
        success: true,
        data: {
            provider: providerPublicConfig(),
            notifications: notificationPublicConfig(),
            skills: skillDb.list(req.user.id).map(({ content, ...skill }) => ({ ...skill, content_length: content.length })),
            settings: settingsDb.get(req.user.id),
            limits: { max_images: MAX_IMAGES, max_image_bytes: MAX_IMAGE_SIZE, max_total_bytes: MAX_TOTAL_SIZE },
            profiles: [
                { id: 'xhs_mobile', name: '移动端标准', description: '生成更快，适合网页和移动端' },
                { id: 'steam_desktop', name: '桌面高精度', description: '更高面数与 4K PBR，耗时更长' }
            ],
            asset_kinds: [
                { id: 'prop', name: '物品/道具' },
                { id: 'character', name: '角色' },
                { id: 'environment', name: '场景' }
            ]
        }
    });
});

app.get('/api/skills', requireUser, (req, res) => {
    res.json({ success: true, data: skillDb.list(req.user.id).map(({ content, ...skill }) => ({ ...skill, content_length: content.length })) });
});

app.post('/api/skills', requireUser, skillUpload.single('skill_file'), (req, res) => {
    try {
        const text = req.file ? req.file.buffer.toString('utf8') : String(req.body.content || '');
        if (text.length > 6000) return res.status(400).json({ success: false, error: 'Skill 内容不能超过 6000 字' });
        const parsed = parseSkillDocument(text, String(req.body.name || req.file?.originalname || '自定义 Skill').replace(/\.[^.]+$/, ''));
        if (req.body.name) parsed.name = String(req.body.name).trim().slice(0, 60);
        const skill = skillDb.create({ ...parsed, owner_id: req.user.id });
        res.status(201).json({ success: true, data: { ...skill, content: undefined, content_length: skill.content.length } });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

app.delete('/api/skills/:id', requireUser, (req, res) => {
    const removed = skillDb.delete(req.params.id, req.user.id);
    if (!removed) return res.status(400).json({ success: false, error: '内置 Skill 不能删除，或 Skill 不存在' });
    res.json({ success: true });
});

app.put('/api/settings/default-skill', requireUser, (req, res) => {
    const skill = skillDb.findById(req.body.skill_id, req.user.id);
    if (!skill) return res.status(404).json({ success: false, error: 'Skill 不存在' });
    res.json({ success: true, data: settingsDb.save({ default_skill_ids: [skill.id], default_skill_id: skill.id }, req.user.id) });
});

app.put('/api/settings/default-skills', requireUser, (req, res) => {
    const requested = safeStringList(req.body.skill_ids);
    const valid = requested.filter(id => skillDb.findById(id, req.user.id));
    if (valid.length !== requested.length) return res.status(400).json({ success: false, error: '只能固定自己的 Skill' });
    const skillIds = [...new Set(['skill-general', ...valid])];
    res.json({ success: true, data: settingsDb.save({ default_skill_ids: skillIds, default_skill_id: skillIds[0] }, req.user.id) });
});

app.get('/api/config/spu', (req, res) => {
    res.json({ success: true, data: providerPublicConfig() });
});

app.put('/api/config/spu', requireUser, (req, res) => {
    try {
        const current = configDb.get();
        const apiUrl = String(req.body.api_url || '').trim();
        if (apiUrl && !['http:', 'https:'].includes(new URL(apiUrl).protocol)) throw new Error('建模服务地址必须使用 HTTP 或 HTTPS');
        const next = {
            provider: String(req.body.provider || current.provider || 'forge3d').slice(0, 30),
            api_url: apiUrl
        };
        if (String(req.body.api_key || '').trim()) next.api_key = String(req.body.api_key).trim();
        configDb.save(next);
        res.json({ success: true, data: providerPublicConfig() });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

app.get('/api/notification-config', (req, res) => {
    res.json({ success: true, data: notificationPublicConfig() });
});

app.put('/api/notification-config', requireUser, (req, res) => {
    const current = configDb.getNotifications();
    const body = req.body || {};
    const next = {
        email: {
            recipient: String(body.email?.recipient || current.email.recipient).trim().slice(0, 200),
            smtp_host: String(body.email?.smtp_host || current.email.smtp_host).trim().slice(0, 200),
            smtp_port: Math.max(1, Math.min(65535, Number(body.email?.smtp_port ?? current.email.smtp_port) || 465)),
            smtp_secure: body.email?.smtp_secure ?? current.email.smtp_secure,
            smtp_user: String(body.email?.smtp_user || current.email.smtp_user).trim().slice(0, 200)
        },
        feishu: {},
        wecom: {}
    };
    if (String(body.email?.smtp_pass || '').trim()) next.email.smtp_pass = String(body.email.smtp_pass);
    if (String(body.feishu?.webhook || '').trim()) next.feishu.webhook = String(body.feishu.webhook).trim();
    if (String(body.wecom?.webhook || '').trim()) next.wecom.webhook = String(body.wecom.webhook).trim();
    configDb.saveNotifications(next);
    res.json({ success: true, data: notificationPublicConfig() });
});

app.post('/api/notification-config/test', requireUser, async (req, res) => {
    const channel = String(req.body.channel || '');
    if (!CHANNELS.includes(channel)) return res.status(400).json({ success: false, error: '未知通知通道' });
    try {
        await sendChannel(channel, {
            id: 'TEST',
            name: '通知连通性测试',
            status: 'succeeded',
            base_url: process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`,
            output: { validated: true }
        });
        res.json({ success: true, message: '测试通知已发送' });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

app.post('/api/jobs', requireUser, limitJobSubmissions, imageUpload.array('images', MAX_IMAGES), (req, res) => {
    let imageNames = [];
    try {
        if (!getProviderConfig().apiUrl) throw new Error('建模服务尚未配置，请先打开设置完成配置');
        imageNames = normalizeUploadedImages(req.files || []);
        const settings = settingsDb.get(req.user.id);
        const defaultSkills = (settings.default_skill_ids || [settings.default_skill_id]).map(id => skillDb.findById(id, req.user.id)).filter(Boolean);
        const extraIds = safeStringList(req.body.skill_ids).slice(0, 3);
        const extraSkills = extraIds.map(id => skillDb.findById(id, req.user.id)).filter(Boolean);
        const inlineSkill = String(req.body.inline_skill || '').trim();
        if (inlineSkill.length > 1000) throw new Error('本次临时 Skill 不能超过 1000 字');
        const prompt = String(req.body.prompt || '').trim();
        if (prompt.length > 1000) throw new Error('建模提示词不能超过 1000 字');
        if (extraSkills.length !== extraIds.length) throw new Error('所选 Skill 不存在或不属于当前用户');
        const snapshot = createSkillSnapshot(defaultSkills, extraSkills, inlineSkill);
        if (buildProviderPrompt(snapshot, prompt).length > 12000) throw new Error('提示词与 Skill 合并后超过 12000 字，请精简内容');
        const assetKind = ASSET_KINDS.includes(req.body.asset_kind) ? req.body.asset_kind : 'prop';
        const profile = PROFILES.includes(req.body.profile) ? req.body.profile : 'xhs_mobile';
        const availableChannels = getChannelStatus();
        const requestedChannels = safeStringList(req.body.channels, CHANNELS).filter(channel => availableChannels[channel]?.configured);
        let name = String(req.body.name || path.parse(req.files[0].originalname).name || '新模型').trim().slice(0, 80);
        if (name.length < 2) name = `${name || '新'}模型`;
        const job = jobDb.create({
            owner_id: req.user.id,
            name,
            input: { images: imageNames, prompt, asset_kind: assetKind, profile, seed: parseSeed(req.body.seed) },
            skill_snapshot: snapshot,
            requested_channels: requestedChannels,
            base_url: process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`
        });
        modelWorker.wake();
        res.status(202).json({ success: true, data: jobWithNotifications(job) });
    } catch (error) {
        if (!imageNames.length) removeFiles(req.files || []);
        else removeFiles(imageNames.map(filename => ({ path: path.join(uploadDir, filename) })));
        res.status(400).json({ success: false, error: error.message });
    }
});

app.get('/api/jobs', requireUser, (req, res) => {
    res.json({ success: true, data: jobDb.list(req.query.limit, req.user.id).map(jobWithNotifications) });
});

app.get('/api/jobs/:id', requireUser, (req, res) => {
    const job = jobDb.findById(req.params.id);
    if (!job || job.owner_id !== req.user.id) return res.status(404).json({ success: false, error: '任务不存在' });
    res.json({ success: true, data: jobWithNotifications(job) });
});

app.post('/api/jobs/:id/retry', requireUser, (req, res) => {
    const job = jobDb.findById(req.params.id);
    if (!job || job.owner_id !== req.user.id) return res.status(404).json({ success: false, error: '任务不存在' });
    if (job.status !== 'failed') return res.status(400).json({ success: false, error: '只有失败任务可以重试' });
    const next = jobDb.update(job.id, {
        status: 'queued',
        progress_message: '已重新进入队列',
        attempt: 0,
        provider: null,
        error: null,
        next_run_at: new Date().toISOString()
    });
    modelWorker.wake();
    res.json({ success: true, data: jobWithNotifications(next) });
});

app.get('/api/models', requireUser, (req, res) => {
    res.json({ success: true, data: modelDb.list().filter(model => jobDb.findById(model.job_id)?.owner_id === req.user.id) });
});

app.get('/api/models/:id', requireUser, (req, res) => {
    const model = modelDb.findById(req.params.id);
    if (!model || jobDb.findById(model.job_id)?.owner_id !== req.user.id) return res.status(404).json({ success: false, error: '模型不存在' });
    res.json({ success: true, data: model });
});

app.delete('/api/models/:id', requireUser, (req, res) => {
    const model = modelDb.findById(req.params.id);
    if (!model || jobDb.findById(model.job_id)?.owner_id !== req.user.id) return res.status(404).json({ success: false, error: '模型不存在' });
    if (model.model_file) {
        const modelPath = path.join(modelDir, path.basename(model.model_file));
        if (fs.existsSync(modelPath)) fs.unlinkSync(modelPath);
    }
    modelDb.delete(model.id);
    res.json({ success: true });
});

app.post('/api/models/upload', (req, res) => res.status(410).json({ success: false, error: '请使用新的多图异步任务接口 /api/jobs' }));
app.post('/api/models/:id/generate', (req, res) => res.status(410).json({ success: false, error: '请使用新的多图异步任务接口 /api/jobs' }));

app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        status: 'running',
        provider_configured: Boolean(getProviderConfig().apiUrl),
        stats: getStats(),
        timestamp: new Date().toISOString()
    });
});

app.use('/api', (req, res) => res.status(404).json({ success: false, error: '接口不存在' }));
app.use((req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
app.use((error, req, res, next) => {
    removeFiles(req.files || (req.file ? [req.file] : []));
    if (error instanceof multer.MulterError) {
        const messages = { LIMIT_FILE_SIZE: '单张图片不能超过 10 MB', LIMIT_FILE_COUNT: `最多上传 ${MAX_IMAGES} 张图片`, LIMIT_UNEXPECTED_FILE: '上传字段不正确或图片数量过多' };
        return res.status(400).json({ success: false, error: messages[error.code] || error.message });
    }
    console.error(error);
    res.status(500).json({ success: false, error: '服务器处理失败，请稍后重试' });
});

const notificationWorker = startNotificationWorker();
const modelWorker = startModelWorker();

app.listen(PORT, '0.0.0.0', () => {
    console.log(`3D 建模工作室已启动，端口 ${PORT}`);
    console.log(`建模服务：${getProviderConfig().apiUrl ? '已配置' : '未配置'}`);
});

process.on('SIGTERM', () => {
    modelWorker.stop();
    notificationWorker.stop();
    process.exit(0);
});
