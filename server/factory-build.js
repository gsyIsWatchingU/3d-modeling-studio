const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { zipSync } = require('fflate');
const { validateGame } = require('./factory-spec');
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function atomicFile(filename, value) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(`${filename}.tmp`, value); fs.renameSync(`${filename}.tmp`, filename);
}
function wav(frequencies, seconds = .3) {
    const rate = 22050, length = Math.round(rate * seconds), data = Buffer.alloc(44 + length * 2);
    data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
    data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28);
    data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(length * 2, 40);
    const noteLength = seconds / frequencies.length;
    for (let i = 0; i < length; i++) {
        const t = i / rate, note = Math.min(frequencies.length - 1, Math.floor(t / noteLength)), local = t % noteLength;
        const envelope = Math.min(1, local / .015) * Math.min(1, (noteLength - local) / .06);
        const sample = (Math.sin(2 * Math.PI * frequencies[note] * t) + .15 * Math.sin(4 * Math.PI * frequencies[note] * t)) * envelope * .32;
        data.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
    }
    return data;
}
function artwork(spec) {
    const avatar = (color, shape) => `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><g stroke="#15242f" stroke-width="4">${shape === 'circle' ? `<circle cx="48" cy="48" r="34" fill="${color}"/>` : shape === 'robot' ? `<rect x="17" y="16" width="62" height="68" rx="13" fill="${color}"/><path d="M48 16V5"/>` : `<path d="M12 85L19 33Q48 -11 77 33L84 85Z" fill="${color}"/>`}<rect x="26" y="32" width="44" height="27" rx="12" fill="#243646"/><path d="M36 42v7m24-7v7" stroke="#fff" stroke-width="5"/><path d="M30 79v11m36-11v11" stroke-width="9"/></g></svg>`;
    return {
        'player.svg': avatar(spec.player.color, spec.player.shape),
        'npc.svg': avatar(spec.palette.accent, 'robot'),
        'item.svg': `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><path d="M48 6L82 34L70 75L48 91L26 75L14 34Z" fill="${spec.collectible.color}" stroke="#18373a" stroke-width="4"/><path d="M48 6L34 36L48 91L62 36ZM14 34H82" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="3"/></svg>`
    };
}
function gameHtml(spec) {
    const json = JSON.stringify(spec).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(spec.title)}</title>
<style>*{box-sizing:border-box}body{margin:0;background:#101b27;color:#eef4f2;font:15px system-ui,sans-serif}main{max-width:1000px;margin:auto;padding:16px}header{display:flex;align-items:center;justify-content:space-between;gap:12px}h1{font-size:22px;margin:0}p{line-height:1.6}button{background:#d5ecc8;color:#18332b;border:0;padding:12px 18px;border-radius:8px;font:inherit;cursor:pointer}button:disabled{opacity:.5}button:focus-visible,canvas:focus-visible{outline:3px solid #facf73}.stage{position:relative}canvas{width:100%;display:block;border-radius:12px;background:#182e3c}#overlay{position:absolute;inset:0;display:grid;place-items:center;background:#0b182acc;border-radius:12px;padding:12px}#overlay[hidden]{display:none}.card{width:min(540px,100%);padding:24px;background:#1b3040;border:1px solid #617680;border-radius:16px;max-height:100%;overflow:auto}#description{white-space:pre-wrap}#actions{display:flex;gap:10px;flex-wrap:wrap}.controls{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;padding:12px}button[data-key]{touch-action:none;user-select:none;min-width:52px}#status{color:#c3dacb;min-height:24px}#message{color:#b5c7d1;min-height:44px}@media(max-width:600px){main{padding:8px}.card{padding:12px}h1{font-size:18px}button{padding:10px}header{flex-wrap:wrap}.stage{min-height:310px}canvas{height:310px;object-fit:contain}#overlay{font-size:13px}}</style>
<main><header><h1 id="title"></h1><div><button id="sound">声音：开</button> <button id="pause">暂停</button></div></header><p id="goal"></p><p id="status" role="status"></p><div class="stage"><canvas id="game" tabindex="0" aria-label="探索游戏，方向键移动，E对话"></canvas><div id="overlay"><div class="card"><h2 id="heading"></h2><p id="description"></p><div id="actions"></div></div></div></div><div class="controls"><button data-key="ArrowLeft" aria-label="向左">←</button><button data-key="ArrowUp" aria-label="向上">↑</button><button data-key="ArrowDown" aria-label="向下">↓</button><button data-key="ArrowRight" aria-label="向右">→</button><button id="interact">对话 E</button></div><p id="message"></p></main><script>window.GAME_SPEC=${json};</script><script src="runtime.js"></script></html>`;
}
function writeArt(dir, spec) { for (const [name, svg] of Object.entries(artwork(spec))) atomicFile(path.join(dir, 'assets', name), svg); }
function writeAudio(dir, spec) {
    const a = spec.audio;
    for (const [name, freqs, duration] of [['collect', [a.collect_hz, a.collect_hz * 1.5], .22], ['danger', [a.danger_hz, a.danger_hz * .7], .35], ['win', [a.win_hz, a.win_hz * 1.25, a.win_hz * 1.5], .7], ['music', [220, 261.63, 329.63, 293.66, 220, 293.66, 329.63, 261.63], 8]]) atomicFile(path.join(dir, 'assets', `${name}.wav`), wav(freqs, duration));
}
function buildGame(dir, spec) {
    validateGame(spec);
    atomicFile(path.join(dir, 'index.html'), gameHtml(spec));
    atomicFile(path.join(dir, 'runtime.js'), fs.readFileSync(path.join(__dirname, '../public/game-runtime.js')));
}
function inventory(dir) {
    const result = [];
    const walk = (folder, prefix = '') => {
        for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
            if (entry.isSymbolicLink()) throw new Error('产物目录禁止符号链接');
            const relative = prefix + entry.name;
            if (entry.isDirectory()) walk(path.join(folder, entry.name), relative + '/');
            else if (!entry.name.endsWith('.tmp')) { const bytes = fs.readFileSync(path.join(folder, entry.name)); result.push({ path: relative, bytes: bytes.length, sha256: digest(bytes) }); }
        }
    };
    walk(dir); return result;
}
function audit(dir, spec) {
    validateGame(spec);
    const files = inventory(dir);
    const required = ['index.html', 'runtime.js', 'game.json', 'assets/player.svg', 'assets/npc.svg', 'assets/item.svg', 'assets/collect.wav', 'assets/danger.wav', 'assets/win.wav', 'assets/music.wav', 'animation.json'];
    for (const file of required) if (!files.some(f => f.path === file && f.bytes > 0)) throw new Error(`缺少交付文件：${file}`);
    for (const file of files.filter(f => f.path.endsWith('.wav'))) { const b = fs.readFileSync(path.join(dir, file.path)); if (b.toString('ascii', 0, 4) !== 'RIFF' || b.readUInt32LE(40) !== b.length - 44) throw new Error('音频文件校验失败'); }
    return { automated: 'passed', checks: ['游戏结构与参数', '关卡任务点可达性', '碰撞与危险物路径', '文件完整性与 SHA-256', 'WAV 格式与数据长度'], human: 'pending', unverified: ['实际设备性能', '美术与声音质量', '游玩体验与难度'], files };
}
function exportZip(dir, project, run) {
    const files = inventory(dir), contents = {};
    for (const file of files) contents[file.path] = fs.readFileSync(path.join(dir, file.path));
    contents['rebuild.cjs'] = Buffer.from(`const fs = require('node:fs');\nconst spec = JSON.parse(fs.readFileSync('game.json', 'utf8'));\nconst json = JSON.stringify(spec).replace(/</g, '\\\\u003c');\nconst html = fs.readFileSync('index.html', 'utf8').replace(/window\\.GAME_SPEC=[\\s\\S]*?;<\\/script>/, () => 'window.GAME_SPEC=' + json + ';</script>');\nfs.writeFileSync('index.html', html);\nconsole.log('已将 game.json 更新到 index.html');\n`);
    contents['README.md'] = Buffer.from(`# ${project.name}\n\n解压后双击 index.html 即可离线游玩。上传全部文件到静态托管可发布。\n\n- 方向键/WASD 移动，E 对话，Esc 暂停；支持触屏按钮。\n- game.json 是可编辑数据；修改后须同步 index.html 的 GAME_SPEC 数据。runtime.js 是完整引擎源代码。\n- docs/ 保存策划、剧本、角色场景与制作规范来源。assets/ 为矢量素材和程序合成 WAV。\n- 此版本：${run.id}；审核：${run.review?.status || 'pending'}。自动校验不代表人工试玩通过。\n- 内置素材由本平台程序生成，不包含第三方素材；模型生成的故事与设计仍需自行审查权利及质量。\n- 引擎支持俯视探索收集、危险物、NPC 对话、多关卡；不含联网、3D 战斗或真人配音。\n`);
    contents['README.md'] = Buffer.from(contents['README.md'].toString().replace('修改后须同步 index.html 的 GAME_SPEC 数据', '修改后在工程目录运行 node rebuild.cjs 更新试玩页面（需 Node.js 20+）'));
    contents['manifest.json'] = Buffer.from(JSON.stringify({ project_id: project.id, run_id: run.id, review: run.review, skill_version: project.catalog_version, files }, null, 2));
    return Buffer.from(zipSync(contents, { level: 6 }));
}
module.exports = { atomicFile, writeArt, writeAudio, buildGame, audit, inventory, exportZip, digest };
