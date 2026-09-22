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
    args = parser.parse_args()
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
    mesh = pipeline(image=image, num_inference_steps=30, guidance_scale=5.0, generator=generator)[0]
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
