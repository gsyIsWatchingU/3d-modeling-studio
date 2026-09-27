// ForgeLoop 自进化经验库 HTTP 接口
//   /api/learning/recommend            建任务前：相似案例检索 + 三档候选推荐（不接管流水线）
//   /api/learning/attempts             不可变 Attempt 列表
//   /api/learning/attempts/pending     待审片队列（自动通过、待人工结论）
//   /api/learning/attempts/repairable  待修复队列（自动失败或人工打回、未耗尽修复次数）
//   /api/learning/attempts/:id/review  人工审片门禁（approved 才进经验库；打回作为失败样本）
//   /api/learning/attempts/:id/repair  失败/打回 → 创建全新单变量修复任务（不重置旧任务）
//   /api/learning/retrospectives       失败—修复—批准 的因果链
//   /api/learning/policies             角色/场景/道具最佳策略（草稿→影子→小范围→默认→回滚）
//   /api/learning/experiments          受控 A/B 实验
//   /api/learning/overview             「模型进化」页总览：失败分布、质量趋势、策略变更
const express = require('express');
const { learningDb, jobDb, modelDb } = require('./db');
const { requireModelUser, requireUser } = require('./auth');
const {
    DOMAINS, DOMAIN_LABELS,
    FAILURE_CATEGORIES, CATEGORY_LABELS, CANDIDATE_BUDGET,
    LIFECYCLE_LABELS, VARIABLE_LABELS,
    recommendCandidates, canAdvance, qualityScore,
    countValidChains, remainingRepairs, isRepairableAttempt, applyRepairToPlan,
    currentDomainVariableValue,
    variablesForDomain, repairParamValid
} = require('./modeling-learning');
const { onHumanVerdict } = require('./retrospective-worker');
const autoRepair = require('./auto-repair');

const ASSET_KINDS = ['prop', 'character', 'environment'];
const VALIDATION_SCOPES = ['viewer', 'game'];

// ForgeLoop v2 领域过滤：不传 domain 时默认只返回 model 领域（旧客户端兼容）；
// domain=all 表示不做领域过滤。
function resolveDomainFilter(value) {
    if (value === undefined || value === null || value === '') return 'model';
    if (value === 'all') return null;
    if (!DOMAINS.includes(value)) throw new Error(`domain 必须是 ${DOMAINS.join('/')} 之一，或 all`);
    return value;
}

function filterAttempts(attempts, query = {}) {
    const domain = resolveDomainFilter(query.domain);
    const assetId = query.asset_id ? String(query.asset_id).slice(0, 120) : null;
    const eventId = query.event_id ? String(query.event_id).slice(0, 120) : null;
    const project = query.project ? String(query.project).slice(0, 120) : null;
    return attempts.filter(a => {
        if (domain && a.domain !== domain) return false;
        if (assetId && a.asset_id !== assetId) return false;
        if (eventId && a.event_id !== eventId) return false;
        if (project && a.project !== project) return false;
        return true;
    });
}

function createLearningRouter({ wake = () => {} } = {}) {
    const router = express.Router();

    // 建任务前的候选推荐：只建议、不自动跑；附带单变量修复白名单供前端渲染（按领域）。
    router.post('/recommend', requireModelUser, (req, res) => {
        try {
            const body = req.body || {};
            const domain = resolveDomainFilter(body.domain || 'model');
            if (!domain) throw new Error('recommend 需要明确的 domain（不支持 all）');
            const assetKind = ASSET_KINDS.includes(body.asset_kind) ? body.asset_kind : 'prop';
            const query = {
                owner_id: req.user.id,
                domain,
                asset_kind: assetKind,
                profile: String(body.profile || 'xhs_mobile'),
                defect_category: FAILURE_CATEGORIES.includes(body.defect_category) ? body.defect_category : null,
                based_on_attempt_id: String(body.based_on_attempt_id || '') || null,
                seed: body.seed
            };
            const candidates = recommendCandidates(query);
            const domainRules = variablesForDomain(domain);
            res.json({
                success: true,
                data: {
                    domain,
                    domain_label: DOMAIN_LABELS[domain] || domain,
                    candidates,
                    budget: CANDIDATE_BUDGET,
                    variables: Object.keys(domainRules).map(param => ({
                        param,
                        label: VARIABLE_LABELS[param] || param,
                        rule: describeRule(param)
                    })),
                    note: '推荐仅作参考：每次最多跑上述候选中的一个，修复最多 2 次；用完即交人工判断。'
                }
            });
        } catch (error) {
            res.status(400).json({ success: false, error: error.message });
        }
    });

    // 不可变 Attempt 列表（v2：支持 domain / asset_id / event_id / project 过滤；默认 model 领域）
    router.get('/attempts', requireModelUser, (req, res) => {
        try {
            const attempts = filterAttempts(
                learningDb.listAttempts({ ownerId: req.user.id, limit: Number(req.query.limit) || 100 }),
                req.query
            );
            res.json({ success: true, data: attempts });
        } catch (error) {
            res.status(400).json({ success: false, error: error.message });
        }
    });

    // 待审片队列：自动成功、但人工尚未结论的 Attempt（v2 领域过滤）
    router.get('/attempts/pending', requireModelUser, (req, res) => {
        try {
            const pending = filterAttempts(
                learningDb.listAttempts({ ownerId: req.user.id, limit: 500 }),
                req.query
            )
                .filter(a => a.human_verdict === 'pending' && a.auto_status === 'succeeded')
                .slice(0, 100)
                .map(a => {
                    const model = a.artifacts?.glb_file ? modelDb.list().find(m => m.model_file === a.artifacts.glb_file) : null;
                    return {
                        id: a.id, job_id: a.job_id, domain: a.domain, project: a.project, stage: a.stage,
                        asset_id: a.asset_id, event_id: a.event_id,
                        asset_kind: a.asset_kind, profile: a.profile,
                        prompt: a.prompt, created_at: a.created_at,
                        glb_file: a.artifacts?.glb_file, glb_sha: a.artifacts?.glb_sha,
                        preview_url: a.artifacts?.preview_url,
                        metrics: a.metrics, quality_score: qualityScore(a.metrics),
                        model_id: model?.id || null
                    };
                });
            res.json({ success: true, data: pending });
        } catch (error) {
            res.status(400).json({ success: false, error: error.message });
        }
    });

    // 待修复队列：自动失败或人工打回、且还有剩余修复次数的 Attempt（v2 领域过滤）
    router.get('/attempts/repairable', requireModelUser, (req, res) => {
        try {
            const items = filterAttempts(
                learningDb.listAttempts({ ownerId: req.user.id, limit: 500 }),
                req.query
            )
                .filter(isRepairableAttempt)
                .filter(a => remainingRepairs(a.id) > 0)
                .slice(0, 200)
                .map(a => {
                    const model = a.artifacts?.glb_file ? modelDb.list().find(m => m.model_file === a.artifacts.glb_file) : null;
                    return {
                        id: a.id, job_id: a.job_id, domain: a.domain, project: a.project, stage: a.stage,
                        asset_id: a.asset_id, event_id: a.event_id,
                        asset_kind: a.asset_kind, profile: a.profile,
                        prompt: a.prompt, created_at: a.created_at,
                        glb_file: a.artifacts?.glb_file,
                        failure_category: a.human_category || a.failure_category,
                        failure_detail: a.human_notes || a.failure_detail || '',
                        defect_score: a.human_defect_score,
                        based_on_attempt_id: a.based_on_attempt_id,
                        changed_variable: a.changed_variable,
                        remaining_repairs: remainingRepairs(a.id),
                        quality_score: qualityScore(a.metrics),
                        variables: Object.keys(variablesForDomain(a.domain)).map(param => ({ param, label: VARIABLE_LABELS[param] || param, current: currentDomainVariableValue(a, param) })),
                        model_id: model?.id || null
                    };
                });
            res.json({ success: true, data: items });
        } catch (error) {
            res.status(400).json({ success: false, error: error.message });
        }
    });

    // 人工审片门禁：approved 才可能成为经验；rejected 作为失败样本，必须给原因分类与 1~5 缺陷评分。
    router.post('/attempts/:id/review', requireUser, (req, res) => {
        try {
            const attempt = learningDb.findAttemptById(req.params.id);
            if (!attempt || attempt.owner_id !== req.user.id) return res.status(404).json({ success: false, error: 'Attempt 不存在' });
            const verdict = req.body?.verdict === 'approved' ? 'approved' : 'rejected';
            const category = FAILURE_CATEGORIES.includes(req.body?.category) ? req.body.category : null;
            if (verdict === 'rejected' && !category) return res.status(400).json({ success: false, error: '打回时必须选择失败/缺陷原因，经验库才能据此学习' });
            // 缺陷评分：1~5 整数；打回必须给分，批准可为空
            let defectScore = null;
            if (req.body?.defect_score !== undefined && req.body?.defect_score !== null && req.body?.defect_score !== '') {
                defectScore = Number(req.body.defect_score);
                if (!Number.isInteger(defectScore) || defectScore < 1 || defectScore > 5) {
                    return res.status(400).json({ success: false, error: '缺陷评分必须是 1~5 的整数' });
                }
            }
            if (verdict === 'rejected' && defectScore === null) {
                return res.status(400).json({ success: false, error: '打回时必须给出 1~5 的缺陷评分，供后续修复参考' });
            }
            const scope = String(req.body?.validation_scope || '');
            if (scope && !VALIDATION_SCOPES.includes(scope)) return res.status(400).json({ success: false, error: 'validation_scope 必须是 viewer 或 game' });
            const result = onHumanVerdict(attempt.id, verdict, {
                category,
                notes: String(req.body?.notes || '').slice(0, 1000),
                retestedInGame: scope === 'game',
                validationScope: scope || null,
                defectScore,
                reviewerId: req.user.id
            });
            res.json({ success: true, data: result });
        } catch (error) {
            res.status(400).json({ success: false, error: error.message });
        }
    });

    // 创建修复任务：以失败/打回 Attempt 为依据，复制参考图、Skill 快照、执行计划与生产上下文，
    // 仅修改一个白名单变量；创建全新 job_id，绝不重置旧任务；每条链最多 2 次修复。
    router.post('/attempts/:id/repair', requireModelUser, (req, res) => {
        try {
            const attempt = learningDb.findAttemptById(req.params.id);
            if (!attempt || attempt.owner_id !== req.user.id) return res.status(404).json({ success: false, error: 'Attempt 不存在' });
            if (!isRepairableAttempt(attempt)) return res.status(400).json({ success: false, error: '只有自动失败或人工打回的 Attempt 才能创建修复任务' });

            const remaining = remainingRepairs(attempt.id);
            if (remaining <= 0) return res.status(400).json({ success: false, error: '该条链的修复次数已用完（最多 2 次），请交人工判断' });

            const cv = req.body?.variable || {};
            const param = String(cv.param || '');
            // v2：单变量白名单按 Attempt 所在领域校验（旧建模 Attempt domain=model，行为不变）
            const domain = attempt.domain || 'model';
            const domainRules = variablesForDomain(domain);
            if (!Object.prototype.hasOwnProperty.call(domainRules, param)) {
                return res.status(400).json({ success: false, error: `修复变量不在「${DOMAIN_LABELS[domain] || domain}」领域白名单内：${param || '(空)'}（允许 ${Object.keys(domainRules).join('、')}）` });
            }
            const from = cv.from !== undefined && cv.from !== null ? cv.from : currentDomainVariableValue(attempt, param);
            if (from === undefined || from === null) {
                return res.status(400).json({ success: false, error: '无法确定该变量在父 Attempt 中的当前值，不能做单变量修复' });
            }
            const to = cv.to;
            if (!repairParamValid(domain, param, to)) return res.status(400).json({ success: false, error: '目标值不符合该变量的合法范围' });
            if (JSON.stringify(from) === JSON.stringify(to)) return res.status(400).json({ success: false, error: '修复值必须与当前值不同' });

            const parentJob = jobDb.findById(attempt.job_id);
            if (!parentJob) return res.status(400).json({ success: false, error: '父任务不存在，无法复制执行上下文' });
            const parentPlan = parentJob.execution_plan;
            if (!parentPlan) return res.status(400).json({ success: false, error: '父 Attempt 未保存执行计划，无法做单变量修复' });

            const reason = String(cv.reason || '').slice(0, 200);
            const changedVariable = { param, from, to, reason };
            const repairVariable = { param, from, to, reason };
            const newPlan = applyRepairToPlan(parentPlan, param, to);

            // 生产上下文复制：同一批参考图、同一 Skill 快照、同一计划、同一生产计划/通知通道
            // v2：领域/项目/阶段/资产/事件/契约哈希随父 Attempt 透传，修复链保持同域同资产
            const seed = param === 'seed' ? to : parentJob.input.seed;
            const job = jobDb.create({
                owner_id: req.user.id,
                production_plan_id: parentJob.production_plan_id || null,
                name: `${parentJob.name || '修复'}-修复${attempt.id}`.slice(0, 80),
                domain: attempt.domain || 'model',
                project: attempt.project || parentJob.project || null,
                stage: attempt.stage || null,
                asset_id: attempt.asset_id || null,
                event_id: attempt.event_id || null,
                evidence: attempt.evidence || {},
                contract_hash: attempt.contract_hash || null,
                input: {
                    images: [...(parentJob.input.images || [])],
                    prompt: parentJob.input.prompt || attempt.prompt || '',
                    asset_kind: parentJob.input.asset_kind || attempt.asset_kind || 'prop',
                    profile: parentJob.input.profile || attempt.profile || 'xhs_mobile',
                    seed
                },
                skill_snapshot: parentJob.skill_snapshot || null,
                requested_channels: [...(parentJob.requested_channels || [])],
                base_url: parentJob.base_url || '',
                based_on_attempt_id: attempt.id,
                changed_variable: changedVariable,
                repair_variable: repairVariable,
                parent_plan_sha: parentPlan.sha256 || null,
                execution_plan: newPlan
            });
            wake();
            res.status(201).json({
                success: true,
                data: {
                    job,
                    attempt,
                    changed_variable: changedVariable,
                    parent_attempt_id: attempt.id,
                    remaining_after: remaining - 1,
                    plan_sha: newPlan.sha256,
                    note: '已创建全新修复任务；参考图、Skill、Profile 与其他参数保持不变，仅修改声明的一个变量。'
                }
            });
        } catch (error) {
            res.status(400).json({ success: false, error: error.message });
        }
    });

    // 复盘因果链
    router.get('/retrospectives', requireModelUser, (req, res) => {
        res.json({ success: true, data: learningDb.listRetrospectives({ ownerId: req.user.id, limit: Number(req.query.limit) || 100 }) });
    });

    // 策略列表（仅当前账号）
    router.get('/policies', requireModelUser, (req, res) => {
        const policies = learningDb.listPolicies({ ownerId: req.user.id, includeRolledBack: req.query.include_rolled_back === '1' });
        res.json({
            success: true,
            data: policies.map(p => ({ ...p, lifecycle_label: LIFECYCLE_LABELS[p.lifecycle] || p.lifecycle }))
        });
    });

    // 新建草稿策略（人工从一条复盘提炼，禁止自动写全局参数；证据数一律服务端计算，客户端不能提交/伪造）
    router.post('/policies', requireUser, (req, res) => {
        try {
            const body = req.body || {};
            const domain = resolveDomainFilter(body.domain || 'model');
            if (!domain) throw new Error('策略需要明确的 domain（不支持 all）');
            if (!ASSET_KINDS.includes(body.asset_kind)) throw new Error('asset_kind 必须是 prop/character/environment');
            // 校验 basis_retro_ids 属于当前账号
            const basis = Array.isArray(body.basis_retro_ids) ? body.basis_retro_ids.slice(0, 20) : [];
            for (const rid of basis) {
                const retro = learningDb.listRetrospectives({ ownerId: req.user.id, limit: 500 }).find(r => r.id === rid);
                if (!retro) throw new Error(`复盘 ${rid} 不存在或不属于当前账号`);
            }
            // v2：策略可携带已登记的修复变量（晋级到 default/small_scale 后由 model-worker 注入新任务执行计划）
            let changedVariable = null;
            if (body.changed_variable) {
                const pv = body.changed_variable;
                if (!repairParamValid(domain, String(pv.param || ''), pv.to)) {
                    throw new Error('策略的 changed_variable 必须属于该领域白名单且值合法');
                }
                changedVariable = { param: String(pv.param), to: pv.to, reason: String(pv.reason || '').slice(0, 200) };
            }
            let sampleRatio = 0;
            if (body.sample_ratio !== undefined && body.sample_ratio !== null && body.sample_ratio !== '') {
                sampleRatio = Number(body.sample_ratio);
                if (!Number.isFinite(sampleRatio) || sampleRatio < 0 || sampleRatio > 1) throw new Error('sample_ratio 必须是 0～1 的数字');
            }
            const policy = learningDb.createPolicy({
                owner_id: req.user.id,
                domain,
                asset_kind: body.asset_kind,
                scope: { profile: body.scope?.profile || null },
                name: body.name,
                description: body.description,
                params: body.params || {},
                basis_retro_ids: basis,
                changed_variable: changedVariable || undefined,
                sample_ratio: sampleRatio
            });
            res.status(201).json({ success: true, data: policy });
        } catch (error) {
            res.status(400).json({ success: false, error: error.message });
        }
    });

    // 晋级 / 回滚：证据数量由服务端依据该账号已闭合的有效因果链实时计算（按策略领域）
    router.post('/policies/:id/advance', requireUser, (req, res) => {
        try {
            const policy = learningDb.findPolicyById(req.params.id, req.user.id);
            if (!policy) return res.status(404).json({ success: false, error: '策略不存在' });
            const next = String(req.body?.lifecycle || '');
            const counts = countValidChains({
                ownerId: req.user.id,
                domain: policy.domain || 'model',
                assetKind: policy.asset_kind,
                profile: policy.scope?.profile || null
            });
            const gate = canAdvance(policy, next, counts);
            if (!gate.ok) {
                return res.status(400).json({ success: false, error: gate.reason, evidence: gate.counts });
            }
            const updated = learningDb.advancePolicy(policy.id, next, {
                reason: req.body?.reason,
                reviewerId: req.user.id,
                evidenceCount: counts.valid,
                gameVerifiedCount: counts.game_verified
            });
            res.json({ success: true, data: { ...updated, lifecycle_label: LIFECYCLE_LABELS[updated.lifecycle], evidence: counts } });
        } catch (error) {
            res.status(400).json({ success: false, error: error.message });
        }
    });

    // 生效策略（default/small_scale/shadow）：供「模型进化」页展示；实际注入由 model-worker 的计划编译器读取
    router.get('/policies/effective', requireModelUser, (req, res) => {
        try {
            const domain = resolveDomainFilter(req.query.domain || 'all');
            const policies = learningDb.listEffectivePolicies({
                ownerId: req.user.id,
                domain: domain || undefined,
                assetKind: req.query.asset_kind || undefined,
                profile: req.query.profile || undefined
            });
            res.json({ success: true, data: policies.map(p => ({ ...p, lifecycle_label: LIFECYCLE_LABELS[p.lifecycle] || p.lifecycle })) });
        } catch (error) {
            res.status(400).json({ success: false, error: error.message });
        }
    });

    // 自动修复编排（v2）：对待修复 Attempt 执行受限自动决策
    //  - GET  /auto-repair/pending-triage   不可自动修复的待处理队列（歧义/审美/未知/基础设施）
    //  - POST /auto-repair/queue            每轮最多 3 个候选、每父链最多 2 次；幂等不重复创建
    //  - POST /attempts/:id/auto-repair     单条 Attempt 的决策与创建（不提交 GPU，提交由执行器负责）
    router.get('/auto-repair/pending-triage', requireModelUser, (req, res) => {
        try {
            const items = autoRepair.listPendingTriage({ ownerId: req.user.id })
                .slice(0, 100)
                .map(item => ({
                    attempt_id: item.attempt.id,
                    job_id: item.attempt.job_id,
                    domain: item.attempt.domain,
                    asset_id: item.attempt.asset_id,
                    event_id: item.attempt.event_id,
                    failure_category: item.attempt.human_category || item.attempt.failure_category,
                    failure_detail: item.attempt.human_notes || item.attempt.failure_detail || '',
                    defer_reason: item.decision.reason,
                    human_verdict: item.attempt.human_verdict
                }));
            res.json({ success: true, data: items });
        } catch (error) {
            res.status(400).json({ success: false, error: error.message });
        }
    });

    router.post('/auto-repair/queue', requireModelUser, (req, res) => {
        try {
            const result = autoRepair.queueAutoRepairs({ ownerId: req.user.id });
            res.json({
                success: true,
                data: result,
                note: '只创建子 Attempt，不提交 GPU；执行由 repair-executor 按 job_id 幂等完成，绝不自动批准。'
            });
        } catch (error) {
            res.status(400).json({ success: false, error: error.message });
        }
    });

    router.post('/attempts/:id/auto-repair', requireModelUser, (req, res) => {
        try {
            const attempt = learningDb.findAttemptById(req.params.id);
            if (!attempt || attempt.owner_id !== req.user.id) return res.status(404).json({ success: false, error: 'Attempt 不存在' });
            const decision = autoRepair.decideAutoRepair(attempt);
            if (decision.action !== 'repair') {
                return res.status(400).json({ success: false, error: decision.reason, action: decision.action });
            }
            const result = autoRepair.createAutoRepairChild(attempt, decision);
            res.status(result.created ? 201 : 200).json({ success: true, data: { ...result, decision } });
        } catch (error) {
            res.status(400).json({ success: false, error: error.message });
        }
    });

    // 受控实验
    router.get('/experiments', requireModelUser, (req, res) => {
        res.json({ success: true, data: learningDb.listExperiments({ ownerId: req.user.id, limit: Number(req.query.limit) || 100 }) });
    });

    // 总览：失败分布 + 质量趋势 + 策略分布 + 闭环数（全部按账号隔离）
    router.get('/overview', requireModelUser, (req, res) => {
        const attempts = learningDb.listAttempts({ ownerId: req.user.id, limit: 500 });
        const retros = learningDb.listRetrospectives({ ownerId: req.user.id, limit: 500 });
        const policies = learningDb.listPolicies({ ownerId: req.user.id });

        const failureDist = {};
        for (const a of attempts) {
            if (a.auto_status !== 'failed' && a.human_verdict !== 'rejected') continue;
            const cat = a.human_category || a.failure_category || 'unknown';
            failureDist[cat] = (failureDist[cat] || 0) + 1;
        }
        const verdictDist = {};
        for (const a of attempts) verdictDist[a.human_verdict] = (verdictDist[a.human_verdict] || 0) + 1;
        const trend = {};
        for (const a of attempts) {
            const month = new Date(a.created_at).toISOString().slice(0, 7);
            trend[month] = trend[month] || { approved: 0, rejected: 0, pending: 0 };
            trend[month][a.human_verdict] = (trend[month][a.human_verdict] || 0) + 1;
        }
        const policyDist = {};
        for (const p of policies) policyDist[p.lifecycle] = (policyDist[p.lifecycle] || 0) + 1;
        const domainDist = {};
        for (const a of attempts) domainDist[a.domain || 'model'] = (domainDist[a.domain || 'model'] || 0) + 1;

        res.json({
            success: true,
            data: {
                totals: {
                    attempts: attempts.length,
                    failed: attempts.filter(a => a.auto_status === 'failed' || a.human_verdict === 'rejected').length,
                    approved: verdictDist.approved || 0,
                    rejected: verdictDist.rejected || 0,
                    pending: verdictDist.pending || 0,
                    valid_chains: retros.filter(r => r.chain_valid).length
                },
                domain_distribution: domainDist,
                domain_labels: DOMAIN_LABELS,
                failure_distribution: failureDist,
                failure_labels: CATEGORY_LABELS,
                verdict_distribution: verdictDist,
                monthly_trend: trend,
                policy_distribution: policyDist,
                lifecycle_labels: LIFECYCLE_LABELS,
                failure_categories: FAILURE_CATEGORIES
            }
        });
    });

    return router;
}

function describeRule(param) {
    switch (param) {
        case 'seed': return '0～4294967295 的整数';
        case 'generation.triangle_budget': return '1000～120000 的整数';
        case 'generation.texture_size': return '512 / 1024 / 2048 / 4096';
        case 'generation.paint_views': return '6～9 的整数';
        case 'generation.paint_resolution': return '512 / 768';
        case 'generation.roughness_floor': return '0.15～0.8 的数字';
        case 'generation.specular_level': return '0.1～0.5 的数字';
        case 'animation.weight_repair_plan': return '已登记的权重修复方案之一（sanitize_skin_weights / repair_rig_symmetry / stabilize_locomotion）';
        case 'animation.retarget_plan': return '已登记的重定向方案之一（retarget_actions）';
        case 'audio.gain_adjust': return '0.05～2.0 的增益倍率';
        case 'audio.trim_start_s': return '0～30 的截取起点（秒）';
        default: return '';
    }
}

module.exports = { createLearningRouter };