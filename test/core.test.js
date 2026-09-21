const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modeling-studio-test-'));
process.env.DB_PATH = path.join(tempRoot, 'db.json');
process.env.UPLOAD_DIR = path.join(tempRoot, 'uploads');
process.env.MODEL_DIR = path.join(tempRoot, 'models');

const { detectImageType, parseSkillDocument, createSkillSnapshot, buildProviderPrompt, validateGlbBuffer } = require('../server/utils');
const { skillDb, settingsDb, jobDb, notificationDb } = require('../server/db');
const { createReferenceBoard } = require('../server/image-board');
const sharp = require('sharp');

test('识别允许的图片文件头，拒绝伪造内容', () => {
    assert.equal(detectImageType(Buffer.from([0xff, 0xd8, 0xff]))?.mime, 'image/jpeg');
    assert.equal(detectImageType(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))?.mime, 'image/png');
    assert.equal(detectImageType(Buffer.from('not-an-image')), null);
});

test('读取 SKILL.md 元数据并生成不可变快照', () => {
    const parsed = parseSkillDocument('---\nname: 鞋类优化\ndescription: 保持鞋底结构\n---\n鞋底必须闭合。');
    assert.equal(parsed.name, '鞋类优化');
    assert.equal(parsed.content, '鞋底必须闭合。');
    const snapshot = createSkillSnapshot({ id: 'base', name: '默认', version: 2, content: '完整主体。' }, [{ id: 'shoe', ...parsed, version: 1 }], '本次保留鞋带。');
    assert.equal(snapshot.entries.length, 3);
    assert.equal(snapshot.sha256.length, 64);
    assert.match(buildProviderPrompt(snapshot, '白色材质。'), /白色材质/);
});

test('校验 GLB 2.0 文件头与声明长度', () => {
    const glb = Buffer.alloc(12);
    glb.write('glTF', 0, 'ascii');
    glb.writeUInt32LE(2, 4);
    glb.writeUInt32LE(12, 8);
    assert.equal(validateGlbBuffer(glb).length, 12);
    const invalid = Buffer.from(glb);
    invalid.writeUInt32LE(99, 8);
    assert.throws(() => validateGlbBuffer(invalid), /长度校验失败/);
});

test('数据层兼容旧库并持久化 Skill、任务和通知幂等键', () => {
    const skills = skillDb.list();
    assert.ok(skills.some(skill => skill.id === 'skill-general'));
    const custom = skillDb.create({ name: '道具强化', content: '保持硬表面。' });
    settingsDb.save({ default_skill_ids: ['skill-general', custom.id], default_skill_id: 'skill-general' });
    assert.ok(settingsDb.get().default_skill_ids.includes(custom.id));
    const job = jobDb.create({ name: '测试模型', input: { images: ['a.png'], prompt: '', asset_kind: 'prop', profile: 'xhs_mobile' }, skill_snapshot: createSkillSnapshot(custom), requested_channels: ['feishu'] });
    assert.equal(job.status, 'queued');
    assert.equal(jobDb.claimNext().status, 'generating');
    const first = notificationDb.enqueue({ job_id: job.id, event: 'model.succeeded', channel: 'feishu', idempotency_key: `${job.id}:model.succeeded:feishu` });
    const second = notificationDb.enqueue({ job_id: job.id, event: 'model.succeeded', channel: 'feishu', idempotency_key: `${job.id}:model.succeeded:feishu` });
    assert.equal(first.id, second.id);
});

test('多张图片会合成为一张多视角参考板', async () => {
    const first = path.join(tempRoot, 'one.png');
    const second = path.join(tempRoot, 'two.png');
    const output = path.join(tempRoot, 'board.png');
    await sharp({ create: { width: 80, height: 120, channels: 3, background: '#ff0000' } }).png().toFile(first);
    await sharp({ create: { width: 120, height: 80, channels: 3, background: '#0000ff' } }).png().toFile(second);
    await createReferenceBoard([first, second], output);
    const metadata = await sharp(output).metadata();
    assert.equal(metadata.width, 1072);
    assert.equal(metadata.height, 544);
});
