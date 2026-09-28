from __future__ import annotations

import hashlib
import os
import re
import shutil
from pathlib import Path
from uuid import uuid4

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.requests import Request
from starlette.responses import JSONResponse

from forge3d import __version__
from forge3d.config import load_pipelines, load_profiles
from forge3d.domain import AssetJob, AssetKind, StageResult
from forge3d.settings import Settings
from forge3d.store import JobStore

settings = Settings.from_env()
settings.ensure_directories()
store = JobStore(settings)
profiles = load_profiles(settings.profiles_path)
pipelines = load_pipelines(settings.pipeline_path)

# Multi-GPU：集群内其它主机（T4/控制面）访问必须带令牌；本机回环保持无令牌，旧接口行为不变。
APP_TOKEN = os.environ.get("FORGE3D_API_TOKEN", "")

app = FastAPI(title="Forge3D", version=__version__)


@app.middleware("http")
async def token_gate(request: Request, call_next):
    client = request.client.host if request.client else ""
    if client not in ("127.0.0.1", "::1", "localhost"):
        if not APP_TOKEN or request.headers.get("X-Forge3D-Token") != APP_TOKEN:
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
    return await call_next(request)

ALLOWED_EXTENSIONS = {
    AssetKind.character: {".png", ".jpg", ".jpeg", ".webp"},
    AssetKind.prop: {".png", ".jpg", ".jpeg", ".webp"},
    AssetKind.environment: {".png", ".jpg", ".jpeg", ".webp"},
    AssetKind.vfx: {".png", ".jpg", ".jpeg", ".webp", ".exr", ".blend"},
    AssetKind.audio: {".wav", ".flac", ".ogg"},
}


@app.get("/health")
def health() -> dict:
    pbr_status = settings.model_root / "status"
    dependencies = {
        "redis": _safe_ping(),
        "blender": Path("/workspace/.tools/blender/blender").is_file(),
        "hunyuan_shape": (settings.model_root / "status" / "hunyuan-shape.ready").is_file(),
        "hunyuan_pbr": (pbr_status / "hunyuan-pbr.ready").is_file()
        and (pbr_status / "hunyuan-pbr-inference.ready").is_file(),
        "unirig": (settings.model_root / "status" / "unirig.ready").is_file(),
    }
    return {
        "service": "forge3d",
        "version": __version__,
        "control_plane": "ready" if dependencies["redis"] else "degraded",
        "production_backends_ready": all(dependencies.values()),
        "dry_run": settings.dry_run,
        "dependencies": dependencies,
        "routing": {
            "gpu": {
                "queue": settings.gpu_queue_name,
                "asset_kinds": ["character", "prop", "environment"],
                "pending": _safe_queue_size(settings.gpu_queue_name),
            },
            "cpu": {
                "queue": settings.cpu_queue_name,
                "asset_kinds": ["audio", "vfx"],
                "pending": _safe_queue_size(settings.cpu_queue_name),
            },
        },
    }


@app.get("/v1/profiles")
def list_profiles() -> dict:
    return {"profiles": profiles}


ALLOWED_MESH_BACKENDS = {"single", "2mv"}


async def _save_upload(
    upload: UploadFile, job_dir: Path, name_prefix: str, asset_kind: AssetKind
) -> tuple[Path, str]:
    """将可选视图上传保存到任务目录，返回 (路径, sha256)。"""
    suffix = Path(upload.filename or "").suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS[asset_kind]:
        raise HTTPException(415, f"{asset_kind.value} 不支持参考文件类型 {suffix}")
    target = job_dir / f"{name_prefix}{suffix}"
    hasher = hashlib.sha256()
    size = 0
    with target.open("wb") as output:
        while chunk := await upload.read(1024 * 1024):
            size += len(chunk)
            if size > settings.max_upload_mb * 1024 * 1024:
                output.close()
                shutil.rmtree(job_dir)
                raise HTTPException(413, "参考文件过大")
            hasher.update(chunk)
            output.write(chunk)
    return target, hasher.hexdigest()


@app.post("/v1/jobs", response_model=AssetJob)
async def create_job(
    source: UploadFile = File(...),
    material_source: UploadFile | None = File(None),
    view_right: UploadFile | None = File(None),
    view_back: UploadFile | None = File(None),
    asset_name: str = Form(..., min_length=2, max_length=80),
    asset_kind: AssetKind = Form(...),
    profile: str = Form("xhs_mobile"),
    prompt: str = Form("", max_length=2000),
    seed: int = Form(1234, ge=0, le=2**32 - 1),
    mesh_backend: str = Form("single"),
) -> AssetJob:
    if profile not in profiles:
        raise HTTPException(400, f"未知档位: {profile}")
    if mesh_backend not in ALLOWED_MESH_BACKENDS:
        raise HTTPException(400, f"mesh_backend 必须是 {sorted(ALLOWED_MESH_BACKENDS)} 之一")
    safe_name = re.sub(r"[^a-zA-Z0-9_-]+", "-", asset_name).strip("-").lower()
    if len(safe_name) < 2:
        raise HTTPException(400, "asset_name 必须包含可用的英文、数字、连字符或下划线")
    suffix = Path(source.filename or "").suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS[asset_kind]:
        raise HTTPException(415, f"{asset_kind.value} 不支持文件类型 {suffix}")
    material_suffix = Path(material_source.filename or "").suffix.lower() if material_source else ""
    if material_source and material_suffix not in ALLOWED_EXTENSIONS[asset_kind]:
        raise HTTPException(415, f"{asset_kind.value} 不支持材质参考文件类型 {material_suffix}")

    job_id = uuid4().hex
    job_dir = settings.jobs_root / job_id
    job_dir.mkdir(parents=True, exist_ok=False)
    source_path = job_dir / f"source{suffix}"
    digest = hashlib.sha256()
    size = 0
    with source_path.open("wb") as output:
        while chunk := await source.read(1024 * 1024):
            size += len(chunk)
            if size > settings.max_upload_mb * 1024 * 1024:
                output.close()
                shutil.rmtree(job_dir)
                raise HTTPException(413, "上传文件过大")
            digest.update(chunk)
            output.write(chunk)

    material_source_path = None
    material_digest = None
    if material_source:
        material_source_path, material_digest = await _save_upload(
            material_source, job_dir, "material-source", asset_kind
        )

    view_files: dict[str, dict] = {}
    for view_name, upload in (("right", view_right), ("back", view_back)):
        if upload is not None:
            view_path, view_digest = await _save_upload(
                upload, job_dir, f"view-{view_name}", asset_kind
            )
            view_files[view_name] = {
                "file": str(view_path),
                "sha256": view_digest,
                "filename": upload.filename or "",
            }

    stages = [StageResult(name=name) for name in pipelines[asset_kind.value]]
    queue_name = settings.queue_for_asset_kind(asset_kind.value)
    job = AssetJob(
        job_id=job_id,
        asset_name=safe_name,
        asset_kind=asset_kind,
        profile=profile,
        source_file=str(source_path),
        source_sha256=digest.hexdigest(),
        material_source_file=str(material_source_path) if material_source_path else None,
        material_source_sha256=material_digest,
        prompt=prompt,
        seed=seed,
        stages=stages,
        provenance={
            "source_filename": source.filename,
            "material_source_filename": material_source.filename if material_source else None,
            "mesh_backend": mesh_backend,
            "views": view_files,
            "forge3d_version": __version__,
            "resource_class": settings.resource_class_for(asset_kind.value),
            "queue_name": queue_name,
        },
    )
    store.save(job)
    store.enqueue(job_id, queue_name)
    return job


@app.get("/v1/jobs/{job_id}", response_model=AssetJob)
def get_job(job_id: str) -> AssetJob:
    if not re.fullmatch(r"[0-9a-f]{32}", job_id):
        raise HTTPException(400, "job_id 格式错误")
    try:
        return store.load(job_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, "任务不存在") from exc


@app.post("/v1/stages/paint", response_model=AssetJob)
async def create_paint_job(
    mesh: UploadFile = File(...),
    material_source: UploadFile | None = File(None),
    asset_name: str = Form(..., min_length=2, max_length=80),
    asset_kind: AssetKind = Form(...),
    profile: str = Form("xhs_mobile"),
    prompt: str = Form("", max_length=2000),
    seed: int = Form(1234, ge=0, le=2**32 - 1),
) -> AssetJob:
    """Multi-GPU paint-only 阶段：接收已在 T4 生成的选中候选网格，只跑 L20 的
    normalize→Hunyuan3D Paint→textured.glb，不重跑 shape。stop_after 让流水线
    在 generate_material 完成后置 completed 返回，控制面据此下载贴图产物。"""
    if profile not in profiles:
        raise HTTPException(400, f"未知档位: {profile}")
    if asset_kind.value not in ("character", "prop", "environment"):
        raise HTTPException(400, "paint 只支持 character/prop/environment")
    safe_name = re.sub(r"[^a-zA-Z0-9_-]+", "-", asset_name).strip("-").lower()
    if len(safe_name) < 2:
        raise HTTPException(400, "asset_name 必须包含可用的英文、数字、连字符或下划线")
    mesh_suffix = Path(mesh.filename or "").suffix.lower()
    if mesh_suffix != ".glb":
        raise HTTPException(415, "paint 只接受 .glb 网格")
    # paint-only 任务必须带参考图：Hunyuan3D Paint 需要以参考图为 image 输入，
    # 缺省时流水线会把 source.glb（网格）误当 image 传入，必然失败。
    if material_source is None:
        raise HTTPException(400, "paint 必须提供 material_source 参考图")

    job_id = uuid4().hex
    job_dir = settings.jobs_root / job_id
    job_dir.mkdir(parents=True, exist_ok=False)
    source_path = job_dir / f"source{mesh_suffix}"
    digest = hashlib.sha256()
    size = 0
    with source_path.open("wb") as output:
        while chunk := await mesh.read(1024 * 1024):
            size += len(chunk)
            if size > settings.max_upload_mb * 1024 * 1024:
                output.close()
                shutil.rmtree(job_dir)
                raise HTTPException(413, "上传文件过大")
            digest.update(chunk)
            output.write(chunk)

    material_source_path = None
    material_digest = None
    if material_source:
        material_source_path, material_digest = await _save_upload(
            material_source, job_dir, "material-source", asset_kind
        )

    # paint-only 管线：prepare → generate_material；不包含 generate_mesh/draft_preview，
    # 上游 shape 由外部（T4）生成后直接注入 job.outputs["shape_mesh"]。
    partial_stages = [
        StageResult(name=name)
        for name in pipelines[asset_kind.value]
        if name in ("prepare", "generate_material")
    ]
    queue_name = settings.queue_for_asset_kind(asset_kind.value)
    job = AssetJob(
        job_id=job_id,
        asset_name=safe_name,
        asset_kind=asset_kind,
        profile=profile,
        source_file=str(source_path),
        source_sha256=digest.hexdigest(),
        material_source_file=str(material_source_path) if material_source_path else None,
        material_source_sha256=material_digest,
        prompt=prompt,
        seed=seed,
        stages=partial_stages,
        stop_after="generate_material",
        provenance={
            "source_filename": mesh.filename,
            "material_source_filename": material_source.filename if material_source else None,
            "mesh_backend": "selected-candidate",
            "forge3d_version": __version__,
            "resource_class": settings.resource_class_for(asset_kind.value),
            "queue_name": queue_name,
            "partial_pipeline": "paint",
        },
    )
    # 直接注入已选候选网格，避免在 L20 重跑 shape（Multi-GPU 分工约束）。
    job.outputs["shape_mesh"] = str(source_path)
    store.save(job)
    store.enqueue(job_id, queue_name)
    return job


@app.get("/v1/jobs/{job_id}/artifacts/{artifact_key}")
def get_job_artifact(job_id: str, artifact_key: str):
    """Multi-GPU：控制面下载远端阶段产物。只允许 outputs 中登记过的键，
    返回文件流而不暴露路径，防止任意文件读取。"""
    if not re.fullmatch(r"[0-9a-f]{32}", job_id):
        raise HTTPException(400, "job_id 格式错误")
    try:
        job = store.load(job_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, "任务不存在") from exc
    output = job.outputs.get(artifact_key)
    if not output:
        raise HTTPException(404, "产物不存在")
    target = Path(output)
    if not target.is_file() or target.stat().st_size == 0:
        raise HTTPException(410, "产物尚未就绪")
    return FileResponse(target, filename=target.name)


def _safe_ping() -> bool:
    try:
        return store.ping()
    except Exception:
        return False


def _safe_queue_size(queue_name: str) -> int | None:
    try:
        return store.queue_size(queue_name)
    except Exception:
        return None


def main() -> None:
    uvicorn.run(app, host=settings.bind_host, port=settings.bind_port)
