from __future__ import annotations

import argparse
import os
import subprocess
import sys
import types
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--mesh", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--views", type=int, default=6, choices=range(6, 10))
    parser.add_argument("--resolution", type=int, default=512, choices=(512, 768))
    parser.add_argument(
        "--asset-kind",
        default="prop",
        choices=("character", "prop", "environment"),
    )
    parser.add_argument("--roughness-floor", type=float, default=0.32)
    parser.add_argument("--specular-level", type=float, default=0.35)
    parser.add_argument("--prompt", default="high quality")
    parser.add_argument("--preserve-mesh", action="store_true")
    parser.add_argument("--remesh", action="store_true")
    args = parser.parse_args()

    repo = Path(args.repo).resolve()
    paint_root = repo / "hy3dpaint"
    sys.path.insert(0, str(paint_root))
    sys.path.insert(0, str(paint_root / "custom_rasterizer"))
    os.chdir(repo)

    # Hunyuan3D 的推理环境使用 Python 3.10，而当前 PyPI 的 bpy 仅提供
    # Python 3.11 wheel。推理阶段不需要 bpy；最终 OBJ 转 GLB 交给独立
    # Blender 进程完成，因此这里只为上游模块的顶层导入提供占位模块。
    try:
        import bpy  # type: ignore  # noqa: F401
    except ModuleNotFoundError:
        sys.modules["bpy"] = types.ModuleType("bpy")

    # basicsr 1.4.2 仍使用 torchvision 0.17 之前的公开模块路径；
    # torchvision 0.20 保留了同一实现，但移动到了私有模块。
    try:
        import torchvision.transforms.functional_tensor  # type: ignore  # noqa: F401
    except ModuleNotFoundError:
        from torchvision.transforms import _functional_tensor

        sys.modules["torchvision.transforms.functional_tensor"] = _functional_tensor

    from textureGenPipeline import Hunyuan3DPaintConfig, Hunyuan3DPaintPipeline

    config = Hunyuan3DPaintConfig(max_num_view=args.views, resolution=args.resolution)
    config.realesrgan_ckpt_path = str(paint_root / "ckpt" / "RealESRGAN_x4plus.pth")
    config.multiview_cfg_path = str(paint_root / "cfgs" / "hunyuan-paint-pbr.yaml")
    config.custom_pipeline = str(paint_root / "hunyuanpaintpbr")

    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output_obj = output.with_suffix(".obj")
    painter = Hunyuan3DPaintPipeline(config)
    # 上游将 caption 写死为 high quality；在唯一的多视角推理入口传入个人 Skill 提示词。
    from material_prompt import apply_material_prompt
    apply_material_prompt(painter, args.prompt)
    mesh_path = str(Path(args.mesh).resolve())
    if args.preserve_mesh:
        # GLB 通常加载为 Scene；先转成单网格 OBJ，避免再次减面且兼容 UV 展开。
        import trimesh
        prepared = trimesh.load(mesh_path, force="mesh")
        mesh_path = str(output.with_suffix(".paint-input.obj"))
        prepared.export(mesh_path)
    painter(
        mesh_path=mesh_path,
        image_path=str(Path(args.image).resolve()),
        output_mesh_path=str(output_obj),
        save_glb=False,
        use_remesh=not args.preserve_mesh,
    )
    if not output_obj.is_file() or output_obj.stat().st_size == 0:
        raise RuntimeError(f"PBR OBJ 输出无效: {output_obj}")

    project_root = Path(os.environ.get("FORGE3D_PROJECT_ROOT", repo.parent.parent))
    blender = os.environ.get("FORGE3D_BLENDER", "/workspace/.tools/blender/blender")
    subprocess.run(
        [
            blender,
            "--background",
            "--python-exit-code",
            "1",
            "--python",
            str(project_root / "blender" / "convert_pbr_obj.py"),
            "--",
            "--input",
            str(output_obj),
            "--output",
            str(output),
            "--asset-kind",
            args.asset_kind,
            "--roughness-floor",
            str(args.roughness_floor),
            "--specular-level",
            str(args.specular_level),
        ],
        check=True,
    )
    if not output.is_file() or output.stat().st_size == 0:
        raise RuntimeError(f"PBR 输出无效: {output}")
    print(output)


if __name__ == "__main__":
    main()
