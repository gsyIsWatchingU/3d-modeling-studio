from __future__ import annotations

import hashlib
import json
import os
import shutil
import signal
import subprocess
import time
from pathlib import Path
from typing import ClassVar

from forge3d.config import load_pipelines, load_profiles
from forge3d.domain import AssetJob, JobState, StageResult, utc_now
from forge3d.quality import (
    collect_deformation_violations,
    collect_quality_violations,
    collect_rig_quality_violations,
)
from forge3d.settings import Settings
from forge3d.store import JobStore

# 草稿早退门禁的档位（PERF-02）。分辨率刻意压低，只求快。
DRAFT_PREVIEW_SHOTS = 1
DRAFT_PREVIEW_RESOLUTION = 256


class PipelineError(RuntimeError):
    pass


class PipelineRunner:
    def __init__(self, settings: Settings, store: JobStore):
        self.settings = settings
        self.store = store
        self.profiles = load_profiles(settings.profiles_path)
        self.pipelines = load_pipelines(settings.pipeline_path)

    def profile(self, job: AssetJob) -> dict:
        return self.profiles[job.profile]

    def run(self, job: AssetJob) -> AssetJob:
        job.state = JobState.running
        job.error = None
        self.store.save(job)
        try:
            for stage in job.stages:
                # 跳过判断在 _run_stage 里按「阶段指纹」做，不再只看 completed。
                self._run_stage(job, stage)
                # Multi-GPU 部分流水线：paint-only 等任务跑到 stop_after 即结束，
                # 状态置 completed（本任务范围内流水线完成），后续阶段保持 pending。
                if job.stop_after and stage.name == job.stop_after:
                    job.state = JobState.completed
                    job.quality_gates["automatic_pipeline"] = "passed"
                    job.provenance["partial_pipeline"] = job.stop_after
                    self.store.save(job)
                    return job
            job.state = JobState.review
            job.quality_gates["automatic_pipeline"] = "passed"
            job.quality_gates["human_art_review"] = "required"
            self.store.save(job)
            return job
        except Exception as exc:
            job.state = JobState.failed
            job.error = str(exc)[:2000]
            self.store.save(job)
            raise

    def _should_skip_stage(self, job: AssetJob, stage: StageResult) -> bool:
        """阶段指纹没变 → 这一步的产物可以原样复用，不必重跑（PERF-01）。

        指纹同时覆盖「本阶段参数」和「全部上游阶段指纹」，所以上游一变，下游自动失效。
        """

        if job.stop_after:
            # Multi-GPU 部分流水线续跑：上游产物由外部阶段生成，已完成的阶段一律复用。
            return stage.state == "completed"
        return stage.state == "completed" and stage.details.get("fingerprint") == self._fingerprint(
            job, stage
        )

    def _run_stage(self, job: AssetJob, stage: StageResult) -> None:
        handler = getattr(self, f"stage_{stage.name}", None)
        if handler is None:
            raise PipelineError(f"未实现阶段: {stage.name}")
        if self._should_skip_stage(job, stage):
            # 本阶段参数与全部上游指纹都没变，结果可直接复用。
            return
        self._remaining_seconds(job)
        stage.state = "running"
        stage.details = {"fingerprint": self._fingerprint(job, stage)}
        stage.started_at = utc_now()
        stage.completed_at = None
        self.store.save(job)
        started = time.monotonic()
        try:
            details = handler(job) or {}
            stage.details.update(details)
        finally:
            stage.details["elapsed_seconds"] = round(time.monotonic() - started, 3)
            stage.details["execution_job_id"] = job.job_id
            self.store.save(job)
        stage.state = "completed"
        stage.completed_at = utc_now()
        self.store.save(job)

    # 阶段 → 它真正读取的阶段输出。上游指纹一变，下游自动失效。
    # 空元组是**有意的**"没有上游"，不是"待推断"：generate_mesh 只读源图与种子，
    # 并不吃 prepare 写出的 profile.json。如果把它向后退化成"紧邻的上一个阶段"，
    # 换 delivery 档位就会连带把整条链全部失效，shape 生成这个最贵的 GPU 阶段也会被重跑。
    STAGE_INPUTS: ClassVar[dict[str, tuple[str, ...]]] = {
        "prepare": (),
        "generate_mesh": (),
        "draft_preview": ("generate_mesh",),
        "generate_material": ("generate_mesh",),
        # normalize_mesh 的**实际**输入是 outputs["generated_mesh"]，而这个键由
        # stage_generate_material 覆写为上色后的网格；而且它内部跑的就是 normalize_export.py，
        # 出来的是带动画的导出链所吃的那个网格。所以 generate_material 必须声明在上游里：
        # 漏了它，只改 paint 参数重跑时本阶段会被指纹跳过，新贴图被静默丢弃，
        # rig/retarget/export 全沿用旧产物，任务却照样 passed 进 review（PERF-12）。
        "normalize_mesh": ("generate_mesh", "generate_material"),
        "rig": ("normalize_mesh",),
        "retarget_animation": ("rig",),
        "export": ("retarget_animation", "normalize_mesh"),
        "render_preview": ("export",),
        "validate": ("render_preview",),
        "bake_vfx": (),
        "master_audio": (),
    }

    def _upstream_names(self, job: AssetJob, stage_name: str) -> tuple[str, ...]:
        names = [item.name for item in job.stages]
        index = names.index(stage_name) if stage_name in names else -1
        if stage_name not in self.STAGE_INPUTS:
            # 表外的新阶段：保守起见沿用串行语义，取紧邻的上一个阶段。
            return (names[index - 1],) if index > 0 else ()
        declared = self.STAGE_INPUTS[stage_name]
        if not declared:
            return ()
        # 声明过的上游若不在本条管线里（例如 prop 没有 retarget_animation），
        # 就只保留实际存在的那些；一个都不剩时才退回紧邻阶段。
        present = tuple(name for name in declared if name in names[:index])
        if present:
            return present
        return (names[index - 1],) if index > 0 else ()

    def _fingerprint(self, job: AssetJob, stage: StageResult) -> str:
        upstream = {
            name: next(
                (item.details.get("fingerprint") for item in job.stages if item.name == name),
                None,
            )
            for name in self._upstream_names(job, stage.name)
        }
        payload = {
            "stage": stage.name,
            "params": self._stage_params(job, stage.name),
            "upstream": upstream,
            "forge3d_version": job.provenance.get("forge3d_version"),
            # 换了后端镜像 / 模型权重之后，人工把这个 salt 改一下即可让全部阶段失效。
            # 这是当前唯一的"非参数"失效开关，见 asset-pipeline.md PERF-10。
            "salt": job.provenance.get("fingerprint_salt"),
        }
        blob = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str)
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]

    def _stage_params(self, job: AssetJob, stage_name: str) -> dict:
        """只取本阶段真正用到的档位键。缺键一律返回 None，不要抛 KeyError
        —— 否则将来出现只做音频的档位时，指纹会在无关阶段上崩掉。"""

        profile = self.profiles.get(job.profile, {})
        geometry = profile.get("geometry", {})
        textures = profile.get("textures", {})
        animation = profile.get("animation", {})
        if stage_name == "prepare":
            return {"profile": job.profile}
        if stage_name == "generate_mesh":
            return {
                "source_sha256": job.source_sha256,
                "seed": job.seed,
                "prompt": job.prompt,
            }
        if stage_name == "draft_preview":
            return {
                "shots": DRAFT_PREVIEW_SHOTS,
                "resolution": DRAFT_PREVIEW_RESOLUTION,
            }
        if stage_name == "generate_material":
            return {"paint": self._paint_policy(job)}
        if stage_name == "normalize_mesh":
            return {"geometry": geometry}
        if stage_name == "rig":
            return {"backend": "unirig"}
        if stage_name == "retarget_animation":
            return {
                "clips": animation.get("required_clips", []),
                "fps": animation.get("fps"),
            }
        if stage_name == "export":
            return {"geometry": geometry, "texture_max": textures.get("max_size")}
        if stage_name == "render_preview":
            params = {"engine": "BLENDER_EEVEE_NEXT", "shots": 4, "resolution": 512}
            if job.provenance.get("quality_harness"):
                params["turntable"] = "rest-v1"
            return params
        if stage_name == "validate":
            return {"quality": profile.get("quality", {}), "geometry": geometry}
        if stage_name == "master_audio":
            return {"audio": profile.get("audio", {})}
        return {}

    def _paint_policy(self, job: AssetJob) -> dict:
        from forge3d.repair_policy import validate_paint_overrides

        paint = self.profiles[job.profile].get("textures", {}).get("paint", {})
        overrides = validate_paint_overrides(job.provenance.get("paint_overrides", {}))
        return {**paint.get("default", {}), **paint.get(job.asset_kind.value, {}), **overrides}

    @staticmethod
    def _remaining_seconds(job: AssetJob) -> float:
        deadline = job.provenance.get("deadline_epoch")
        remaining = min(3600.0, float(deadline) - time.time()) if deadline else 3600.0
        if remaining <= 0:
            raise PipelineError("任务耗时预算已用完，停止后续阶段")
        return remaining

    def stage_prepare(self, job: AssetJob) -> dict:
        profile = self.profiles[job.profile]
        work_dir = self.store.job_dir(job.job_id) / "work"
        work_dir.mkdir(parents=True, exist_ok=True)
        (work_dir / "profile.json").write_text(
            json.dumps(profile, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        return {"work_dir": str(work_dir), "profile": job.profile}

    def stage_generate_mesh(self, job: AssetJob) -> dict:
        output = self.store.job_dir(job.job_id) / "work" / "generated.glb"
        if self.settings.dry_run:
            output.write_bytes(b"FORGE3D_DRY_RUN_GLB")
            # dry_run 也必须写 shape_mesh：draft_preview 读的是这个键，
            # 早先只在非 dry_run 分支赋值，会让 dry_run 下的草稿阶段直接 KeyError。
            job.outputs["shape_mesh"] = str(output)
            job.outputs["generated_mesh"] = str(output)
            return {"backend": "dry_run"}
        mesh_backend = job.provenance.get("mesh_backend", "single")
        if mesh_backend == "2mv":
            # Hunyuan3D-2mv：用 1-4 张一致视图生成形体，source 固定为 front。
            command = [
                str(self.settings.project_root / "scripts" / "run-hunyuan-mv.sh"),
                "--front", job.source_file,
                "--output", str(output),
                "--seed", str(job.seed),
            ]
            for view_name in ("right", "back"):
                view = job.provenance.get("views", {}).get(view_name)
                if view and view.get("file"):
                    command += [f"--{view_name}", str(view["file"])]
            self._run_command(command, job)
            self._require_output(output)
            job.outputs["shape_mesh"] = str(output)
            job.outputs["generated_mesh"] = str(output)
            return {"backend": "hunyuan3d-2mv", "output": str(output)}
        command = [
            str(self.settings.project_root / "scripts" / "run-hunyuan.sh"),
            job.source_file,
            str(output),
            str(job.seed),
        ]
        self._run_command(command, job)
        self._require_output(output)
        job.outputs["shape_mesh"] = str(output)
        job.outputs["generated_mesh"] = str(output)
        return {"backend": "hunyuan3d-2.1", "output": str(output)}

    def stage_draft_preview(self, job: AssetJob) -> dict:
        """草稿早退门禁（PERF-02）：在 generate_mesh 之后出一张低分辨率单角度图，
        只拦"一定不能过"的灾难性错误，把发现坏网格的成本从整条链压到 ~110 秒。

        门禁判定放在 render_preview.py 里（指标在那边算），这里只负责执行与拦停。
        """

        output = self.store.job_dir(job.job_id) / "draft-preview.png"
        report_path = output.with_suffix(".json")
        if self.settings.dry_run:
            output.write_bytes(b"FORGE3D_DRY_RUN_DRAFT")
            report_path.write_text(
                json.dumps(
                    {"asset_kind": job.asset_kind.value, "draft_gate": "passed"},
                    ensure_ascii=False,
                )
                + "\n",
                encoding="utf-8",
            )
        else:
            command = [
                os.environ.get("FORGE3D_BLENDER", "/workspace/.tools/blender/blender"),
                "--background",
                "--python-exit-code",
                "1",
                "--python",
                str(self.settings.project_root / "blender" / "render_preview.py"),
                "--",
                "--input",
                job.outputs["shape_mesh"],
                "--output",
                str(output),
                "--asset-kind",
                job.asset_kind.value,
                "--shots",
                str(DRAFT_PREVIEW_SHOTS),
                "--resolution",
                str(DRAFT_PREVIEW_RESOLUTION),
            ]
            self._run_command(command, job)
        self._require_output(output)
        self._require_output(report_path)
        report = json.loads(report_path.read_text(encoding="utf-8"))
        job.outputs["draft_preview"] = str(output)
        job.outputs["draft_preview_manifest"] = str(report_path)
        gate = self._enforce_draft_gate(report)
        return {"draft_preview": str(output), "draft_gate": gate}

    @staticmethod
    def _enforce_draft_gate(report: dict) -> str:
        """读 Blender 侧算好的草稿门禁结论并拦停（PERF-02）。

        阈值与分类算法统一在 blender/preview_gate.py 里，与审片渲染共用一份实现。
        这里只做"读结论 + 抛错"，绝不重复实现判定，否则两边阈值迟早漂移。
        """

        gate = str(report.get("draft_gate", "passed"))
        if gate == "failed":
            violations = report.get("draft_violations") or ["unknown"]
            raise PipelineError(
                "草稿门禁失败: " + ", ".join(str(item) for item in violations)
            )
        return gate

    def stage_generate_material(self, job: AssetJob) -> dict:
        # 必须从 shape_mesh 读，不能从 generated_mesh 读：本阶段跑完会把 generated_mesh
        # 指向贴图后的文件。以前每次都整链重跑所以看不出问题，PERF-01 让"只重跑这一段"
        # 变成常态后，重跑会给已贴图模型再贴一次（同路径时 Windows 直接 SameFileError）。
        source = Path(job.outputs["shape_mesh"])
        output = self.store.job_dir(job.job_id) / "work" / "textured.glb"
        paint_source = self.store.job_dir(job.job_id) / "work" / "paint-source.glb"
        if self.settings.dry_run:
            shutil.copyfile(source, output)
        else:
            # Hunyuan shape 的原始网格可能远超交付预算。先按目标 profile 清模，
            # 再进入多视角 Paint，既保留最终可见细节，也避免复杂场景占满显存。
            normalize_command = [
                os.environ.get("FORGE3D_BLENDER", "/workspace/.tools/blender/blender"),
                "--background",
                "--python-exit-code",
                "1",
                "--python",
                str(self.settings.project_root / "blender" / "normalize_export.py"),
                "--",
                "--input",
                str(source),
                "--output",
                str(paint_source),
                "--profile",
                job.profile,
                "--profiles",
                str(self.settings.profiles_path),
            ]
            self._run_command(normalize_command, job)
            self._require_output(paint_source)
            source = paint_source
            job.outputs["paint_source"] = str(paint_source)
            paint_policy = self._paint_policy(job)
            command = [
                str(self.settings.project_root / "scripts" / "run-hunyuan-paint.sh"),
                str(source),
                job.material_source_file or job.source_file,
                str(output),
                str(paint_policy.get("views", 8)),
                str(paint_policy.get("resolution", 768)),
                job.asset_kind.value,
                str(paint_policy.get("roughness_floor", 0.32)),
                str(paint_policy.get("specular_level", 0.35)),
                str(paint_policy.get("paint_seed", 0)),
            ]
            self._run_command(command, job)
        self._require_output(output)
        job.outputs["pbr_mesh"] = str(output)
        job.outputs["generated_mesh"] = str(output)
        return {
            "backend": "hunyuan3d-paint-2.1",
            "paint_source": str(source),
            "output": str(output),
            "material_source": job.material_source_file or job.source_file,
        }

    def stage_normalize_mesh(self, job: AssetJob) -> dict:
        source = Path(job.outputs["generated_mesh"])
        output = self.store.job_dir(job.job_id) / "work" / "normalized.glb"
        if self.settings.dry_run:
            shutil.copyfile(source, output)
        else:
            command = [
                os.environ.get("FORGE3D_BLENDER", "/workspace/.tools/blender/blender"),
                "--background",
                "--python-exit-code",
                "1",
                "--python",
                str(self.settings.project_root / "blender" / "normalize_export.py"),
                "--",
                "--input",
                str(source),
                "--output",
                str(output),
                "--profile",
                job.profile,
                "--profiles",
                str(self.settings.profiles_path),
            ]
            self._run_command(command, job)
        self._require_output(output)
        job.outputs["normalized_mesh"] = str(output)
        return {"output": str(output)}

    def stage_rig(self, job: AssetJob) -> dict:
        source = Path(job.outputs["normalized_mesh"])
        output = self.store.job_dir(job.job_id) / "work" / "rigged.glb"
        if self.settings.dry_run:
            shutil.copyfile(source, output)
        else:
            rig_limits = self.profile(job).get("animation", {}).get("rig_quality", {})
            command = [
                str(self.settings.project_root / "scripts" / "run-unirig.sh"),
                str(source),
                str(output),
                json.dumps(rig_limits, separators=(",", ":")),
            ]
            self._run_command(command, job)
        self._require_output(output)
        job.outputs["rigged_mesh"] = str(output)
        details = {"backend": "unirig", "output": str(output)}
        if not self.settings.dry_run:
            report_path = self.store.job_dir(job.job_id) / "rig-qc.json"
            command = [
                os.environ.get("FORGE3D_BLENDER", "/workspace/.tools/blender/blender"),
                "--background", "--python-exit-code", "1", "--python",
                str(self.settings.project_root / "blender" / "analyze_rig_structure.py"),
                "--", "--input", str(output), "--output", str(report_path),
            ]
            self._run_command(command, job)
            report = json.loads(report_path.read_text(encoding="utf-8"))
            violations = collect_rig_quality_violations(report, self.profile(job))
            job.outputs["rig_quality_report"] = str(report_path)
            job.metrics["rig_quality"] = report.get("quality", {})
            job.quality_gates["rig_structure_review"] = "failed" if violations else "passed"
            self.store.save(job)
            if violations:
                raise PipelineError("骨架门禁失败: " + ", ".join(violations))
            details["rig_quality"] = report.get("quality", {})
        return details

    def stage_retarget_animation(self, job: AssetJob) -> dict:
        source = Path(job.outputs["rigged_mesh"])
        output = self.store.job_dir(job.job_id) / "work" / "animated.blend"
        if self.settings.dry_run:
            shutil.copyfile(source, output)
        else:
            command = [
                os.environ.get("FORGE3D_BLENDER", "/workspace/.tools/blender/blender"),
                "--background",
                "--python-exit-code",
                "1",
                "--python",
                str(self.settings.project_root / "blender" / "retarget.py"),
                "--",
                "--input",
                str(source),
                "--output",
                str(output),
                "--library",
                str(self.settings.data_root / "library" / "animations"),
                "--profile",
                job.profile,
            ]
            self._run_command(command, job)
            stabilization_report = self.store.job_dir(job.job_id) / "locomotion-stabilize.json"
            command = [
                os.environ.get("FORGE3D_BLENDER", "/workspace/.tools/blender/blender"),
                "--background", "--python-exit-code", "1", "--python",
                str(self.settings.project_root / "blender" / "stabilize_locomotion.py"),
                "--", "--input", str(output), "--output", str(output),
                "--report", str(stabilization_report),
            ]
            self._run_command(command, job)
            job.outputs["locomotion_stabilization_report"] = str(stabilization_report)
        self._require_output(output)
        job.outputs["animated_source"] = str(output)
        details = {"output": str(output)}
        if not self.settings.dry_run:
            report_path = self.store.job_dir(job.job_id) / "deformation-qc.json"
            command = [
                os.environ.get("FORGE3D_BLENDER", "/workspace/.tools/blender/blender"),
                "--background", "--python-exit-code", "1", "--python",
                str(self.settings.project_root / "blender" / "analyze_deformation.py"),
                "--", "--input", str(output), "--output", str(report_path),
                "--action", "walk_loop", "--samples", "12",
            ]
            self._run_command(command, job)
            report = json.loads(report_path.read_text(encoding="utf-8"))
            violations = collect_deformation_violations(report, self.profile(job))
            job.outputs["deformation_quality_report"] = str(report_path)
            job.metrics["deformation_quality"] = report.get("quality", {})
            job.quality_gates["deformation_review"] = "failed" if violations else "passed"
            self.store.save(job)
            if violations:
                raise PipelineError("蒙皮变形门禁失败: " + ", ".join(violations))
            details["deformation_quality"] = report.get("quality", {})
        return details

    def stage_export(self, job: AssetJob) -> dict:
        source_key = "animated_source" if job.asset_kind.value == "character" else "normalized_mesh"
        source = Path(job.outputs[source_key])
        export_dir = self.settings.data_root / "exports" / job.asset_name / job.job_id
        export_dir.mkdir(parents=True, exist_ok=True)
        output = export_dir / f"{job.asset_name}-{job.profile}.glb"
        if self.settings.dry_run:
            shutil.copyfile(source, output)
        else:
            command = [
                os.environ.get("FORGE3D_BLENDER", "/workspace/.tools/blender/blender"),
                "--background",
                "--python-exit-code",
                "1",
                "--python",
                str(self.settings.project_root / "blender" / "export_profile.py"),
                "--",
                "--input",
                str(source),
                "--output",
                str(output),
                "--profile",
                job.profile,
                "--profiles",
                str(self.settings.profiles_path),
            ]
            self._run_command(command, job)
        self._require_output(output)
        job.outputs["game_asset"] = str(output)
        return {"output": str(output)}

    def stage_validate(self, job: AssetJob) -> dict:
        profile = self.profiles[job.profile]
        asset_path = Path(job.outputs.get("game_asset", job.source_file))
        if not asset_path.is_file() or asset_path.stat().st_size == 0:
            raise PipelineError("交付文件为空")
        inspection: dict = {}
        if asset_path.suffix.lower() in {".glb", ".gltf", ".fbx"} and not self.settings.dry_run:
            report_path = self.store.job_dir(job.job_id) / "inspection.json"
            command = [
                os.environ.get("FORGE3D_BLENDER", "/workspace/.tools/blender/blender"),
                "--background",
                "--python-exit-code",
                "1",
                "--python",
                str(self.settings.project_root / "blender" / "inspect_asset.py"),
                "--",
                "--input",
                str(asset_path),
                "--output",
                str(report_path),
            ]
            self._run_command(command, job)
            inspection = json.loads(report_path.read_text(encoding="utf-8"))
            if job.asset_kind.value == "character" and any(
                "walk_loop" in name.lower() for name in inspection.get("animations", [])
            ):
                animation_report_path = self.store.job_dir(job.job_id) / "animation-qc.json"
                animation_command = [
                    os.environ.get("FORGE3D_BLENDER", "/workspace/.tools/blender/blender"),
                    "--background",
                    "--python-exit-code",
                    "1",
                    "--python",
                    str(self.settings.project_root / "blender" / "analyze_animation.py"),
                    "--",
                    "--input",
                    str(asset_path),
                    "--output",
                    str(animation_report_path),
                    "--action",
                    "walk_loop",
                ]
                self._run_command(animation_command, job)
                animation_report = json.loads(
                    animation_report_path.read_text(encoding="utf-8")
                )
                inspection["pose_quality"] = animation_report.get("pose_quality", {})

        preview_report: dict = {}
        preview_manifest = job.outputs.get("preview_manifest")
        if preview_manifest and Path(preview_manifest).is_file():
            preview_report = json.loads(Path(preview_manifest).read_text(encoding="utf-8"))

        geometry = profile.get("geometry", {})
        animation = profile.get("animation", {})
        required_clips = set(animation.get("required_clips", []))
        actual_clips = {name.lower() for name in inspection.get("animations", [])}
        missing_clips = sorted(
            clip for clip in required_clips if not any(clip in actual for actual in actual_clips)
        )
        violations = collect_quality_violations(
            inspection,
            preview_report,
            profile,
            job.asset_kind.value,
        )
        material_uv_codes = {
            "missing_material",
            "missing_uv",
            "invalid_uv",
            "uv_out_of_range",
            "degenerate_uv",
            "missing_base_color_texture",
            "unassigned_material_faces",
            "roughness_collapse",
            "roughness_too_low",
        }
        pose_codes = {
            "hands_too_close",
            "hands_cross_body",
            "hands_crossed",
            "elbow_overflexed",
            "upperarm_overdriven",
            "unexpected_root_motion",
            "character_height_collapse",
            "character_height_stretch",
        }
        job.metrics.update(
            {
                "delivery_bytes": asset_path.stat().st_size,
                "triangle_budget": geometry.get("triangle_budget"),
                "max_bones": geometry.get("max_bones"),
                "missing_animation_clips": missing_clips,
                "preview_quality": preview_report.get("quality", {}),
                **inspection,
            }
        )
        job.quality_gates.update(
            {
                "file_exists": "passed",
                "profile_contract": "failed" if violations else "passed",
                "material_uv_review": "failed"
                if material_uv_codes.intersection(violations)
                else "passed",
                "render_anomaly_review": "failed"
                if any(
                    violation.startswith("render_") or violation == "missing_render_metrics"
                    for violation in violations
                )
                else "passed",
                "animation_pose_review": "failed"
                if pose_codes.intersection(violations)
                else "passed"
                if job.asset_kind.value == "character"
                else "n/a",
                "deformation_review": "required" if job.asset_kind.value == "character" else "n/a",
                "target_device_review": "required",
            }
        )
        if violations:
            raise PipelineError(f"质量门禁失败: {', '.join(violations)}")
        return {"asset": str(asset_path), "bytes": asset_path.stat().st_size}

    def stage_render_preview(self, job: AssetJob) -> dict:
        preview = self.store.job_dir(job.job_id) / "preview.png"
        manifest = preview.with_suffix(".json")
        if self.settings.dry_run:
            preview.write_bytes(b"FORGE3D_DRY_RUN_PREVIEW")
            manifest.write_text(
                json.dumps({"status": "dry_run"}, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
        else:
            command = [
                os.environ.get("FORGE3D_BLENDER", "/workspace/.tools/blender/blender"),
                "--background",
                "--python-exit-code",
                "1",
                "--python",
                str(self.settings.project_root / "blender" / "render_preview.py"),
                "--",
                "--input",
                job.outputs["game_asset"],
                "--output",
                str(preview),
                "--asset-kind",
                job.asset_kind.value,
            ]
            self._run_command(command, job)
        self._require_output(preview)
        self._require_output(manifest)
        job.outputs["preview"] = str(preview)
        job.outputs["preview_manifest"] = str(manifest)
        if job.provenance.get("quality_harness") and not self.settings.dry_run:
            turntable = preview.with_name("turntable.png")
            command[command.index("--output") + 1] = str(turntable)
            command.extend(["--action", "__turntable__"])
            self._run_command(command, job)
            self._require_output(turntable)
            job.outputs["turntable"] = str(turntable)
        return {"preview": str(preview), "manifest": str(manifest)}

    def stage_bake_vfx(self, job: AssetJob) -> dict:
        return self._passthrough_media(job, "vfx")

    def stage_master_audio(self, job: AssetJob) -> dict:
        profile = self.profiles[job.profile]["audio"]
        output_dir = self.settings.data_root / "exports" / job.asset_name / job.job_id
        output_dir.mkdir(parents=True, exist_ok=True)
        output = output_dir / f"{job.asset_name}.ogg"
        if self.settings.dry_run:
            shutil.copyfile(job.source_file, output)
        else:
            command = [
                os.environ.get(
                    "FORGE3D_CONTROL_PYTHON", "/workspace/.envs/forge3d/bin/python"
                ),
                str(self.settings.project_root / "scripts" / "master_audio.py"),
                "--input",
                job.source_file,
                "--output",
                str(output),
                "--sample-rate",
                str(profile["sample_rate"]),
                "--target-lufs",
                str(profile["target_lufs"]),
                "--bitrate-kbps",
                str(profile["bitrate_kbps"]),
            ]
            self._run_command(command, job)
        self._require_output(output)
        job.outputs["game_asset"] = str(output)
        return {"backend": "ffmpeg_loudnorm", "output": str(output)}

    def _passthrough_media(self, job: AssetJob, key: str) -> dict:
        output_dir = self.settings.data_root / "exports" / job.asset_name / job.job_id
        output_dir.mkdir(parents=True, exist_ok=True)
        source = Path(job.source_file)
        output = output_dir / source.name
        shutil.copyfile(source, output)
        job.outputs["game_asset"] = str(output)
        return {"backend": f"{key}_baseline", "output": str(output)}

    def _run_command(self, command: list[str], job: AssetJob) -> None:
        log_path = self.store.job_dir(job.job_id) / "pipeline.log"
        env = os.environ.copy()
        env.update(
            {
                "FORGE3D_DATA_ROOT": str(self.settings.data_root),
                "FORGE3D_MODEL_ROOT": str(self.settings.model_root),
                "HF_HOME": str(self.settings.model_root / "huggingface"),
            }
        )
        with log_path.open("a", encoding="utf-8") as log:
            process = subprocess.Popen(
                command,
                cwd=self.settings.project_root,
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=os.name != "nt",
            )
            try:
                process.wait(timeout=self._remaining_seconds(job))
            except (subprocess.TimeoutExpired, PipelineError):
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                                   stdout=log, stderr=log, check=False)
                else:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                process.wait()
                raise PipelineError("阶段耗时预算已用完，已终止生成进程及其子进程") from None
        if process.returncode != 0:
            raise PipelineError(f"阶段命令失败，退出码 {process.returncode}: {' '.join(command[:3])}")

    @staticmethod
    def _require_output(path: Path) -> None:
        if not path.is_file() or path.stat().st_size == 0:
            raise PipelineError(f"缺少阶段输出: {path}")
