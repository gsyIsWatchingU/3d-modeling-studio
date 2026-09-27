// ForgeLoop v2 —— 生产契约 HTTP 接口
//   GET    /api/contracts                         项目契约列表（摘要）
//   GET    /api/contracts/:projectId              单个契约全文 + 最新审计
//   PUT    /api/contracts/:projectId              校验并保存契约（upsert，幂等覆盖）
//   GET    /api/contracts/:projectId/quality-report   质量报告（审计）
//   POST   /api/contracts/:projectId/recheck      重跑质量检查（重建审计并返回）
//
// 门禁语义：审片候选包只允许 review 及以上资产；正式包只允许人工 approved 资产。
// 影子运行期：审计只报告、不阻断；人工 approved 前系统不得自动批准或发布。
const express = require('express');
const { contractDb } = require('./db');
const { requireModelUser, requireUser } = require('./auth');
const { validateContract, auditContract } = require('./contract');

function createContractRouter() {
    const router = express.Router();

    router.get('/', requireModelUser, (req, res) => {
        const items = contractDb.list(req.user.id).map(record => {
            const doc = record.doc;
            const counts = {
                characters: (doc.characters || []).length,
                actions: (doc.actions || []).length,
                props: (doc.props || []).length,
                audio_events: (doc.audio_events || []).length
            };
            return {
                project_id: record.project_id,
                project_name: doc.project_name,
                version: doc.version,
                sha256: record.sha256,
                updated_at: record.updated_at,
                asset_counts: counts
            };
        });
        res.json({ success: true, data: items });
    });

    router.get('/:projectId', requireModelUser, (req, res) => {
        const record = contractDb.get(req.params.projectId, req.user.id);
        if (!record) return res.status(404).json({ success: false, error: '该项目尚未登记生产契约' });
        const audit = auditContract(record.doc);
        res.json({ success: true, data: { ...record, audit } });
    });

    // 更新契约：服务端先校验 schema，保存后立即出审计。契约是权威来源，覆盖即版本更新。
    router.put('/:projectId', requireUser, (req, res) => {
        try {
            const body = req.body || {};
            const normalized = validateContract({ ...body, project_id: req.params.projectId });
            const record = contractDb.save(req.params.projectId, normalized, req.user.id);
            const audit = auditContract(normalized);
            res.json({ success: true, data: { ...record, audit } });
        } catch (error) {
            res.status(400).json({ success: false, error: error.message });
        }
    });

    // 重跑质量检查：对已保存契约重新审计（确定性结果，按需调用）
    router.post('/:projectId/recheck', requireModelUser, (req, res) => {
        const record = contractDb.get(req.params.projectId, req.user.id);
        if (!record) return res.status(404).json({ success: false, error: '该项目尚未登记生产契约' });
        res.json({ success: true, data: { project_id: req.params.projectId, audit: auditContract(record.doc) } });
    });

    router.get('/:projectId/quality-report', requireModelUser, (req, res) => {
        const record = contractDb.get(req.params.projectId, req.user.id);
        if (!record) return res.status(404).json({ success: false, error: '该项目尚未登记生产契约' });
        res.json({ success: true, data: auditContract(record.doc) });
    });

    return router;
}

module.exports = { createContractRouter };
