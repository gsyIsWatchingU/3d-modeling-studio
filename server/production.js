const express = require('express');
const { productionPlanDb } = require('./db');
const { requireModelUser } = require('./auth');
const { getCatalog, getGuide, catalogVersion } = require('./production-skills');

function createProductionRouter() {
    const router = express.Router();
    router.use(requireModelUser);
    router.get('/catalog', (req, res) => res.json({ success: true, data: getCatalog() }));
    router.get('/guides/:stage', (req, res) => {
        try {
            if (req.query.plan_id) {
                const plan = productionPlanDb.findById(req.query.plan_id, req.user.id);
                if (!plan) return res.status(404).json({ success: false, error: '制作计划不存在' });
                const stage = plan.stages.find(item => item.id === req.params.stage);
                if (!stage) return res.status(404).json({ success: false, error: '制作阶段不存在' });
                return res.json({ success: true, data: { ...stage, plan_id: plan.id, brief: plan.brief, profile: plan.profile } });
            }
            res.json({ success: true, data: getGuide(req.params.stage) });
        } catch (error) { res.status(400).json({ success: false, error: error.message }); }
    });
    router.get('/plans', (req, res) => res.json({ success: true, data: productionPlanDb.list(req.user.id) }));
    router.post('/plans', (req, res) => {
        try {
            const { name, brief, profile = 'xhs_mobile' } = req.body || {};
            if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error('请填写 1～80 字的计划名称');
            if (typeof brief !== 'string' || !brief.trim() || brief.length > 2000) throw new Error('请填写 1～2000 字的游戏目标与约束');
            if (!['xhs_mobile', 'steam_desktop'].includes(profile)) throw new Error('不支持的质量档位');
            const plan = productionPlanDb.create({ name: name.trim(), brief: brief.trim(), profile, catalog_version: catalogVersion,
                status: 'planned', stages: getCatalog().stages.map(stage => getGuide(stage.id)) }, req.user.id);
            res.status(201).json({ success: true, data: plan });
        } catch (error) { res.status(400).json({ success: false, error: error.message }); }
    });
    router.get('/plans/:id', (req, res) => {
        const plan = productionPlanDb.findById(req.params.id, req.user.id);
        res.status(plan ? 200 : 404).json(plan ? { success: true, data: plan } : { success: false, error: '制作计划不存在' });
    });
    return router;
}
module.exports = { createProductionRouter };
