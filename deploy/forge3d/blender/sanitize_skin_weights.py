"""隔离左右腿蒙皮，并把胯部中线区域稳定到骨盆，避免走路时爆拉。"""

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


def point_segment_distance(point, head, tail) -> float:
    """Distance from a point to a bone segment (head->tail) in armature space."""
    segment = tail - head
    length_squared = segment.length_squared
    if length_squared <= 1e-12:
        return (point - head).length
    factor = max(0.0, min(1.0, (point - head).dot(segment) / length_squared))
    return (point - (head + segment * factor)).length


def common_ancestor(first: bpy.types.Bone, second: bpy.types.Bone) -> bpy.types.Bone:
    """Return the closest shared parent for two limb roots."""

    ancestors = set()
    current = first.parent
    while current is not None:
        ancestors.add(current)
        current = current.parent
    current = second.parent
    while current is not None:
        if current in ancestors:
            return current
        current = current.parent
    raise RuntimeError("左右大腿没有共同骨盆祖先")


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


def isolate_foot_cross_midline(
    obj: bpy.types.Object,
    semantic_names: dict[str, str],
    mesh_to_armature,
    foot_centre_x: float,
) -> list[dict[str, object]]:
    """硬隔离跨身体中线的左右脚/脚掌混权。

    UniRig 会在鞋底内侧一圈顶点上同时给 foot_l/foot_r/ball_l/ball_r 权重，
    走路循环双脚反向摆动时把短边拉成数十倍。靴子本身左右分离，不需要胯部
    那样的平滑过渡：按顶点 X 相对双脚中点判定侧别，把对侧脚/脚掌权重按同侧
    foot:ball 比例并回同侧。
    """

    foot_l = obj.vertex_groups.get(semantic_names["foot_l"])
    foot_r = obj.vertex_groups.get(semantic_names["foot_r"])
    ball_l = obj.vertex_groups.get(semantic_names["ball_l"])
    ball_r = obj.vertex_groups.get(semantic_names["ball_r"])
    if any(group is None for group in (foot_l, foot_r, ball_l, ball_r)):
        return []
    changes: list[dict[str, object]] = []
    for vertex in obj.data.vertices:
        weights = {item.group: item.weight for item in vertex.groups}
        fl = weights.get(foot_l.index, 0.0)
        fr = weights.get(foot_r.index, 0.0)
        bl = weights.get(ball_l.index, 0.0)
        br = weights.get(ball_r.index, 0.0)
        left_side = fl + bl
        right_side = fr + br
        if left_side <= 1e-6 or right_side <= 1e-6:
            continue
        armature_x = (mesh_to_armature @ vertex.co).x
        if armature_x >= foot_centre_x:
            # 顶点在左侧：把右脚/右掌权重并回左脚/左掌
            same_total = left_side
            foot_after = (fl + fr) * (fl / same_total)
            ball_after = (bl + br) * (bl / same_total)
            selected, cross_foot, cross_ball = foot_l, foot_r, ball_r
            same_foot, same_ball = foot_l, ball_l
            side = "l"
        else:
            same_total = right_side
            foot_after = (fr + fl) * (fr / same_total)
            ball_after = (br + bl) * (br / same_total)
            selected, cross_foot, cross_ball = foot_r, foot_l, ball_l
            same_foot, same_ball = foot_r, ball_r
            side = "r"
        before = {
            "foot_l": round(fl, 7), "ball_l": round(bl, 7),
            "foot_r": round(fr, 7), "ball_r": round(br, 7),
        }
        cross_foot.remove([vertex.index])
        cross_ball.remove([vertex.index])
        same_foot.add([vertex.index], foot_after, "REPLACE")
        same_ball.add([vertex.index], ball_after, "REPLACE")
        changes.append({
            "object": obj.name,
            "vertex": vertex.index,
            "x": round(armature_x, 7),
            "selected_side": side,
            "assignment": "foot_cross_midline_isolate",
            "weights_before": before,
            "foot_after": round(foot_after, 7),
            "ball_after": round(ball_after, 7),
        })
    return changes


def clean_arm_pelvis_contamination(
    obj: bpy.types.Object,
    armature: bpy.types.Object,
    semantic_names: dict[str, str],
    mesh_to_armature,
    pelvis_group: bpy.types.VertexGroup,
    centre_x: float,
) -> list[dict[str, object]]:
    """清理夹克袖/前臂顶点被骨盆根骨污染的权重。

    UniRig 会把宽松袖筒上的顶点同时绑到 lowerarm/hand/手指骨和 pelvis。
    走路摆臂时 lowerarm 转动而 pelvis 不动，袖边被拉成 2~2.5 倍。这里按顶点
    X 判定左右臂，把明显落在手臂链上的顶点的 pelvis 份额按最近骨段重分配；
    真正的手指几何（最近骨段是 index_*）只剥掉 pelvis 并保持手指间比例。
    """

    changes: list[dict[str, object]] = []
    for side in ("l", "r"):
        names = [f"lowerarm_{side}", f"hand_{side}", f"index_01_{side}", f"index_02_{side}"]
        groups = {name: obj.vertex_groups.get(semantic_names.get(name, "")) for name in names}
        if any(group is None for group in groups.values()):
            continue
        bones = {name: armature.data.bones[semantic_names[name]] for name in names}
        for vertex in obj.data.vertices:
            weights = {item.group: item.weight for item in vertex.groups}
            pelvis_w = weights.get(pelvis_group.index, 0.0)
            if pelvis_w < 0.02:
                continue
            point = mesh_to_armature @ vertex.co
            if (point.x >= centre_x) != (side == "l"):
                continue
            side_w = {name: weights.get(groups[name].index, 0.0) for name in names}
            arm_w = sum(side_w.values())
            finger_w = side_w[f"index_01_{side}"] + side_w[f"index_02_{side}"]
            if finger_w < 0.2 or arm_w < 0.5:
                continue
            distances = {
                name: point_segment_distance(point, bones[name].head_local, bones[name].tail_local)
                for name in names
            }
            nearest = min(distances, key=distances.get)
            total = arm_w + pelvis_w
            # 只剥离错误的 pelvis 根骨份额，按顶点已有手臂链权重比例放大吸收。
            # 绝不把顶点硬重投到单根骨——硬隔离会在相邻未完全清理的袖筒顶点间
            # 制造更尖锐的拉伸边（A/B 探针实测 max 从 21.7 恶化到 25.3，已回退）。
            pelvis_group.remove([vertex.index])
            for name in names:
                groups[name].remove([vertex.index])
            scale = total / arm_w
            for name in names:
                if side_w[name] > 1e-8:
                    groups[name].add([vertex.index], side_w[name] * scale, "REPLACE")
            mode = "arm_remove_pelvis_renormalize"
            changes.append({
                "object": obj.name,
                "vertex": vertex.index,
                "x": round(point.x, 7),
                "selected_side": side,
                "nearest": nearest,
                "assignment": mode,
                "pelvis_weight_before": round(pelvis_w, 7),
                "arm_weights_before": {name: round(value, 7) for name, value in side_w.items()},
            })
    return changes


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
    left_bone = armature.data.bones[left_name]
    right_bone = armature.data.bones[right_name]
    pelvis_bone = armature.data.bones.get(semantic_names.get("pelvis", ""))
    if pelvis_bone is None:
        pelvis_bone = common_ancestor(left_bone, right_bone)
    pelvis_name = pelvis_bone.name
    left_lower_names = [semantic_names[name] for name in ("calf_l", "foot_l", "ball_l")]
    right_lower_names = [semantic_names[name] for name in ("calf_r", "foot_r", "ball_r")]
    center_x = pelvis_bone.head_local.x
    points = [point for bone in armature.data.bones for point in (bone.head_local, bone.tail_local)]
    rig_height = max(point.z for point in points) - min(point.z for point in points)
    left_head_x = armature.data.bones[left_name].head_local.x
    right_head_x = armature.data.bones[right_name].head_local.x
    blend_band = max(min(abs(left_head_x - center_x), abs(right_head_x - center_x)), rig_height * 0.02)
    foot_l_bone = armature.data.bones.get(semantic_names.get("foot_l", ""))
    foot_r_bone = armature.data.bones.get(semantic_names.get("foot_r", ""))
    if foot_l_bone is not None and foot_r_bone is not None:
        foot_centre_x = (foot_l_bone.head_local.x + foot_r_bone.head_local.x) / 2.0
    else:
        foot_centre_x = center_x
    changed: list[dict[str, object]] = []
    smoothed_vertices = 0
    foot_changes: list[dict[str, object]] = []
    arm_changes: list[dict[str, object]] = []

    for obj in bpy.context.scene.objects:
        if obj.type != "MESH" or not any(mod.type == "ARMATURE" for mod in obj.modifiers):
            continue
        left = obj.vertex_groups.get(left_name)
        right = obj.vertex_groups.get(right_name)
        pelvis = obj.vertex_groups.get(pelvis_name)
        if left is None or right is None or pelvis is None:
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
            elif abs(armature_x - center_x) <= blend_band:
                # 宽松短裤和衣摆在胯部常由同一块连续网格跨过中线。
                # 让这一小圈顶点同时跟随左右大腿，会在双腿反向摆动时把
                # 很短的边拉成尖刺；只保留当前位置一侧的大腿，并在中线
                # 到保护带边缘之间连续过渡到骨盆，避免形成新的硬接缝。
                before_left = weights.get(left.index, 0.0)
                before_right = weights.get(right.index, 0.0)
                thigh_fraction = abs(armature_x - center_x) / blend_band
                pelvis_weight = weights.get(pelvis.index, 0.0) + thigh_weight * (1.0 - thigh_fraction)
                selected_weight = thigh_weight * thigh_fraction
                selected = left if armature_x >= center_x else right
                left.remove([vertex.index])
                right.remove([vertex.index])
                if selected_weight > 1e-6:
                    selected.add([vertex.index], selected_weight, "REPLACE")
                pelvis.add([vertex.index], pelvis_weight, "REPLACE")
                changed.append({
                    "object": obj.name,
                    "vertex": vertex.index,
                    "x": round(armature_x, 7),
                    "left_weight_before": round(before_left, 7),
                    "right_weight_before": round(before_right, 7),
                    "selected_thigh": selected.name,
                    "selected_thigh_weight_after": round(selected_weight, 7),
                    "pelvis_weight_after": round(pelvis_weight, 7),
                    "assignment": "pelvis_center_blend",
                })
                continue
            else:
                # 中线保护带外按骨架实际左右方向硬隔离。这里不能继续做
                # 左右大腿混合，否则相邻顶点会被两条腿向相反方向牵引。
                left_fraction = 1.0 if armature_x > center_x else 0.0
                assignment = "left_by_position" if left_fraction else "right_by_position"
            right_fraction = 1.0 - left_fraction
            before_left = weights.get(left.index, 0.0)
            before_right = weights.get(right.index, 0.0)
            after_left = thigh_weight * left_fraction
            after_right = thigh_weight * right_fraction
            if abs(after_left - before_left) <= 1e-7 and abs(after_right - before_right) <= 1e-7:
                continue
            changed.append({
                "object": obj.name,
                "vertex": vertex.index,
                "x": round(armature_x, 7),
                "left_weight_before": round(before_left, 7),
                "right_weight_before": round(before_right, 7),
                "left_weight_after": round(after_left, 7),
                "right_weight_after": round(after_right, 7),
                "assignment": assignment,
            })
            left.remove([vertex.index])
            right.remove([vertex.index])
            if left_fraction > 1e-6:
                left.add([vertex.index], after_left, "REPLACE")
            if right_fraction > 1e-6:
                right.add([vertex.index], after_right, "REPLACE")
        for side in ("l", "r"):
            thigh = obj.vertex_groups.get(semantic_names[f"thigh_{side}"])
            calf = obj.vertex_groups.get(semantic_names[f"calf_{side}"])
            if thigh is not None and calf is not None:
                smoothed_vertices += smooth_joint_weights(obj, thigh, calf)
        foot_changes.extend(isolate_foot_cross_midline(obj, semantic_names, mesh_to_armature, foot_centre_x))
        if changed or foot_changes:
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
            "foot_centre_x": round(foot_centre_x, 7),
            "blend_band": round(blend_band, 7),
            "changed_vertex_count": len(changed),
            "foot_isolate_count": len(foot_changes),
            "arm_pelvis_clean_count": len(arm_changes),
            "smoothed_vertex_updates": smoothed_vertices,
            "changes": changed,
            "foot_changes": foot_changes,
            "arm_changes": arm_changes,
        }, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
