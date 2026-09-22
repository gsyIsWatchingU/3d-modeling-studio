"""把后端解析后的材质文本接入上游多视角扩散入口。"""


def apply_material_prompt(painter, prompt):
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 800:
        raise ValueError("材质提示词无效")
    original = painter.models["multiview_model"]

    def prompted(*args, **kwargs):
        kwargs["prompt"] = prompt
        return original(*args, **kwargs)

    painter.models["multiview_model"] = prompted
