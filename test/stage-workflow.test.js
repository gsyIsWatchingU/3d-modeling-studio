const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const gameFixture = require('./fixtures/game-spec.json');

async function waitFor(fn, ms = 15000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const value = await fn().catch(() => null); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error('等待超时');
}

test('引导式工位支持独立生成、依赖交接、预览图后端保存和人工审核', { timeout: 40000 }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-workflow-')), db = path.join(dir, 'db.json');
    fs.writeFileSync(db, JSON.stringify({
        users: [{ id: 1, email: 'one@example.test' }, { id: 2, email: 'two@example.test' }],
        sessions: [1, 2].map(id => ({ userId: id, token: `stage-${id}`, expiresAt: new Date(Date.now() + 3600000).toISOString() }))
    }));
    let plannerRequests = 0, plannerBodies = [];
    const planner = http.createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw); plannerRequests++; plannerBodies.push(body);
        assert.match(body.messages[0].content, /固定规范/);
        if (body.response_format) {
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(gameFixture) } }] }));
        }
        assert.match(body.messages[0].content, /独立阶段执行器/);
        const title = body.messages[0].content.match(/只交付“([^”]+)”/)?.[1] || '阶段';
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: `# ${title}\n\n这是独立阶段的可审核交付文档，包含稳定的 CHAR-001、SCENE-001 与 EVENT-001，并记录输入、输出、依赖、风险和人工验收项。\n\n## 交付\n\n内容仅为当前阶段提案，不代表图片、模型、音频或最终游戏已经生成。` } }] }));
    });
    await new Promise(resolve => planner.listen(0, '127.0.0.1', resolve));
    const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const origin = `http://127.0.0.1:${port}`, plannerOrigin = `http://127.0.0.1:${planner.address().port}`;
    const child = spawn(process.execPath, ['server/index.js'], { cwd: path.resolve(__dirname, '..'), stdio: 'ignore', env: { ...process.env, PORT: String(port), DB_PATH: db, UPLOAD_DIR: path.join(dir, 'uploads'), MODEL_DIR: path.join(dir, 'models'), FACTORY_DIR: path.join(dir, 'factory'), FACTORY_PLANNER_URL: plannerOrigin, PUBLIC_URL: origin } });
    t.after(async () => {
        if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
        planner.closeAllConnections(); await new Promise(resolve => planner.close(resolve)); fs.rmSync(dir, { recursive: true, force: true });
    });
    await waitFor(async () => (await fetch(origin + '/api/health')).ok);
    const headers = id => ({ Cookie: `studio_session=stage-${id}`, 'Content-Type': 'application/json' });
    const request = (route, options = {}, id = 1) => fetch(origin + '/api/factory' + route, { ...options, headers: { ...headers(id), ...options.headers } });
    const post = value => ({ method: 'POST', body: JSON.stringify(value) });
    const data = async response => { const result = await response, payload = await result.json(); assert.ok(result.ok, payload.error); return payload.data; };

    const capabilities = await data(request('/capabilities'));
    assert.deepEqual(capabilities.workflow_stages.map(stage => stage.id), ['design', 'narrative', 'concept', 'modeling', 'animation_audio', 'integration', 'qa']);
    const project = await data(request('/projects', post({ name: '阶段工厂', brief: '制作一款寻找遗失灯火并返回家园的浏览器探索游戏。', style: '克制的夜色与暖光' })));

    const designArgs = { stage_id: 'design', request_key: 'stage-design-001', instructions: '先明确核心循环' };
    const design = await data(request(`/projects/${project.id}/stage-runs`, post(designArgs)));
    const duplicate = await data(request(`/projects/${project.id}/stage-runs`, post(designArgs))); assert.equal(duplicate.id, design.id);
    const designDone = await waitFor(async () => {
        const current = await data(request(`/projects/${project.id}`)); return current.stage_runs.find(run => run.id === design.id)?.status === 'succeeded' && current.stage_runs.find(run => run.id === design.id);
    });
    assert.deepEqual(designDone.missing_approved_inputs, []);
    assert.match(await request(`/projects/${project.id}/stage-runs/${design.id}/files/output.md`).then(response => response.text()), /CHAR-001/);
    assert.equal((await request(`/projects/${project.id}/stage-runs/${design.id}/files/output.md`, {}, 2)).status, 404);
    assert.equal((await request(`/projects/${project.id}/stage-runs/${design.id}/review`, { ...post({ status: 'approved', notes: '尝试绕过网页登录审核', confirmed: true }), headers: { Cookie: '' } })).status, 401);
    await data(request(`/projects/${project.id}/stage-runs/${design.id}/review`, post({ status: 'approved', notes: '策划结构清楚，可以进入剧本阶段', confirmed: true })));

    const narrative = await data(request(`/projects/${project.id}/stage-runs`, post({ stage_id: 'narrative', request_key: 'stage-narrative-001', instructions: '' })));
    const narrativeDone = await waitFor(async () => {
        const current = await data(request(`/projects/${project.id}`)); return current.stage_runs.find(run => run.id === narrative.id)?.status === 'succeeded' && current.stage_runs.find(run => run.id === narrative.id);
    });
    assert.deepEqual(narrativeDone.input_run_ids, [design.id]);
    await data(request(`/projects/${project.id}/stage-runs/${narrative.id}/review`, post({ status: 'approved', notes: '剧本事件和角色编号可以继续使用', confirmed: true })));

    const concept = await data(request(`/projects/${project.id}/stage-runs`, post({ stage_id: 'concept', request_key: 'stage-concept-001', instructions: '优先设计主角和首个场景' })));
    await waitFor(async () => (await data(request(`/projects/${project.id}`))).stage_runs.find(run => run.id === concept.id)?.status === 'succeeded');
    assert.equal((await request(`/projects/${project.id}/stage-runs/${concept.id}/review`, post({ status: 'approved', notes: '制作单内容符合项目方向', confirmed: true }))).status, 400);
    const form = new FormData(); form.append('images', new Blob([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' }), 'hero-preview.png');
    const upload = await fetch(`${origin}/api/factory/projects/${project.id}/stage-runs/${concept.id}/previews`, { method: 'POST', headers: { Cookie: 'studio_session=stage-1' }, body: form });
    const uploaded = await data(Promise.resolve(upload)); assert.equal(uploaded.filter(item => item.type === 'image').length, 1);
    const image = await request(`/projects/${project.id}/stage-runs/${concept.id}/files/${uploaded.find(item => item.type === 'image').path}`); assert.equal(image.status, 200); assert.equal((await image.arrayBuffer()).byteLength, 8);
    await data(request(`/projects/${project.id}/stage-runs/${concept.id}/review`, post({ status: 'approved', notes: '已经检查实际预览图，可以交给建模', confirmed: true })));
    const modelPlan = await data(request(`/projects/${project.id}/model-plan`, post({})));
    assert.equal(modelPlan.preview_files.length, 1); assert.match(modelPlan.preview_files[0].url, /stage-runs/);
    const complete = await data(request(`/projects/${project.id}/runs`, post({ request_key: 'stage-complete-001', instructions: '沿用已批准的阶段产物' })));
    const finalProject = await waitFor(async () => { const current = await data(request(`/projects/${project.id}`)); return current.runs.find(run => run.id === complete.id)?.status === 'succeeded' && current; }, 20000);
    assert.equal(finalProject.stage_runs.at(-1).review.status, 'approved');
    assert.deepEqual(finalProject.runs[0].stage_input_ids, [design.id, narrative.id, concept.id]);
    const fullRequest = plannerBodies.find(body => body.response_format); const fullInput = JSON.parse(fullRequest.messages[1].content);
    assert.deepEqual(fullInput.approved_stage_inputs.map(input => input.stage_run_id), [design.id, narrative.id, concept.id]);
    assert.equal(plannerRequests, 4);
});
