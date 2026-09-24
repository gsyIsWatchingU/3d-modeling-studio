"""收敛移动动作的腿部摆幅，避免瘦高角色脚部沿纵深方向爆出。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import bpy
from mathutils import Quaternion


ACTION_FACTORS = {
    "walk_loop": 0.88,
    "walk_formal_loop": 0.88,
    "run_loop": 0.92,
    "sprint_loop": 0.92,
    "crouch_walk_loop": 0.92,
}
LEG_BONES = (
    "thigh_l", "thigh_r", "calf_l", "calf_r",
    "foot_l", "foot_r", "ball_l", "ball_r",
)


def parse_args() -> argparse.Namespace:
    args = sys.argv[sys.argv.index("--") + 1 :]
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--report", required=True)
    return parser.parse_args(args)


def main() -> None:
    args = parse_args()
    source = Path(args.input).resolve()
    output = Path(args.output).resolve()
    report_path = Path(args.report).resolve()
    bpy.ops.wm.open_mainfile(filepath=str(source))
    identity = Quaternion((1.0, 0.0, 0.0, 0.0))
    changes: list[dict[str, object]] = []

    for action_name, factor in ACTION_FACTORS.items():
        action = bpy.data.actions.get(action_name)
        if action is None or not hasattr(action, "fcurves"):
            continue
        for bone_name in LEG_BONES:
            data_path = f'pose.bones["{bone_name}"].rotation_quaternion'
            curves = [action.fcurves.find(data_path, index=index) for index in range(4)]
            if any(curve is None for curve in curves):
                continue
            frames = sorted({point.co.x for curve in curves for point in curve.keyframe_points})
            changed_keys = 0
            for frame in frames:
                rotation = Quaternion(tuple(curve.evaluate(frame) for curve in curves)).normalized()
                reduced = identity.slerp(rotation, factor).normalized()
                for curve, value in zip(curves, reduced, strict=True):
                    for point in curve.keyframe_points:
                        if abs(point.co.x - frame) < 1e-5:
                            point.co.y = value
                            changed_keys += 1
                            break
            for curve in curves:
                curve.update()
            changes.append({
                "action": action_name,
                "bone": bone_name,
                "factor": factor,
                "changed_keys": changed_keys,
            })

    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(output))
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(
        json.dumps({"source": str(source), "output": str(output), "changes": changes}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
