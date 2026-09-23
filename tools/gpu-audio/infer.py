"""在独立 Python 环境内加载 GPU 音频模型，生成母版与技术检查证据。"""
import argparse
import importlib.metadata
import json
from pathlib import Path
import sys

from audio_factory import BACKENDS, cached_model_ready, digest, validate, write_json


def main():
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--check', choices=BACKENDS)
    group.add_argument('--request')
    args = parser.parse_args()
    import torch
    import numpy as np
    import soundfile as sf
    from huggingface_hub import snapshot_download
    request = validate(json.loads(Path(args.request).read_text(encoding='utf-8'))) if args.request else None
    backend = args.check or request['backend']
    if backend == 'tts':
        from qwen_tts import Qwen3TTSModel
    else:
        from moss_soundeffect_v2 import MossSoundEffectPipeline
    try:
        model_path = snapshot_download(BACKENDS[backend]['model'], revision=BACKENDS[backend].get('revision'), local_files_only=True)
    except Exception:
        model_path = None
    if args.check:
        print(json.dumps({'dependencies_ready': True, 'cuda_available': torch.cuda.is_available(), 'weights_cached': cached_model_ready(model_path, backend), 'inference_verified': False}))
        return
    if not torch.cuda.is_available():
        raise RuntimeError('CUDA 不可用；禁止 CPU 回退')
    if not cached_model_ready(model_path, backend):
        raise RuntimeError('本地权重未准备完整；运行 prepare-model.py')
    torch.cuda.set_device(0)
    directory = Path(args.request).parent
    if backend == 'tts':
        model = Qwen3TTSModel.from_pretrained(model_path, device_map='cuda:0', dtype=torch.bfloat16, attn_implementation='sdpa')
        if str(model.device) != 'cuda:0':
            raise RuntimeError('TTS 模型未加载到 CUDA')
    else:
        model = MossSoundEffectPipeline.from_pretrained(model_path, torch_dtype=torch.bfloat16, device='cuda:0')
        model.eval()
        if str(model.device) != 'cuda:0':
            raise RuntimeError('音效模型未加载到 CUDA')
        # 核心生成组件每次前向均检查设备，禁止上游静默回退到 CPU。
        def require_cuda(module, inputs):
            if next(module.parameters()).device.type != 'cuda':
                raise RuntimeError('生成组件不在 CUDA')
        for component in (model.transformer, model.text_encoder, model.vae):
            component.eval()
            component.register_forward_pre_hook(require_cuda)
    outputs = []
    for i in range(request['variants']):
        seed = request['seed'] + i
        torch.manual_seed(seed)
        with torch.inference_mode():
            if backend == 'tts':
                wavs, sr = model.generate_custom_voice(text=request['text'], language='Chinese', speaker=request['speaker'], instruct=request['instruct'], max_new_tokens=2048)
                samples = np.asarray(wavs[0], dtype=np.float32)
            else:
                generated = model(prompt=request['prompt'], seconds=request['duration'], seed=seed, num_inference_steps=100, cfg_scale=4.0)
                if generated.device.type != 'cuda':
                    raise RuntimeError('生成结果未来自 CUDA')
                samples = generated[0].detach().float().cpu().numpy().T
                sr = model.sample_rate
        if not samples.size or not np.isfinite(samples).all():
            raise RuntimeError('产物为空或包含非有限值')
        peak = float(np.abs(samples).max())
        rms = float(np.sqrt(np.mean(samples.astype(np.float64)**2)))
        if rms < 1e-5:
            raise RuntimeError('产物近乎静音')
        # 仅衰减防削波，保留模型输出的响度证据；不冒充听感审核。
        attenuation = min(1., .95 / max(peak, 1e-12))
        target = directory / f'{request["event_id"]}-{i + 1:02d}.wav'
        sf.write(str(target), samples * attenuation, sr, subtype='PCM_16')
        outputs.append({'file': target.name, 'sha256': digest(target), 'seed': seed, 'sample_rate': sr,
                        'channels': 1 if samples.ndim == 1 else samples.shape[1], 'duration': len(samples) / sr,
                        'source_peak': peak, 'source_rms': rms, 'gain_applied': attenuation, 'listening': 'unverified', 'loop': 'unverified'})
    files = [p for p in Path(model_path).rglob('*') if p.is_file() and p.suffix in ('.safetensors', '.json', '.bin', '.pth', '.txt')]
    evidence = {'device': 'cuda:0', 'gpu_name': torch.cuda.get_device_name(0), 'torch_version': torch.__version__,
                'backend_version': importlib.metadata.version('qwen-tts' if backend == 'tts' else 'moss-soundeffect-v2'),
                'model_revision': Path(model_path).name, 'model_files_sha256': {str(p.relative_to(model_path)): digest(p) for p in files}, 'outputs': outputs}
    write_json(directory / 'inference.json', evidence)


if __name__ == '__main__':
    main()
