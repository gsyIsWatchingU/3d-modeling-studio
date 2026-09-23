const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { factoryDb, dbPath } = require('./db');
const { atomicFile } = require('./factory-build');
const { stageDefinition } = require('./stage-workflow');

const root = process.env.FACTORY_DIR || path.join(path.dirname(dbPath), 'game-factory');
const guideScopes = {
    design: ['design'],
    narrative: ['narrative'],
    concept: ['character', 'environment', 'prop']
};
const instructions = {
    design: '输出简洁中文 Markdown。必须包含：已知条件与假设、目标平台与玩家视角、核心循环、规则、首个可玩切片、资源清单、风险和人工验收项。为角色、场景、道具、事件分配稳定 ID。',
    narrative: '输出简洁中文 Markdown。必须包含：故事提案、角色表、场景与事件、对白、分镜、结局、连续性检查和人工验收项。沿用输入中的稳定 ID；新设定标为提案，不擅自改写已确认内容。',
    concept: '输出预览图制作单，不声称已经生成图片。必须包含：角色、场景、道具的稳定资产 ID；每张图的用途、画面内容、构图、视角、色彩材质、连续性约束、负面约束、3D 建模交接要求和人工审片清单。'
};

function stageRunDir(project, run) { return path.join(root, project.id, 'stages', run.stage_id, run.id); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function selectedGuides(project, stageId) {
    const wanted = new Set(guideScopes[stageId] || []);
    return (project.guides || []).filter(guide => wanted.has(guide.id));
}
function approvedInputs(project, run) {
    return (run.input_run_ids || []).map(id => (project.stage_runs || []).find(item => item.id === id)).filter(Boolean).map(input => {
        const filename = path.join(stageRunDir(project, input), 'output.md');
        return fs.existsSync(filename) ? `## ${input.stage_name} ${input.id}\n\n${fs.readFileSync(filename, 'utf8')}` : '';
    }).filter(Boolean).join('\n\n');
}
async function generate(project, run, signal) {
    const stage = stageDefinition(run.stage_id);
    const guideText = [...new Map(selectedGuides(project, run.stage_id)
        .flatMap(guide => guide.snapshot?.entries || []).map(entry => [entry.id, entry])).values()]
        .map(entry => entry.content).join('\n\n');
    const response = await fetch(process.env.FACTORY_PLANNER_URL || process.env.SKILL_PLANNER_URL || 'http://127.0.0.1:8002/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]),
        body: JSON.stringify({
            model: process.env.FACTORY_PLANNER_MODEL || process.env.SKILL_PLANNER_MODEL || 'qwen3.5-9b-fp8',
            temperature: .55, max_tokens: 4500,
            messages: [
                { role: 'system', content: `你是游戏生产工厂的独立阶段执行器。只交付“${stage.name}”文档，不生成或执行代码，不虚构图片、模型、音频或验收结果。${instructions[run.stage_id]}\n\n固定规范：\n${guideText}` },
                { role: 'user', content: JSON.stringify({ project: { name: project.name, brief: project.brief, style: project.style }, instructions: run.instructions, approved_inputs: approvedInputs(project, run) || '无已批准的上游输入，本次按项目目标独立起草。' }) }
            ]
        })
    });
    if (!response.ok) throw new Error(`阶段生成模型暂时不可用（HTTP ${response.status}）`);
    const payload = await response.json();
    const output = String(payload.choices?.[0]?.message?.content || '').replace(/^```(?:markdown|md)?\s*|\s*```$/g, '').trim();
    if (output.length < 80 || output.length > 100000) throw new Error('阶段输出为空、过短或过长');
    return output;
}
function startStageWorker() {
    let busy = false, stopped = false, controller;
    for (const project of factoryDb.all()) {
        if ((project.stage_runs || []).some(run => run.status === 'running')) factoryDb.change(project.id, project.owner_id, item => {
            for (const run of item.stage_runs || []) if (run.status === 'running') run.status = 'queued';
        });
    }
    async function tick() {
        if (busy || stopped) return;
        const project = factoryDb.all().find(item => (item.stage_runs || []).some(run => run.status === 'queued'));
        if (!project) return;
        const run = project.stage_runs.find(item => item.status === 'queued');
        busy = true; controller = new AbortController();
        const patch = fn => factoryDb.change(project.id, project.owner_id, item => fn(item.stage_runs.find(value => value.id === run.id)));
        try {
            patch(item => { item.status = 'running'; item.started_at ||= new Date().toISOString(); item.error = null; });
            const output = await generate(project, run, controller.signal);
            if (stopped) throw new Error('服务正在停止');
            const dir = stageRunDir(project, run), bytes = Buffer.from(output);
            atomicFile(path.join(dir, 'output.md'), bytes);
            const artifact = { path: 'output.md', type: 'document', bytes: bytes.length, sha256: sha256(bytes), created_at: new Date().toISOString() };
            const manifest = {
                project_id: project.id, stage_run_id: run.id, stage_id: run.stage_id,
                input_run_ids: run.input_run_ids || [], missing_approved_inputs: run.missing_approved_inputs || [],
                artifacts: [artifact], generated_at: new Date().toISOString(), review: 'pending'
            };
            atomicFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
            patch(item => {
                item.status = 'succeeded'; item.artifacts = [artifact]; item.finished_at = new Date().toISOString();
                item.deliverable_status = item.stage_id === 'concept' ? 'brief_ready' : 'ready_for_review';
                item.review = { status: 'pending' };
            });
        } catch (error) {
            if (!stopped) patch(item => { item.status = 'failed'; item.error = String(error.message).slice(0, 800); item.finished_at = new Date().toISOString(); });
        } finally { busy = false; controller = null; if (!stopped) setImmediate(tick); }
    }
    const timer = setInterval(tick, 2500); timer.unref(); setImmediate(tick);
    return { wake: tick, stop() { stopped = true; clearInterval(timer); controller?.abort(); } };
}

module.exports = { stageRunDir, startStageWorker };
