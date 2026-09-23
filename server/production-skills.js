const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createSkillSnapshot } = require('./utils');

const root = path.join(__dirname, '..', 'production-skills');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'sources.lock.json'), 'utf8'));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
// 上游只作为审阅后的来源存档；不执行上游脚本、不在线拉取新指令。
for (const source of lock.sources) {
    if (hash(fs.readFileSync(path.join(root, source.path))) !== source.sha256) throw new Error(`生产 Skill 来源校验失败：${source.id}`);
}
const upstream = name => `skills-gamedev/${name}/SKILL.md`;
const references = {
    common: [], design: [upstream('game-design')],
    narrative: [upstream('narrative-design'), 'agency-agents/narrative-designer.md'],
    modeling: [upstream('blender-modeling'), upstream('tech-art')],
    character: [upstream('blender-modeling'), upstream('blender-animation')],
    environment: [upstream('level-design'), 'agency-agents/level-designer.md'],
    prop: [upstream('blender-modeling'), upstream('tech-art')],
    animation: [upstream('blender-animation')],
    audio: [upstream('game-audio'), 'agency-agents/game-audio-engineer.md', 'qwen3-tts-cli/SKILL.md', 'moss-soundeffect-v2/README.md', 'moss-soundeffect-v2/MODEL_CARD.md'],
    integration: [upstream('tech-art'), upstream('game-design')],
    qa: [upstream('playtesting'), upstream('tech-art')]
};
const names = { common: '制作通则', modeling: '通用建模', design: '策划与制作拆解', narrative: '剧本与分镜', character: '角色', environment: '场景与关卡', prop: '道具', animation: '骨骼与动画', audio: '音效与音乐', integration: '集成与技术美术', qa: '验收与交付' };
const specs = [
    ['design', [], 'agent', 'AI 按规范编写', ['游戏目标、平台、玩法'], ['GDD、核心循环、资产清单与预算']],
    ['narrative', ['design'], 'agent', 'AI 按规范编写', ['世界观、玩法、人物和场次'], ['剧本、分镜、分支条件和声音事件']],
    ['character', ['narrative'], 'model', 'GPU 静态建模已接入', ['人物设定、参考图、比例与动作需求'], ['角色 GLB、材质、绑定需求']],
    ['environment', ['narrative'], 'model', 'GPU 场景资产建模已接入', ['布局、角色尺度、参考图、主路线'], ['场景模块 GLB、碰撞与镜头说明']],
    ['prop', ['design', 'narrative'], 'model', 'GPU 道具建模已接入', ['用途、尺寸、参考图、交互方式'], ['道具 GLB、枢轴与交互件说明']],
    ['animation', ['character'], 'specification', '工厂含 2D 运行时动画；3D 绑定仍需另行执行', ['角色模型、骨架、引擎与动作清单'], ['骨架、动作状态与事件规格；执行后交付动画']],
    ['audio', ['narrative', 'environment'], 'specification', '2D 完整生产可自动组装 GPU 事件音效；依赖、权重与推理状态须执行 doctor 核实，程序配乐另行标注', ['声源、触发条件、时长、循环与情绪'], ['声音事件表、GPU 请求与来源记录；生成后交付待试听音频']],
    ['integration', ['character', 'environment', 'prop', 'animation', 'audio'], 'external', '工厂可组装 2D 探索游戏；其他引擎另行执行', ['已验收资产、引擎和平台约束'], ['可玩切片、资产映射和性能记录']],
    ['qa', ['integration'], 'human', '需实际试玩和人工验收', ['可玩构建、目标设备、验收用例'], ['问题与复测证据、发布资产清单']]
];
const skills = Object.fromEntries(Object.keys(names).map(key => {
    let content = fs.readFileSync(path.join(root, key, 'SKILL.md'), 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
    // 远程 Agent 只能拿到正文时，也收到完整 GPU 命令与状态边界。
    if (key === 'audio') content += '\n\n' + fs.readFileSync(path.join(root, 'gpu-audio/SKILL.md'), 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
    const sources = references[key].map(id => {
        const source = lock.sources.find(item => item.id === id);
        if (!source) throw new Error(`缺少 Skill 来源：${id}`);
        return { id: source.id, url: source.url, commit: source.commit, sha256: source.sha256, license: source.license };
    });
    return [key, { id: `production-${key}`, name: names[key], version: key === 'audio' ? 5 : key === 'integration' ? 2 : 1, content, sources, production: true }];
}));
const catalogVersion = hash(JSON.stringify(skills));

function stageSkills(stage) {
    if (!specs.some(spec => spec[0] === stage)) throw new Error('未知制作阶段');
    return [skills.common, ...(['character', 'environment', 'prop'].includes(stage) ? [skills.modeling] : []), skills[stage]];
}
function getGuide(stage) {
    const [id, dependencies, execution, capability, inputs, deliverables] = specs.find(spec => spec[0] === stage) || [];
    if (!id) throw new Error('未知制作阶段');
    return { id, name: names[id], dependencies, execution, capability, inputs, deliverables, snapshot: createSkillSnapshot(stageSkills(stage)) };
}
function getCatalog() {
    return { version: catalogVersion, stages: specs.map(([id]) => {
        const { snapshot, ...guide } = getGuide(id);
        return { ...guide, skills: snapshot.entries.map(({ content, ...entry }) => entry) };
    }) };
}
function modelingSkills(kind, plan) {
    if (!['character', 'environment', 'prop'].includes(kind)) throw new Error('未知建模类型');
    if (!plan) return stageSkills(kind);
    const stage = plan.stages.find(item => item.id === kind);
    if (!stage?.snapshot?.entries?.length) throw new Error('制作计划缺少对应的固定 Skill');
    return stage.snapshot.entries;
}

module.exports = { getCatalog, getGuide, modelingSkills, catalogVersion };
