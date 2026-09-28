from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from PIL import Image


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--seed", required=True, type=int)
    # 质量参数：CLI 优先，其次环境变量，最后回退到既有默认（不改变串行产线行为）。
    parser.add_argument("--num-inference-steps", type=int, default=None)
    parser.add_argument("--guidance-scale", type=float, default=None)
    parser.add_argument("--octree-resolution", type=int, default=None)
    args = parser.parse_args()

    steps = args.num_inference_steps if args.num_inference_steps is not None \
        else int(os.environ.get("FORGE3D_SHAPE_STEPS", "30"))
    guidance = args.guidance_scale if args.guidance_scale is not None \
        else float(os.environ.get("FORGE3D_SHAPE_GUIDANCE", "5.0"))
    octree = args.octree_resolution
    if octree is None:
        octree_env = os.environ.get("FORGE3D_SHAPE_OCTREE")
        octree = int(octree_env) if octree_env else None

    repo = Path(args.repo).resolve()
    sys.path.insert(0, str(repo))
    sys.path.insert(0, str(repo / "hy3dshape"))
    sys.path.insert(0, str(repo / "hy3dpaint"))

    from hy3dshape.rembg import BackgroundRemover
    from hy3dshape.pipelines import Hunyuan3DDiTFlowMatchingPipeline
    import torch

    pipeline = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(
        "tencent/Hunyuan3D-2.1", subfolder="hunyuan3d-dit-v2-1"
    )
    image = Image.open(args.input)
    if image.mode != "RGBA" or image.getextrema()[3] == (255, 255):
        image = BackgroundRemover()(image.convert("RGB"))
    else:
        image = image.convert("RGBA")
    generator = torch.Generator(device="cpu").manual_seed(args.seed)
    call_kwargs = {
        "image": image,
        "num_inference_steps": steps,
        "guidance_scale": guidance,
        "generator": generator,
    }
    if octree:
        call_kwargs["octree_resolution"] = octree
    print(f"[shape] steps={steps} guidance={guidance} octree={octree if octree else 'default'}", flush=True)
    mesh = pipeline(**call_kwargs)[0]
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    shape_output = output.with_suffix(".shape.glb")
    mesh.export(shape_output)

    if os.environ.get("FORGE3D_ENABLE_PBR", "1") == "1":
        import torch
        from textureGenPipeline import Hunyuan3DPaintConfig, Hunyuan3DPaintPipeline

        del pipeline
        torch.cuda.empty_cache()
        config = Hunyuan3DPaintConfig(max_num_view=6, resolution=512)
        config.realesrgan_ckpt_path = str(repo / "hy3dpaint" / "ckpt" / "RealESRGAN_x4plus.pth")
        config.multiview_cfg_path = str(repo / "hy3dpaint" / "cfgs" / "hunyuan-paint-pbr.yaml")
        config.custom_pipeline = str(repo / "hy3dpaint" / "hunyuanpaintpbr")
        painter = Hunyuan3DPaintPipeline(config)
        painter(mesh_path=str(shape_output), image_path=args.input, output_mesh_path=str(output))
    else:
        shape_output.replace(output)


if __name__ == "__main__":
    main()
