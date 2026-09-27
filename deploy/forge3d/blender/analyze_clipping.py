"""ForgeLoop v2 —— 穿模门禁 Blender 分析器（GPU/Blender 工位）

用法：
  blender --background --python analyze_clipping.py -- \
      --glb assets/characters/teen-boy.glb \
      --action "walk" \
      --scene-glb assets/environments/env-schoolyard.glb \
      --frame-stride 4 \
      --out clipping_report.json

对关键动画抽帧，通过骨骼影响把网格顶点划分到语义区域，
检测非允许区域对的三角形相交；连续两帧相交 → failed，单帧 → warn，
证据（帧、动作、骨骼、碰撞区域）写入 JSON 供 ForgeLoop 复盘与人工审片。

自动化终点固定为 pending_human_review；本脚本不做任何修复。
"""
import argparse
import json
import os
import sys

# Blender 后台运行时不继承调用方 PYTHONPATH；按脚本位置注入仓库 src/，
# 使 `import forge3d.clipping_core` 可解析（与 test_clipping.py 同一约定）。
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

try:
    import bpy  # noqa: F401  (Blender 环境)
    import mathutils
    _IN_BLENDER = True
except Exception:  # pragma: no cover
    _IN_BLENDER = False

if _IN_BLENDER:
    from forge3d.clipping_core import (
        classify_vertex_regions, detect_frame_intersections, run_clipping_gate,
    )
else:  # pragma: no cover
    print("需要 Blender 环境（bpy）运行本脚本；核心逻辑单测见 test_clipping.py", file=sys.stderr)
    sys.exit(2)


def region_meshes_at_frame(obj, action, frame, scene_obj=None, frame_shift=0):
    """在给定帧求网格世界坐标，并按顶点区域归类为三角形列表。"""
    scene = bpy.context.scene
    scene.frame_set(int(frame + frame_shift))
    mesh = obj.to_mesh()
    region_tris: dict[str, list] = {}
    try:
        tris = mesh.loop_triangles
        verts = [obj.matrix_world @ mathutils.Vector(v.co) for v in mesh.vertices]
        # 顶点 → 区域（dominant bone）
        weights = []
        for v in mesh.vertices:
            groups = []
            for g in v.groups:
                name = obj.vertex_groups[g.group].name
                groups.append((name, g.weight))
            weights.append(groups)
        labels = classify_vertex_regions(weights)
        for tri in tris:
            region = labels[tri.vertices[0]]
            pts = [[verts[i][0], verts[i][1], verts[i][2]] for i in tri.vertices]
            region_tris.setdefault(region, []).append(pts)
    finally:
        obj.to_mesh_clear()
    # 场景网格（道具/地面）划入 prop/scene 区域
    if scene_obj is not None:
        s_mesh = scene_obj.to_mesh()
        try:
            s_tris = s_mesh.loop_triangles
            s_verts = [scene_obj.matrix_world @ mathutils.Vector(v.co) for v in s_mesh.vertices]
            kind = "scene" if "ground" in scene_obj.name.lower() or "floor" in scene_obj.name.lower() else "prop"
            for tri in s_tris:
                pts = [[s_verts[i][0], s_verts[i][1], s_verts[i][2]] for i in tri.vertices]
                region_tris.setdefault(kind, []).append(pts)
        finally:
            scene_obj.to_mesh_clear()
    return region_tris


def main():
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
    else:
        argv = argv[1:]
    ap = argparse.ArgumentParser()
    ap.add_argument("--glb", required=True)
    ap.add_argument("--action", required=True)
    ap.add_argument("--scene-glb", default=None)
    ap.add_argument("--frame-stride", type=int, default=4)
    # 兼容 repair-executor 的 --report 与脚本自身文档的 --out
    ap.add_argument("--report", dest="out", default="clipping_report.json")
    ap.add_argument("--out", dest="out", default="clipping_report.json")
    args = ap.parse_args(argv)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=args.glb)
    obj = None
    for o in bpy.data.objects:
        if o.type == "MESH" and o.name != "Ground":
            obj = o
            break
    if obj is None:
        print(json.dumps({"gate": "clipping_review", "status": "failed", "action": args.action,
                          "fail_events": [{"regions": ["missing"], "frames": [], "bones": []}],
                          "note": "GLB 未包含网格"}))
        return 1
    scene_obj = None
    if args.scene_glb:
        bpy.ops.import_scene.gltf(filepath=args.scene_glb)
        scene_obj = next((o for o in bpy.data.objects if o.type == "MESH" and o != obj), None)

    action = bpy.data.actions.get(args.action)
    if action is None:
        print(json.dumps({"gate": "clipping_review", "status": "warn", "action": args.action,
                          "warn_events": [{"regions": ["missing-action"], "frames": [], "bones": []}],
                          "note": f"动作 {args.action} 不存在；跳过（warn 不阻断）"}))
        return 0
    frame_start, frame_end = int(action.frame_range[0]), int(action.frame_range[1])
    frames = []
    for frame in range(frame_start, frame_end + 1, args.frame_stride):
        region_tris = region_meshes_at_frame(obj, action, frame, scene_obj)
        hits = detect_frame_intersections(region_tris)
        frames.append({"frame_index": frame, "hits": hits, "triangles": sum(h["triangles"] for h in hits)})
    report = run_clipping_gate(frames, action=args.action, frames_sampled=len(frames))
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)
    # 完整报告打印到 stdout，供 repair-executor parseClippingReport 直接解析
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report["status"] != "failed" else 3


if __name__ == "__main__":
    sys.exit(main())
