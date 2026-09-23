"""统计骨骼动作的局部旋转范围，辅助自动发现僵硬关节。"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector


DEFAULT_BONES = [
    "clavicle_l",
    "upperarm_l",
    "lowerarm_l",
    "hand_l",
    "clavicle_r",
    "upperarm_r",
    "lowerarm_r",
    "hand_r",
    "thigh_l",
    "calf_l",
    "foot_l",
    "thigh_r",
    "calf_r",
    "foot_r",
]


def parse_args() -> argparse.Namespace:
    args = sys.argv[sys.argv.index("--") + 1 :]
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--action", default="walk_loop")
    parser.add_argument("--samples", type=int, default=24)
    return parser.parse_args(args)


def import_scene(path: Path) -> None:
    if path.suffix.lower() == ".blend":
        bpy.ops.wm.open_mainfile(filepath=str(path))
    else:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=str(path))


def angle_degrees(first: Vector, second: Vector) -> float:
    if first.length <= 1e-8 or second.length <= 1e-8:
        return 0.0
    return math.degrees(first.angle(second))


def armature_height(armature: bpy.types.Object) -> float:
    points = [
        armature.matrix_world @ point
        for bone in armature.data.bones
        for point in (bone.head_local, bone.tail_local)
    ]
    return max(point.z for point in points) - min(point.z for point in points)


def main() -> None:
    args = parse_args()
    source = Path(args.input).resolve()
    import_scene(source)
    armatures = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
    if len(armatures) != 1:
        raise RuntimeError(f"期望一个骨架，实际为 {len(armatures)}")
    action = bpy.data.actions.get(args.action)
    if action is None:
        candidates = [item for item in bpy.data.actions if args.action in item.name]
        if len(candidates) != 1:
            raise RuntimeError(f"没有唯一匹配动作: {args.action}")
        action = candidates[0]

    armature = armatures[0]
    armature.animation_data_create()
    for track in armature.animation_data.nla_tracks:
        track.mute = True
    armature.animation_data.action = action
    start, end = action.frame_range
    frames = [
        start + (end - start) * index / max(1, args.samples - 1)
        for index in range(args.samples)
    ]
    rotations: dict[str, list[list[float]]] = {name: [] for name in DEFAULT_BONES}
    hand_distances: list[float] = []
    lateral_hand_separations: list[float] = []
    elbow_bends: list[float] = []
    upperarm_rotation_angles: list[float] = []
    crossing_frames = 0
    ankle_separations: list[float] = []
    knee_separations: list[float] = []
    knee_bends: list[float] = []
    foot_lateral_ratios: list[float] = []
    knee_lateral_deviations: list[float] = []
    leg_crossing_frames = 0
    root_translations: list[float] = []
    height = max(armature_height(armature), 1e-6)
    scene = bpy.context.scene
    for frame in frames:
        scene.frame_set(int(frame), subframe=frame % 1)
        bpy.context.view_layer.update()
        for name in DEFAULT_BONES:
            bone = armature.pose.bones.get(name)
            if bone is None:
                continue
            euler = bone.matrix_basis.to_quaternion().to_euler("XYZ")
            rotations[name].append([math.degrees(value) for value in euler])
            if name.startswith("upperarm_"):
                upperarm_rotation_angles.append(
                    math.degrees(bone.matrix_basis.to_quaternion().angle)
                )

        left_hand = armature.pose.bones.get("hand_l")
        right_hand = armature.pose.bones.get("hand_r")
        if left_hand is not None and right_hand is not None:
            left = armature.matrix_world @ left_hand.tail
            right = armature.matrix_world @ right_hand.tail
            hand_distances.append((left - right).length)
            lateral_hand_separations.append(left.x - right.x)
            crossing_frames += int(left.x <= right.x)
        for side in ("l", "r"):
            upper = armature.pose.bones.get(f"upperarm_{side}")
            lower = armature.pose.bones.get(f"lowerarm_{side}")
            if upper is not None and lower is not None:
                shoulder_to_elbow = upper.tail - upper.head
                elbow_to_wrist = lower.tail - lower.head
                elbow_bends.append(angle_degrees(shoulder_to_elbow, elbow_to_wrist))
            thigh = armature.pose.bones.get(f"thigh_{side}")
            calf = armature.pose.bones.get(f"calf_{side}")
            foot = armature.pose.bones.get(f"foot_{side}")
            if thigh is None or calf is None or foot is None:
                continue
            hip = armature.matrix_world @ thigh.head
            knee = armature.matrix_world @ calf.head
            ankle = armature.matrix_world @ foot.head
            toe = armature.matrix_world @ foot.tail
            knee_bends.append(angle_degrees(knee - hip, ankle - knee))
            foot_vector = toe - ankle
            if foot_vector.length > 1e-8:
                foot_lateral_ratios.append(abs(foot_vector.x) / foot_vector.length)
            hip_to_ankle = ankle - hip
            if abs(hip_to_ankle.z) > 1e-8:
                line_x = hip.x + (ankle.x - hip.x) * ((knee.z - hip.z) / hip_to_ankle.z)
                knee_lateral_deviations.append(abs(knee.x - line_x) / height)
        left_calf = armature.pose.bones.get("calf_l")
        right_calf = armature.pose.bones.get("calf_r")
        left_foot = armature.pose.bones.get("foot_l")
        right_foot = armature.pose.bones.get("foot_r")
        if all((left_calf, right_calf, left_foot, right_foot)):
            left_knee = armature.matrix_world @ left_calf.head
            right_knee = armature.matrix_world @ right_calf.head
            left_ankle = armature.matrix_world @ left_foot.head
            right_ankle = armature.matrix_world @ right_foot.head
            knee_separations.append(left_knee.x - right_knee.x)
            ankle_separations.append(left_ankle.x - right_ankle.x)
            leg_crossing_frames += int(
                left_knee.x <= right_knee.x or left_ankle.x <= right_ankle.x
            )
        pelvis = armature.pose.bones.get("pelvis")
        if pelvis is not None:
            root_translations.append(pelvis.location.length)

    report = {"asset": str(source), "action": action.name, "frame_range": [start, end], "bones": {}}
    for name, values in rotations.items():
        if not values:
            continue
        axes = list(zip(*values))
        report["bones"][name] = {
            "min_degrees": [round(min(axis), 3) for axis in axes],
            "max_degrees": [round(max(axis), 3) for axis in axes],
            "range_degrees": [round(max(axis) - min(axis), 3) for axis in axes],
        }
    sampled_frames = max(1, len(frames))
    report["pose_quality"] = {
        "rig_height": round(height, 5),
        "min_hand_distance_ratio": round(min(hand_distances, default=height) / height, 5),
        "min_lateral_hand_separation_ratio": round(
            min(lateral_hand_separations, default=height) / height,
            5,
        ),
        "hand_crossing_ratio": round(crossing_frames / sampled_frames, 5),
        "max_elbow_bend_degrees": round(max(elbow_bends, default=0.0), 3),
        "max_upperarm_rotation_degrees": round(
            max(upperarm_rotation_angles, default=0.0),
            3,
        ),
        "max_root_translation_ratio": round(
            max(root_translations, default=0.0) / height,
            5,
        ),
        "min_ankle_separation_ratio": round(
            min(ankle_separations, default=height) / height,
            5,
        ),
        "min_knee_separation_ratio": round(
            min(knee_separations, default=height) / height,
            5,
        ),
        "leg_crossing_ratio": round(leg_crossing_frames / sampled_frames, 5),
        "max_knee_bend_degrees": round(max(knee_bends, default=0.0), 3),
        "max_foot_lateral_ratio": round(max(foot_lateral_ratios, default=0.0), 5),
        "max_knee_lateral_deviation_ratio": round(
            max(knee_lateral_deviations, default=0.0),
            5,
        ),
    }
    Path(args.output).write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
