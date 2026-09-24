"""清除跨越身体中线的左右大腿混合权重，避免胯部边在走路时爆拉。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from repair_rig_symmetry import semantic_mapping


def parse_args() -> argparse.Namespace:
    args = sys.argv[sys.argv.index("--") + 1 :]
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--center-band-ratio", type=float, default=0.001)
    return parser.parse_args(args)


def main() -> None:
    args = parse_args()
    source = Path(args.input).resolve()
    output = Path(args.output).resolve()
    report_path = Path(args.report).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    report_path.parent.mkdir(parents=True, exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(source))
    armatures = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
    if len(armatures) != 1:
        raise RuntimeError(f"期望一个骨架，实际为 {len(armatures)}")
    armature = armatures[0]
    mapping = semantic_mapping(armature)
    semantic_names = {semantic: original for original, semantic in mapping.items()}
    left_name = semantic_names["thigh_l"]
    right_name = semantic_names["thigh_r"]
    center_x = armature.data.bones[semantic_names["pelvis"]].head_local.x if "pelvis" in semantic_names else 0.0
    points = [point for bone in armature.data.bones for point in (bone.head_local, bone.tail_local)]
    rig_height = max(point.z for point in points) - min(point.z for point in points)
    center_band = max(rig_height * args.center_band_ratio, 1e-6)
    changed: list[dict[str, object]] = []

    for obj in bpy.context.scene.objects:
        if obj.type != "MESH" or not any(mod.type == "ARMATURE" for mod in obj.modifiers):
            continue
        left = obj.vertex_groups.get(left_name)
        right = obj.vertex_groups.get(right_name)
        if left is None or right is None:
            continue
        mesh_to_armature = armature.matrix_world.inverted() @ obj.matrix_world
        for vertex in obj.data.vertices:
            weights = {item.group: item.weight for item in vertex.groups}
            if left.index not in weights and right.index not in weights:
                continue
            armature_x = (mesh_to_armature @ vertex.co).x
            if abs(armature_x - center_x) <= center_band:
                continue
            keep = left if armature_x > center_x else right
            remove = right if keep == left else left
            thigh_weight = weights.get(left.index, 0.0) + weights.get(right.index, 0.0)
            if thigh_weight <= 0:
                continue
            changed.append({
                "object": obj.name,
                "vertex": vertex.index,
                "x": round(armature_x, 7),
                "kept": keep.name,
                "removed": remove.name,
                "removed_weight": round(weights.get(remove.index, 0.0), 7),
            })
            left.remove([vertex.index])
            right.remove([vertex.index])
            keep.add([vertex.index], thigh_weight, "REPLACE")
        if changed:
            bpy.context.view_layer.objects.active = obj
            obj.select_set(True)
            bpy.ops.object.vertex_group_normalize_all(group_select_mode="ALL", lock_active=False)
            obj.select_set(False)

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=str(output),
        export_format="GLB",
        export_animations=False,
        export_skins=True,
        export_materials="EXPORT",
    )
    report_path.write_text(
        json.dumps({
            "source": str(source),
            "output": str(output),
            "center_x": round(center_x, 7),
            "center_band": round(center_band, 7),
            "changed_vertex_count": len(changed),
            "changes": changed,
        }, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
