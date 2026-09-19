const fs = require('fs');
const path = require('path');

// 支持环境变量配置数据库路径
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'db.json');
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
const modelDir = process.env.MODEL_DIR || path.join(__dirname, '..', 'models');

// 确保目录存在
function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

ensureDir(path.dirname(dbPath));
ensureDir(uploadDir);
ensureDir(modelDir);

// 初始化数据库文件
function initDb() {
    if (!fs.existsSync(dbPath)) {
        const initialData = {
            models: [],
            spu_config: { api_url: '', api_key: '' },
            nextId: 1
        };
        fs.writeFileSync(dbPath, JSON.stringify(initialData, null, 2));
    }
}

initDb();

// 读取数据库
function readDb() {
    const raw = fs.readFileSync(dbPath, 'utf-8');
    return JSON.parse(raw);
}

// 写入数据库
function writeDb(data) {
    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
}

// 模型操作
const modelDb = {
    create: (data) => {
        const db = readDb();
        const id = db.nextId++;
        const model = {
            id,
            name: data.name,
            original_image: data.original_image,
            prompt: data.prompt || '',
            status: data.status || 'pending',
            model_file: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };
        db.models.push(model);
        writeDb(db);
        return { lastInsertRowid: id };
    },

    update: (id, data) => {
        const db = readDb();
        const model = db.models.find(m => m.id === parseInt(id));
        if (model) {
            Object.assign(model, data, { updated_at: new Date().toISOString() });
            writeDb(db);
        }
    },

    findById: (id) => {
        const db = readDb();
        return db.models.find(m => m.id === parseInt(id));
    },

    list: () => {
        const db = readDb();
        return [...db.models].sort((a, b) => 
            new Date(b.created_at) - new Date(a.created_at)
        );
    },

    delete: (id) => {
        const db = readDb();
        db.models = db.models.filter(m => m.id !== parseInt(id));
        writeDb(db);
    }
};

// SPU配置操作
const configDb = {
    get: () => {
        const db = readDb();
        return db.spu_config;
    },

    save: (data) => {
        const db = readDb();
        db.spu_config = { ...data, updated_at: new Date().toISOString() };
        writeDb(db);
    }
};

module.exports = { modelDb, configDb, dbPath, uploadDir, modelDir };
