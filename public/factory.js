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
    $('advancedWorkspace').open = false;
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
    $('deliverables').hidden = !run;
    renderNextTask();
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
function setProjectFlow(current, completed = []) {
    document.querySelectorAll('[data-flow]').forEach(item => {
        item.classList.toggle('active', item.dataset.flow === current);
        item.classList.toggle('done', completed.includes(item.dataset.flow));
    });
}
function showTab(name) {
    const button = document.querySelector(`[data-tab="${name}"]`);
    if (button) button.click();
    $('deliverables').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function openAdvanced(stage) {
    $('advancedWorkspace').open = true;
    if (stage) selectWorkflowStage(stage);
    else $('advancedWorkspace').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function setNextTask({ kicker, title, description, primary, primaryAction, secondary, secondaryAction, flow, completed = [], progress = 0 }) {
    $('nextKicker').textContent = kicker;
    $('nextTitle').textContent = title;
    $('nextDescription').textContent = description;
    $('nextPrimary').textContent = primary;
    $('nextPrimary').onclick = primaryAction;
    $('nextSecondary').hidden = !secondary;
    $('nextSecondary').textContent = secondary || '';
    $('nextSecondary').onclick = secondaryAction || null;
    $('nextProgress').hidden = !progress;
    $('nextProgress').firstElementChild.style.width = `${progress}%`;
    setProjectFlow(flow, completed);
}
function renderNextTask() {
    if (!active || !capabilities) return;
    const run = currentRun();
    if (!run && active.stage_runs?.length) {
        const stage = capabilities.workflow_stages.find(item => workflowState(item).status !== 'approved') || capabilities.workflow_stages.at(-1);
        const state = workflowState(stage), awaitingReview = state.status === 'succeeded' || state.status === 'failed';
        setNextTask({
            kicker: awaitingReview ? '需要你确认' : '分阶段精修',
            title: awaitingReview ? `${stage.name}已有新产物` : `下一步：${stage.name}`,
            description: awaitingReview ? '查看实际产物，批准后再进入下一阶段；需要调整也可以直接留下修改意见。' : stage.description,
            primary: awaitingReview ? '查看并处理 →' : `进入${stage.name} →`,
            primaryAction: () => openAdvanced(stage.id),
            secondary: '改为生成完整版本',
            secondaryAction: () => { openAdvanced(); $('instructions').focus(); },
            flow: 'production', completed: ['idea']
        });
        return;
    }
    if (!run) {
        setNextTask({
            kicker: '下一步', title: '生成第一个可玩版本',
            description: 'AI 会在后台完成策划、剧本、素材、声音与关卡组装；完成后回到这里试玩。',
            primary: '开始生成可玩版本 →', primaryAction: () => $('produce').click(),
            secondary: '我想分阶段精修', secondaryAction: () => openAdvanced('design'),
            flow: 'production', completed: ['idea']
        });
        return;
    }
    if (['queued', 'running'].includes(run.status)) {
        const current = run.stages?.find(item => item.status === 'running') || run.stages?.find(item => item.status === 'pending');
        const done = run.stages?.filter(item => item.status === 'succeeded').length || 0;
        const total = run.stages?.length || capabilities.stages.length || 1;
        setNextTask({
            kicker: 'AI 正在后台制作', title: current ? `当前：${current.name}` : '任务已进入生产队列',
            description: `已完成 ${done} / ${total} 个制作环节。可以关闭页面，生产不会中断。`,
            primary: '查看制作进度', primaryAction: () => { openAdvanced(); document.querySelector('.production-panel').scrollIntoView({ behavior: 'smooth' }); },
            flow: 'production', completed: ['idea'], progress: Math.max(4, Math.round(done / total * 100))
        });
        return;
    }
    if (run.status === 'failed') {
        const failed = run.stages?.find(item => item.status === 'failed');
        setNextTask({
            kicker: '需要处理', title: `${failed?.name || '游戏制作'}未完成`,
            description: run.error || '保留已完成内容，只重试失败的制作环节。',
            primary: '重试失败环节 →', primaryAction: () => act(async () => { await api(`${base(run)}/retry`, { method: 'POST', body: '{}' }); await refresh(); }),
            secondary: '查看错误详情', secondaryAction: () => { openAdvanced(); document.querySelector('.production-panel').scrollIntoView({ behavior: 'smooth' }); },
            flow: 'production', completed: ['idea']
        });
        return;
    }
    if (run.status === 'cancelled') {
        setNextTask({
            kicker: '制作已暂停', title: '重新生成一个可玩版本', description: '上一次任务已取消，可以保留项目创意并重新开始。',
            primary: '重新开始 →', primaryAction: () => $('produce').click(), secondary: '调整本次要求', secondaryAction: () => { openAdvanced(); $('instructions').focus(); },
            flow: 'production', completed: ['idea']
        });
        return;
    }
    if (run.review?.status === 'approved') {
        const published = Boolean(active.release);
        setNextTask({
            kicker: published ? '制作完成' : '最后一步',
            title: published ? '游戏已经发布' : '下载工程或发布游戏',
            description: published ? '公开试玩链接已生效，你仍可以下载完整工程或继续制作新版本。' : '这一版已经通过试玩验收，可以下载完整工程，也可以生成公开试玩链接。',
            primary: published ? '打开公开游戏 ↗' : '查看交付选项 →',
            primaryAction: published ? () => $('releaseLink').click() : () => showTab('review'),
            secondary: '下载与文件', secondaryAction: () => showTab('files'),
            flow: 'delivery', completed: published ? ['idea', 'production', 'review', 'delivery'] : ['idea', 'production', 'review']
        });
        return;
    }
    if (run.review?.status === 'changes_requested') {
        setNextTask({
            kicker: '继续修改', title: '根据试玩意见生成新版本', description: '旧版本和验收记录会保留。先写清要改什么，再开始一次新的完整生产。',
            primary: '填写修改要求 →', primaryAction: () => { openAdvanced(); $('instructions').focus(); },
            secondary: '再次试玩', secondaryAction: () => showTab('preview'),
            flow: 'production', completed: ['idea']
        });
        return;
    }
    setNextTask({
        kicker: '下一步', title: '试玩并验收这个版本', description: '请亲自检查操作、画面和声音。确认通过后，才会开放发布。',
        primary: '开始试玩 →', primaryAction: () => showTab('preview'),
        secondary: '查看文件', secondaryAction: () => showTab('files'),
        flow: 'review', completed: ['idea', 'production']
    });
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
$('newProject').onclick = () => { active = null; runId = ''; stageId = ''; stageRunId = ''; $('workspace').hidden = true; $('welcome').hidden = false; $('stageWorkspace').hidden = true; $('advancedWorkspace').open = false; $('preview').removeAttribute('src'); previewKey = ''; filesKey = ''; stageOutputKey = ''; $('createForm').reset(); $('toast').hidden = true; history.replaceState(null, '', '/'); renderProjects(); $('brief').focus(); };
$('createForm').onsubmit = event => { event.preventDefault(); act(async () => {
    $('create').disabled = true;
    const brief = $('brief').value.trim();
    const suggestedName = brief.split(/[。！？!?.，,\n]/)[0].trim();
    const name = $('name').value.trim() || `${suggestedName.slice(0, 12)}${suggestedName.length > 12 ? '…' : ''}` || '我的游戏';
    try { const p = await api('/projects', { method: 'POST', body: JSON.stringify({ name, brief, style: $('style').value || undefined }) }); await refresh(); await selectProject(p.id); toast('项目已创建，下一步已经为你准备好'); }
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
$('modeling').onclick = () => act(async () => {
    const result = await api(`/projects/${active.id}/model-plan`, { method: 'POST', body: '{}' });
    if (result.preview_files?.length) sessionStorage.setItem('modeling-reference-transfer', JSON.stringify({ plan_id: result.production_plan_id, project_name: active.name, images: result.preview_files }));
    location.href = result.url;
});
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
        await refresh(); const id = new URLSearchParams(location.search).get('project'); if (id) await selectProject(id);
        setInterval(() => { if (!busy && !document.hidden) refresh().catch(e => toast(e.message, true)); }, 4000);
    } catch (e) { toast(e.message, true); }
})();
