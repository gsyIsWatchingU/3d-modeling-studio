"""使用官方 Hunyuan3D-2mv 从 1-4 张一致视图生成形体网格。"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

from PIL import Image


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--front", required=True)
    parser.add_argument("--left")
    parser.add_argument("--back")
    parser.add_argument("--right")
    parser.add_argument("--output", required=True)
    parser.add_argument("--seed", required=True, type=int)
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--subfolder", default="hunyuan3d-dit-v2-mv")
    parser.add_argument("--steps", type=int, default=30)
    parser.add_argument("--guidance-scale", type=float, default=5.0)
    args = parser.parse_args()

    repo = Path(args.repo).resolve()
    sys.path.insert(0, str(repo))
    sys.path.insert(0, str(repo / "hy3dshape"))
    # Hunyuan3D-2mv 的官方配置仍引用旧包名 hy3dgen.shapegen；2.1 仓库把
    # 同一实现迁到了 hy3dshape。只在本进程建立兼容映射，不修改官方权重或共享仓库。
    compatibility = tempfile.TemporaryDirectory(prefix="forge3d-hy3dgen-compat-")
    compatibility_root = Path(compatibility.name)
    package_root = compatibility_root / "hy3dgen"
    package_root.mkdir()
    (package_root / "__init__.py").write_text("", encoding="utf-8")
    os.symlink(repo / "hy3dshape" / "hy3dshape", package_root / "shapegen", target_is_directory=True)
    sys.path.insert(0, str(compatibility_root))
    from hy3dshape.rembg import BackgroundRemover
    from hy3dshape.pipelines import Hunyuan3DDiTFlowMatchingPipeline

    remover = BackgroundRemover()
    images = {}
    for view in ("front", "left", "back", "right"):
        path = getattr(args, view)
        if not path:
            continue
        image = Image.open(path)
        if image.mode != "RGBA" or image.getextrema()[3] == (255, 255):
            image = remover(image.convert("RGB"))
        else:
            image = image.convert("RGBA")
        images[view] = image
    if not images:
        raise RuntimeError("至少需要一个视图")

    pipeline = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(
        args.model_path,
        subfolder=args.subfolder,
        use_safetensors=True,
        device="cuda",
    )
    mesh = pipeline(
        image=images,
        num_inference_steps=args.steps,
        guidance_scale=args.guidance_scale,
        seed=args.seed,
    )[0]
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    mesh.export(output)
    print(json.dumps({
        "output": str(output),
        "views": sorted(images),
        "seed": args.seed,
        "steps": args.steps,
        "guidance_scale": args.guidance_scale,
        "model_path": args.model_path,
        "subfolder": args.subfolder,
    }, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
