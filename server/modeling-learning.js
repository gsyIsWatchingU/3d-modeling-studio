// ForgeLoop 自进化建模闭环 —— 核心规则库（v2：多领域经验 + 规则门禁，不训练新模型）
//
// 设计原则：
// 1. 只有「失败 A → 明确缺陷 → 只改一个变量 → 候选 B 指标改善 → 游戏内复测 → 人工 approved」
//    的完整因果链才能成为成功样本；单纯 completed / 自动高分一律不进经验库。
// 2. 推荐只给「三档候选」，不直接接管流水线；每轮 ≤3 候选、≤2 次修复，预算耗尽即交人工。
// 3. 策略只能 draft→shadow→small_scale→default 逐级晋级，可一键回滚，禁止一次成功改全局。
// 4. v2 引入领域（domain）：model/animation/audio/integration/qa，各领域有独立的单变量修复白名单；
//    旧建模数据由 db.js 幂等回填为 domain=model，旧客户端不传 domain 时默认只按 model 领域过滤。
// 5. 穿模门禁：非允许区域连续两帧相交即失败；单帧异常进警告并附证据。自动失败后仅切换一个
//    已登记的权重修复或重定向方案，生成新候选并复测，停在人工审片。

const { learningDb } = require('./db');
const { hashText } = require('./utils');

const DOMAINS = ['model', 'animation', 'audio', 'integration', 'qa'];
const DOMAIN_LABELS = {
    model: '建模', animation: '动画', audio: '音频', integration: '集成', qa: '验收'
};

const FAILURE_CATEGORIES = [
    'input',          // 参考图/提示词/参数等输入问题
    'infrastructure', // 网络、超时、GPU、服务 5xx 等基础设施
    'shape',          // 形体：比例错误、缺块、多碎片
    'material',       // 材质/PBR/UV 问题
    'topology',       // 拓扑/破面/法线
    'rig',            // 骨骼
    'skinning',       // 蒙皮权重
    'animation',      // 动画/变形/姿态
    'clipping',       // 穿模：骨架/蒙皮/身体/衣物/手/脚/场景相交
    'audio_event',    // 音频：解码失败、缺触发、未停止、孤儿事件
    'integration',    // 集成：打包缺文件、加载失败、运行期漏接
    'export',         // GLB 导出/校验失败
    'engine_runtime', // 引擎运行时崩溃/穿模/性能
    'aesthetic'       // 自动通过但人工审美不符
];

const CATEGORY_LABELS = {
    input: '输入问题', infrastructure: '基础设施', shape: '形体', material: '材质',
    topology: '拓扑', rig: '骨骼', skinning: '蒙皮', animation: '动画',
    clipping: '穿模', audio_event: '音频事件', integration: '集成',
    export: '导出', engine_runtime: '引擎运行', aesthetic: '审美不符'
};

const CANDIDATE_BUDGET = { max_candidates: 3, max_repairs: 2 };

// ---------- ForgeLoop 单变量修复白名单（按领域） ----------
// 只有这些变量允许在「失败→修复」闭环中被单独修改；其他任何参数改动都会被服务端拒绝。
// model 领域沿用 v1 白名单；animation 领域只允许切换已登记的权重修复/重定向方案；
// audio 领域只允许调整增益/截取起点等单一可测参数。
const REPAIR_VARIABLES = {
    model: {
        seed: v => Number.isInteger(v) && v >= 0 && v <= 4294967295,
        'generation.triangle_budget': v => Number.isInteger(v) && v >= 1000 && v <= 120000,
        'generation.texture_size': v => [512, 1024, 2048, 4096].includes(v),
        'generation.paint_views': v => Number.isInteger(v) && v >= 6 && v <= 9,
        'generation.paint_resolution': v => [512, 768].includes(v),
        'generation.roughness_floor': v => typeof v === 'number' && v >= 0.15 && v <= 0.8,
        'generation.specular_level': v => typeof v === 'number' && v >= 0.1 && v <= 0.5
    },
    // 已登记的权重修复/重定向方案（与 GPU 工位 deploy/forge3d/blender/ 下的修复脚本一一对应）
    animation: {
        'animation.weight_repair_plan': v => REGISTERED_WEIGHT_REPAIR_PLANS.includes(v),
        'animation.retarget_plan': v => REGISTERED_RETARGET_PLANS.includes(v)
    },
    audio: {
        'audio.gain_adjust': v => typeof v === 'number' && v >= 0.05 && v <= 2.0,
        'audio.trim_start_s': v => typeof v === 'number' && v >= 0 && v <= 30
    }
};

// 已登记的修复方案（必须与 GPU 工位 deploy/forge3d/blender/ 下的修复脚本一一对应；新增方案须同时落到工位脚本与生产文档）
const REGISTERED_WEIGHT_REPAIR_PLANS = [
    'sanitize_skin_weights',        // deploy/forge3d/blender/sanitize_skin_weights.py
    'repair_rig_symmetry',          // deploy/forge3d/blender/repair_rig_symmetry.py
    'stabilize_locomotion'          // deploy/forge3d/blender/stabilize_locomotion.py
];
const REGISTERED_RETARGET_PLANS = [
    'retarget_actions'              // deploy/forge3d/blender/retarget.py（动作重定向）
];

// v1 兼容导出：旧客户端/旧测试引用 SINGLE_VARIABLES / SINGLE_VARIABLE_RULES 时仍指 model 领域
const SINGLE_VARIABLE_RULES = REPAIR_VARIABLES.model;
const SINGLE_VARIABLES = Object.keys(SINGLE_VARIABLE_RULES);
const VARIABLE_LABELS = {
    seed: '随机种子',
    'generation.triangle_budget': '三角面预算',
    'generation.texture_size': '纹理尺寸',
    'generation.paint_views': '涂装视角数',
    'generation.paint_resolution': '涂装分辨率',
    'generation.roughness_floor': '粗糙度下限',
    'generation.specular_level': '高光强度',
    'animation.weight_repair_plan': '权重修复方案',
    'animation.retarget_plan': '重定向方案',
    'audio.gain_adjust': '音频增益',
    'audio.trim_start_s': '截取起点（秒）'
};
const DOMAIN_REPAIR_VARIABLES = REPAIR_VARIABLES;

// ---------- 失败自动分类（best-effort，人工可在审片时改判） ----------
// 质量门取值：boolean / 数字分数 / Forge3D 的 passed|failed|required|n/a|pending。
// 只有明确失败才视为失败；'required'（需人工复核）、'n/a'（不适用）、'pending' 均不算失败。
function gateValueFails(value) {
    if (value === false || value === 'fail' || value === 'failed') return true;
    if (typeof value === 'number' && value < 0.5) return true;
    return false;
}

function gateValuePasses(value) {
    if (value === true || value === 'pass' || value === 'passed') return true;
    if (typeof value === 'number' && value >= 0.5) return true;
    return false;
}

function gateFailed(gates, keys) {
    for (const key of keys) {
        if (gateValueFails(gates?.[key])) return true;
    }
    return false;
}

// 对齐 Forge3D 真实门禁键：先判具体 Review 门禁，再判复合 profile_contract，最后落到旧键兜底。
function classifyFailure({ job = {}, quality = {} }) {
    const code = job?.error?.code;
    const msg = String(job?.error?.message || '');
    const gates = quality?.quality_gates || {};
    // 1. 输入被服务端拒绝（最高优先，与产物质量无关）
    if (code === 'invalid_request') return 'input';
    // 2. 音频领域失败：解码/缺文件/缺触发/孤儿/未停止（由音频契约校验与运行期追踪上报）
    if (code === 'audio_decode' || code === 'audio_trigger' || code === 'audio_orphan' || code === 'audio_unstopped') return 'audio_event';
    if (/音频|audio|解码|decode|未停止|孤儿|缺少触发/.test(msg)) return 'audio_event';
    // 3. 集成/打包领域失败：缺文件、加载失败、运行期漏接
    if (code === 'integration_missing_file' || code === 'integration_load_failed' || /集成|打包缺|漏接|加载失败/.test(msg)) return 'integration';
    // 4. 导出/GLB 校验
    if (/GLB|glTF|文件长度|文件过小|模型文件|不是有效/.test(msg)) return 'export';
    // 5. Forge3D 真实 Review 门禁
    if (gateFailed(gates, ['clipping_review'])) return 'clipping';
    if (gateFailed(gates, ['rig_structure_review'])) return 'rig';
    if (gateFailed(gates, ['deformation_review'])) return 'animation';
    if (gateFailed(gates, ['animation_pose_review'])) return 'animation';
    if (gateFailed(gates, ['material_uv_review'])) return 'material';
    if (gateFailed(gates, ['render_anomaly_review'])) return 'material';
    if (gateFailed(gates, ['profile_contract'])) return 'shape';
    // 6. 旧版自动质检上报的缺陷维度（兼容）
    if (gateFailed(gates, ['shape', 'geometry', 'silhouette'])) return 'shape';
    if (gateFailed(gates, ['material', 'texture', 'pbr'])) return 'material';
    if (gateFailed(gates, ['topology', 'mesh', 'manifold'])) return 'topology';
    if (gateFailed(gates, ['rig', 'bone', 'skeleton'])) return 'rig';
    if (gateFailed(gates, ['skin', 'skinning', 'weight'])) return 'skinning';
    if (gateFailed(gates, ['animation', 'deform'])) return 'animation';
    if (gateFailed(gates, ['engine', 'runtime', 'performance'])) return 'engine_runtime';
    // 7. 临时/基础设施
    if (code === 'provider_error' || /暂时不可用|超时|HTTP (5\d\d|429|408)/.test(msg)) return 'infrastructure';
    return 'infrastructure';
}

// ---------- 领域白名单辅助 ----------
function variablesForDomain(domain) {
    return REPAIR_VARIABLES[domain] || REPAIR_VARIABLES.model;
}

// 校验某领域下的单变量修复是否合法（param 在该领域白名单内且目标值符合规则）
function repairParamValid(domain, param, to) {
    const rules = variablesForDomain(domain);
    if (!rules || !Object.prototype.hasOwnProperty.call(rules, param)) return false;
    return Boolean(rules[param](to));
}

function currentDomainVariableValue(attempt, param) {
    if (attempt?.domain === 'audio') {
        return attempt?.evidence?.audio?.[param] ?? attempt?.execution_plan?.audio?.[param.slice('audio.'.length)];
    }
    if (attempt?.domain === 'animation') {
        return attempt?.execution_plan?.animation?.[param.slice('animation.'.length)] ?? null;
    }
    return currentVariableValue(attempt, param);
}

// ---------- 指标：只看可量化的硬指标，审美不计入 ----------
// 返回 0~1 的可比较分数；越接近 1 越好。缺项按中性 0.5，避免用缺数据虚高。
// 门禁值兼容 Forge3D 的 passed/failed/required/n/a。
function qualityScore(metrics = {}) {
    const parts = [];
    const gates = metrics.quality_gates || {};
    for (const [key, value] of Object.entries(gates)) {
        if (gateValuePasses(value)) parts.push(1);
        else if (gateValueFails(value)) parts.push(0);
        else if (typeof value === 'number') parts.push(Math.max(0, Math.min(1, value)));
        // 'required'/'n/a'/'pending'/字符串其余值 → 中性，不计分（不虚高也不冤枉）
    }
    if (metrics.triangles && metrics.triangles > 0) {
        // 面数在合理区间得分；过多/过少都扣分（粗略规则，v1 不调参）
        const ok = metrics.triangles >= 500 && metrics.triangles <= 150000;
        parts.push(ok ? 1 : 0.4);
    }
    if (!parts.length) return null;
    return parts.reduce((sum, v) => sum + v, 0) / parts.length;
}

// ---------- 相似检索：同资产类型 > 同档位 > 同解决过的缺陷 ----------
// query.owner_id 与 query.ownerId 统一读取，避免账号泄漏（必须按账号隔离检索）。
function similarityScore(attempt, query) {
    let score = 0;
    if (attempt.asset_kind === query.asset_kind) score += 4;
    if (attempt.profile === query.profile) score += 2;
    if (query.defect_category && attempt.human_category === query.defect_category) score += 3;
    if (attempt.human_verdict === 'approved') score += 2;
    if (attempt.artifacts?.glb_sha) score += 0.5;
    // 越新权重略高（最近 90 天）
    const ageDays = (Date.now() - new Date(attempt.created_at).getTime()) / 86400000;
    if (ageDays <= 90) score += 1;
    return score;
}

function findSimilarApproved(query, { limit = 5 } = {}) {
    const ownerId = query.owner_id ?? query.ownerId;
    const all = learningDb.listAttempts({ ownerId, limit: 500 });
    return all
        .filter(a => a.asset_kind === query.asset_kind && (!query.domain || a.domain === query.domain) && a.human_verdict === 'approved')
        .map(a => ({ attempt: a, score: similarityScore(a, query) }))
        .sort((x, y) => y.score - x.score)
        .slice(0, Math.max(1, Math.min(limit, 10)))
        .map(item => item.attempt);
}

// ---------- 因果链校验：只有闭环闭合的复盘才配指导后续 ----------
// v1 有效链：失败方确实是失败（自动失败或人工打回）、修复方人工 approved、
// 只改一个白名单变量、指标确有改善、自动门禁确有改善、且至少经过 Three.js 预览复测。
function isLearningGradeRetro(retro) {
    if (!retro || !retro.chain_valid) return false;
    const failed = learningDb.findAttemptById(retro.failed_attempt_id);
    const fixed = learningDb.findAttemptById(retro.fixed_attempt_id);
    if (!failed || !fixed) return false;
    // 失败方确实失败：自动失败，或人工打回
    const failedSample = failed.auto_status === 'failed' || failed.human_verdict === 'rejected';
    if (!failedSample) return false;
    if (fixed.human_verdict !== 'approved') return false;
    // 只改了一个白名单变量（按修复 Attempt 所在领域校验；旧数据 domain=model 行为不变）
    const param = retro.changed_variable?.param;
    if (!repairParamValid(fixed.domain || 'model', param, retro.changed_variable?.to)) return false;
    // 指标改善 + 自动门禁改善 + 至少 viewer 级复测
    const ev = retro.evidence || {};
    const viewerRetested = ev.validation_scope === 'viewer' || ev.validation_scope === 'game';
    return Boolean(ev.improved && ev.gate_improved && viewerRetested);
}

// ---------- 三档推荐：稳妥 / 改进 / 探索 ----------
// query: { owner_id, asset_kind, profile, defect_category?, based_on_attempt_id? }
function recommendCandidates(query) {
    const candidates = [];
    const approved = findSimilarApproved(query, { limit: 5 });

    // 稳妥方案：复用最近一条 approved 的参数（profile/seed/prompt 都沿用）
    const safe = approved[0];
    if (safe) {
        candidates.push({
            tier: 'safe',
            name: '稳妥方案',
            rationale: `复用 ${safe.id}（${CATEGORY_LABELS[safe.asset_kind] || safe.asset_kind}，${safe.profile}）已通过审片的参数`,
            params: { profile: safe.profile, seed: safe.seed, prompt: safe.prompt, skill_snapshot_sha: safe.skill_snapshot_sha },
            evidence_attempt_ids: [safe.id],
            risk: '低'
        });
    }

    // 改进方案：针对当前缺陷，找一条已闭合、同类缺陷的复盘，只套用它改的那一个变量
    if (query.defect_category) {
        const retros = learningDb.listRetrospectives({ ownerId: query.owner_id, limit: 200 });
        const chain = retros
            .filter(r => r.asset_kind === query.asset_kind && (!query.domain || r.domain === query.domain) && r.defect_category === query.defect_category)
            .filter(isLearningGradeRetro)[0];
        if (chain) {
            candidates.push({
                tier: 'improve',
                name: '改进方案',
                rationale: `针对「${CATEGORY_LABELS[query.defect_category] || query.defect_category}」，复用闭环 ${chain.id}：只把 ${chain.changed_variable.param} 从 ${JSON.stringify(chain.changed_variable.from)} 改为 ${JSON.stringify(chain.changed_variable.to)}`,
                params: { [chain.changed_variable.param]: chain.changed_variable.to },
                changed_variable: chain.changed_variable,
                evidence_attempt_ids: [chain.failed_attempt_id, chain.fixed_attempt_id],
                risk: '中'
            });
        }
    }

    // 探索方案：小比例扰动 seed（v1 只动 seed 一个变量，绝不碰全局参数）
    if (candidates.length < CANDIDATE_BUDGET.max_candidates) {
        candidates.push({
            tier: 'explore',
            name: '探索方案',
            rationale: '在稳妥参数基础上仅扰动 seed，小比例试新结果；不修改任何 Skill/Profile 全局设置',
            params: { seed: (Number(query.seed || 1234) + 7919) % 4294967296 },
            evidence_attempt_ids: safe ? [safe.id] : [],
            risk: '较高，仅作候选对比'
        });
    }

    return candidates.slice(0, CANDIDATE_BUDGET.max_candidates);
}

// ---------- 策略晋级门禁（服务端依据已闭合因果链计算证据，客户端不能伪造） ----------
const LIFECYCLE_ORDER = ['draft', 'shadow', 'small_scale', 'default'];
const LIFECYCLE_LABELS = {
    draft: '草稿', shadow: '影子验证', small_scale: '小范围启用', default: '默认策略', rolled_back: '已回滚'
};
const PROMOTION_GATES = {
    shadow: { min_valid: 1, min_game: 0, reason: valid => `至少需要 ${1} 条有效因果链才能晋级影子验证（当前 ${valid}）` },
    small_scale: { min_valid: 3, min_game: 0, reason: valid => `至少需要 ${3} 条有效因果链才能小范围启用（当前 ${valid}）` },
    default: { min_valid: 5, min_game: 1, reason: (valid, game) => `至少需要 ${5} 条有效因果链且其中 ${1} 条经过真实游戏内验证才能设为默认（当前有效 ${valid}，游戏验证 ${game}）` }
};

function canAdvance(policy, nextLifecycle, counts = {}) {
    if (nextLifecycle === 'rolled_back') return { ok: true, counts };
    if (!LIFECYCLE_ORDER.includes(nextLifecycle)) return { ok: false, reason: '未知阶段', counts };
    if (nextLifecycle !== LIFECYCLE_ORDER[LIFECYCLE_ORDER.indexOf(policy.lifecycle) + 1]) {
        return { ok: false, reason: '策略只能逐级晋级，不能跳级', counts };
    }
    const gate = PROMOTION_GATES[nextLifecycle];
    if (gate) {
        const valid = counts.valid || 0;
        const game = counts.game_verified || 0;
        if (valid < gate.min_valid || game < gate.min_game) {
            return { ok: false, reason: gate.reason(valid, game), counts };
        }
    }
    return { ok: true, counts };
}

// ---------- 证据计数：按账号、领域、资产类型与档位统计有效因果链 ----------
function countValidChains({ ownerId, assetKind, profile, domain } = {}) {
    const retros = learningDb.listRetrospectives({ ownerId, limit: 500 });
    const valid = retros.filter(r =>
        r.chain_valid &&
        (!domain || r.domain === domain) &&
        (!assetKind || r.asset_kind === assetKind) &&
        (!profile || r.profile === profile)
    );
    const gameVerified = valid.filter(r => r.evidence?.game_verified);
    return { valid: valid.length, game_verified: gameVerified.length };
}

// ---------- 单变量修复链辅助 ----------
// 从某 Attempt 沿 based_on_attempt_id 回退根节点，统计该链已发生的修复次数（深度）。
// 根 Attempt 深度 0；每条链最多 2 次修复，即允许创建的修复深度 ≤ 2。
function chainRepairDepth(attemptId) {
    let depth = 0;
    let cur = learningDb.findAttemptById(attemptId);
    const seen = new Set();
    while (cur && cur.based_on_attempt_id && !seen.has(cur.id)) {
        seen.add(cur.id);
        cur = learningDb.findAttemptById(cur.based_on_attempt_id);
        depth += 1;
        if (depth > 10) break; // 防御异常链
    }
    return depth;
}

// 读取 Attempt 某白名单变量当前值（用于 from），拿不到返回 undefined。
function currentVariableValue(attempt, param) {
    if (param === 'seed') return attempt?.seed;
    if (typeof param === 'string' && param.startsWith('generation.')) {
        return attempt?.execution_plan?.generation?.[param.slice('generation.'.length)];
    }
    return undefined;
}

// 判断该 Attempt 是否还能创建修复（剩余次数 > 0）。
function remainingRepairs(attemptId) {
    return Math.max(0, CANDIDATE_BUDGET.max_repairs - chainRepairDepth(attemptId));
}

// 点路径写入：'generation.triangle_budget' → plan.generation.triangle_budget = to；
// 中间层必须是普通对象；seed 不在计划内（走 job.input.seed）。
function setPlanPath(plan, param, to) {
    const parts = param.split('.');
    if (parts.length < 2 || parts[0] === 'seed') throw new Error(`不支持修复该变量：${param}`);
    let node = plan;
    for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i];
        if (!node[key] || typeof node[key] !== 'object' || Array.isArray(node[key])) {
            throw new Error(`父 Attempt 的执行计划缺少 ${key} 参数，无法修复该变量`);
        }
        node = node[key];
    }
    node[parts[parts.length - 1]] = to;
    return plan;
}

// 把单变量覆盖应用到执行计划并重算 SHA（返回新计划对象）。seed 不在计划内，计划不变。
function applyRepairToPlan(plan, param, to) {
    if (!plan || typeof plan !== 'object') throw new Error('父 Attempt 缺少执行计划，无法做单变量修复');
    const clean = { ...plan };
    delete clean.sha256;
    // 深拷贝：浅拷贝共享嵌套对象，setPlanPath 原地写入会污染父 Attempt 的计划快照
    const base = JSON.parse(JSON.stringify(clean));
    if (param === 'seed') {
        // seed 走 job.input.seed，执行计划不变
    } else if (typeof param === 'string' && param.includes('.')) {
        setPlanPath(base, param, to);
    } else {
        throw new Error(`不支持修复该变量：${param}`);
    }
    return { ...base, sha256: hashText(JSON.stringify(base)) };
}

// 提交 GPU 前的完整性校验：重算 SHA、回退单变量后必须与父执行计划 SHA 一致，
// 从而证明参考图/Skill/Profile/其余参数均未变化。点路径变量（generation./audio./animation.）同样校验。
function verifyRepairPlan(plan, parentPlanSha, pv) {
    if (!plan || typeof plan !== 'object') throw new Error('修复任务缺少执行计划');
    const validInAnyDomain = ['model', 'animation', 'audio'].some(domain => repairParamValid(domain, pv?.param, pv?.to));
    if (!pv || !validInAnyDomain) throw new Error('修复变量不在白名单内');
    const clean = { ...plan };
    delete clean.sha256;
    // 1) 当前计划 SHA 必须自洽
    const selfSha = hashText(JSON.stringify(clean));
    if (plan.sha256 !== selfSha) throw new Error('修复执行计划 SHA 不一致，已中止提交');
    // 2) 回退这一个变量后必须与父执行计划 SHA 一致（证明其余全部不变）
    if (pv.param !== 'seed' && typeof pv.param === 'string' && pv.param.includes('.')) {
        if (pv.from === undefined) throw new Error('修复变量缺少原值 from，无法校验未变化部分');
        const reverted = JSON.parse(JSON.stringify(clean));
        setPlanPath(reverted, pv.param, pv.from);
        const revertedSha = hashText(JSON.stringify(reverted));
        if (parentPlanSha && revertedSha !== parentPlanSha) {
            throw new Error('修复任务输入与父 Attempt 的参考图/Skill/Profile/其他参数不一致，已中止提交');
        }
    }
    return true;
}

// 判断 Attempt 是否可被修复（自动失败或人工打回）。
function isRepairableAttempt(attempt) {
    if (!attempt) return false;
    if (attempt.auto_status === 'failed') return true;
    if (attempt.human_verdict === 'rejected') return true;
    return false;
}

module.exports = {
    DOMAINS,
    DOMAIN_LABELS,
    FAILURE_CATEGORIES,
    CATEGORY_LABELS,
    CANDIDATE_BUDGET,
    SINGLE_VARIABLES,
    SINGLE_VARIABLE_RULES,
    VARIABLE_LABELS,
    REPAIR_VARIABLES,
    DOMAIN_REPAIR_VARIABLES,
    REGISTERED_WEIGHT_REPAIR_PLANS,
    REGISTERED_RETARGET_PLANS,
    LIFECYCLE_ORDER,
    LIFECYCLE_LABELS,
    PROMOTION_GATES,
    classifyFailure,
    qualityScore,
    gateValueFails,
    gateValuePasses,
    findSimilarApproved,
    isLearningGradeRetro,
    recommendCandidates,
    canAdvance,
    countValidChains,
    chainRepairDepth,
    remainingRepairs,
    currentVariableValue,
    currentDomainVariableValue,
    variablesForDomain,
    repairParamValid,
    applyRepairToPlan,
    verifyRepairPlan,
    isRepairableAttempt
};
