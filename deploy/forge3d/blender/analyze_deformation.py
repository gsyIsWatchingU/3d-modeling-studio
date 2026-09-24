"""在走路动作中统计蒙皮网格的包围盒膨胀和边拉伸。"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def parse_args() -> argparse.Namespace:
    args = sys.argv[sys.argv.index("--") + 1 :]
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--action", default="walk_loop")
    parser.add_argument("--samples", type=int, default=12)
    return parser.parse_args(args)


def import_scene(path: Path) -> None:
    if path.suffix.lower() == ".blend":
        bpy.ops.wm.open_mainfile(filepath=str(path))
    else:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=str(path))


def evaluated_vertices(obj: bpy.types.Object, depsgraph) -> list[Vector]:
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    try:
        return [evaluated.matrix_world @ vertex.co for vertex in mesh.vertices]
    finally:
        evaluated.to_mesh_clear()


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, round((len(ordered) - 1) * fraction))]


def bounds(points: list[Vector]) -> tuple[float, float, float]:
    return (
        max(point.x for point in points) - min(point.x for point in points),
        max(point.y for point in points) - min(point.y for point in points),
        max(point.z for point in points) - min(point.z for point in points),
    )


def vertex_weights(obj: bpy.types.Object, index: int) -> list[dict[str, float | str]]:
    groups = {group.index: group.name for group in obj.vertex_groups}
    return [
        {"bone": groups.get(item.group, str(item.group)), "weight": round(item.weight, 6)}
        for item in sorted(obj.data.vertices[index].groups, key=lambda value: value.weight, reverse=True)
    ]


def main() -> None:
    args = parse_args()
    source = Path(args.input).resolve()
    import_scene(source)
    armatures = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
    if len(armatures) != 1:
        raise RuntimeError(f"期望一个骨架，实际为 {len(armatures)}")
    armature = armatures[0]
    meshes = [
        obj for obj in bpy.context.scene.objects
        if obj.type == "MESH" and any(mod.type == "ARMATURE" for mod in obj.modifiers)
    ]
    if not meshes:
        raise RuntimeError("没有找到蒙皮网格")
    action = bpy.data.actions.get(args.action)
    if action is None:
        matches = [item for item in bpy.data.actions if args.action in item.name]
        if len(matches) != 1:
            raise RuntimeError(f"没有唯一匹配动作: {args.action}")
        action = matches[0]

    armature.animation_data_create()
    for track in armature.animation_data.nla_tracks:
        track.mute = True
    scene = bpy.context.scene
    depsgraph = bpy.context.evaluated_depsgraph_get()

    armature.data.pose_position = "REST"
    armature.animation_data.action = None
    scene.frame_set(0)
    bpy.context.view_layer.update()
    rest_vertices = {obj.name: evaluated_vertices(obj, depsgraph) for obj in meshes}
    rest_edges = {obj.name: [(edge.vertices[0], edge.vertices[1]) for edge in obj.data.edges] for obj in meshes}
    rest_points = [point for values in rest_vertices.values() for point in values]
    rest_width, rest_depth, rest_height = bounds(rest_points)
    rest_height = max(rest_height, 1e-6)

    armature.data.pose_position = "POSE"
    armature.animation_data.action = action
    start, end = action.frame_range
    frames = [start + (end - start) * index / max(1, args.samples - 1) for index in range(args.samples)]
    width_to_height = []
    depth_to_height = []
    width_expansion = []
    depth_expansion = []
    all_stretches = []
    worst_edges = []
    frame_reports = []
    for frame in frames:
        scene.frame_set(int(frame), subframe=frame % 1)
        bpy.context.view_layer.update()
        current_by_object = {obj.name: evaluated_vertices(obj, depsgraph) for obj in meshes}
        current_points = [point for values in current_by_object.values() for point in values]
        width, depth, height = bounds(current_points)
        height = max(height, 1e-6)
        frame_stretches = []
        for obj in meshes:
            current = current_by_object[obj.name]
            rest = rest_vertices[obj.name]
            for first, second in rest_edges[obj.name]:
                rest_length = (rest[first] - rest[second]).length
                if rest_length <= 1e-7:
                    continue
                stretch = (current[first] - current[second]).length / rest_length
                frame_stretches.append(stretch)
                if len(worst_edges) < 16 or stretch > worst_edges[-1]["stretch_ratio"]:
                    worst_edges.append({
                        "object": obj.name,
                        "frame": round(frame, 3),
                        "vertices": [first, second],
                        "rest_length": round(rest_length, 8),
                        "posed_length": round((current[first] - current[second]).length, 8),
                        "stretch_ratio": round(stretch, 5),
                        "weights": [vertex_weights(obj, first), vertex_weights(obj, second)],
                    })
                    worst_edges.sort(key=lambda item: item["stretch_ratio"], reverse=True)
                    del worst_edges[16:]
        all_stretches.extend(frame_stretches)
        width_to_height.append(width / height)
        depth_to_height.append(depth / height)
        width_expansion.append(width / max(rest_width, 1e-6))
        depth_expansion.append(depth / max(rest_depth, 1e-6))
        frame_reports.append({
            "frame": round(frame, 3),
            "width_to_height": round(width / height, 5),
            "depth_to_height": round(depth / height, 5),
            "width_expansion_ratio": round(width_expansion[-1], 5),
            "depth_expansion_ratio": round(depth_expansion[-1], 5),
            "p99_edge_stretch_ratio": round(percentile(frame_stretches, 0.99), 5),
            "max_edge_stretch_ratio": round(max(frame_stretches, default=0.0), 5),
        })

    stretched_edges = sum(value > 2.0 for value in all_stretches)
    report = {
        "asset": str(source),
        "action": action.name,
        "frames": frame_reports,
        "worst_edges": worst_edges,
        "quality": {
            "rest_width_to_height": round(rest_width / rest_height, 5),
            "rest_depth_to_height": round(rest_depth / rest_height, 5),
            "max_width_to_height": round(max(width_to_height, default=0.0), 5),
            "max_depth_to_height": round(max(depth_to_height, default=0.0), 5),
            "max_width_expansion_ratio": round(max(width_expansion, default=0.0), 5),
            "max_depth_expansion_ratio": round(max(depth_expansion, default=0.0), 5),
            "p99_edge_stretch_ratio": round(percentile(all_stretches, 0.99), 5),
            "max_edge_stretch_ratio": round(max(all_stretches, default=0.0), 5),
            "stretched_edge_ratio": round(stretched_edges / max(1, len(all_stretches)), 6),
        },
    }
    Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
