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
        // 建模资源库：跨机器共享的建模资产清单（GPU 服务器扫描 / 本机登记 / 上传到服务器）
        resources: [],
        jobs: [],
        skills: [BUILTIN_SKILL],
        notifications: [],
        users: [],
        sessions: [],
        api_tokens: [],
        production_plans: [],
        factory_projects: [],
        studio_assets: [],
        studio_plans: [],
        studio_tasks: [],
        studio_shares: [],
        studio_configs: {},
        user_notifications: {},
        // ForgeLoop 自进化经验库：不可变 Attempt、结构化复盘、策略、受控实验
        learning_attempts: [],
        retrospectives: [],
        modeling_policies: [],
        experiments: [],
        // ForgeLoop v2：统一生产契约（按项目 ID 存储，文档含 sha256 证据锚点）
        production_contracts: [],
        // ForgeLoop v3：无人值守自动闭环（策略版本、champion、自动循环锁）
        v3_policies: [],
        champions: [],
        auto_locks: [],
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
        nextUserId: 1,
        nextLearningId: 1,
        nextRetroId: 1
    };
}

function normalizeDb(raw) {
    const defaults = initialData();
    const db = raw && typeof raw === 'object' ? raw : {};
    db.models = Array.isArray(db.models) ? db.models : [];
    // 建模资源库：幂等回填（旧库自动补空集合）
    db.resources = Array.isArray(db.resources) ? db.resources : [];
    db.jobs = Array.isArray(db.jobs) ? db.jobs : [];
    db.skills = Array.isArray(db.skills) ? db.skills : [];
    db.notifications = Array.isArray(db.notifications) ? db.notifications : [];
    db.users = Array.isArray(db.users) ? db.users : [];
    db.sessions = Array.isArray(db.sessions) ? db.sessions : [];
    db.api_tokens = Array.isArray(db.api_tokens) ? db.api_tokens : [];
    db.production_plans = Array.isArray(db.production_plans) ? db.production_plans : [];
    db.factory_projects = Array.isArray(db.factory_projects) ? db.factory_projects : [];
    for (const key of ['studio_assets', 'studio_plans', 'studio_tasks', 'studio_shares']) db[key] = Array.isArray(db[key]) ? db[key] : [];
    db.studio_configs = db.studio_configs && typeof db.studio_configs === 'object' ? db.studio_configs : {};
    db.learning_attempts = Array.isArray(db.learning_attempts) ? db.learning_attempts : [];
    db.retrospectives = Array.isArray(db.retrospectives) ? db.retrospectives : [];
    db.modeling_policies = Array.isArray(db.modeling_policies) ? db.modeling_policies : [];
    db.experiments = Array.isArray(db.experiments) ? db.experiments : [];
    db.production_contracts = Array.isArray(db.production_contracts) ? db.production_contracts : [];
    db.v3_policies = Array.isArray(db.v3_policies) ? db.v3_policies : [];
    db.champions = Array.isArray(db.champions) ? db.champions : [];
    db.auto_locks = Array.isArray(db.auto_locks) ? db.auto_locks : [];
    // ForgeLoop v2 幂等回填：旧 Attempt 只增字段（domain 回填为 model），不重命名/不删除现有数据。
    // 重复 normalize 不会产生第二次变更，迁移天然幂等。
    for (const attempt of db.learning_attempts) {
        if (attempt.domain === undefined) attempt.domain = 'model';
        if (attempt.project === undefined) attempt.project = null;
        if (attempt.stage === undefined) attempt.stage = null;
        if (attempt.asset_id === undefined) attempt.asset_id = null;
        if (attempt.event_id === undefined) attempt.event_id = null;
        if (attempt.evidence === undefined) attempt.evidence = {};
        if (attempt.contract_hash === undefined) attempt.contract_hash = null;
        // ForgeLoop v3：旧 Attempt 回填无人值守状态（默认停留在旧流程语义）
        if (attempt.auto_flow_state === undefined) attempt.auto_flow_state = 'exhausted';
        if (attempt.acceptance_mode === undefined) attempt.acceptance_mode = null;
        if (attempt.human_review === undefined) attempt.human_review = 'not_performed';
        if (attempt.auto_flow_history === undefined) attempt.auto_flow_history = [];
    }
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
    db.nextLearningId = Number.isInteger(db.nextLearningId) ? db.nextLearningId : Math.max(1, ...db.learning_attempts.map(a => Number(String(a.id).replace(/\D/g, '')) || 0) + 1);
    db.nextRetroId = Number.isInteger(db.nextRetroId) ? db.nextRetroId : Math.max(1, ...db.retrospectives.map(r => Number(String(r.id).replace(/\D/g, '')) || 0) + 1);
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
    // normalizeDb 原地改造 raw 对象，必须先克隆再比较，否则恒等导致回填永不落盘
    const before = JSON.parse(JSON.stringify(current));
    const normalized = normalizeDb(current);
    if (JSON.stringify(before) !== JSON.stringify(normalized)) writeDb(normalized);
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
                production_plan_id: data.production_plan_id || null,
                requested_channels: data.requested_channels || [],
                base_url: data.base_url || '',
                ...(data.studio_plan_id ? { studio_plan_id: data.studio_plan_id } : {}),
                attempt: 0,
                max_attempts: data.max_attempts || 3,
                next_run_at: now,
                provider: null,
                output: null,
                error: null,
                // ForgeLoop 修复链字段：单变量覆盖、父 Attempt 依据、父执行计划 SHA、覆盖后的执行计划
                ...(data.based_on_attempt_id ? { based_on_attempt_id: data.based_on_attempt_id } : {}),
                ...(data.changed_variable ? { changed_variable: data.changed_variable } : {}),
                ...(data.repair_variable ? { repair_variable: data.repair_variable } : {}),
                ...(data.parent_plan_sha ? { parent_plan_sha: data.parent_plan_sha } : {}),
                ...(data.execution_plan ? { execution_plan: data.execution_plan } : {}),
                // ForgeLoop v2：领域/项目/阶段/资产/事件/证据/契约哈希（由任务创建方显式声明）
                ...(data.domain ? { domain: data.domain } : {}),
                ...(data.project ? { project: data.project } : {}),
                ...(data.stage ? { stage: data.stage } : {}),
                ...(data.asset_id ? { asset_id: data.asset_id } : {}),
                ...(data.event_id ? { event_id: data.event_id } : {}),
                ...(data.evidence ? { evidence: data.evidence } : {}),
                ...(data.contract_hash ? { contract_hash: data.contract_hash } : {}),
                // ForgeLoop v2 受限自动修复：输入/产物 SHA 锚点、门禁证据、执行器、自动修复标记
                ...(data.input_sha ? { input_sha: data.input_sha } : {}),
                ...(data.artifact_sha ? { artifact_sha: data.artifact_sha } : {}),
                ...(data.gate_evidence ? { gate_evidence: data.gate_evidence } : {}),
                ...(data.executor ? { executor: data.executor } : {}),
                ...(data.auto_repair ? { auto_repair: data.auto_repair } : {}),
                created_at: now,
                updated_at: now
            };
            db.jobs.push(job);
            return clone(job);
        });
    },
    listAll() {
        return clone(readDb().jobs);
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

const productionPlanDb = {
    create(data, userId) {
        return mutate(db => {
            if (db.production_plans.filter(plan => plan.owner_id === userId).length >= 100) throw new Error('最多保存 100 份制作计划');
            const plan = { ...clone(data), id: `P${crypto.randomUUID()}`, owner_id: userId, created_at: new Date().toISOString() };
            db.production_plans.push(plan);
            return clone(plan);
        });
    },
    findById(id, userId) {
        return clone(readDb().production_plans.find(plan => plan.id === id && plan.owner_id === userId) || null);
    },
    list(userId) {
        return readDb().production_plans.filter(plan => plan.owner_id === userId).reverse().map(({ stages, brief, ...plan }) => plan);
    }
};

// 工厂状态与原有账号/任务共用原子存储；生成文件单独保存，避免放大业务数据库。
const factoryDb = {
    list(userId) { return clone(readDb().factory_projects.filter(p => p.owner_id === userId).reverse()); },
    all() { return clone(readDb().factory_projects); },
    get(id, userId) { return clone(readDb().factory_projects.find(p => p.id === id && p.owner_id === userId) || null); },
    create(data, userId) {
        return mutate(db => {
            if (db.factory_projects.filter(p => p.owner_id === userId).length >= 40) throw new Error('每个账号最多保存 40 个游戏项目');
            const now = new Date().toISOString();
            const project = { ...clone(data), id: `G${crypto.randomUUID()}`, owner_id: userId, runs: [], created_at: now, updated_at: now };
            db.factory_projects.push(project); return clone(project);
        });
    },
    change(id, userId, fn) {
        return mutate(db => {
            const project = db.factory_projects.find(p => p.id === id && p.owner_id === userId);
            if (!project) throw new Error('游戏项目不存在');
            fn(project, db.factory_projects);
            project.updated_at = new Date().toISOString();
            return clone(project);
        });
    }
};

const studioDb = {
    list(collection, ownerId) { return clone(readDb()[`studio_${collection}`].filter(item => ownerId === undefined || item.owner_id === ownerId)); },
    get(collection, id, ownerId) { return this.list(collection, ownerId).find(item => item.id === id) || null; },
    create(collection, data, ownerId) {
        return mutate(db => {
            const item = { ...clone(data), id: crypto.randomUUID(), owner_id: ownerId, created_at: new Date().toISOString() };
            db[`studio_${collection}`].push(item); return clone(item);
        });
    },
    change(collection, id, ownerId, fn) {
        return mutate(db => {
            const item = db[`studio_${collection}`].find(value => value.id === id && value.owner_id === ownerId);
            if (!item) throw new Error('资源或任务不存在');
            fn(item); return clone(item);
        });
    },
    config(ownerId) { return clone(readDb().studio_configs[ownerId] || {}); },
    saveConfig(ownerId, data) { return mutate(db => { db.studio_configs[ownerId] = { ...(db.studio_configs[ownerId] || {}), ...data }; }); }
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

// ---------- ForgeLoop 自进化经验库 ----------
// Attempt 一旦写入即不可变：输入/参数/产物/指标快照只追加、不修改；
// 人工结论单独落在 human_* 字段，且只有审片动作能写入。
const learningDb = {
    listAttempts({ ownerId, limit = 50 } = {}) {
        return clone(readDb().learning_attempts
            .filter(a => ownerId === undefined || a.owner_id === ownerId)
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
            .slice(0, Math.max(1, Math.min(Number(limit) || 50, 500))));
    },
    findAttemptById(id) {
        return clone(readDb().learning_attempts.find(a => a.id === id) || null);
    },
    findAttemptByJobId(jobId) {
        return clone(readDb().learning_attempts.find(a => a.job_id === jobId) || null);
    },
    createAttempt(data) {
        return mutate(db => {
            const now = new Date().toISOString();
            const attempt = {
                id: `LA${String(db.nextLearningId++).padStart(6, '0')}`,
                job_id: data.job_id || null,
                owner_id: data.owner_id ?? null,
                // ForgeLoop v2：领域（model/animation/audio/integration/qa）、项目、阶段、资产/事件 ID
                domain: data.domain || 'model',
                project: data.project || null,
                stage: data.stage || null,
                asset_id: data.asset_id || null,
                event_id: data.event_id || null,
                evidence: data.evidence || {},            // 失败/警告证据：穿模帧、音频追踪、碰撞区域等
                contract_hash: data.contract_hash || null,
                asset_kind: data.asset_kind || 'prop',
                profile: data.profile || 'xhs_mobile',
                seed: data.seed ?? 1234,
                reference_shas: data.reference_shas || [],
                prompt: data.prompt || '',
                skill_snapshot_sha: data.skill_snapshot_sha || null,
                execution_plan: data.execution_plan || null,   // 实际提交 GPU 的执行计划快照（含 generation 与 sha）
                pipeline: data.pipeline || {},          // { provider, model, pipeline_version }
                metrics: data.metrics || {},            // 面数/材质/骨架/蒙皮/动画/耗时/显存/重试/QC
                artifacts: data.artifacts || {},        // { preview_url, glb_file, glb_sha, qc_report_sha }
                auto_status: data.auto_status || 'unknown', // succeeded / failed
                failure_category: data.failure_category || null,
                failure_detail: data.failure_detail || null,
                // ForgeLoop v3：无人值守自动闭环状态与验收模式
                auto_flow_state: data.auto_flow_state || 'generated', // generated/auto_evaluating/auto_repairing/auto_accepted/auto_rejected/exhausted/quarantined
                auto_flow_history: [],                                // append-only 状态迁移记录
                acceptance_mode: data.acceptance_mode || null,        // automatic / human
                human_review: data.human_review || 'not_performed',   // not_performed / performed
                auto_chain_index: data.auto_chain_index ?? 0,         // 无人循环第几轮（0=父，1..N=子）
                auto_evaluation: null,                                // 最近一次自动评估结果快照
                // 以下字段仅由人工审片/复盘追加，不回改输入快照
                human_verdict: 'pending',                // pending / approved / rejected
                human_category: null,
                human_notes: null,
                human_reviewed_at: null,
                based_on_attempt_id: data.based_on_attempt_id || null,
                changed_variable: data.changed_variable || null,
                experiment_id: data.experiment_id || null,
                created_at: now,
                updated_at: now
            };
            db.learning_attempts.push(attempt);
            return clone(attempt);
        });
    },
    // ForgeLoop v3：状态迁移（append-only），校验合法迁移表；绝不触碰 human_* 字段。
    setAutoFlowState(attemptId, state, { detail, evidence } = {}) {
        return mutate(db => {
            const attempt = db.learning_attempts.find(a => a.id === attemptId);
            if (!attempt) return null;
            const valid = AUTO_FLOW_TRANSITIONS[attempt.auto_flow_state] || [];
            if (!valid.includes(state)) throw new Error(`非法状态迁移: ${attempt.auto_flow_state} → ${state}`);
            const now = new Date().toISOString();
            attempt.auto_flow_history.push({ from: attempt.auto_flow_state, to: state, at: now, detail: detail || null, evidence: evidence || null });
            attempt.auto_flow_state = state;
            attempt.updated_at = now;
            return clone(attempt);
        });
    },
    // manual_override（可选能力）：人工将终态 reset 回 generated 重新进入无人循环（保留历史迁移记录）
    resetAutoFlow(attemptId, { reason } = {}) {
        return mutate(db => {
            const attempt = db.learning_attempts.find(a => a.id === attemptId);
            if (!attempt) return null;
            if (!['auto_rejected', 'exhausted', 'quarantined'].includes(attempt.auto_flow_state)) {
                throw new Error(`仅终态可 reset 重入无人循环（当前 ${attempt.auto_flow_state}）`);
            }
            const now = new Date().toISOString();
            attempt.auto_flow_history.push({ from: attempt.auto_flow_state, to: 'generated', at: now, detail: `manual_override: ${reason || '重入无人循环'}`, evidence: null });
            attempt.auto_flow_state = 'generated';
            attempt.updated_at = now;
            return clone(attempt);
        });
    },
    listAttemptsByFlowState(state) {
        return clone(readDb().learning_attempts.filter(a => a.auto_flow_state === state));
    },
    listAutoAccepted() {
        return clone(readDb().learning_attempts.filter(a => a.auto_flow_state === 'auto_accepted'));
    },
    saveAutoEvaluation(attemptId, evaluation) {
        return mutate(db => {
            const attempt = db.learning_attempts.find(a => a.id === attemptId);
            if (!attempt) return null;
            attempt.auto_evaluation = { ...(attempt.auto_evaluation || {}), ...evaluation, at: new Date().toISOString() };
            attempt.updated_at = new Date().toISOString();
            return clone(attempt);
        });
    },
    // 只允许追加人工结论，绝不回写输入快照字段
    applyVerdict(attemptId, verdict, { category, notes, reviewerId, defectScore, validationScope } = {}) {        return mutate(db => {
            const attempt = db.learning_attempts.find(a => a.id === attemptId);
            if (!attempt) return null;
            if (attempt.human_verdict !== 'pending') throw new Error('该 Attempt 已审片，不能重复改判');
            attempt.human_verdict = verdict === 'approved' ? 'approved' : 'rejected';
            attempt.human_category = category || attempt.failure_category || null;
            attempt.human_defect_score = defectScore ?? null;   // 1~5，人工缺陷评分
            attempt.human_notes = notes || null;
            attempt.validation_scope = validationScope || null;  // viewer / game
            attempt.human_reviewed_at = new Date().toISOString();
            attempt.reviewer_id = reviewerId ?? null;
            attempt.updated_at = attempt.human_reviewed_at;
            return clone(attempt);
        });
    },
    // 仅复盘 worker 在闭环闭合后回写，标记该 Attempt 已被经验库采纳
    linkExperiment(attemptId, experimentId, changedVariable) {
        return mutate(db => {
            const attempt = db.learning_attempts.find(a => a.id === attemptId);
            if (!attempt) return null;
            attempt.experiment_id = experimentId;
            attempt.changed_variable = changedVariable || attempt.changed_variable;
            return clone(attempt);
        });
    },
    // v2 自动修复收尾：回填终态快照（auto_status/metrics/artifacts/pipeline/evidence 等），
    // 绝不触碰 human_* 字段（自动流程必须停在 pending_human_review）。
    updateAttemptTerminal(jobId, data) {
        return mutate(db => {
            const attempt = db.learning_attempts.find(a => a.job_id === jobId);
            if (!attempt) return null;
            attempt.auto_status = data.auto_status || attempt.auto_status;
            if (data.metrics) attempt.metrics = data.metrics;
            if (data.artifacts) attempt.artifacts = data.artifacts;
            if (data.pipeline) attempt.pipeline = data.pipeline;
            if (data.evidence) attempt.evidence = data.evidence;
            if (data.failure_category) attempt.failure_category = data.failure_category;
            if (data.failure_detail) attempt.failure_detail = data.failure_detail;
            attempt.updated_at = new Date().toISOString();
            return clone(attempt);
        });
    },

    listRetrospectives({ ownerId, limit = 50 } = {}) {
        return clone(readDb().retrospectives
            .filter(r => ownerId === undefined || r.owner_id === ownerId)
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
            .slice(0, Math.max(1, Math.min(Number(limit) || 50, 500))));
    },
    createRetrospective(data) {
        return mutate(db => {
            const now = new Date().toISOString();
            const retro = {
                id: `RT${String(db.nextRetroId++).padStart(6, '0')}`,
                owner_id: data.owner_id ?? null,
                domain: data.domain || 'model',
                asset_kind: data.asset_kind || 'prop',
                profile: data.profile || null,
                scope: data.scope || null,                 // { profile } 适用范围
                defect_category: data.defect_category || null,
                defect_detail: data.defect_detail || '',
                failed_attempt_id: data.failed_attempt_id,
                fixed_attempt_id: data.fixed_attempt_id,
                changed_variable: data.changed_variable || null,  // { param, from, to, reason }
                evidence: data.evidence || {},                     // { before_metrics, after_metrics, improved, validation_scope, game_verified }
                chain_valid: Boolean(data.chain_valid),           // 失败→单变量→改善→门禁改善→复测→人工approved 全链闭合
                policy_id: null,
                created_at: now
            };
            db.retrospectives.push(retro);
            return clone(retro);
        });
    },

    listPolicies({ assetKind, includeRolledBack = false, ownerId } = {}) {
        return clone(readDb().modeling_policies
            .filter(p => (ownerId === undefined || p.owner_id === ownerId))
            .filter(p => assetKind === undefined || p.asset_kind === assetKind)
            .filter(p => includeRolledBack || p.lifecycle !== 'rolled_back')
            .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)));
    },
    findPolicyById(id, ownerId) {
        return clone(readDb().modeling_policies.find(p => p.id === id && (ownerId === undefined || p.owner_id === ownerId)) || null);
    },
    createPolicy(data) {
        return mutate(db => {
            const crypto = require('crypto');
            const policy = {
                id: `MP-${crypto.randomUUID()}`,
                owner_id: data.owner_id ?? null,
                domain: data.domain || 'model',      // v2：策略按领域独立积累证据
                asset_kind: data.asset_kind || 'prop',
                scope: data.scope || {},                 // { profile } 等适用范围
                name: String(data.name || '未命名策略').slice(0, 80),
                description: String(data.description || '').slice(0, 400),
                lifecycle: 'draft',                       // draft/shadow/small_scale/default/rolled_back
                version: 1,
                params: data.params || {},               // { profile, seed?, prompt_addendum?, skill_instruction? }
                basis_retro_ids: data.basis_retro_ids || [],
                // v2：策略携带已登记的修复变量（default/small_scale 由 model-worker 注入新任务执行计划）
                ...(data.changed_variable ? { changed_variable: data.changed_variable } : {}),
                // v2 小规模应用统计：采样比例与命中/对照组（服务端记录，客户端不可写）
                sample_ratio: data.sample_ratio || 0,
                applied_count: 0,
                hit_count: 0,
                control_count: 0,
                // 证据数量一律由服务端依据已闭合因果链计算，客户端提交的 evidence_case_count 一律忽略
                evidence_case_count: 0,
                game_verified_count: 0,
                last_gate: null,                          // 最近一次晋级门禁评估摘要
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                rolled_back_at: null,
                rollback_reason: null
            };
            db.modeling_policies.push(policy);
            // 新建策略若基于具体有效复盘，则把策略挂到这些复盘上，供后续计算该策略证据
            for (const retro of db.retrospectives) {
                if (Array.isArray(data.basis_retro_ids) && data.basis_retro_ids.includes(retro.id) && !retro.policy_id) {
                    retro.policy_id = policy.id;
                }
            }
            return clone(policy);
        });
    },
    advancePolicy(policyId, nextLifecycle, { reason, reviewerId, evidenceCount, gameVerifiedCount } = {}) {
        return mutate(db => {
            const policy = db.modeling_policies.find(p => p.id === policyId);
            if (!policy) return null;
            const order = ['draft', 'shadow', 'small_scale', 'default'];
            if (nextLifecycle === 'rolled_back') {
                policy.lifecycle = 'rolled_back';
                policy.rolled_back_at = new Date().toISOString();
                policy.rollback_reason = reason || '人工回滚';
                policy.updated_at = policy.rolled_back_at;
                return clone(policy);
            }
            if (!order.includes(nextLifecycle)) throw new Error('未知策略阶段');
            // 禁止跳级：必须逐级晋级；证据数量由服务端在路由层计算并传入
            if (order.indexOf(nextLifecycle) !== order.indexOf(policy.lifecycle) + 1) {
                throw new Error('策略只能逐级晋级，不能跳级');
            }
            policy.lifecycle = nextLifecycle;
            if (evidenceCount !== undefined) policy.evidence_case_count = evidenceCount;
            if (gameVerifiedCount !== undefined) policy.game_verified_count = gameVerifiedCount;
            policy.last_gate = {
                at: new Date().toISOString(),
                next: nextLifecycle,
                evidence: evidenceCount ?? policy.evidence_case_count,
                game_verified: gameVerifiedCount ?? policy.game_verified_count,
                reviewer_id: reviewerId ?? null
            };
            policy.updated_at = new Date().toISOString();
            return clone(policy);
        });
    },
    // v2 策略应用统计（小规模命中/对照组）：由策略引擎在每次注入决策后记录，客户端不可写
    recordPolicyApplication(policyId, { applied, hit, control } = {}) {
        return mutate(db => {
            const policy = db.modeling_policies.find(p => p.id === policyId);
            if (!policy) return null;
            if (applied) policy.applied_count = (policy.applied_count || 0) + 1;
            if (hit) policy.hit_count = (policy.hit_count || 0) + 1;
            if (control) policy.control_count = (policy.control_count || 0) + 1;
            policy.updated_at = new Date().toISOString();
            return clone(policy);
        });
    },
    // v2 生效策略查询：default 直接注入执行计划；small_scale 按稳定比例采样；
    // shadow 只计算拟应用参数与差异；draft/rolled_back 一律不生效。
    listEffectivePolicies({ domain, assetKind, profile, ownerId } = {}) {
        const all = readDb().modeling_policies.filter(p =>
            (ownerId === undefined || p.owner_id === ownerId) &&
            (domain === undefined || p.domain === domain) &&
            (assetKind === undefined || p.asset_kind === assetKind) &&
            (profile === undefined || !p.scope?.profile || p.scope.profile === profile));
        return clone(all.filter(p => p.lifecycle === 'default' || p.lifecycle === 'small_scale' || p.lifecycle === 'shadow'));
    },

    listExperiments({ ownerId, limit = 50 } = {}) {
        return clone(readDb().experiments
            .filter(e => ownerId === undefined || e.owner_id === ownerId)
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
            .slice(0, Math.max(1, Math.min(Number(limit) || 50, 500))));
    },
    createExperiment(data) {
        return mutate(db => {
            const crypto = require('crypto');
            const exp = {
                id: `EXP-${crypto.randomUUID()}`,
                owner_id: data.owner_id ?? null,
                asset_kind: data.asset_kind || 'prop',
                hypothesis: String(data.hypothesis || '').slice(0, 400),
                variable: data.variable || null,
                baseline_attempt_id: data.baseline_attempt_id || null,
                candidate_attempt_id: data.candidate_attempt_id || null,
                result: 'pending',                        // pending / improved / regressed / inconclusive
                metrics_delta: data.metrics_delta || {},
                human_decision: null,
                created_at: new Date().toISOString()
            };
            db.experiments.push(exp);
            return clone(exp);
        });
    },
    updateExperiment(id, data) {
        return mutate(db => {
            const exp = db.experiments.find(e => e.id === id);
            if (!exp) return null;
            Object.assign(exp, data);
            return clone(exp);
        });
    }
};

// ForgeLoop v3：无人值守状态机合法迁移表（generated → auto_evaluating → auto_repairing → auto_accepted / auto_rejected / exhausted / quarantined）
const AUTO_FLOW_TRANSITIONS = {
    generated: ['auto_evaluating', 'auto_rejected', 'exhausted', 'quarantined'],
    auto_evaluating: ['auto_accepted', 'auto_rejected', 'auto_repairing', 'exhausted', 'quarantined'],
    auto_repairing: ['auto_evaluating', 'exhausted', 'quarantined'],
    auto_rejected: ['auto_repairing', 'exhausted', 'quarantined'],
    auto_accepted: ['exhausted'],
    exhausted: [],
    quarantined: []
};

// ForgeLoop v3：champion（每个 项目+资产+领域 一个当前最优自动验收候选）与 release 记录
const championDb = {
    list() { return clone(readDb().champions); },
    get({ project, asset_id, domain }) {
        return clone(readDb().champions.find(c =>
            (project === undefined || c.project === project) &&
            (asset_id === undefined || c.asset_id === asset_id) &&
            (domain === undefined || c.domain === domain)) || null);
    },
    set(data) {
        return mutate(db => {
            const now = new Date().toISOString();
            const existing = db.champions.find(c =>
                c.project === data.project && c.asset_id === data.asset_id && c.domain === data.domain);
            const record = {
                project: data.project || null,
                asset_id: data.asset_id || null,
                domain: data.domain || 'model',
                attempt_id: data.attempt_id,
                job_id: data.job_id || null,
                artifact_sha: data.artifact_sha || null,
                release_zip: data.release_zip || null,
                release_zip_sha: data.release_zip_sha || null,
                release_zip_bytes: data.release_zip_bytes ?? null,
                accepted_at: now,
                acceptance_mode: data.acceptance_mode || 'automatic',
                published: data.published || false,
                human_review: data.human_review || 'not_performed',
                metrics: data.metrics || {},
                prev_attempt_id: existing ? existing.attempt_id : null
            };
            if (existing) Object.assign(existing, record);
            else db.champions.push(record);
            return clone(record);
        });
    }
};

// ForgeLoop v3：版本化自动质量策略（六领域硬门禁+阈值+评分钩子）
const v3PolicyDb = {
    list(domain) {
        return clone(readDb().v3_policies
            .filter(p => domain === undefined || p.domain === domain)
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
    },
    latest(domain) {
        const list = readDb().v3_policies.filter(p => p.domain === domain).sort((a, b) => (b.version || 0) - (a.version || 0));
        return clone(list[0] || null);
    },
    save(data) {
        return mutate(db => {
            const now = new Date().toISOString();
            const existing = db.v3_policies.find(p => p.domain === data.domain && p.version === data.version);
            const record = {
                domain: data.domain,
                version: data.version,
                policy: data.policy,             // { hard_gates[], quality_metrics[], regression[], comparison[], thresholds{} }
                threshold_units: data.threshold_units || {},
                change_log: data.change_log || [],
                created_at: existing?.created_at || now,
                updated_at: now
            };
            if (existing) Object.assign(existing, record);
            else db.v3_policies.push(record);
            return clone(record);
        });
    }
};

// ForgeLoop v3：自动循环并发锁（服务重启后锁超时自动失效，可重入；同一 attempt/job 不会重复提交 GPU）
const autoLockDb = {
    acquire(key, owner, ttlMs = 10 * 60 * 1000) {
        return mutate(db => {
            const now = Date.now();
            db.auto_locks = db.auto_locks.filter(l => l.key !== key || l.expires_at > now);
            if (db.auto_locks.some(l => l.key === key)) return null; // 已存在未过期锁
            db.auto_locks.push({ key, owner, expires_at: now + ttlMs, acquired_at: new Date(now).toISOString() });
            return clone(db.auto_locks.find(l => l.key === key));
        });
    },
    release(key, owner) {
        return mutate(db => {
            const before = db.auto_locks.length;
            db.auto_locks = db.auto_locks.filter(l => !(l.key === key && l.owner === owner));
            return before !== db.auto_locks.length;
        });
    },
    list() { return clone(readDb().auto_locks); }
};

// ---------- ForgeLoop v2：统一生产契约（按项目 ID 存储，文档含 sha256 证据锚点） ----------
const contractDb = {
    list(ownerId) {
        return clone(readDb().production_contracts
            .filter(c => ownerId === undefined || c.owner_id === ownerId)
            .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)));
    },
    get(projectId, ownerId) {
        const record = readDb().production_contracts.find(c =>
            c.project_id === projectId && (ownerId === undefined || c.owner_id === ownerId));
        return clone(record || null);
    },
    // upsert：同一项目 ID 幂等覆盖（契约是权威来源，覆盖即版本更新）
    save(projectId, doc, ownerId) {
        return mutate(db => {
            const now = new Date().toISOString();
            const existing = db.production_contracts.find(c => c.project_id === projectId && c.owner_id === ownerId);
            const record = {
                project_id: projectId,
                owner_id: ownerId ?? null,
                doc,
                sha256: doc.sha256,
                updated_at: now,
                created_at: existing?.created_at || now
            };
            if (existing) Object.assign(existing, record);
            else db.production_contracts.push(record);
            return clone(record);
        });
    },
    remove(projectId, ownerId) {
        return mutate(db => {
            const before = db.production_contracts.length;
            db.production_contracts = db.production_contracts.filter(c => !(c.project_id === projectId && c.owner_id === ownerId));
            return before !== db.production_contracts.length;
        });
    }
};

// ---------- 建模资源库（跨机器共享资产清单） ----------
// source: 'gpu'（GPU 服务器目录扫描/登记）| 'local'（本机目录登记，仅清单）| 'upload'（已上传到服务器，跨机器可访问）
const resourceDb = {
    create(data) {
        return mutate(db => {
            const now = new Date().toISOString();
            const resource = {
                id: db.nextId++,
                name: String(data.name || '未命名资源').trim().slice(0, 120) || '未命名资源',
                kind: data.kind || 'other',
                source: data.source || 'local',
                ext: data.ext || null,
                size: data.size ?? null,
                sha256: data.sha256 || null,
                file_path: data.file_path || null,
                url: data.url || null,
                tags: Array.isArray(data.tags) ? [...new Set(data.tags.map(String).filter(Boolean))].slice(0, 20) : [],
                note: String(data.note || '').trim().slice(0, 1000),
                origin: data.origin && typeof data.origin === 'object'
                    ? { machine: String(data.origin.machine || '').trim().slice(0, 120) || null, dir: String(data.origin.dir || '').trim().slice(0, 500) || null }
                    : null,
                job_id: data.job_id || null,
                mp_id: data.mp_id || null,
                missing: false,
                created_at: now,
                updated_at: now
            };
            db.resources.push(resource);
            return clone(resource);
        });
    },
    update(id, data) {
        return mutate(db => {
            const resource = db.resources.find(item => item.id === Number(id));
            if (!resource) return null;
            const patch = {};
            if (data.name !== undefined) patch.name = String(data.name).trim().slice(0, 120) || '未命名资源';
            if (data.kind !== undefined) patch.kind = data.kind;
            if (data.tags !== undefined) patch.tags = [...new Set(data.tags.map(String).filter(Boolean))].slice(0, 20);
            if (data.note !== undefined) patch.note = String(data.note).trim().slice(0, 1000);
            if (data.job_id !== undefined) patch.job_id = data.job_id || null;
            if (data.mp_id !== undefined) patch.mp_id = data.mp_id || null;
            if (data.url !== undefined) patch.url = data.url ? String(data.url).trim().slice(0, 500) : null;
            Object.assign(resource, patch, { updated_at: new Date().toISOString() });
            return clone(resource);
        });
    },
    findById(id) {
        return clone(readDb().resources.find(item => item.id === Number(id)) || null);
    },
    list() {
        return clone(readDb().resources.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)));
    },
    delete(id) {
        return mutate(db => {
            const before = db.resources.length;
            db.resources = db.resources.filter(item => item.id !== Number(id));
            return before !== db.resources.length;
        });
    },
    // 扫描入库幂等键：(source, file_path)；命中则只刷新 missing 标记
    upsertByPath(source, filePath, data) {
        return mutate(db => {
            const existing = db.resources.find(item => item.source === source && item.file_path === filePath);
            const now = new Date().toISOString();
            if (existing) {
                existing.missing = false;
                existing.updated_at = now;
                if (data.size !== undefined) existing.size = data.size;
                if (data.sha256 !== undefined && data.sha256) existing.sha256 = data.sha256;
                return { resource: clone(existing), created: false };
            }
            const resource = {
                id: db.nextId++,
                name: String(data.name || '未命名资源').trim().slice(0, 120) || '未命名资源',
                kind: data.kind || 'other',
                source,
                ext: data.ext || null,
                size: data.size ?? null,
                sha256: data.sha256 || null,
                file_path: filePath,
                url: data.url || null,
                tags: Array.isArray(data.tags) ? [...new Set(data.tags.map(String).filter(Boolean))].slice(0, 20) : [],
                note: String(data.note || '').trim().slice(0, 1000),
                origin: data.origin && typeof data.origin === 'object'
                    ? { machine: String(data.origin.machine || '').trim().slice(0, 120) || null, dir: String(data.origin.dir || '').trim().slice(0, 500) || null }
                    : null,
                job_id: data.job_id || null,
                mp_id: data.mp_id || null,
                missing: false,
                created_at: now,
                updated_at: now
            };
            db.resources.push(resource);
            return { resource: clone(resource), created: true };
        });
    },
    // 扫描后核对：source 下已登记但文件已不存在的资源标记 missing（upload 记录不参与核对）
    markMissing(source, existingPaths) {
        return mutate(db => {
            let count = 0;
            for (const resource of db.resources) {
                if (resource.source !== source || resource.url) continue;
                const stillExists = resource.file_path && existingPaths.has(resource.file_path);
                if (!stillExists && !resource.missing) {
                    resource.missing = true;
                    resource.updated_at = new Date().toISOString();
                    count += 1;
                } else if (stillExists && resource.missing) {
                    resource.missing = false;
                    resource.updated_at = new Date().toISOString();
                }
            }
            return count;
        });
    }
};

function getStats() {
    const db = readDb();
    const jobCounts = {};
    for (const job of db.jobs) jobCounts[job.status] = (jobCounts[job.status] || 0) + 1;
    const attemptVerdicts = {};
    for (const a of db.learning_attempts) attemptVerdicts[a.human_verdict] = (attemptVerdicts[a.human_verdict] || 0) + 1;
    return {
        models: db.models.length,
        jobs: jobCounts,
        skills: db.skills.length,
        learning: {
            attempts: db.learning_attempts.length,
            retrospectives: db.retrospectives.length,
            policies: db.modeling_policies.length,
            experiments: db.experiments.length,
            verdicts: attemptVerdicts
        }
    };
}

module.exports = {
    studioDb,
    modelDb,
    resourceDb,
    skillDb,
    settingsDb,
    jobDb,
    notificationDb,
    configDb,
    userDb,
    sessionDb,
    apiTokenDb,
    productionPlanDb,
    factoryDb,
    learningDb,
    contractDb,
    championDb,
    v3PolicyDb,
    autoLockDb,
    AUTO_FLOW_TRANSITIONS,
    getStats,
    dbPath,
    uploadDir,
    modelDir,
    BUILTIN_SKILL
};
