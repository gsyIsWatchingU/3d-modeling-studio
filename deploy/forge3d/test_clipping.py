"""ForgeLoop v2 —— 穿模门禁核心单测（纯 Python，不依赖 Blender）

覆盖：
  1. 语义区域划分（骨骼名 → 区域；左右区分；无标记中线肢体）
  2. 三角形相交（穿透 / 共面 / 分离）
  3. 帧内区域相交检测 + 允许接触忽略（牵手/脚触地/相邻网格）
  4. 跨帧门禁判定：连续两帧 fail / 单帧 warn / 无 passed
  5. quality.py 门禁代码映射
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

from forge3d.clipping_core import (
    classify_vertex_regions, detect_frame_intersections,
    region_for_bone, run_clipping_gate, tri_tri_intersect,
)
from forge3d.quality import collect_clipping_violations


def box_triangles(cx, cy, cz, sx, sy, sz):
    """轴对齐立方体表面三角形（12 个），便于构造确定性相交场景。"""
    def quad(a, b, c, d):
        return [a, b, c], [a, c, d]
    x0, x1 = cx - sx / 2, cx + sx / 2
    y0, y1 = cy - sy / 2, cy + sy / 2
    z0, z1 = cz - sz / 2, cz + sz / 2
    tris = []
    p = lambda x, y, z: (x, y, z)
    # 六个面
    faces = [
        (p(x0, y0, z0), p(x1, y0, z0), p(x1, y1, z0), p(x0, y1, z0)),  # z0
        (p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1)),  # z1
        (p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1)),  # y0
        (p(x0, y1, z0), p(x1, y1, z0), p(x1, y1, z1), p(x0, y1, z1)),  # y1
        (p(x0, y0, z0), p(x0, y1, z0), p(x0, y1, z1), p(x0, y0, z1)),  # x0
        (p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), p(x1, y0, z1)),  # x1
    ]
    for f in faces:
        tris.extend(quad(*f))
    return tris


def test_region_for_bone():
    assert region_for_bone("Head") == "head"
    assert region_for_bone("mixamorig:LeftHand") == "left_hand"
    assert region_for_bone("RightFoot") == "right_foot"
    assert region_for_bone("Spine") == "torso"
    assert region_for_bone("Skirt") == "cloth"
    assert region_for_bone("unknown_bone_xyz") == "other"


def test_classify_vertex_regions():
    labels = classify_vertex_regions([
        [("LeftHand", 0.9), ("LeftArm", 0.1)],
        [("Spine", 0.8), ("LeftHand", 0.2)],
        [],
    ])
    assert labels == ["left_hand", "torso", "other"]


def test_tri_tri_intersect_penetrating():
    # 两个互相穿过的三角形（x 平面相交）
    t1 = [(0, 0, 0), (2, 0, 0), (0, 2, 0)]
    t2 = [(1, 0.5, -1), (1, 0.5, 1), (1, 1.5, 0)]
    assert tri_tri_intersect(t1, t2) is True


def test_tri_tri_intersect_separate():
    t1 = [(0, 0, 0), (2, 0, 0), (0, 2, 0)]
    t2 = [(5, 5, 0), (7, 5, 0), (5, 7, 0)]
    assert tri_tri_intersect(t1, t2) is False


def test_tri_tri_intersect_coplanar():
    # 共面共享边/角（两个三角形在 z=0 平面相邻）→ 边界触碰不算相交
    t1 = [(0, 0, 0), (2, 0, 0), (1, 1, 0)]
    t2 = [(2, 0, 0), (3, 0, 0), (2, 1, 0)]
    assert tri_tri_intersect(t1, t2) is False
    # 共面面积重叠：t3 的顶点 (1,0.6) 严格落在 t1 内部
    t3 = [(1, 0.6, 0), (3, 0.6, 0), (2, 2, 0)]
    assert tri_tri_intersect(t1, t3) is True


def test_detect_intersections_and_allowed_pairs():
    # 左臂盒与右臂盒互相穿透 → 检测到（非允许对）
    left_arm = box_triangles(0, 0, 0, 1, 1, 1)
    right_arm = box_triangles(0.5, 0.5, 0.5, 1, 1, 1)
    hits = detect_frame_intersections({"left_arm": left_arm, "right_arm": right_arm})
    assert len(hits) >= 1
    assert hits[0]["regions"] == ["left_arm", "right_arm"]

    # 牵手（left_hand + right_hand 相交）→ 明确允许，忽略
    hand_hits = detect_frame_intersections({
        "left_hand": box_triangles(0, 0, 0, 1, 1, 1),
        "right_hand": box_triangles(0.4, 0.4, 0.4, 1, 1, 1),
    })
    assert hand_hits == []

    # 脚触地（foot + scene 相交）→ 允许，忽略
    foot_hits = detect_frame_intersections({
        "right_foot": box_triangles(0, 0.2, 0, 0.4, 0.4, 0.4),
        "scene": box_triangles(0, -0.5, 0, 10, 1, 10),
    })
    assert foot_hits == []

    # 头 + 场景墙 → 非允许，检测到
    head_hits = detect_frame_intersections({
        "head": box_triangles(2, 2, 0, 1, 1, 1),
        "scene": box_triangles(2.5, 2, 0, 0.5, 10, 10),
    })
    assert len(head_hits) >= 1 and head_hits[0]["regions"] == ["head", "scene"]


def test_gate_consecutive_fail_single_warn_pass():
    # 连续两帧同一区域对相交 → failed
    hit = {"regions": ["head", "scene"], "triangles": 3, "bones": ["head", "scene"]}
    frames = [
        {"frame_index": 1, "hits": [hit]},
        {"frame_index": 2, "hits": [hit]},
        {"frame_index": 3, "hits": []},
    ]
    r = run_clipping_gate(frames, action="walk")
    assert r["status"] == "failed" and len(r["fail_events"]) == 1
    assert r["stop_point"] == "pending_human_review"

    # 单帧异常 → warn
    frames_w = [{"frame_index": 5, "hits": [hit]}, {"frame_index": 6, "hits": []}]
    rw = run_clipping_gate(frames_w, action="walk")
    assert rw["status"] == "warn" and len(rw["fail_events"]) == 0 and len(rw["warn_events"]) == 1

    # 无相交 → passed
    rp = run_clipping_gate([{"frame_index": 1, "hits": []}], action="idle")
    assert rp["status"] == "passed"


def test_quality_violations_mapping():
    report = {
        "gate": "clipping_review", "status": "failed",
        "fail_events": [{"regions": ["head", "scene"], "frames": [10, 11], "bones": []}],
        "warn_events": [], "action": "walk",
    }
    violations = collect_clipping_violations(report, {})
    assert "clipping_penetration" in violations
    assert any(v.startswith("clipping_head-scene@") for v in violations)

    assert collect_clipping_violations({"gate": "clipping_review", "status": "warn"}, {}) == ["clipping_single_frame"]
    assert collect_clipping_violations({"gate": "clipping_review", "status": "passed"}, {}) == []
    assert "clipping_review_missing" in collect_clipping_violations({}, {})


if __name__ == "__main__":
    for name in sorted(globals()):
        if name.startswith("test_"):
            globals()[name]()
            print("ok", name)
    print("ALL CLIPPING TESTS PASS")
