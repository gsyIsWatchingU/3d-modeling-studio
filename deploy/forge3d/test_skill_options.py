import json
import pytest
from forge3d.skill_options import parse_skill_plan, apply_skill_options


def plan():
    return {"version": 1, "sha256": "a" * 64, "generation": {
        "triangle_budget": 60000, "texture_size": 2048, "paint_views": 9,
        "paint_resolution": 768, "roughness_floor": 0.55, "specular_level": 0.2}}


def test_skill_options_are_applied_without_changing_shared_profile():
    profile = {"geometry": {"triangle_budget": 30000}, "textures": {"max_size": 1024, "paint": {"prop": {"views": 8}}}}
    result = apply_skill_options(profile, parse_skill_plan(json.dumps(plan())), "prop")
    assert result["geometry"]["triangle_budget"] == 60000
    assert result["textures"]["max_size"] == 2048
    assert result["textures"]["paint"]["prop"]["roughness_floor"] == 0.55
    assert profile["geometry"]["triangle_budget"] == 30000
    assert profile["textures"]["paint"]["prop"]["views"] == 8


def test_unknown_or_unbounded_parameters_are_rejected():
    value = plan()
    value["generation"]["command"] = "echo unsafe"
    with pytest.raises(ValueError):
        parse_skill_plan(json.dumps(value))
    value = plan()
    value["generation"]["triangle_budget"] = 10000000
    with pytest.raises(ValueError):
        parse_skill_plan(json.dumps(value))
    assert parse_skill_plan("") == {}
