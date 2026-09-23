const workflowStages = [
    {
        id: 'design', name: '策划与玩法', number: '01', action: 'generate', capability: 'connected',
        description: '生成核心循环、规则、平台预算与首个可玩切片。', depends_on: []
    },
    {
        id: 'narrative', name: '剧本与分镜', number: '02', action: 'generate', capability: 'connected',
        description: '生成世界观、角色、场景、对白、事件和分镜提案。', depends_on: ['design']
    },
    {
        id: 'concept', name: '预览图设计', number: '03', action: 'generate_upload', capability: 'brief-and-upload',
        description: '先生成可执行的美术制作单，再上传实际角色、场景或道具预览图。', depends_on: ['narrative']
    },
    {
        id: 'modeling', name: '3D 游戏建模', number: '04', action: 'modeling', capability: 'connected',
        description: '把已确认的参考图交给 Forge3D，生成独立 GLB 资产。', depends_on: ['concept']
    },
    {
        id: 'animation_audio', name: '动画与声音', number: '05', action: 'full_production', capability: 'partial',
        description: '完整生产含运行时动画和程序声音；骨骼动画与 GPU 音频仍需独立接入。', depends_on: ['modeling']
    },
    {
        id: 'integration', name: '游戏集成', number: '06', action: 'full_production', capability: 'connected',
        description: '使用当前 2D 探索引擎组装交互、关卡、UI、声音与可玩工程。', depends_on: ['design', 'narrative']
    },
    {
        id: 'qa', name: '试玩与发布', number: '07', action: 'review', capability: 'connected',
        description: '自动检查后由用户实际试玩、记录问题、批准并按需发布。', depends_on: ['integration']
    }
];

const generatedStageIds = new Set(['design', 'narrative', 'concept']);
const byId = new Map(workflowStages.map(stage => [stage.id, stage]));

function stageDefinition(id) { return byId.get(id) || null; }
function publicWorkflowStages() { return workflowStages.map(stage => ({ ...stage, depends_on: [...stage.depends_on] })); }

module.exports = { generatedStageIds, publicWorkflowStages, stageDefinition, workflowStages };
