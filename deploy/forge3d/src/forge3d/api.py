from __future__ import annotations

import hashlib
import re
import shutil
from pathlib import Path
from uuid import uuid4

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile

from forge3d import __version__
from forge3d.config import load_pipelines, load_profiles
from forge3d.domain import AssetJob, AssetKind, StageResult
from forge3d.settings import Settings
from forge3d.store import JobStore
from forge3d.skill_options import parse_skill_plan

settings = Settings.from_env()
settings.ensure_directories()
store = JobStore(settings)
profiles = load_profiles(settings.profiles_path)
pipelines = load_pipelines(settings.pipeline_path)

app = FastAPI(title="Forge3D", version=__version__)

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


@app.post("/v1/jobs", response_model=AssetJob)
async def create_job(
    source: UploadFile = File(...),
    material_source: UploadFile | None = File(None),
    asset_name: str = Form(..., min_length=2, max_length=80),
    asset_kind: AssetKind = Form(...),
    profile: str = Form("xhs_mobile"),
    prompt: str = Form("", max_length=2000),
    seed: int = Form(1234, ge=0, le=2**32 - 1),
    skill_plan: str = Form("", max_length=16000),
) -> AssetJob:
    try:
        execution_plan = parse_skill_plan(skill_plan)
    except (ValueError, TypeError, AttributeError) as exc:
        raise HTTPException(400, f"Skill 执行参数无效: {exc}") from exc
    if profile not in profiles:
        raise HTTPException(400, f"未知档位: {profile}")
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
        material_source_path = job_dir / f"material-source{material_suffix}"
        material_hasher = hashlib.sha256()
        material_size = 0
        with material_source_path.open("wb") as output:
            while chunk := await material_source.read(1024 * 1024):
                material_size += len(chunk)
                if material_size > settings.max_upload_mb * 1024 * 1024:
                    output.close()
                    shutil.rmtree(job_dir)
                    raise HTTPException(413, "材质参考文件过大")
                material_hasher.update(chunk)
                output.write(chunk)
        material_digest = material_hasher.hexdigest()

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
        skill_plan=execution_plan,
        stages=stages,
        provenance={
            "source_filename": source.filename,
            "material_source_filename": material_source.filename if material_source else None,
            "forge3d_version": __version__,
            "resource_class": settings.resource_class_for(asset_kind.value),
            "queue_name": queue_name,
            "skill_plan_sha256": execution_plan.get("sha256"),
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
