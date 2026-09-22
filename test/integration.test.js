const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const sharp = require('sharp');

function validGlb() {
    const jsonText = JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{}] });
    const padded = jsonText.padEnd(Math.ceil(jsonText.length / 4) * 4, ' ');
    const json = Buffer.from(padded, 'utf8');
    const buffer = Buffer.alloc(12 + 8 + json.length);
    buffer.write('glTF', 0, 'ascii');
    buffer.writeUInt32LE(2, 4);
    buffer.writeUInt32LE(buffer.length, 8);
    buffer.writeUInt32LE(json.length, 12);
    buffer.writeUInt32LE(0x4e4f534a, 16);
    json.copy(buffer, 20);
    return buffer;
}

async function waitFor(predicate, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        try {
            const value = await predicate();
            if (value) return value;
        } catch (error) { lastError = error; }
        await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw lastError || new Error('等待条件超时');
}

test('多图任务会立即返回 202，并由后台 Worker 完成模型校验', { timeout: 20000 }, async t => {
    let polls = 0;
    let submissions = 0;
    let receivedPlan;
    const model = validGlb();
    const provider = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/v1/jobs') {
            submissions += 1;
            const chunks = [];
            req.on('data', chunk => chunks.push(chunk));
            req.on('end', async () => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                const form = await new Response(Buffer.concat(chunks), {headers: {'content-type': req.headers['content-type']}}).formData();
                const plan = JSON.parse(form.get('skill_plan'));
                receivedPlan = plan;
                res.end(JSON.stringify({ job_id: 'mock-job', state: 'queued', provenance: {skill_plan_sha256: plan.sha256} }));
            });
            return;
        }
        if (req.method === 'GET' && req.url === '/v1/jobs/mock-job') {
            polls += 1;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(polls < 2
                ? { job_id: 'mock-job', state: 'running', stages: [{ name: 'shape', state: 'running' }] }
                : { job_id: 'mock-job', state: 'completed', outputs: { model: `http://127.0.0.1:${provider.address().port}/model.glb` } }));
            return;
        }
        if (req.method === 'GET' && req.url === '/model.glb') {
            res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Length': model.length });
            res.end(model);
            return;
        }
        res.writeHead(404).end();
    });
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    t.after(() => provider.close());

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeling-studio-integration-'));
    // 预置统一账号用户与会话：/api/jobs 现在要求登录，测试直接种子一个有效会话
    const now = new Date();
    const sessionToken = 'test-session-token-for-integration';
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'db.json'), JSON.stringify({
        models: [],
        jobs: [],
        skills: [],
        notifications: [],
        users: [{
            id: 1,
            username: 'tester@example.com',
            password: 'sso:test-placeholder',
            email: 'tester@example.com',
            ssoSubject: 'sso-user-integration',
            displayName: 'tester',
            isAdmin: 0,
            createdAt: now.toISOString()
        }],
        sessions: [{ token: sessionToken, userId: 1, expiresAt: new Date(now.getTime() + 3600e3).toISOString(), createdAt: now.toISOString() }],
        settings: {},
        spu_config: {},
        notification_config: {},
        nextId: 1,
        nextJobId: 1,
        nextSkillId: 1,
        nextNotificationId: 1,
        nextUserId: 2
    }));
    const appPort = 34000 + Math.floor(Math.random() * 1000);
    const child = spawn(process.execPath, ['server/index.js'], {
        cwd: path.resolve(__dirname, '..'),
        env: {
            ...process.env,
            PORT: String(appPort),
            DB_PATH: path.join(root, 'db.json'),
            UPLOAD_DIR: path.join(root, 'uploads'),
            MODEL_DIR: path.join(root, 'models'),
            SKILL_PLANNER_MODE: 'structured',
            SPU_PROVIDER: 'forge3d',
            SPU_API_URL: `http://127.0.0.1:${provider.address().port}/v1/jobs`,
            PUBLIC_BASE_URL: `http://127.0.0.1:${appPort}`
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let childOutput = '';
    child.stdout.on('data', chunk => { childOutput += chunk; });
    child.stderr.on('data', chunk => { childOutput += chunk; });
    t.after(() => {
        if (!child.killed) child.kill('SIGTERM');
        fs.rmSync(root, { recursive: true, force: true });
    });

    await waitFor(async () => (await fetch(`http://127.0.0.1:${appPort}/api/health`)).ok, 6000);
    const pngA = await sharp({ create: { width: 40, height: 50, channels: 3, background: '#ff0000' } }).png().toBuffer();
    const pngB = await sharp({ create: { width: 50, height: 40, channels: 3, background: '#0000ff' } }).png().toBuffer();
    const apiBase = 'http://127.0.0.1:' + appPort;
    const cookie = {Cookie: 'studio_session=' + sessionToken};
    const skillForm = new FormData();
    skillForm.append('skill_file', new Blob(['---\nname: 个人高精度\n---\n' + '保留主体细节。'.repeat(350) + '\n' + '\x60\x60\x60modeling\n{"triangle_budget":60000}\n\x60\x60\x60']), 'SKILL.md');
    const skillResponse = await fetch(apiBase + '/api/skills', {method: 'POST', headers: cookie, body: skillForm});
    assert.equal(skillResponse.status, 201);
    const personalSkill = (await skillResponse.json()).data;
    const fixed = await fetch(apiBase + '/api/settings/default-skills', {method: 'PUT', headers: {...cookie, 'Content-Type': 'application/json'}, body: JSON.stringify({skill_ids: [personalSkill.id]})});
    assert.equal(fixed.status, 200);
    const form = new FormData();
    form.append('images', new Blob([pngA], { type: 'image/png' }), 'front.png');
    form.append('images', new Blob([pngB], { type: 'image/png' }), 'back.png');
    form.append('name', '测试道具');
    form.append('prompt', '保持红蓝结构。');
    form.append('asset_kind', 'prop');
    form.append('profile', 'xhs_mobile');
    form.append('skill_ids', '[]');
    form.append('channels', '[]');
    // 未登录提交 → 401
    const unauth = await fetch(`http://127.0.0.1:${appPort}/api/jobs`, { method: 'POST', body: form });
    assert.equal(unauth.status, 401, childOutput);
    const response = await fetch(`http://127.0.0.1:${appPort}/api/jobs`, {
        method: 'POST',
        body: form,
        headers: { Cookie: `studio_session=${sessionToken}` }
    });
    assert.equal(response.status, 202, childOutput);
    const created = await response.json();
    assert.equal(created.data.status, 'queued');

    const completed = await waitFor(async () => {
        const result = await fetch(`http://127.0.0.1:${appPort}/api/jobs/${created.data.id}`, {headers: {Cookie: `studio_session=${sessionToken}`}}).then(item => item.json());
        return result.data?.status === 'succeeded' ? result.data : null;
    }, 14000);
    assert.equal(submissions, 1);
    assert.equal(receivedPlan.generation.triangle_budget, 60000);
    assert.equal(completed.skill_snapshot.entries.find(item => item.id === personalSkill.id).mandatory, true);
    assert.equal(completed.execution_plan.generation.triangle_budget, 60000);
    const noLogin = await fetch(apiBase + '/api/jobs/' + completed.id);
    assert.equal(noLogin.status, 401);
    assert.equal(completed.output.validated, true);
    assert.equal(completed.output.sha256.length, 64);
});
