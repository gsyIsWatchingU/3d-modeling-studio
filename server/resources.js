'use strict';

// ---------- 建模资源库（Resources）----------
// 整理 GPU 服务器与本机上的建模资源（模型 GLB、参考图、贴图、预览图、音频等），
// 统一登记到 db.json 的 resources 集合，通过网页跨机器共享（数据与上传文件都落在服务器）。
//
// source 语义：
//   gpu     —— GPU 服务器目录中的资源（扫描/登记产生，file_path 为服务器绝对路径）
//   local   —— 本机目录中的资源（登记产生，仅清单 + 本机路径，未同步文件）
//   upload  —— 已上传到服务器 data/resources/ 的资源（url 可跨机器直接访问）

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { resourceDb, modelDb, jobDb } = require('./db');
const { detectImageType, validateGlbBuffer } = require('./utils');

const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;
const SCAN_MAX_FILES = 3000;      // 单次扫描文件上限，防止 exports 大目录拖垮接口
const SCAN_MAX_DEPTH = 4;         // 递归深度上限

const KINDS = [
    { id: 'model', name: '模型（GLB/OBJ/FBX）' },
    { id: 'image', name: '预览图' },
    { id: 'reference', name: '参考图' },
    { id: 'texture', name: '贴图' },
    { id: 'audio', name: '音频' },
    { id: 'archive', name: '压缩包/工程' },
    { id: 'other', name: '其他' }
];
const SOURCES = [
    { id: 'gpu', name: 'GPU 服务器' },
    { id: 'local', name: '本机' },
    { id: 'upload', name: '已上传' }
];

const MIME_TYPES = {
    '.glb': 'model/gltf-binary',
    '.obj': 'text/plain',
    '.fbx': 'application/octet-stream',
    '.blend': 'application/octet-stream',
    '.stl': 'application/octet-stream',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.zip': 'application/zip',
    '.rar': 'application/x-rar-compressed',
    '.7z': 'application/x-7z-compressed',
    '.json': 'application/json',
    '.md': 'text/markdown',
    '.txt': 'text/plain'
};

const UPLOAD_ALLOWED_EXTS = new Set([
    '.glb', '.obj', '.fbx', '.blend', '.stl',
    '.png', '.jpg', '.jpeg', '.webp',
    '.wav', '.mp3', '.ogg', '.flac',
    '.zip', '.rar', '.7z'
]);

function extOf(filename) {
    return path.extname(String(filename || '').toLowerCase());
}

function kindByExt(ext, context = {}) {
    const modelExts = ['.glb', '.obj', '.fbx', '.blend', '.stl'];
    if (modelExts.includes(ext)) return 'model';
    if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
        if (context.dir === 'uploads') return 'reference';
        // mp-assets / exports 内的 png：preview/draft 归预览图，其余按贴图
        if (/preview|draft|thumb/i.test(context.fileName || '')) return 'image';
        return 'texture';
    }
    if (['.wav', '.mp3', '.ogg', '.flac'].includes(ext)) return 'audio';
    if (['.zip', '.rar', '.7z'].includes(ext)) return 'archive';
    return 'other';
}

function humanNameFromPath(filePath, baseDir) {
    const rel = path.relative(baseDir, filePath).split(path.sep).join('/');
    return rel || path.basename(filePath);
}

function safeDir(base, target) {
    const baseResolved = path.resolve(base);
    const targetResolved = path.resolve(target);
    return targetResolved === baseResolved || targetResolved.startsWith(baseResolved + path.sep);
}

function collectFiles(dir, { maxDepth = SCAN_MAX_DEPTH, maxFiles = SCAN_MAX_FILES, skip = [] } = {}) {
    const results = [];
    const seen = new Set();
    const walk = (current, depth) => {
        if (results.length >= maxFiles || depth > maxDepth) return;
        let entries;
        try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            if (results.length >= maxFiles) return;
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                if (skip.includes(entry.name)) continue;
                walk(full, depth + 1);
            } else if (entry.isFile()) {
                if (seen.has(full)) continue;
                seen.add(full);
                const stat = fs.statSync(full);
                if (stat.isFile() && stat.size > 0) results.push({ full, size: stat.size });
            }
        }
    };
    walk(dir, 0);
    return results;
}

// 扫描单个目录并按规则入库；返回 { dir, label, found, added }
function scanAndUpsert({ dir, label, source, origin, kindContext = {}, maxDepth, maxFiles }) {
    if (!dir || !fs.existsSync(dir)) return { dir, label, found: 0, added: 0 };
    const files = collectFiles(dir, { maxDepth, maxFiles });
    let added = 0;
    const existingPaths = new Set();
    for (const file of files) {
        const ext = extOf(file.full);
        if (ext === '.json') continue; // 质检/元数据文件不入库
        const kind = kindByExt(ext, { ...kindContext, fileName: path.basename(file.full) });
        const relName = humanNameFromPath(file.full, dir);
        let name = relName;
        let mpId = null;
        let jobId = null;
        let tags = [];
        // mp-assets 结构：MP-xxxx/Txxxxxx/<stage>.ext
        const mpMatch = path.relative(dir, file.full).split(path.sep).filter(Boolean);
        if (mpMatch.length >= 2 && /^MP-\d+$/.test(mpMatch[0])) {
            mpId = mpMatch[0];
            tags = [mpMatch[1], path.basename(file.full, path.extname(file.full))];
            name = `${mpId} / ${mpMatch.slice(1).join('/')}`;
        }
        // data/models 正式产物：关联原建模任务
        if (kind === 'model' && origin?.dir === 'models') {
            const model = modelDb.list().find(m => m.model_file === `/models/${path.basename(file.full)}`);
            if (model) jobId = model.job_id;
        }
        // data/uploads 参考图：按文件名匹配任务输入图
        if (kind === 'reference' && origin?.dir === 'uploads') {
            const basename = path.basename(file.full);
            const job = jobDb.listAll().find(item => (item.input?.images || []).includes(basename));
            if (job) jobId = job.id;
        }
        const { created } = resourceDb.upsertByPath(source, file.full, {
            name,
            kind,
            ext,
            size: file.size,
            tags,
            job_id: jobId,
            mp_id: mpId,
            origin
        });
        if (created) added += 1;
        existingPaths.add(file.full);
    }
    return { dir, label, found: files.length, added, existingPaths };
}

function createResourcesRouter(options = {}) {
    const uploadDir = options.uploadDir;
    const modelDir = options.modelDir;
    const resourceDir = options.resourceDir;   // 上传文件落盘目录（服务器 = data/resources）
    const mpAssetsDir = options.mpAssetsDir;
    const assetRoot = options.assetRoot;       // GPU Forge3D 资产根（env FORGE3D_ASSET_ROOT）

    if (!fs.existsSync(resourceDir)) fs.mkdirSync(resourceDir, { recursive: true });

    // 允许被 /files/:id 直接读取的目录（防止登记任意系统路径后被当作静态文件外泄）
    const allowedRoots = [resourceDir, uploadDir, modelDir, mpAssetsDir, assetRoot]
        .filter(Boolean)
        .map(dir => path.resolve(dir));

    const router = express.Router();

    // 元信息：类型/来源枚举 + 本机可扫描目录（供前端渲染筛选与扫描选项）
    router.get('/meta', (req, res) => {
        res.json({
            success: true,
            data: {
                kinds: KINDS,
                sources: SOURCES,
                scan_dirs: [
                    ...(fs.existsSync(modelDir) ? [{ id: 'models', name: '正式模型（data/models）', path: modelDir }] : []),
                    ...(fs.existsSync(uploadDir) ? [{ id: 'uploads', name: '参考图（data/uploads）', path: uploadDir }] : []),
                    ...(fs.existsSync(mpAssetsDir) ? [{ id: 'mp-assets', name: '并行建模资产（data/mp-assets）', path: mpAssetsDir }] : []),
                    ...(assetRoot && fs.existsSync(path.join(assetRoot, 'exports')) ? [{ id: 'exports', name: 'GPU 导出资产（3d-assets/exports）', path: path.join(assetRoot, 'exports') }] : [])
                ]
            }
        });
    });

    // 列表：可选 kind / source / q（名称、标签、备注）
    router.get('/', (req, res) => {
        const kind = req.query.kind ? String(req.query.kind) : '';
        const source = req.query.source ? String(req.query.source) : '';
        const q = String(req.query.q || '').trim().toLowerCase();
        let list = resourceDb.list();
        if (kind) list = list.filter(item => item.kind === kind);
        if (source) list = list.filter(item => item.source === source);
        if (q) list = list.filter(item =>
            String(item.name).toLowerCase().includes(q) ||
            (item.tags || []).some(tag => String(tag).toLowerCase().includes(q)) ||
            String(item.note || '').toLowerCase().includes(q));
        res.json({ success: true, data: list });
    });

    // 手动登记（不传文件）：记录 GPU/本机资源清单
    router.post('/', (req, res) => {
        try {
            const body = req.body || {};
            const source = ['gpu', 'local', 'upload'].includes(body.source) ? body.source : 'local';
            const filePath = String(body.file_path || '').trim();
            const ext = extOf(body.file_name || filePath || '');
            const resource = resourceDb.create({
                name: body.name,
                kind: body.kind || (ext ? kindByExt(ext) : 'other'),
                source,
                ext: ext || null,
                size: body.size !== undefined && Number.isFinite(Number(body.size)) ? Math.max(0, Number(body.size)) : null,
                file_path: filePath || null,
                url: body.url ? String(body.url).trim().slice(0, 500) : null,
                tags: body.tags,
                note: body.note,
                origin: { machine: body.machine, dir: body.dir }
            });
            res.status(201).json({ success: true, data: resource });
        } catch (error) {
            res.status(400).json({ success: false, error: error.message });
        }
    });

    // 上传文件入库：文件落 data/resources/，图片/模型可直接在线预览，跨机器可访问
    const uploadStorage = multer.diskStorage({
        destination: (req, file, callback) => callback(null, resourceDir),
        filename: (req, file, callback) => callback(null, `${crypto.randomUUID()}.upload`)
    });
    const uploadMiddleware = multer({
        storage: uploadStorage,
        limits: { files: 1, fileSize: MAX_UPLOAD_SIZE, fields: 10 }
    });

    router.post('/upload', uploadMiddleware.single('file'), (req, res) => {
        const uploaded = req.file;
        const cleanup = () => { if (uploaded?.path && fs.existsSync(uploaded.path)) { try { fs.unlinkSync(uploaded.path); } catch {} } };
        try {
            if (!uploaded) throw new Error('请选择要上传的资源文件（不超过 50 MB）');
            const header = fs.readFileSync(uploaded.path).subarray(0, 64);
            let ext = extOf(uploaded.originalname);
            const isImage = detectImageType(header);
            if (isImage) {
                ext = isImage.ext;
            } else if (ext === '.glb') {
                validateGlbBuffer(fs.readFileSync(uploaded.path));
            }
            if (!UPLOAD_ALLOWED_EXTS.has(ext)) {
                throw new Error(`不支持的文件类型 ${ext || '(未知)'}，仅支持 GLB/OBJ/FBX/BLEND/STL、图片、音频与压缩包`);
            }
            const storedName = `${crypto.randomUUID()}${ext}`;
            const storedPath = path.join(resourceDir, storedName);
            fs.renameSync(uploaded.path, storedPath);
            const stat = fs.statSync(storedPath);
            const sha256 = stat.size <= 30 * 1024 * 1024
                ? crypto.createHash('sha256').update(fs.readFileSync(storedPath)).digest('hex')
                : null;
            const created = resourceDb.create({
                name: bodyName(req.body, uploaded.originalname),
                kind: req.body.kind || kindByExt(ext),
                source: 'upload',
                ext,
                size: stat.size,
                sha256,
                file_path: storedName,              // 相对 resourceDir 的文件名
                url: null,                          // 创建后由 update 补全 /api/resources/files/:id
                tags: req.body.tags,
                note: req.body.note,
                origin: { machine: 'upload', dir: 'data/resources' }
            });
            // url 里补上 id（记录创建后才能拿到 id）
            const withUrl = resourceDb.update(created.id, { url: `/api/resources/files/${created.id}` });
            res.status(201).json({ success: true, data: withUrl });
        } catch (error) {
            cleanup();
            res.status(400).json({ success: false, error: error.message });
        }
    });

    // 更新：名称 / 类型 / 标签 / 备注 / 关联任务
    router.put('/:id', (req, res) => {
        const updated = resourceDb.update(req.params.id, {
            name: req.body?.name,
            kind: req.body?.kind,
            tags: req.body?.tags,
            note: req.body?.note,
            job_id: req.body?.job_id,
            mp_id: req.body?.mp_id
        });
        if (!updated) return res.status(404).json({ success: false, error: '资源不存在' });
        res.json({ success: true, data: updated });
    });

    // 删除登记；?delete_file=1 且是 upload 资源时同时删除服务器上的文件
    router.delete('/:id', (req, res) => {
        const resource = resourceDb.findById(req.params.id);
        if (!resource) return res.status(404).json({ success: false, error: '资源不存在' });
        let deletedFile = false;
        if (req.query.delete_file === '1' && resource.source === 'upload' && resource.file_path) {
            const filePath = path.join(resourceDir, path.basename(resource.file_path));
            if (safeDir(resourceDir, filePath) && fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                deletedFile = true;
                try { fs.rmdirSync(path.dirname(filePath)); } catch {}
            }
        }
        resourceDb.delete(resource.id);
        res.json({ success: true, data: { deleted_file: deletedFile } });
    });

    // 扫描服务器（或本机）目录，自动整理入库（幂等：同 source+路径只刷新，不重复登记）
    router.post('/scan', (req, res) => {
        try {
            const source = (process.env.FORGE3D_ASSET_ROOT || process.env.RESOURCE_SOURCE === 'gpu') ? 'gpu' : 'local';
            const machine = source === 'gpu' ? 'GPU 服务器' : '本机';
            const requested = Array.isArray(req.body?.dirs) ? req.body.dirs.filter(Boolean) : [];
            const targets = [];
            if (!requested.length || requested.includes('models')) {
                targets.push({ key: 'models', dir: modelDir, label: '正式模型（data/models）', origin: { machine, dir: 'models' }, maxDepth: 1 });
            }
            if (!requested.length || requested.includes('uploads')) {
                targets.push({ key: 'uploads', dir: uploadDir, label: '参考图（data/uploads）', origin: { machine, dir: 'uploads' }, maxDepth: 1 });
            }
            if (!requested.length || requested.includes('mp-assets')) {
                targets.push({ key: 'mp-assets', dir: mpAssetsDir, label: '并行建模资产（data/mp-assets）', origin: { machine, dir: 'mp-assets' }, maxDepth: 4 });
            }
            if (!requested.length || requested.includes('exports')) {
                const exportsDir = assetRoot ? path.join(assetRoot, 'exports') : null;
                if (exportsDir) targets.push({ key: 'exports', dir: exportsDir, label: 'GPU 导出资产（3d-assets/exports）', origin: { machine, dir: 'exports' }, maxDepth: 3 });
            }
            const results = [];
            const existingPaths = new Set();
            for (const target of targets) {
                const result = scanAndUpsert({
                    dir: target.dir,
                    label: target.label,
                    source,
                    origin: target.origin,
                    maxDepth: target.maxDepth
                });
                results.push({ key: target.key, dir: result.dir, label: result.label, found: result.found, added: result.added });
                for (const filePath of result.existingPaths) existingPaths.add(filePath);
            }
            const missing = resourceDb.markMissing(source, existingPaths);
            const added = results.reduce((sum, r) => sum + r.added, 0);
            const found = results.reduce((sum, r) => sum + r.found, 0);
            res.json({
                success: true,
                data: {
                    source,
                    machine,
                    targets: results,
                    totals: { found, added, missing, total: resourceDb.list().length }
                }
            });
        } catch (error) {
            res.status(400).json({ success: false, error: error.message });
        }
    });

    // 资源文件访问（inline 预览 / ?download=1 下载）
    router.get('/files/:id', (req, res) => {
        const resource = resourceDb.findById(req.params.id);
        if (!resource) return res.status(404).json({ success: false, error: '资源不存在' });
        let filePath = null;
        if (resource.source === 'upload' && resource.file_path) {
            filePath = path.join(resourceDir, path.basename(resource.file_path));
        } else if (resource.file_path && fs.existsSync(resource.file_path)) {
            filePath = resource.file_path;
        }
        if (!filePath) return res.status(404).json({ success: false, error: '资源文件不存在或仅登记了路径（未同步文件）' });
        if (!allowedRoots.some(root => safeDir(root, filePath))) {
            return res.status(403).json({ success: false, error: '文件不在允许的资源目录内' });
        }
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            return res.status(404).json({ success: false, error: '资源文件不存在' });
        }
        const stat = fs.statSync(filePath);
        const ext = extOf(filePath) || resource.ext || '';
        res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
        res.setHeader('Content-Length', stat.size);
        res.setHeader('Cache-Control', 'private, max-age=60');
        if (req.query.download === '1') {
            const extName = ext || '';
            res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${resource.name}${extName}`)}`);
        }
        // 用流式响应替代 res.sendFile（Windows 上 send 模块对部分绝对路径误报 NotFound）
        const stream = fs.createReadStream(filePath);
        stream.on('error', error => {
            console.error(`[资源库] 文件流错误 ${filePath}: ${error.message}`);
            if (!res.headersSent) res.status(500).json({ success: false, error: '资源文件读取失败' });
            else res.end();
        });
        stream.pipe(res);
    });

    return router;
};

function bodyName(body, fallback) {
    const name = String(body?.name || '').trim();
    if (name) return name;
    const original = String(fallback || '').replace(/\.[^.]+$/, '').trim();
    return original || '上传资源';
}

module.exports = { createResourcesRouter };
