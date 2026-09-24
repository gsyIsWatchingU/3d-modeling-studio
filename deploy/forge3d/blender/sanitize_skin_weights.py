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
    return parser.parse_args(args)


def group_weight(vertex: bpy.types.MeshVertex, group_index: int) -> float:
    return next((item.weight for item in vertex.groups if item.group == group_index), 0.0)


def smooth_joint_weights(
    obj: bpy.types.Object,
    upper: bpy.types.VertexGroup,
    lower: bpy.types.VertexGroup,
    *,
    repeats: int = 3,
    factor: float = 0.5,
) -> int:
    """Smooth a two-bone knee transition without changing total limb influence."""

    neighbours = [set() for _ in obj.data.vertices]
    for edge in obj.data.edges:
        first, second = edge.vertices
        neighbours[first].add(second)
        neighbours[second].add(first)
    changed = 0
    for _ in range(repeats):
        updates: list[tuple[int, float, float]] = []
        for vertex in obj.data.vertices:
            upper_weight = group_weight(vertex, upper.index)
            lower_weight = group_weight(vertex, lower.index)
            total = upper_weight + lower_weight
            if total < 0.35:
                continue
            ratios = []
            for index in neighbours[vertex.index]:
                neighbour = obj.data.vertices[index]
                neighbour_upper = group_weight(neighbour, upper.index)
                neighbour_lower = group_weight(neighbour, lower.index)
                neighbour_total = neighbour_upper + neighbour_lower
                if neighbour_total >= 0.35:
                    ratios.append(neighbour_upper / neighbour_total)
            if not ratios:
                continue
            current = upper_weight / total
            target = sum(ratios) / len(ratios)
            repaired = current * (1.0 - factor) + target * factor
            if abs(repaired - current) > 1e-5:
                updates.append((vertex.index, total * repaired, total * (1.0 - repaired)))
        for index, upper_weight, lower_weight in updates:
            upper.add([index], upper_weight, "REPLACE")
            lower.add([index], lower_weight, "REPLACE")
        changed += len(updates)
    return changed


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
    left_lower_names = [semantic_names[name] for name in ("calf_l", "foot_l", "ball_l")]
    right_lower_names = [semantic_names[name] for name in ("calf_r", "foot_r", "ball_r")]
    center_x = armature.data.bones[semantic_names["pelvis"]].head_local.x if "pelvis" in semantic_names else 0.0
    points = [point for bone in armature.data.bones for point in (bone.head_local, bone.tail_local)]
    rig_height = max(point.z for point in points) - min(point.z for point in points)
    left_head_x = armature.data.bones[left_name].head_local.x
    right_head_x = armature.data.bones[right_name].head_local.x
    blend_band = max(min(abs(left_head_x - center_x), abs(right_head_x - center_x)), rig_height * 0.02)
    changed: list[dict[str, object]] = []
    smoothed_vertices = 0

    for obj in bpy.context.scene.objects:
        if obj.type != "MESH" or not any(mod.type == "ARMATURE" for mod in obj.modifiers):
            continue
        left = obj.vertex_groups.get(left_name)
        right = obj.vertex_groups.get(right_name)
        if left is None or right is None:
            continue
        left_lower = [obj.vertex_groups.get(name) for name in left_lower_names]
        right_lower = [obj.vertex_groups.get(name) for name in right_lower_names]
        left_lower_indices = {group.index for group in left_lower if group is not None}
        right_lower_indices = {group.index for group in right_lower if group is not None}
        mesh_to_armature = armature.matrix_world.inverted() @ obj.matrix_world
        for vertex in obj.data.vertices:
            weights = {item.group: item.weight for item in vertex.groups}
            if left.index not in weights and right.index not in weights:
                continue
            armature_x = (mesh_to_armature @ vertex.co).x
            thigh_weight = weights.get(left.index, 0.0) + weights.get(right.index, 0.0)
            if thigh_weight <= 0:
                continue
            left_lower_weight = sum(weights.get(index, 0.0) for index in left_lower_indices)
            right_lower_weight = sum(weights.get(index, 0.0) for index in right_lower_indices)
            if left_lower_weight > right_lower_weight + 1e-6:
                # A vertex already following the left calf/foot belongs to the
                # left leg even when loose shorts place it near the body centre.
                # Retaining any right-thigh share tears adjacent knee vertices
                # apart during the walk cycle.
                left_fraction = 1.0
                assignment = "left_lower_limb"
            elif right_lower_weight > left_lower_weight + 1e-6:
                left_fraction = 0.0
                assignment = "right_lower_limb"
            else:
                left_fraction = max(0.0, min(1.0, 0.5 + (armature_x - center_x) / (2.0 * blend_band)))
                assignment = "center_blend"
            right_fraction = 1.0 - left_fraction
            changed.append({
                "object": obj.name,
                "vertex": vertex.index,
                "x": round(armature_x, 7),
                "left_weight_before": round(weights.get(left.index, 0.0), 7),
                "right_weight_before": round(weights.get(right.index, 0.0), 7),
                "left_weight_after": round(thigh_weight * left_fraction, 7),
                "right_weight_after": round(thigh_weight * right_fraction, 7),
                "assignment": assignment,
            })
            left.remove([vertex.index])
            right.remove([vertex.index])
            if left_fraction > 1e-6:
                left.add([vertex.index], thigh_weight * left_fraction, "REPLACE")
            if right_fraction > 1e-6:
                right.add([vertex.index], thigh_weight * right_fraction, "REPLACE")
        for side in ("l", "r"):
            thigh = obj.vertex_groups.get(semantic_names[f"thigh_{side}"])
            calf = obj.vertex_groups.get(semantic_names[f"calf_{side}"])
            if thigh is not None and calf is not None:
                smoothed_vertices += smooth_joint_weights(obj, thigh, calf)
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
            "blend_band": round(blend_band, 7),
            "changed_vertex_count": len(changed),
            "smoothed_vertex_updates": smoothed_vertices,
            "changes": changed,
        }, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
