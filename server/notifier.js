const nodemailer = require('nodemailer');
const { configDb, jobDb, notificationDb } = require('./db');

function getEffectiveConfig() {
    const stored = configDb.getNotifications();
    return {
        email: {
            recipient: process.env.NOTIFY_EMAIL_TO || stored.email.recipient || '',
            smtp_host: process.env.SMTP_HOST || stored.email.smtp_host || '',
            smtp_port: Number(process.env.SMTP_PORT || stored.email.smtp_port || 465),
            smtp_secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : stored.email.smtp_secure !== false,
            smtp_user: process.env.SMTP_USER || stored.email.smtp_user || '',
            smtp_pass: process.env.SMTP_PASS || stored.email.smtp_pass || ''
        },
        feishu: { webhook: process.env.FEISHU_WEBHOOK || stored.feishu.webhook || '' },
        wecom: { webhook: process.env.WECOM_WEBHOOK || stored.wecom.webhook || '' }
    };
}

function getChannelStatus() {
    const config = getEffectiveConfig();
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
    const resultUrl = job.base_url ? `${job.base_url.replace(/\/$/, '')}/?job=${encodeURIComponent(job.id)}` : '';
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
    const config = getEffectiveConfig();
    const text = buildMessage(job);
    if (channel === 'email') {
        if (!getChannelStatus().email.configured) throw new Error('邮箱通知尚未完整配置');
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
            subject: job.status === 'succeeded' ? `模型已完成 · ${job.name}` : `模型生成失败 · ${job.name}`,
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
            const job = jobDb.findById(delivery.job_id);
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
