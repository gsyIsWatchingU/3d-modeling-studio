"""检查角色静置骨架的语义完整性与左右对称性。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from retarget import semantic_mapping


PAIRS = ("clavicle", "upperarm", "lowerarm", "hand", "thigh", "calf", "foot", "ball")
REQUIRED = {
    "pelvis", "spine_01", "spine_02", "spine_03", "neck_01", "Head",
    *(f"{name}_{side}" for name in PAIRS for side in ("l", "r")),
}


def functional_length(semantic_bones: dict[str, bpy.types.Bone], name: str, side: str) -> float:
    """按可动链比较长度，避免把 UniRig 的手指分段差异误判成手臂不对称。"""

    if name != "hand":
        bone = semantic_bones.get(f"{name}_{side}")
        return bone.length if bone is not None else 0.0
    names = [f"hand_{side}", *(f"index_0{index}_{side}" for index in range(1, 4))]
    return sum(semantic_bones[key].length for key in names if key in semantic_bones)


def parse_args() -> argparse.Namespace:
    args = sys.argv[sys.argv.index("--") + 1 :]
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--rig-limits-json", default="{}")
    parser.add_argument("--fail-on-violation", action="store_true")
    return parser.parse_args(args)


def import_scene(path: Path) -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if path.suffix.lower() == ".fbx":
        bpy.ops.import_scene.fbx(filepath=str(path))
    else:
        bpy.ops.import_scene.gltf(filepath=str(path))


def main() -> None:
    args = parse_args()
    source = Path(args.input).resolve()
    import_scene(source)
    armatures = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
    if len(armatures) != 1:
        raise RuntimeError(f"期望一个骨架，实际为 {len(armatures)}")
    armature = armatures[0]
    bones = armature.data.bones
    raw_mapping = semantic_mapping(armature)
    semantic_bones = {semantic: bones[original] for original, semantic in raw_mapping.items()}
    semantic_names = {semantic: original for original, semantic in raw_mapping.items()}
    points = [point for bone in bones for point in (bone.head_local, bone.tail_local)]
    height = max(max(point.z for point in points) - min(point.z for point in points), 1e-6)
    missing = sorted(REQUIRED - set(semantic_bones))
    mirror_x_errors = []
    depth_errors = []
    height_errors = []
    length_mismatches = []
    pair_details = {}
    for name in PAIRS:
        left = semantic_bones.get(f"{name}_l")
        right = semantic_bones.get(f"{name}_r")
        if left is None or right is None:
            continue
        pair_mirror = []
        pair_depth = []
        pair_height = []
        for left_point, right_point in ((left.head_local, right.head_local), (left.tail_local, right.tail_local)):
            pair_mirror.append(abs(left_point.x + right_point.x) / height)
            pair_depth.append(abs(left_point.y - right_point.y) / height)
            pair_height.append(abs(left_point.z - right_point.z) / height)
        left_functional_length = functional_length(semantic_bones, name, "l")
        right_functional_length = functional_length(semantic_bones, name, "r")
        length_mismatch = abs(left_functional_length - right_functional_length) / max(
            left_functional_length, right_functional_length, 1e-6
        )
        mirror_x_errors.extend(pair_mirror)
        depth_errors.extend(pair_depth)
        height_errors.extend(pair_height)
        length_mismatches.append(length_mismatch)
        pair_details[name] = {
            "left_bone": semantic_names[f"{name}_l"],
            "right_bone": semantic_names[f"{name}_r"],
            "left_head": [round(value, 5) for value in left.head_local],
            "left_tail": [round(value, 5) for value in left.tail_local],
            "right_head": [round(value, 5) for value in right.head_local],
            "right_tail": [round(value, 5) for value in right.tail_local],
            "left_length": round(left.length, 5),
            "right_length": round(right.length, 5),
            "left_functional_length": round(left_functional_length, 5),
            "right_functional_length": round(right_functional_length, 5),
            "left_children": [child.name for child in left.children],
            "right_children": [child.name for child in right.children],
            "mirror_x_error_ratio": round(max(pair_mirror), 5),
            "depth_error_ratio": round(max(pair_depth), 5),
            "height_error_ratio": round(max(pair_height), 5),
            "length_mismatch_ratio": round(length_mismatch, 5),
        }

    foot_lateral = []
    for side in ("l", "r"):
        foot = semantic_bones.get(f"foot_{side}")
        if foot is not None and foot.length > 1e-8:
            foot_lateral.append(abs((foot.tail_local - foot.head_local).x) / foot.length)

    report = {
        "asset": str(source),
        "bone_count": len(bones),
        "semantic_bones": {
            semantic: {
                "source": original,
                "head": [round(value, 5) for value in bones[original].head_local],
                "tail": [round(value, 5) for value in bones[original].tail_local],
                "length": round(bones[original].length, 5),
            }
            for original, semantic in sorted(raw_mapping.items(), key=lambda item: item[1])
        },
        "unmapped_bones": [
            {
                "name": bone.name,
                "parent": bone.parent.name if bone.parent else None,
                "head": [round(value, 5) for value in bone.head_local],
                "tail": [round(value, 5) for value in bone.tail_local],
                "length": round(bone.length, 5),
            }
            for bone in bones
            if bone.name not in raw_mapping
        ],
        "missing_required_bones": missing,
        "pair_details": pair_details,
        "quality": {
            "rig_height": round(height, 5),
            "max_mirror_x_error_ratio": round(max(mirror_x_errors, default=1.0), 5),
            "max_pair_depth_error_ratio": round(max(depth_errors, default=1.0), 5),
            "max_pair_height_error_ratio": round(max(height_errors, default=1.0), 5),
            "max_bone_length_mismatch_ratio": round(max(length_mismatches, default=1.0), 5),
            "max_rest_foot_lateral_ratio": round(max(foot_lateral, default=1.0), 5),
        },
    }
    if args.fail_on_violation:
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
        from forge3d.quality import collect_rig_quality_violations

        profile = {"animation": {"rig_quality": json.loads(args.rig_limits_json)}}
        violations = collect_rig_quality_violations(report, profile)
        report["violations"] = violations
    Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.fail_on_violation and report["violations"]:
        raise RuntimeError("骨架预检失败: " + ", ".join(report["violations"]))


if __name__ == "__main__":
    main()
