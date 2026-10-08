// 本地 UI 验收使用隔离账号与模拟推理服务，不向真实 GPU 提交任务。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, waitFor } = require('../test-support/studio-fixture');

async function main() {
    const { chromium } = require(process.env.STUDIO_PLAYWRIGHT_PATH || 'playwright');
    const f = await fixture();
    const browser = await chromium.launch({ executablePath: process.env.STUDIO_BROWSER_PATH || undefined, headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
    const artifacts = path.resolve('artifacts/studio-ui'); fs.mkdirSync(artifacts, { recursive: true });
    try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        await context.addCookies([{ name: 'studio_session', value: 'fixture-session-1', url: f.base }]);
        const page = await context.newPage(), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(f.base); await page.locator('#totalCount').filter({ hasText: '0' }).waitFor();
        for (const [name, buffer, mimeType, filename] of [['黄铜台灯 · 参考图', f.png, 'image/png', 'lamp.png'], ['道具 · 3D 模型', f.glb, 'model/gltf-binary', 'lamp.glb'], ['木门 · 音效', f.wav, 'audio/wav', 'door.wav']]) {
            await page.click('#uploadButton'); await page.fill('#resourceName', name);
            await page.setInputFiles('#resourceFile', { name: filename, mimeType, buffer }); await page.click('#uploadSubmit'); await page.locator('#uploadDialog').waitFor({ state: 'hidden' });
        }
        await page.locator('.resource-card').nth(2).waitFor();
        assert.equal(await page.locator('.resource-card').count(), 3);
        await page.screenshot({ path: path.join(artifacts, 'library-desktop.png'), fullPage: true });
        await page.click('[data-kind="2d"]'); await page.locator('.resource-card button').click();
        await waitFor(() => page.locator('#previewContent img').evaluate(img => img.complete && img.naturalWidth > 0));
        await page.check('#reviewedResource'); await page.click('#shareButton'); await page.getByRole('button', { name: '撤回公开展示', exact: true }).waitFor(); await page.click('[data-close="previewDialog"]');
        await page.click('[data-kind="3d"]'); await page.locator('.resource-card button').click();
        await page.locator('#previewStatus').filter({ hasText: '拖动旋转' }).waitFor();
        assert.equal(await page.locator('#previewContent canvas').count(), 1);
        await page.click('.preview-controls'); assert.equal(await page.locator('.preview-controls').textContent(), '线框：开');
        await page.screenshot({ path: path.join(artifacts, 'model-preview.png') }); await page.click('[data-close="previewDialog"]');
        await page.click('[data-kind="sfx"]'); await page.locator('.resource-card button').click();
        await waitFor(() => page.locator('#previewContent audio').evaluate(audio => Number.isFinite(audio.duration)));
        await page.locator('#previewContent audio').evaluate(audio => audio.play());
        assert.equal(await page.locator('#previewContent audio').evaluate(audio => audio.paused), false);
        await page.click('[data-close="previewDialog"]'); assert.equal(await page.locator('#previewContent audio').count(), 0);
        await page.click('#startCreate'); await page.fill('#brief', '将台灯做成适合网页展示的低面数黄铜道具。');
        await page.setInputFiles('#references', { name: 'lamp.png', mimeType: 'image/png', buffer: f.png });
        await page.click('#planButton'); await page.locator('#planPanel').waitFor();
        assert.equal(f.captures.gpu.length, 0); await page.screenshot({ path: path.join(artifacts, 'creation-plan.png'), fullPage: true });
        await page.fill('#brief', '将台灯做成适合网页展示的黄铜道具，底座完整。'); assert.equal(await page.locator('#planPanel').isVisible(), false);
        await page.click('#planButton'); await page.locator('#planPanel').waitFor(); await page.click('#executeButton');
        await page.locator('#creationStatus').filter({ hasText: '已提交' }).waitFor();
        await waitFor(() => f.captures.gpu.length === 1);
        await page.setViewportSize({ width: 390, height: 844 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await page.screenshot({ path: path.join(artifacts, 'creation-mobile.png'), fullPage: true });
        const guest = await browser.newContext({ viewport: { width: 390, height: 844 } }); const guestPage = await guest.newPage(); await guestPage.goto(f.base);
        await guestPage.locator('.resource-card').waitFor(); assert.equal(await guestPage.locator('.resource-card').count(), 1); assert.equal(await guestPage.locator('#settingsButton').isVisible(), false);
        await guestPage.locator('.resource-card button').click(); await waitFor(() => guestPage.locator('#previewContent img').evaluate(img => img.naturalWidth > 0));
        assert.equal(await guestPage.locator('#shareControls').isVisible(), false); await guestPage.click('[data-close="previewDialog"]');
        await guestPage.screenshot({ path: path.join(artifacts, 'showcase-mobile.png'), fullPage: true });
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ result: 'passed', verified: ['三类资源真实上传和保存', '图片加载', 'WebGL 模型与线框', '音频实际播放和关闭停止', 'AI 计划与确认后提交', '修改需求后计划失效', '仅明确公开资源对游客可见', '手机无横向溢出'], artifacts }, null, 2));
    } finally { await browser.close(); await f.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
