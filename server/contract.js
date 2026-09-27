// ForgeLoop v2 —— 统一生产契约（production-contract）
//
// 用稳定 ID 描述角色、动作、道具、音频事件、触发/停止条件、来源、审核状态与发布门禁。
// 本模块只做纯函数：schema 校验、审计（质量报告）、契约哈希。
// 存储与 HTTP 接口在 production-contract.js 路由层；游戏侧的生成/构建期校验在游戏仓库的 tools/ 下。
//
// 设计原则：
// 1. 契约是唯一权威来源：剧情/交互需要的事件、GPU 产物、包内文件、HTML 加载、运行时触发
//    全部挂到同一事件 ID 上。
// 2. review 资产只能进入审片候选包；正式包只允许人工 approved 资产。系统不得自动批准。
// 3. 迁移只增字段、幂等回填，不重命名或删除现有 ForgeLoop 数据。

const { hashText } = require('./utils');

const CONTRACT_SCHEMA = 2;

const ASSET_KINDS = ['character', 'action', 'prop', 'audio_event'];
const REVIEW_STATUS = ['pending', 'review', 'approved', 'rejected', 'deprecated'];
const REQUIREMENT = ['required', 'optional', 'deprecated'];
const AUDIO_ROLES = ['dialogue', 'sfx', 'ambient', 'cover', 'locomotion', 'ui'];
const RELEASE_GATES = ['review', 'approved'];

// 允许的接触语义对（穿模门禁忽略这些相邻/接触，见 forge3d analyze_clipping）。
const ALLOWED_CONTACT_PAIRS = [
    'hand-hand',      // 牵手
    'hand-hip',       // 牵手（手搭在身侧）
    'body-bench',     // 坐下
    'foot-ground',    // 脚/地面
    'adjacent-mesh'   // 相邻网格（由骨骼影响划分时同属一个语义区域）
];

// ---------- 校验 ----------

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value, field, { max = 200, allowEmpty = false } = {}) {
    if (typeof value !== 'string') throw new Error(`${field} 必须是字符串`);
    const trimmed = value.trim();
    if (!allowEmpty && !trimmed) throw new Error(`${field} 不能为空`);
    if (trimmed.length > max) throw new Error(`${field} 不能超过 ${max} 字符`);
    return trimmed;
}

function validateAssetRef(ref) {
    if (typeof ref !== 'string' || !ref.trim()) throw new Error('asset_ref 不能为空');
    if (ref.length > 300) throw new Error('asset_ref 过长');
    return ref.trim();
}

function validateSource(source) {
    if (source === null || source === undefined) return null;
    if (!isPlainObject(source)) throw new Error('source 必须是对象或 null');
    if (source.path !== undefined && (typeof source.path !== 'string' || !source.path.trim())) throw new Error('source.path 无效');
    if (source.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(String(source.sha256))) throw new Error('source.sha256 必须是 64 位十六进制');
    if (source.bytes !== undefined && (!Number.isInteger(source.bytes) || source.bytes < 0)) throw new Error('source.bytes 必须是自然数');
    return {
        path: source.path || null,
        sha256: source.sha256 || null,
        bytes: source.bytes ?? null,
        task_id: source.task_id || null,   // GPU 服务器任务 ID
        model: source.model || null,       // GPU 模型名
        params: source.params || null,     // 生成参数
        note: source.note || null
    };
}

function validateAudioEvent(event, index) {
    const label = `audio_events[${index}]`;
    const id = requireString(event.id, `${label}.id`, { max: 80 });
    const role = AUDIO_ROLES.includes(event.role) ? event.role : null;
    if (!role) throw new Error(`${label}.role 必须是 ${AUDIO_ROLES.join('/')} 之一`);
    const requirement = REQUIREMENT.includes(event.requirement) ? event.requirement : 'optional';
    const reviewStatus = REVIEW_STATUS.includes(event.review_status) ? event.review_status : 'pending';
    const releaseGate = RELEASE_GATES.includes(event.release_gate) ? event.release_gate : 'approved';
    const source = validateSource(event.source);
    const packageFile = event.package_file ? validateAssetRef(event.package_file) : null;
    if (requirement === 'required' && !packageFile) throw new Error(`${label} 必需事件的 package_file 不能为空`);

    const triggers = Array.isArray(event.triggers) ? event.triggers.map((trigger, i) => {
        if (!isPlainObject(trigger)) throw new Error(`${label}.triggers[${i}] 必须是对象`);
        return {
            site: requireString(trigger.site, `${label}.triggers[${i}].site`, { max: 200, allowEmpty: true }),
            trigger: requireString(trigger.trigger, `${label}.triggers[${i}].trigger`, { max: 200, allowEmpty: true }),
            stop: requireString(trigger.stop, `${label}.triggers[${i}].stop`, { max: 200, allowEmpty: true })
        };
    }) : [];

    return {
        id,
        kind: 'audio',
        role,
        requirement,
        source,
        package_file: packageFile,
        html_loaded: Boolean(event.html_loaded),
        triggers,
        review_status: reviewStatus,
        human_review: event.human_review || null,
        release_gate: releaseGate,
        notes: event.notes ? String(event.notes).slice(0, 400) : null
    };
}

function validateAsset(event, kind, index) {
    const label = `${kind}s[${index}]`;
    if (!ASSET_KINDS.includes(kind)) throw new Error(`未知资产类型 ${kind}`);
    const id = requireString(event.id, `${label}.id`, { max: 80 });
    const reviewStatus = REVIEW_STATUS.includes(event.review_status) ? event.review_status : 'pending';
    const releaseGate = RELEASE_GATES.includes(event.release_gate) ? event.release_gate : 'approved';
    return {
        id,
        kind,
        name: event.name ? requireString(event.name, `${label}.name`, { max: 120, allowEmpty: true }) : null,
        asset_ref: event.asset_ref ? validateAssetRef(event.asset_ref) : null,
        source: validateSource(event.source),
        review_status: reviewStatus,
        human_review: event.human_review || null,
        release_gate: releaseGate,
        notes: event.notes ? String(event.notes).slice(0, 400) : null
    };
}

// 校验完整契约，返回规范化后的契约对象（未知字段保留但规范字段被重建）。
function validateContract(raw) {
    if (!isPlainObject(raw)) throw new Error('契约必须是 JSON 对象');
    const projectId = requireString(raw.project_id, 'project_id', { max: 120 });
    const projectName = raw.project_name ? requireString(raw.project_name, 'project_name', { max: 200, allowEmpty: true }) : projectId;

    const characters = Array.isArray(raw.characters) ? raw.characters.map((item, i) => validateAsset(item, 'character', i)) : [];
    const actions = Array.isArray(raw.actions) ? raw.actions.map((item, i) => validateAsset(item, 'action', i)) : [];
    const props = Array.isArray(raw.props) ? raw.props.map((item, i) => validateAsset(item, 'prop', i)) : [];
    const audioEvents = Array.isArray(raw.audio_events) ? raw.audio_events.map((item, i) => validateAudioEvent(item, i)) : [];

    // 事件 ID 全局唯一（同一 ID 不能被角色/动作/道具/音频复用）
    const seen = new Set();
    for (const item of [...characters, ...actions, ...props, ...audioEvents]) {
        if (seen.has(item.id)) throw new Error(`事件/资产 ID 重复：${item.id}`);
        seen.add(item.id);
    }

    const releaseGates = isPlainObject(raw.release_gates) ? {
        review_package: raw.release_gates.review_package === 'review' ? 'review' : 'review',
        official_package: RELEASE_GATES.includes(raw.release_gates.official_package) ? raw.release_gates.official_package : 'approved'
    } : { review_package: 'review', official_package: 'approved' };

    const contract = {
        schema: CONTRACT_SCHEMA,
        project_id: projectId,
        project_name: projectName,
        version: raw.version ? String(raw.version).slice(0, 60) : null,
        updated_at: raw.updated_at || new Date().toISOString(),
        generated_by: raw.generated_by ? String(raw.generated_by).slice(0, 120) : null,
        characters,
        actions,
        props,
        audio_events: audioEvents,
        release_gates: releaseGates,
        allowed_contact_pairs: Array.isArray(raw.allowed_contact_pairs)
            ? raw.allowed_contact_pairs.filter(pair => ALLOWED_CONTACT_PAIRS.includes(pair))
            : [...ALLOWED_CONTACT_PAIRS]
    };
    // 契约哈希作为 Attempt.contract_hash 的证据锚点
    contract.sha256 = contractHash(contract);
    return contract;
}

// ---------- 审计（质量报告） ----------

function auditContract(contract) {
    if (!contract || contract.sha256 !== contractHash(contract)) {
        // 允许传入原始文档：先规范化
        if (isPlainObject(contract)) contract = validateContract(contract);
    }
    const problems = [];
    const stats = { characters: 0, actions: 0, props: 0, audio_events: 0 };
    const byReview = { pending: 0, review: 0, approved: 0, rejected: 0, deprecated: 0 };
    const requiredEvents = [];
    const orphans = [];
    const unapprovedForOfficial = [];

    const all = [...(contract.characters || []), ...(contract.actions || []), ...(contract.props || []), ...(contract.audio_events || [])];
    for (const item of all) {
        stats[item.kind === 'audio' ? 'audio_events' : item.kind === 'character' ? 'characters' : item.kind === 'action' ? 'actions' : 'props'] += 1;
        byReview[item.review_status] = (byReview[item.review_status] || 0) + 1;
        if (item.kind === 'audio' && item.requirement === 'required') requiredEvents.push(item.id);
        // 正式包只允许人工 approved 资产（rejected/deprecated 明确排除）
        if (item.release_gate === 'approved' && item.review_status !== 'approved') {
            unapprovedForOfficial.push(item.id);
        }
        // 孤儿音频：有包内文件但没有任何触发条件
        if (item.kind === 'audio' && item.package_file && item.requirement !== 'deprecated' && (!item.triggers || item.triggers.length === 0)) {
            orphans.push(item.id);
        }
        // 必需事件必须有包内文件、来源与触发条件
        if (item.kind === 'audio' && item.requirement === 'required') {
            if (!item.source?.path || !item.source?.sha256) problems.push(`${item.id}: 必需事件缺少 GPU 来源（source.path/sha256）`);
            if (!item.package_file) problems.push(`${item.id}: 必需事件缺少包内文件（package_file）`);
            if (!item.html_loaded && !(item.triggers || []).some(t => t.site && t.site.startsWith('html'))) {
                problems.push(`${item.id}: 必需事件未在 HTML 中加载`);
            }
            if (!(item.triggers || []).length) problems.push(`${item.id}: 必需事件缺少静态触发点（孤儿音频）`);
        }
    }

    // 审计结论分三档：ok / warn / fail（影子运行期只报告不阻断，见 release 门禁）
    const severity = problems.length ? 'fail' : (orphans.length || unapprovedForOfficial.length) ? 'warn' : 'ok';
    return {
        generated_at: new Date().toISOString(),
        contract_sha256: contract.sha256,
        severity,
        stats,
        by_review_status: byReview,
        required_events: requiredEvents,
        required_events_total: requiredEvents.length,
        orphans,
        unapproved_for_official: unapprovedForOfficial,
        problems,
        release_gate: {
            review_package: 'review',          // 审片候选包：review 及以上（review/approved）
            official_package: contract.release_gates?.official_package || 'approved' // 正式包：仅 approved
        },
        note: '影子运行期：审计只报告，不阻断发布；人工 approved 前不得自动发布。'
    };
}

function contractHash(contract) {
    const { sha256, ...rest } = contract || {};
    return hashText(JSON.stringify(rest));
}

module.exports = {
    CONTRACT_SCHEMA,
    ASSET_KINDS,
    REVIEW_STATUS,
    REQUIREMENT,
    AUDIO_ROLES,
    RELEASE_GATES,
    ALLOWED_CONTACT_PAIRS,
    validateContract,
    auditContract,
    contractHash
};
