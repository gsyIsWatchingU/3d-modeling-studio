"""修正 UniRig 静置骨架的左右漂移与脚尖横向扭转。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import bpy


PAIRS = ("clavicle", "upperarm", "lowerarm", "hand", "thigh", "calf", "foot", "ball")
REPAIR_PAIRS = (*PAIRS, "index_01", "index_02", "index_03")


def parse_args() -> argparse.Namespace:
    args = sys.argv[sys.argv.index("--") + 1 :]
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--report", required=True)
    return parser.parse_args(args)


def chain(start: bpy.types.Bone) -> list[bpy.types.Bone]:
    result = [start]
    current = start
    while len(current.children) == 1:
        current = current.children[0]
        result.append(current)
    return result


def semantic_mapping(armature: bpy.types.Object) -> dict[str, str]:
    """按 UniRig 拓扑识别四肢；与 retarget.py 使用同一规则。"""

    roots = [bone for bone in armature.data.bones if bone.parent is None]
    if len(roots) != 1:
        raise RuntimeError("UniRig 骨架拓扑不符合单根人形结构")
    root = roots[0]
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
    if len(spine) < 2:
        raise RuntimeError("脊柱链过短")
    chest = spine[-1]
    upper_children = list(chest.children)
    neck_start = max(upper_children, key=lambda bone: bone.tail_local.z - bone.head_local.z)
    arm_starts = [bone for bone in upper_children if bone != neck_start]
    if len(arm_starts) != 2:
        raise RuntimeError("没有识别到双臂")

    center_x = root.head_local.x
    mapping: dict[str, str] = {}
    for start in arm_starts:
        side = "l" if start.tail_local.x > center_x else "r"
        names = [
            f"clavicle_{side}", f"upperarm_{side}", f"lowerarm_{side}",
            f"hand_{side}", f"index_01_{side}", f"index_02_{side}", f"index_03_{side}",
        ]
        for bone, name in zip(chain(start), names, strict=False):
            mapping[bone.name] = name
    for start in leg_starts:
        side = "l" if start.head_local.x > center_x else "r"
        names = [f"thigh_{side}", f"calf_{side}", f"foot_{side}", f"ball_{side}"]
        for bone, name in zip(chain(start), names, strict=False):
            mapping[bone.name] = name
    return mapping


def coords(bone: bpy.types.EditBone) -> dict[str, list[float]]:
    return {
        "head": [round(value, 6) for value in bone.head],
        "tail": [round(value, 6) for value in bone.tail],
    }


def translate_branch(bone: bpy.types.EditBone, delta) -> None:
    bone.head += delta
    bone.tail += delta
    for child in bone.children:
        translate_branch(child, delta)


def main() -> None:
    args = parse_args()
    source = Path(args.input).resolve()
    output = Path(args.output).resolve()
    report_path = Path(args.report).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    report_path.parent.mkdir(parents=True, exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=str(source))
    armatures = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
    if len(armatures) != 1:
        raise RuntimeError(f"期望一个骨架，实际为 {len(armatures)}")
    armature = armatures[0]
    raw_mapping = semantic_mapping(armature)
    semantic_names = {semantic: original for original, semantic in raw_mapping.items()}

    bpy.context.view_layer.objects.active = armature
    armature.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    edit_bones = armature.data.edit_bones
    before = {
        semantic: coords(edit_bones[original])
        for semantic, original in semantic_names.items()
        if semantic.rsplit("_", 1)[0] in REPAIR_PAIRS
    }

    for name in REPAIR_PAIRS:
        left_name = semantic_names.get(f"{name}_l")
        right_name = semantic_names.get(f"{name}_r")
        if left_name is None and right_name is None and name.startswith("index_"):
            continue
        if left_name is None or right_name is None:
            raise RuntimeError(f"缺少左右骨骼: {name}")
        left = edit_bones[left_name]
        right = edit_bones[right_name]
        for attr in ("head", "tail"):
            left_point = getattr(left, attr).copy()
            right_point = getattr(right, attr).copy()
            lateral = (abs(left_point.x) + abs(right_point.x)) * 0.5
            depth = (left_point.y + right_point.y) * 0.5
            height = (left_point.z + right_point.z) * 0.5
            getattr(left, attr)[:] = (lateral, depth, height)
            getattr(right, attr)[:] = (-lateral, depth, height)

    # UniRig 偶尔把脚骨斜向外侧。保留前后和高度，只把足部链的横向分量归零。
    for side, sign in (("l", 1.0), ("r", -1.0)):
        foot = edit_bones[semantic_names[f"foot_{side}"]]
        ball = edit_bones[semantic_names[f"ball_{side}"]]
        foot_x = abs(foot.head.x) * sign
        foot.head.x = foot_x
        foot.tail.x = foot_x
        ball.head = foot.tail
        ball.tail.x = foot_x

        # 手掌有两条未映射的手指分支。解除“连接”只保留父子关系，避免 FBX
        # 导出器把已对称的手掌尾点重新吸附到任一手指根部。
        hand = edit_bones[semantic_names[f"hand_{side}"]]
        for child in hand.children:
            child.use_connect = False
            translate_branch(child, hand.tail - child.head)

    after = {
        semantic: coords(edit_bones[original])
        for semantic, original in semantic_names.items()
        if semantic.rsplit("_", 1)[0] in REPAIR_PAIRS
    }
    bpy.ops.object.mode_set(mode="OBJECT")

    bpy.ops.object.select_all(action="SELECT")
    bpy.context.view_layer.objects.active = armature
    bpy.ops.export_scene.fbx(
        filepath=str(output),
        use_selection=False,
        add_leaf_bones=False,
        bake_anim=False,
    )
    report_path.write_text(
        json.dumps({"source": str(source), "output": str(output), "before": before, "after": after}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
