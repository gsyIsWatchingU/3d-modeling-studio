const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const sharp = require('sharp');

async function waitFor(fn, timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error('等待测试服务超时');
}
function cubeGlb() {
    const THREE = require('three');
    const positions = new THREE.BoxGeometry(1, 1.4, 1).toNonIndexed().attributes.position.array;
    const binary = Buffer.from(positions.buffer);
    const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }], materials: [{ pbrMetallicRoughness: { baseColorFactor: [.55, .7, .48, 1], metallicFactor: .1, roughnessFactor: .7 } }], buffers: [{ byteLength: binary.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: binary.length }], accessors: [{ bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min: [-.5, -.7, -.5], max: [.5, .7, .5] }] };
    const text = JSON.stringify(json), jsonBytes = Buffer.from(text.padEnd(Math.ceil(text.length / 4) * 4, ' '));
    const glb = Buffer.alloc(28 + jsonBytes.length + binary.length);
    glb.write('glTF'); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8); glb.writeUInt32LE(jsonBytes.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); jsonBytes.copy(glb, 20); glb.writeUInt32LE(binary.length, 20 + jsonBytes.length); glb.writeUInt32LE(0x004e4942, 24 + jsonBytes.length); binary.copy(glb, 28 + jsonBytes.length); return glb;
}
function wavFixture() {
    const wav = Buffer.alloc(44 + 22050 * 2); wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(22050, 24); wav.writeUInt32LE(44100, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40); return wav;
}
async function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-studio-test-'));
    const captures = { plans: [], gpu: [], invalid: false }, glb = cubeGlb();
    const provider = http.createServer(async (req, res) => {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        if (req.url === '/chat') {
            const input = JSON.parse(bytes); captures.plans.push({ body: input, authorization: req.headers.authorization });
            const user = JSON.parse(input.messages.at(-1).content);
            const content = captures.invalid ? { name: '坏参数', summary: '拒绝执行', prompt: '测试', material_prompt: 'matte', generation: { triangle_budget: 999999999 } } : user.kind === 'sfx'
                ? { name: '木门开启', summary: '近距离木门吱呀声，短尾音', prompt: 'dry wooden door creaking open, no music, short tail', duration: 2, review_requirements: ['试听确认音量和尾音。'] }
                : { name: '黄铜台灯', summary: '按参考图制作网页用道具，保留黄铜材质', prompt: '保留参考图的黄铜台灯，底座完整。', material_prompt: 'brushed brass lamp, matte surface', generation: { triangle_budget: 24000 }, review_requirements: ['检查背面完整性。'] };
            res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
        } else if (req.url === '/v1/jobs' && req.method === 'POST') {
            const form = await new Response(bytes, { headers: { 'content-type': req.headers['content-type'] } }).formData();
            const plan = JSON.parse(form.get('skill_plan')); captures.gpu.push(plan);
            res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ job_id: 'fixture-job', state: 'queued', provenance: { skill_plan_sha256: plan.sha256 } }));
        } else if (req.url === '/v1/jobs/fixture-job') {
            res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ job_id: 'fixture-job', state: 'completed', outputs: { model: `http://127.0.0.1:${provider.address().port}/cube.glb` } }));
        } else if (req.url === '/cube.glb') res.end(glb);
        else res.writeHead(404).end();
    });
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    const seed = { users: [1, 2].map(id => ({ id, username: `fixture${id}@example.com`, email: `fixture${id}@example.com`, displayName: `测试用户${id}`, password: 'sso:fixture', ssoSubject: `fixture-${id}` })), sessions: [1, 2].map(id => ({ token: `fixture-session-${id}`, userId: id, expiresAt: new Date(Date.now() + 3600000).toISOString() })) };
    fs.writeFileSync(path.join(root, 'db.json'), JSON.stringify(seed));
    const socket = http.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve)); const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
    const base = `http://127.0.0.1:${port}`, cookie = { Cookie: 'studio_session=fixture-session-1' };
    const child = spawn(process.execPath, ['server/index.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, PORT: String(port), DB_PATH: path.join(root, 'db.json'), UPLOAD_DIR: path.join(root, 'uploads'), MODEL_DIR: path.join(root, 'models'), SPU_API_URL: `http://127.0.0.1:${provider.address().port}/v1/jobs`, SKILL_PLANNER_URL: `http://127.0.0.1:${provider.address().port}/chat`, SKILL_PLANNER_MODE: 'structured', MP_ENABLED: '0' }, stdio: 'pipe' });
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    try { await waitFor(async () => (await fetch(`${base}/api/health`)).ok, 10000); } catch (error) { child.kill(); provider.close(); throw new Error(`${error.message}\n${output}`); }
    const api = (url, options = {}, owner = 1) => fetch(base + '/api' + url, { ...options, headers: { ...(owner ? { Cookie: `studio_session=fixture-session-${owner}` } : {}), ...options.headers } });
    const json = (url, method, body, owner = 1) => api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, owner);
    const png = await sharp({ create: { width: 80, height: 80, channels: 3, background: '#abc3ad' } }).png().toBuffer();
    const upload = async (name, bytes, filename) => { const form = new FormData(); form.append('name', name); form.append('file', new Blob([bytes]), filename); return api('/studio/resources', { method: 'POST', body: form }); };
    return { root, base, cookie, api, json, upload, png, glb, wav: wavFixture(), captures, provider, async close() { await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); }); await new Promise(resolve => provider.close(resolve)); if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(root, { recursive: true, force: true }); } };
}
module.exports = { fixture, waitFor, wavFixture };
