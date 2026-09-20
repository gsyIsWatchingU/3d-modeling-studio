// 3D建模工作室 - 前端逻辑
let scene, camera, renderer, controls;
let currentModel = null;
let ambientLight, dirLight;
let currentModelId = null;
let wireframeMode = false;
let models = [];

// API基础路径
const API_BASE = '/api';

// 与 style.css 的 --pixel-* 令牌保持一致
const THEME = {
    stage: 0xecedE8,        // 视口背景（中性浅灰工作台）
    ground: 0xf7f7f2,       // 地面
    gridCenter: 0x858d86,   // 网格中心线
    gridLine: 0xb8beb8,     // 普通网格线
    demoMaterial: 0xc8cbc5  // 默认演示模型（中性 clay，品牌绿留给 UI 状态）
};

// 场景可选：?scene=light 或 0xRRGGBB
const _sceneParam = new URLSearchParams(location.search).get('scene');

// ============ 轻量弹窗（替代原生 alert） ============
// 原生 alert 无法套主题，且会阻塞渲染循环；这里用像素风方角面板
function showToast(message, options = {}) {
    const dialog = document.createElement('div');
    dialog.className = 'pixel-modal-backdrop';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', '提示');

    const panel = document.createElement('div');
    panel.className = 'pixel-modal';

    const title = document.createElement('h4');
    title.textContent = options.title || '提示';

    const body = document.createElement('p');
    body.textContent = String(message);

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'btn primary';
    okBtn.textContent = '确定';

    panel.append(title, body, okBtn);
    dialog.append(panel);
    document.body.append(dialog);

    let closed = false;
    const lastFocused = document.activeElement;

    function close() {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKeydown);
        dialog.remove();
        if (lastFocused && lastFocused.focus) lastFocused.focus();
    }

    function onKeydown(e) {
        if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            close();
        }
    }

    okBtn.addEventListener('click', close);
    dialog.addEventListener('click', (e) => {
        if (e.target === dialog) close();
    });
    document.addEventListener('keydown', onKeydown);

    okBtn.focus();

    return close;
}

// ============ Three.js 场景 ============
function initScene() {
    const container = document.querySelector('.viewport');
    const canvas = document.getElementById('canvas');

    scene = new THREE.Scene();
    scene.background = new THREE.Color(THEME.stage);
    // 浅色场景里雾会把远处模型洗白、直接吃掉对比度，这里给得很轻
    scene.fog = new THREE.Fog(THEME.stage, 28, 60);

    if (_sceneParam === 'light') {
        scene.fog = null;
    }

    camera = new THREE.PerspectiveCamera(60, container.clientWidth / container.clientHeight, 0.1, 1000);
    camera.position.set(3, 3, 5);

    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    // 灯光：弱环境光 + 稍强主光，靠明暗关系而不是整体提亮来塑造体积
    ambientLight = new THREE.AmbientLight(0xffffff, 0.38);
    scene.add(ambientLight);

    dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(5, 10, 5);
    dirLight.castShadow = true;
    scene.add(dirLight);

    // 地面
    const groundGeometry = new THREE.PlaneGeometry(20, 20);
    const groundMaterial = new THREE.MeshStandardMaterial({
        color: THEME.ground,
        roughness: 0.92,
        metalness: 0
    });
    const ground = new THREE.Mesh(groundGeometry, groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    const gridHelper = new THREE.GridHelper(20, 20, THEME.gridCenter, THEME.gridLine);
    scene.add(gridHelper);

    window.addEventListener('resize', onWindowResize);
    animate();
}

function onWindowResize() {
    const container = document.querySelector('.viewport');
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
}

function animate() {
    requestAnimationFrame(animate);
    // 阻尼模式需要每帧 update() 来应用旋转/平移输入；只按 autoRotate 判断会让手动拖拽失效
    controls.update();
    renderer.render(scene, camera);
}

// ============ 模型加载 ============
function loadDemoModel() {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial({
        color: THEME.demoMaterial,
        roughness: 0.7,
        metalness: 0.05
    });
    const cube = new THREE.Mesh(geometry, material);
    cube.castShadow = true;
    cube.position.y = 0.5;
    currentModel = cube;
    scene.add(cube);
}

async function loadModelFromUrl(url) {
    const loader = new THREE.GLTFLoader();
    
    if (currentModel) scene.remove(currentModel);

    return new Promise((resolve, reject) => {
        loader.load(url, (gltf) => {
            currentModel = gltf.scene;
            
            const box = new THREE.Box3().setFromObject(currentModel);
            const size = box.getSize(new THREE.Vector3());
            const center = box.getCenter(new THREE.Vector3());
            
            const maxDim = Math.max(size.x, size.y, size.z);
            const scale = 2 / maxDim;
            currentModel.scale.setScalar(scale);
            currentModel.position.x = -center.x * scale;
            currentModel.position.z = -center.z * scale;
            currentModel.position.y = -center.y * scale + 1;

            currentModel.traverse((child) => {
                if (child.isMesh) {
                    child.castShadow = true;
                    child.receiveShadow = true;
                }
            });

            scene.add(currentModel);
            resolve();
        }, undefined, reject);
    });
}

// ============ 模型列表 ============
async function fetchModels() {
    try {
        const res = await fetch(`${API_BASE}/models`);
        const data = await res.json();
        models = data.data || [];
        renderModelList();
    } catch (error) {
        console.error('获取模型列表失败:', error);
    }
}

function renderModelList() {
    const list = document.getElementById('modelList');
    
    if (models.length === 0) {
        list.innerHTML = '<div class="empty-state">暂无模型，上传图片生成第一个吧</div>';
        return;
    }

    list.innerHTML = models.map(m => `
        <div class="model-item ${m.id === currentModelId ? 'active' : ''}" data-id="${m.id}">
            <div class="model-item-name">${m.name}</div>
            <div class="model-item-time">
                ${new Date(m.created_at).toLocaleString()}
                <span class="status status-${m.status}">${getStatusText(m.status)}</span>
            </div>
        </div>
    `).join('');

    list.querySelectorAll('.model-item').forEach(item => {
        item.addEventListener('click', () => selectModel(parseInt(item.dataset.id)));
    });
}

function getStatusText(status) {
    const map = { pending: '待生成', generating: '生成中', completed: '已完成', failed: '失败' };
    return map[status] || status;
}

async function selectModel(id) {
    currentModelId = id;
    const model = models.find(m => m.id === id);
    
    if (model && model.model_file) {
        try {
            await loadModelFromUrl(model.model_file);
        } catch (error) {
            console.error('加载模型失败:', error);
        }
    }
    
    renderModelList();
}

// ============ 上传和生成 ============
function initUpload() {
    const uploadArea = document.getElementById('uploadArea');
    const fileInput = document.getElementById('fileInput');
    const previewImg = document.getElementById('previewImg');

    uploadArea.addEventListener('click', () => fileInput.click());

    uploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadArea.classList.add('dragover');
    });

    uploadArea.addEventListener('dragleave', () => {
        uploadArea.classList.remove('dragover');
    });

    uploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadArea.classList.remove('dragover');
        const file = e.dataTransfer.files[0];
        if (file && file.type.startsWith('image/')) handleImageFile(file);
    });

    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) handleImageFile(file);
    });

    function handleImageFile(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            previewImg.src = e.target.result;
            previewImg.hidden = false;
            uploadArea.querySelector('.upload-placeholder').style.display = 'none';
        };
        reader.readAsDataURL(file);
        window.selectedImage = file;
    }
}

async function generateModel() {
    const generateBtn = document.getElementById('generateBtn');
    const btnText = generateBtn.querySelector('.btn-text');
    const loading = generateBtn.querySelector('.loading');
    const prompt = document.getElementById('promptInput').value;

    if (!window.selectedImage) {
        showToast('请先上传一张图片', { title: '缺少输入' });
        return;
    }

    generateBtn.disabled = true;
    btnText.textContent = '上传中...';
    loading.hidden = false;

    try {
        // 1. 上传图片
        const formData = new FormData();
        formData.append('image', window.selectedImage);
        formData.append('name', window.selectedImage.name);
        formData.append('prompt', prompt);

        const uploadRes = await fetch(`${API_BASE}/models/upload`, {
            method: 'POST',
            body: formData
        });
        const uploadData = await uploadRes.json();
        
        if (!uploadData.success) throw new Error(uploadData.error);

        const modelId = uploadData.data.id;
        btnText.textContent = '生成中...';

        // 2. 调用生成
        const genRes = await fetch(`${API_BASE}/models/${modelId}/generate`, {
            method: 'POST'
        });
        const genData = await genRes.json();
        
        if (!genData.success) throw new Error(genData.error);

        btnText.textContent = '已提交，等待生成...';
        
        // 3. 轮询状态
        pollModelStatus(modelId);

    } catch (error) {
        console.error('生成失败:', error);
        showToast(`生成失败: ${error.message}`, { title: '错误' });
    } finally {
        generateBtn.disabled = false;
        btnText.textContent = '生成3D模型';
        loading.hidden = true;
    }
}

async function pollModelStatus(modelId) {
    const interval = setInterval(async () => {
        try {
            const res = await fetch(`${API_BASE}/models/${modelId}`);
            const data = await res.json();
            const model = data.data;

            if (model.status === 'completed') {
                clearInterval(interval);
                await fetchModels();
                await selectModel(modelId);
                showToast('模型生成完成', { title: '完成' });
            } else if (model.status === 'failed') {
                clearInterval(interval);
                await fetchModels();
                showToast('模型生成失败', { title: '错误' });
            }
        } catch (error) {
            console.error('轮询状态失败:', error);
        }
    }, 1000);
}

// ============ SPU配置 ============
async function loadSpuConfig() {
    try {
        const res = await fetch(`${API_BASE}/config/spu`);
        const data = await res.json();
        if (data.data) {
            document.getElementById('spuApiUrl').value = data.data.api_url || '';
            document.getElementById('spuApiKey').value = data.data.api_key || '';
        }
    } catch (error) {
        console.error('加载SPU配置失败:', error);
    }
}

async function saveSpuConfig() {
    const apiUrl = document.getElementById('spuApiUrl').value;
    const apiKey = document.getElementById('spuApiKey').value;

    try {
        const res = await fetch(`${API_BASE}/config/spu`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_url: apiUrl, api_key: apiKey })
        });
        const data = await res.json();
        if (data.success) {
            showToast('SPU 配置已保存', { title: '完成' });
        }
    } catch (error) {
        showToast('保存失败: ' + error.message, { title: '错误' });
    }
}

// ============ 材质/灯光/工具栏 ============
function initMaterialControls() {
    document.getElementById('materialColor').addEventListener('input', (e) => {
        if (currentModel) {
            currentModel.traverse(child => {
                if (child.isMesh && child.material.color) child.material.color.set(e.target.value);
            });
        }
    });

    document.getElementById('roughnessSlider').addEventListener('input', (e) => {
        document.getElementById('roughnessValue').textContent = e.target.value;
        if (currentModel) {
            currentModel.traverse(child => {
                if (child.isMesh && 'roughness' in child.material) {
                    child.material.roughness = parseFloat(e.target.value);
                }
            });
        }
    });

    document.getElementById('metalnessSlider').addEventListener('input', (e) => {
        document.getElementById('metalnessValue').textContent = e.target.value;
        if (currentModel) {
            currentModel.traverse(child => {
                if (child.isMesh && 'metalness' in child.material) {
                    child.material.metalness = parseFloat(e.target.value);
                }
            });
        }
    });
}

function initLightControls() {
    document.getElementById('ambientSlider').addEventListener('input', (e) => {
        document.getElementById('ambientValue').textContent = e.target.value;
        ambientLight.intensity = parseFloat(e.target.value);
    });

    document.getElementById('dirSlider').addEventListener('input', (e) => {
        document.getElementById('dirValue').textContent = e.target.value;
        dirLight.intensity = parseFloat(e.target.value);
    });
}

function initToolbar() {
    document.getElementById('resetCameraBtn').addEventListener('click', () => {
        camera.position.set(3, 3, 5);
        controls.target.set(0, 0, 0);
        controls.update();
    });

    document.getElementById('wireframeBtn').addEventListener('click', (e) => {
        wireframeMode = !wireframeMode;
        e.currentTarget.classList.toggle('active', wireframeMode);
        if (currentModel) {
            currentModel.traverse(child => {
                if (child.isMesh && 'wireframe' in child.material) {
                    child.material.wireframe = wireframeMode;
                }
            });
        }
    });

    document.getElementById('autoRotateBtn').addEventListener('click', (e) => {
        controls.autoRotate = !controls.autoRotate;
        e.currentTarget.classList.toggle('active', controls.autoRotate);
    });
}

function initExport() {
    document.getElementById('exportPngBtn').addEventListener('click', () => {
        renderer.render(scene, camera);
        const link = document.createElement('a');
        link.download = 'model-screenshot.png';
        link.href = renderer.domElement.toDataURL('image/png');
        link.click();
    });

    const notReady = (feature) => () => {
        showToast(`${feature} 尚未接入导出流程`, { title: '未实现' });
    };
    document.getElementById('exportGlbBtn').addEventListener('click', notReady('导出 GLB'));
    document.getElementById('exportObjBtn').addEventListener('click', notReady('导出 OBJ'));
}

// ============ 初始化 ============
document.addEventListener('DOMContentLoaded', async () => {
    initScene();
    initUpload();
    initMaterialControls();
    initLightControls();
    initToolbar();
    initExport();
    loadDemoModel();
    await loadSpuConfig();
    await fetchModels();

    document.getElementById('generateBtn').addEventListener('click', generateModel);
    document.getElementById('saveConfigBtn').addEventListener('click', saveSpuConfig);
});
