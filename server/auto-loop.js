// ForgeLoop v3 —— 无人值守自动迭代闭环
// generated → auto_evaluating → auto_repairing → auto_accepted / auto_rejected / exhausted / quarantined
//  - 每次失败自动创建独立子 Attempt + 新 Job ID（不复用同一 Job）
//  - 从结构化缺陷中选择一个白名单变量（按 Attempt.domain 校验）
//  - 调用真实 GPU 执行器重新生产，保存任务 ID/模型/参数/路径/SHA
//  - 自动跑资产检查、游戏接入、真实浏览器复测；与父候选 champion/challenger 对比
//  - 通过全部硬门禁且质量提升 → auto_accepted；默认最多 3 次；无改善/连续退化/能力缺失 → exhausted/quarantined
//  - 服务重启从数据库恢复，不重复创建 Job；并发锁防重复提交
'use strict';
const { learningDb, jobDb, autoLockDb, AUTO_FLOW_TRANSITIONS } = require('./db');
const { ensurePolicies, domainQualityScore, POLICY_V1 } = require('./auto-policy');
const { classifyFailure, repairParamValid, variablesForDomain } = require('./modeling-learning');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const LOCK_TTL_MS = 10 * 60 * 1000;

// ---------- ForgeLoop v3.1 animation@2 ----------
// critical 标签（VLM 文本命中任一即硬失败，防平均分掩盖局部严重失败）
const CRITICAL_LABELS = ['比例失调', '骨架断裂', '严重穿模', '跑出画面', '僵硬失真', '结构崩塌', '几何形变', '动作僵硬'];
const EVIDENCE_MODES = ['raw_generic_glb', 'runtime_rotation_only'];

// 解析 GPU VLM 输出：取 0~1 评分 + 命中标签
function parseGpuVlmText(text) {
    const s = String(text || '').trim();
    const m = s.match(/(?:评分|score|质量)[：:]\s*(0?\.\d+|1(?:\.0)?)/i);
    const score = m ? Math.max(0, Math.min(1, parseFloat(m[1]))) : null;
    const labels = CRITICAL_LABELS.filter(l => s.includes(l));
    return { score, labels, critical: labels, text: s.slice(0, 400) };
}

// 构建带标记的 VLM 证据样本（每份证据必须标记 mode/viewport/camera/animation_time/artifact_sha）
//  - 优先 attempt.evidence.samples / external.samples（显式标记）
//  - 旧证据仅给 gpu_images 时按 scope 推导并记录 tagged_by: 'scope'
function buildVlmSamples(attempt, external = {}) {
    const ev = attempt.evidence || {};
    const scope = ev.scope || external.scope || 'runtime_rotation_only_gameplay';
    const defaultMode = String(scope).includes('raw') ? 'raw_generic_glb' : 'runtime_rotation_only';
    const artifactSha = attempt.artifacts?.glb_sha || attempt.artifacts?.artifact_sha || null;
    // 新鲜外部证据优先（continue 阶段上传的最新样本）；子 Attempt 继承的父样本属旧证据，不得覆盖新证据
    const rawSamples = Array.isArray(external.samples) && external.samples.length
        ? external.samples.map(s => ({ ...s }))
        : (Array.isArray(ev.samples) && ev.samples.length ? ev.samples.map(s => ({ ...s })) : []);
    // 旧证据兼容：gpu_images → 每张一个样本；precomputed gpu_review（含文本）→ 一个 runtime 样本（文本含 critical 标签时仍触发硬失败）
    if (!rawSamples.length && Array.isArray(external.gpu_images) && external.gpu_images.length) {
        for (const img of external.gpu_images) rawSamples.push({ image: img });
    }
    if (!rawSamples.length && external.gpu_review && typeof external.gpu_review.score === 'number') {
        rawSamples.push({
            image: null,
            name: 'precomputed_gpu_review',
            vlm_score: external.gpu_review.score,
            vlm_text: external.gpu_review.text || ''
        });
    }
    const samples = rawSamples.map(s => {
        const mode = s.mode || (s.scope && String(s.scope).includes('raw') ? 'raw_generic_glb' : defaultMode);
        const name = String(s.image || s.name || '');
        const isMobile = name.includes('mobile') || s.viewport === 'mobile';
        return {
            image: s.image || null,
            mode: EVIDENCE_MODES.includes(mode) ? mode : defaultMode,
            viewport: s.viewport || ev.viewport || (mode === 'raw_generic_glb' ? 'blender-viewer' : (isMobile ? 'mobile' : 'desktop')),
            camera: s.camera || ev.camera || (mode === 'raw_generic_glb' ? 'blender-camera-45' : 'game-camera'),
            animation_time: s.animation_time ?? ev.animation_time ?? null,
            artifact_sha: s.artifact_sha || artifactSha || null,
            scope: s.scope || scope,
            name: s.name || null,
            vlm_score: s.vlm_score ?? null,
            vlm_text: s.vlm_text ?? null,
            vlm_labels: s.vlm_labels || [],
            tagged_by: s.mode ? 'explicit' : 'scope'
        };
    });
    return { samples, defaultMode };
}

// 确定性评分：硬门禁均值 0~1（与 v1 一致的缺项中性处理）
function deterministicScore(gates) {
    const parts = [];
    for (const [, value] of Object.entries(gates || {})) {
        if (value === true || value === 'pass' || value === 'passed') parts.push(1);
        else if (value === false || value === 'fail' || value === 'failed') parts.push(0);
        else if (typeof value === 'number') parts.push(Math.max(0, Math.min(1, value)));
    }
    if (!parts.length) return null;
    return parts.reduce((s, v) => s + v, 0) / parts.length;
}

function regressionScore(regression = {}) {
    const parts = [];
    for (const [, value] of Object.entries(regression || {})) {
        if (value === true || value === 'pass' || value === 'passed') parts.push(1);
        else if (value === false || value === 'fail' || value === 'failed') parts.push(0);
        else if (typeof value === 'number') parts.push(Math.max(0, Math.min(1, value)));
    }
    if (!parts.length) return 1.0; // 无回归门禁输入按通过（显式记录在向量里）
    return parts.reduce((s, v) => s + v, 0) / parts.length;
}

// 可追溯评分向量（animation@2）：overall = min(...) 保守聚合，防止平均稀释
// vlm_mean = min(各模式样本均值)、vlm_min = min(各模式样本最低分)——原始 GLB 与 rotation-only 不混合平均
function computeScoreVector(policy, evaluation) {
    const vlm = evaluation.vlm || {};
    const perMode = vlm.per_mode || {};
    const modeNames = Object.keys(perMode);
    let vlmMean = null;
    let vlmMin = null;
    if (modeNames.length) {
        const means = modeNames.map(m => perMode[m].mean).filter(v => v !== null && v !== undefined);
        const mins = modeNames.map(m => perMode[m].min).filter(v => v !== null && v !== undefined);
        vlmMean = means.length ? Math.min(...means) : null;
        vlmMin = mins.length ? Math.min(...mins) : null;
    } else if (vlm.mean !== undefined || vlm.min !== undefined) {
        vlmMean = vlm.mean ?? null;
        vlmMin = vlm.min ?? null;
    }
    const det = deterministicScore(evaluation.hard_gates);
    const reg = regressionScore(evaluation.regression);
    const present = [det, vlmMean, vlmMin, reg].filter(v => v !== null && v !== undefined);
    const overall = present.length ? Math.min(...present) : null;
    return {
        deterministic_score: det,
        vlm_mean: vlmMean,
        vlm_min: vlmMin,
        regression_score: reg,
        overall_score: overall,
        formula: policy?.scoring?.formula || 'min(deterministic_score, vlm_mean, vlm_min, regression_score)',
        per_mode: perMode
    };
}

// ---------- 确定性硬门禁（工厂侧本地检查，通用） ----------
// 对 Attempt 快照做来源/格式/预算/产物 SHA 校验；返回 { hard_gates, defects }
function runLocalGates(attempt) {
    const gates = {};
    const defects = [];
    const policy = POLICY_V1[attempt.domain] || POLICY_V1.model;
    for (const g of policy.hard_gates) gates[g.id] = true;
    // 来源：artifact glb_sha 与 pipeline.task_id
    if (!attempt.artifacts?.glb_sha && !attempt.artifacts?.artifact_sha) {
        gates.provenance = false; defects.push({ gate: 'provenance', severity: 'hard', desc: '缺少产物 SHA' });
    }
    if (!attempt.pipeline?.task_id && !attempt.job_id) {
        gates.provenance = false; defects.push({ gate: 'provenance', severity: 'hard', desc: '缺少 GPU 任务 ID' });
    }
    // 解码：GLB 文件存在且非空
    const glbPath = attempt.artifacts?.glb_file || attempt.artifacts?.artifact_file;
    if (glbPath && fs.existsSync(glbPath)) {
        const stat = fs.statSync(glbPath);
        if (stat.size < 1024) { gates.decode = false; defects.push({ gate: 'decode', severity: 'hard', desc: 'GLB 过小' }); }
    }
    // 预算：三角面
    if (typeof attempt.metrics?.triangles === 'number') {
        const max = policy.thresholds.triangle_budget_max?.value ?? 120000;
        if (attempt.metrics.triangles > max) { gates.budget = false; defects.push({ gate: 'budget', severity: 'hard', desc: `三角面 ${attempt.metrics.triangles} > ${max}` }); }
    }
    // 动画非静态：位移/旋转方差证据
    if (attempt.domain === 'animation' && attempt.evidence?.animation) {
        const ev = attempt.evidence.animation;
        if (typeof ev.displacement === 'number' && ev.displacement <= 0) {
            gates.not_static = false; defects.push({ gate: 'not_static', severity: 'hard', desc: '动作无位移（疑似静态）' });
        }
        if (typeof ev.joint_angle_anomaly_ratio === 'number' && ev.joint_angle_anomaly_ratio > 0.1) {
            gates.joint_angle = false; defects.push({ gate: 'joint_angle', severity: 'hard', desc: `关节角异常 ${ev.joint_angle_anomaly_ratio}` });
        }
        if (typeof ev.clipping_count === 'number' && ev.clipping_count > 0) {
            gates.clipping = false; defects.push({ gate: 'clipping', severity: 'hard', desc: `穿模 ${ev.clipping_count} 处` });
        }
        if (typeof ev.root_drift === 'number' && ev.root_drift > 0.2) {
            gates.root_drift = false; defects.push({ gate: 'root_drift', severity: 'hard', mode: 'runtime_rotation_only', desc: `根漂移 ${ev.root_drift}` });
        }
        // ForgeLoop v3.1：原始 GLB 骨盆/根位移比（raw_generic_glb 模式，rest/bind 空间）——不得被 runtime 证据掩盖
        if (typeof ev.root_translation_ratio === 'number' && ev.root_translation_ratio > 0.5) {
            gates.root_translation_ratio = false; defects.push({ gate: 'root_translation_ratio', severity: 'hard', mode: 'raw_generic_glb', desc: `原始 GLB 骨盆位移比 ${ev.root_translation_ratio} 超阈值` });
        }
        if (typeof ev.loop_seam === 'number' && ev.loop_seam > 0.05) {
            gates.loop_seam = false; defects.push({ gate: 'loop_seam', severity: 'hard', desc: `循环接缝 ${ev.loop_seam}` });
        }
    }
    // 音频
    if (attempt.domain === 'audio') {
        const ev = attempt.evidence?.audio || {};
        if (ev.silent === true) { gates.not_silent = false; defects.push({ gate: 'not_silent', severity: 'hard', desc: '静音' }); }
        if (ev.clipping === true) { gates.no_clip = false; defects.push({ gate: 'no_clip', severity: 'hard', desc: '削波' }); }
        if (ev.unstopped === true) { gates.stop_on_transition = false; defects.push({ gate: 'stop_on_transition', severity: 'hard', desc: '存在未停止源' }); }
    }
    return { gates, defects };
}

// ---------- GPU 多模态审查钩子（自有服务器，不调外部付费） ----------
// 调 mygpu interview-vlm（127.0.0.1:8002，Qwen3.5-27B）。本地开发机/无服务时返回 null（不伪造、不阻断硬门禁）。
async function gpuReviewImage(imagePath, promptText) {
    if (!imagePath || !fs.existsSync(imagePath)) return null;
    try {
        const { execFile } = require('child_process');
        const script = `
import base64, json, urllib.request
img = base64.b64encode(open(${JSON.stringify(imagePath)}, 'rb').read()).decode()
model = "qwen3.5-9b-fp8"
try:
    req0 = urllib.request.Request("http://127.0.0.1:8002/v1/models", headers={"Content-Type": "application/json"})
    out0 = json.loads(urllib.request.urlopen(req0, timeout=15).read())
    ids = [m.get("id") for m in out0.get("data", [])]
    if ids: model = ids[0]
except Exception:
    pass
body = {
  "model": model,
  "messages": [{"role": "user", "content": [
      {"type": "image_url", "image_url": {"url": "data:image/png;base64," + img}},
      {"type": "text", "text": ${JSON.stringify(promptText)}}
  ]}],
  "max_tokens": 300
}
req = urllib.request.Request("http://127.0.0.1:8002/v1/chat/completions", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
try:
    r = urllib.request.urlopen(req, timeout=60)
    out = json.loads(r.read())
    print(out["choices"][0]["message"]["content"])
except Exception as e:
    print("GPU_REVIEW_FAIL " + str(e))
`;
        const tmp = `/tmp/gpu-review-${process.pid}-${Date.now()}.py`;
        fs.writeFileSync(tmp, script);
        const { execSync } = require('child_process');
        const stdout = execSync(`python3 ${tmp}`, { timeout: 90000, encoding: 'utf8' });
        fs.unlinkSync(tmp);
        const text = String(stdout || '').trim();
        if (!text || text.startsWith('GPU_REVIEW_FAIL')) return null;
        // 解析 0~1 评分：优先取 "评分：0.8" 之类；否则由确定性指标给中性
        const m = text.match(/(?:评分|score|质量)[：:]\s*(0?\.\d+|1(?:\.0)?)/i);
        return { score: m ? Math.max(0, Math.min(1, parseFloat(m[1]))) : 0.5, text: text.slice(0, 400), model: 'qwen3.5-9b-fp8(auto)' };
    } catch {
        return null;
    }
}

// ---------- 自动评估（ForgeLoop v3.1 animation@2） ----------
// evaluate：调用方注入的评估实现（试点驱动可传游戏侧硬门禁结果）；默认跑本地门禁。
// 返回 { gates, gpu_review, vlm, metrics, defects, score_vector, score, passed }
async function evaluateAttempt(attempt, { external = null, gpuImages = null } = {}) {
    const policy = POLICY_V1[attempt.domain] || POLICY_V1.model;
    const local = runLocalGates(attempt);
    const defects = [...local.defects, ...(external?.defects || [])];
    // 合并去重（同一 gate 失败优先：本地证据门禁与外部游戏侧门禁任一失败即失败，外部不得覆盖本地失败）
    const mergedGates = {};
    {
        const allIds = new Set([...Object.keys(local.gates), ...Object.keys(external?.hard_gates || {})]);
        for (const k of allIds) {
            const lv = local.gates[k];
            const ev = external?.hard_gates?.[k];
            const lFail = lv === false || lv === 'fail' || lv === 'failed';
            const eFail = ev === false || ev === 'fail' || ev === 'failed';
            if (lFail || eFail) mergedGates[k] = false;
            else if (ev !== undefined) mergedGates[k] = ev;
            else if (lv !== undefined) mergedGates[k] = lv;
        }
    }

    // ---- ForgeLoop v3.1：VLM 证据样本（带标记、按模式隔离） ----
    const ext = { ...(external || {}) };
    if (!ext.gpu_images && gpuImages && gpuImages.length) ext.gpu_images = gpuImages;
    const { samples, defaultMode } = buildVlmSamples(attempt, ext);
    const gpuPrompt = external?.gpuPrompt || '请对这张画面做自动质量审查（0~1 分）：检查角色动作可信度、手绳接触、骨盆姿态、穿模、比例、骨架结构、是否僵硬失真。只输出"评分：0.x"和一句话结论。';
    const sampleReviews = [];
    for (const s of samples) {
        let review = null;
        if (s.vlm_score !== undefined && s.vlm_score !== null) {
            const parsed2 = parseGpuVlmText(s.vlm_text || '');
            review = { score: Math.max(0, Math.min(1, s.vlm_score)), text: s.vlm_text || '', labels: (s.vlm_labels && s.vlm_labels.length ? s.vlm_labels : parsed2.labels), critical: (s.vlm_labels && s.vlm_labels.length ? s.vlm_labels : parsed2.critical), source: 'evidence' };
        } else if (s.image && fs.existsSync(s.image)) {
            const r = await gpuReviewImage(s.image, gpuPrompt);
            if (r) {
                const parsed = parseGpuVlmText(r.text);
                review = { score: r.score, text: r.text, labels: parsed.labels, critical: parsed.critical, source: 'live' };
            }
        } else if (s.vlm_score === undefined && s.image && !fs.existsSync(s.image)) {
            review = { score: null, text: `样本图片不存在: ${s.image}`, labels: [], critical: [], source: 'missing_image' };
        }
        if (review) {
            sampleReviews.push({
                ...s,
                score: review.score,
                text: review.text,
                labels: review.labels,
                critical: review.critical,
                review_source: review.source,
                review_error: review.source === 'missing_image' ? review.text : null
            });
        }
    }
    const perMode = {};
    for (const m of EVIDENCE_MODES) {
        const items = sampleReviews.filter(s => s.mode === m);
        const scores = items.map(i => i.score).filter(v => typeof v === 'number');
        perMode[m] = {
            count: items.length,
            mean: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
            min: scores.length ? Math.min(...scores) : null,
            samples: items.map(i => ({ image: i.image, score: i.score, labels: i.labels, critical: i.critical, viewport: i.viewport, camera: i.camera, animation_time: i.animation_time, artifact_sha: i.artifact_sha, review_source: i.review_source, text: i.text }))
        };
    }
    const vlm = { samples: sampleReviews, per_mode: perMode, mode: defaultMode };

    // ---- ForgeLoop v3.1：结构化缺陷自动生成（防平均稀释/证据缺失） ----
    const policyTh = policy.thresholds || {};
    const vlmMeanMin = policyTh.vlm_mean_min?.value ?? 0.55;
    const vlmMinMin = policyTh.vlm_min_min?.value ?? 0.4;
    for (const m of EVIDENCE_MODES) {
        const pm = perMode[m];
        if (pm.count === 0) {
            // 声明了 evidence_modes 但该模式无样本：不强制失败（raw 模式可能只有报告），但记录审计信息
            vlm.per_mode[m].note = 'no_image_samples';
            continue;
        }
        if (pm.mean !== null && pm.mean < vlmMeanMin) {
            defects.push({ gate: 'vlm_mean', severity: 'critical', mode: m, desc: `${m} VLM 均值 ${pm.mean.toFixed(3)} 低于阈值 ${vlmMeanMin}（平均分不得掩盖局部失败）` });
        }
        if (pm.min !== null && pm.min < vlmMinMin) {
            defects.push({ gate: 'vlm_min', severity: 'critical', mode: m, desc: `${m} VLM 最低分 ${pm.min.toFixed(3)} 低于阈值 ${vlmMinMin}（单样本低分不得被平均稀释）` });
        }
        for (const s of pm.samples) {
            if (s.critical && s.critical.length) {
                defects.push({ gate: 'critical_label', severity: 'critical', mode: m, desc: `样本命中 critical 标签: ${s.critical.join('/')}`, image: s.image, score: s.score });
            }
            if (!s.artifact_sha) {
                defects.push({ gate: 'evidence_tagged', severity: 'hard', mode: m, desc: '证据缺少 artifact_sha 标记', image: s.image });
            }
        }
    }

    const evaluation = { hard_gates: mergedGates, gpu_review: null, vlm, metrics: external?.metrics || {}, regression: external?.regression || {}, defects };
    // 兼容旧字段：gpu_review 取最差模式均值（不再用于稀释）
    const modeMeans = Object.values(perMode).map(p => p.mean).filter(v => v !== null && v !== undefined);
    if (modeMeans.length) evaluation.gpu_review = { score: Math.min(...modeMeans), text: sampleReviews.map(s => s.text).join(' | ').slice(0, 400), model: 'qwen3.5-9b-fp8(auto)' };

    // ---- ForgeLoop v3.1：可追溯评分向量 ----
    const vector = computeScoreVector(policy, evaluation);
    evaluation.score_vector = vector;
    const score = vector.overall_score;

    // 对比：parent=null 的基线只能标 baseline，不得 better_than_parent=true；有父但无记录分值时视为可比较通过
    let betterThanParent = attempt.based_on_attempt_id ? true : false;
    if (attempt.based_on_attempt_id) {
        const parent = learningDb.findAttemptById(attempt.based_on_attempt_id);
        if (parent) {
            const parentVector = parent.auto_evaluation?.score_vector || {};
            const parentScore = parentVector.overall_score ?? (parent.auto_evaluation?.score ?? null);
            if (parentScore !== null && score !== null) betterThanParent = score >= parentScore;
        }
    }
    evaluation.comparison = {
        better_than_parent: betterThanParent,
        baseline: !attempt.based_on_attempt_id,
        parent_attempt_id: attempt.based_on_attempt_id || null
    };
    evaluation.score = score;
    const criticalCount = defects.filter(d => d.severity === 'critical').length;
    const gateFails = defects.length > 0 || Object.values(mergedGates).some(v => v === false || v === 'fail' || v === 'failed');
    const vlmOk = vector.vlm_mean !== null ? vector.vlm_mean >= vlmMeanMin : true;
    const vlmMinOk = vector.vlm_min !== null ? vector.vlm_min >= vlmMinMin : true;
    evaluation.passed = !gateFails && score !== null && vlmOk && vlmMinOk && criticalCount === 0 && (attempt.based_on_attempt_id ? betterThanParent : true);
    return evaluation;
}

// ---------- 缺陷 → 白名单单变量修复 ----------
// 从结构化缺陷中选择唯一白名单变量（按 domain）；歧义/审美/未知/基础设施 → null（进入待处理→quarantined）
function pickRepairVariable(attempt, evaluation) {
    const domain = attempt.domain || 'model';
    const rules = variablesForDomain(domain);
    if (!rules) return null;
    const defects = evaluation?.defects || [];
    const gates = evaluation?.hard_gates || {};
    const failedGates = defects.map(d => d.gate).filter(Boolean)
        .concat(Object.entries(gates).filter(([, v]) => v === false || v === 'fail' || v === 'failed').map(([k]) => k));
    // model：面数超预算 → triangle_budget；来源缺 task_id → 属基础设施/登记问题（不自动改生成参数）
    if (domain === 'model') {
        if (failedGates.includes('budget') || /triangles|三角/.test(String(attempt.failure_detail || ''))) {
            return { param: 'generation.triangle_budget', to: Math.min(120000, (attempt.metrics?.triangles || 0) - 5000) };
        }
        if (failedGates.includes('decode') || /decode|解码/.test(String(attempt.failure_detail || ''))) {
            return { param: 'seed', to: ((attempt.seed || 0) + 1) % 4294967295 };
        }
        return null; // 其余（穿模/审美等）歧义 → 待处理
    }
    if (domain === 'animation') {
        // ForgeLoop v3.1：根/骨盆位移污染（raw GLB root_translation_ratio / runtime root_drift）→ 归一化修复
        if (failedGates.includes('root_translation_ratio') || failedGates.includes('root_drift')
            || /漂移|drift|位移|root/.test(String(attempt.failure_detail || '') + JSON.stringify(defects.map(d => d.desc || '')))) {
            return { param: 'animation.root_translation_normalization', to: 'normalize_root_translation' };
        }
        if (failedGates.includes('clipping') || /穿模|clipping/.test(String(attempt.failure_detail || ''))) {
            return { param: 'animation.weight_repair_plan', to: 'sanitize_skin_weights' };
        }
        if (failedGates.includes('bone_mapping') || /骨骼|映射|bone/.test(String(attempt.failure_detail || ''))) {
            return { param: 'animation.retarget_plan', to: 'retarget_actions' };
        }
        return null;
    }
    if (domain === 'audio') {
        if (failedGates.includes('not_silent') || /静音|silent/.test(String(attempt.failure_detail || ''))) {
            return { param: 'audio.gain_adjust', to: 0.8 };
        }
        if (failedGates.includes('no_clip') || /削波|clip/.test(String(attempt.failure_detail || ''))) {
            return { param: 'audio.gain_adjust', to: 0.3 };
        }
        if (failedGates.includes('decode') || /时长|太短|trim/.test(String(attempt.failure_detail || ''))) {
            return { param: 'audio.trim_start_s', to: 0 };
        }
        return null;
    }
    return null;
}

// ---------- 子 Attempt 创建（独立 Job ID，不复用父 Job） ----------
function createAutoRepairChild(attempt, variable, { ownerId = null, repair } = {}) {
    // 幂等：父 Attempt 已存在未终态子 Attempt（auto_repairing/auto_evaluating）则复用
    const existingChild = learningDb.listAttempts({ ownerId, limit: 100 }).find(a =>
        a.based_on_attempt_id === attempt.id && ['auto_repairing', 'auto_evaluating'].includes(a.auto_flow_state));
    if (existingChild) {
        const existingJob = jobDb.findById(existingChild.job_id);
        return { attempt: existingChild, job: existingJob, reused: true };
    }
    // 创建独立 Job（新 Job ID）
    const job = jobDb.create({
        name: `auto-repair ${attempt.asset_id || attempt.asset_kind} (${attempt.domain})`,
        input: { asset_kind: attempt.asset_kind || 'prop', profile: attempt.profile || 'xhs_mobile', seed: (attempt.seed || 0) + 1 },
        owner_id: ownerId,
        status: 'queued',
        based_on_attempt_id: attempt.id,
        changed_variable: variable,
        repair_variable: variable,
        parent_plan_sha: attempt.execution_plan?.sha256 || null,
        domain: attempt.domain || 'model',
        project: attempt.project,
        stage: attempt.stage,
        asset_id: attempt.asset_id,
        event_id: attempt.event_id,
        evidence: attempt.evidence || {},
        contract_hash: attempt.contract_hash,
        auto_repair: true,
        input_sha: attempt.artifacts?.glb_sha || null
    });
    const child = learningDb.createAttempt({
        job_id: job.id,
        owner_id: ownerId ?? attempt.owner_id,
        domain: attempt.domain || 'model',
        project: attempt.project,
        stage: attempt.stage,
        asset_id: attempt.asset_id,
        event_id: attempt.event_id,
        evidence: attempt.evidence || {},
        contract_hash: attempt.contract_hash,
        asset_kind: attempt.asset_kind || 'prop',
        profile: attempt.profile || 'xhs_mobile',
        seed: (attempt.seed || 0) + 1,
        based_on_attempt_id: attempt.id,
        changed_variable: variable,
        auto_flow_state: 'auto_repairing',
        acceptance_mode: 'automatic',
        human_review: 'not_performed',
        auto_chain_index: (attempt.auto_chain_index || 0) + 1
    });
    return { attempt: child, job, reused: false };
}

// ---------- 主循环入口 ----------
// repair：async (attempt, variable) => ({ job_id, artifacts, metrics, evidence, gates }) 真实 GPU 执行器
// evaluate：async (attempt) => ({ hard_gates, metrics, gpu_review, defects }) 游戏/资产侧评估（可选）
async function runAutoIteration(attemptId, { ownerId = null, evaluate = null, repair = null } = {}) {
    ensurePolicies();
    const lock = autoLockDb.acquire(`auto-loop:${attemptId}`, `main-${process.pid}`);
    if (!lock) return { ok: false, reason: 'concurrent_lock', attemptId };
    try {
        let attempt = learningDb.findAttemptById(attemptId);
        if (!attempt) return { ok: false, reason: 'not_found', attemptId };
        const flow = attempt.auto_flow_state;
        // 已到终态：auto_accepted 不再重跑；exhausted/quarantined 由 manual_override reset 后重入
        if (flow === 'auto_accepted') return { ok: true, attempt, state: 'auto_accepted', final: true };
        if (flow === 'exhausted' || flow === 'quarantined') return { ok: false, state: flow, attempt, final: true };

        // 阶段一：generated → auto_evaluating（进入自动评估）
        if (flow === 'generated') {
            attempt = learningDb.setAutoFlowState(attemptId, 'auto_evaluating', { detail: '无人循环进入自动评估' });
        }
        // 阶段二：auto_evaluating → 自动评估（幂等：已有 external/auto_evaluation 直接复用，除非 reopen 标记强制重评）
        if (attempt.auto_flow_state === 'auto_evaluating') {
            const canReuse = attempt.auto_evaluation && attempt.auto_evaluation.score !== undefined && !attempt.auto_evaluation.reopen;
            const evaluation = canReuse
                ? attempt.auto_evaluation
                : await evaluateAttempt(attempt, { external: evaluate ? await evaluate(attempt) : null, gpuImages: attempt.evidence?.gpu_images || null });
            learningDb.saveAutoEvaluation(attemptId, evaluation);
            attempt = learningDb.findAttemptById(attemptId);
            if (evaluation.passed) {
                attempt = learningDb.setAutoFlowState(attemptId, 'auto_accepted', { detail: '自动评估通过（硬门禁+质量分+对比）', evidence: { score: evaluation.score, score_vector: evaluation.score_vector } });
                return { ok: true, attempt, state: 'auto_accepted', evaluation };
            }
            attempt = learningDb.setAutoFlowState(attemptId, 'auto_rejected', { detail: '自动评估未通过', evidence: { defects: evaluation.defects } });
        }

        // 阶段三：auto_rejected → 单变量修复或终态（exhausted/quarantined）
        attempt = learningDb.findAttemptById(attemptId);
        if (attempt.auto_flow_state !== 'auto_rejected') return { ok: false, state: attempt.auto_flow_state, attempt };
        const chainIndex = attempt.auto_chain_index || 0;
        const maxRepairs = POLICY_V1[attempt.domain]?.thresholds.max_repairs?.value ?? 3;
        if (chainIndex >= maxRepairs) {
            attempt = learningDb.setAutoFlowState(attemptId, 'exhausted', { detail: `已达修复预算上限 ${maxRepairs} 次`, evidence: { chain_index: chainIndex } });
            return { ok: false, state: 'exhausted', attempt, reason: 'repair_budget_exceeded' };
        }
        const variable = pickRepairVariable(attempt, attempt.auto_evaluation || {});
        if (!variable) {
            attempt = learningDb.setAutoFlowState(attemptId, 'quarantined', { detail: '缺陷无法唯一映射到白名单修复变量（歧义/审美/未知/基础设施）', evidence: { defects: attempt.auto_evaluation?.defects || [] } });
            return { ok: false, state: 'quarantined', attempt, reason: 'no_unambiguous_repair' };
        }
        // ForgeLoop v3.1：同一变量连续无改善 → quarantined（防止同变量无限重试，保留 champion）
        if (attempt.changed_variable?.param === variable.param && attempt.based_on_attempt_id) {
            const parentEval = learningDb.findAttemptById(attempt.based_on_attempt_id)?.auto_evaluation || {};
            const curScore = attempt.auto_evaluation?.score_vector?.overall_score ?? attempt.auto_evaluation?.score ?? null;
            const parentScore = parentEval.score_vector?.overall_score ?? parentEval.score ?? null;
            if (curScore !== null && parentScore !== null && curScore <= parentScore) {
                attempt = learningDb.setAutoFlowState(attemptId, 'quarantined', { detail: `变量 ${variable.param} 与父 Attempt 相同且无改善（${curScore} ≤ ${parentScore}），停止同变量重试`, evidence: { variable, cur_score: curScore, parent_score: parentScore } });
                return { ok: false, state: 'quarantined', attempt, reason: 'same_variable_no_improvement' };
            }
        }
        if (!repair) return { ok: false, state: 'quarantined', attempt, reason: 'repair_executor_missing' };

        // 创建子 Attempt（独立 Job）→ 执行真实修复
        const { attempt: child, job, reused } = createAutoRepairChild(attempt, variable, { ownerId: ownerId ?? attempt.owner_id });
        const repairResult = await repair(child, variable, job);
        // 修复执行器回填（真实 GPU 任务 ID/产物/指标）
        if (repairResult?.artifacts) {
            const metrics = { ...(child.metrics || {}), ...(repairResult.metrics || {}) };
            learningDb.updateAttemptTerminal(child.job_id, {
                auto_status: repairResult.job_status || 'succeeded',
                metrics,
                artifacts: { ...(child.artifacts || {}), ...repairResult.artifacts },
                pipeline: { ...(child.pipeline || {}), provider: repairResult.provider || 'forge3d', task_id: repairResult.job_id || child.job_id },
                evidence: { ...(child.evidence || {}), ...(repairResult.evidence || {}), animation: repairResult.animationEvidence || null },
                failure_detail: repairResult.error?.message || null
            });
            // 子 Attempt 进入评估（修复产物必须重跑同一自动门禁）
            // ForgeLoop v3.1：GPU 产物已生成但游戏侧 staging 证据未就绪 → 停在 auto_evaluating，等下一轮带全量外部证据评估（重启可续跑）
            learningDb.setAutoFlowState(child.id, 'auto_evaluating', { detail: repairResult.pending_external ? '修复产物已生成，等待游戏侧 staging 证据后评估' : '修复产物进入自动评估', evidence: { variable, pending_external: !!repairResult.pending_external } });
            if (repairResult.pending_external) {
                return { ok: true, state: 'auto_evaluating', pending_external: true, attempt: learningDb.findAttemptById(child.id), job, reused };
            }
            const childNow = learningDb.findAttemptById(child.id);
            const childEval = await evaluateAttempt(childNow, { external: evaluate ? await evaluate(childNow) : null, gpuImages: childNow.evidence?.gpu_images || null });
            learningDb.saveAutoEvaluation(child.id, childEval);
            if (childEval.passed) {
                learningDb.setAutoFlowState(child.id, 'auto_accepted', { detail: '子 Attempt 自动评估通过', evidence: { score: childEval.score } });
                return { ok: true, state: 'auto_accepted', attempt: learningDb.findAttemptById(child.id), child: true, evaluation: childEval, job, reused };
            }
            learningDb.setAutoFlowState(child.id, 'auto_rejected', { detail: '子 Attempt 评估未通过，可继续下一轮', evidence: { defects: childEval.defects } });
            return { ok: false, state: 'auto_rejected', attempt: learningDb.findAttemptById(child.id), child: true, evaluation: childEval, job, reused };
        }
        // 执行器失败（无产物）→ 记为 exhausted（不伪装成功）
        learningDb.setAutoFlowState(child.id, 'exhausted', { detail: 'GPU 执行器未产出产物（无 artifacts）', evidence: { error: repairResult?.error?.message || null } });
        return { ok: false, state: 'exhausted', attempt: learningDb.findAttemptById(child.id), reason: 'executor_no_output' };
    } finally {
        autoLockDb.release(`auto-loop:${attemptId}`, `main-${process.pid}`);
    }
}

// ---------- 服务重启恢复（幂等，不重复创建 Job） ----------
function recoverFromDb() {
    let recovered = 0;
    for (const attempt of learningDb.listAttempts({ limit: 500 })) {
        if (['generated', 'auto_evaluating', 'auto_repairing'].includes(attempt.auto_flow_state)) {
            // 已有对应 Job（含子 Attempt 的 repair job）→ 视为已提交，不重复创建；状态保持可继续评估
            recovered += 1;
        }
    }
    return recovered;
}

// ---------- 自动接入与回滚 ----------
// staging 检查：调用方注入 verifyStaging（游戏/资产侧全量测试）；通过 → 提升 champion → 写正式区。
// 新版本失败 → 自动回滚上一 champion（历史 Attempt 不变）。
async function autoIntegrate(attemptId, { project, asset_id, domain, stagingDir, verifyStaging, buildReleaseZip } = {}) {
    const attempt = learningDb.findAttemptById(attemptId);
    if (!attempt) return { ok: false, reason: 'not_found' };
    if (attempt.auto_flow_state !== 'auto_accepted') return { ok: false, reason: `not_auto_accepted:${attempt.auto_flow_state}` };
    const { championDb } = require('./db');
    const prev = championDb.get({ project, asset_id, domain });
    const stagingOk = verifyStaging ? await verifyStaging(stagingDir) : { ok: true, report: 'no_verify_staging' };
    if (!stagingOk?.ok) {
        // 新版本失败 → 回滚上一 champion（若存在）
        if (prev) {
            return { ok: false, reason: 'staging_failed_rolled_back', rolled_back_to: prev.attempt_id, prev, staging_report: stagingOk };
        }
        return { ok: false, reason: 'staging_failed_no_prev', staging_report: stagingOk };
    }
    const zip = buildReleaseZip ? await buildReleaseZip(stagingDir) : null;
    const champion = championDb.set({
        project, asset_id, domain,
        attempt_id: attempt.id,
        job_id: attempt.job_id,
        artifact_sha: attempt.artifacts?.glb_sha || attempt.artifacts?.artifact_sha || null,
        release_zip: zip?.path || null,
        release_zip_sha: zip?.sha256 || null,
        release_zip_bytes: zip?.bytes ?? null,
        acceptance_mode: 'automatic',
        human_review: 'not_performed',
        metrics: attempt.auto_evaluation?.metrics || attempt.metrics || {}
    });
    return { ok: true, champion, staging_report: stagingOk, release_zip: zip, previous: prev };
}

module.exports = { runAutoIteration, recoverFromDb, autoIntegrate, evaluateAttempt, pickRepairVariable, createAutoRepairChild, gpuReviewImage, runLocalGates, buildVlmSamples, computeScoreVector, deterministicScore, regressionScore, parseGpuVlmText, CRITICAL_LABELS, EVIDENCE_MODES };
