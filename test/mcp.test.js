const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const sharp = require('sharp');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

async function waitFor(predicate, timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        const value = await predicate().catch(() => null);
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error('等待任务超时');
}

test('stdio MCP：账号隔离、固定 Skill、异步飞书通知、下载与凭证撤销', { timeout: 50000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-mcp-'));
    const dbFile = path.join(root, 'db.json');
    const users = [1, 2].map(id => ({ id, email: `mcp${id}@example.com`, username: `mcp${id}`, ssoSubject: `test-${id}` }));
    const expiry = new Date(Date.now() + 3600000).toISOString();
    fs.writeFileSync(dbFile, JSON.stringify({
        users, sessions: users.map(user => ({ userId: user.id, token: `session-${user.id}`, expiresAt: expiry })),
        skills: [{ id: 'private-1', name: '个人木材', content: '保持木质结构', owner_id: 1, enabled: true }],
        user_settings: { '1': { default_skill_ids: ['skill-general', 'private-1'] } },
        notification_config: { feishu: { webhook: 'https://legacy.invalid/global-secret' } }
    }));
    let submissions = 0;
    const deliveries = [];
    const json = Buffer.from('{"asset":{"version":"2.0"},"scene":0,"scenes":[{}]}'.padEnd(56, ' '));
    const glb = Buffer.alloc(20 + json.length);
    glb.write('glTF'); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8);
    glb.writeUInt32LE(json.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); json.copy(glb, 20);
    const mock = http.createServer(async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'POST' && req.url === '/v1/jobs') {
            submissions++;
            const chunks = []; for await (const chunk of req) chunks.push(chunk);
            const form = await new Response(Buffer.concat(chunks), { headers: { 'Content-Type': req.headers['content-type'] } }).formData();
            const plan = JSON.parse(form.get('skill_plan'));
            res.end(JSON.stringify({ job_id: 'mock-job', state: 'queued', provenance: { skill_plan_sha256: plan.sha256 } }));
        } else if (req.url === '/v1/jobs/mock-job') {
            res.end(JSON.stringify({ job_id: 'mock-job', state: 'completed', outputs: { model: `http://127.0.0.1:${mock.address().port}/model.glb` } }));
        } else if (req.url === '/model.glb') {
            res.setHeader('Content-Type', 'model/gltf-binary'); res.end(glb);
        } else if (req.url.startsWith('/feishu/')) {
            const chunks = []; for await (const chunk of req) chunks.push(chunk);
            deliveries.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks)) });
            // 首次投递失败，验证独立重试不会重新建模。
            res.end(JSON.stringify(deliveries.length === 1 ? { code: 1, msg: 'temporary failure' } : { code: 0 }));
        } else { res.writeHead(404).end('{}'); }
    });
    await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
    const portProbe = http.createServer();
    await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
    const port = portProbe.address().port;
    await new Promise(resolve => portProbe.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    const mockBase = `http://127.0.0.1:${mock.address().port}`;
    const child = spawn(process.execPath, ['server/index.js'], {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, PORT: String(port), DB_PATH: dbFile, UPLOAD_DIR: path.join(root, 'uploads'), MODEL_DIR: path.join(root, 'models'), SKILL_PLANNER_MODE: 'structured', SPU_API_URL: `${mockBase}/v1/jobs`, PUBLIC_URL: base, PUBLIC_BASE_URL: base, FEISHU_WEBHOOK: 'https://environment.invalid/secret' },
        stdio: 'ignore'
    });
    const clients = [];
    t.after(async () => {
        for (const client of clients) await client.close();
        if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
        mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });
    await waitFor(async () => (await fetch(`${base}/api/health`)).ok);
    const cookie = id => ({ Cookie: `studio_session=session-${id}`, 'Content-Type': 'application/json' });
    const mint = async id => {
        const res = await fetch(`${base}/api/mcp/tokens`, { method: 'POST', headers: cookie(id), body: JSON.stringify({ name: `client-${id}` }) });
        assert.equal(res.status, 201); assert.equal(res.headers.get('cache-control'), 'no-store');
        return (await res.json()).data;
    };
    assert.equal((await fetch(`${base}/api/mcp/tokens`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await fetch(`${base}/api/mcp/tokens`, { method: 'POST', headers: { ...cookie(1), Origin: 'https://evil.invalid' }, body: '{}' })).status, 403);
    const a = await mint(1), b = await mint(2);
    const bearer = token => ({ Authorization: `Bearer ${token}` });
    assert.ok(!fs.readFileSync(dbFile, 'utf8').includes(a.token));
    const listed = await fetch(`${base}/api/mcp/tokens`, { headers: cookie(1) }).then(r => r.json());
    assert.equal(listed.data.length, 1); assert.equal(listed.data[0].hash, undefined); assert.equal(listed.data[0].token, undefined);
    assert.equal((await fetch(`${base}/api/mcp/tokens/${a.id}`, { method: 'DELETE', headers: cookie(2) })).status, 404);
    assert.equal((await fetch(`${base}/api/config/spu`, { method: 'PUT', headers: { ...bearer(a.token), 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await fetch(`${base}/api/notification-config`, { method: 'PUT', headers: { ...bearer(a.token), 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    async function connect(token) {
        const client = new Client({ name: 'test', version: '1.0.0' });
        await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve(__dirname, '../mcp/server.js')], env: { ...process.env, STUDIO_URL: base, STUDIO_TOKEN: token }, stderr: 'pipe' }));
        clients.push(client); return client;
    }
    const client = await connect(a.token);
    const call = (name, args = {}) => client.callTool({ name, arguments: args });
    const data = response => JSON.parse(response.content[0].text);
    const toolNames = (await client.listTools()).tools.map(tool => tool.name);
    for (const name of ['create_model', 'get_model', 'create_production_plan', 'get_production_guide', 'list_production_skills', 'list_production_plans', 'start_game_stage', 'get_game_stage_artifact']) assert.ok(toolNames.includes(name));
    const catalog = data(await call('list_production_skills'));
    assert.equal(catalog.stages.length, 9);
    assert.equal(catalog.stages.find(stage => stage.id === 'audio').execution, 'specification');
    const planResult = await call('create_production_plan', { name: '首关测试', brief: '制作木椅道具，用于房间中的观察线索。', profile: 'xhs_mobile' });
    assert.ok(!planResult.isError, planResult.content[0].text);
    const productionPlan = data(planResult);
    assert.equal(data(await call('list_production_plans'))[0].id, productionPlan.id);
    const guide = data(await call('get_production_guide', { stage: 'prop', plan_id: productionPlan.id }));
    assert.equal(guide.snapshot.entries.length, 3);
    assert.ok(guide.snapshot.entries.some(entry => entry.sources.some(source => source.commit.length === 40)));
    assert.equal((await fetch(`${base}/api/production/plans/${productionPlan.id}`, { headers: bearer(b.token) })).status, 404);
    assert.equal((await fetch(`${base}/api/production/guides/prop?plan_id=${productionPlan.id}`, { headers: bearer(b.token) })).status, 404);
    assert.equal((await fetch(`${base}/api/production/plans`)).status, 401);
    assert.deepEqual((await fetch(`${base}/api/production/plans`, { headers: bearer(b.token) }).then(r => r.json())).data, []);
    const account = data(await call('get_account'));
    assert.equal(account.user.id, 1); assert.equal(account.notifications.feishu.configured, false);
    assert.equal(data(await call('list_skills')).some(s => s.id === 'private-1'), true);
    const imagePath = path.join(root, 'chair.png');
    fs.writeFileSync(imagePath, await sharp({ create: { width: 24, height: 24, channels: 3, background: '#ffaa00' } }).png().toBuffer());
    assert.equal((await call('create_model', { image_paths: [imagePath] })).isError, true);
    assert.equal(submissions, 0);
    const notificationRes = await fetch(`${base}/api/notification-config`, { method: 'PUT', headers: cookie(1), body: JSON.stringify({ feishu: { webhook: `${mockBase}/feishu/user-1` } }) });
    assert.equal(notificationRes.status, 200);
    assert.ok(!(await notificationRes.text()).includes('/feishu/user-1'));
    const otherAccount = await fetch(`${base}/api/mcp/me`, { headers: bearer(b.token) }).then(r => r.json());
    assert.equal(otherAccount.data.notifications.feishu.configured, false);
    const creation = await call('create_model', { name: 'MCP 测试木椅', image_paths: [imagePath], production_plan_id: productionPlan.id });
    assert.ok(!creation.isError, creation.content[0].text);
    const job = data(creation);
    assert.equal(job.status, 'queued');
    assert.equal(job.production_plan_id, productionPlan.id);
    for (const expected of guide.snapshot.entries) {
        const applied = job.skill_snapshot.entries.find(entry => entry.id === expected.id);
        assert.equal(applied.sha256, expected.sha256);
        assert.equal(applied.mandatory, true);
    }
    assert.ok(job.skill_snapshot.entries.some(entry => entry.id === 'private-1' && entry.mandatory));
    assert.equal((await fetch(`${base}/api/jobs/${job.id}`, { headers: bearer(b.token) })).status, 404);
    const done = await waitFor(async () => {
        const result = data(await call('get_job', { job_id: job.id }));
        return result.status === 'succeeded' ? result : null;
    });
    assert.equal(done.output.validated, true);
    assert.equal((await fetch(`${base}${done.output.model_file}`, { headers: bearer(b.token) })).status, 404);
    assert.equal((await fetch(`${base}/api/models/${done.output.model_id}`, { headers: bearer(b.token) })).status, 404);
    const downloaded = await call('get_model', { job_id: job.id, download_path: path.join(root, 'download.glb') });
    assert.ok(!downloaded.isError, downloaded.content[0].text);
    assert.deepEqual(fs.readFileSync(path.join(root, 'download.glb')), glb);
    assert.equal((await call('get_model', { job_id: job.id, download_path: path.join(root, 'download.glb') })).isError, true);
    await waitFor(async () => deliveries.length === 1);
    // 撤销不影响已入队的通知重试。
    assert.equal((await fetch(`${base}/api/mcp/tokens/${a.id}`, { method: 'DELETE', headers: cookie(1) })).status, 200);
    assert.equal((await call('get_account')).isError, true);
    await waitFor(async () => deliveries.length === 2, 22000);
    assert.equal(submissions, 1);
    assert.ok(deliveries.every(item => item.url === '/feishu/user-1'));
    assert.match(deliveries[1].body.content.text, /3D 模型生成完成/);
    assert.ok(deliveries[1].body.content.text.includes(job.id));
});

test('MCP 拒绝明文远程连接和非法凭证', () => {
    const { createServer } = require('../mcp/server');
    assert.throws(() => createServer({ baseUrl: 'http://example.com', token: `studio_${'a'.repeat(43)}` }), /HTTPS/);
    assert.throws(() => createServer({ baseUrl: 'https://example.com', token: 'invalid' }), /STUDIO_TOKEN/);
});
