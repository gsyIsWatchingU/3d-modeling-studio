"""只下载官方模型到持久化目录，不执行生成、不读取或输出账号密钥。"""
import argparse
import os
os.environ['HF_HOME'] = '/workspace/models/game-audio/huggingface'
os.environ.pop('HF_HUB_OFFLINE', None)
from huggingface_hub import snapshot_download
from audio_factory import BACKENDS

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('backend', choices=BACKENDS)
args = parser.parse_args()
snapshot_download(BACKENDS[args.backend]['model'], revision=BACKENDS[args.backend].get('revision'), token=False)
print('权重已缓存；仍须 CUDA 试生成与人工试听。')
