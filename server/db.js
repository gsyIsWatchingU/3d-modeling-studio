const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'db.json');
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
const modelDir = process.env.MODEL_DIR || path.join(__dirname, '..', 'models');

const BUILTIN_SKILL = {
    id: 'skill-general',
    name: '通用高质量建模',
    description: '优先保证主体完整、比例正确、材质清晰，适合大多数物体。',
    content: '保持参考图中的主体轮廓、比例与关键结构。补全被遮挡区域，避免悬空碎片、破面和明显噪点。材质应清晰、自然且便于后续编辑。',
    version: 1,
    enabled: true,
    builtin: true,
    created_at: '2026-09-21T00:00:00.000Z',
    updated_at: '2026-09-21T00:00:00.000Z'
};

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

ensureDir(path.dirname(dbPath));
ensureDir(uploadDir);
ensureDir(modelDir);

function initialData() {
    return {
        models: [],
        jobs: [],
        skills: [BUILTIN_SKILL],
        notifications: [],
        users: [],
        sessions: [],
        api_tokens: [],
        user_notifications: {},
        settings: { default_skill_ids: [BUILTIN_SKILL.id], default_skill_id: BUILTIN_SKILL.id },
        user_settings: {},
        spu_config: { provider: 'forge3d', api_url: '', api_key: '' },
        notification_config: {
            email: { recipient: '', smtp_host: '', smtp_port: 465, smtp_secure: true, smtp_user: '', smtp_pass: '' },
            feishu: { webhook: '' },
            wecom: { webhook: '' }
        },
        nextId: 1,
        nextJobId: 1,
        nextSkillId: 1,
        nextNotificationId: 1,
        nextUserId: 1
    };
}

function normalizeDb(raw) {
    const defaults = initialData();
    const db = raw && typeof raw === 'object' ? raw : {};
    db.models = Array.isArray(db.models) ? db.models : [];
    db.jobs = Array.isArray(db.jobs) ? db.jobs : [];
    db.skills = Array.isArray(db.skills) ? db.skills : [];
    db.notifications = Array.isArray(db.notifications) ? db.notifications : [];
    db.users = Array.isArray(db.users) ? db.users : [];
    db.sessions = Array.isArray(db.sessions) ? db.sessions : [];
    db.api_tokens = Array.isArray(db.api_tokens) ? db.api_tokens : [];
    db.user_notifications = db.user_notifications && typeof db.user_notifications === 'object' ? db.user_notifications : {};
    db.user_settings = db.user_settings && typeof db.user_settings === 'object' ? db.user_settings : {};
    if (!db.skills.some(skill => skill.id === BUILTIN_SKILL.id)) db.skills.unshift(BUILTIN_SKILL);
    db.settings = { ...defaults.settings, ...(db.settings || {}) };
    if (!Array.isArray(db.settings.default_skill_ids)) db.settings.default_skill_ids = [db.settings.default_skill_id || BUILTIN_SKILL.id];
    db.settings.default_skill_ids = [...new Set([BUILTIN_SKILL.id, ...db.settings.default_skill_ids])]
        .filter(id => db.skills.some(skill => skill.id === id));
    db.settings.default_skill_id = db.settings.default_skill_ids[0] || BUILTIN_SKILL.id;
    db.spu_config = { ...defaults.spu_config, ...(db.spu_config || {}) };
    db.notification_config = {
        email: { ...defaults.notification_config.email, ...(db.notification_config?.email || {}) },
        feishu: { ...defaults.notification_config.feishu, ...(db.notification_config?.feishu || {}) },
        wecom: { ...defaults.notification_config.wecom, ...(db.notification_config?.wecom || {}) }
    };
    db.nextId = Number.isInteger(db.nextId) ? db.nextId : 1;
    db.nextJobId = Number.isInteger(db.nextJobId) ? db.nextJobId : 1;
    db.nextSkillId = Number.isInteger(db.nextSkillId) ? db.nextSkillId : 1;
    db.nextNotificationId = Number.isInteger(db.nextNotificationId) ? db.nextNotificationId : 1;
    db.nextUserId = Number.isInteger(db.nextUserId) ? db.nextUserId : 1;
    return db;
}

function writeDb(data) {
    const tempPath = `${dbPath}.${process.pid}.${Date.now()}.tmp`;
    const fd = fs.openSync(tempPath, 'w', 0o600);
    try {
        fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(tempPath, dbPath);
}

function initDb() {
    if (!fs.existsSync(dbPath)) {
        writeDb(initialData());
        return;
    }
    const current = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    const normalized = normalizeDb(current);
    if (JSON.stringify(current) !== JSON.stringify(normalized)) writeDb(normalized);
}

function readDb() {
    return normalizeDb(JSON.parse(fs.readFileSync(dbPath, 'utf8')));
}

function mutate(mutator) {
    const db = readDb();
    const result = mutator(db);
    writeDb(db);
    return result;
}

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

initDb();

const modelDb = {
    create(data) {
        return mutate(db => {
            const id = db.nextId++;
            const now = new Date().toISOString();
            const model = {
                id,
                name: data.name,
                original_image: data.original_image || data.original_images?.[0] || '',
                original_images: data.original_images || (data.original_image ? [data.original_image] : []),
                prompt: data.prompt || '',
                skill_snapshot: data.skill_snapshot || null,
                job_id: data.job_id || null,
                status: data.status || 'completed',
                model_file: data.model_file || null,
                file_size: data.file_size || null,
                sha256: data.sha256 || null,
                created_at: now,
                updated_at: now
            };
            db.models.push(model);
            return clone(model);
        });
    },
    update(id, data) {
        return mutate(db => {
            const model = db.models.find(item => item.id === Number(id));
            if (!model) return null;
            Object.assign(model, data, { updated_at: new Date().toISOString() });
            return clone(model);
        });
    },
    findById(id) {
        return clone(readDb().models.find(item => item.id === Number(id)) || null);
    },
    list() {
        return clone(readDb().models.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
    },
    delete(id) {
        return mutate(db => {
            const before = db.models.length;
            db.models = db.models.filter(item => item.id !== Number(id));
            return before !== db.models.length;
        });
    }
};

const skillDb = {
    list(userId) {
        return clone(readDb().skills.filter(skill => skill.enabled !== false && (userId === undefined || skill.builtin || skill.owner_id === userId)));
    },
    findById(id, userId) {
        return clone(readDb().skills.find(skill => skill.id === id && skill.enabled !== false && (userId === undefined || skill.builtin || skill.owner_id === userId)) || null);
    },
    create(data) {
        return mutate(db => {
            const now = new Date().toISOString();
            const skill = {
                id: `skill-custom-${db.nextSkillId++}`,
                name: data.name,
                description: data.description || '',
                content: data.content,
                version: 1,
                enabled: true,
                builtin: false,
                owner_id: data.owner_id ?? null,
                created_at: now,
                updated_at: now
            };
            db.skills.push(skill);
            return clone(skill);
        });
    },
    delete(id, userId) {
        return mutate(db => {
            const skill = db.skills.find(item => item.id === id);
            if (!skill || skill.builtin || (userId !== undefined && skill.owner_id !== userId)) return false;
            db.skills = db.skills.filter(item => item.id !== id);
            db.settings.default_skill_ids = (db.settings.default_skill_ids || []).filter(skillId => skillId !== id);
            db.settings.default_skill_id = db.settings.default_skill_ids[0] || BUILTIN_SKILL.id;
            for (const settings of Object.values(db.user_settings)) {
                settings.default_skill_ids = (settings.default_skill_ids || []).filter(skillId => skillId !== id);
                settings.default_skill_id = settings.default_skill_ids[0] || BUILTIN_SKILL.id;
            }
            return true;
        });
    }
};

const settingsDb = {
    get(userId) {
        const db = readDb();
        if (userId === undefined) return clone(db.settings);
        const settings = db.user_settings[String(userId)] || { default_skill_ids: [BUILTIN_SKILL.id], default_skill_id: BUILTIN_SKILL.id };
        return clone(settings);
    },
    save(data, userId) {
        return mutate(db => {
            if (userId !== undefined) {
                const ids = [...new Set([BUILTIN_SKILL.id, ...(data.default_skill_ids || [])])];
                if (ids.some(id => !db.skills.some(skill => skill.id === id && (skill.builtin || skill.owner_id === userId)))) throw new Error('只能固定自己的 Skill');
                db.user_settings[String(userId)] = { default_skill_ids: ids, default_skill_id: ids[0] };
                return clone(db.user_settings[String(userId)]);
            }
            db.settings = { ...db.settings, ...data };
            return clone(db.settings);
        });
    }
};

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

// ---------- 统一账号用户（密码只存在账号中心，本地仅存 ssoSubject 关联键） ----------
const userDb = {
    findById(id) {
        return clone(readDb().users.find(user => user.id === Number(id)) || null);
    },
    findBySsoSubjectOrEmail(ssoSubject, email) {
        return clone(readDb().users.find(user =>
            (ssoSubject && user.ssoSubject === ssoSubject) ||
            (email && (user.email === email || user.username === email))
        ) || null);
    },
    // upsert：按 ssoSubject 或 email 命中则更新关联字段，未命中则插入（密码列写占位符）
    upsertSsoUser(user) {
        const displayName = String(user.name || user.email.split('@')[0]).trim().slice(0, 40);
        return mutate(db => {
            const existing = db.users.find(item =>
                (user.id && item.ssoSubject === user.id) ||
                (user.email && (item.email === user.email || item.username === user.email))
            );
            if (existing) {
                existing.email = user.email;
                existing.ssoSubject = user.id;
                existing.displayName = displayName;
                return clone(existing);
            }
            const id = db.nextUserId++;
            const local = {
                id,
                username: user.email,
                password: `sso:${crypto.randomBytes(16).toString('hex')}`,
                email: user.email,
                ssoSubject: user.id,
                displayName,
                isAdmin: 0,
                createdAt: new Date().toISOString()
            };
            db.users.push(local);
            return clone(local);
        });
    }
};

// ---------- 本地会话：随机 token + HttpOnly Cookie，30 天有效 ----------
const sessionDb = {
    create(userId) {
        const token = crypto.randomBytes(32).toString('base64url');
        const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
        mutate(db => {
            db.sessions.push({ token, userId, expiresAt, createdAt: new Date().toISOString() });
        });
        return token;
    },
    // 返回 { user, session }；token 不存在或已过期返回 null
    findByToken(token) {
        if (!token) return null;
        const session = readDb().sessions.find(item => item.token === token && new Date(item.expiresAt) > new Date());
        if (!session) return null;
        const user = userDb.findById(session.userId);
        return user ? { user, session } : null;
    },
    deleteByToken(token) {
        return mutate(db => {
            const before = db.sessions.length;
            db.sessions = db.sessions.filter(item => item.token !== token);
            return before !== db.sessions.length;
        });
    }
};

// MCP 凭证只保存摘要；账号归属始终由服务端决定。
const apiTokenDb = {
    create(userId, name) {
        const token = `studio_${crypto.randomBytes(32).toString('base64url')}`;
        const record = {
            id: crypto.randomUUID(), userId, name: String(name || 'AI 客户端').trim().slice(0, 60),
            hash: crypto.createHash('sha256').update(token).digest('hex'),
            created_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 90 * 86400000).toISOString()
        };
        mutate(db => {
            if (!db.users.some(user => user.id === userId)) throw new Error('用户不存在');
            if (db.api_tokens.filter(item => item.userId === userId && new Date(item.expires_at) > new Date()).length >= 20) throw new Error('最多保留 20 个有效凭证，请先撤销旧凭证');
            db.api_tokens.push(record);
        });
        const { hash, ...metadata } = record;
        return { ...metadata, token };
    },
    list(userId) {
        return readDb().api_tokens.filter(item => item.userId === userId).map(({ hash, ...item }) => item);
    },
    authenticate(token) {
        if (!/^studio_[A-Za-z0-9_-]{43}$/.test(token || '')) return null;
        const hash = crypto.createHash('sha256').update(token).digest('hex');
        const db = readDb();
        const record = db.api_tokens.find(item => item.hash === hash && new Date(item.expires_at) > new Date());
        return record ? clone(db.users.find(user => user.id === record.userId) || null) : null;
    },
    revoke(id, userId) {
        return mutate(db => {
            const before = db.api_tokens.length;
            db.api_tokens = db.api_tokens.filter(item => item.id !== id || item.userId !== userId);
            return before !== db.api_tokens.length;
        });
    }
};

const jobDb = {
    create(data) {
        return mutate(db => {
            const now = new Date().toISOString();
            const id = `J${String(db.nextJobId++).padStart(6, '0')}`;
            const job = {
                id,
                name: data.name,
                status: 'queued',
                progress_message: '已进入队列',
                input: data.input,
                skill_snapshot: data.skill_snapshot,
                owner_id: data.owner_id ?? null,
                requested_channels: data.requested_channels || [],
                base_url: data.base_url || '',
                attempt: 0,
                max_attempts: data.max_attempts || 3,
                next_run_at: now,
                provider: null,
                output: null,
                error: null,
                created_at: now,
                updated_at: now
            };
            db.jobs.push(job);
            return clone(job);
        });
    },
    findById(id) {
        return clone(readDb().jobs.find(job => job.id === id) || null);
    },
    list(limit = 30, userId) {
        return clone(readDb().jobs
            .filter(job => userId === undefined || job.owner_id === userId)
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
            .slice(0, Math.max(1, Math.min(Number(limit) || 30, 100))));
    },
    update(id, data) {
        return mutate(db => {
            const job = db.jobs.find(item => item.id === id);
            if (!job) return null;
            Object.assign(job, data, { updated_at: new Date().toISOString() });
            return clone(job);
        });
    },
    claimNext() {
        return mutate(db => {
            const now = new Date();
            const job = db.jobs
                .filter(item => item.status === 'queued' || item.status === 'retry_wait')
                .filter(item => !item.next_run_at || new Date(item.next_run_at) <= now)
                .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0];
            if (!job) return null;
            job.status = 'generating';
            job.progress_message = job.provider?.task_id ? '正在恢复建模任务' : '正在提交建模任务';
            job.attempt = (job.attempt || 0) + 1;
            job.started_at = job.started_at || now.toISOString();
            job.updated_at = now.toISOString();
            return clone(job);
        });
    },
    recoverInterrupted() {
        return mutate(db => {
            let count = 0;
            const now = new Date().toISOString();
            for (const job of db.jobs) {
                if (['generating', 'downloading', 'validating'].includes(job.status)) {
                    job.status = 'queued';
                    job.progress_message = '服务恢复，任务将继续';
                    job.next_run_at = now;
                    job.updated_at = now;
                    count += 1;
                }
            }
            return count;
        });
    }
};

const notificationDb = {
    enqueue(data) {
        return mutate(db => {
            const existing = db.notifications.find(item => item.idempotency_key === data.idempotency_key);
            if (existing) return clone(existing);
            const now = new Date().toISOString();
            const delivery = {
                id: `N${String(db.nextNotificationId++).padStart(6, '0')}`,
                job_id: data.job_id,
                event: data.event,
                channel: data.channel,
                idempotency_key: data.idempotency_key,
                status: 'pending',
                attempts: 0,
                max_attempts: 5,
                next_run_at: now,
                last_error: null,
                created_at: now,
                updated_at: now
            };
            db.notifications.push(delivery);
            return clone(delivery);
        });
    },
    listForJob(jobId) {
        return clone(readDb().notifications.filter(item => item.job_id === jobId));
    },
    claimNext() {
        return mutate(db => {
            const now = new Date();
            const delivery = db.notifications
                .filter(item => item.status === 'pending' || item.status === 'retry_wait')
                .filter(item => !item.next_run_at || new Date(item.next_run_at) <= now)
                .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0];
            if (!delivery) return null;
            delivery.status = 'sending';
            delivery.attempts += 1;
            delivery.updated_at = now.toISOString();
            return clone(delivery);
        });
    },
    update(id, data) {
        return mutate(db => {
            const delivery = db.notifications.find(item => item.id === id);
            if (!delivery) return null;
            Object.assign(delivery, data, { updated_at: new Date().toISOString() });
            return clone(delivery);
        });
    },
    recoverInterrupted() {
        return mutate(db => {
            let count = 0;
            for (const delivery of db.notifications) {
                if (delivery.status === 'sending') {
                    delivery.status = 'retry_wait';
                    delivery.next_run_at = new Date(Date.now() + 30000).toISOString();
                    delivery.last_error = '服务重启，等待安全重试';
                    count += 1;
                }
            }
            return count;
        });
    }
};

const configDb = {
    get() {
        return clone(readDb().spu_config);
    },
    save(data) {
        return mutate(db => {
            db.spu_config = { ...db.spu_config, ...data, updated_at: new Date().toISOString() };
            return clone(db.spu_config);
        });
    },
    getNotifications(userId) {
        const db = readDb();
        if (userId === undefined || userId === null) return clone(db.notification_config);
        const defaults = initialData().notification_config;
        const stored = db.user_notifications[String(userId)] || {};
        return Object.fromEntries(['email', 'feishu', 'wecom'].map(channel => [channel, { ...defaults[channel], ...stored[channel] }]));
    },
    saveNotifications(data, userId) {
        return mutate(db => {
            const config = userId === undefined || userId === null ? db.notification_config
                : (db.user_notifications[String(userId)] ||= initialData().notification_config);
            for (const channel of ['email', 'feishu', 'wecom']) {
                if (data[channel]) config[channel] = { ...config[channel], ...data[channel] };
            }
            return clone(config);
        });
    }
};

function getStats() {
    const db = readDb();
    const jobCounts = {};
    for (const job of db.jobs) jobCounts[job.status] = (jobCounts[job.status] || 0) + 1;
    return { models: db.models.length, jobs: jobCounts, skills: db.skills.length };
}

module.exports = {
    modelDb,
    skillDb,
    settingsDb,
    jobDb,
    notificationDb,
    configDb,
    userDb,
    sessionDb,
    apiTokenDb,
    getStats,
    dbPath,
    uploadDir,
    modelDir,
    BUILTIN_SKILL
};
