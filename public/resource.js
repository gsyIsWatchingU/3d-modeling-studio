// ---------- 建模资源库（Resources）前端 ----------
// 展示 GPU 服务器 / 本机 / 已上传的建模资源；数据存服务器 db.json，任何机器登录后同步可见。
(function () {
    const state = {
        meta: { kinds: [], sources: [], scan_dirs: [] },
        list: [],
        kind: '',
        source: '',
        q: '',
        editingId: null
    };

    const KIND_ICON = { model: '3D', image: 'IMG', reference: 'REF', texture: 'TEX', audio: 'AUD', archive: 'ZIP', other: '···' };
    const SOURCE_LABEL = { gpu: 'GPU', local: '本机', upload: '已上传' };
    const KIND_LABEL = {};
    const SOURCE_META = {};

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    }

    function formatBytes(bytes) {
        if (!bytes && bytes !== 0) return '';
        if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    function formatDate(value) {
        if (!value) return '';
        const date = new Date(value);
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }

    async function api(path, options = {}) {
        const response = await fetch(`/api/resources${path}`, options);
        if (response.status === 401) {
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

    function openDialog(id) {
        document.getElementById(id).showModal();
    }
    function closeDialog(id) {
        document.getElementById(id).close();
    }

    async function loadMeta() {
        state.meta = await api('/meta');
        const kindSelect = document.getElementById('resourceKindFilter');
        kindSelect.replaceChildren();
        kindSelect.append(new Option('全部类型', ''));
        for (const kind of state.meta.kinds) {
            KIND_LABEL[kind.id] = kind.name;
            kindSelect.append(new Option(kind.name, kind.id));
        }
        const sourceSelect = document.getElementById('resourceSourceFilter');
        sourceSelect.replaceChildren();
        sourceSelect.append(new Option('全部来源', ''));
        for (const source of state.meta.sources) {
            SOURCE_META[source.id] = source.name;
            sourceSelect.append(new Option(source.name, source.id));
        }
        const registerKind = document.getElementById('resourceKindInput');
        registerKind.replaceChildren();
        for (const kind of state.meta.kinds) registerKind.append(new Option(kind.name, kind.id));
    }

    async function loadResources() {
        const params = new URLSearchParams();
        if (state.kind) params.set('kind', state.kind);
        if (state.source) params.set('source', state.source);
        if (state.q) params.set('q', state.q);
        state.list = await api(`/?${params.toString()}`);
        renderGrid();
    }

    function renderGrid() {
        const grid = document.getElementById('resourceGrid');
        document.getElementById('resourceCount').textContent = `${state.list.length} 条资源`;
        if (!state.list.length) {
            grid.innerHTML = '<div class="empty-list">还没有资源。点击「扫描服务器目录」自动整理 GPU/本机产物，或「登记 / 上传」手动添加。</div>';
            return;
        }
        const frag = document.createDocumentFragment();
        for (const resource of state.list) {
            frag.append(buildCard(resource));
        }
        grid.replaceChildren(frag);
    }

    function thumbFor(resource) {
        const previewable = resource.url && ['image', 'reference', 'texture'].includes(resource.kind);
        if (previewable) {
            return `<img src="${escapeHtml(resource.url)}" alt="${escapeHtml(resource.name)}" loading="lazy">`;
        }
        return `<span class="library-thumb-icon">${KIND_ICON[resource.kind] || '···'}</span>`;
    }

    function buildCard(resource) {
        const card = document.createElement('article');
        card.className = `library-card${resource.missing ? ' missing' : ''}`;
        card.dataset.id = resource.id;

        const kindName = KIND_LABEL[resource.kind] || resource.kind || '其他';
        const sourceName = (SOURCE_META[resource.source] || SOURCE_LABEL[resource.source] || resource.source || '');
        const tags = (resource.tags || []).map(tag => `<span class="library-tag">${escapeHtml(tag)}</span>`).join('');
        const metaLine = [
            `<span class="library-badge kind">${escapeHtml(kindName.split('（')[0])}</span>`,
            `<span class="library-badge source-${escapeHtml(resource.source)}">${escapeHtml(sourceName)}</span>`,
            resource.size ? `<span>${formatBytes(resource.size)}</span>` : '',
            resource.missing ? `<span class="library-badge missing-badge">文件缺失</span>` : ''
        ].filter(Boolean).join('');

        card.innerHTML = `
            <div class="library-thumb">${thumbFor(resource)}</div>
            <div class="library-card-body">
                <h3 title="${escapeHtml(resource.name)}">${escapeHtml(resource.name)}</h3>
                <div class="library-meta">${metaLine}</div>
                ${tags ? `<div class="library-tags">${tags}</div>` : ''}
                ${resource.note ? `<p class="library-note">${escapeHtml(resource.note)}</p>` : ''}
                <p class="library-time">${formatDate(resource.updated_at)}${resource.origin?.machine ? ` · ${escapeHtml(resource.origin.machine)}` : ''}${resource.mp_id ? ` · ${escapeHtml(resource.mp_id)}` : ''}</p>
                <div class="library-actions">
                    ${resource.url ? `<button class="text-button" data-act="preview" type="button">预览</button><a class="text-button" href="${escapeHtml(resource.url)}?download=1" download>下载</a>` : ''}
                    <button class="text-button" data-act="edit" type="button">编辑</button>
                    <button class="text-button danger" data-act="delete" type="button">删除</button>
                </div>
            </div>`;

        card.addEventListener('click', event => {
            const button = event.target.closest('[data-act]');
            if (!button) return;
            const act = button.dataset.act;
            if (act === 'preview') previewResource(resource);
            else if (act === 'edit') openRegisterDialog(resource);
            else if (act === 'delete') deleteResource(resource);
        });
        return card;
    }

    function previewResource(resource) {
        if (!resource.url) return;
        if (resource.kind === 'model' && (resource.ext === '.glb')) {
            closeDialog('libraryDialog');
            if (typeof loadModel === 'function') {
                loadModel(resource.url).catch(() => showToast('模型加载失败', true));
            } else {
                window.open(resource.url, '_blank');
            }
        } else if (['image', 'reference', 'texture'].includes(resource.kind)) {
            window.open(resource.url, '_blank');
        } else if (resource.kind === 'audio') {
            try {
                const audio = new Audio(resource.url);
                audio.play();
            } catch {
                window.open(resource.url, '_blank');
            }
        } else {
            window.open(`${resource.url}?download=1`, '_blank');
        }
    }

    async function deleteResource(resource) {
        if (!window.confirm(`删除资源「${resource.name}」？${resource.source === 'upload' ? '\n（将同时删除服务器上的文件）' : '（仅删除登记记录，不删原始文件）'}`)) return;
        try {
            await api(`/${resource.id}?delete_file=1`, { method: 'DELETE' });
            showToast('已删除');
            await loadResources();
        } catch (error) {
            showToast(error.message, true);
        }
    }

    async function scanResources() {
        const button = document.getElementById('scanResourcesBtn');
        button.disabled = true;
        button.textContent = '扫描中…';
        try {
            const result = await api('/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
            const byTarget = result.targets.map(item => `${item.label}: 发现 ${item.found} / 新增 ${item.added}`).join('；');
            showToast(`扫描完成：共发现 ${result.totals.found} 个文件，新增入库 ${result.totals.added}，标记缺失 ${result.totals.missing}（${byTarget}）`);
            await loadResources();
        } catch (error) {
            showToast(`扫描失败：${error.message}`, true);
        } finally {
            button.disabled = false;
            button.textContent = '扫描服务器目录';
        }
    }

    function openRegisterDialog(resource = null) {
        state.editingId = resource ? resource.id : null;
        const title = document.getElementById('registerDialogTitle');
        const kicker = document.getElementById('registerDialogKicker');
        const fileGroup = document.getElementById('resourceFileGroup');
        const pathGroup = document.getElementById('resourcePathGroup');
        const sourceInput = document.getElementById('resourceSourceInput');

        document.getElementById('resourceNameInput').value = resource?.name || '';
        document.getElementById('resourceKindInput').value = resource?.kind || 'model';
        sourceInput.value = resource?.source || 'upload';
        document.getElementById('resourcePathInput').value = resource?.file_path || '';
        document.getElementById('resourceMachineInput').value = resource?.origin?.machine || '';
        document.getElementById('resourceTagsInput').value = (resource?.tags || []).join(', ');
        document.getElementById('resourceNoteInput').value = resource?.note || '';
        document.getElementById('resourceFileInput').value = '';

        toggleSourceFields(sourceInput.value);
        if (resource?.source === 'upload' && resource.url) {
            const machineInput = document.getElementById('resourceMachineInput');
            machineInput.value = machineInput.value || '已上传到服务器';
        }

        title.textContent = resource ? '编辑资源' : '登记 / 上传建模资源';
        kicker.textContent = resource ? `资源 #${resource.id}` : '登记资源';
        sourceInput.disabled = Boolean(resource);
        document.getElementById('saveResourceBtn').textContent = resource ? '保存修改' : '保存';
        openDialog('registerDialog');
    }

    function toggleSourceFields(source) {
        const isUpload = source === 'upload';
        document.getElementById('resourceFileGroup').hidden = !isUpload;
        document.getElementById('resourcePathGroup').hidden = isUpload;
    }

    async function saveResource() {
        const payload = {
            name: document.getElementById('resourceNameInput').value.trim(),
            kind: document.getElementById('resourceKindInput').value,
            tags: document.getElementById('resourceTagsInput').value.split(/[,，]/).map(tag => tag.trim()).filter(Boolean),
            note: document.getElementById('resourceNoteInput').value.trim()
        };
        const source = document.getElementById('resourceSourceInput').value;
        try {
            if (source === 'upload') {
                const fileInput = document.getElementById('resourceFileInput');
                if (state.editingId) {
                    const updated = await api(`/${state.editingId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                    showToast('已保存修改');
                } else {
                    if (!fileInput.files.length) throw new Error('上传资源请先选择文件');
                    const form = new FormData();
                    form.append('file', fileInput.files[0]);
                    form.append('name', payload.name);
                    form.append('kind', payload.kind);
                    form.append('tags', JSON.stringify(payload.tags));
                    form.append('note', payload.note);
                    const created = await api('/upload', { method: 'POST', body: form });
                    showToast(`已上传并入库「${created.name}」`);
                }
            } else {
                payload.source = source;
                payload.file_path = document.getElementById('resourcePathInput').value.trim();
                payload.machine = document.getElementById('resourceMachineInput').value.trim();
                if (!payload.file_path) throw new Error('请填写文件路径');
                if (state.editingId) {
                    await api(`/${state.editingId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                    showToast('已保存修改');
                } else {
                    await api('/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                    showToast('已登记资源');
                }
            }
            closeDialog('registerDialog');
            await loadResources();
        } catch (error) {
            showToast(error.message, true);
        }
    }

    function bindEvents() {
        document.getElementById('openLibraryBtn').addEventListener('click', () => {
            openDialog('libraryDialog');
            loadResources().catch(error => showToast(error.message, true));
        });
        document.getElementById('closeLibraryBtn').addEventListener('click', () => closeDialog('libraryDialog'));
        document.getElementById('scanResourcesBtn').addEventListener('click', scanResources);
        document.getElementById('registerResourceBtn').addEventListener('click', () => openRegisterDialog());
        document.getElementById('resourceSearch').addEventListener('input', event => {
            state.q = event.target.value.trim();
            loadResources().catch(error => showToast(error.message, true));
        });
        document.getElementById('resourceKindFilter').addEventListener('change', event => {
            state.kind = event.target.value;
            loadResources().catch(error => showToast(error.message, true));
        });
        document.getElementById('resourceSourceFilter').addEventListener('change', event => {
            state.source = event.target.value;
            loadResources().catch(error => showToast(error.message, true));
        });
        document.getElementById('closeRegisterBtn').addEventListener('click', () => closeDialog('registerDialog'));
        document.getElementById('cancelRegisterBtn').addEventListener('click', () => closeDialog('registerDialog'));
        document.getElementById('saveResourceBtn').addEventListener('click', saveResource);
        document.getElementById('resourceSourceInput').addEventListener('change', event => toggleSourceFields(event.target.value));
        // 防止 dialog 内部点击冒泡关闭
        for (const id of ['libraryDialog', 'registerDialog']) {
            document.getElementById(id).addEventListener('click', event => {
                if (event.target === document.getElementById(id)) event.stopPropagation();
            });
        }
    }

    function init() {
        bindEvents();
        loadMeta().catch(() => { /* 资源库未就绪时先允许打开空面板 */ });
    }

    document.addEventListener('DOMContentLoaded', init);
})();
