const $ = id => document.getElementById(id);
let projects = [], active = null, runId = '', capabilities, busy = false, previewKey = '', filesKey = '';
const labels = { queued: '排队中', running: '生产中', succeeded: '完成 · 待验收', failed: '生产失败', cancelled: '已取消', pending: '等待', approved: '验收通过', changes_requested: '需要修改' };
async function api(route, options = {}) {
    const res = await fetch(`/api/factory${route}`, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
    if (res.status === 401) { location.replace('/login.html'); throw new Error('请先登录'); }
    const data = await res.json(); if (!res.ok) throw new Error(data.error || '请求失败'); return data.data;
}
function toast(text, error = false) { $('toast').textContent = text; $('toast').classList.toggle('error', error); $('toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').hidden = true, 5000); }
async function act(fn) { if (busy) return; busy = true; try { await fn(); } catch (e) { toast(e.message, true); } finally { busy = false; renderRun(); } }
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
    if (active) { const p = projects.find(p => p.id === active.id); if (p && JSON.stringify(active) !== JSON.stringify(p)) { active = p; renderRun(); } }
    if (changed) renderProjects();
}
async function selectProject(id) {
    active = await api(`/projects/${id}`); runId = active.runs.at(-1)?.id || ''; previewKey = ''; filesKey = '';
    $('instructions').value = ''; $('reviewNotes').value = ''; $('played').checked = false;
    $('welcome').hidden = true; $('workspace').hidden = false;
    $('projectTitle').textContent = active.name; $('projectBrief').textContent = active.brief;
    history.replaceState(null, '', `/?project=${encodeURIComponent(id)}`); renderProjects(); renderRun();
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
$('newProject').onclick = () => { active = null; runId = ''; $('workspace').hidden = true; $('welcome').hidden = false; $('preview').removeAttribute('src'); previewKey = ''; filesKey = ''; history.replaceState(null, '', '/'); renderProjects(); $('name').focus(); };
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
