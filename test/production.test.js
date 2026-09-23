const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-production-'));
process.env.DB_PATH = path.join(root, 'db.json');
process.env.UPLOAD_DIR = path.join(root, 'uploads');
process.env.MODEL_DIR = path.join(root, 'models');
const { getCatalog, getGuide, modelingSkills } = require('../server/production-skills');
const { productionPlanDb } = require('../server/db');
const { createSkillSnapshot } = require('../server/utils');

test('音频规范携带 GPU 操作正文与固定上游来源，不将安装误报为推理成功', () => {
    const guide = getGuide('audio');
    const skill = guide.snapshot.entries.find(entry => entry.id === 'production-audio');
    assert.equal(skill.version, 5);
    assert.match(skill.content, /audio_factory\.py doctor/);
    assert.match(skill.content, /不代表模型可用/);
    assert.ok(skill.sources.some(source => source.id === 'qwen3-tts-cli/SKILL.md' && source.license === 'Apache-2.0'));
    assert.ok(skill.sources.some(source => source.id === 'moss-soundeffect-v2/MODEL_CARD.md' && source.license === 'Apache-2.0'));
});

test('生产流按依赖顺序执行，并保留独立音频与动画规范', () => {
    const catalog = getCatalog();
    const visited = new Set();
    for (const stage of catalog.stages) {
        for (const dependency of stage.dependencies) assert.ok(visited.has(dependency), `${stage.id} 缺少前置阶段 ${dependency}`);
        visited.add(stage.id);
        assert.ok(stage.inputs.length && stage.deliverables.length);
    }
    assert.equal(catalog.stages.find(stage => stage.id === 'audio').execution, 'specification');
    assert.equal(catalog.stages.find(stage => stage.id === 'animation').execution, 'specification');
    assert.throws(() => getGuide('unknown'), /未知/);
});

test('角色、场景、道具只带对应规范，快照有来源而非仅路径', () => {
    for (const kind of ['character', 'environment', 'prop']) {
        const snapshot = createSkillSnapshot(modelingSkills(kind));
        assert.equal(snapshot.entries.length, 3);
        assert.ok(snapshot.entries.every(entry => entry.mandatory && entry.content.length > 100));
        assert.ok(snapshot.entries.find(entry => entry.id === `production-${kind}`));
        assert.ok(!snapshot.entries.find(entry => entry.id === 'production-audio'));
        assert.ok(snapshot.entries.flatMap(entry => entry.sources).every(source => source.sha256.length === 64 && source.license === 'MIT'));
    }
});

test('制作计划按账号隔离并冻结完整规范，读出内容变化不会污染持久化快照', () => {
    const plan = productionPlanDb.create({ name: '计划', brief: '测试', stages: getCatalog().stages.map(stage => getGuide(stage.id)) }, 1);
    const oldHash = plan.stages.find(stage => stage.id === 'character').snapshot.sha256;
    plan.stages.find(stage => stage.id === 'character').snapshot.entries[0].content = '外部修改';
    const stored = productionPlanDb.findById(plan.id, 1);
    assert.notEqual(stored.stages.find(stage => stage.id === 'character').snapshot.entries[0].content, '外部修改');
    assert.equal(createSkillSnapshot(modelingSkills('character', stored)).sha256, oldHash);
    assert.equal(productionPlanDb.findById(plan.id, 2), null);
    assert.equal(productionPlanDb.list(2).length, 0);
    const guide = getGuide('character');
    guide.snapshot.entries[0].content = '新规范';
    assert.equal(productionPlanDb.findById(plan.id, 1).stages.find(stage => stage.id === 'character').snapshot.sha256, oldHash);
});
