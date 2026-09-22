// 安装自包含的全局 Skill 副本；不覆盖已有目录。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const source = path.resolve(__dirname, '../production-skills');
const destination = path.resolve(process.argv[2] || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills', 'game-production-workflow'));
if (fs.existsSync(destination)) throw new Error(`目标已存在，请先审查已有版本：${destination}`);
fs.mkdirSync(destination, { recursive: true });
fs.copyFileSync(path.join(source, 'agent/SKILL.md'), path.join(destination, 'SKILL.md'));
const refs = path.join(destination, 'references');
fs.mkdirSync(refs);
for (const entry of fs.readdirSync(source)) {
    if (entry === 'agent') continue;
    fs.cpSync(path.join(source, entry), path.join(refs, entry), { recursive: true });
}
console.log(`已安装：${destination}`);
