"""在独立 Python 环境内加载 GPU 音频模型，生成母版与技术检查证据。"""
import argparse
import importlib.metadata
import json
from pathlib import Path
import sys

from audio_factory import BACKENDS, digest, validate, write_json


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
        from stable_audio_3 import StableAudioModel
        from flash_attn import flash_attn_func  # Medium 缺少此依赖可能输出噪声
    try:
        model_path = snapshot_download(BACKENDS[backend]['model'], local_files_only=True)
    except Exception:
        model_path = None
    if args.check:
        print(json.dumps({'dependencies_ready': True, 'cuda_available': torch.cuda.is_available(), 'weights_cached': model_path is not None, 'inference_verified': False}))
        return
    if not torch.cuda.is_available():
        raise RuntimeError('CUDA 不可用；禁止 CPU 回退')
    if not model_path:
        raise RuntimeError('本地权重未准备；运行 prepare-model.py，Stable Audio 3 须先获得模型访问权限')
    torch.cuda.set_device(0)
    directory = Path(args.request).parent
    if backend == 'tts':
        model = Qwen3TTSModel.from_pretrained(model_path, device_map='cuda:0', dtype=torch.bfloat16, attn_implementation='sdpa')
        if str(model.device) != 'cuda:0':
            raise RuntimeError('TTS 模型未加载到 CUDA')
    else:
        model = StableAudioModel.from_pretrained('medium', device='cuda:0')
    outputs = []
    for i in range(request['variants']):
        seed = request['seed'] + i
        torch.manual_seed(seed)
        with torch.inference_mode():
            if backend == 'tts':
                wavs, sr = model.generate_custom_voice(text=request['text'], language='Chinese', speaker=request['speaker'], instruct=request['instruct'], max_new_tokens=2048)
                samples = np.asarray(wavs[0], dtype=np.float32)
            else:
                generated = model.generate(prompt=request['prompt'], duration=request['duration'], seed=seed, steps=8, sample_size=model.model_config['sample_size'])
                samples = generated[0].detach().float().cpu().numpy().T
                sr = model.model.sample_rate
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
    files = [p for p in Path(model_path).rglob('*') if p.is_file() and p.suffix in ('.safetensors', '.json', '.bin')]
    evidence = {'device': 'cuda:0', 'gpu_name': torch.cuda.get_device_name(0), 'torch_version': torch.__version__,
                'backend_version': importlib.metadata.version('qwen-tts' if backend == 'tts' else 'stable-audio-3'),
                'model_revision': Path(model_path).name, 'model_files_sha256': {str(p.relative_to(model_path)): digest(p) for p in files}, 'outputs': outputs}
    write_json(directory / 'inference.json', evidence)


if __name__ == '__main__':
    main()
