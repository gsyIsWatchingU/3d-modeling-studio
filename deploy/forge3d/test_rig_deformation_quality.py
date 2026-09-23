from src.forge3d.quality import (
    collect_deformation_violations,
    collect_rig_quality_violations,
)


PROFILE = {
    "animation": {
        "rig_quality": {
            "max_mirror_x_error_ratio": 0.02,
            "max_pair_depth_error_ratio": 0.02,
            "max_pair_height_error_ratio": 0.015,
            "max_bone_length_mismatch_ratio": 0.10,
            "max_rest_foot_lateral_ratio": 0.20,
        },
        "deformation_quality": {
            "max_depth_to_height": 0.50,
            "max_p99_edge_stretch_ratio": 2.30,
            "max_edge_stretch_ratio": 20.0,
            "max_stretched_edge_ratio": 0.015,
        },
    }
}


def test_normal_character_passes_new_gates():
    rig = {"missing_required_bones": [], "quality": {
        "max_mirror_x_error_ratio": 0.00225,
        "max_pair_depth_error_ratio": 0.00439,
        "max_pair_height_error_ratio": 0.00193,
        "max_bone_length_mismatch_ratio": 0.04339,
        "max_rest_foot_lateral_ratio": 0.05044,
    }}
    deformation = {"quality": {
        "max_depth_to_height": 0.43136,
        "p99_edge_stretch_ratio": 2.08848,
        "max_edge_stretch_ratio": 12.81094,
        "stretched_edge_ratio": 0.011058,
    }}
    assert collect_rig_quality_violations(rig, PROFILE) == []
    assert collect_deformation_violations(deformation, PROFILE) == []


def test_rejected_v3_is_stopped_by_rig_and_deformation_gates():
    rig = {"missing_required_bones": [], "quality": {
        "max_mirror_x_error_ratio": 0.06220,
        "max_pair_depth_error_ratio": 0.20165,
        "max_pair_height_error_ratio": 0.01235,
        "max_bone_length_mismatch_ratio": 0.05663,
        "max_rest_foot_lateral_ratio": 0.28884,
    }}
    deformation = {"quality": {
        "max_depth_to_height": 0.73624,
        "p99_edge_stretch_ratio": 2.53446,
        "max_edge_stretch_ratio": 37.90487,
        "stretched_edge_ratio": 0.017345,
    }}
    assert collect_rig_quality_violations(rig, PROFILE) == [
        "rig_mirror_asymmetry", "rig_depth_asymmetry", "rig_foot_lateral_twist"
    ]
    assert collect_deformation_violations(deformation, PROFILE) == [
        "deformation_depth_explosion", "deformation_edge_stretch",
        "deformation_extreme_edge_stretch", "deformation_stretched_area",
    ]


def test_missing_metrics_fail_closed():
    assert collect_rig_quality_violations({"quality": {}}, PROFILE) == [
        "rig_mirror_asymmetry_metric_missing",
        "rig_depth_asymmetry_metric_missing",
        "rig_height_asymmetry_metric_missing",
        "rig_length_asymmetry_metric_missing",
        "rig_foot_lateral_twist_metric_missing",
    ]
    assert collect_deformation_violations({"quality": {}}, PROFILE) == [
        "deformation_depth_explosion_metric_missing",
        "deformation_edge_stretch_metric_missing",
        "deformation_extreme_edge_stretch_metric_missing",
        "deformation_stretched_area_metric_missing",
    ]
