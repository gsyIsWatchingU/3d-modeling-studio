#!/usr/bin/env python3
"""normalize_root_translation.py — ForgeLoop v3.1 根/骨盆位移归一化修复脚本（gsy013 Blender 工位）

animation.root_translation_normalization = normalize_root_translation

真实缺陷：源 FBX 单位污染导致 hang 动作的 pelvis/root position 通道出现巨大漂移
（gsy013 v3-anim-report.json: max_root_translation_ratio = 86.75535，即骨盆世界位移约为
骨架高度的 86.8% —— 一个 2.4s 挂绳循环内骨盆移动 ~1.09m，物理上不可能）。

修复目标（骨架/rest/bind 空间内正确归一化，禁止隐藏模型/静态动作/缩小角色/镜头遮挡）：
  1. 导入 GLB，定位骨架与指定动作（默认 hang）；
  2. 以骨架 rest/bind 空间为基准，取骨盆（回退 root/首骨）的 rest 世界位置作为锚点；
  3. 逐帧采样骨盆世界平移，减去首帧锚点，用最小二乘去掉线性趋势（污染斜坡/单位偏差）；
  4. 剩余振荡分量限幅到 0.15 × rig_height（物理合理的摆动幅度，保留非静态运动）；
  5. 在局部空间写回 pelvis 的 translation fcurve，强制循环接缝（末帧 == 首帧）；
  6. 导出新 GLB（保留网格/蒙皮/全部动画轨道），输出 JSON 报告（before/after 指标）。
"""
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
    parser.add_argument("--input", required=True, help="输入 GLB")
    parser.add_argument("--output", required=True, help="输出 GLB（新文件，不覆盖输入）")
    parser.add_argument("--action", default="hang", help="要修复的动作名")
    parser.add_argument("--report", required=True, help="JSON 报告输出路径")
    parser.add_argument("--max-ratio", type=float, default=0.15, help="骨盆摆动幅度上限（× rig_height）")
    return parser.parse_args(args)


def import_scene(path: Path) -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(path))


def rig_height(armature: bpy.types.Object) -> float:
    points = [
        armature.matrix_world @ point
        for bone in armature.data.bones
        for point in (bone.head_local, bone.tail_local)
    ]
    if not points:
        return 1.0
    return max(p.z for p in points) - min(p.z for p in points)


def find_pelvis(armature: bpy.types.Object):
    """返回骨盆/根骨（pose bone），回退：pelvis → root → 第一个带位置通道的骨 → 首骨。"""
    names = ["pelvis", "root", "Root", "hips", "Hips", "spine"]
    for name in names:
        pb = armature.pose.bones.get(name)
        if pb is not None:
            return pb
    for pb in armature.pose.bones:
        if pb.parent is None:
            return pb
    return armature.pose.bones[0]


def find_action(action_name: str):
    action = bpy.data.actions.get(action_name)
    if action is not None:
        return action
    candidates = [a for a in bpy.data.actions if action_name in a.name]
    if len(candidates) != 1:
        raise RuntimeError(f"没有唯一匹配动作: {action_name}（{len(candidates)} 个候选）")
    return candidates[0]


def linear_trend(values: list[Vector]) -> list[Vector]:
    """逐轴最小二乘线性趋势（用于剥离单位污染斜坡）。"""
    n = len(values)
    if n < 2:
        return [Vector((0, 0, 0))] * n
    idx = list(range(n))
    mean_x = sum(idx) / n
    mean_y = [sum(v[i] for v in values) / n for i in range(3)]
    denom = sum((x - mean_x) ** 2 for x in idx) or 1.0
    slopes = []
    for axis in range(3):
        num = sum((x - mean_x) * (values[x][axis] - mean_y[axis]) for x in idx)
        slopes.append(num / denom)
    return [Vector((s * (x - mean_x) for s in slopes)) for x in idx]


def main() -> None:
    args = parse_args()
    source = Path(args.input).resolve()
    output = Path(args.output).resolve()
    if output == source:
        raise RuntimeError("输出路径不能与输入相同（绝不覆盖输入产物）")
    output.parent.mkdir(parents=True, exist_ok=True)

    import_scene(source)
    armatures = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
    if len(armatures) != 1:
        raise RuntimeError(f"期望一个骨架，实际为 {len(armatures)}")
    armature = armatures[0]
    action = find_action(args.action)
    pelvis = find_pelvis(armature)

    height = rig_height(armature)
    max_amp = args.max_ratio * height

    # 先取 rest/bind 空间锚点（不挂动作时）
    armature.animation_data_create()
    for track in armature.animation_data.nla_tracks:
        track.mute = True
    armature.animation_data.action = action

    start, end = action.frame_range
    # 按动作实际帧率/步长采样（≤ 60 采样，足够还原斜坡与振荡）
    n_samples = min(60, max(24, int(end - start) + 1))
    frames = [start + (end - start) * i / max(1, n_samples - 1) for i in range(n_samples)]

    world_pts: list[Vector] = []
    for f in frames:
        bpy.context.scene.frame_set(int(f), subframe=f % 1)
        bpy.context.view_layer.update()
        world_pts.append(pelvis.matrix_world.translation.copy())

    anchor = world_pts[0].copy()
    rel = [p - anchor for p in world_pts]
    trend = linear_trend(rel)
    detrended = [r - t for r, t in zip(rel, trend)]

    before_max_travel = max(v.length for v in rel)
    before_ratio = before_max_travel / height if height else 0.0

    raw_max = max(v.length for v in detrended) or 1e-9
    clamped = False
    if raw_max > max_amp:
        scale = max_amp / raw_max
        detrended = [v * scale for v in detrended]
        clamped = True
    after_max_travel = max(v.length for v in detrended)
    after_ratio = after_max_travel / height if height else 0.0

    # 强制循环接缝：末帧位移 == 首帧位移
    detrended[-1] = detrended[0].copy()

    # 写回局部平移 fcurve：新世界位置 = anchor + detrended(t)，再转到 pelvis 的父空间
    parent = pelvis.parent
    data_path = f'pose.bones["{pelvis.name}"].location'
    existing = [fc for fc in action.fcurves if fc.data_path == data_path]
    for fc in existing:
        action.fcurves.remove(fc)

    local_vals: list[Vector] = []
    for i, f in enumerate(frames):
        bpy.context.scene.frame_set(int(f), subframe=f % 1)
        bpy.context.view_layer.update()
        new_world = anchor + detrended[i]
        parent_world = parent.matrix_world if parent is not None else None
        if parent_world is not None:
            local = parent_world.inverted() @ new_world
        else:
            local = new_world
        local_vals.append(local)

    for axis in range(3):
        fc = action.fcurves.new(data_path=data_path, index=axis)
        for i, f in enumerate(frames):
            kp = fc.keyframe_points.insert(int(f), local_vals[i][axis])
            kp.interpolation = "LINEAR"

    # 报告（before/after，输出路径不覆盖输入）
    report = {
        "repair_kind": "animation.root_translation_normalization",
        "action": action.name,
        "pelvis_bone": pelvis.name,
        "rig_height": round(height, 5),
        "input": str(source),
        "output": str(output),
        "before": {
            "max_world_travel": round(before_max_travel, 5),
            "max_root_translation_ratio": round(before_ratio, 5),
        },
        "after": {
            "max_world_travel": round(after_max_travel, 5),
            "max_root_translation_ratio": round(after_ratio, 5),
        },
        "clamped_to_ratio": round(max_amp / height, 5) if height else None,
        "clamped": clamped,
        "loop_seam_enforced": True,
        "samples": n_samples,
    }

    # 导出：保留网格/蒙皮/动画（全部轨道），不选中其余对象
    bpy.ops.object.mode_set(mode="OBJECT")
    armature.animation_data.action = None
    bpy.ops.export_scene.gltf(
        filepath=str(output),
        export_format="GLB",
        use_selection=False,
        export_apply=False,
        export_animations=True,
        export_skins=True,
        export_yup=True,
    )

    Path(args.report).parent.mkdir(parents=True, exist_ok=True)
    Path(args.report).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
