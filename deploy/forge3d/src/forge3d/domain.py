from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class AssetKind(str, Enum):
    character = "character"
    prop = "prop"
    environment = "environment"
    vfx = "vfx"
    audio = "audio"


class JobState(str, Enum):
    queued = "queued"
    running = "running"
    review = "review"
    completed = "completed"
    approved = "approved"
    failed = "failed"


class StageResult(BaseModel):
    name: str
    state: str = "pending"
    started_at: str | None = None
    completed_at: str | None = None
    details: dict[str, Any] = Field(default_factory=dict)


class AssetJob(BaseModel):
    schema_version: str = "1.0"
    job_id: str
    asset_name: str
    asset_kind: AssetKind
    profile: str
    state: JobState = JobState.queued
    source_file: str
    source_sha256: str
    prompt: str = ""
    seed: int = 1234
    created_at: str = Field(default_factory=utc_now)
    updated_at: str = Field(default_factory=utc_now)
    stages: list[StageResult] = Field(default_factory=list)
    outputs: dict[str, str] = Field(default_factory=dict)
    metrics: dict[str, Any] = Field(default_factory=dict)
    provenance: dict[str, Any] = Field(default_factory=dict)
    quality_gates: dict[str, Any] = Field(default_factory=dict)
    skill_plan: dict[str, Any] = Field(default_factory=dict)
    error: str | None = None
