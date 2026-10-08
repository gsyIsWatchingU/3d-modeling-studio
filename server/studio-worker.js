const { studioDb } = require('./db');
const { assetRoot } = require('./studio');
const { generateGpuEvent } = require('./gpu-audio');

function startStudioWorker({ generate = generateGpuEvent } = {}) {
    let busy = false, stopped = false;
    for (const task of studioDb.list('tasks')) if (task.status === 'running') studioDb.change('tasks', task.id, task.owner_id, item => { item.status = 'queued'; });
    async function tick() {
        if (busy || stopped) return;
        const task = studioDb.list('tasks').find(item => item.status === 'queued');
        if (!task) return;
        busy = true;
        const patch = fn => studioDb.change('tasks', task.id, task.owner_id, fn);
        try {
            patch(item => { item.status = 'running'; item.progress_message = '自有 GPU 生成中'; item.error = null; });
            const plan = studioDb.get('plans', task.plan_id, task.owner_id);
            const output = await generate(task, plan, assetRoot);
            if (stopped) return;
            const existing = studioDb.list('assets', task.owner_id).find(item => item.task_id === task.id);
            const asset = existing || studioDb.create('assets', { ...output, task_id: task.id, name: task.name, kind: 'sfx', source: 'GPU · MOSS', review: 'pending' }, task.owner_id);
            patch(item => { item.status = 'succeeded'; item.progress_message = '已保存资源，待人工试听'; item.asset_id = asset.id; item.evidence = output.evidence; item.readiness = output.readiness; });
        } catch (error) { if (!stopped) patch(item => { item.status = 'failed'; item.error = String(error.message).slice(0, 800); item.progress_message = '生成失败'; }); }
        finally { busy = false; if (!stopped) setImmediate(tick); }
    }
    const timer = setInterval(tick, 2000); timer.unref(); setImmediate(tick);
    return { wake: () => setImmediate(tick), stop: () => { stopped = true; clearInterval(timer); } };
}
module.exports = { startStudioWorker };
