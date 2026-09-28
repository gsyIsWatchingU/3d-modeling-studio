#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Multi-GPU Forge3D 阶段 Worker（纯标准库，无第三方依赖）。

用法:
    python3 worker.py \
        --capability shape:t4 \
        --api-url http://10.42.0.166:3300 \
        --token <MP_WORKER_TOKEN> \
        --host $(hostname) \
        --gpu-index 0 \
        --work-dir /workspace/runtime/work \
        --stage-timeout 3600

行为:
    轮询领取 -> 下载输入 -> 执行阶段命令（CUDA_VISIBLE_DEVICES 固定单卡）-> 上传产物 -> complete/fail
    心跳 20s；阶段执行中每 3s 采样 nvidia-smi 峰值显存；感知取消。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

HEARTBEAT_EVERY = 20
VRAM_SAMPLE_EVERY = 3
POLL_EVERY = 5


class StageError(RuntimeError):
    pass


# ---------------- HTTP 基础 ----------------

def http_json(method: str, url: str, token: str, payload: dict | None = None, timeout: int = 30) -> dict:
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("X-MP-Token", token)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8", "replace")
    try:
        return json.loads(body) if body else {}
    except ValueError:
        raise StageError(f"控制面返回了非 JSON 内容: {body[:200]}")


def http_download(url: str, token: str, target: Path, timeout: int = 600) -> None:
    req = urllib.request.Request(url, method="GET")
    req.add_header("X-MP-Token", token)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        with open(target, "wb") as out:
            while True:
                chunk = resp.read(1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)


def multipart_upload(url: str, token: str, fields: dict, files: list[tuple[str, str, bytes]], timeout: int = 1800) -> dict:
    """files: [(field_key, filename, bytes)]"""
    boundary = "----mpworker" + uuid.uuid4().hex
    parts = []
    for key, value in fields.items():
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{value}\r\n".encode())
    for key, filename, content in files:
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"; filename=\"{filename}\"\r\n"
            f"Content-Type: application/octet-stream\r\n\r\n".encode() + content + b"\r\n"
        )
    parts.append(f"--{boundary}--\r\n".encode())
    body = b"".join(parts)
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    req.add_header("X-MP-Token", token)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", "replace")
    try:
        return json.loads(raw) if raw else {}
    except ValueError:
        raise StageError(f"上传产物失败，控制面返回非 JSON: {raw[:200]}")


# ---------------- 显存采样 ----------------

class VramMonitor:
    def __init__(self, gpu_index: int | None):
        self.gpu_index = gpu_index
        self.peak_mb = 0
        self.samples = []
        self.stop = False

    def sample(self) -> None:
        if self.gpu_index is None:
            return
        try:
            out = subprocess.run(
                ["nvidia-smi", "--query-gpu=memory.used,utilization.gpu", "--format=csv,noheader,nounits",
                 "-i", str(self.gpu_index)],
                capture_output=True, text=True, timeout=10, check=False,
            )
            line = (out.stdout or "").strip().splitlines()
            if line:
                mem, util = [int(x.strip()) for x in re.split(r"[,\s]+", line[0].strip()) if x.strip().isdigit()]
                self.peak_mb = max(self.peak_mb, mem)
                self.samples.append({"memory_mb": mem, "utilization": util, "at": time.time()})
        except Exception:
            pass

    def start(self):
        self._thread = __import__("threading").Thread(target=self._loop, daemon=True)
        self._thread.start()

    def _loop(self):
        while not self.stop:
            self.sample()
            time.sleep(VRAM_SAMPLE_EVERY)

    def report(self) -> dict:
        self.stop = True
        time.sleep(0.2)
        return {"peak_vram_mb": self.peak_mb, "samples": self.samples}


# ---------------- 阶段执行器 ----------------

def env_base(args, gpu_index: int | None) -> dict:
    env = os.environ.copy()
    if gpu_index is not None:
        env["CUDA_VISIBLE_DEVICES"] = str(gpu_index)
    env.setdefault("FORGE3D_PROJECT_ROOT", "/workspace/projects/forge3d")
    env.setdefault("FORGE3D_MODEL_ROOT", "/workspace/models/forge3d")
    env.setdefault("FORGE3D_DATA_ROOT", "/workspace/3d-assets")
    env.setdefault("FORGE3D_BLENDER", "/workspace/.tools/blender/blender")
    env.setdefault("HF_HOME", "/workspace/models/forge3d/huggingface")
    env.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    env.setdefault("HY3DGEN_MODELS", "/workspace/models/forge3d/hy3dgen")
    env.setdefault("U2NET_HOME", "/workspace/models/forge3d/rembg")
    env.setdefault("FORGE3D_ENABLE_PBR", "0")
    return env


def blender_cmd(args, env, blender_args: list[str]) -> list[str]:
    return [env.get("FORGE3D_BLENDER", "/workspace/.tools/blender/blender"), "--background",
            "--python-exit-code", "1", "--python"] + blender_args


def run_command(cmd: list[str], env: dict, timeout: int, monitor: VramMonitor, log_lines: list[str]) -> None:
    log_lines.append("$ " + " ".join(str(c) for c in cmd))
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, text=True)
    deadline = time.time() + timeout
    try:
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                proc.kill()
                raise StageError(f"阶段超时（{timeout}s）")
            try:
                line = proc.stdout.readline()
            except Exception:
                line = ""
            if line:
                log_lines.append(line.rstrip())
                if len(log_lines) > 4000:
                    log_lines.pop(0)
                continue
            if proc.poll() is not None:
                break
            monitor.sample()
            time.sleep(0.2)
        if proc.returncode != 0:
            raise StageError(f"阶段命令退出码 {proc.returncode}: {' '.join(str(c) for c in cmd[:3])}")
    finally:
        if proc.poll() is None:
            proc.kill()


def sha256_file(path: Path) -> str:
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


# 各阶段执行：返回 {outputs: [{key, filename}], preview, qc_report, metrics, fail}
def execute_stage(args, task: dict, workdir: Path, monitor: VramMonitor, log_lines: list[str]) -> dict:
    stage = task["stage"]
    params = task.get("params") or {}
    inputs = {a["key"]: a for a in task.get("inputArtifacts") or []}
    input_path = workdir / "inputs"
    input_path.mkdir(parents=True, exist_ok=True)
    for key, art in inputs.items():
        target = input_path / art["fileName"]
        http_download(f"{args.api_url}/api/mp/artifacts/{task['parentJobId']}/{art.get('taskId') or task['id']}/{urllib.parse.quote(art['fileName'])}",
                      args.token, target)
    env = env_base(args, args.gpu_index)
    profiles_yaml = env.get("FORGE3D_PROJECT_ROOT") + "/config/profiles.yaml"
    outdir = workdir / "outputs"
    outdir.mkdir(parents=True, exist_ok=True)

    outputs = []
    preview = None
    qc_report = None
    metrics = {"stage": stage, "elapsed_seconds": 0.0}

    if stage == "shape":
        source = input_path / inputs["source"]["fileName"]
        out_glb = outdir / "shape.glb"
        run_command([env.get("FORGE3D_PROJECT_ROOT") + "/scripts/run-hunyuan.sh",
                     str(source), str(out_glb), str(task.get("seed") or params.get("seed") or 1234)],
                    env, args.stage_timeout, monitor, log_lines)
        if not out_glb.is_file():
            raise StageError("shape 阶段没有产生 GLB 输出")
        outputs.append({"key": "mesh", "filename": "shape.glb"})

    elif stage == "draft_preview":
        mesh = input_path / inputs["mesh"]["fileName"]
        out_png = outdir / "draft-preview.png"
        out_json = outdir / "draft-preview.json"
        run_command(blender_cmd(args, env, [env.get("FORGE3D_PROJECT_ROOT") + "/blender/render_preview.py", "--",
                                            "--input", str(mesh), "--output", str(out_png),
                                            "--asset-kind", params.get("assetKind", "prop"),
                                            "--shots", "1", "--resolution", "256"]),
                    env, args.stage_timeout, monitor, log_lines)
        if not out_png.is_file() or not out_json.is_file():
            raise StageError("draft_preview 缺少输出")
        report = read_json(out_json)
        if str(report.get("draft_gate", "passed")) == "failed":
            violations = report.get("draft_violations") or ["unknown"]
            raise StageError("草稿门禁失败: " + ", ".join(str(v) for v in violations))
        outputs.append({"key": "preview", "filename": "draft-preview.png"})
        outputs.append({"key": "preview_manifest", "filename": "draft-preview.json"})
        preview = "draft-preview.png"

    elif stage == "candidate_qc":
        candidates = params.get("candidates") or []
        rows = []
        for cand in candidates:
            ck = cand["candidateKey"]
            mesh_art = inputs.get(f"mesh-{ck}")
            if not mesh_art:
                rows.append({"candidateKey": ck, "passed": False, "score": 0, "violations": ["缺少 shape 产物"]})
                continue
            mesh = input_path / mesh_art["fileName"]
            inspect = outdir / f"inspect-{ck}.json"
            run_command(blender_cmd(args, env, [env.get("FORGE3D_PROJECT_ROOT") + "/blender/inspect_asset.py", "--",
                                                "--input", str(mesh), "--output", str(inspect)]),
                        env, args.stage_timeout, monitor, log_lines)
            report = read_json(inspect) if inspect.is_file() else {}
            gate = "passed"
            draft_art = inputs.get(f"draft-{ck}")
            if draft_art:
                dm = input_path / draft_art["fileName"]
                if dm.is_file():
                    gate = str(read_json(dm).get("draft_gate", "passed"))
            penalty = 0
            for code in ["missing_material", "missing_uv", "degenerate_uv", "uv_out_of_range",
                         "degenerate_triangle", "missing_base_color_texture", "roughness_collapse",
                         "vertex_count_zero"]:
                if report.get(code):
                    penalty += 25
            if gate == "failed":
                penalty += 60
            score = max(0, 100 - penalty)
            rows.append({"candidateKey": ck, "seed": cand.get("seed"),
                         "passed": penalty < 60 and gate != "failed",
                         "score": round(score, 2),
                         "violations": [k for k in report if report.get(k) and k in (
                             "missing_material", "missing_uv", "degenerate_uv", "uv_out_of_range",
                             "degenerate_triangle", "missing_base_color_texture", "roughness_collapse")],
                         "metrics": {k: report[k] for k in ("triangle_count", "vertex_count", "animation_count")
                                     if k in report}})
        qc = {"stage": "candidate_qc", "generated_at": time.time(),
              "candidates": rows, "auto_approve": False,
              "note": "自动评分仅排序/拒绝明显失败项，不能自动 approved"}
        qc_file = outdir / "qc.json"
        qc_file.write_text(json.dumps(qc, ensure_ascii=False, indent=2), encoding="utf-8")
        outputs.append({"key": "qc", "filename": "qc.json"})
        qc_report = "qc.json"
        metrics["candidates"] = len(rows)

    elif stage == "normalize":
        mesh = input_path / inputs["mesh"]["fileName"]
        out_glb = outdir / "normalized.glb"
        run_command(blender_cmd(args, env, [env.get("FORGE3D_PROJECT_ROOT") + "/blender/normalize_export.py", "--",
                                            "--input", str(mesh), "--output", str(out_glb),
                                            "--profile", params.get("profile", "xhs_mobile"),
                                            "--profiles", profiles_yaml]),
                    env, args.stage_timeout, monitor, log_lines)
        outputs.append({"key": "mesh", "filename": "normalized.glb"})

    elif stage == "rig":
        mesh = input_path / inputs["mesh"]["fileName"]
        out_glb = outdir / "rigged.glb"
        rig_limits = json.dumps({"max_mirror_x_error_ratio": 0.02, "max_pair_depth_error_ratio": 0.02,
                                 "max_pair_height_error_ratio": 0.015, "max_bone_length_mismatch_ratio": 0.10,
                                 "max_rest_foot_lateral_ratio": 0.20}, separators=(",", ":"))
        run_command([env.get("FORGE3D_PROJECT_ROOT") + "/scripts/run-unirig.sh",
                     str(mesh), str(out_glb), rig_limits],
                    env, args.stage_timeout, monitor, log_lines)
        if not out_glb.is_file():
            raise StageError("rig 阶段没有产生输出")
        outputs.append({"key": "mesh", "filename": "rigged.glb"})

    elif stage == "retarget_animation":
        mesh = input_path / inputs["mesh"]["fileName"]
        out_blend = outdir / "animated.blend"
        anim_lib = params.get("animationLibrary") or "/workspace/3d-assets/library/animations"
        run_command(blender_cmd(args, env, [env.get("FORGE3D_PROJECT_ROOT") + "/blender/retarget.py", "--",
                                            "--input", str(mesh), "--output", str(out_blend),
                                            "--library", anim_lib, "--profile", params.get("profile", "xhs_mobile")]),
                    env, args.stage_timeout, monitor, log_lines)
        stab_report = outdir / "locomotion-stabilize.json"
        run_command(blender_cmd(args, env, [env.get("FORGE3D_PROJECT_ROOT") + "/blender/stabilize_locomotion.py", "--",
                                            "--input", str(out_blend), "--output", str(out_blend),
                                            "--report", str(stab_report)]),
                    env, args.stage_timeout, monitor, log_lines)
        deform_report = outdir / "deformation-qc.json"
        run_command(blender_cmd(args, env, [env.get("FORGE3D_PROJECT_ROOT") + "/blender/analyze_deformation.py", "--",
                                            "--input", str(out_blend), "--output", str(deform_report),
                                            "--action", "walk_loop", "--samples", "12"]),
                    env, args.stage_timeout, monitor, log_lines)
        if not out_blend.is_file():
            raise StageError("retarget_animation 没有产生输出")
        outputs.append({"key": "mesh", "filename": "animated.blend"})
        outputs.append({"key": "deformation_qc", "filename": "deformation-qc.json"})

    elif stage == "export":
        mesh = input_path / inputs["mesh"]["fileName"]
        out_glb = outdir / "exported.glb"
        run_command(blender_cmd(args, env, [env.get("FORGE3D_PROJECT_ROOT") + "/blender/export_profile.py", "--",
                                            "--input", str(mesh), "--output", str(out_glb),
                                            "--profile", params.get("profile", "xhs_mobile"),
                                            "--profiles", profiles_yaml]),
                    env, args.stage_timeout, monitor, log_lines)
        if not out_glb.is_file():
            raise StageError("export 阶段没有产生 GLB")
        outputs.append({"key": "mesh", "filename": "exported.glb"})

    elif stage == "render_preview":
        mesh = input_path / inputs["mesh"]["fileName"]
        out_png = outdir / "preview.png"
        out_json = outdir / "preview.json"
        run_command(blender_cmd(args, env, [env.get("FORGE3D_PROJECT_ROOT") + "/blender/render_preview.py", "--",
                                            "--input", str(mesh), "--output", str(out_png),
                                            "--asset-kind", params.get("assetKind", "prop")]),
                    env, args.stage_timeout, monitor, log_lines)
        if not out_png.is_file() or not out_json.is_file():
            raise StageError("render_preview 缺少输出")
        outputs.append({"key": "preview", "filename": "preview.png"})
        outputs.append({"key": "preview_manifest", "filename": "preview.json"})
        preview = "preview.png"

    elif stage == "validate":
        mesh = input_path / inputs["mesh"]["fileName"]
        inspect = outdir / "inspection.json"
        run_command(blender_cmd(args, env, [env.get("FORGE3D_PROJECT_ROOT") + "/blender/inspect_asset.py", "--",
                                            "--input", str(mesh), "--output", str(inspect)]),
                    env, args.stage_timeout, monitor, log_lines)
        report = read_json(inspect) if inspect.is_file() else {}
        anims = [str(a).lower() for a in report.get("animations") or []]
        if params.get("assetKind") == "character" and any("walk_loop" in a for a in anims):
            anim_qc = outdir / "animation-qc.json"
            run_command(blender_cmd(args, env, [env.get("FORGE3D_PROJECT_ROOT") + "/blender/analyze_animation.py", "--",
                                                "--input", str(mesh), "--output", str(anim_qc), "--action", "walk_loop"]),
                        env, args.stage_timeout, monitor, log_lines)
            if anim_qc.is_file():
                report["pose_quality"] = read_json(anim_qc).get("pose_quality", {})
        violations = [k for k in ("missing_material", "missing_uv", "invalid_uv", "uv_out_of_range",
                                  "degenerate_uv", "missing_base_color_texture", "unassigned_material_faces",
                                  "roughness_collapse", "roughness_too_low", "degenerate_triangle")
                      if report.get(k)]
        pose_codes = [k for k in ("hands_too_close", "hands_cross_body", "elbow_overflexed",
                                  "upperarm_overdriven", "unexpected_root_motion",
                                  "character_height_collapse", "character_height_stretch") if report.get(k)]
        passed = not violations and not pose_codes
        qc = {"stage": "validate", "generated_at": time.time(), "passed": passed,
              "violations": violations, "pose_violations": pose_codes,
              "metrics": {k: report[k] for k in ("triangle_count", "vertex_count", "animation_count",
                                                 "delivery_bytes", "missing_animation_clips")
                          if k in report},
              "pose_quality": report.get("pose_quality", {}),
              "auto_approve": False,
              "note": "自动质检通过不等于 approved，仍需人工审片"}
        qc_file = outdir / "qc.json"
        qc_file.write_text(json.dumps(qc, ensure_ascii=False, indent=2), encoding="utf-8")
        outputs.append({"key": "qc", "filename": "qc.json"})
        qc_report = "qc.json"
        metrics["passed"] = passed

    else:
        raise StageError(f"未知阶段: {stage}")

    return {"outputs": outputs, "preview": preview, "qc_report": qc_report, "metrics": metrics}


# ---------------- Worker 主循环 ----------------

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--capability", required=True)
    parser.add_argument("--api-url", required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--host", default="unknown")
    parser.add_argument("--gpu-index", type=int, default=None)
    parser.add_argument("--gpu-uuid", default="")
    parser.add_argument("--work-dir", default="/workspace/runtime/work")
    parser.add_argument("--stage-timeout", type=int, default=3600)
    args = parser.parse_args()

    work_root = Path(args.work_dir)
    work_root.mkdir(parents=True, exist_ok=True)
    print(f"[worker {args.capability}] 启动 host={args.host} gpu={args.gpu_index}", flush=True)

    while True:
        try:
            poll = http_json("GET", f"{args.api_url}/api/mp/worker/poll"
                              f"?capability={urllib.parse.quote(args.capability)}"
                              f"&worker={urllib.parse.quote(args.host)}"
                              f"&host={urllib.parse.quote(args.host)}"
                              f"&gpu_index={args.gpu_index or ''}"
                              f"&gpu_uuid={urllib.parse.quote(args.gpu_uuid)}",
                             args.token, timeout=30)
            task = (poll.get("data") or {}).get("id") and poll.get("data") or None
        except Exception as exc:
            print(f"[worker {args.capability}] 轮询失败: {exc}", flush=True)
            time.sleep(POLL_EVERY)
            continue
        if not task:
            time.sleep(POLL_EVERY)
            continue

        task_id = task["id"]
        workdir = work_root / task_id
        workdir.mkdir(parents=True, exist_ok=True)
        log_lines = [f"task {task_id} stage={task['stage']} attempt={task.get('attempt')}"]
        monitor = VramMonitor(args.gpu_index)
        monitor.start()
        started = time.monotonic()
        try:
            result = execute_stage(args, task, workdir, monitor, log_lines)
            elapsed = round(time.monotonic() - started, 2)
            vram = monitor.report()
            metrics = dict(result.get("metrics") or {})
            metrics["elapsed_seconds"] = elapsed
            metrics.update(vram)

            files = []
            for out in result.get("outputs") or []:
                path = workdir / "outputs" / out["filename"]
                if not path.is_file():
                    raise StageError(f"产物缺失: {out['filename']}")
                files.append((f"{out['key']}:{out['filename']}", out["filename"], path.read_bytes()))

            fields = {
                "worker": args.host,
                "metrics": json.dumps(metrics, ensure_ascii=False),
            }
            if result.get("preview"):
                fields["preview"] = result["preview"]
            if result.get("qc_report"):
                fields["qc_report"] = result["qc_report"]
            if log_lines:
                fields["logs"] = "\n".join(log_lines[-2000:])
            resp = multipart_upload(f"{args.api_url}/api/mp/worker/tasks/{task_id}/complete",
                                    args.token, fields, files)
            if not resp.get("success"):
                raise StageError(f"complete 被拒: {resp.get('error')}")
            print(f"[worker {args.capability}] 任务 {task_id} 完成 {elapsed}s", flush=True)
        except Exception as exc:
            monitor.stop = True
            vram = monitor.report()
            error = str(exc)
            try:
                resp = http_json("POST", f"{args.api_url}/api/mp/worker/tasks/{task_id}/fail",
                                 args.token, {"worker": args.host, "error": error[:800],
                                              "code": "stage_error" if not isinstance(exc, StageError) else "stage_failed"},
                                 timeout=30)
                if not resp.get("success"):
                    print(f"[worker {args.capability}] fail 被拒: {resp.get('error')}", flush=True)
            except Exception as exc2:
                print(f"[worker {args.capability}] fail 上报失败: {exc2}", flush=True)
            print(f"[worker {args.capability}] 任务 {task_id} 失败: {error[:300]}", flush=True)
        finally:
            import shutil
            shutil.rmtree(workdir, ignore_errors=True)
            time.sleep(1)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
