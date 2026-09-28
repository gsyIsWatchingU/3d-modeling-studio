from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    project_root: Path
    data_root: Path
    model_root: Path
    redis_url: str
    queue_name: str
    worker_queues: tuple[str, ...]
    gpu_queue_name: str
    cpu_queue_name: str
    worker_pool: str | None
    bind_host: str
    bind_port: int
    dry_run: bool
    max_upload_mb: int

    @classmethod
    def from_env(cls) -> Settings:
        project_root = Path(
            os.environ.get("FORGE3D_PROJECT_ROOT", Path(__file__).resolve().parents[2])
        ).resolve()
        queue_name = os.environ.get("FORGE3D_QUEUE", "forge3d:jobs")
        worker_queues = tuple(
            dict.fromkeys(
                queue.strip()
                for queue in os.environ.get("FORGE3D_QUEUES", queue_name).split(",")
                if queue.strip()
            )
        )
        if not worker_queues:
            worker_queues = (queue_name,)
        return cls(
            project_root=project_root,
            data_root=Path(os.environ.get("FORGE3D_DATA_ROOT", "/workspace/3d-assets")).resolve(),
            model_root=Path(
                os.environ.get("FORGE3D_MODEL_ROOT", "/workspace/models/forge3d")
            ).resolve(),
            redis_url=os.environ.get("FORGE3D_REDIS_URL", "redis://127.0.0.1:6379/5"),
            queue_name=queue_name,
            worker_queues=worker_queues,
            gpu_queue_name=os.environ.get("FORGE3D_GPU_QUEUE", queue_name),
            cpu_queue_name=os.environ.get("FORGE3D_CPU_QUEUE", queue_name),
            worker_pool=os.environ.get("FORGE3D_WORKER_POOL") or None,
            bind_host=os.environ.get("FORGE3D_HOST", "127.0.0.1"),
            bind_port=int(os.environ.get("FORGE3D_PORT", "8091")),
            dry_run=os.environ.get("FORGE3D_DRY_RUN", "0") == "1",
            max_upload_mb=int(os.environ.get("FORGE3D_MAX_UPLOAD_MB", "32")),
        )

    @staticmethod
    def resource_class_for(asset_kind: str) -> str:
        return "cpu" if asset_kind in {"audio", "vfx"} else "gpu"

    def queue_for_asset_kind(self, asset_kind: str) -> str:
        if self.resource_class_for(asset_kind) == "cpu":
            return self.cpu_queue_name
        return self.gpu_queue_name

    @property
    def profiles_path(self) -> Path:
        return self.project_root / "config" / "profiles.yaml"

    @property
    def pipeline_path(self) -> Path:
        return self.project_root / "config" / "pipeline.yaml"

    @property
    def jobs_root(self) -> Path:
        return self.data_root / "jobs"

    def ensure_directories(self) -> None:
        for path in (
            self.data_root / "source",
            self.jobs_root,
            self.data_root / "exports",
            self.data_root / "library" / "animations",
            self.data_root / "library" / "materials",
            self.data_root / "library" / "audio",
            self.model_root,
        ):
            path.mkdir(parents=True, exist_ok=True)
