"""自有 GPU 音频工位。仅调用本机 CUDA 模型，无云端生成回退。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
BACKENDS = {
    'tts': {'python': '/workspace/.envs/game-audio-tts/bin/python', 'module': 'qwen_tts',
            'model': 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice', 'license': 'Apache-2.0'},
    'sfx': {'python': '/workspace/.envs/game-audio-moss/bin/python', 'module': 'moss_soundeffect_v2',
            'model': 'OpenMOSS-Team/MOSS-SoundEffect-v2.0', 'license': 'Apache-2.0',
            'revision': 'e35df4d82fbe87fcd5d14e5d100e349c0c3c076d', 'min_free_mib': 20480},
}
SFX_FILES = ['model_index.json', 'scheduler/scheduler_config.json', 'transformer/config.json',
             'transformer/diffusion_pytorch_model.safetensors', 'text_encoder/config.json',
             'text_encoder/model.safetensors.index.json', 'text_encoder/model-00001-of-00002.safetensors',
             'text_encoder/model-00002-of-00002.safetensors', 'tokenizer/tokenizer.json',
             'tokenizer/tokenizer_config.json', 'vae/vae_128d_48k.pth']


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def write_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(path)


def validate(value):
    if not isinstance(value, dict):
        raise ValueError('请求须为 JSON 对象')
    allowed = {'project_id', 'event_id', 'backend', 'prompt', 'text', 'speaker', 'instruct', 'duration', 'seed', 'variants', 'loop'}
    if set(value) - allowed:
        raise ValueError('请求含未知字段')
    for key in ('project_id', 'event_id'):
        if not isinstance(value.get(key), str) or not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,79}', value[key]):
            raise ValueError(key + ' 仅允许小写字母、数字、下划线与连字符')
    if value.get('backend') not in BACKENDS:
        raise ValueError('backend 仅允许 tts / sfx')
    value = dict(value)
    value.setdefault('seed', 92301)
    value.setdefault('variants', 1)
    value.setdefault('loop', False)
    if type(value['seed']) is not int or not 0 <= value['seed'] < 2**31:
        raise ValueError('seed 必须为非负 31 位整数')
    if type(value['variants']) is not int or not 1 <= value['variants'] <= 8:
        raise ValueError('variants 必须在 1～8 之间')
    if type(value['loop']) is not bool:
        raise ValueError('loop 须为布尔值；仅表示待验收需求，不保证无缝')
    key = 'text' if value['backend'] == 'tts' else 'prompt'
    if not isinstance(value.get(key), str) or not 1 <= len(value[key].strip()) <= 2000:
        raise ValueError(key + ' 须为 1～2000 字符')
    if value['backend'] == 'sfx':
        if type(value.get('duration')) not in (int, float) or not .5 <= value['duration'] <= 30:
            raise ValueError('音效 duration 须为 0.5～30 秒')
    else:
        value.setdefault('speaker', 'Dylan')
        if value['speaker'] not in ('Vivian', 'Serena', 'Uncle_Fu', 'Dylan', 'Eric', 'Ryan', 'Aiden', 'Ono_Anna', 'Sohee'):
            raise ValueError('不支持的 Qwen 音色')
        value.setdefault('instruct', '自然、克制地说话，避免播音腔。')
        if not isinstance(value['instruct'], str) or len(value['instruct']) > 500:
            raise ValueError('instruct 须为最多 500 字符')
    return value


def backend_env():
    env = dict(os.environ)
    env['HF_HOME'] = '/workspace/models/game-audio/huggingface'
    env['HF_HUB_DISABLE_PROGRESS_BARS'] = '1'
    # 权重预下载是独立步骤；生成期间禁止依赖远程下载或 API。
    env['HF_HUB_OFFLINE'] = '1'
    env['TRANSFORMERS_OFFLINE'] = '1'
    env['TORCHDYNAMO_DISABLE'] = '1'
    return env


def cached_model_ready(snapshot, backend):
    if not snapshot:
        return False
    required = SFX_FILES if backend == 'sfx' else ['model.safetensors', 'config.json', 'speech_tokenizer/model.safetensors', 'speech_tokenizer/config.json']
    return all((Path(snapshot) / name).is_file() and (Path(snapshot) / name).stat().st_size > 0 for name in required)


def doctor():
    result = {'host': socket.gethostname(), 'generation': 'self-hosted-cuda-only', 'backends': {}}
    for name, cfg in BACKENDS.items():
        entry = {'model': cfg['model'], 'license': cfg['license'], 'runtime_installed': Path(cfg['python']).is_file(), 'inference_verified': False}
        if entry['runtime_installed']:
            p = subprocess.run([cfg['python'], str(Path(__file__).with_name('infer.py')), '--check', name], env=backend_env(), capture_output=True, text=True, timeout=90)
            if p.returncode == 0:
                entry.update(json.loads(p.stdout.strip().splitlines()[-1]))
            else:
                entry['error'] = '依赖或 CUDA 检查失败；在服务器运行 infer.py --check 查看详情'
        result['backends'][name] = entry
    return result


def generate(request, output_root, gpu):
    request = validate(request)
    cfg = BACKENDS[request['backend']]
    if not Path(cfg['python']).is_file():
        raise RuntimeError('模型环境未安装，请运行对应 install-runtime.sh；不会回退到 CPU 或商业 API')
    # 把规范、代码和来源纳入任务身份，更新流水线后不会复用旧结果。
    snapshot = {str(p.relative_to(ROOT)): digest(p) for p in [Path(__file__), Path(__file__).with_name('infer.py'), ROOT / 'production-skills/audio/SKILL.md', ROOT / 'production-skills/sources.lock.json']}
    identity = json.dumps({'request': request, 'pipeline': snapshot}, sort_keys=True, ensure_ascii=False).encode()
    job_id = hashlib.sha256(identity).hexdigest()[:24]
    directory = Path(output_root).resolve() / request['project_id'] / request['event_id'] / job_id
    directory.mkdir(parents=True, exist_ok=True)
    manifest_path = directory / 'manifest.json'
    # 同机器音频生产串行；内核锁在退出或崩溃后自动释放。
    import fcntl
    with (Path(output_root).resolve() / '.audio-gpu.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('音频工位正在生产，请稍后复用同一请求重试')
        if manifest_path.exists():
            old = json.loads(manifest_path.read_text(encoding='utf-8'))
            if old.get('status') == 'review' and old.get('outputs') and all((directory / f['file']).is_file() and digest(directory / f['file']) == f['sha256'] for f in old['outputs']):
                return old
        env = backend_env()
        env['CUDA_VISIBLE_DEVICES'] = str(gpu)
        raw = subprocess.check_output(['nvidia-smi', '-i', str(gpu), '--query-gpu=memory.free,utilization.gpu', '--format=csv,noheader,nounits'], text=True)
        free, usage = map(int, raw.strip().split(','))
        required_free = cfg.get('min_free_mib', 12288)
        if free < required_free or usage > 20:
            raise RuntimeError(f'GPU 空闲显存不足 {required_free // 1024} GiB 或正在忙碌；请等待，不停止其他服务')
        manifest = {'job_id': job_id, 'status': 'running', 'review': 'pending', 'request': request,
                    'host': socket.gethostname(), 'gpu_index': gpu, 'model': cfg['model'], 'license': cfg['license'],
                    'pipeline_sha256': snapshot, 'started_at': time.time(), 'outputs': []}
        write_json(directory / 'request.json', request)
        write_json(manifest_path, manifest)
        try:
            with (directory / 'generation.log').open('w', encoding='utf-8') as log:
                subprocess.run([cfg['python'], str(Path(__file__).with_name('infer.py')), '--request', str(directory / 'request.json')], env=env, stdout=log, stderr=log, check=True, timeout=1800)
            evidence = json.loads((directory / 'inference.json').read_text(encoding='utf-8'))
            if evidence['device'] != 'cuda:0' or not evidence['outputs']:
                raise RuntimeError('缺少 CUDA 生成证据或产物')
            manifest.update(evidence)
            manifest.update(status='review', review='pending', finished_at=time.time(), manifest=str(manifest_path))
        except Exception:
            manifest.update(status='failed', finished_at=time.time(), error='生成失败，详见任务 generation.log；不会替换生成来源')
            write_json(manifest_path, manifest)
            raise
        write_json(manifest_path, manifest)
        return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('doctor')
    gen = sub.add_parser('generate')
    gen.add_argument('--request', required=True)
    gen.add_argument('--output-root', default='/workspace/3d-assets/game-audio')
    gen.add_argument('--gpu', type=int, default=0, choices=range(8))
    args = parser.parse_args()
    try:
        result = doctor() if args.command == 'doctor' else generate(json.loads(Path(args.request).read_text(encoding='utf-8-sig')), args.output_root, args.gpu)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({'status': 'failed', 'error': str(e)}, ensure_ascii=False), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
