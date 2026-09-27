"""ForgeLoop v2 —— HY-Motion 动作烘焙到 UniRig 语义骨架（bridge-after-rain 试点）

把 HY-Motion 动作库 FBX（语义骨架：spine/upperarm_*/thigh_* 等）的骨骼动作曲线
烘焙到目标角色 GLB 的骨架（UniRig 已语义命名：Head/calf_*/foot_* 等），导出
带动作的 GLB（NLA 轨道 → glTF 动作片段），供穿模门禁 analyze_clipping.py 抽帧分析；
同时可选输出逐帧 LOCAL 四元数 JSON（与游戏运行时 clip 定义一致，供游戏私有审片目录复测）。

仅做"相对旋转 delta 映射 + 骨盆位移按骨架高度比缩放"，不修改网格与权重。
自动化终点固定为人工审片；本脚本不做任何质量判定。

用法：
  blender --background --python retarget_hy.py -- \
      --input assets/girl.glb --fbx hang.fbx --alias hang \
      --output out.glb [--frames-out hang.json] [--fps 30]
"""
from __future__ import annotations

import argparse
import json
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
    parser.add_argument("--frames-out", default=None)
    parser.add_argument("--fps", type=int, default=30)
    return parser.parse_args(args)


def rig_height(armature: bpy.types.Object) -> float:
    """沿世界 Z 的骨架纵向长度（用对象矩阵变换后的骨端点，兼容 Y-up 的 FBX 导入）。"""
    mat = armature.matrix_world
    points = [
        (mat @ bone.head_local).z
        for bone in armature.data.bones
    ] + [
        (mat @ bone.tail_local).z
        for bone in armature.data.bones
    ]
    return max(points) - min(points)


# SMPL-H（HY-Motion 动作库）→ UniRig 语义骨架 骨名映射。
# 目标骨架没有手指骨（单骨 hand_l），SMPL 的 Spine3/Head/手指/脚趾按末端截断处理。
SMPL_TO_UNIRIG = {
    "Pelvis": "pelvis",
    "Spine1": "spine_01",
    "Spine2": "spine_02",
    "Spine3": "neck_01",
    "Neck": "neck_01",
    "Head": "neck_01",
    "L_Collar": "clavicle_l",
    "L_Shoulder": "upperarm_l",
    "L_Elbow": "lowerarm_l",
    "L_Wrist": "hand_l",
    "R_Collar": "clavicle_r",
    "R_Shoulder": "upperarm_r",
    "R_Elbow": "lowerarm_r",
    "R_Wrist": "hand_r",
    "L_Hip": "thigh_l",
    "L_Knee": "calf_l",
    "L_Ankle": "foot_l",
    "L_Foot": "ball_l",
    "R_Hip": "thigh_r",
    "R_Knee": "calf_r",
    "R_Ankle": "foot_r",
    "R_Foot": "ball_r",
}


def local_quats_at_frame(target, frame):
    """当前帧下，目标骨架每骨相对其父骨同帧世界的 LOCAL 旋转（游戏运行时 clip 定义）。"""
    scene = bpy.context.scene
    scene.frame_set(int(frame))
    bpy.context.view_layer.update()
    rendered = {}
    for pb in target.pose.bones:
        rendered[pb.name] = target.matrix_world @ pb.matrix
    out = {}
    for name in rendered:
        parent = target.pose.bones[name].parent
        m = rendered[parent.name].inverted() @ rendered[name] if parent is not None else rendered[name]
        q = m.to_quaternion().normalized()
        out[name] = [q.x, q.y, q.z, q.w]
    return out


def main() -> None:
    args = parse_args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=args.input)
    target = next((o for o in bpy.context.scene.objects if o.type == "ARMATURE"), None)
    if target is None:
        raise RuntimeError("输入 GLB 未包含骨架")

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
    # 源骨盆 rest 位置（减去后只传递运动增量，避免 SMPL 的大常量偏移把角色甩飞）
    source_pelvis_rest = (
        source.data.bones["Pelvis"].head_local
        if source.data.bones.get("Pelvis") is not None
        else bpy.Vector((0, 0, 0))
    )

    baked: list[str] = []
    start = end = 0
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
                # 源骨架用 SMPL-H 命名，先查映射表（目标没有手指骨/末端链，跳过）
                src_name = next((s for s, t in SMPL_TO_UNIRIG.items() if t == name), None)
                if src_name is None:
                    continue
                sp = source.pose.bones.get(src_name)
                tp = target.pose.bones.get(name)
                srest = source.data.bones.get(src_name)
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
                    s_motion = s_basis @ (sp.location - source_pelvis_rest)
                    tp.location = t_basis.inverted() @ (s_motion * scale_ratio)
                    tp.keyframe_insert("location", frame=frame, group=name)
                tp.keyframe_insert("rotation_quaternion", frame=frame, group=name)
        target.animation_data.action = None
        # NLA 轨道：glTF 导出器把每条 NLA 轨道输出为一个动作片段（与 retarget.py 一致）
        track = target.animation_data.nla_tracks.new()
        track.name = args.alias
        strip = track.strips.new(args.alias, int(start), target_action)
        strip.action_frame_start = int(start)
        strip.action_frame_end = int(end)
        baked.append(args.alias)
        break  # 只烘焙第一个动作（单动作场景）

    if not baked:
        raise RuntimeError("没有可烘焙的动作曲线")

    # 删除源 FBX 骨架与多余对象；仅保留目标骨架及其下网格（目标角色本体）
    for o in list(bpy.data.objects):
        if o is target:
            continue
        if o.type == "ARMATURE":
            # 源 FBX 骨架（及任何多余骨架）
            bpy.data.objects.remove(o, do_unlink=True)
        elif o.type == "MESH":
            # 只保留直接挂在目标骨架下的蒙皮网格（boy-runtime.glb 自带 Icosphere 标记物，须一并删除）
            if o.parent is not target:
                bpy.data.objects.remove(o, do_unlink=True)

    # 逐帧 LOCAL 四元数 JSON（游戏运行时 clip 定义）
    if args.frames_out:
        frames = []
        for frame in range(start, end + 1):
            frames.append(local_quats_at_frame(target, frame))
        n = end - start + 1
        out = {
            "clip": args.alias,
            "fps": args.fps,
            "duration": round(n / args.fps, 4),
            "frames": frames,
        }
        Path(args.frames_out).parent.mkdir(parents=True, exist_ok=True)
        with open(args.frames_out, "w", encoding="utf-8") as fh:
            json.dump(out, fh, ensure_ascii=False)

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    # 与 export_profile.py 同一导出参数：NLA 轨道 → GLB 动作片段（export_animation_mode=NLA_TRACKS）
    bpy.ops.export_scene.gltf(
        filepath=str(output),
        export_format="GLB",
        export_apply=True,
        export_yup=True,
        export_skins=True,
        export_animations=True,
        export_animation_mode="NLA_TRACKS",
        export_morph=True,
        export_materials="EXPORT",
    )
    print(
        f"OK alias={args.alias} frames={start}..{end} scale_ratio={scale_ratio:.4f} "
        f"output={output} frames_out={args.frames_out}"
    )


if __name__ == "__main__":
    main()
