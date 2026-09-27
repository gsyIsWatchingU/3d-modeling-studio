// 一次性补丁：修复 initDb 迁移永不落盘（normalizeDb 原地改造导致比较恒等）
// 用法：node patch_initdb.cjs
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'server', 'db.js');
let src = fs.readFileSync(file, 'utf8');
const old = `    const current = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    const normalized = normalizeDb(current);
    if (JSON.stringify(current) !== JSON.stringify(normalized)) writeDb(normalized);`;
const next = `    const current = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    // normalizeDb 原地改造 raw 对象，必须先克隆再比较，否则恒等导致回填永不落盘
    const before = JSON.parse(JSON.stringify(current));
    const normalized = normalizeDb(current);
    if (JSON.stringify(before) !== JSON.stringify(normalized)) writeDb(normalized);`;
if (!src.includes(old)) {
    console.error('PATCH FAILED: target block not found');
    process.exit(1);
}
src = src.replace(old, next);
fs.writeFileSync(file, src, 'utf8');
console.log('patched initDb');
