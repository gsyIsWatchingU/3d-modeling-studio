const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeAudio, digest } = require('../server/factory-build');
const { gpuSfxEnabled, buildSfxRequests, installGeneratedSfx } = require('../server/gpu-audio');
const fixture = require('./fixtures/game-spec.json');

test('GPU SFX 开关和固定事件请求保持真实能力边界', () => {
    assert.equal(gpuSfxEnabled({ FACTORY_GPU_SFX: '1' }), true);
    assert.equal(gpuSfxEnabled({ FACTORY_GPU_SFX: 'false' }), false);
    const requests = buildSfxRequests({ id: 'G private project' }, fixture);
    assert.deepEqual(requests.map(item => item.id), ['collect', 'danger', 'win']);
    assert.ok(requests.every(item => item.request.backend === 'sfx' && /no music, no speech/.test(item.request.prompt)));
    assert.ok(requests.every(item => /^[a-z0-9_-]+$/.test(item.request.project_id)));
});

test('GPU SFX 全部校验后才原子安装，并保留程序配乐', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-sfx-integration-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const sourceDir = path.join(dir, 'source'), gameDir = path.join(dir, 'game');
    writeAudio(sourceDir, fixture);
    writeAudio(gameDir, fixture, { effects: false });
    const items = ['collect', 'danger', 'win'].map(id => {
        const jobDir = path.join(sourceDir, id, 'job'); fs.mkdirSync(jobDir, { recursive: true });
        const source = path.join(sourceDir, 'assets', `${id}.wav`), target = path.join(jobDir, `${id}-01.wav`);
        fs.copyFileSync(source, target);
        const output = { file: path.basename(target), sha256: digest(fs.readFileSync(target)), sample_rate: 22050, channels: 1, duration: 1, source_peak: .5, source_rms: .1 };
        const manifestPath = path.join(jobDir, 'manifest.json');
        const manifest = { job_id: `job-${id}`, status: 'review', review: 'pending', device: 'cuda:0', model: 'MOSS', model_revision: 'fixed', backend_version: 'test', outputs: [output], manifest: manifestPath };
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
        return { id, manifest, manifestPath };
    });
    const installed = installGeneratedSfx(gameDir, items, sourceDir);
    assert.equal(installed.length, 3);
    assert.ok(fs.existsSync(path.join(gameDir, 'assets', 'music.wav')));
    assert.deepEqual(installed.map(item => item.review_status), ['pending', 'pending', 'pending']);
    assert.equal(digest(fs.readFileSync(path.join(gameDir, 'assets', 'win.wav'))), items[2].manifest.outputs[0].sha256);

    const failedDir = path.join(dir, 'failed-game'); writeAudio(failedDir, fixture, { effects: false });
    items[2].manifest.outputs[0].sha256 = '0'.repeat(64);
    assert.throws(() => installGeneratedSfx(failedDir, items, sourceDir), /哈希校验失败/);
    assert.ok(!fs.existsSync(path.join(failedDir, 'assets', 'collect.wav')));
});
