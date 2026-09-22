const crypto = require('crypto');

const IMAGE_TYPES = [
    { mime: 'image/png', ext: '.png', test: buffer => buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
    { mime: 'image/jpeg', ext: '.jpg', test: buffer => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff },
    { mime: 'image/webp', ext: '.webp', test: buffer => buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' }
];

function detectImageType(buffer) {
    return IMAGE_TYPES.find(type => type.test(buffer)) || null;
}

function hashText(value) {
    return crypto.createHash('sha256').update(value || '', 'utf8').digest('hex');
}

function parseSeed(value) {
    if (value === undefined || value === null || value === '') return 1234;
    const seed = Number(value);
    if (!Number.isInteger(seed) || seed < 0 || seed > 2 ** 32 - 1) throw new Error('随机种子必须为 0～4294967295 的整数');
    return seed;
}

function parseSkillDocument(text, fallbackName = '自定义 Skill') {
    const normalized = String(text || '').replace(/^\uFEFF/, '').trim();
    if (!normalized) throw new Error('Skill 内容不能为空');
    let name = fallbackName;
    let description = '';
    let content = normalized;
    const match = normalized.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
    if (match) {
        const frontmatter = match[1];
        name = frontmatter.match(/^name:\s*(.+)$/mi)?.[1]?.trim().replace(/^['"]|['"]$/g, '') || name;
        description = frontmatter.match(/^description:\s*(.+)$/mi)?.[1]?.trim().replace(/^['"]|['"]$/g, '') || '';
        content = normalized.slice(match[0].length).trim();
    }
    if (!content) throw new Error('Skill 正文不能为空');
    return { name: name.slice(0, 60), description: description.slice(0, 160), content };
}

function createSkillSnapshot(defaultSkill, extraSkills = [], inlineSkill = '') {
    const entries = [];
    const defaults = Array.isArray(defaultSkill) ? defaultSkill : [defaultSkill].filter(Boolean);
    entries.push(...defaults);
    for (const skill of extraSkills) {
        if (skill && !entries.some(item => item.id === skill.id)) entries.push(skill);
    }
    const snapshots = entries.map(skill => ({
        id: skill.id,
        name: skill.name,
        version: skill.version || 1,
        mandatory: defaults.some(item => item.id === skill.id),
        content: skill.content,
        sha256: hashText(skill.content)
    }));
    const inline = String(inlineSkill || '').trim();
    if (inline) snapshots.push({ id: null, name: '本次临时要求', version: 1, content: inline, sha256: hashText(inline), temporary: true });
    const mergedContent = snapshots.map(item => `【${item.name}】\n${item.content}`).join('\n\n');
    return { entries: snapshots, merged_content: mergedContent, sha256: hashText(mergedContent) };
}

function buildProviderPrompt(skillSnapshot, userPrompt) {
    const parts = [];
    if (skillSnapshot?.merged_content) parts.push(skillSnapshot.merged_content);
    if (String(userPrompt || '').trim()) parts.push(`【本次建模要求】\n${String(userPrompt).trim()}`);
    return parts.join('\n\n');
}

function validateGlbBuffer(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) throw new Error('模型文件过小，不是有效 GLB');
    if (buffer.toString('ascii', 0, 4) !== 'glTF') throw new Error('模型文件缺少 GLB 标识');
    const version = buffer.readUInt32LE(4);
    const declaredLength = buffer.readUInt32LE(8);
    if (version !== 2) throw new Error(`仅支持 GLB 2.0，当前版本为 ${version}`);
    if (declaredLength !== buffer.length) throw new Error('GLB 文件长度校验失败');
    return { version, length: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
}

function safeStringList(value, allowlist) {
    let parsed = value;
    if (typeof value === 'string') {
        try { parsed = JSON.parse(value); } catch { parsed = [value]; }
    }
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter(item => typeof item === 'string' && (!allowlist || allowlist.includes(item))))];
}

function publicSkillSnapshot(snapshot) {
    if (!snapshot) return null;
    return {
        entries: (snapshot.entries || []).map(item => ({ id: item.id, name: item.name, version: item.version, sha256: item.sha256, mandatory: Boolean(item.mandatory), temporary: Boolean(item.temporary) })),
        sha256: snapshot.sha256
    };
}

function publicJob(job, deliveries = []) {
    if (!job) return null;
    return {
        ...job,
        skill_snapshot: publicSkillSnapshot(job.skill_snapshot),
        notifications: deliveries.map(item => ({ channel: item.channel, status: item.status, attempts: item.attempts, last_error: item.last_error }))
    };
}

module.exports = {
    parseSeed,
    detectImageType,
    hashText,
    parseSkillDocument,
    createSkillSnapshot,
    buildProviderPrompt,
    validateGlbBuffer,
    safeStringList,
    publicJob
};
