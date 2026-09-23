const { z } = require('zod');
const text = (max = 300) => z.string().trim().min(1).max(max);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const point = { x: z.number().int().min(1).max(18), y: z.number().int().min(1).max(10) };
const GameSpec = z.object({
    title: text(60), tagline: text(140), story: text(2500), goal: text(240), ending: text(600),
    palette: z.object({ background: color, floor: color, wall: color, accent: color }),
    player: z.object({ name: text(50), description: text(500), color, shape: z.enum(['circle', 'robot', 'hood']) }),
    collectible: z.object({ name: text(40), description: text(240), color }),
    rules: z.object({ lives: z.number().int().min(1).max(9), speed: z.number().min(2).max(6) }),
    levels: z.array(z.object({
        id: z.string().regex(/^L[1-9][0-9]?$/), name: text(60), description: text(500), intro: text(600),
        background: color,
        spawn: z.object(point), exit: z.object(point),
        walls: z.array(z.object(point)).max(70),
        items: z.array(z.object(point)).min(1).max(12),
        hazards: z.array(z.object({ ...point, axis: z.enum(['x', 'y']), range: z.number().int().min(0).max(3) })).max(8),
        npc: z.object({ ...point, name: text(40), dialogue: text(700), choices: z.array(z.object({ label: text(50), response: text(300) })).min(1).max(3) })
    })).min(1).max(5),
    audio: z.object({ mood: text(200), collect_hz: z.number().int().min(220).max(1200), danger_hz: z.number().int().min(60).max(400), win_hz: z.number().int().min(330).max(1200) })
}).strict();

function validateGame(value) {
    const spec = GameSpec.parse(value);
    if (new Set(spec.levels.map(l => l.id)).size !== spec.levels.length) throw new Error('关卡 ID 重复');
    const key = p => `${p.x},${p.y}`;
    for (const level of spec.levels) {
        const walls = new Set(level.walls.map(key));
        const nodes = [level.spawn, level.exit, level.npc, ...level.items];
        if (new Set(nodes.map(key)).size !== nodes.length || nodes.some(p => walls.has(key(p)))) throw new Error(`${level.id}：出生点、出口、NPC 或道具重叠`);
        const seen = new Set([key(level.spawn)]), queue = [level.spawn];
        for (let i = 0; i < queue.length; i++) {
            const p = queue[i];
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const n = { x: p.x + dx, y: p.y + dy }, k = key(n);
                if (n.x < 1 || n.x > 18 || n.y < 1 || n.y > 10 || walls.has(k) || seen.has(k)) continue;
                seen.add(k); queue.push(n);
            }
        }
        if (nodes.some(p => !seen.has(key(p)))) throw new Error(`${level.id}：存在无法抵达的出口或任务点`);
        for (const h of level.hazards) {
            const steps = Array.from({ length: h.range * 2 + 1 }, (_, i) => ({ x: h.x + (h.axis === 'x' ? i - h.range : 0), y: h.y + (h.axis === 'y' ? i - h.range : 0) }));
            if (steps.some(p => p.x < 1 || p.x > 18 || p.y < 1 || p.y > 10 || walls.has(key(p)))) throw new Error(`${level.id}：危险物路径越界或穿墙`);
            if (steps.some(p => key(p) === key(level.spawn))) throw new Error(`${level.id}：危险物覆盖出生点`);
        }
    }
    return spec;
}

const schemaDescription = `仅输出 JSON，不要代码块。完整结构如下：
{"title":"游戏标题","tagline":"一句话介绍","story":"完整故事提案","goal":"玩家目标","ending":"结局文本",
"palette":{"background":"#142332","floor":"#243846","wall":"#486171","accent":"#f3c778"},
"player":{"name":"角色名","description":"角色设定","color":"#f3c778","shape":"hood"},
"collectible":{"name":"收集物","description":"用途","color":"#84dcc6"},"rules":{"lives":3,"speed":3.5},
"levels":[{"id":"L1","name":"关卡名","description":"场景设定","intro":"开场剧本","background":"#142332",
"spawn":{"x":2,"y":5},"exit":{"x":17,"y":5},"walls":[{"x":9,"y":3}],
"items":[{"x":5,"y":3},{"x":12,"y":8}],"hazards":[{"x":10,"y":6,"axis":"x","range":2}],
"npc":{"x":6,"y":7,"name":"人物名","dialogue":"对话","choices":[{"label":"问路","response":"提示"}]}}],
"audio":{"mood":"音景设计","collect_hz":660,"danger_hz":110,"win_hz":880}}
画布是20x12格，边界不能用，坐标必须为整数 x=1..18,y=1..10。1..5关，一般3关；每关1..12收集物，0..8危险物，0..70墙。出生点、出口、NPC、收集物不得重叠或在墙中，所有任务点必须互相可达。危险物沿axis移动range(0..3)格，整条路径不得越界、穿墙或覆盖出生点。玩家形状只支持circle/robot/hood。颜色只能#RRGGBB。ID为L1/L2等且唯一。
这是俯视探索收集游戏：移动、碰撞、收集全部道具、接近NPC并选择对白、躲避危险、打开出口进入下一关，最后胜利；支持键盘与触屏、暂停、失败重试。对话仅提供故事或提示，不影响胜负，禁止写必须选择正确对话才能过关；唯一过关条件是收集本关全部道具后进入出口。本引擎不支持战斗、平台跳跃、联网、任意代码或3D场景。必须根据用户目标在此能力内设计，不得声称实现其他机制。难度循序增加，提示准确可执行。没有外部URL、HTML、JavaScript或命令。`;
module.exports = { validateGame, schemaDescription };
