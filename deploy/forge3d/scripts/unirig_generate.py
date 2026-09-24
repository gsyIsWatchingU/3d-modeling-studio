"""UniRig 适配器，在骨架生成后、蒙皮前执行低成本质量预检。"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
from pathlib import Path


def run(command: list[str], *, cwd: Path, env: dict[str, str], expected: Path | None = None) -> None:
    result = subprocess.run(command, cwd=cwd, env=env, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"UniRig 推理或预检失败: {command[1]} ({result.returncode})")
    if expected is not None and (not expected.is_file() or expected.stat().st_size == 0):
        raise RuntimeError(f"UniRig 阶段没有产生输出: {expected}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--python", required=True)
    parser.add_argument("--blender", required=True)
    parser.add_argument("--rig-repairer", required=True)
    parser.add_argument("--rig-analyzer", required=True)
    parser.add_argument("--rig-limits-json", default="{}")
    parser.add_argument("--skeleton-only", action="store_true")
    args = parser.parse_args()
    repo = Path(args.repo)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    skeleton = output.with_suffix(".skeleton.fbx")
    repaired_skeleton = output.with_suffix(".skeleton-repaired.fbx")
    repair_report = output.with_suffix(".skeleton-repair.json")
    skeleton_report = output.with_suffix(".skeleton-qc.json")
    skin = output.with_suffix(".skin.fbx")
    work = output.parent / f".{output.stem}-unirig"
    skeleton_npz = work / "skeleton"
    skin_npz = work / "skin"
    shutil.rmtree(work, ignore_errors=True)
    skeleton_npz.mkdir(parents=True)
    skin_npz.mkdir(parents=True)
    env = os.environ.copy()
    env["PATH"] = f"{Path(args.python).parent}:{env.get('PATH', '')}"
    shared_hf_cache = Path("/workspace/models/forge3d/huggingface")
    if shared_hf_cache.is_dir():
        env.setdefault("HF_HOME", str(shared_hf_cache))
        # Production weights are installed ahead of time. Fail immediately when a
        # dependency is incomplete instead of waiting through remote HEAD retries.
        env.setdefault("HF_HUB_OFFLINE", "1")
        env.setdefault("TRANSFORMERS_OFFLINE", "1")

    run([
        "bash", "launch/inference/extract.sh", "--input", args.input,
        "--output_dir", str(skeleton_npz), "--force_override", "true",
    ], cwd=repo, env=env)
    run([
        args.python, "run.py",
        "--task=configs/task/quick_inference_skeleton_articulationxl_ar_256.yaml",
        "--seed=12345", f"--input={args.input}", f"--output={skeleton}",
        f"--npz_dir={skeleton_npz}",
    ], cwd=repo, env=env, expected=skeleton)
    run([
        args.blender, "--background", "--python-exit-code", "1", "--python",
        args.rig_repairer, "--", "--input", str(skeleton), "--output",
        str(repaired_skeleton), "--report", str(repair_report),
    ], cwd=repo, env=env, expected=repaired_skeleton)
    run([
        args.blender, "--background", "--python-exit-code", "1", "--python",
        args.rig_analyzer, "--", "--input", str(repaired_skeleton), "--output",
        str(skeleton_report), "--rig-limits-json", args.rig_limits_json,
        "--fail-on-violation",
    ], cwd=repo, env=env, expected=skeleton_report)
    if args.skeleton_only:
        print(f"骨架探针通过: {skeleton_report}", flush=True)
        return
    run([
        "bash", "launch/inference/extract.sh", "--input", str(repaired_skeleton),
        "--output_dir", str(skin_npz), "--force_override", "true",
    ], cwd=repo, env=env)
    run([
        args.python, "run.py", "--task=configs/task/quick_inference_unirig_skin.yaml",
        "--seed=12345", f"--input={repaired_skeleton}", f"--output={skin}",
        f"--npz_dir={skin_npz}", "--data_name=raw_data.npz",
    ], cwd=repo, env=env, expected=skin)
    run([
        args.python, "-m", "src.inference.merge", "--require_suffix=glb",
        "--num_runs=1", "--id=0", f"--source={skin}", f"--target={args.input}",
        f"--output={output}",
    ], cwd=repo, env=env, expected=output)


if __name__ == "__main__":
    main()
