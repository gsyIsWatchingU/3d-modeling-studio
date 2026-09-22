const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modeling-studio-auth-test-'));
process.env.DB_PATH = path.join(tempRoot, 'db.json');
process.env.UPLOAD_DIR = path.join(tempRoot, 'uploads');
process.env.MODEL_DIR = path.join(tempRoot, 'models');

const { userDb, sessionDb, apiTokenDb } = require('../server/db');

test('统一账号 upsert：首次插入，重复登录按 ssoSubject 关联同一行', () => {
    const first = userDb.upsertSsoUser({ id: 'sso-user-1', email: 'Tester@Example.com', name: '测试用户' });
    assert.ok(first.id >= 1);
    assert.equal(first.email, 'Tester@Example.com');
    assert.equal(first.ssoSubject, 'sso-user-1');
    assert.equal(first.displayName, '测试用户');
    // 本地永远不存真实密码：password 是占位符，且不含邮箱/账号中心 id
    assert.match(first.password, /^sso:/);
    assert.ok(!first.password.includes('Tester'));
    assert.ok(!first.password.includes('sso-user-1'));

    const again = userDb.upsertSsoUser({ id: 'sso-user-1', email: 'tester@example.com', name: '测试用户' });
    assert.equal(again.id, first.id);
    assert.equal(again.email, 'tester@example.com');
});

test('本地会话：创建 → 校验 → 过期/删除后失效', () => {
    const user = userDb.upsertSsoUser({ id: 'sso-user-2', email: 'session@example.com' });
    const token = sessionDb.create(user.id);
    assert.equal(token.length, 43); // base64url(32 bytes)
    const found = sessionDb.findByToken(token);
    assert.equal(found.user.id, user.id);
    assert.equal(found.user.email, 'session@example.com');
    assert.equal(sessionDb.findByToken('not-a-token'), null);
    sessionDb.deleteByToken(token);
    assert.equal(sessionDb.findByToken(token), null);
});

test('MCP 凭证保存摘要，过期和撤销后立即失效', () => {
    const user = userDb.upsertSsoUser({ id: 'mcp-token-user', email: 'mcp@example.com' });
    const issued = apiTokenDb.create(user.id, '测试客户端');
    assert.equal(apiTokenDb.authenticate(issued.token).id, user.id);
    assert.ok(!fs.readFileSync(process.env.DB_PATH, 'utf8').includes(issued.token));
    assert.equal(apiTokenDb.revoke(issued.id, user.id + 1), false);
    const db = JSON.parse(fs.readFileSync(process.env.DB_PATH, 'utf8'));
    db.api_tokens.find(item => item.id === issued.id).expires_at = '2000-01-01T00:00:00.000Z';
    fs.writeFileSync(process.env.DB_PATH, JSON.stringify(db));
    assert.equal(apiTokenDb.authenticate(issued.token), null);
    assert.equal(apiTokenDb.revoke(issued.id, user.id), true);
    assert.equal(apiTokenDb.list(user.id).length, 0);
});
