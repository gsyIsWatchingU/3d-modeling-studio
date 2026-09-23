const $ = id => document.getElementById(id);
let projects = [], active = null, runId = '', capabilities, busy = false, previewKey = '', filesKey = '';
let stageId = '', stageRunId = '', stageOutputKey = '';
const labels = { queued: '排队中', running: '生产中', succeeded: '完成 · 待验收', failed: '生产失败', cancelled: '已取消', pending: '等待', approved: '验收通过', changes_requested: '需要修改' };
async function api(route, options = {}) {
    const res = await fetch(`/api/factory${route}`, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
    if (res.status === 401) { location.replace('/login.html'); throw new Error('请先登录'); }
    const data = await res.json(); if (!res.ok) throw new Error(data.error || '请求失败'); return data.data;
}
function toast(text, error = false) { $('toast').textContent = text; $('toast').classList.toggle('error', error); $('toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').hidden = true, 5000); }
async function act(fn) { if (busy) return; busy = true; try { await fn(); } catch (e) { toast(e.message, true); } finally { busy = false; renderRun(); renderWorkflow(); } }
function currentRun() { return active?.runs.find(r => r.id === runId) || active?.runs.at(-1); }
function base(run = currentRun()) { return `/projects/${active.id}/runs/${run.id}`; }
function renderProjects() {
    $('projects').replaceChildren();
    if (!projects.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = '创建你的第一个游戏项目。'; $('projects').append(p); }
    for (const p of projects) {
        const button = document.createElement('button'); button.className = `project-button${p.id === active?.id ? ' active' : ''}`;
        const title = document.createElement('strong'), sub = document.createElement('small'); title.textContent = p.name;
        sub.textContent = p.runs.length ? `${p.runs.length} 个版本 · ${labels[p.runs.at(-1).status]}` : '等待首次生产';
        button.append(title, sub); button.onclick = () => act(() => selectProject(p.id)); $('projects').append(button);
    }
}
async function refresh() {
    const next = await api('/projects');
    const changed = JSON.stringify(projects) !== JSON.stringify(next);
    projects = next;
    if (active) {
        const p = await api(`/projects/${active.id}`);
        if (JSON.stringify(active) !== JSON.stringify(p)) { active = p; renderRun(); renderWorkflow(); }
    }
    if (changed) renderProjects();
}
async function selectProject(id) {
    active = await api(`/projects/${id}`); runId = active.runs.at(-1)?.id || ''; previewKey = ''; filesKey = '';
    stageId = ''; stageRunId = ''; stageOutputKey = '';
    $('instructions').value = ''; $('reviewNotes').value = ''; $('played').checked = false;
    $('welcome').hidden = true; $('workspace').hidden = false;
    $('projectTitle').textContent = active.name; $('projectBrief').textContent = active.brief;
    history.replaceState(null, '', `/?project=${encodeURIComponent(id)}`); renderProjects(); renderRun(); renderWorkflow();
}
function renderRun() {
    if (!active) return;
    const run = currentRun(), running = active.runs.some(r => ['queued', 'running'].includes(r.status));
    $('versions').replaceChildren(...active.runs.map(r => new Option(`第 ${r.version} 版`, r.id)));
    if (run) { runId = run.id; $('versions').value = run.id; }
    $('runStatus').textContent = run ? labels[run.status] : '准备就绪，开始第一版制作';
    $('stages').replaceChildren();
    for (const stage of run?.stages || capabilities.stages) {
        const li = document.createElement('li'), name = document.createElement('span'), status = document.createElement('em');
        li.dataset.status = stage.status || 'pending'; name.textContent = stage.name; status.textContent = stage.status === 'succeeded' ? '✓ 完成' : labels[stage.status || 'pending'];
        li.append(name, status); $('stages').append(li);
    }
    $('runError').hidden = !run?.error; $('runError').textContent = run?.error || '';
    $('produce').disabled = busy || running; $('produce').textContent = running ? '正在后台生产…' : active.runs.length ? '生成新版本' : '开始完整生产';
    $('runActions').replaceChildren();
    for (const [condition, text, route] of [[run?.status === 'failed', '重试失败阶段', 'retry'], [run && ['queued', 'running'].includes(run.status), '取消生产', 'cancel']]) {
        if (!condition) continue;
        const b = document.createElement('button'); b.textContent = text; b.disabled = busy; b.onclick = () => act(async () => { await api(`${base()}/${route}`, { method: 'POST', body: '{}' }); await refresh(); }); $('runActions').append(b);
    }
    const completed = run?.status === 'succeeded', key = completed ? `${active.id}/${run.id}` : '';
    if (previewKey !== key) { previewKey = key; if (key) $('preview').src = `/api/factory${base()}/files/index.html`; else $('preview').removeAttribute('src'); }
    $('preview').hidden = !completed; $('previewEmpty').hidden = Boolean(completed);
    $('download').hidden = !completed; if (completed) { $('download').href = `/api/factory${base()}/export`; $('download').download = `${active.id}-v${run.version}.zip`; }
    if (key && filesKey !== key) { filesKey = key; loadFiles(key).catch(e => toast(e.message, true)); }
    if (!key) { filesKey = ''; $('files').replaceChildren(); $('filePreview').textContent = '等待生产完成。'; $('qaReport').textContent = '等待生产完成。'; }
    $('approve').disabled = $('reject').disabled = !completed || busy;
    $('publish').disabled = run?.review?.status !== 'approved' || busy;
    $('reviewState').textContent = run?.review ? `审核状态：${labels[run.review.status]}${run.review.notes ? ` · ${run.review.notes}` : ''}` : '';
    $('release').hidden = !active.release;
    if (active.release) { $('releaseLink').href = `/api/factory/play/${active.release.token}/`; const r = active.runs.find(r => r.id === active.release.run_id); $('releaseLink').textContent = `打开已发布游戏 · 第 ${r?.version || '?'} 版 ↗`; }
    if (run?.notifications?.length) $('runStatus').textContent += ' / ' + run.notifications.map(n => `${n.channel}：${({ pending: '通知等待发送', sent: '通知已发送', sending: '正在通知', retry_wait: '通知等待重试', failed: '通知失败' })[n.status] || n.status}`).join(' · ');
}
function runsForStage(id) { return (active?.stage_runs || []).filter(run => run.stage_id === id); }
function selectedStageRun() { return (active?.stage_runs || []).find(run => run.id === stageRunId) || runsForStage(stageId).at(-1); }
function workflowState(stage) {
    if (['design', 'narrative', 'concept'].includes(stage.id)) {
        const run = runsForStage(stage.id).at(-1);
        if (!run) return { text: '可开始', status: 'ready' };
        if (run.review?.status === 'approved') return { text: `v${run.version} 已批准`, status: 'approved' };
        if (run.review?.status === 'changes_requested') return { text: `v${run.version} 需修改`, status: 'failed' };
        if (run.status === 'succeeded' && run.stage_id === 'concept' && !run.artifacts?.some(item => item.type === 'image')) return { text: `v${run.version} 待上传图片`, status: 'running' };
        return { text: `v${run.version} ${labels[run.status] || run.status}`, status: run.status };
    }
    if (stage.id === 'modeling') {
        const jobs = active?.model_jobs || [], job = jobs.at(-1);
        const review = active?.stage_reviews?.modeling;
        if (job && review?.reference_id === job.id && review.status === 'approved') return { text: '模型已人工批准', status: 'approved' };
        if (job && review?.reference_id === job.id && review.status === 'changes_requested') return { text: '模型需要修改', status: 'failed' };
        return job ? { text: job.status === 'succeeded' ? '模型已生成 · 待验收' : `模型任务：${labels[job.status] || job.status}`, status: job.status } : { text: '可进入工位', status: 'ready' };
    }
    const run = active?.runs.at(-1);
    if (!run) return { text: stage.id === 'qa' ? '等待可玩版本' : '完整生产中执行', status: 'pending' };
    if (stage.id === 'qa') return run.review?.status === 'approved' ? { text: '试玩验收通过', status: 'approved' } : { text: run.status === 'succeeded' ? '等待人工试玩' : labels[run.status], status: run.status };
    const ids = stage.id === 'animation_audio' ? ['audio', 'animation'] : ['integration'];
    const done = ids.every(id => run.stages?.find(item => item.id === id)?.status === 'succeeded');
    return { text: done ? `第 ${run.version} 版完成` : labels[run.status], status: done ? 'succeeded' : run.status };
}
function renderWorkflow() {
    if (!active || !capabilities?.workflow_stages) return;
    $('workflowStages').replaceChildren();
    let recommended = capabilities.workflow_stages.find(stage => workflowState(stage).status !== 'approved' && !['animation_audio', 'integration', 'qa'].includes(stage.id));
    recommended ||= capabilities.workflow_stages.find(stage => workflowState(stage).status !== 'approved');
    for (const stage of capabilities.workflow_stages) {
        const state = workflowState(stage), button = document.createElement('button');
        button.className = `workflow-card${stage.id === stageId ? ' active' : ''}${stage.id === recommended?.id ? ' recommended' : ''}`;
        button.dataset.status = state.status || 'pending';
        const number = document.createElement('span'), title = document.createElement('strong'), description = document.createElement('small'), status = document.createElement('em');
        number.textContent = stage.number; title.textContent = stage.name; description.textContent = stage.description; status.textContent = `${stage.id === recommended?.id ? '推荐下一步 · ' : ''}${state.text}`;
        button.append(number, title, description, status); button.onclick = () => selectWorkflowStage(stage.id); $('workflowStages').append(button);
    }
    if (stageId) renderStageWorkspace();
}
function selectWorkflowStage(id) {
    stageId = id; stageRunId = runsForStage(id).at(-1)?.id || ''; stageOutputKey = '';
    $('stageInstructions').value = ''; $('stageReviewNotes').value = ''; $('stageConfirmed').checked = false;
    $('stageWorkspace').hidden = false; renderWorkflow(); $('stageWorkspace').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function renderStageWorkspace() {
    const stage = capabilities.workflow_stages.find(item => item.id === stageId); if (!stage) return;
    const runs = runsForStage(stageId), run = selectedStageRun(); if (run) stageRunId = run.id;
    $('stageNumber').textContent = `${stage.number} / ${stage.capability}`; $('stageTitle').textContent = stage.name; $('stageDescription').textContent = stage.description;
    $('stageVersions').replaceChildren(...runs.map(item => new Option(`第 ${item.version} 版`, item.id)));
    $('stageVersions').hidden = !runs.length; if (run) $('stageVersions').value = run.id;
    const dependencyNames = stage.depends_on.map(id => capabilities.workflow_stages.find(item => item.id === id)?.name || id);
    $('stageDependency').textContent = dependencyNames.length ? `推荐输入：${dependencyNames.join('、')}。缺少已批准输入时仍可独立起草，结果会标记为待衔接。` : '这是起始阶段，可直接生成。';
    const canGenerate = ['generate', 'generate_upload'].includes(stage.action);
    $('stagePrompt').hidden = !canGenerate;
    $('startStage').hidden = !canGenerate && !['full_production', 'review'].includes(stage.action);
    $('startStage').disabled = busy || (active.stage_runs || []).some(item => ['queued', 'running'].includes(item.status));
    $('startStage').textContent = canGenerate ? `生成${stage.name}` : stage.action === 'review' ? '前往试玩验收' : '转到完整生产';
    $('openModeling').hidden = stage.action !== 'modeling'; $('openModeling').disabled = busy;
    $('stageInstructions').disabled = !canGenerate;
    const modelJob = stage.id === 'modeling' ? active.model_jobs?.at(-1) : null;
    $('stageStatus').textContent = run ? `${labels[run.status] || run.status}${run.review?.status && run.review.status !== 'pending' ? ` · ${labels[run.review.status]}` : ''}${run.missing_approved_inputs?.length ? ' · 独立起草，缺少已批准上游' : ''}` : workflowState(stage).text;
    $('stageError').hidden = !run?.error; $('stageError').textContent = run?.error || '';
    $('conceptUpload').hidden = !(stage.id === 'concept' && run?.status === 'succeeded');
    const reviewable = run?.status === 'succeeded' || modelJob?.status === 'succeeded';
    $('stageReview').hidden = !reviewable;
    $('approveStage').disabled = $('rejectStage').disabled = busy || !reviewable;
    const key = run?.status === 'succeeded' ? `${active.id}/${run.id}/${(run.artifacts || []).length}` : '';
    if (!key) { stageOutputKey = ''; $('stageOutput').innerHTML = '<p class="muted">本阶段尚无可查看的产物。</p>'; }
    else if (key !== stageOutputKey) { stageOutputKey = key; loadStageOutput(run, key).catch(error => toast(error.message, true)); }
}
async function loadStageOutput(run, key) {
    const response = await fetch(`/api/factory/projects/${active.id}/stage-runs/${run.id}/files/output.md`);
    if (!response.ok) throw new Error('阶段产物读取失败'); const content = await response.text();
    if (stageOutputKey !== key) return;
    $('stageOutput').replaceChildren(); const pre = document.createElement('pre'); pre.textContent = content; $('stageOutput').append(pre);
    const images = (run.artifacts || []).filter(item => item.type === 'image');
    if (images.length) {
        const gallery = document.createElement('div'); gallery.className = 'preview-gallery';
        for (const item of images) { const img = document.createElement('img'); img.src = `/api/factory/projects/${active.id}/stage-runs/${run.id}/files/${item.path}`; img.alt = item.original_name || '预览图'; gallery.append(img); }
        $('stageOutput').append(gallery);
    }
}
async function loadFiles(key) {
    const route = base(), files = await api(`${route}/files`);
    if (filesKey !== key) return;
    $('files').replaceChildren(); $('filePreview').textContent = '选择文件查看；工程 ZIP 包含全部源文件和产物。';
    for (const file of files) {
        const b = document.createElement('button'); b.textContent = `${file.path} · ${(file.bytes / 1024).toFixed(1)} KB`;
        b.onclick = () => showFile(route, file.path).catch(e => toast(e.message, true)); $('files').append(b);
    }
    const qa = await fetch(`/api/factory${route}/files/qa.json`).then(r => r.json());
    if (filesKey !== key) return;
    $('qaReport').textContent = `自动检查：${qa.automated === 'passed' ? '通过' : '失败'}。${qa.checks.join('；')}。尚需人工验证：${qa.unverified.join('、')}。`;
}
let fileRequest = 0;
async function showFile(route, filename) {
    const request = ++fileRequest, key = filesKey, url = `/api/factory${route}/files/${filename}`;
    $('filePreview').replaceChildren();
    if (filename.endsWith('.svg')) { const img = document.createElement('img'); img.src = url; img.alt = filename; $('filePreview').append(img); }
    else if (filename.endsWith('.wav')) { const audio = document.createElement('audio'); audio.src = url; audio.controls = true; $('filePreview').append(audio); }
    else {
        const response = await fetch(url); if (!response.ok) throw new Error('文件读取失败'); const content = await response.text();
        if (request !== fileRequest || key !== filesKey) return;
        const pre = document.createElement('pre'); pre.textContent = content; $('filePreview').append(pre);
    }
    const p = document.createElement('p'), link = document.createElement('a'); link.href = url; link.download = filename.split('/').at(-1); link.textContent = '下载此文件'; p.append(link); $('filePreview').append(p);
}
$('newProject').onclick = () => { active = null; runId = ''; stageId = ''; stageRunId = ''; $('workspace').hidden = true; $('welcome').hidden = false; $('stageWorkspace').hidden = true; $('preview').removeAttribute('src'); previewKey = ''; filesKey = ''; stageOutputKey = ''; history.replaceState(null, '', '/'); renderProjects(); $('name').focus(); };
$('createForm').onsubmit = event => { event.preventDefault(); act(async () => {
    $('create').disabled = true;
    try { const p = await api('/projects', { method: 'POST', body: JSON.stringify({ name: $('name').value, brief: $('brief').value, style: $('style').value || undefined }) }); await refresh(); await selectProject(p.id); toast('项目已创建，点击开始完整生产'); }
    finally { $('create').disabled = false; }
}); };
$('produce').onclick = () => act(async () => {
    $('produce').disabled = true;
    const instructions = $('instructions').value, storageKey = `factory-submit-${active.id}`;
    let pending; try { pending = JSON.parse(sessionStorage.getItem(storageKey)); } catch {}
    if (!pending || pending.instructions !== instructions) pending = { request_key: crypto.randomUUID(), instructions };
    sessionStorage.setItem(storageKey, JSON.stringify(pending));
    const r = await api(`/projects/${active.id}/runs`, { method: 'POST', body: JSON.stringify({ ...pending, channels: $('notify').checked ? ['feishu'] : [] }) });
    sessionStorage.removeItem(storageKey); runId = r.id; $('played').checked = false; $('reviewNotes').value = ''; await refresh(); toast('生产已开始，可以关闭页面');
});
$('versions').onchange = event => { runId = event.target.value; $('played').checked = false; $('reviewNotes').value = ''; renderRun(); };
document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { document.querySelectorAll('[data-tab]').forEach(t => { t.classList.toggle('active', t === b); t.setAttribute('aria-selected', t === b ? 'true' : 'false'); $(`tab-${t.dataset.tab}`).hidden = t !== b; }); });
async function review(status) {
    if (!$('played').checked) throw new Error('请实际试玩并勾选确认');
    if ($('reviewNotes').value.trim().length < 5) throw new Error('请填写至少 5 字的验收记录');
    await api(`${base()}/review`, { method: 'POST', body: JSON.stringify({ status, notes: $('reviewNotes').value, played: true }) }); await refresh(); toast(status === 'approved' ? '验收已记录，现在可以发布' : '已记录修改意见，可生成新版本');
}
$('approve').onclick = () => act(() => review('approved'));
$('reject').onclick = () => act(() => review('changes_requested'));
$('publish').onclick = () => act(async () => { await api(`${base()}/publish`, { method: 'POST', body: '{}' }); await refresh(); toast('游戏已发布，链接无需登录即可游玩'); });
$('unpublish').onclick = () => act(async () => { await api(`/projects/${active.id}/release`, { method: 'DELETE' }); await refresh(); toast('公开链接已关闭'); });
$('modeling').onclick = () => act(async () => { const result = await api(`/projects/${active.id}/model-plan`, { method: 'POST', body: '{}' }); location.href = result.url; });
$('openModeling').onclick = $('modeling').onclick;
$('startStage').onclick = () => act(async () => {
    const stage = capabilities.workflow_stages.find(item => item.id === stageId);
    if (stage.action === 'review') {
        document.querySelector('[data-tab="review"]').click(); document.querySelector('.deliverables').scrollIntoView({ behavior: 'smooth' }); return;
    }
    if (stage.action === 'full_production') { $('instructions').focus(); document.querySelector('.production-panel').scrollIntoView({ behavior: 'smooth' }); return; }
    const instructions = $('stageInstructions').value, storageKey = `factory-stage-submit-${active.id}-${stageId}`;
    let pending; try { pending = JSON.parse(sessionStorage.getItem(storageKey)); } catch {}
    if (!pending || pending.instructions !== instructions) pending = { request_key: crypto.randomUUID(), instructions };
    sessionStorage.setItem(storageKey, JSON.stringify(pending));
    const run = await api(`/projects/${active.id}/stage-runs`, { method: 'POST', body: JSON.stringify({ ...pending, stage_id: stageId }) });
    sessionStorage.removeItem(storageKey); stageRunId = run.id; stageOutputKey = ''; await refresh(); toast(`${stage.name}已进入后台队列`);
});
$('stageVersions').onchange = event => { stageRunId = event.target.value; stageOutputKey = ''; $('stageReviewNotes').value = ''; $('stageConfirmed').checked = false; renderStageWorkspace(); };
$('uploadConcept').onclick = () => act(async () => {
    const run = selectedStageRun(), files = [...$('conceptImages').files]; if (!run || !files.length) throw new Error('请选择需要保存的预览图');
    const form = new FormData(); files.forEach(file => form.append('images', file));
    const response = await fetch(`/api/factory/projects/${active.id}/stage-runs/${run.id}/previews`, { method: 'POST', body: form });
    const payload = await response.json(); if (!response.ok) throw new Error(payload.error || '预览图保存失败');
    $('conceptImages').value = ''; stageOutputKey = ''; await refresh(); toast('预览图已保存到后端阶段版本');
});
async function reviewStage(status) {
    if (!$('stageConfirmed').checked) throw new Error('请先检查实际产物并勾选确认');
    if ($('stageReviewNotes').value.trim().length < 5) throw new Error('请填写至少 5 字的阶段验收记录');
    if (stageId === 'modeling') {
        const job = active.model_jobs?.at(-1); if (!job) throw new Error('请先完成关联的 3D 建模任务');
        await api(`/projects/${active.id}/workflow-stages/modeling/review`, { method: 'POST', body: JSON.stringify({ status, notes: $('stageReviewNotes').value, confirmed: true, reference_id: job.id }) });
        await refresh(); toast(status === 'approved' ? '模型已批准，可继续下一阶段' : '已记录模型修改意见'); return;
    }
    const run = selectedStageRun(); if (!run) throw new Error('请选择需要验收的阶段版本');
    await api(`/projects/${active.id}/stage-runs/${run.id}/review`, { method: 'POST', body: JSON.stringify({ status, notes: $('stageReviewNotes').value, confirmed: true }) });
    await refresh(); toast(status === 'approved' ? '本阶段已批准，可继续下一阶段' : '已记录修改意见，可重新生成新版本');
}
$('approveStage').onclick = () => act(() => reviewStage('approved'));
$('rejectStage').onclick = () => act(() => reviewStage('changes_requested'));
$('logout').onclick = async () => { await AUTH_API.logout(); location.replace('/login.html'); };
(async () => {
    try {
        const user = await AUTH_API.me(); if (!user) return location.replace('/login.html'); $('account').textContent = user.email;
        capabilities = await api('/capabilities'); $('notify').disabled = !capabilities.notifications.feishu.configured; $('notify').checked = capabilities.notifications.feishu.configured; $('notifyState').textContent = capabilities.notifications.feishu.configured ? '已配置' : '请先配置';
        for (const [title, list] of [['已接入', capabilities.supported], ['尚未接入', capabilities.unavailable]]) { const h = document.createElement('h3'), ul = document.createElement('ul'); h.textContent = title; list.forEach(text => { const li = document.createElement('li'); li.textContent = text; ul.append(li); }); $('capabilityList').append(h, ul); }
        await refresh(); const id = new URLSearchParams(location.search).get('project'); if (id) await selectProject(id);
        setInterval(() => { if (!busy && !document.hidden) refresh().catch(e => toast(e.message, true)); }, 4000);
    } catch (e) { toast(e.message, true); }
})();
