"""将 UniRig 无语义骨架标准化，并挂接 CC0 人形动作库。

UniRig 输出的骨骼名为 ``bone_N``。本脚本依据骨架拓扑和关节位置识别
躯干、四肢及简化手指，再改名为通用人形骨骼。动作库的同名骨骼曲线随后
写入目标骨架的独立 NLA 轨道，供 glTF 导出器输出多个动作片段。
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Quaternion


ACTION_ALIASES = {
    "Idle_Loop": "idle_loop",
    "Idle_Torch_Loop": "idle_torch_loop",
    "Walk_Loop": "walk_loop",
    "Walk_Formal_Loop": "walk_formal_loop",
    "Jog_Fwd_Loop": "run_loop",
    "Sprint_Loop": "sprint_loop",
    "Crouch_Idle_Loop": "crouch_idle_loop",
    "Crouch_Fwd_Loop": "crouch_walk_loop",
    "Interact": "interact",
    "Push_Loop": "push_loop",
    "Jump_Start": "jump_start",
    "Jump_Loop": "jump_loop",
    "Jump_Land": "jump_land",
    "Roll": "roll",
    "Death01": "death",
}

LOCOMOTION_ACTIONS = {
    "walk_loop",
    "walk_formal_loop",
    "run_loop",
    "sprint_loop",
    "crouch_walk_loop",
}


def add_arm_follow_through(
    rotation: Quaternion,
    alias: str,
    bone_name: str,
    phase: float,
) -> Quaternion:
    """对移动动作使用保守手臂摆动，避免不同骨滚转把手臂卷到胸前。"""
    if alias not in LOCOMOTION_ACTIONS:
        return rotation
    side = 1.0 if bone_name.endswith("_l") else -1.0
    opposite_phase = phase + (math.pi if side < 0 else 0.0)
    identity = Quaternion((1.0, 0.0, 0.0, 0.0))
    if bone_name.startswith("upperarm_"):
        mapped = identity.slerp(rotation, 0.22)
        return (
            mapped
            @ Quaternion((0.0, 0.0, 1.0), -side * math.radians(5.0))
        ).normalized()
    if bone_name.startswith("lowerarm_"):
        mapped = identity.slerp(rotation, 0.15)
        flex = -math.radians(9.0) - math.radians(2.5) * (1.0 + math.cos(opposite_phase))
        return (
            mapped
            @ Quaternion((1.0, 0.0, 0.0), flex)
            @ Quaternion((0.0, 0.0, 1.0), -side * math.radians(1.5))
        ).normalized()
    if bone_name.startswith("hand_"):
        mapped = identity.slerp(rotation, 0.12)
        flex = math.radians(2.0) * math.sin(opposite_phase - 0.35)
        sway = side * math.radians(1.5) * math.cos(opposite_phase)
        return (
            mapped
            @ Quaternion((1.0, 0.0, 0.0), flex)
            @ Quaternion((0.0, 0.0, 1.0), sway)
        ).normalized()
    return rotation


def parse_args() -> argparse.Namespace:
    args = sys.argv[sys.argv.index("--") + 1 :]
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--library", required=True)
    parser.add_argument("--profile", required=True)
    return parser.parse_args(args)


def import_scene(path: Path) -> None:
    if path.suffix.lower() == ".fbx":
        bpy.ops.import_scene.fbx(filepath=str(path))
    else:
        bpy.ops.import_scene.gltf(filepath=str(path))


def chain(start: bpy.types.Bone) -> list[bpy.types.Bone]:
    result = [start]
    current = start
    while len(current.children) == 1:
        current = current.children[0]
        result.append(current)
    return result


def semantic_mapping(armature: bpy.types.Object) -> dict[str, str]:
    roots = [bone for bone in armature.data.bones if bone.parent is None]
    if len(roots) != 1:
        raise RuntimeError("UniRig 骨架拓扑不符合单根人形结构")
    root = roots[0]
    # UniRig may insert one or more unweighted helper roots above the pelvis.
    # Follow only an unambiguous single-child chain until the human pelvis
    # branch (spine + two legs) is reached. prune_unmapped_bones later merges
    # any helper-root weights into pelvis and removes the helper bones.
    while len(root.children) == 1 and len(root.children[0].children) >= 3:
        root = root.children[0]
    if len(root.children) < 3:
        raise RuntimeError("UniRig 骨架拓扑缺少脊柱与双腿分支")
    children = list(root.children)
    spine_start = max(children, key=lambda bone: bone.tail_local.z - bone.head_local.z)
    leg_starts = [bone for bone in children if bone != spine_start]
    if len(leg_starts) != 2:
        raise RuntimeError("没有识别到双腿")

    spine = chain(spine_start)
    # Some valid UniRig outputs use two torso bones before the shoulder split.
    # The action baker already skips missing semantic bones, so two is enough.
    if len(spine) < 2:
        raise RuntimeError("脊柱链过短")
    chest = spine[-1]
    upper_children = list(chest.children)
    neck_start = max(
        upper_children,
        key=lambda bone: bone.tail_local.z - bone.head_local.z,
    )
    arm_starts = [bone for bone in upper_children if bone != neck_start]
    if len(arm_starts) != 2:
        raise RuntimeError("没有识别到双臂")

    mapping: dict[str, str] = {root.name: "pelvis"}
    spine_names = ["spine_01", "spine_02", "spine_03"]
    for bone, name in zip(spine[:3], spine_names, strict=False):
        mapping[bone.name] = name
    neck = chain(neck_start)
    mapping[neck[0].name] = "neck_01"
    if len(neck) > 1:
        mapping[neck[1].name] = "Head"

    center_x = root.head_local.x
    for start in arm_starts:
        side = "l" if start.tail_local.x > center_x else "r"
        names = [
            f"clavicle_{side}",
            f"upperarm_{side}",
            f"lowerarm_{side}",
            f"hand_{side}",
            f"index_01_{side}",
            f"index_02_{side}",
            f"index_03_{side}",
        ]
        for bone, name in zip(chain(start), names, strict=False):
            mapping[bone.name] = name

    for start in leg_starts:
        side = "l" if start.head_local.x > center_x else "r"
        names = [f"thigh_{side}", f"calf_{side}", f"foot_{side}", f"ball_{side}"]
        for bone, name in zip(chain(start), names, strict=False):
            mapping[bone.name] = name
    return mapping


def rename_rig(armature: bpy.types.Object, mapping: dict[str, str]) -> None:
    for old_name, new_name in mapping.items():
        bone = armature.data.bones.get(old_name)
        if bone is not None:
            bone.name = new_name
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        groups = {group.name: group for group in obj.vertex_groups}
        for old_name, new_name in mapping.items():
            if old_name in groups and new_name not in groups:
                groups[old_name].name = new_name


def prune_unmapped_bones(armature: bpy.types.Object, keep_names: set[str]) -> None:
    """移动档把未映射的手指骨权重合并到最近的语义父骨。"""
    fallback: dict[str, str] = {}
    for bone in armature.data.bones:
        if bone.name in keep_names:
            continue
        parent = bone.parent
        while parent is not None and parent.name not in keep_names:
            parent = parent.parent
        fallback[bone.name] = parent.name if parent is not None else "pelvis"

    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        for source_name, target_name in fallback.items():
            source_group = obj.vertex_groups.get(source_name)
            if source_group is None:
                continue
            target_group = obj.vertex_groups.get(target_name) or obj.vertex_groups.new(
                name=target_name
            )
            source_index = source_group.index
            for vertex in obj.data.vertices:
                for membership in vertex.groups:
                    if membership.group == source_index and membership.weight > 0:
                        target_group.add([vertex.index], membership.weight, "ADD")
                        break
            obj.vertex_groups.remove(source_group)
        if obj.vertex_groups:
            bpy.context.view_layer.objects.active = obj
            obj.select_set(True)
            bpy.ops.object.vertex_group_normalize_all(group_select_mode="ALL", lock_active=False)
            obj.select_set(False)

    bpy.context.view_layer.objects.active = armature
    armature.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    for bone in list(armature.data.edit_bones):
        if bone.name not in keep_names:
            armature.data.edit_bones.remove(bone)
    bpy.ops.object.mode_set(mode="OBJECT")
    armature.select_set(False)


def neutralize_foot_rest(armature: bpy.types.Object) -> None:
    """把 A-pose 脚部外撇收敛到矢状面。

    Hunyuan3D/UniRig 产出的 rest pose 常带脚掌外翻（左右脚向两侧张开），
    动作重定向只叠加相对 delta，外撇会残留到最终资产。本函数在 EDIT 模式下
    绕踝关节（世界竖直轴 Blender Z）把脚骨旋转到与矢状面（-Y）平行；
    前掌骨头部跟随脚骨尾部，方向由父骨继承，保证脚掌整体刚性跟随。
    """
    bpy.context.view_layer.objects.active = armature
    bpy.ops.object.mode_set(mode="EDIT")
    edit_bones = armature.data.edit_bones
    for side in ("l", "r"):
        foot = edit_bones.get("foot_" + side)
        if foot is None:
            continue
        ball = edit_bones.get("ball_" + side)
        anchor = foot.head.copy()
        tip = ball.head.copy() if ball is not None else foot.tail.copy()
        direction = tip - anchor
        direction.z = 0.0
        length = direction.length
        if length < 1e-6:
            continue
        current = math.atan2(direction.y, direction.x)
        target = -math.pi / 2.0  # 角色矢状面（脚指向 -Y）
        delta = target - current
        if abs(delta) < math.radians(2.0):
            continue
        m = Matrix.Translation(anchor) @ Matrix.Rotation(delta, 4, "Z") @ Matrix.Translation(-anchor)
        foot.transform(m, roll=False)
        if ball is not None:
            ball.head = foot.tail.copy()
    bpy.ops.object.mode_set(mode="OBJECT")


def compatible_actions(
    actions: list[bpy.types.Action], bone_names: set[str]
) -> list[tuple[bpy.types.Action, str]]:
    result: list[tuple[bpy.types.Action, str]] = []
    for action in actions:
        alias = ACTION_ALIASES.get(action.name)
        if alias is None:
            continue
        result.append((action, alias))
    return result


def rig_height(armature: bpy.types.Object) -> float:
    points = [
        coordinate
        for bone in armature.data.bones
        for coordinate in (bone.head_local.z, bone.tail_local.z)
    ]
    return max(points) - min(points)


def bake_action(
    source_armature: bpy.types.Object,
    target_armature: bpy.types.Object,
    source_action: bpy.types.Action,
    alias: str,
    bone_names: set[str],
) -> bpy.types.Action:
    source_armature.animation_data_create()
    target_armature.animation_data_create()
    for track in source_armature.animation_data.nla_tracks:
        track.mute = True
    for track in target_armature.animation_data.nla_tracks:
        track.mute = True
    source_armature.animation_data.action = source_action
    target_action = bpy.data.actions.new(alias)
    target_armature.animation_data.action = target_action
    scale_ratio = rig_height(target_armature) / max(rig_height(source_armature), 1e-6)
    start = math.floor(source_action.frame_range[0])
    end = math.ceil(source_action.frame_range[1])

    scene = bpy.context.scene
    for frame in range(start, end + 1):
        scene.frame_set(frame)
        bpy.context.view_layer.update()
        phase = math.tau * (frame - start) / max(1, end - start)
        for name in bone_names:
            source_pose = source_armature.pose.bones.get(name)
            target_pose = target_armature.pose.bones.get(name)
            source_rest = source_armature.data.bones.get(name)
            target_rest = target_armature.data.bones.get(name)
            if not all((source_pose, target_pose, source_rest, target_rest)):
                continue
            source_basis = source_rest.matrix_local.to_quaternion()
            target_basis = target_rest.matrix_local.to_quaternion()
            source_delta = source_pose.matrix_basis.to_quaternion()
            target_delta = (
                target_basis.inverted()
                @ source_basis
                @ source_delta
                @ source_basis.inverted()
                @ target_basis
            )
            target_delta = add_arm_follow_through(
                target_delta,
                alias,
                name,
                phase,
            )
            target_pose.rotation_mode = "QUATERNION"
            target_pose.rotation_quaternion = target_delta.normalized()
            target_pose.location = (0.0, 0.0, 0.0)
            if name == "pelvis":
                if alias not in LOCOMOTION_ACTIONS:
                    source_motion = source_basis @ source_pose.location
                    target_pose.location = target_basis.inverted() @ (
                        source_motion * scale_ratio
                    )
                target_pose.keyframe_insert("location", frame=frame, group=name)
            target_pose.keyframe_insert("rotation_quaternion", frame=frame, group=name)

    target_armature.animation_data.action = None
    for track in target_armature.animation_data.nla_tracks:
        track.mute = False
    return target_action


def main() -> None:
    args = parse_args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    source = Path(args.input)
    import_scene(source)
    armatures = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
    if len(armatures) != 1:
        raise RuntimeError(f"期望一个骨架，实际为 {len(armatures)}")
    target_armature = armatures[0]
    mapping = semantic_mapping(target_armature)
    rename_rig(target_armature, mapping)
    if args.profile == "xhs_mobile":
        prune_unmapped_bones(target_armature, set(mapping.values()))
    neutralize_foot_rest(target_armature)

    library_root = Path(args.library)
    candidates = sorted(library_root.rglob("UAL1_Standard.glb"))
    if not candidates:
        raise RuntimeError(f"缺少 CC0 动作库: {library_root}")
    actions_before = set(bpy.data.actions)
    objects_before = set(bpy.data.objects)
    import_scene(candidates[0])
    imported_objects = set(bpy.data.objects) - objects_before
    source_actions = [action for action in bpy.data.actions if action not in actions_before]
    source_armatures = [obj for obj in imported_objects if obj.type == "ARMATURE"]
    if len(source_armatures) != 1:
        raise RuntimeError(f"动作库期望一个骨架，实际为 {len(source_armatures)}")
    source_armature = source_armatures[0]

    target_armature.animation_data_create()
    bone_names = {bone.name for bone in target_armature.data.bones}
    attached: list[str] = []
    for source_action, alias in compatible_actions(source_actions, bone_names):
        action = bake_action(
            source_armature,
            target_armature,
            source_action,
            alias,
            bone_names,
        )
        track = target_armature.animation_data.nla_tracks.new()
        track.name = alias
        strip = track.strips.new(alias, int(action.frame_range[0]), action)
        strip.name = alias
        strip.action_frame_start = action.frame_range[0]
        strip.action_frame_end = action.frame_range[1]
        attached.append(alias)
    if not {"idle_loop", "walk_loop", "run_loop", "interact"}.issubset(attached):
        raise RuntimeError(f"动作库缺少基础片段，当前为: {sorted(attached)}")

    for obj in imported_objects:
        bpy.data.objects.remove(obj, do_unlink=True)
    target_armature["forge3d_profile"] = args.profile
    target_armature["forge3d_actions"] = ",".join(sorted(attached))
    target_armature["forge3d_bone_mapping"] = ";".join(
        f"{old}:{new}" for old, new in sorted(mapping.items())
    )

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(output))


if __name__ == "__main__":
    main()
