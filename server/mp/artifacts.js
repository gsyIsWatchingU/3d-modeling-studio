'use strict';

// ---------- 多节点并行建模（Multi-GPU）产物存储 ----------
// 临时文件 → 大小/SHA-256 校验 → 原子改名；记录传输来源（发送/接收主机、任务、时间）。

const fs = require('fs');
const path = require('path');
const { mpAssetDir, sha256Hex, recordTransfer } = require('./store');
const { validateGlbBuffer } = require('../utils');

const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024; // 1 GB

function taskDir(parentId, taskId) {
    return path.join(mpAssetDir, parentId, taskId);
}

// 任务目录内写入产物；同名已存在且 SHA 一致则视为幂等重传
function saveArtifact({ parentId, taskId, fileName, buffer, fromHost, transferNote }) {
    const dir = taskDir(parentId, taskId);
    fs.mkdirSync(dir, { recursive: true });
    const sha = sha256Hex(buffer);
    const finalPath = path.join(dir, fileName);
    const tempPath = path.join(dir, `.${fileName}.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tempPath, buffer);
    const actualSize = fs.statSync(tempPath).size;
    if (actualSize !== buffer.length) {
        fs.unlinkSync(tempPath);
        throw new Error('产物写入大小不一致');
    }
    const actualSha = sha256Hex(fs.readFileSync(tempPath));
    if (actualSha !== sha) {
        fs.unlinkSync(tempPath);
        throw new Error(`产物 SHA-256 校验失败: ${fileName}`);
    }
    if (fs.existsSync(finalPath)) {
        // 幂等重传：内容一致则保留原文件；内容不同则拒绝覆盖
        const existingSha = sha256Hex(fs.readFileSync(finalPath));
        if (existingSha !== sha) throw new Error(`产物已存在且内容不一致，拒绝覆盖: ${fileName}`);
        fs.unlinkSync(tempPath);
    } else {
        fs.renameSync(tempPath, finalPath);
    }
    recordTransfer({
        parentJobId: parentId,
        taskId,
        fileName,
        fromHost: fromHost || 'unknown',
        toHost: 'control-plane',
        bytes: buffer.length,
        sha256: sha,
        note: transferNote || 'upload'
    });
    return { fileName, bytes: buffer.length, sha256: sha, path: `/api/mp/artifacts/${parentId}/${taskId}/${encodeURIComponent(fileName)}` };
}

function readArtifactBuffer(parentId, taskId, fileName) {
    const filePath = path.join(taskDir(parentId, taskId), path.basename(fileName));
    if (!fs.existsSync(filePath)) return null;
    const buffer = fs.readFileSync(filePath);
    if (buffer.length > MAX_ARTIFACT_BYTES) throw new Error('产物文件超过 1 GB 限制');
    return { buffer, sha256: sha256Hex(buffer) };
}

function artifactPath(parentId, taskId, fileName) {
    return path.join(taskDir(parentId, taskId), path.basename(fileName));
}

function verifyGlb(parentId, taskId, fileName) {
    const data = readArtifactBuffer(parentId, taskId, fileName);
    if (!data) throw new Error('缺少 GLB 产物');
    const validation = validateGlbBuffer(data.buffer);
    return { ...validation, fileName };
}

// 服务器向远端上传产物时的传输记录（paint 推送）
function recordPush({ parentId, taskId, fileName, toHost, bytes, sha256, note }) {
    recordTransfer({
        parentJobId: parentId,
        taskId,
        fileName,
        fromHost: 'control-plane',
        toHost,
        bytes,
        sha256,
        note
    });
}

module.exports = {
    taskDir,
    saveArtifact,
    readArtifactBuffer,
    artifactPath,
    verifyGlb,
    recordPush,
    MAX_ARTIFACT_BYTES
};
