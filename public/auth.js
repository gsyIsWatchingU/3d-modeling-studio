// 统一账号认证 —— 前端 API 封装
// 用法见 login.html 与 main.js；真正的鉴权永远走 /me（后端会话），
// 本文件只负责把表单/SSO 流程接上统一账号中心。
const AUTH_API = {
    async raw(path, options = {}) {
        const response = await fetch(path, options);
        let payload = {};
        try { payload = await response.json(); } catch { /* 204 等无响应体 */ }
        return { ok: response.ok, status: response.status, data: payload };
    },
    async me() {
        const result = await AUTH_API.raw('/me');
        return result.ok ? result.data : null;
    },
    async login(email, password) {
        return AUTH_API.raw('/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
    },
    async register(email, password, code, name) {
        return AUTH_API.raw('/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, code, name: name || undefined })
        });
    },
    async requestRegistrationCode(email) {
        return AUTH_API.raw('/auth/register-code', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
    },
    async logout() {
        await fetch('/logout', { method: 'POST' });
    },
    ssoStart() {
        location.href = '/auth/sso/start';
    }
};
