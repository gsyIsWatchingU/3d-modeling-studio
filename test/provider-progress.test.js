const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-provider-'));
process.env.DB_PATH = path.join(root, 'db.json');
process.env.UPLOAD_DIR = path.join(root, 'uploads');
process.env.MODEL_DIR = path.join(root, 'models');
const { progressFromResult, providerQuality } = require('../server/model-worker');

test('线上 Forge3D 阶段契约可显示真实进度', () => {
    for (const [name, label] of Object.entries({generate_mesh: '正在生成模型形体', generate_material: '正在生成 PBR 材质', normalize_mesh: '正在整理模型结构', render_preview: '正在生成预览', validate: '正在进行质量检查'})) {
        assert.equal(progressFromResult({state: 'running', stages: [{name, state: 'running'}]}), label);
    }
    assert.match(progressFromResult({state: 'queued'}), /排队/);
});

test('保留质量门禁，文件交付不能代替效果验收', () => {
    const quality = providerQuality({state: 'review', quality_gates: {human_art_review: 'required'}, metrics: {triangles: 29999}});
    assert.equal(quality.review_required, true);
    assert.equal(quality.metrics.triangles, 29999);
    assert.equal(quality.quality_gates.human_art_review, 'required');
    assert.equal(providerQuality().review_required, true);
    assert.equal(providerQuality({state: 'approved'}).review_required, false);
});
