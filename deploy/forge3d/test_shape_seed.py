import runpy
import sys
import types
from pathlib import Path


def test_requested_seed_reaches_generator(monkeypatch, tmp_path):
    calls = []
    class Generator:
        def __init__(self, device):
            self.device = device
        def manual_seed(self, seed):
            self.seed = seed
            return self
    class Mesh:
        def export(self, target):
            Path(target).write_bytes(b"mesh")
    class Pipeline:
        @classmethod
        def from_pretrained(cls, *args, **kwargs):
            return cls()
        def __call__(self, **kwargs):
            calls.append(kwargs)
            return [Mesh()]
    image = types.SimpleNamespace(mode="RGBA", getextrema=lambda: [(0, 255)] * 4)
    image.convert = lambda mode: image
    monkeypatch.setitem(sys.modules, "torch", types.SimpleNamespace(Generator=Generator))
    monkeypatch.setitem(sys.modules, "PIL", types.SimpleNamespace(Image=types.SimpleNamespace(open=lambda filename: image)))
    monkeypatch.setitem(sys.modules, "hy3dshape", types.ModuleType("hy3dshape"))
    monkeypatch.setitem(sys.modules, "hy3dshape.rembg", types.SimpleNamespace(BackgroundRemover=lambda: None))
    monkeypatch.setitem(sys.modules, "hy3dshape.pipelines", types.SimpleNamespace(Hunyuan3DDiTFlowMatchingPipeline=Pipeline))
    monkeypatch.setenv("FORGE3D_ENABLE_PBR", "0")
    output = tmp_path / "model.glb"
    monkeypatch.setattr(sys, "argv", ["hunyuan_generate.py", "--repo", str(tmp_path), "--input", "input.png", "--output", str(output), "--seed", "0"])
    runpy.run_path(str(Path(__file__).parent / "scripts" / "hunyuan_generate.py"), run_name="__main__")
    assert calls[0]["generator"].seed == 0
    assert calls[0]["generator"].device == "cpu"
    assert "seed" not in calls[0]
    assert output.read_bytes() == b"mesh"


def test_material_skill_replaces_upstream_fixed_caption():
    module = runpy.run_path(str(Path(__file__).parent / "scripts" / "material_prompt.py"))
    calls = []
    painter = types.SimpleNamespace(models={"multiview_model": lambda *args, **kwargs: calls.append((args, kwargs))})
    module["apply_material_prompt"](painter, "matte stone and aged brass")
    painter.models["multiview_model"]("reference", prompt="high quality", resize_input=True)
    assert calls[0][1]["prompt"] == "matte stone and aged brass"
    assert calls[0][1]["resize_input"] is True
    assert calls[0][0] == ("reference",)
