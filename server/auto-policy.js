// ForgeLoop v3 —— 自动质量策略（版本化）
// 为 model / animation / audio / image / scene / gameplay 各领域维护版本化 policy：
//   - hard_gates：来源、SHA、任务 ID、格式、解码、加载、穿模、错误、离线、预算（必过）
//   - quality_metrics：确定性指标 + 自有 GPU 多模态模型审查
//   - regression：新候选不得破坏既有角色、关卡、音频和性能
//   - comparison：子 Attempt 必须优于父 Attempt（champion/challenger）
// 所有阈值写入配置，记录单位、版本与修改历史；不调用外部付费模型或平台生成额度。
'use strict';
const { v3PolicyDb } = require('./db');

// 六领域版本化策略。阈值含单位；修改必须追加 change_log（版本+原因+操作者）。
const POLICY_V1 = {
    model: {
        version: 1,
        hard_gates: [
            { id: 'provenance', desc: '来源完整：任务 ID、模型/参数、产物路径与 SHA-256 齐备', unit: 'boolean' },
            { id: 'decode', desc: 'GLB 可解码、结构有效', unit: 'boolean' },
            { id: 'budget', desc: '三角面 ≤ 120000、骨骼 ≤ 128、每顶点权重 ≤ 4', unit: 'count' },
            { id: 'clipping', desc: '自动穿模报告无严重穿插', unit: 'report' },
            { id: 'offline', desc: '无运行期联网请求', unit: 'boolean' }
        ],
        quality_metrics: [
            { id: 'quality_score', desc: '确定性门禁质量分 0~1', unit: 'score', min: 0.6 },
            { id: 'gpu_review', desc: '自有 GPU 多模态视觉审查评分 0~1', unit: 'score', min: 0.5 }
        ],
        regression: [
            { id: 'existing_assets', desc: '不破坏既有角色/场景加载', unit: 'boolean' }
        ],
        comparison: [
            { id: 'better_than_parent', desc: '子 Attempt 质量分 ≥ 父 Attempt', unit: 'boolean' }
        ],
        thresholds: {
            triangle_budget_max: { value: 120000, unit: 'count' },
            bones_max: { value: 128, unit: 'count' },
            weights_per_vertex_max: { value: 4, unit: 'count' },
            quality_score_min: { value: 0.6, unit: 'score' },
            gpu_review_min: { value: 0.5, unit: 'score' },
            max_repairs: { value: 3, unit: 'count' },
            max_candidates_per_round: { value: 3, unit: 'count' }
        }
    },
    animation: {
        version: 1,
        hard_gates: [
            { id: 'bone_mapping', desc: '骨骼映射完整、无缺失骨骼', unit: 'report' },
            { id: 'not_static', desc: '动作非静态（位移/旋转方差 > 0）', unit: 'boolean' },
            { id: 'joint_angle', desc: '关节角异常比例低于阈值', unit: 'ratio' },
            { id: 'clipping', desc: '穿模检查无严重穿插', unit: 'report' },
            { id: 'root_drift', desc: '根节点漂移低于阈值', unit: 'distance' },
            { id: 'loop_seam', desc: '循环接缝（起止帧差异）低于阈值', unit: 'distance' },
            { id: 'contact', desc: '接触点可信（手绳/脚底）', unit: 'gpu_review' },
            { id: 'gameplay_readable', desc: '游戏实际镜头可读性', unit: 'gpu_review' }
        ],
        quality_metrics: [
            { id: 'quality_score', desc: '确定性门禁质量分 0~1', unit: 'score', min: 0.6 },
            { id: 'gpu_review', desc: '自有 GPU 多模态视觉审查评分 0~1', unit: 'score', min: 0.5 }
        ],
        regression: [
            { id: 'playthrough', desc: '四关流程不回归', unit: 'boolean' },
            { id: 'audio_trace', desc: '音频事件不回归', unit: 'boolean' }
        ],
        comparison: [
            { id: 'better_than_parent', desc: '子 Attempt 质量分 ≥ 父 Attempt', unit: 'boolean' }
        ],
        thresholds: {
            joint_angle_anomaly_ratio_max: { value: 0.1, unit: 'ratio' },
            root_drift_max: { value: 0.2, unit: 'm' },
            loop_seam_max: { value: 0.05, unit: 'distance' },
            quality_score_min: { value: 0.6, unit: 'score' },
            gpu_review_min: { value: 0.5, unit: 'score' },
            max_repairs: { value: 3, unit: 'count' },
            max_candidates_per_round: { value: 3, unit: 'count' }
        }
    },
    audio: {
        version: 1,
        hard_gates: [
            { id: 'decode', desc: '可解码、时长 > 0', unit: 'boolean' },
            { id: 'not_silent', desc: '非静音（RMS 高于阈值）', unit: 'boolean' },
            { id: 'no_clip', desc: '无削波（峰值 ≤ 0.999）', unit: 'boolean' },
            { id: 'loudness', desc: '响度在安全区间', unit: 'db' },
            { id: 'asr_match', desc: '对白 ASR 文本匹配', unit: 'boolean' },
            { id: 'reachable', desc: '事件 reachable/started/stopped 证据', unit: 'boolean' },
            { id: 'stop_on_transition', desc: '切关/暂停/失焦后 active sources 归零', unit: 'boolean' },
            { id: 'source', desc: 'GPU 任务 ID 与产物 SHA 登记', unit: 'boolean' }
        ],
        quality_metrics: [
            { id: 'quality_score', desc: '确定性门禁质量分 0~1', unit: 'score', min: 0.6 },
            { id: 'gpu_review', desc: '自有 GPU 音质模型评分 0~1', unit: 'score', min: 0.5 }
        ],
        regression: [
            { id: 'existing_clips', desc: '既有 62 clip 清单不回归', unit: 'boolean' }
        ],
        comparison: [
            { id: 'better_than_parent', desc: '子 Attempt 质量分 ≥ 父 Attempt', unit: 'boolean' }
        ],
        thresholds: {
            rms_min: { value: 0.01, unit: 'amplitude' },
            peak_max: { value: 0.999, unit: 'amplitude' },
            loudness_db_range: { value: [-30, 0], unit: 'db' },
            quality_score_min: { value: 0.6, unit: 'score' },
            gpu_review_min: { value: 0.5, unit: 'score' },
            max_repairs: { value: 3, unit: 'count' },
            max_candidates_per_round: { value: 3, unit: 'count' }
        }
    },
    image: {
        version: 1,
        hard_gates: [
            { id: 'decode', desc: '可解码、非空白', unit: 'boolean' },
            { id: 'dimension', desc: '尺寸与目标一致', unit: 'px' },
            { id: 'source', desc: '自有 GPU 任务 ID 与 SHA', unit: 'boolean' },
            { id: 'offline', desc: '无外部请求', unit: 'boolean' }
        ],
        quality_metrics: [
            { id: 'gpu_review', desc: '自有 GPU 多模态视觉审查评分 0~1', unit: 'score', min: 0.5 }
        ],
        regression: [],
        comparison: [
            { id: 'better_than_parent', desc: '子 Attempt 质量分 ≥ 父 Attempt', unit: 'boolean' }
        ],
        thresholds: {
            gpu_review_min: { value: 0.5, unit: 'score' },
            max_repairs: { value: 3, unit: 'count' },
            max_candidates_per_round: { value: 3, unit: 'count' }
        }
    },
    scene: {
        version: 1,
        hard_gates: [
            { id: 'decode', desc: 'GLB 可解码、结构有效', unit: 'boolean' },
            { id: 'budget', desc: '三角面 ≤ 120000', unit: 'count' },
            { id: 'grounding', desc: '接地检查通过', unit: 'boolean' },
            { id: 'clipping', desc: '穿模报告无严重穿插', unit: 'report' },
            { id: 'source', desc: 'GPU 任务 ID 与产物 SHA', unit: 'boolean' }
        ],
        quality_metrics: [
            { id: 'quality_score', desc: '确定性门禁质量分 0~1', unit: 'score', min: 0.6 },
            { id: 'gpu_review', desc: '自有 GPU 多模态视觉审查评分 0~1', unit: 'score', min: 0.5 }
        ],
        regression: [
            { id: 'existing_assets', desc: '不破坏既有关卡', unit: 'boolean' }
        ],
        comparison: [
            { id: 'better_than_parent', desc: '子 Attempt 质量分 ≥ 父 Attempt', unit: 'boolean' }
        ],
        thresholds: {
            triangle_budget_max: { value: 120000, unit: 'count' },
            quality_score_min: { value: 0.6, unit: 'score' },
            gpu_review_min: { value: 0.5, unit: 'score' },
            max_repairs: { value: 3, unit: 'count' },
            max_candidates_per_round: { value: 3, unit: 'count' }
        }
    },
    gameplay: {
        version: 1,
        hard_gates: [
            { id: 'four_chapters', desc: '四关真实走完（含看画、父亲陪伴、妹妹过桥结局）', unit: 'boolean' },
            { id: 'console_errors_zero', desc: '控制台错误 = 0', unit: 'count' },
            { id: 'external_requests_zero', desc: '外部请求 = 0（全离线）', unit: 'count' },
            { id: 'viewport', desc: '桌面与移动视口正常', unit: 'boolean' },
            { id: 'pause_resume', desc: '暂停/恢复/刷新恢复正常', unit: 'boolean' },
            { id: 'package_budget', desc: 'release ZIP ≤ 10,485,760 字节且 index.html 在根', unit: 'bytes' },
            { id: 'no_illegal_entries', desc: 'ZIP 无非法条目（绝对路径/../反斜杠）', unit: 'boolean' },
            { id: 'provenance_complete', desc: '全部素材来源记录完整（task_id/SHA）', unit: 'boolean' }
        ],
        quality_metrics: [
            { id: 'playthrough_score', desc: '四关通过率 0~1', unit: 'score', min: 1 }
        ],
        regression: [
            { id: 'replay', desc: '重玩闭环正常', unit: 'boolean' }
        ],
        comparison: [
            { id: 'better_than_parent', desc: '子 Attempt 不劣于父 Attempt', unit: 'boolean' }
        ],
        thresholds: {
            release_zip_max_bytes: { value: 10485760, unit: 'bytes' },
            console_errors_max: { value: 0, unit: 'count' },
            external_requests_max: { value: 0, unit: 'count' },
            max_repairs: { value: 3, unit: 'count' },
            max_candidates_per_round: { value: 3, unit: 'count' }
        }
    }
};

const CHANGE_LOG = [
    { version: 1, at: '2026-09-28T12:00:00+08:00', reason: 'ForgeLoop v3 初始策略：六领域硬门禁+确定性指标+自有 GPU 多模态审查钩子；阈值含单位与版本', operator: 'Doubao MainAgent' }
];

// 服务启动幂等：把六领域 v1 策略写入 db（已存在相同 domain+version 则跳过）
function ensurePolicies() {
    let saved = 0;
    for (const [domain, policy] of Object.entries(POLICY_V1)) {
        const existing = v3PolicyDb.latest(domain);
        if (existing && existing.version === policy.version) continue;
        v3PolicyDb.save({ domain, version: policy.version, policy, threshold_units: policy.thresholds, change_log: CHANGE_LOG });
        saved += 1;
    }
    return saved;
}

// 确定性质量分：对评价对象（attempt 或评估结果）按领域计算 0~1（缺项按中性 0.5）
function domainQualityScore(domain, evaluation = {}) {
    const parts = [];
    const gates = evaluation.hard_gates || {};
    for (const [key, value] of Object.entries(gates)) {
        if (value === true || value === 'pass' || value === 'passed') parts.push(1);
        else if (value === false || value === 'fail' || value === 'failed') parts.push(0);
        else if (typeof value === 'number') parts.push(Math.max(0, Math.min(1, value)));
        // 其余（required/n/a/pending）中性不计分
    }
    const gpu = evaluation.gpu_review?.score;
    if (typeof gpu === 'number') parts.push(gpu);
    if (evaluation.playthrough_score !== undefined) parts.push(evaluation.playthrough_score);
    if (!parts.length) return null;
    return parts.reduce((s, v) => s + v, 0) / parts.length;
}

module.exports = { POLICY_V1, ensurePolicies, domainQualityScore, v3PolicyDb };
