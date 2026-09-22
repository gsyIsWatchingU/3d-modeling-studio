// 共用 main.js 的登录态与 API；不在浏览器执行 Skill 中的脚本。
let productionPlans = [];
let activeProductionPlan = null;
let productionGuideText = '';
let productionGuideRequest = 0;

async function loadProductionPlans(selectedId = '') {
    productionPlans = await api('/production/plans');
    const saved = document.getElementById('savedPlanSelect');
    const model = document.getElementById('productionPlanSelect');
    for (const [select, emptyLabel] of [[saved, '当前标准规范'], [model, '独立建模']]) {
        const current = selectedId || select.value;
        select.replaceChildren(new Option(emptyLabel, ''));
        productionPlans.forEach(plan => select.append(new Option(plan.name, plan.id)));
        if (productionPlans.some(plan => plan.id === current)) select.value = current;
    }
    applyProductionPlanSelection();
}

function applyProductionPlanSelection() {
    const plan = productionPlans.find(item => item.id === document.getElementById('productionPlanSelect').value);
    const profile = document.getElementById('profileSelect');
    if (plan) profile.value = plan.profile;
    profile.disabled = Boolean(plan);
}

function updateProductionFixedSkills() {
    const names = { character: '角色', environment: '场景与关卡', prop: '道具' };
    document.getElementById('productionFixedSkills').textContent = `自动使用制作通则、通用建模和${names[document.getElementById('assetKindSelect').value] || '道具'}规范。个人固定 Skill 同时生效。`;
}

async function showProductionGuide(stage) {
    const requestId = ++productionGuideRequest;
    productionGuideText = '';
    document.getElementById('copyProductionGuideBtn').disabled = true;
    const target = document.getElementById('productionGuide');
    target.textContent = '正在读取规范…';
    try {
        const suffix = activeProductionPlan ? `?plan_id=${encodeURIComponent(activeProductionPlan.id)}` : '';
        const guide = await api(`/production/guides/${encodeURIComponent(stage)}${suffix}`);
        if (requestId !== productionGuideRequest) return;
        const context = activeProductionPlan ? `计划：${activeProductionPlan.name}\n目标与约束：${activeProductionPlan.brief}\n\n` : '';
        productionGuideText = `${context}${guide.name}\n能力：${guide.capability}\n所需输入：${guide.inputs.join('；')}\n交付：${guide.deliverables.join('；')}\n\n${guide.snapshot.merged_content}`;
        target.replaceChildren();
        const text = document.createElement('div'); text.textContent = productionGuideText; target.append(text);
        const sources = new Map(guide.snapshot.entries.flatMap(entry => entry.sources || []).map(source => [source.url, source]));
        for (const source of sources.values()) {
            const row = document.createElement('p');
            const link = document.createElement('a'); link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
            link.textContent = `${source.id} · ${source.commit.slice(0, 7)} · ${source.license}`;
            row.append(link); target.append(row);
        }
        document.getElementById('copyProductionGuideBtn').disabled = false;
    } catch (error) { if (requestId === productionGuideRequest) target.textContent = error.message; }
}

function renderProductionStages(catalog) {
    const list = document.getElementById('productionStages'); list.replaceChildren();
    for (const stage of catalog.stages) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'production-stage';
        button.textContent = `${stage.name} · ${stage.capability}`;
        button.addEventListener('click', () => showProductionGuide(stage.id)); list.append(button);
    }
}

document.getElementById('openProductionBtn').addEventListener('click', async () => {
    document.getElementById('productionDialog').showModal();
    try {
        const catalog = await api('/production/catalog');
        renderProductionStages(catalog);
        await loadProductionPlans();
        document.getElementById('savedPlanSelect').value = activeProductionPlan?.id || '';
        await showProductionGuide('design');
    } catch (error) { showToast(error.message, true); }
});
document.getElementById('closeProductionBtn').addEventListener('click', () => document.getElementById('productionDialog').close());
document.getElementById('createProductionPlanBtn').addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    try {
        activeProductionPlan = await api('/production/plans', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
            name: document.getElementById('planNameInput').value, brief: document.getElementById('planBriefInput').value, profile: document.getElementById('planProfileSelect').value
        }) });
        await loadProductionPlans(activeProductionPlan.id);
        document.getElementById('downloadProductionPlanBtn').disabled = false;
        document.getElementById('productionPlanNotice').textContent = `已关联：${activeProductionPlan.name}。本计划使用保存时的规范版本。`;
        await showProductionGuide('design');
        showToast('计划已保存，后续建模会关联此计划');
    } catch (error) { showToast(error.message, true); }
    finally { document.getElementById('createProductionPlanBtn').disabled = false; }
});
document.getElementById('savedPlanSelect').addEventListener('change', async event => {
    try {
        activeProductionPlan = event.target.value ? await api(`/production/plans/${encodeURIComponent(event.target.value)}`) : null;
        document.getElementById('productionPlanSelect').value = activeProductionPlan?.id || '';
        applyProductionPlanSelection();
        document.getElementById('downloadProductionPlanBtn').disabled = !activeProductionPlan;
        document.getElementById('productionPlanNotice').textContent = activeProductionPlan ? `已关联：${activeProductionPlan.name}。本计划使用保存时的规范版本。` : '正在查看当前标准规范。';
        await showProductionGuide('design');
    } catch (error) { showToast(error.message, true); }
});
document.getElementById('copyProductionGuideBtn').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(productionGuideText); showToast('规范已复制'); }
    catch { showToast('复制失败，请选中规范文本手动复制', true); }
});
document.getElementById('downloadProductionPlanBtn').addEventListener('click', () => {
    if (!activeProductionPlan) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(activeProductionPlan, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `${activeProductionPlan.id}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
});
document.getElementById('productionPlanSelect').addEventListener('change', applyProductionPlanSelection);
document.getElementById('assetKindSelect').addEventListener('change', updateProductionFixedSkills);
