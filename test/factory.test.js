const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { unzipSync } = require('fflate');
const { validateGame } = require('../server/factory-spec');
const fixture = require('./fixtures/game-spec.json');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

async function waitFor(fn, ms = 20000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const value = await fn().catch(() => null); if (value) return value; await new Promise(r => setTimeout(r, 120)); }
    throw new Error('等待超时');
}
test('游戏校验阻止死路、危险物覆盖出生点、颜色注入与重复场次', () => {
    assert.equal(validateGame(fixture).levels.length, 1);
    const dead = structuredClone(fixture); dead.levels[0].walls = Array.from({ length: 10 }, (_, i) => ({ x: 8, y: i + 1 }));
    assert.throws(() => validateGame(dead), /无法抵达/);
    const danger = structuredClone(fixture); danger.levels[0].hazards = [{ x: 3, y: 5, axis: 'x', range: 1 }];
    assert.throws(() => validateGame(danger), /出生点/);
    const injection = structuredClone(fixture); injection.player.color = '"><script>';
    assert.throws(() => validateGame(injection));
    const duplicate = structuredClone(fixture); duplicate.levels.push(duplicate.levels[0]); assert.throws(() => validateGame(duplicate), /ID 重复/);
});

test('游戏工厂：MCP生产、幂等、隔离、断点恢复、产物、审核与公开发布', { timeout: 60000 }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-test-')), db = path.join(dir, 'db.json');
    fs.writeFileSync(db, JSON.stringify({ users: [{ id: 1, email: 'one@example.test' }, { id: 2, email: 'two@example.test' }], sessions: [1, 2].map(id => ({ userId: id, token: `test-${id}`, expiresAt: new Date(Date.now() + 3600000).toISOString() })) }));
    let requests = 0, malformed = false, events = [];
    const mock = http.createServer(async (req, res) => {
        let raw = ''; for await (const b of req) raw += b;
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/feishu') { events.push(JSON.parse(raw)); return res.end('{"code":0}'); }
        const body = JSON.parse(raw); requests++;
        assert.match(body.messages[0].content, /固定规范/);
        res.end(JSON.stringify({ choices: [{ message: { content: malformed ? '{}' : JSON.stringify({ ...fixture, title: '灯塔 </script><script>alert(1)</script>' }) } }] }));
    });
    await new Promise(r => mock.listen(0, '127.0.0.1', r));
    const probe = http.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port; await new Promise(r => probe.close(r));
    const origin = `http://127.0.0.1:${port}`, mockOrigin = `http://127.0.0.1:${mock.address().port}`;
    let child, client;
    const start = () => child = spawn(process.execPath, ['server/index.js'], { cwd: path.resolve(__dirname, '..'), stdio: 'ignore', env: { ...process.env, FACTORY_GPU_SFX: '0', PORT: String(port), DB_PATH: db, UPLOAD_DIR: path.join(dir, 'uploads'), MODEL_DIR: path.join(dir, 'models'), FACTORY_PLANNER_URL: mockOrigin, PUBLIC_URL: origin } });
    const stop = async () => { if (child?.exitCode === null) { child.kill(); await once(child, 'exit'); } };
    t.after(async () => { if (client) await client.close(); await stop(); mock.closeAllConnections(); await new Promise(r => mock.close(r)); fs.rmSync(dir, { force: true, recursive: true }); });
    start(); await waitFor(async () => (await fetch(origin + '/api/health')).ok);
    const headers = id => ({ Cookie: `studio_session=test-${id}`, 'Content-Type': 'application/json' });
    const request = (route, options = {}, id = 1) => fetch(origin + '/api/factory' + route, { ...options, headers: { ...headers(id), ...options.headers } });
    const post = value => ({ method: 'POST', body: JSON.stringify(value) });
    const data = async response => { const r = await response; const p = await r.json(); assert.ok(r.ok, p.error); return p.data; };
    assert.equal((await fetch(origin + '/api/factory/projects')).status, 401);
    assert.equal((await request('/projects', { ...post({}), headers: { Origin: 'https://other.test' } })).status, 403);
    await fetch(origin + '/api/notification-config', { method: 'PUT', headers: headers(1), body: JSON.stringify({ feishu: { webhook: mockOrigin + '/feishu' } }) });
    const token = await fetch(origin + '/api/mcp/tokens', { ...post({ name: 'factory-test' }), headers: headers(1) }).then(r => r.json());
    client = new Client({ name: 'factory-test', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve(__dirname, '../mcp/server.js')], env: { ...process.env, STUDIO_URL: origin, STUDIO_TOKEN: token.data.token }, stderr: 'pipe' }));
    const call = async (name, args = {}) => { const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError, result.content[0].text); return JSON.parse(result.content[0].text); };
    const p = await call('create_game_project', { name: '工厂验证', brief: '制作一款寻找光晶、点亮灯塔的浏览器探索游戏。' });
    assert.equal((await request(`/projects/${p.id}`, {}, 2)).status, 404);
    const args = { project_id: p.id, request_key: 'test-first-run', notify_feishu: true };
    const run = await call('start_game_production', args), duplicate = await call('start_game_production', args);
    assert.equal(duplicate.id, run.id);
    const endpoint = `/projects/${p.id}/runs/${run.id}`;
    const done = await waitFor(async () => { const x = await data(request(`/projects/${p.id}`)); return x.runs[0].status === 'succeeded' && x; });
    assert.equal(requests, 1); assert.equal(done.runs[0].stages.filter(s => s.status === 'succeeded').length, 7);
    assert.equal((await request(endpoint + '/publish', post({}))).status, 400);
    assert.equal((await request(endpoint + '/review', { ...post({ status: 'approved', played: true, notes: '这是自动化接口检查' }), headers: { Cookie: '', Authorization: `Bearer ${token.data.token}` } })).status, 401);
    assert.equal((await request(endpoint + '/files/game.json', {}, 2)).status, 404);
    const files = await call('get_game_artifacts', { project_id: p.id, run_id: run.id });
    assert.ok(files.some(f => f.path === 'assets/music.wav' && f.bytes > 300000));
    assert.ok(files.every(f => /^[a-f0-9]{64}$/.test(f.sha256)));
    const html = await request(endpoint + '/files/index.html').then(r => r.text());
    assert.ok(!html.includes('</script><script>alert(1)')); assert.ok(html.includes('\\u003c/script>'));
    assert.ok(html.includes('window.GAME_ASSETS=')); assert.ok(!html.includes('<script src="runtime.js">'));
    const archive = path.join(dir, 'game.zip'); await call('export_game', { project_id: p.id, run_id: run.id, download_path: archive });
    const packed = unzipSync(fs.readFileSync(archive)); assert.ok(packed['runtime.js']); assert.ok(packed['assets/player.svg']); assert.ok(packed['docs/skill-snapshot.json']);
    const editDir = path.join(dir, 'editable'); fs.mkdirSync(editDir);
    for (const name of ['index.html', 'rebuild.cjs', 'game.json']) fs.writeFileSync(path.join(editDir, name), packed[name]);
    const rebuild = spawnSync(process.execPath, ['rebuild.cjs'], { cwd: editDir }); assert.equal(rebuild.status, 0, rebuild.stderr.toString());
    assert.ok(!fs.readFileSync(path.join(editDir, 'index.html'), 'utf8').includes('</script><script>alert(1)'));
    await waitFor(async () => events.length === 1); assert.match(events[0].content.text, /游戏版本生产完成/);
    await data(request(endpoint + '/review', post({ status: 'approved', played: true, notes: '测试账号接口验收状态，非真实人工结论' })));
    const published = await call('publish_game', { project_id: p.id, run_id: run.id });
    assert.equal((await fetch(published.url)).status, 200);
    assert.equal((await fetch(published.url + 'assets/music.wav')).status, 200);
    assert.equal((await fetch(published.url + 'docs/design.md')).status, 404);
    // 失败重试只补失败阶段，旧产物与公开版本不变。
    malformed = true;
    const bad = await call('start_game_production', { project_id: p.id, request_key: 'test-failed-run', instructions: '改成更简短的对白', notify_feishu: false });
    await waitFor(async () => (await data(request(`/projects/${p.id}`))).runs[1].status === 'failed');
    const countBefore = requests; malformed = false;
    // 模拟进程中断后的 running 状态，重启恢复未完成阶段。
    await stop(); const stored = JSON.parse(fs.readFileSync(db)); const storedRun = stored.factory_projects[0].runs[1]; storedRun.status = 'running'; storedRun.stages[0].status = 'running'; fs.writeFileSync(db, JSON.stringify(stored)); start();
    await waitFor(async () => (await data(request(`/projects/${p.id}`))).runs[1].status === 'succeeded');
    assert.equal(requests, countBefore + 1);
    assert.equal((await data(request(`/projects/${p.id}`))).release.run_id, run.id);
    assert.equal((await request(endpoint + '/files/game.json').then(r => r.json())).title, '灯塔 </script><script>alert(1)</script>');
    await data(request(`/projects/${p.id}/release`, { method: 'DELETE' })); assert.equal((await fetch(published.url)).status, 404);
    const canceled = await data(request(`/projects/${p.id}/runs`, post({ request_key: 'test-cancel-run' })));
    await data(request(`/projects/${p.id}/runs/${canceled.id}/cancel`, post({})));
    assert.equal((await data(request(`/projects/${p.id}`))).runs.at(-1).status, 'cancelled');
    assert.equal((await request(`/projects/${p.id}/runs/${bad.id}/retry`, post({}))).status, 400);
});
