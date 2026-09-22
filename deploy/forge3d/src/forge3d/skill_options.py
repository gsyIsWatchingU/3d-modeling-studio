"""工作室 Skill 只能覆盖白名单生成参数，不执行上传内容。"""
import copy
import json
from pydantic import BaseModel, ConfigDict, Field, StrictInt
from typing import Literal


class GenerationOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")
    triangle_budget: StrictInt = Field(ge=1000, le=120000)
    texture_size: Literal[512, 1024, 2048, 4096]
    paint_views: StrictInt = Field(ge=6, le=9)
    paint_resolution: Literal[512, 768]
    roughness_floor: float = Field(ge=0.15, le=0.8)
    specular_level: float = Field(ge=0.1, le=0.5)


def parse_skill_plan(raw: str) -> dict:
    if not raw:
        return {}
    if len(raw) > 16000:
        raise ValueError("Skill 执行计划过长")
    plan = json.loads(raw)
    if plan.get("version") != 1:
        raise ValueError("不支持的 Skill 计划版本")
    options = GenerationOptions.model_validate(plan.get("generation"))
    material_prompt = plan.get("material_prompt", "high quality")
    if not isinstance(material_prompt, str) or len(material_prompt) > 800:
        raise ValueError("材质提示词无效")
    digest = plan.get("sha256", "")
    if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
        raise ValueError("Skill 计划缺少有效摘要")
    return {"version": 1, "generation": options.model_dump(), "material_prompt": material_prompt, "sha256": digest,
            "skill_sha256": str(plan.get("skill_sha256", ""))[:64]}


def apply_skill_options(profile: dict, plan: dict, asset_kind: str) -> dict:
    result = copy.deepcopy(profile)
    if not plan:
        return result
    options = GenerationOptions.model_validate(plan["generation"]).model_dump()
    result["geometry"]["triangle_budget"] = options["triangle_budget"]
    result["textures"]["max_size"] = options["texture_size"]
    paint = result["textures"].setdefault("paint", {})
    paint[asset_kind] = {"views": options["paint_views"], "resolution": options["paint_resolution"],
                         "roughness_floor": options["roughness_floor"], "specular_level": options["specular_level"]}
    return result
