const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { modelDb, configDb, uploadDir, modelDir } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// 静态文件服务
app.use('/uploads', express.static(uploadDir));
app.use('/models', express.static(modelDir));

// Multer配置
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});
const upload = multer({ storage });

// ============ API 路由 ============

// 获取模型列表
app.get('/api/models', (req, res) => {
    try {
        const models = modelDb.list();
        res.json({ success: true, data: models });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取单个模型
app.get('/api/models/:id', (req, res) => {
    try {
        const model = modelDb.findById(req.params.id);
        if (!model) return res.status(404).json({ success: false, error: '模型不存在' });
        res.json({ success: true, data: model });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 上传图片并创建模型记录
app.post('/api/models/upload', upload.single('image'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, error: '请上传图片文件' });

        const result = modelDb.create({
            name: req.body.name || req.file.originalname,
            original_image: `/uploads/${req.file.filename}`,
            prompt: req.body.prompt || '',
            status: 'pending'
        });

        const newModel = modelDb.findById(result.lastInsertRowid);
        res.json({ success: true, data: newModel });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 调用SPU生成模型（GPU服务器上的SPU服务）
app.post('/api/models/:id/generate', async (req, res) => {
    try {
        const model = modelDb.findById(req.params.id);
        if (!model) return res.status(404).json({ success: false, error: '模型不存在' });

        const config = configDb.get();
        const spuUrl = process.env.SPU_API_URL || config.api_url;
        
        if (!spuUrl) {
            return res.status(400).json({ success: false, error: '请先配置SPU API地址' });
        }

        modelDb.update(model.id, { status: 'generating' });

        console.log(`[生成任务] 模型ID: ${model.id}`);
        console.log(`[SPU服务] ${spuUrl}`);
        console.log(`[原始图片] ${model.original_image}`);
        console.log(`[提示词] ${model.prompt}`);

        // ===== 对接GPU服务器上的SPU服务 =====
        try {
            // 1. 读取图片文件
            const imagePath = path.join(uploadDir, path.basename(model.original_image));
            const imageBuffer = fs.readFileSync(imagePath);

            // 2. 调用SPU API（GPU服务器上的建模服务）
            const formData = new FormData();
            formData.append('image', new Blob([imageBuffer]), path.basename(model.original_image));
            formData.append('prompt', model.prompt || '');

            const spuResponse = await fetch(spuUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.SPU_API_KEY || config.api_key}`
                },
                body: formData
            });

            const spuResult = await spuResponse.json();
            
            if (spuResult.model_url) {
                // 3. 下载生成的模型文件到本地存储
                const modelResponse = await fetch(spuResult.model_url);
                const modelBuffer = await modelResponse.arrayBuffer();
                
                const modelFileName = `model-${model.id}-${Date.now()}.glb`;
                const modelPath = path.join(modelDir, modelFileName);
                fs.writeFileSync(modelPath, Buffer.from(modelBuffer));

                // 4. 更新数据库
                modelDb.update(model.id, {
                    status: 'completed',
                    model_file: `/models/${modelFileName}`
                });

                console.log(`[完成] 模型 ${model.id} 已保存到 ${modelPath}`);
            } else {
                throw new Error('SPU服务未返回model_url');
            }
        } catch (spuError) {
            console.error('SPU调用失败:', spuError);
            modelDb.update(model.id, { status: 'failed' });
            throw spuError;
        }

        res.json({ success: true, message: '生成任务已启动' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 删除模型
app.delete('/api/models/:id', (req, res) => {
    try {
        const model = modelDb.findById(req.params.id);
        if (!model) return res.status(404).json({ success: false, error: '模型不存在' });

        // 删除文件
        if (model.original_image) {
            const imgPath = path.join(uploadDir, path.basename(model.original_image));
            if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
        }
        if (model.model_file) {
            const modelPath = path.join(modelDir, path.basename(model.model_file));
            if (fs.existsSync(modelPath)) fs.unlinkSync(modelPath);
        }

        modelDb.delete(req.params.id);
        res.json({ success: true, message: '模型已删除' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// SPU配置 - 获取
app.get('/api/config/spu', (req, res) => {
    try {
        const config = configDb.get();
        // 环境变量优先
        if (process.env.SPU_API_URL) {
            config.api_url = process.env.SPU_API_URL;
        }
        res.json({ success: true, data: config });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// SPU配置 - 保存
app.post('/api/config/spu', (req, res) => {
    try {
        const { api_url, api_key } = req.body;
        configDb.save({ api_url, api_key: api_key || '' });
        res.json({ success: true, message: '配置已保存' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 健康检查
app.get('/api/health', (req, res) => {
    res.json({ 
        success: true, 
        status: 'running',
        timestamp: new Date().toISOString()
    });
});

// 前端路由 - SPA fallback
app.use((req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 3D建模工作室服务器已启动`);
    console.log(`📍 端口: ${PORT}`);
    console.log(`📁 数据库: ${process.env.DB_PATH || 'db.json'}`);
    console.log(`📁 上传目录: ${uploadDir}`);
    console.log(`📁 模型目录: ${modelDir}`);
});
