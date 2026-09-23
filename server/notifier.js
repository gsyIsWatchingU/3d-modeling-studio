const nodemailer = require('nodemailer');
const { configDb, jobDb, notificationDb, factoryDb } = require('./db');

function getEffectiveConfig(userId) {
    const stored = configDb.getNotifications(userId);
    // 旧的全局配置只供无归属的历史任务使用，不能作为其他账号的默认收件人。
    const env = userId === undefined || userId === null ? process.env : {};
    return {
        email: {
            recipient: env.NOTIFY_EMAIL_TO || stored.email.recipient || '',
            smtp_host: env.SMTP_HOST || stored.email.smtp_host || '',
            smtp_port: Number(env.SMTP_PORT || stored.email.smtp_port || 465),
            smtp_secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : stored.email.smtp_secure !== false,
            smtp_user: env.SMTP_USER || stored.email.smtp_user || '',
            smtp_pass: env.SMTP_PASS || stored.email.smtp_pass || ''
        },
        feishu: { webhook: env.FEISHU_WEBHOOK || stored.feishu.webhook || '' },
        wecom: { webhook: env.WECOM_WEBHOOK || stored.wecom.webhook || '' }
    };
}

function getChannelStatus(userId) {
    const config = getEffectiveConfig(userId);
    return {
        email: {
            label: '邮箱',
            configured: Boolean(config.email.recipient && config.email.smtp_host && config.email.smtp_user && config.email.smtp_pass),
            recipient: config.email.recipient ? maskEmail(config.email.recipient) : ''
        },
        feishu: { label: '飞书', configured: Boolean(config.feishu.webhook) },
        wecom: { label: '企业微信', configured: Boolean(config.wecom.webhook) }
    };
}

function maskEmail(value) {
    const [name, domain] = String(value).split('@');
    if (!domain) return '已填写';
    return `${name.slice(0, 2)}***@${domain}`;
}

function buildMessage(job) {
    const succeeded = job.status === 'succeeded';
    if (job.kind === 'game') return [succeeded ? '游戏版本生产完成，待试玩验收' : '游戏版本生产失败', `项目：${job.name}`,
        succeeded ? '策划、剧本、素材、声音和浏览器试玩包已保存。' : `原因：${job.error?.message || '生产失败'}`,
        job.base_url ? `查看：${job.base_url.replace(/\/$/, '')}/?project=${encodeURIComponent(job.project_id)}` : ''].filter(Boolean).join('\n');
    const resultUrl = job.base_url ? `${job.base_url.replace(/\/$/, '')}/modeling.html?job=${encodeURIComponent(job.id)}` : '';
    return [
        succeeded ? '3D 模型生成完成' : '3D 模型生成失败',
        `任务：${job.id} · ${job.name}`,
        succeeded ? '模型文件已保存并通过 GLB 校验。' : `原因：${job.error?.message || '建模任务未完成'}`,
        resultUrl ? `查看结果：${resultUrl}` : ''
    ].filter(Boolean).join('\n');
}

async function postWebhook(url, body) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`通知服务返回 HTTP ${response.status}`);
    const text = await response.text();
    if (text) {
        try {
            const data = JSON.parse(text);
            const code = data.code ?? data.StatusCode ?? data.errcode;
            if (code !== undefined && Number(code) !== 0) throw new Error(data.msg || data.StatusMessage || data.errmsg || '通知服务拒绝请求');
        } catch (error) {
            if (error instanceof SyntaxError) return;
            throw error;
        }
    }
}

async function sendChannel(channel, job) {
    const config = getEffectiveConfig(job.owner_id);
    const text = buildMessage(job);
    if (channel === 'email') {
        if (!getChannelStatus(job.owner_id).email.configured) throw new Error('邮箱通知尚未完整配置');
        const transport = nodemailer.createTransport({
            host: config.email.smtp_host,
            port: config.email.smtp_port,
            secure: config.email.smtp_secure,
            auth: { user: config.email.smtp_user, pass: config.email.smtp_pass },
            connectionTimeout: 15000,
            greetingTimeout: 15000,
            socketTimeout: 20000
        });
        await transport.sendMail({
            from: config.email.smtp_user,
            to: config.email.recipient,
            subject: `${job.kind === 'game' ? '游戏生产' : '建模'}${job.status === 'succeeded' ? '已完成' : '失败'} · ${job.name}`,
            text
        });
        return;
    }
    if (channel === 'feishu') {
        if (!config.feishu.webhook) throw new Error('飞书通知尚未配置');
        await postWebhook(config.feishu.webhook, { msg_type: 'text', content: { text } });
        return;
    }
    if (channel === 'wecom') {
        if (!config.wecom.webhook) throw new Error('企业微信通知尚未配置');
        await postWebhook(config.wecom.webhook, { msgtype: 'text', text: { content: text } });
        return;
    }
    throw new Error('未知通知通道');
}

function enqueueJobNotifications(job, event) {
    for (const channel of job.requested_channels || []) {
        notificationDb.enqueue({
            job_id: job.id,
            event,
            channel,
            idempotency_key: `${job.id}:${event}:${channel}`
        });
    }
}

function startNotificationWorker() {
    notificationDb.recoverInterrupted();
    let running = false;
    let timer;

    async function tick() {
        if (running) return;
        const delivery = notificationDb.claimNext();
        if (!delivery) return;
        running = true;
        try {
            let job = jobDb.findById(delivery.job_id);
            if (!job && delivery.job_id.startsWith('F')) {
                const p = factoryDb.all().find(p => p.runs.some(r => r.id === delivery.job_id));
                if (p) {
                    const r = p.runs.find(r => r.id === delivery.job_id);
                    job = { id: r.id, name: `${p.name} · 第 ${r.version} 版`, kind: 'game', project_id: p.id, owner_id: p.owner_id,
                        status: delivery.event === 'succeeded' ? 'succeeded' : 'failed', base_url: r.base_url, error: { message: r.error || '该次生产失败，可在网站查看最新状态' } };
                }
            }
            if (!job) throw new Error('通知对应的任务不存在');
            await sendChannel(delivery.channel, job);
            notificationDb.update(delivery.id, { status: 'sent', sent_at: new Date().toISOString(), last_error: null });
        } catch (error) {
            const exhausted = delivery.attempts >= delivery.max_attempts;
            notificationDb.update(delivery.id, {
                status: exhausted ? 'failed' : 'retry_wait',
                next_run_at: new Date(Date.now() + Math.min(300000, 15000 * (2 ** Math.max(0, delivery.attempts - 1)))).toISOString(),
                last_error: error.message
            });
        } finally {
            running = false;
        }
    }

    timer = setInterval(tick, 5000);
    timer.unref();
    tick();
    return { wake: tick, stop: () => clearInterval(timer) };
}

module.exports = { getEffectiveConfig, getChannelStatus, sendChannel, enqueueJobNotifications, startNotificationWorker };
