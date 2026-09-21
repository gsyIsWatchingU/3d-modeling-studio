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
    const model = validGlb();
    const provider = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/v1/jobs') {
            submissions += 1;
            req.resume();
            req.on('end', () => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ job_id: 'mock-job', state: 'queued' }));
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
    const appPort = 34000 + Math.floor(Math.random() * 1000);
    const child = spawn(process.execPath, ['server/index.js'], {
        cwd: path.resolve(__dirname, '..'),
        env: {
            ...process.env,
            PORT: String(appPort),
            DB_PATH: path.join(root, 'db.json'),
            UPLOAD_DIR: path.join(root, 'uploads'),
            MODEL_DIR: path.join(root, 'models'),
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
    const form = new FormData();
    form.append('images', new Blob([pngA], { type: 'image/png' }), 'front.png');
    form.append('images', new Blob([pngB], { type: 'image/png' }), 'back.png');
    form.append('name', '测试道具');
    form.append('prompt', '保持红蓝结构。');
    form.append('asset_kind', 'prop');
    form.append('profile', 'xhs_mobile');
    form.append('skill_ids', '[]');
    form.append('channels', '[]');
    const response = await fetch(`http://127.0.0.1:${appPort}/api/jobs`, { method: 'POST', body: form });
    assert.equal(response.status, 202, childOutput);
    const created = await response.json();
    assert.equal(created.data.status, 'queued');

    const completed = await waitFor(async () => {
        const result = await fetch(`http://127.0.0.1:${appPort}/api/jobs/${created.data.id}`).then(item => item.json());
        return result.data?.status === 'succeeded' ? result.data : null;
    }, 14000);
    assert.equal(submissions, 1);
    assert.equal(completed.output.validated, true);
    assert.equal(completed.output.sha256.length, 64);
});
