"""ForgeLoop v2 —— HY-Motion 动作烘焙到 UniRig 语义骨架（bridge-after-rain 试点）

把 HY-Motion 动作库 FBX（语义骨架：spine/upperarm_*/thigh_* 等）的骨骼动作曲线
烘焙到目标角色 GLB 的骨架（UniRig 已语义命名：Head/calf_*/foot_* 等），导出
带动作的 GLB，供穿模门禁 analyze_clipping.py 抽帧分析。

仅做"相对旋转 delta 映射 + 骨盆位移按骨架高度比缩放"，不修改网格与权重。
自动化终点固定为人工审片；本脚本不做任何质量判定。

用法：
  blender --background --python retarget_hy.py -- \
      --input assets/girl.glb --fbx hang.fbx --alias hang \
      --output out.glb
"""
from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Quaternion


def parse_args() -> argparse.Namespace:
    args = sys.argv[sys.argv.index("--") + 1 :]
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--fbx", required=True)
    parser.add_argument("--alias", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args(args)


def rig_height(armature: bpy.types.Object) -> float:
    points = [
        coordinate
        for bone in armature.data.bones
        for coordinate in (bone.head_local.z, bone.tail_local.z)
    ]
    return max(points) - min(points)


def main() -> None:
    args = parse_args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=args.input)
    target = next((o for o in bpy.context.scene.objects if o.type == "ARMATURE"), None)
    if target is None:
        raise RuntimeError("输入 GLB 未包含骨架")
    target_meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]

    bpy.ops.import_scene.fbx(filepath=args.fbx)
    source = next(
        (o for o in bpy.context.scene.objects if o.type == "ARMATURE" and o is not target),
        None,
    )
    if source is None:
        raise RuntimeError("HY-Motion FBX 未包含源骨架")
    source_actions = [a for a in bpy.data.actions if a.users and a.users >= 1]
    if not source_actions:
        raise RuntimeError("HY-Motion FBX 未包含动作曲线")

    target.animation_data_create()
    target_bone_names = {bone.name for bone in target.data.bones}
    scale_ratio = rig_height(target) / max(rig_height(source), 1e-6)

    baked: list[str] = []
    for source_action in source_actions:
        target_action = bpy.data.actions.new(args.alias)
        target.animation_data.action = target_action
        start = math.floor(source_action.frame_range[0])
        end = math.ceil(source_action.frame_range[1])
        scene = bpy.context.scene
        for frame in range(start, end + 1):
            scene.frame_set(frame)
            bpy.context.view_layer.update()
            for name in target_bone_names:
                sp = source.pose.bones.get(name)
                tp = target.pose.bones.get(name)
                srest = source.data.bones.get(name)
                trest = target.data.bones.get(name)
                if not all((sp, tp, srest, trest)):
                    continue
                s_basis = srest.matrix_local.to_quaternion()
                t_basis = trest.matrix_local.to_quaternion()
                s_delta = sp.matrix_basis.to_quaternion()
                t_delta = (
                    t_basis.inverted()
                    @ s_basis
                    @ s_delta
                    @ s_basis.inverted()
                    @ t_basis
                )
                tp.rotation_mode = "QUATERNION"
                tp.rotation_quaternion = t_delta.normalized()
                tp.location = (0.0, 0.0, 0.0)
                if name == "pelvis":
                    s_motion = s_basis @ sp.location
                    tp.location = t_basis.inverted() @ (s_motion * scale_ratio)
                    tp.keyframe_insert("location", frame=frame, group=name)
                tp.keyframe_insert("rotation_quaternion", frame=frame, group=name)
        target.animation_data.action = None
        baked.append(args.alias)
        break  # 只烘焙第一个动作（单动作场景）

    if not baked:
        raise RuntimeError("没有可烘焙的动作曲线")

    # 导出前挂接动作作为 active action，保证 GLB 携带该动作（Blender 4.5 glTF 导出器
    # 不支持 NLA strip 的 action slot，直接用 active action 导出）。
    target.animation_data.action = bpy.data.actions.get(args.alias)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(output),
        export_format="GLB",
        use_selection=False,
        export_apply=True,
    )
    print(
        f"OK alias={args.alias} frames={start}..{end} scale_ratio={scale_ratio:.4f} "
        f"meshes={[o.name for o in target_meshes]} output={output}"
    )


if __name__ == "__main__":
    main()
