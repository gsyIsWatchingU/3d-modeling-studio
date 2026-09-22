// 统一账号中心接入 —— 3D 建模工作室认证模块（lowdb 版）
// 参考 unified-account-sso-integration Skill 的 Express 模板与 write-here 实现：
// 账号密码只存在账号中心，本模块只做 JSON 代理 + 本地 upsert + 本地会话。
const express = require('express');
const { createHash, randomBytes, timingSafeEqual } = require('crypto');
const { userDb, sessionDb, apiTokenDb } = require('./db');

const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 天
const SSO_CLIENT_ID = process.env.SSO_CLIENT_ID || '3d-modeling-studio';
const SESSION_COOKIE = 'studio_session';
const SSO_STATE_COOKIE = 'studio_sso_state';
const SSO_VERIFIER_COOKIE = 'studio_sso_verifier';

// ---------- Cookie 工具（HttpOnly + SameSite=Lax，https 时加 Secure） ----------
function appendCookie(res, name, value, maxAgeSeconds) {
    const secure = String(process.env.PUBLIC_URL || '').startsWith('https://') ? '; Secure' : '';
    res.append('Set-Cookie',
        `${name}=${encodeURIComponent(value)}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; SameSite=Lax${secure}`);
}

function clearCookie(res, name) {
    appendCookie(res, name, '', 0);
}

function readCookie(req, name) {
    const entry = (req.get('cookie') || '')
        .split(';')
        .map(part => part.trim())
        .find(part => part.startsWith(`${name}=`));
    return entry ? decodeURIComponent(entry.split('=').slice(1).join('=')) : '';
}

function safeEqual(left, right) {
    const a = Buffer.from(String(left || ''));
    const b = Buffer.from(String(right || ''));
    return a.length === b.length && timingSafeEqual(a, b);
}

// ---------- 账号中心地址与统一请求 ----------
function accountBaseUrl() {
    return String(process.env.SSO_AUTH_BASE_URL || '').replace(/\/$/, '');
}

function ssoConfig() {
    const authBaseUrl = accountBaseUrl();
    const publicUrl = String(process.env.PUBLIC_URL || '').replace(/\/$/, '');
    if (!authBaseUrl || !publicUrl) return null;
    return { authBaseUrl, redirectUri: `${publicUrl}/auth/sso/callback` };
}

async function requestUnifiedAccount(pathname, payload) {
    const baseUrl = accountBaseUrl();
    if (!baseUrl) throw Object.assign(new Error('统一账号服务尚未配置'), { statusCode: 503 });
    const response = await fetch(`${baseUrl}/api/sso/${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: SSO_CLIENT_ID, ...payload })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw Object.assign(new Error(data.error || '统一账号服务请求失败'), { statusCode: response.status });
    }
    return data;
}

function localUserResponse(user) {
    return { id: user.id, username: user.displayName || user.username, email: user.email, isAdmin: user.isAdmin };
}

function createLocalSession(userId, res) {
    const token = sessionDb.create(userId);
    appendCookie(res, SESSION_COOKIE, token, SESSION_MAX_AGE_SECONDS);
    return token;
}

// ---------- 会话鉴权 ----------
async function authenticateSession(req) {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) return null;
    const found = sessionDb.findByToken(token);
    return found ? found.user : null;
}

async function requireUser(req, res, next) {
    const user = await authenticateSession(req);
    if (!user) return res.status(401).json({ success: false, error: '登录已过期，请重新登录' });
    req.user = user;
    next();
}

// 仅建模和只读资源接口接受 MCP 凭证；账号和配置管理仍要求网页登录。
async function requireModelUser(req, res, next) {
    const authorization = req.get('authorization');
    if (!authorization) return requireUser(req, res, next);
    const match = /^Bearer (\S+)$/i.exec(authorization);
    const user = match && apiTokenDb.authenticate(match[1]);
    if (!user) return res.status(401).json({ success: false, error: 'MCP 凭证无效或已过期，请登录网页重新创建' });
    req.user = user;
    req.isMcp = true;
    next();
}

// ---------- 路由 ----------
function createAuthRouter() {
    const router = express.Router();

    router.use('/api/mcp/tokens', (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        const origin = req.get('origin');
        const expected = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
        if (origin && origin !== new URL(expected).origin) return res.status(403).json({ success: false, error: '来源不受信任' });
        next();
    });
    router.get('/api/mcp/tokens', requireUser, (req, res) => {
        res.json({ success: true, data: apiTokenDb.list(req.user.id) });
    });
    router.post('/api/mcp/tokens', requireUser, (req, res) => {
        try {
            res.status(201).json({ success: true, data: apiTokenDb.create(req.user.id, req.body?.name) });
        } catch (error) { res.status(400).json({ success: false, error: error.message }); }
    });
    router.delete('/api/mcp/tokens/:id', requireUser, (req, res) => {
        const removed = apiTokenDb.revoke(req.params.id, req.user.id);
        res.status(removed ? 200 : 404).json({ success: removed });
    });

    // 站内注册验证码
    router.post('/auth/register-code', async (req, res) => {
        try {
            res.json(await requestUnifiedAccount('register-code', { email: req.body.email }));
        } catch (error) {
            res.status(error.statusCode || 500).json({ error: error.message });
        }
    });

    // 站内注册（密码只交给账号中心）
    router.post('/auth/register', async (req, res) => {
        try {
            const { user } = await requestUnifiedAccount('register', {
                email: req.body.email,
                password: req.body.password,
                code: req.body.code,
                name: req.body.name || undefined
            });
            const localUser = userDb.upsertSsoUser(user);
            createLocalSession(localUser.id, res);
            res.status(201).json(localUserResponse(localUser));
        } catch (error) {
            res.status(error.statusCode || 500).json({ error: error.message });
        }
    });

    // 站内登录
    router.post('/auth/login', async (req, res) => {
        try {
            const { user } = await requestUnifiedAccount('login', {
                email: req.body.email,
                password: req.body.password
            });
            const localUser = userDb.upsertSsoUser(user);
            createLocalSession(localUser.id, res);
            res.json(localUserResponse(localUser));
        } catch (error) {
            res.status(error.statusCode || 500).json({ error: error.message });
        }
    });

    // SSO 跳转：OAuth2 授权码 + PKCE S256
    router.get('/auth/sso/start', (req, res) => {
        const config = ssoConfig();
        if (!config) return res.status(503).json({ error: '统一登录尚未配置' });
        const state = randomBytes(24).toString('base64url');
        const verifier = randomBytes(32).toString('base64url');
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        appendCookie(res, SSO_STATE_COOKIE, state, 10 * 60);
        appendCookie(res, SSO_VERIFIER_COOKIE, verifier, 10 * 60);
        const authorize = new URL('/api/sso/authorize', config.authBaseUrl);
        authorize.searchParams.set('client_id', SSO_CLIENT_ID);
        authorize.searchParams.set('redirect_uri', config.redirectUri);
        authorize.searchParams.set('state', state);
        authorize.searchParams.set('code_challenge', challenge);
        authorize.searchParams.set('code_challenge_method', 'S256');
        res.redirect(authorize.toString());
    });

    // SSO 回调：state 校验 → 兑换授权码 → upsert → 建本地会话
    router.get('/auth/sso/callback', async (req, res) => {
        const config = ssoConfig();
        const state = readCookie(req, SSO_STATE_COOKIE);
        const verifier = readCookie(req, SSO_VERIFIER_COOKIE);
        clearCookie(res, SSO_STATE_COOKIE);
        clearCookie(res, SSO_VERIFIER_COOKIE);
        if (!config || !state || !verifier || !safeEqual(state, req.query.state) || !req.query.code) {
            return res.redirect('/login.html?error=sso');
        }
        try {
            const response = await fetch(`${config.authBaseUrl}/api/sso/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    code: req.query.code,
                    clientId: SSO_CLIENT_ID,
                    redirectUri: config.redirectUri,
                    codeVerifier: verifier
                })
            });
            if (!response.ok) throw new Error('授权码兑换失败');
            const { user } = await response.json();
            const localUser = userDb.upsertSsoUser(user);
            createLocalSession(localUser.id, res);
            res.redirect('/');
        } catch (error) {
            console.error('统一登录失败:', error.message);
            res.redirect('/login.html?error=sso');
        }
    });

    // 忘记密码：302 到账号中心
    router.get('/auth/forgot-password', (req, res) => {
        const baseUrl = accountBaseUrl();
        if (!baseUrl) return res.status(503).json({ error: '统一账号服务尚未配置' });
        res.redirect(`${baseUrl}/forgot-password`);
    });

    // 当前用户
    router.get('/me', async (req, res) => {
        const user = await authenticateSession(req);
        if (!user) return res.status(401).json({ error: '登录已过期，请重新登录' });
        res.json(localUserResponse(user));
    });

    // 登出：删会话行 + 清 Cookie
    router.post('/logout', (req, res) => {
        const token = readCookie(req, SESSION_COOKIE);
        if (token) sessionDb.deleteByToken(token);
        clearCookie(res, SESSION_COOKIE);
        res.status(204).end();
    });

    return router;
}

module.exports = { createAuthRouter, authenticateSession, requireUser, requireModelUser, localUserResponse };
