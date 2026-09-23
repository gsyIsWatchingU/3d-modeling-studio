from __future__ import annotations

from typing import Any


def collect_rig_quality_violations(report: dict[str, Any], profile: dict[str, Any]) -> list[str]:
    quality = report.get("quality", {})
    limits = profile.get("animation", {}).get("rig_quality", {})
    violations: list[str] = []
    if report.get("missing_required_bones"):
        violations.append("missing_humanoid_bones")
    checks = (
        ("max_mirror_x_error_ratio", "max_mirror_x_error_ratio", 0.02, "rig_mirror_asymmetry"),
        ("max_pair_depth_error_ratio", "max_pair_depth_error_ratio", 0.02, "rig_depth_asymmetry"),
        ("max_pair_height_error_ratio", "max_pair_height_error_ratio", 0.015, "rig_height_asymmetry"),
        ("max_bone_length_mismatch_ratio", "max_bone_length_mismatch_ratio", 0.10, "rig_length_asymmetry"),
        ("max_rest_foot_lateral_ratio", "max_rest_foot_lateral_ratio", 0.20, "rig_foot_lateral_twist"),
    )
    for metric, limit, fallback, code in checks:
        if metric not in quality:
            violations.append(f"{code}_metric_missing")
        elif quality[metric] > limits.get(limit, fallback):
            violations.append(code)
    return violations


def collect_deformation_violations(report: dict[str, Any], profile: dict[str, Any]) -> list[str]:
    quality = report.get("quality", {})
    limits = profile.get("animation", {}).get("deformation_quality", {})
    violations: list[str] = []
    checks = (
        ("max_depth_to_height", "max_depth_to_height", 0.50, "deformation_depth_explosion"),
        ("p99_edge_stretch_ratio", "max_p99_edge_stretch_ratio", 2.30, "deformation_edge_stretch"),
        ("max_edge_stretch_ratio", "max_edge_stretch_ratio", 20.0, "deformation_extreme_edge_stretch"),
        ("stretched_edge_ratio", "max_stretched_edge_ratio", 0.015, "deformation_stretched_area"),
    )
    for metric, limit, fallback, code in checks:
        if metric not in quality:
            violations.append(f"{code}_metric_missing")
        elif quality[metric] > limits.get(limit, fallback):
            violations.append(code)
    return violations


def collect_quality_violations(
    inspection: dict[str, Any],
    preview: dict[str, Any],
    profile: dict[str, Any],
    asset_kind: str,
) -> list[str]:
    """把 Blender 结构检查与审片图统计转换为稳定的门禁代码。"""

    geometry = profile.get("geometry", {})
    quality = profile.get("quality", {})
    uv_limits = quality.get("uv", {})
    material_limits = quality.get("material", {})
    render_limits = quality.get("render", {})
    uv = inspection.get("uv_metrics", {})
    material = inspection.get("material_metrics", {})
    render = preview.get("quality", {})
    violations: list[str] = []

    if inspection.get("triangles", 0) > geometry.get("triangle_budget", 10**9):
        violations.append("triangle_budget")
    if inspection.get("bones", 0) > geometry.get("max_bones", 10**9):
        violations.append("bone_budget")
    if inspection.get("max_weights_per_vertex", 0) > geometry.get(
        "max_weights_per_vertex", 10**9
    ):
        violations.append("skin_weight_budget")
    if inspection and inspection.get("materials", 0) == 0:
        violations.append("missing_material")
    if uv.get("textured_meshes_without_uv", 0):
        violations.append("missing_uv")
    if uv.get("non_finite_values", 0):
        violations.append("invalid_uv")
    if uv.get("out_of_range_ratio_max", 0.0) > uv_limits.get(
        "max_out_of_range_ratio", 0.02
    ):
        violations.append("uv_out_of_range")
    if uv.get("degenerate_triangle_ratio_max", 0.0) > uv_limits.get(
        "max_degenerate_triangle_ratio", 0.02
    ):
        violations.append("degenerate_uv")
    if material.get("missing_base_color_textures", 0):
        violations.append("missing_base_color_texture")
    if material.get("unassigned_material_faces", 0):
        violations.append("unassigned_material_faces")
    if material.get("roughness_collapsed_materials", 0):
        violations.append("roughness_collapse")
    roughness_p95 = material.get("roughness_p95_min")
    if roughness_p95 is not None and roughness_p95 < material_limits.get(
        "min_roughness_p95", 0.14
    ):
        violations.append("roughness_too_low")

    if preview and not render and preview.get("status") != "dry_run":
        violations.append("missing_render_metrics")
    if render:
        if render.get("luma_stddev", 1.0) < render_limits.get("min_luma_stddev", 0.04):
            violations.append("render_flat_or_blank")
        if render.get("clipped_channel_ratio", 0.0) > render_limits.get(
            "max_clipped_channel_ratio", 0.025
        ):
            violations.append("render_highlight_clipping")
        if render.get("neutral_white_ratio", 0.0) > render_limits.get(
            "max_neutral_white_ratio", 0.002
        ):
            violations.append("render_white_patch_risk")

    animation = profile.get("animation", {})
    if asset_kind == "character":
        if render.get("min_character_height_ratio", 1.0) < render_limits.get(
            "min_character_height_ratio", 0.72
        ):
            violations.append("character_height_collapse")
        if render.get("max_character_height_ratio", 1.0) > render_limits.get(
            "max_character_height_ratio", 1.28
        ):
            violations.append("character_height_stretch")
        required_clips = set(animation.get("required_clips", []))
        actual_clips = {name.lower() for name in inspection.get("animations", [])}
        missing_clips = {
            clip for clip in required_clips if not any(clip in actual for actual in actual_clips)
        }
        if missing_clips:
            violations.append("required_animations")
        pose = inspection.get("pose_quality", {})
        pose_limits = animation.get("pose_quality", {})
        if pose:
            if pose.get("min_hand_distance_ratio", 1.0) < pose_limits.get(
                "min_hand_distance_ratio", 0.10
            ):
                violations.append("hands_too_close")
            if pose.get("min_lateral_hand_separation_ratio", 1.0) < pose_limits.get(
                "min_lateral_hand_separation_ratio", 0.06
            ):
                violations.append("hands_cross_body")
            if pose.get("hand_crossing_ratio", 0.0) > pose_limits.get(
                "max_hand_crossing_ratio", 0.0
            ):
                violations.append("hands_crossed")
            if pose.get("max_elbow_bend_degrees", 0.0) > pose_limits.get(
                "max_elbow_bend_degrees", 55.0
            ):
                violations.append("elbow_overflexed")
            if pose.get("max_upperarm_rotation_degrees", 0.0) > pose_limits.get(
                "max_upperarm_rotation_degrees", 24.0
            ):
                violations.append("upperarm_overdriven")
            if pose.get("max_root_translation_ratio", 0.0) > pose_limits.get(
                "max_root_translation_ratio", 0.01
            ):
                violations.append("unexpected_root_motion")
            if pose.get("min_ankle_separation_ratio", 1.0) < pose_limits.get(
                "min_ankle_separation_ratio", 0.015
            ):
                violations.append("ankles_crossed_or_too_close")
            if pose.get("min_knee_separation_ratio", 1.0) < pose_limits.get(
                "min_knee_separation_ratio", 0.015
            ):
                violations.append("knees_crossed_or_too_close")
            if pose.get("leg_crossing_ratio", 0.0) > pose_limits.get(
                "max_leg_crossing_ratio", 0.0
            ):
                violations.append("legs_crossed")
            if pose.get("max_knee_bend_degrees", 0.0) > pose_limits.get(
                "max_knee_bend_degrees", 95.0
            ):
                violations.append("knee_overflexed")
            if pose.get("max_foot_lateral_ratio", 0.0) > pose_limits.get(
                "max_foot_lateral_ratio", 0.38
            ):
                violations.append("foot_lateral_twist")
            if pose.get("max_knee_lateral_deviation_ratio", 0.0) > pose_limits.get(
                "max_knee_lateral_deviation_ratio", 0.08
            ):
                violations.append("knee_lateral_twist")
    return list(dict.fromkeys(violations))
