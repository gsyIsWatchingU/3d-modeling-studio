const API_BASE = '/api';
const state = {
    images: [],
    bootstrap: null,
    jobs: [],
    activeJobId: new URLSearchParams(location.search).get('job') || localStorage.getItem('activeJobId') || '',
    currentModel: null,
    wireframe: false,
    polling: false
};

let scene;
let camera;
let renderer;
let controls;
let ambientLight;
let directionalLight;

const statusLabels = {
    queued: '排队中',
    retry_wait: '等待重试',
    generating: '生成中',
    downloading: '保存中',
    validating: '校验中',
    succeeded: '已完成',
    failed: '失败'
};

async function api(path, options = {}) {
    const response = await fetch(`${API_BASE}${path}`, options);
    if (response.status === 401 && !location.pathname.endsWith('/login.html')) {
        location.replace('/login.html');
        throw new Error('登录已过期，请重新登录');
    }
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; } catch { throw new Error(`服务器返回异常（HTTP ${response.status}）`); }
    if (!response.ok || payload.success === false) throw new Error(payload.error || `请求失败（HTTP ${response.status}）`);
    return payload.data ?? payload;
}

function showToast(message, isError = false) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.toggle('error', isError);
    toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { toast.hidden = true; }, 4500);
}

function initScene() {
    const canvas = document.getElementById('canvas');
    const viewport = document.querySelector('.viewport');
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf4f5ef);
    camera = new THREE.PerspectiveCamera(45, viewport.clientWidth / viewport.clientHeight, 0.1, 1000);
    camera.position.set(3.2, 2.8, 5.2);
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(viewport.clientWidth, viewport.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.outputEncoding = THREE.sRGBEncoding;
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 1, 0);
    ambientLight = new THREE.HemisphereLight(0xffffff, 0xb8c1b6, 1.25);
    scene.add(ambientLight);
    directionalLight = new THREE.DirectionalLight(0xffffff, 1.4);
    directionalLight.position.set(4, 8, 5);
    directionalLight.castShadow = true;
    scene.add(directionalLight);
    const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(20, 20),
        new THREE.MeshStandardMaterial({ color: 0xe8ebe5, roughness: 1 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    scene.add(new THREE.GridHelper(20, 20, 0x97b39b, 0xc4ccc3));
    window.addEventListener('resize', resizeRenderer);
    new ResizeObserver(resizeRenderer).observe(document.getElementById('taskProgress'));
    resizeRenderer();
    animate();
}

function resizeRenderer() {
    const viewport = document.querySelector('.viewport');
    if (!viewport?.clientWidth || !viewport?.clientHeight) return;
    const progress = document.getElementById('taskProgress');
    const height = Math.max(160, viewport.clientHeight - (progress?.offsetHeight || 125) - 28);
    camera.aspect = viewport.clientWidth / height;
    camera.updateProjectionMatrix();
    renderer.setSize(viewport.clientWidth, height);
}

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}

function disposeCurrentModel() {
    if (!state.currentModel) return;
    scene.remove(state.currentModel);
    state.currentModel.traverse(child => {
        if (!child.isMesh) return;
        child.geometry?.dispose?.();
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach(material => material?.dispose?.());
    });
    state.currentModel = null;
}

async function loadModel(url) {
    document.getElementById('emptyView').hidden = true;
    document.getElementById('viewerToolbar').hidden = false;
    document.getElementById('downloadModelBtn').href = url;
    disposeCurrentModel();
    await new Promise((resolve, reject) => {
        new THREE.GLTFLoader().load(url, gltf => {
            const model = gltf.scene;
            const firstBox = new THREE.Box3().setFromObject(model);
            const size = firstBox.getSize(new THREE.Vector3());
            const maxDimension = Math.max(size.x, size.y, size.z) || 1;
            model.scale.setScalar(2.6 / maxDimension);
            const box = new THREE.Box3().setFromObject(model);
            const center = box.getCenter(new THREE.Vector3());
            model.position.x -= center.x;
            model.position.z -= center.z;
            model.position.y -= box.min.y;
            model.traverse(child => {
                if (child.isMesh) {
                    child.castShadow = true;
                    child.receiveShadow = true;
                }
            });
            state.currentModel = model;
            scene.add(model);
            controls.target.set(0, Math.min(1.2, (box.max.y - box.min.y) / 2), 0);
            controls.update();
            resolve();
        }, undefined, reject);
    });
}

function formatBytes(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function addImages(fileList) {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    for (const file of fileList) {
        if (state.images.length >= 6) {
            showToast('最多上传 6 张参考图', true);
            break;
        }
        if (!allowed.includes(file.type)) {
            showToast(`${file.name} 不是支持的图片格式`, true);
            continue;
        }
        if (file.size > 10 * 1024 * 1024) {
            showToast(`${file.name} 超过 10 MB`, true);
            continue;
        }
        const duplicate = state.images.some(item => item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified);
        if (!duplicate) state.images.push({ file, url: URL.createObjectURL(file) });
    }
    renderImages();
    updateGenerateState();
}

function renderImages() {
    const grid = document.getElementById('imageGrid');
    grid.replaceChildren();
    state.images.forEach((item, index) => {
        const card = document.createElement('div');
        card.className = 'image-card';
        const image = document.createElement('img');
        image.src = item.url;
        image.alt = `参考图 ${index + 1}`;
        const badge = document.createElement('span');
        badge.className = 'image-index';
        badge.textContent = `${index + 1} · ${formatBytes(item.file.size)}`;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '×';
        remove.title = `删除 ${item.file.name}`;
        remove.addEventListener('click', () => {
            URL.revokeObjectURL(item.url);
            state.images.splice(index, 1);
            renderImages();
            updateGenerateState();
        });
        card.append(image, badge, remove);
        grid.append(card);
    });
}

function updateGenerateState() {
    const button = document.getElementById('generateBtn');
    const serviceReady = Boolean(state.bootstrap?.provider?.configured);
    button.disabled = !serviceReady || state.images.length === 0 || button.dataset.busy === 'true';
}

function fillSelect(select, items, selected) {
    select.replaceChildren();
    for (const item of items) {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.description ? `${item.name} · ${item.description}` : item.name;
        option.selected = item.id === selected;
        select.append(option);
    }
}

function applyBootstrap(data) {
    state.bootstrap = data;
    const provider = data.provider;
    const badge = document.getElementById('serviceBadge');
    const notice = document.getElementById('serviceNotice');
    badge.textContent = provider.configured ? '建模服务正常' : '建模服务未配置';
    badge.className = `service-badge ${provider.configured ? 'ready' : 'error'}`;
    notice.textContent = provider.configured ? '建模服务已就绪，提交后会在后台运行。' : '建模服务尚未配置，请打开右上角“设置”。';
    notice.classList.toggle('ready', provider.configured);
    fillSelect(document.getElementById('assetKindSelect'), data.asset_kinds, 'prop');
    fillSelect(document.getElementById('profileSelect'), data.profiles, 'xhs_mobile');
    const defaultIds = data.settings.default_skill_ids || [data.settings.default_skill_id].filter(Boolean);
    const defaultSkills = data.skills.filter(skill => defaultIds.includes(skill.id));
    document.getElementById('defaultSkillName').textContent = defaultSkills.map(skill => skill.name).join(' + ') || '未设置';
    renderExtraSkillSelect(data.skills, defaultIds);
    renderSkillManager(data.skills, defaultIds);
    applyNotificationStatus(data.notifications);
    applySettingsForms(data);
    updateGenerateState();
}

function renderExtraSkillSelect(skills, defaultIds) {
    const select = document.getElementById('extraSkillSelect');
    const current = select.value;
    select.replaceChildren();
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '不使用';
    select.append(empty);
    for (const skill of skills.filter(item => !defaultIds.includes(item.id))) {
        const option = document.createElement('option');
        option.value = skill.id;
        option.textContent = skill.name;
        select.append(option);
    }
    if ([...select.options].some(option => option.value === current)) select.value = current;
}

function applyNotificationStatus(notifications) {
    const status = notifications.status;
    document.querySelectorAll('.channel-input').forEach(input => {
        const channel = status[input.value];
        input.disabled = !channel?.configured;
        if (input.disabled) input.checked = false;
        const label = document.querySelector(`[data-channel-status="${input.value}"]`);
        label.textContent = channel?.configured ? (channel.recipient || '已配置') : '未配置';
    });
}

function applySettingsForms(data) {
    document.getElementById('providerUrlInput').value = data.provider.api_url || '';
    document.getElementById('providerUrlInput').disabled = data.provider.managed_by_environment;
    document.getElementById('providerKeyInput').disabled = data.provider.managed_by_environment;
    document.getElementById('saveProviderBtn').disabled = data.provider.managed_by_environment;
    const email = data.notifications.editable.email;
    document.getElementById('emailRecipientInput').value = '';
    document.getElementById('emailRecipientInput').placeholder = email.recipient_configured ? '已配置，留空表示不修改' : 'name@example.com';
    document.getElementById('smtpHostInput').value = '';
    document.getElementById('smtpHostInput').placeholder = email.smtp_host_configured ? '已配置，留空表示不修改' : 'smtp.example.com';
    document.getElementById('smtpPortInput').value = email.smtp_port || 465;
    document.getElementById('smtpUserInput').value = '';
    document.getElementById('smtpUserInput').placeholder = email.smtp_user_configured ? '已配置，留空表示不修改' : 'SMTP 用户名';
    document.getElementById('smtpSecureInput').checked = email.smtp_secure !== false;
    document.getElementById('smtpPassInput').placeholder = email.smtp_pass_configured ? '已配置，留空表示不修改' : '请输入 SMTP 密码';
    document.getElementById('feishuWebhookInput').placeholder = data.notifications.editable.feishu.webhook_configured ? '已配置，留空表示不修改' : '粘贴飞书机器人 Webhook';
    document.getElementById('wecomWebhookInput').placeholder = data.notifications.editable.wecom.webhook_configured ? '已配置，留空表示不修改' : '粘贴企业微信机器人 Webhook';
}

function renderSkillManager(skills, defaultIds) {
    const manager = document.getElementById('skillManager');
    manager.replaceChildren();
    for (const skill of skills) {
        const row = document.createElement('div');
        row.className = 'skill-row';
        const head = document.createElement('div');
        head.className = 'skill-row-head';
        const title = document.createElement('strong');
        title.textContent = skill.name;
        head.append(title);
        if (defaultIds.includes(skill.id)) {
            const badge = document.createElement('span');
            badge.className = 'default-label';
            badge.textContent = '固定';
            head.append(badge);
        }
        const description = document.createElement('p');
        description.textContent = skill.description || `${skill.content_length} 字 · v${skill.version}`;
        const actions = document.createElement('div');
        actions.className = 'skill-actions';
        if (!skill.builtin) {
            const toggleDefault = document.createElement('button');
            toggleDefault.type = 'button';
            toggleDefault.textContent = defaultIds.includes(skill.id) ? '取消固定' : '每次使用';
            toggleDefault.addEventListener('click', () => toggleDefaultSkill(skill.id));
            actions.append(toggleDefault);
        }
        if (!skill.builtin) {
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'danger';
            remove.textContent = '删除';
            remove.addEventListener('click', () => deleteSkill(skill.id));
            actions.append(remove);
        }
        row.append(head, description, actions);
        manager.append(row);
    }
}

async function reloadBootstrap() {
    const data = await api('/bootstrap');
    applyBootstrap(data);
}

async function toggleDefaultSkill(skillId) {
    try {
        const current = state.bootstrap.settings.default_skill_ids || [state.bootstrap.settings.default_skill_id].filter(Boolean);
        const next = current.includes(skillId) ? current.filter(id => id !== skillId) : [...current, skillId];
        await api('/settings/default-skills', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ skill_ids: next }) });
        await reloadBootstrap();
        showToast('我的每次必用 Skill 已更新');
    } catch (error) { showToast(error.message, true); }
}

async function deleteSkill(skillId) {
    try {
        await api(`/skills/${encodeURIComponent(skillId)}`, { method: 'DELETE' });
        await reloadBootstrap();
        showToast('Skill 已删除');
    } catch (error) { showToast(error.message, true); }
}

function createJobCard(job) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `job-card ${job.id === state.activeJobId ? 'active' : ''}`;
    const head = document.createElement('div');
    head.className = 'job-card-head';
    const titleWrap = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = job.name;
    const time = document.createElement('time');
    time.textContent = new Date(job.created_at).toLocaleString();
    titleWrap.append(title, time);
    const status = document.createElement('span');
    status.className = `job-status ${job.status}`;
    status.textContent = statusLabels[job.status] || job.status;
    head.append(titleWrap, status);
    const message = document.createElement('p');
    message.textContent = `${job.id} · ${job.progress_message || '等待处理'}`;
    button.append(head, message);
    button.addEventListener('click', () => selectJob(job.id));
    return button;
}

function renderJobList() {
    const list = document.getElementById('jobList');
    list.replaceChildren();
    if (!state.jobs.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-list';
        empty.textContent = '还没有任务';
        list.append(empty);
        return;
    }
    state.jobs.forEach(job => list.append(createJobCard(job)));
}

function stageIndex(status) {
    return { queued: 0, retry_wait: 0, generating: 1, downloading: 2, validating: 3, succeeded: 4, failed: -1 }[status] ?? 0;
}

async function renderActiveJob() {
    const job = state.jobs.find(item => item.id === state.activeJobId);
    const title = document.getElementById('activeJobTitle');
    const chip = document.getElementById('activeJobStatus');
    const message = document.getElementById('progressMessage');
    const retry = document.getElementById('retryJobBtn');
    const steps = [...document.querySelectorAll('#progressSteps li')];
    steps.forEach(item => { item.className = ''; });
    if (!job || job.status !== 'succeeded') {
        disposeCurrentModel();
        document.getElementById('emptyView').hidden = false;
        document.getElementById('viewerToolbar').hidden = true;
    }
    if (!job) {
        document.getElementById('skillExecution')?.replaceChildren();
        title.textContent = '尚未提交任务';
        chip.textContent = '等待开始';
        chip.className = 'status-chip';
        message.textContent = '完成左侧三步后，任务状态会显示在这里。';
        retry.hidden = true;
        return;
    }
    title.textContent = `${job.id} · ${job.name}`;
    chip.textContent = statusLabels[job.status] || job.status;
    chip.className = `status-chip ${job.status}`;
    message.textContent = job.error?.message || job.progress_message || '正在处理';
    let execution = document.getElementById('skillExecution');
    if (!execution) {
        execution = document.createElement('div');
        execution.id = 'skillExecution';
        execution.className = 'step-copy';
        message.after(execution);
    }
    execution.replaceChildren();
    const fixed = (job.skill_snapshot?.entries || []).filter(item => item.mandatory).map(item => item.name);
    const summary = document.createElement('p');
    summary.textContent = `本次已使用：${(job.skill_snapshot?.entries || []).map(item => item.name).join('、') || '无'}${fixed.length ? `；个人必用：${fixed.join('、')}` : ''}`;
    execution.append(summary);
    if (job.execution_plan) {
        const plan = job.execution_plan;
        const applied = document.createElement('p');
        applied.textContent = `执行参数：${plan.generation.triangle_budget.toLocaleString()} 面预算 · ${plan.generation.texture_size}px 纹理上限 · ${plan.generation.paint_views} 视角 · 粗糙度下限 ${plan.generation.roughness_floor}`;
        execution.append(applied);
        if (plan.material_prompt) {
            const prompt = document.createElement('details');
            const label = document.createElement('summary');
            label.textContent = '查看实际材质提示词';
            const content = document.createElement('p');
            content.textContent = plan.material_prompt;
            prompt.append(label, content);
            execution.append(prompt);
        }
        if (plan.review_requirements?.length) {
            const review = document.createElement('p');
            review.textContent = `待效果验收（未保证实现）：${plan.review_requirements.join('；')}`;
            execution.append(review);
        }
    }
    retry.hidden = job.status !== 'failed';
    const current = stageIndex(job.status);
    steps.forEach((item, index) => {
        if (job.status === 'failed' && index === Math.max(0, stageIndex(job.previous_status || 'generating'))) item.classList.add('error');
        else if (job.status === 'succeeded' || index < current) item.classList.add('done');
        else if (index === current) item.classList.add('active');
    });
    if (job.status === 'succeeded' && job.output?.model_file && document.getElementById('downloadModelBtn').href !== new URL(job.output.model_file, location.href).href) {
        try { await loadModel(job.output.model_file); } catch (error) { showToast(`模型已生成，但浏览器加载失败：${error.message}`, true); }
    }
}

async function selectJob(id) {
    state.activeJobId = id;
    localStorage.setItem('activeJobId', id);
    const url = new URL(location.href);
    url.searchParams.set('job', id);
    history.replaceState(null, '', url);
    renderJobList();
    await renderActiveJob();
}

async function loadJobs(silent = false) {
    if (state.polling) return;
    state.polling = true;
    try {
        state.jobs = await api('/jobs?limit=40');
        if (!state.activeJobId && state.jobs.length) state.activeJobId = state.jobs[0].id;
        renderJobList();
        await renderActiveJob();
    } catch (error) {
        if (!silent) showToast(error.message, true);
    } finally {
        state.polling = false;
    }
}

async function submitJob() {
    const button = document.getElementById('generateBtn');
    if (!state.images.length) return showToast('请先上传至少一张参考图', true);
    button.dataset.busy = 'true';
    button.querySelector('.btn-text').textContent = '正在提交…';
    button.querySelector('.loading').hidden = false;
    updateGenerateState();
    const form = new FormData();
    state.images.forEach(item => form.append('images', item.file));
    form.append('name', document.getElementById('modelNameInput').value);
    form.append('prompt', document.getElementById('promptInput').value);
    form.append('asset_kind', document.getElementById('assetKindSelect').value);
    form.append('profile', document.getElementById('profileSelect').value);
    const extraSkill = document.getElementById('extraSkillSelect').value;
    form.append('skill_ids', JSON.stringify(extraSkill ? [extraSkill] : []));
    form.append('inline_skill', document.getElementById('inlineSkillInput').value);
    const channels = [...document.querySelectorAll('.channel-input:checked')].map(input => input.value);
    form.append('channels', JSON.stringify(channels));
    try {
        const response = await fetch(`${API_BASE}/jobs`, { method: 'POST', body: form });
        const payload = await response.json();
        if (!response.ok || payload.success === false) throw new Error(payload.error || '任务提交失败');
        const job = payload.data;
        state.jobs.unshift(job);
        await selectJob(job.id);
        showToast(`任务 ${job.id} 已提交，可以关闭页面等待通知`);
        await loadJobs(true);
    } catch (error) {
        showToast(error.message, true);
    } finally {
        button.dataset.busy = 'false';
        button.querySelector('.btn-text').textContent = '开始建模';
        button.querySelector('.loading').hidden = true;
        updateGenerateState();
    }
}

async function retryActiveJob() {
    if (!state.activeJobId) return;
    try {
        await api(`/jobs/${encodeURIComponent(state.activeJobId)}/retry`, { method: 'POST' });
        showToast('任务已重新进入队列');
        await loadJobs();
    } catch (error) { showToast(error.message, true); }
}

async function saveProvider() {
    try {
        await api('/config/spu', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: 'forge3d', api_url: document.getElementById('providerUrlInput').value, api_key: document.getElementById('providerKeyInput').value })
        });
        document.getElementById('providerKeyInput').value = '';
        await reloadBootstrap();
        showToast('建模服务已保存');
    } catch (error) { showToast(error.message, true); }
}

async function addSkill() {
    const form = new FormData();
    const file = document.getElementById('skillFileInput').files[0];
    if (file) form.append('skill_file', file);
    form.append('name', document.getElementById('skillNameInput').value);
    form.append('content', document.getElementById('skillContentInput').value);
    try {
        await api('/skills', { method: 'POST', body: form });
        document.getElementById('skillNameInput').value = '';
        document.getElementById('skillFileInput').value = '';
        document.getElementById('skillContentInput').value = '';
        await reloadBootstrap();
        showToast('Skill 已保存，可设为默认或本次使用');
    } catch (error) { showToast(error.message, true); }
}

async function saveNotifications() {
    const body = {
        email: {
            recipient: document.getElementById('emailRecipientInput').value,
            smtp_host: document.getElementById('smtpHostInput').value,
            smtp_port: Number(document.getElementById('smtpPortInput').value),
            smtp_secure: document.getElementById('smtpSecureInput').checked,
            smtp_user: document.getElementById('smtpUserInput').value,
            smtp_pass: document.getElementById('smtpPassInput').value
        },
        feishu: { webhook: document.getElementById('feishuWebhookInput').value },
        wecom: { webhook: document.getElementById('wecomWebhookInput').value }
    };
    try {
        await api('/notification-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        ['smtpPassInput', 'feishuWebhookInput', 'wecomWebhookInput'].forEach(id => { document.getElementById(id).value = ''; });
        await reloadBootstrap();
        showToast('通知设置已保存');
    } catch (error) { showToast(error.message, true); }
}

async function testNotification(channel) {
    try {
        await api('/notification-config/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel }) });
        showToast('测试通知已发送');
    } catch (error) { showToast(error.message, true); }
}

async function loadMcpTokens() {
    const list = document.getElementById('mcpTokenList');
    try {
        const tokens = await api('/mcp/tokens');
        list.replaceChildren();
        if (!tokens.length) list.textContent = '尚未创建接入凭证';
        for (const token of tokens) {
            const row = document.createElement('p');
            const text = document.createElement('span');
            text.textContent = `${token.name} · ${new Date(token.expires_at).toLocaleDateString()} 到期 `;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'text-button';
            button.textContent = '撤销';
            button.addEventListener('click', async () => {
                button.disabled = true;
                try {
                    await api(`/mcp/tokens/${encodeURIComponent(token.id)}`, { method: 'DELETE' });
                    clearMcpToken();
                    await loadMcpTokens();
                    showToast('凭证已撤销，已提交的任务会继续完成');
                } catch (error) { button.disabled = false; showToast(error.message, true); }
            });
            row.append(text, button);
            list.append(row);
        }
    } catch (error) { list.textContent = error.message; }
}

function clearMcpToken() {
    document.getElementById('mcpTokenValue').value = '';
    document.getElementById('mcpTokenResult').hidden = true;
}

async function createMcpToken() {
    const button = document.getElementById('createMcpTokenBtn');
    button.disabled = true;
    clearMcpToken();
    try {
        const result = await api('/mcp/tokens', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: document.getElementById('mcpTokenName').value })
        });
        document.getElementById('mcpTokenValue').value = result.token;
        document.getElementById('mcpTokenResult').hidden = false;
        await loadMcpTokens();
        showToast('凭证已创建，请复制保存');
    } catch (error) { showToast(error.message, true); }
    finally { button.disabled = false; }
}

function bindEvents() {
    const uploadArea = document.getElementById('uploadArea');
    const fileInput = document.getElementById('fileInput');
    uploadArea.addEventListener('click', () => fileInput.click());
    uploadArea.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') fileInput.click(); });
    uploadArea.addEventListener('dragover', event => { event.preventDefault(); uploadArea.classList.add('dragover'); });
    uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
    uploadArea.addEventListener('drop', event => { event.preventDefault(); uploadArea.classList.remove('dragover'); addImages(event.dataTransfer.files); });
    fileInput.addEventListener('change', () => { addImages(fileInput.files); fileInput.value = ''; });
    document.getElementById('promptInput').addEventListener('input', event => { document.getElementById('promptCount').textContent = `${event.target.value.length}/1000`; });
    document.getElementById('generateBtn').addEventListener('click', submitJob);
    document.getElementById('refreshJobsBtn').addEventListener('click', () => loadJobs());
    document.getElementById('retryJobBtn').addEventListener('click', retryActiveJob);
    document.getElementById('openSettingsBtn').addEventListener('click', () => {
        document.getElementById('settingsDialog').showModal();
        document.getElementById('mcpPlatformUrl').textContent = location.origin;
        loadMcpTokens();
    });
    document.getElementById('closeSettingsBtn').addEventListener('click', () => document.getElementById('settingsDialog').close());
    document.getElementById('settingsDialog').addEventListener('close', clearMcpToken);
    document.getElementById('createMcpTokenBtn').addEventListener('click', createMcpToken);
    document.getElementById('copyMcpTokenBtn').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(document.getElementById('mcpTokenValue').value); showToast('凭证已复制'); }
        catch { showToast('复制失败，请手动选中凭证复制', true); }
    });
    document.getElementById('saveProviderBtn').addEventListener('click', saveProvider);
    document.getElementById('addSkillBtn').addEventListener('click', addSkill);
    document.getElementById('saveNotificationsBtn').addEventListener('click', saveNotifications);
    document.querySelectorAll('[data-test-channel]').forEach(button => button.addEventListener('click', () => testNotification(button.dataset.testChannel)));
    document.getElementById('resetCameraBtn').addEventListener('click', () => { camera.position.set(3.2, 2.8, 5.2); controls.target.set(0, 1, 0); controls.update(); });
    document.getElementById('wireframeBtn').addEventListener('click', event => {
        state.wireframe = !state.wireframe;
        event.currentTarget.classList.toggle('active', state.wireframe);
        state.currentModel?.traverse(child => {
            if (!child.isMesh) return;
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            materials.forEach(material => { material.wireframe = state.wireframe; });
        });
    });
    document.getElementById('autoRotateBtn').addEventListener('click', event => {
        controls.autoRotate = !controls.autoRotate;
        event.currentTarget.classList.toggle('active', controls.autoRotate);
    });
    document.getElementById('logoutBtn').addEventListener('click', async () => {
        try { await AUTH_API.logout(); } finally { location.replace('/login.html'); }
    });
}

// 统一账号守卫：未登录先跳登录页，登录后展示当前账号
async function requireAuth() {
    const user = await AUTH_API.me();
    if (!user) {
        location.replace('/login.html');
        return null;
    }
    const chip = document.getElementById('currentUser');
    chip.textContent = user.email;
    chip.hidden = false;
    document.getElementById('logoutBtn').hidden = false;
    return user;
}

async function init() {
    const user = await requireAuth();
    if (!user) return;
    initScene();
    bindEvents();
    try {
        await reloadBootstrap();
        await loadJobs();
    } catch (error) {
        showToast(`初始化失败：${error.message}`, true);
    }
    setInterval(() => loadJobs(true), 3000);
}

document.addEventListener('DOMContentLoaded', init);
