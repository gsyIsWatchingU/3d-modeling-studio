const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-personal-'));
process.env.DB_PATH = path.join(root, 'db.json');
process.env.UPLOAD_DIR = path.join(root, 'uploads');
process.env.MODEL_DIR = path.join(root, 'models');
const { skillDb, settingsDb } = require('../server/db');
const { createSkillSnapshot } = require('../server/utils');
const { compileSkillPlan, validateGeneration } = require('../server/skill-plan');
const block = data => '```modeling\n' + JSON.stringify(data) + '\n```';

test('随机种子 0 可用，非法范围在提交 GPU 前拒绝', () => {
    const { parseSeed } = require('../server/utils');
    assert.equal(parseSeed('0'), 0);
    assert.equal(parseSeed(''), 1234);
    assert.throws(() => parseSeed('-1'), /整数/);
    assert.throws(() => parseSeed('1.5'), /整数/);
    assert.throws(() => parseSeed('4294967296'), /整数/);
});

test('个人 Skill 和每次必用配置互不影响，删除不改变任务快照', () => {
    const skill = skillDb.create({name: '石材', content: block({roughness_floor: 0.55}), owner_id: 1});
    settingsDb.save({default_skill_ids: [skill.id]}, 1);
    assert.equal(skillDb.findById(skill.id, 2), null);
    assert.equal(skillDb.delete(skill.id, 2), false);
    assert.throws(() => settingsDb.save({default_skill_ids: [skill.id]}, 2), /自己的/);
    assert.deepEqual(settingsDb.get(2).default_skill_ids, ['skill-general']);
    const snapshot = createSkillSnapshot([skill]);
    skillDb.delete(skill.id, 1);
    assert.equal(snapshot.entries[0].mandatory, true);
    assert.match(snapshot.entries[0].content, /0.55/);
});

test('固定 Skill 参数优先于本次要求，冲突和未知参数不能静默执行', async () => {
    process.env.SKILL_PLANNER_MODE = 'structured';
    const fixed = {id: 'a', name: '固定', content: block({triangle_budget: 60000})};
    const job = {input: {profile: 'xhs_mobile', prompt: block({triangle_budget: 10000})}, skill_snapshot: createSkillSnapshot([fixed])};
    const plan = await compileSkillPlan(job);
    assert.equal(plan.generation.triangle_budget, 60000);
    assert.equal(plan.sha256.length, 64);
    assert.throws(() => validateGeneration({command: 'delete files'}), /不受支持/);
    assert.throws(() => validateGeneration({paint_views: 100}), /范围/);
    job.skill_snapshot = createSkillSnapshot([fixed, {id: 'b', name: '冲突', content: block({triangle_budget: 20000})}]);
    await assert.rejects(compileSkillPlan(job), /冲突/);
    delete process.env.SKILL_PLANNER_MODE;
});

test('自然语言 Skill 交给解析器并实际产生参数和待验收项', async () => {
    const http = require('http');
    let request;
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            request = JSON.parse(Buffer.concat(chunks));
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({choices: [{message: {content: JSON.stringify({generation: {roughness_floor: 0.6}, material_prompt: 'matte stone, detailed surface', review_requirements: ['链条保持分离']})}}]}));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    process.env.SKILL_PLANNER_URL = `http://127.0.0.1:${server.address().port}`;
    try {
        const plan = await compileSkillPlan({input: {profile: 'xhs_mobile', prompt: '链条保持分离'}, skill_snapshot: createSkillSnapshot([{id: 'stone', name: '哑光', content: '石材使用高粗糙度'}])});
        assert.equal(plan.generation.roughness_floor, 0.6);
        assert.equal(plan.material_prompt, 'matte stone, detailed surface');
        assert.deepEqual(plan.review_requirements, ['链条保持分离']);
        assert.equal(JSON.parse(request.messages[1].content).skills[0].mandatory, true);
    } finally { server.close(); delete process.env.SKILL_PLANNER_URL; }
});
