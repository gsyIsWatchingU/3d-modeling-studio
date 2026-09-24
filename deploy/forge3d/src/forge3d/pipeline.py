from __future__ import annotations

import json
import os
import shutil
import subprocess
import yaml
from pathlib import Path

from forge3d.config import load_pipelines, load_profiles
from forge3d.domain import AssetJob, JobState, StageResult, utc_now
from forge3d.quality import (
    collect_deformation_violations,
    collect_quality_violations,
    collect_rig_quality_violations,
)
from forge3d.settings import Settings
from forge3d.store import JobStore
from forge3d.skill_options import apply_skill_options


class PipelineError(RuntimeError):
    pass


class PipelineRunner:
    def __init__(self, settings: Settings, store: JobStore):
        self.settings = settings
        self.store = store
        self.profiles = load_profiles(settings.profiles_path)
        self.pipelines = load_pipelines(settings.pipeline_path)

    def profile(self, job: AssetJob) -> dict:
        return apply_skill_options(self.profiles[job.profile], job.skill_plan, job.asset_kind.value)

    def profile_path(self, job: AssetJob) -> Path:
        if not job.skill_plan:
            return self.settings.profiles_path
        target = self.store.job_dir(job.job_id) / "work" / "effective-profiles.yaml"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(yaml.safe_dump({"profiles": {job.profile: self.profile(job)}}), encoding="utf-8")
        return target

    def run(self, job: AssetJob) -> AssetJob:
        job.state = JobState.running
        job.error = None
        self.store.save(job)
        try:
            for stage in job.stages:
                if stage.state == "completed":
                    continue
                self._run_stage(job, stage)
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

    def _run_stage(self, job: AssetJob, stage: StageResult) -> None:
        stage.state = "running"
        stage.started_at = utc_now()
        self.store.save(job)
        handler = getattr(self, f"stage_{stage.name}", None)
        if handler is None:
            raise PipelineError(f"未实现阶段: {stage.name}")
        details = handler(job) or {}
        stage.details.update(details)
        stage.state = "completed"
        stage.completed_at = utc_now()
        self.store.save(job)

    def stage_prepare(self, job: AssetJob) -> dict:
        profile = self.profile(job)
        if job.skill_plan:
            job.provenance["applied_skill_parameters"] = job.skill_plan["generation"]
            job.provenance["applied_material_prompt"] = job.skill_plan.get("material_prompt", "high quality")
            self.profile_path(job)
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
            job.outputs["generated_mesh"] = str(output)
            return {"backend": "dry_run"}
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

    def stage_generate_material(self, job: AssetJob) -> dict:
        source = Path(job.outputs["generated_mesh"])
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
                str(self.profile_path(job)),
            ]
            self._run_command(normalize_command, job)
            self._require_output(paint_source)
            source = paint_source
            job.outputs["paint_source"] = str(paint_source)
            texture_profile = self.profile(job).get("textures", {})
            paint_profile = texture_profile.get("paint", {})
            paint_policy = {
                **paint_profile.get("default", {}),
                **paint_profile.get(job.asset_kind.value, {}),
            }
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
                job.skill_plan.get("material_prompt", "high quality"),
                "--preserve-mesh" if job.skill_plan else "--remesh",
            ]
            self._run_command(command, job)
        self._require_output(output)
        job.outputs["pbr_mesh"] = str(output)
        job.outputs["generated_mesh"] = str(output)
        return {
            "backend": "hunyuan3d-paint-2.1",
            "paint_source": str(source),
            "output": str(output),
            "preserved_mesh": bool(job.skill_plan),
            "material_prompt": job.skill_plan.get("material_prompt", "high quality"),
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
                str(self.profile_path(job)),
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
                str(self.profile_path(job)),
            ]
            self._run_command(command, job)
        self._require_output(output)
        job.outputs["game_asset"] = str(output)
        return {"output": str(output)}

    def stage_validate(self, job: AssetJob) -> dict:
        profile = self.profile(job)
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
        return {"preview": str(preview), "manifest": str(manifest)}

    def stage_bake_vfx(self, job: AssetJob) -> dict:
        return self._passthrough_media(job, "vfx")

    def stage_master_audio(self, job: AssetJob) -> dict:
        profile = self.profile(job)["audio"]
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
            result = subprocess.run(
                command,
                cwd=self.settings.project_root,
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
                check=False,
                timeout=3600,
            )
        if result.returncode != 0:
            raise PipelineError(f"阶段命令失败，退出码 {result.returncode}: {' '.join(command[:3])}")

    @staticmethod
    def _require_output(path: Path) -> None:
        if not path.is_file() or path.stat().st_size == 0:
            raise PipelineError(f"缺少阶段输出: {path}")
