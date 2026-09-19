// 3D建模工作室 - 前端逻辑
let scene, camera, renderer, controls;
let currentModel = null;
let ambientLight, dirLight;
let currentModelId = null;
let wireframeMode = false;
let models = [];

// API基础路径
const API_BASE = '/api';

// ============ Three.js 场景 ============
function initScene() {
    const container = document.querySelector('.viewport');
    const canvas = document.getElementById('canvas');

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f0f1a);
    scene.fog = new THREE.Fog(0x0f0f1a, 10, 50);

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

    // 灯光
    ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
    dirLight.position.set(5, 10, 5);
    dirLight.castShadow = true;
    scene.add(dirLight);

    // 地面
    const groundGeometry = new THREE.PlaneGeometry(20, 20);
    const groundMaterial = new THREE.MeshStandardMaterial({ color: 0x1a1a2e, roughness: 0.8, metalness: 0.2 });
    const ground = new THREE.Mesh(groundGeometry, groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    const gridHelper = new THREE.GridHelper(20, 20, 0x333366, 0x222244);
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
    controls.update();
    renderer.render(scene, camera);
}

// ============ 模型加载 ============
function loadDemoModel() {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial({ color: 0x4a9eff, roughness: 0.5, metalness: 0.1 });
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
        alert('请先上传一张图片');
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
        alert(`生成失败: ${error.message}`);
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
                alert('模型生成完成！');
            } else if (model.status === 'failed') {
                clearInterval(interval);
                await fetchModels();
                alert('模型生成失败');
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
            alert('SPU配置已保存');
        }
    } catch (error) {
        alert('保存失败: ' + error.message);
    }
}

// ============ 材质/灯光/工具栏 ============
function initMaterialControls() {
    document.getElementById('materialColor').addEventListener('input', (e) => {
        if (currentModel) {
            currentModel.traverse(child => {
                if (child.isMesh) child.material.color.set(e.target.value);
            });
        }
    });

    document.getElementById('roughnessSlider').addEventListener('input', (e) => {
        document.getElementById('roughnessValue').textContent = e.target.value;
        if (currentModel) {
            currentModel.traverse(child => {
                if (child.isMesh) child.material.roughness = parseFloat(e.target.value);
            });
        }
    });

    document.getElementById('metalnessSlider').addEventListener('input', (e) => {
        document.getElementById('metalnessValue').textContent = e.target.value;
        if (currentModel) {
            currentModel.traverse(child => {
                if (child.isMesh) child.material.metalness = parseFloat(e.target.value);
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
        e.target.classList.toggle('active', wireframeMode);
        if (currentModel) {
            currentModel.traverse(child => {
                if (child.isMesh) child.material.wireframe = wireframeMode;
            });
        }
    });

    document.getElementById('autoRotateBtn').addEventListener('click', (e) => {
        controls.autoRotate = !controls.autoRotate;
        e.target.classList.toggle('active', controls.autoRotate);
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
