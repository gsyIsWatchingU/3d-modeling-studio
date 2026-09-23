const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const fixture = require('./fixtures/game-spec.json');

function game(spec) {
    const nodes = new Map(), handlers = {}, buttons = [], draw = new Proxy({}, { get: () => () => {}, set: () => true });
    function node() { return { textContent: '', hidden: false, children: [], append(n) { this.children.push(n); }, replaceChildren() { this.children = []; }, focus() {}, getContext: () => draw, setPointerCapture() {} }; }
    const get = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
    let frame, time = 1000;
    const sandbox = { window: { GAME_SPEC: spec, addEventListener: (name, fn) => handlers[name] = fn }, document: { getElementById: get, querySelectorAll: () => buttons, createElement: node }, Image: class {}, Audio: class { play() { return Promise.resolve(); } pause() {} }, requestAnimationFrame: fn => frame = fn, Math, Set };
    vm.runInNewContext(fs.readFileSync(require.resolve('../public/game-runtime.js'), 'utf8'), sandbox);
    const advance = frames => { for (let i = 0; i < frames; i++) { time += 16; frame(time); } };
    const key = (key, frames) => { handlers.keydown({ key, preventDefault() {}, target: { tagName: 'CANVAS' } }); advance(frames); handlers.keyup({ key }); };
    return { get, advance, key, click: label => { const b = get('actions').children.find(b => b.textContent === label); assert.ok(b, label); b.onclick(); } };
}
test('探索引擎实际状态：收集、过关、胜利、重开、暂停与恢复', () => {
    const spec = structuredClone(fixture); spec.levels[0].hazards = []; spec.levels.push({ ...structuredClone(spec.levels[0]), id: 'L2' });
    const g = game(spec); g.click('开始游戏'); g.advance(2);
    assert.match(g.get('status').textContent, /光晶 0\/2/);
    g.key('ArrowRight', 300); assert.equal(g.get('heading').textContent, '通路已打开');
    g.click('进入下一关'); g.key('ArrowRight', 300); assert.equal(g.get('heading').textContent, '旅程完成');
    g.click('再玩一次'); g.advance(2); assert.match(g.get('status').textContent, /光晶 0\/2/);
    g.get('pause').onclick(); assert.equal(g.get('heading').textContent, '已暂停');
    const before = g.get('status').textContent; g.key('ArrowRight', 60); assert.equal(g.get('status').textContent, before);
    g.click('继续游戏'); g.key('ArrowRight', 50); assert.match(g.get('status').textContent, /光晶 1\/2/);
});
test('接近 NPC 后选择对白并恢复移动', () => {
    const g = game(structuredClone(fixture)); g.click('开始游戏'); g.key('ArrowRight', 70); g.key('ArrowDown', 36); g.key('e', 1);
    assert.equal(g.get('heading').textContent, '修灯师'); g.click('光晶在哪？'); assert.match(g.get('description').textContent, /主路/);
    g.click('继续探索'); assert.equal(g.get('overlay').hidden, true);
});
test('危险物扣除生命、失败重试；墙阻挡移动', () => {
    const spec = structuredClone(fixture); spec.rules.lives = 1; spec.levels[0].hazards = [{ x: 5, y: 5, axis: 'x', range: 0 }];
    const g = game(spec); g.click('开始游戏'); g.advance(100); g.key('ArrowRight', 90);
    assert.equal(g.get('heading').textContent, '再试一次'); g.click('重新开始'); g.advance(1); assert.match(g.get('status').textContent, /生命 1/);
    const wallSpec = structuredClone(fixture); wallSpec.levels[0].walls = [{ x: 3, y: 5 }];
    const blocked = game(wallSpec); blocked.click('开始游戏'); blocked.key('ArrowRight', 200); assert.match(blocked.get('status').textContent, /光晶 0\/2/);
});
