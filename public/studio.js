const $ = id => document.getElementById(id);
const studio = { resources: [], filter: 'all', plan: null, config: null, jobs: [], tasks: [], referenceUrls: [], revision: 0, guest: false, preview: null };
const labels = { '2d': '2D 图像', '3d': '3D 模型', sfx: '事件音效' };
const statusLabels = { queued: '排队中', retry_wait: '等待重试', running: '生成中', generating: '生成中', downloading: '保存中', validating: '校验中', succeeded: '已完成', failed: '失败' };
let toastTimer, previewCleanup = () => {}, previewRevision = 0;

async function request(path, options = {}) {
    const response = await fetch(`/api${path}`, options);
    if (response.status === 401) { location.replace('/login.html'); throw new Error('请重新登录'); }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) throw new Error(payload.error || `请求失败（HTTP ${response.status}）`);
    return payload.data;
}
const jsonRequest = (path, method, body) => request(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
function element(tag, text, className) { const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; }
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500); }
function creationStatus(message, error = false) { $('creationStatus').textContent = message; $('creationStatus').classList.toggle('error', error); }
function invalidatePlan() { studio.revision++; studio.plan = null; $('planPanel').hidden = true; }
function view(name) {
    if (studio.guest && name === 'create') { location.href = '/login.html'; return; }
    $('libraryView').hidden = name !== 'library'; $('createView').hidden = name !== 'create';
    document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === name));
    history.replaceState(null, '', name === 'create' ? '/?view=create' : '/');
    if (name === 'create') loadTasks();
}
function formatBytes(bytes) { return bytes ? bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B` : ''; }
function renderLibrary() {
    for (const [kind, id] of [['2d', 'imageCount'], ['3d', 'modelCount'], ['sfx', 'audioCount']]) $(id).textContent = studio.resources.filter(item => item.kind === kind).length;
    $('totalCount').textContent = studio.resources.length;
    const query = $('search').value.trim().toLowerCase();
    const filtered = studio.resources.filter(item => (studio.filter === 'all' || item.kind === studio.filter) && item.name.toLowerCase().includes(query));
    // Stop old audio before replacing cards, including on background refresh.
    $('resourceGrid').querySelectorAll('audio').forEach(audio => audio.pause());
    $('resourceGrid').replaceChildren(); $('resultCount').textContent = `${filtered.length} 份资源 · 最新在前`;
    $('emptyLibrary').hidden = filtered.length > 0;
    $('emptyLibrary').querySelector('h2').textContent = studio.resources.length ? '没有匹配的资源' : '从第一份资源开始';
    for (const resource of filtered) {
        const card = element('article', null, 'resource-card'), visual = element('div', null, 'resource-visual');
        visual.append(element('span', resource.kind === '3d' && resource.thumbnail ? '3D / 参考图' : labels[resource.kind], 'type-tag'));
        if (resource.kind === '2d' || resource.thumbnail) {
            const img = element('img'); img.src = resource.kind === '2d' ? resource.url : resource.thumbnail; img.alt = resource.name; img.loading = 'lazy';
            img.addEventListener('error', () => { img.remove(); visual.append(element('span', '预览图加载失败', 'muted')); }); visual.append(img);
        } else visual.append(element('span', resource.kind === '3d' ? '◇' : '♪', resource.kind === '3d' ? 'model-symbol' : 'audio-symbol'));
        if (resource.kind === 'sfx') { const audio = element('audio'); audio.controls = true; audio.preload = 'none'; audio.src = resource.url; audio.setAttribute('aria-label', `试听 ${resource.name}`); visual.append(audio); }
        const body = element('div', null, 'resource-body'); body.append(element('h3', resource.name));
        body.append(element('div', [resource.source, formatBytes(resource.bytes), resource.review === 'approved' ? '已审核' : '待审核'].filter(Boolean).join(' · '), 'resource-meta'));
        const actions = element('div', null, 'card-actions'), preview = element('button', resource.kind === '3d' ? '旋转预览 ↗' : resource.kind === 'sfx' ? '打开试听 ↗' : '查看大图 ↗');
        preview.addEventListener('click', () => openPreview(resource));
        const download = element('a', '下载 ↓'); download.href = resource.url; download.download = resource.name; actions.append(preview, download); body.append(actions); card.append(visual, body); $('resourceGrid').append(card);
    }
}
async function loadLibrary(background = false) {
    try {
        const resources = await request(studio.guest ? '/studio/showcase' : '/studio/resources');
        $('libraryError').hidden = true;
        if (!background || JSON.stringify(resources) !== JSON.stringify(studio.resources)) { studio.resources = resources; renderLibrary(); }
    } catch (error) { $('libraryError').hidden = false; $('libraryError').textContent = error.message; }
}
async function loadTasks() {
    try {
        [studio.jobs, studio.tasks] = await Promise.all([request('/jobs'), request('/studio/tasks')]);
        const tasks = [...studio.jobs, ...studio.tasks].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 12);
        $('tasks').replaceChildren();
        if (!tasks.length) $('tasks').append(element('p', '提交后会在这里显示生成进度。', 'muted'));
        for (const task of tasks) {
            const row = element('div', null, 'task-item'); row.append(element('b', task.name));
            const progress = element('p'); progress.append(element('span', statusLabels[task.status] || task.status, 'task-state'), document.createTextNode(task.progress_message || '')); row.append(progress);
            if (task.error) row.append(element('p', typeof task.error === 'string' ? task.error : task.error.message, 'error'));
            if (task.id.startsWith('J')) { const link = element('a', '查看任务详情 ↗'); link.href = `/modeling.html?job=${encodeURIComponent(task.id)}`; row.append(link); }
            else if (task.asset_id) { const button = element('button', '预览音效 ↗', 'quiet'); button.onclick = async () => { await loadLibrary(true); const asset = studio.resources.find(item => item.id === task.asset_id); if (asset) openPreview(asset); }; row.append(button); }
            $('tasks').append(row);
        }
    } catch (error) { $('tasks').replaceChildren(element('p', error.message, 'error')); }
}
async function loadConfig() {
    studio.config = await request('/studio/config');
    const kind = $('kind').value;
    $('capabilityHint').textContent = kind === '3d'
        ? studio.config.modeling_configured ? '3D 工位已配置；实际造型以第一张参考图为准。' : '请先到专业工位设置 3D 建模服务。'
        : studio.config.audio_configured ? '使用自有 GPU 的 MOSS 生成独立事件音效，完成后待试听。' : '音效须在已配置的自有 GPU 服务器上执行。';
}
function resetPreview() { previewRevision++; previewCleanup(); previewCleanup = () => {}; $('previewContent').querySelectorAll('audio').forEach(audio => audio.pause()); $('previewContent').replaceChildren(); }
function disposeModel(model) { model.traverse(node => { node.geometry?.dispose(); for (const material of Array.isArray(node.material) ? node.material : node.material ? [node.material] : []) { for (const value of Object.values(material)) if (value?.isTexture) value.dispose(); material.dispose(); } }); }
function openPreview(resource) {
    resetPreview(); const revision = previewRevision;
    studio.preview = resource; $('shareControls').hidden = studio.guest; $('reviewedResource').checked = false;
    $('shareButton').textContent = resource.shared ? '撤回公开展示' : '公开这份资源 ↗';
    $('reviewedResource').parentElement.hidden = Boolean(resource.shared);
    $('previewName').textContent = resource.name; $('previewType').textContent = labels[resource.kind]; $('previewSource').textContent = `${resource.source} · ${resource.review === 'approved' ? '已审核' : '待人工审核'}`;
    $('previewDownload').href = resource.url; $('previewDownload').download = resource.name; $('previewStatus').textContent = '';
    $('previewDialog').showModal();
    if (resource.kind === '2d') { const img = element('img'); img.src = resource.url; img.alt = resource.name; img.onerror = () => { $('previewStatus').textContent = '图片加载失败，请重试。'; }; $('previewContent').append(img); return; }
    if (resource.kind === 'sfx') { const audio = element('audio'); audio.src = resource.url; audio.controls = true; audio.preload = 'metadata'; audio.onerror = () => { $('previewStatus').textContent = '音频加载失败或格式不受支持。'; }; $('previewContent').append(audio); $('previewStatus').textContent = '点击播放试听，关闭预览会停止播放。'; return; }
    $('previewStatus').textContent = '正在加载 3D 模型…';
    try {
        const container = $('previewContent'), renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.outputEncoding = THREE.sRGBEncoding;
        container.append(renderer.domElement);
        const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(42, 1, .001, 10000);
        const controls = new THREE.OrbitControls(camera, renderer.domElement); controls.enableDamping = true;
        scene.add(new THREE.HemisphereLight(0xffffff, 0x62755f, 1.7)); const light = new THREE.DirectionalLight(0xffffff, 1.4); light.position.set(3, 5, 4); scene.add(light);
        let model, animationFrame;
        const resize = () => { const width = container.clientWidth, height = container.clientHeight; renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); };
        const observer = new ResizeObserver(resize); observer.observe(container); resize();
        const draw = () => { animationFrame = requestAnimationFrame(draw); controls.update(); renderer.render(scene, camera); }; draw();
        previewCleanup = () => { cancelAnimationFrame(animationFrame); observer.disconnect(); controls.dispose(); if (model) disposeModel(model); renderer.dispose(); renderer.forceContextLoss(); };
        new THREE.GLTFLoader().load(resource.url, gltf => {
            if (revision !== previewRevision) { disposeModel(gltf.scene); return; }
            model = gltf.scene; scene.add(model); model.updateMatrixWorld(true);
            const box = new THREE.Box3().setFromObject(model), center = box.getCenter(new THREE.Vector3());
            const span = Math.max(...box.getSize(new THREE.Vector3()).toArray()) || 1;
            const distance = span / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * Math.max(1, 1 / camera.aspect) * 1.5;
            camera.position.copy(center).add(new THREE.Vector3(distance * .6, distance * .4, distance)); camera.near = span / 1000; camera.far = span * 1000; camera.updateProjectionMatrix(); controls.target.copy(center); controls.update();
            $('previewStatus').textContent = '拖动旋转 · 滚轮缩放 · 右键平移';
            const wireframe = element('button', '线框：关', 'preview-controls'); let enabled = false;
            wireframe.onclick = () => { enabled = !enabled; model.traverse(node => { for (const material of Array.isArray(node.material) ? node.material : node.material ? [node.material] : []) material.wireframe = enabled; }); wireframe.textContent = `线框：${enabled ? '开' : '关'}`; }; container.append(wireframe);
        }, undefined, () => { if (revision === previewRevision) $('previewStatus').textContent = '模型加载失败，可下载文件检查。'; });
    } catch { $('previewStatus').textContent = '当前浏览器无法启动 3D 预览，请启用 WebGL 或下载模型。'; }
}

document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => view(button.dataset.view));
$('startCreate').onclick = () => view('create');
document.querySelectorAll('[data-kind]').forEach(button => button.onclick = () => { studio.filter = button.dataset.kind; document.querySelectorAll('[data-kind]').forEach(item => { const active = item === button; item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active)); }); renderLibrary(); });
$('search').oninput = renderLibrary; $('refresh').onclick = () => loadLibrary(); $('refreshTasks').onclick = loadTasks;
$('scanButton').onclick = async () => {
    if (studio.guest) { location.href = '/login.html'; return; }
    $('scanButton').disabled = true;
    try {
        const result = await request('/resources/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        await loadLibrary();
        toast(`扫描完成：新增 ${result.totals.added} 份，共 ${result.totals.total} 份可用`);
    } catch (error) { toast(error.message); }
    finally { $('scanButton').disabled = false; }
};
for (const id of ['uploadButton', 'emptyUpload']) $(id).onclick = () => { if (studio.guest) { location.href = '/login.html'; return; } $('uploadStatus').textContent = ''; $('uploadDialog').showModal(); };
document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => $(button.dataset.close).close());
$('previewDialog').addEventListener('close', resetPreview);
$('shareButton').onclick = async () => {
    const resource = studio.preview; if (!resource) return;
    if (!resource.shared && !$('reviewedResource').checked) { toast('请先预览或试听，并勾选公开确认。'); return; }
    $('shareButton').disabled = true;
    try {
        if (resource.shared) await request(`/studio/resources/${encodeURIComponent(resource.id)}/share`, { method: 'DELETE' });
        else await jsonRequest(`/studio/resources/${encodeURIComponent(resource.id)}/share`, 'POST', { reviewed: true });
        resource.shared = !resource.shared; $('shareButton').textContent = resource.shared ? '撤回公开展示' : '公开这份资源 ↗'; $('reviewedResource').parentElement.hidden = resource.shared;
        await loadLibrary(); toast(resource.shared ? '已公开，可让访客在首页预览' : '已撤回公开展示');
    } catch (error) { toast(error.message); }
    finally { $('shareButton').disabled = false; }
};
$('uploadForm').onsubmit = async event => {
    event.preventDefault(); $('uploadSubmit').disabled = true; $('uploadStatus').textContent = '正在保存…';
    try { const form = new FormData(); form.append('file', $('resourceFile').files[0]); form.append('name', $('resourceName').value); await request('/studio/resources', { method: 'POST', body: form }); $('uploadDialog').close(); $('uploadForm').reset(); await loadLibrary(); view('library'); toast('资源已保存'); }
    catch (error) { $('uploadStatus').textContent = error.message; }
    finally { $('uploadSubmit').disabled = false; }
};
$('settingsButton').onclick = async () => {
    try { await loadConfig(); $('plannerUrl').value = studio.config.url; $('plannerModel').value = studio.config.model; $('plannerKey').value = ''; $('clearKey').checked = false; $('keyState').textContent = studio.config.api_key_configured ? '已配置' : '未配置'; $('settingsStatus').textContent = ''; $('settingsDialog').showModal(); }
    catch (error) { toast(error.message); }
};
$('settingsForm').onsubmit = async event => {
    event.preventDefault(); $('settingsSubmit').disabled = true;
    try { await jsonRequest('/studio/config', 'PUT', { url: $('plannerUrl').value, model: $('plannerModel').value, api_key: $('plannerKey').value, clear_key: $('clearKey').checked }); $('plannerKey').value = ''; $('settingsDialog').close(); invalidatePlan(); await loadConfig(); toast('模型设置已保存'); }
    catch (error) { $('settingsStatus').textContent = error.message; }
    finally { $('settingsSubmit').disabled = false; }
};
for (const id of ['brief', 'assetKind', 'profile']) $(id).addEventListener('input', invalidatePlan);
$('kind').onchange = () => { invalidatePlan(); const model = $('kind').value === '3d'; $('referenceFields').hidden = !model; $('brief').placeholder = model ? '例如：将参考图里的台灯做成低面数 3D 模型，保留黄铜材质。' : '例如：生成 2 秒木门缓慢打开的吱呀声，近距离、干声，尾音短，不要背景音乐。'; loadConfig().catch(error => creationStatus(error.message, true)); };
$('references').onchange = () => {
    invalidatePlan(); studio.referenceUrls.forEach(url => URL.revokeObjectURL(url)); studio.referenceUrls = []; $('referencePreview').replaceChildren();
    for (const file of Array.from($('references').files).slice(0, 6)) { const url = URL.createObjectURL(file); studio.referenceUrls.push(url); const img = element('img'); img.src = url; img.alt = file.name; $('referencePreview').append(img); }
};
$('promptForm').onsubmit = async event => {
    event.preventDefault(); invalidatePlan(); const revision = studio.revision;
    $('planButton').disabled = true; creationStatus('AI 正在整理制作要求，尚未提交 GPU…');
    try {
        const plan = await jsonRequest('/studio/plans', 'POST', { kind: $('kind').value, brief: $('brief').value, asset_kind: $('assetKind').value, profile: $('profile').value });
        if (revision !== studio.revision) { creationStatus('需求已修改，请重新整理制作计划。'); return; }
        studio.plan = plan; $('planName').textContent = plan.name; $('planSummary').textContent = plan.summary; $('planPrompt').textContent = plan.prompt;
        $('planParameters').replaceChildren();
        const generation = plan.execution_plan?.generation;
        const parameters = generation ? [`面数预算 ${generation.triangle_budget}`, `贴图 ${generation.texture_size}`, `${plan.asset_kind === 'character' ? '角色' : plan.asset_kind === 'environment' ? '场景' : '道具'}`] : [`时长 ${plan.duration} 秒`, 'MOSS / 自有 GPU', '独立 WAV 音效'];
        for (const text of parameters) $('planParameters').append(element('span', text));
        $('planReview').replaceChildren(...(plan.review_requirements.length ? plan.review_requirements : ['产物完成后需人工检查。']).map(text => element('li', text)));
        $('planPanel').hidden = false; $('executeButton').disabled = false; creationStatus('制作计划已准备好，确认后才会提交 GPU。');
    } catch (error) { creationStatus(error.message, true); }
    finally { $('planButton').disabled = false; }
};
$('executeButton').onclick = async () => {
    const plan = studio.plan; if (!plan) return; $('executeButton').disabled = true;
    try {
        let task;
        if (plan.kind === '3d') {
            const files = Array.from($('references').files);
            if (!files.length || files.length > 6 || files.some(file => file.size > 10 * 1048576) || files.reduce((sum, file) => sum + file.size, 0) > 30 * 1048576) throw new Error('请上传 1～6 张参考图，单张最多 10 MB，总计最多 30 MB。');
            const form = new FormData(); form.append('studio_plan_id', plan.id); for (const file of files) form.append('images', file); task = await request('/jobs', { method: 'POST', body: form });
        } else task = await jsonRequest(`/studio/plans/${encodeURIComponent(plan.id)}/execute`, 'POST', {});
        invalidatePlan(); creationStatus(`已提交：${task.name}。可在最近任务查看进度，关闭页面后仍会继续。`); await loadTasks(); toast('GPU 任务已提交');
    } catch (error) { creationStatus(error.message, true); $('executeButton').disabled = false; }
};
$('logout').onclick = async () => { await AUTH_API.logout(); location.replace('/login.html'); };
document.addEventListener('play', event => { if (event.target.tagName === 'AUDIO') document.querySelectorAll('audio').forEach(audio => { if (audio !== event.target) audio.pause(); }); }, true);
async function init() {
    const legacyProject = new URLSearchParams(location.search).get('project');
    if (legacyProject) { location.replace(`/game-factory.html?project=${encodeURIComponent(legacyProject)}`); return; }
    const user = await AUTH_API.me();
    if (!user) {
        studio.guest = true; $('settingsButton').hidden = true; $('logout').textContent = '登录'; $('logout').onclick = () => { location.href = '/login.html'; };
        $('libraryView').querySelector('h1').textContent = '创作资源，在线预览。'; $('libraryView').querySelector('.lead').textContent = '浏览已公开的 2D 图像、3D 模型与事件音效。';
        $('emptyLibrary').querySelector('p').textContent = '尚无公开资源。登录后可管理自己的资源和 GPU 创作任务。'; $('emptyUpload').textContent = '登录工作室 →';
        view('library'); await loadLibrary(); return;
    }
    $('account').textContent = user.email || user.username || '';
    view(new URLSearchParams(location.search).get('view') === 'create' ? 'create' : 'library');
    await Promise.all([loadLibrary(), loadTasks(), loadConfig().catch(error => creationStatus(error.message, true))]);
    setInterval(async () => { if (document.hidden) return; const active = [...studio.jobs, ...studio.tasks].some(task => !['succeeded', 'failed'].includes(task.status)); if (active || !$('createView').hidden) await loadTasks(); if (active) await loadLibrary(true); }, 5000);
}
init().catch(error => toast(error.message));
