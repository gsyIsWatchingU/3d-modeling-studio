from src.forge3d.quality import collect_quality_violations


PROFILE = {
    "animation": {
        "pose_quality": {
            "min_ankle_separation_ratio": 0.015,
            "min_knee_separation_ratio": 0.015,
            "max_leg_crossing_ratio": 0.0,
            "max_knee_bend_degrees": 95.0,
            "max_foot_lateral_ratio": 0.38,
            "max_knee_lateral_deviation_ratio": 0.08,
        }
    }
}


def violations(pose_quality):
    return collect_quality_violations(
        {"materials": 1, "pose_quality": pose_quality},
        {"status": "dry_run"},
        PROFILE,
        "character",
    )


def test_leg_quality_accepts_clean_walk_metrics():
    assert violations(
        {
            "min_ankle_separation_ratio": 0.09,
            "min_knee_separation_ratio": 0.09,
            "leg_crossing_ratio": 0.0,
            "max_knee_bend_degrees": 82.0,
            "max_foot_lateral_ratio": 0.05,
            "max_knee_lateral_deviation_ratio": 0.003,
        }
    ) == []


def test_leg_quality_rejects_twisted_or_crossed_legs():
    result = violations(
        {
            "min_ankle_separation_ratio": -0.01,
            "min_knee_separation_ratio": 0.0,
            "leg_crossing_ratio": 0.25,
            "max_knee_bend_degrees": 108.0,
            "max_foot_lateral_ratio": 0.46,
            "max_knee_lateral_deviation_ratio": 0.10,
        }
    )
    assert result == [
        "ankles_crossed_or_too_close",
        "knees_crossed_or_too_close",
        "legs_crossed",
        "knee_overflexed",
        "foot_lateral_twist",
        "knee_lateral_twist",
    ]
