'use strict';

// ---------- 多节点并行建模（Multi-GPU）常量与阶段定义 ----------

const MP_STAGE_VERSION = '1.0';
const MP_PIPELINE_VERSION = 'mp-1.0';

// 阶段顺序（与 deploy/forge3d 的 pipeline 阶段名对齐，paint 由 gsy013 L20 执行）
const STAGE_ORDER = {
    character: [
        'prepare',
        'shape', 'draft_preview', 'candidate_qc',
        'select',
        'paint',
        'normalize', 'rig', 'retarget_animation',
        'export', 'render_preview', 'validate', 'review'
    ],
    prop: [
        'prepare',
        'shape', 'draft_preview', 'candidate_qc',
        'select',
        'paint',
        'normalize',
        'export', 'render_preview', 'validate', 'review'
    ],
    environment: [
        'prepare',
        'shape', 'draft_preview', 'candidate_qc',
        'select',
        'paint',
        'normalize',
        'export', 'render_preview', 'validate', 'review'
    ]
};

// 阶段 → 能力队列；select/review/prepare 由控制面自身完成（无外部 Worker）
const STAGE_CAPABILITY = {
    prepare: 'control',
    shape: 'shape:t4',
    draft_preview: 'draft_preview:t4',
    candidate_qc: 'candidate_qc:t4',
    select: 'control',
    paint: 'paint:l20',
    normalize: 'normalize:t4',
    // UniRig 依赖 bpy 与独立 Blender（均需 glibc 2.28+）；T4 为 glibc 2.27 无法运行，
    // 故 rig 由 gsy013（Ubuntu 22.04）的 GPU Worker 在 L20 上执行。
    rig: 'rig:l20',
    retarget_animation: 'animation:t4',
    export: 'export:t4',
    render_preview: 'preview:t4',
    validate: 'validate:t4',
    review: 'control'
};

// 可被外部 Worker 领取的阶段
const WORKER_STAGES = new Set(Object.keys(STAGE_CAPABILITY).filter(stage => !['control'].includes(STAGE_CAPABILITY[stage])));

// 状态
const TASK_STATUS = {
    QUEUED: 'queued',
    LEASED: 'leased',
    RUNNING: 'running',
    RETRY_WAIT: 'retry_wait',
    WAITING_REMOTE: 'waiting_remote',
    REVIEW: 'review',
    COMPLETED: 'completed',
    FAILED: 'failed',
    DEAD_LETTER: 'dead_letter',
    CANCELLED: 'cancelled'
};

const PARENT_STATUS = {
    QUEUED: 'queued',
    RUNNING: 'running',
    SELECT_NEEDED: 'select_needed',
    REVIEW: 'review',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled'
};

const MODES = ['single', 'parallel_assets', 'candidate_race'];
const ASSET_KINDS = ['prop', 'character', 'environment'];
const PROFILES = ['xhs_mobile', 'steam_desktop'];

// 租约与心跳
const LEASE_TTL_MS = 10 * 60 * 1000;       // 任务租约时长
const HEARTBEAT_INTERVAL_MS = 30 * 1000;   // Worker 心跳间隔
const RETRY_BASE_MS = 30 * 1000;           // 指数退避基数
const RETRY_MAX_MS = 10 * 60 * 1000;       // 退避上限
const DEFAULT_MAX_ATTEMPTS = 3;
const PAINT_POLL_MS = 5000;                // 远端 Paint 轮询间隔
const PAINT_REMOTE_TIMEOUT_MS = 45 * 60 * 1000; // 远端任务超时

// 合法的子任务状态迁移
const TASK_TRANSITIONS = {
    [TASK_STATUS.QUEUED]: [TASK_STATUS.LEASED, TASK_STATUS.CANCELLED, TASK_STATUS.RETRY_WAIT],
    [TASK_STATUS.LEASED]: [TASK_STATUS.RUNNING, TASK_STATUS.QUEUED, TASK_STATUS.COMPLETED, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED],
    [TASK_STATUS.RUNNING]: [TASK_STATUS.COMPLETED, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED, TASK_STATUS.RETRY_WAIT, TASK_STATUS.WAITING_REMOTE],
    [TASK_STATUS.WAITING_REMOTE]: [TASK_STATUS.COMPLETED, TASK_STATUS.FAILED, TASK_STATUS.RETRY_WAIT, TASK_STATUS.CANCELLED],
    [TASK_STATUS.RETRY_WAIT]: [TASK_STATUS.QUEUED, TASK_STATUS.CANCELLED, TASK_STATUS.DEAD_LETTER],
    [TASK_STATUS.REVIEW]: [TASK_STATUS.COMPLETED],
    [TASK_STATUS.COMPLETED]: [],
    [TASK_STATUS.FAILED]: [TASK_STATUS.QUEUED, TASK_STATUS.DEAD_LETTER],
    [TASK_STATUS.DEAD_LETTER]: [],
    [TASK_STATUS.CANCELLED]: []
};

function stageCapability(stage) {
    return STAGE_CAPABILITY[stage] || null;
}

function stagesFor(kind) {
    return STAGE_ORDER[kind] || STAGE_ORDER.prop;
}

module.exports = {
    MP_STAGE_VERSION,
    MP_PIPELINE_VERSION,
    STAGE_ORDER,
    STAGE_CAPABILITY,
    WORKER_STAGES,
    TASK_STATUS,
    PARENT_STATUS,
    MODES,
    ASSET_KINDS,
    PROFILES,
    LEASE_TTL_MS,
    HEARTBEAT_INTERVAL_MS,
    RETRY_BASE_MS,
    RETRY_MAX_MS,
    DEFAULT_MAX_ATTEMPTS,
    PAINT_POLL_MS,
    PAINT_REMOTE_TIMEOUT_MS,
    TASK_TRANSITIONS,
    stageCapability,
    stagesFor
};
