"""ForgeLoop v2 —— 穿模门禁核心（Blender 无关，可纯 Python 单测）

语义：
- 通过骨骼影响划分语义区域（dominant bone → region label）。
- 相邻网格（骨架父子邻接）与明确允许接触（牵手/手搭髋/坐下/脚触地）忽略。
- 非允许区域连续两帧相交 → fail；单帧异常 → warn，并生成
  帧、动作、骨骼、碰撞区域证据。自动失败后仅切换一个已登记的
  权重修复或重定向方案（见 server/modeling-learning.js REGISTERED_*），
  生成新候选并复测，停在人工审片（本模块不产生修复动作）。

实现：
- tri_tri_intersect：Möller 三角形-三角形相交测试（stdlib only）。
- detect_frame_intersections：对一帧内所有区域对做相交检测。
- run_clipping_gate：跨帧聚合 → passed / warn / failed + 证据。
"""

from __future__ import annotations

from typing import Iterable, Sequence

EPS = 1e-6

# ---------- 语义区域 ----------
REGIONS = (
    "head", "neck", "torso", "left_arm", "right_arm",
    "left_hand", "right_hand", "left_leg", "right_leg",
    "left_foot", "right_foot", "hair", "cloth", "prop", "scene", "other",
)

# 骨骼名模式 → 区域（中文与英文都覆盖；左右通过名称前缀判断）
_BONE_REGION_RULES: tuple[tuple[str, str], ...] = (
    ("head", "head"), ("头", "head"),
    ("neck", "neck"), ("颈", "neck"),
    ("chest", "torso"), ("胸", "torso"), ("abdomen", "torso"), ("腰", "torso"),
    ("spine", "torso"), ("hip", "torso"), ("根", "torso"), ("pelvis", "torso"), ("盆", "torso"),
    ("hair", "hair"), ("发", "hair"),
    ("cloth", "cloth"), ("衣", "cloth"), ("裙", "cloth"), ("skirt", "cloth"),
    ("hand", "hand"), ("手", "hand"),
    ("arm", "arm"), ("臂", "arm"), ("shoulder", "arm"), ("肩", "arm"),
    ("leg", "leg"), ("腿", "leg"), ("thigh", "leg"), ("knee", "leg"), ("膝", "leg"),
    ("foot", "foot"), ("脚", "foot"), ("ankle", "foot"), ("踝", "foot"),
    ("prop", "prop"), ("道具", "prop"),
    ("scene", "scene"), ("环境", "scene"), ("env", "scene"), ("ground", "scene"), ("地", "scene"),
)

_LEFT_MARKERS = ("left", "l_", "_l", "左")
_RIGHT_MARKERS = ("right", "r_", "_r", "右")


def region_for_bone(bone_name: str) -> str:
    """骨骼名 → 语义区域。含左右标记的肢体归入对应侧。"""
    name = (bone_name or "").strip().lower()
    base = None
    for pattern, region in _BONE_REGION_RULES:
        if pattern in name:
            base = region
            break
    if base is None:
        return "other"
    if base in ("arm", "hand", "leg", "foot"):
        if any(m in name for m in _LEFT_MARKERS):
            return f"left_{base}"
        if any(m in name for m in _RIGHT_MARKERS):
            return f"right_{base}"
        return base  # 无左右标记的中线肢体
    return base


def classify_vertex_regions(vertex_bone_weights: Sequence[Sequence[tuple[str, float]]]) -> list[str]:
    """每个顶点 → 区域（dominant bone 权重最大者）。"""
    labels: list[str] = []
    for weights in vertex_bone_weights:
        if not weights:
            labels.append("other")
            continue
        dominant = max(weights, key=lambda item: item[1])[0]
        labels.append(region_for_bone(dominant))
    return labels


# 骨架父子邻接（相邻网格允许接触）
_ADJACENT = {
    ("head", "neck"), ("neck", "torso"),
    ("torso", "left_arm"), ("torso", "right_arm"),
    ("torso", "left_leg"), ("torso", "right_leg"),
    ("left_arm", "left_hand"), ("right_arm", "right_hand"),
    ("left_leg", "left_foot"), ("right_leg", "right_foot"),
    # 衣物贴身：与身体各区域视为相邻（允许贴合，不做失败）
    ("cloth", "head"), ("cloth", "neck"), ("cloth", "torso"),
    ("cloth", "left_arm"), ("cloth", "right_arm"),
    ("cloth", "left_hand"), ("cloth", "right_hand"),
    ("cloth", "left_leg"), ("cloth", "right_leg"),
    ("cloth", "left_foot"), ("cloth", "right_foot"),
}

# 明确允许接触（牵手/手搭髋/坐下/脚触地），由生产契约 allowed_contact_pairs 驱动
_DEFAULT_ALLOWED: set[tuple[str, str]] = {
    ("left_hand", "right_hand"),   # 牵手
    ("left_hand", "torso"),        # 手搭髋/身侧
    ("right_hand", "torso"),
    ("left_foot", "scene"),        # 脚/地面
    ("right_foot", "scene"),
    ("torso", "prop"),             # 坐下（长凳）
    ("left_hand", "prop"), ("right_hand", "prop"),  # 抓道具
}


def is_allowed_pair(a: str, b: str, allowed: set[tuple[str, str]] | None = None) -> bool:
    pair = (a, b) if a <= b else (b, a)
    if pair in _ADJACENT or pair in _DEFAULT_ALLOWED:
        return True
    return allowed is not None and pair in allowed


# ---------- 三角形相交（Möller，stdlib only） ----------
def sub(u, v):
    return (u[0] - v[0], u[1] - v[1], u[2] - v[2])


def cross(u, v):
    return (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])


def dot(u, v):
    return u[0] * v[0] + u[1] * v[1] + u[2] * v[2]


def _point_in_tri(p, a, b, c) -> bool:
    """严格内部判定：边界/顶点触碰不算相交（相邻网格允许接触）。"""
    def sign(x1, y1, x2, y2, x3, y3):
        return (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3)

    d1 = sign(p[0], p[1], a[0], a[1], b[0], b[1])
    d2 = sign(p[0], p[1], b[0], b[1], c[0], c[1])
    d3 = sign(p[0], p[1], c[0], c[1], a[0], a[1])
    if abs(d1) < EPS or abs(d2) < EPS or abs(d3) < EPS:
        return False
    has_neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    has_pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (has_neg and has_pos)


def tri_tri_intersect(t1: Sequence[Sequence[float]], t2: Sequence[Sequence[float]]) -> bool:
    """Möller 三角形-三角形相交测试（返回是否相交/触碰）。"""
    a, b, c = t1
    d, e, f = t2

    n1 = cross(sub(b, a), sub(c, a))
    d2 = dot(n1, sub(d, a))
    if abs(d2) < EPS:
        return _coplanar_case(a, b, c, d, e, f)
    d3 = dot(n1, sub(e, a))
    d4 = dot(n1, sub(f, a))
    if d2 * d3 >= -EPS and d2 * d4 >= -EPS and d2 * d3 <= EPS and d2 * d4 <= EPS:
        return _coplanar_case(a, b, c, d, e, f)
    if d2 * d3 >= 0 and d2 * d4 >= 0:
        return False
    # 三角形 2 与平面 1 相交，反查三角形 1 与平面 2
    n2 = cross(sub(e, d), sub(f, d))
    d1_ = dot(n2, sub(a, d))
    d2_ = dot(n2, sub(b, d))
    d3_ = dot(n2, sub(c, d))
    if d1_ * d2_ >= 0 and d1_ * d3_ >= 0:
        return False
    return _interval_intersects(d2, d3, d4, d1_, d2_, d3_)


def _coplanar_case(a, b, c, d, e, f) -> bool:
    # 共面：投影到丢失最大分量的平面做 2D 相交
    n = cross(sub(b, a), sub(c, a))
    axis = max(range(3), key=lambda i: abs(n[i]))
    u, v = [i for i in range(3) if i != axis]

    def p2(p):
        return (p[u], p[v])

    a2, b2, c2, d2, e2, f2 = p2(a), p2(b), p2(c), p2(d), p2(e), p2(f)
    for tri in (d2, e2, f2):
        if _point_in_tri(tri, a2, b2, c2):
            return True
    for tri in (a2, b2, c2):
        if _point_in_tri(tri, d2, e2, f2):
            return True
    return False


def _interval_intersects(d2, d3, d4, d1_, d2_, d3_) -> bool:
    # 两个三角形与各自平面交线在共享线段上是否有重叠区间
    def interval(v1, v2, v3):
        t = sorted((v1, v2, v3))
        if t[0] * t[1] > 0:
            return (t[0], t[2])
        return None

    iv1 = interval(d2, d3, d4)
    iv2 = interval(d1_, d2_, d3_)
    if iv1 is None or iv2 is None:
        return True
    return not (iv1[1] < iv2[0] - EPS or iv2[1] < iv1[0] - EPS)


# ---------- 帧内相交检测 ----------
def detect_frame_intersections(
    region_meshes: dict[str, Sequence[Sequence[Sequence[float]]]],
    allowed: set[tuple[str, str]] | None = None,
    max_tri_pairs: int = 400_000,
) -> list[dict]:
    """一帧内的区域相交检测。

    region_meshes: {region: [triangles]}，每三角形为三个三维点。
    返回 [{regions: (a,b), triangles: n, bones: [a,b]}]，按相交三角形对数降序。
    """
    hits: list[dict] = []
    keys = [k for k in region_meshes if region_meshes[k]]
    checked = 0
    for i, a in enumerate(keys):
        for b in keys[i + 1:]:
            if is_allowed_pair(a, b, allowed):
                continue
            tri_a, tri_b = region_meshes[a], region_meshes[b]
            if len(tri_a) * len(tri_b) > max_tri_pairs:
                continue  # 防御性上限：跳过超大网格对（由工位侧 BVH 细分）
            count = 0
            for ta in tri_a:
                for tb in tri_b:
                    if tri_tri_intersect(ta, tb):
                        count += 1
            checked += 1
            if count:
                hits.append({"regions": sorted((a, b)), "triangles": count, "bones": sorted((a, b))})
    hits.sort(key=lambda h: -h["triangles"])
    return hits


# ---------- 门禁判定（跨帧聚合） ----------
def run_clipping_gate(
    frames: Sequence[dict],
    action: str = "unknown",
    frames_sampled: int = 0,
    consecutive_fail_frames: int = 2,
) -> dict:
    """聚合抽帧结果。

    frames: [{frame_index, hits:[{regions, triangles, bones}]}]
    规则：同一非允许区域对连续 ≥2 帧相交 → fail；单帧 → warn。
    """
    by_pair: dict[tuple[str, str], list[int]] = {}
    frame_map: dict[int, dict] = {}
    for f in frames:
        frame_map[f["frame_index"]] = f
        for hit in f.get("hits", []):
            pair = tuple(hit["regions"])
            by_pair.setdefault(pair, []).append(f["frame_index"])

    fail_events, warn_events = [], []
    for pair, fr in by_pair.items():
        fr = sorted(set(fr))
        consecutive = []
        for i in range(len(fr) - 1):
            if fr[i + 1] - fr[i] <= 1:  # 相邻采样帧（抽帧步长内连续）
                consecutive.append((fr[i], fr[i + 1]))
        if consecutive:
            evidence = {
                "regions": sorted(pair),
                "frames": fr,
                "consecutive_pairs": consecutive,
                "bones": list(pair),
                "triangles": max((frame_map[x].get("triangles", 0) for x in fr), default=0),
            }
            if len(fr) >= consecutive_fail_frames:
                fail_events.append(evidence)
            else:
                warn_events.append(evidence)
        else:
            warn_events.append({
                "regions": sorted(pair),
                "frames": fr,
                "bones": list(pair),
                "triangles": frame_map[fr[0]].get("triangles", 0),
            })

    status = "failed" if fail_events else ("warn" if warn_events else "passed")
    return {
        "gate": "clipping_review",
        "status": status,
        "action": action,
        "frames_sampled": frames_sampled or len(frames),
        "fail_events": fail_events,
        "warn_events": warn_events,
        "stop_point": "pending_human_review",  # 自动化终点固定为待人工审片
        "note": "非允许区域连续两帧相交即失败；单帧异常进警告并附证据。自动失败后仅切换一个已登记的权重修复或重定向方案，复测后停在人工审片。",
    }
