import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import audio_factory as factory


class AudioFactoryTest(unittest.TestCase):
    def request(self):
        return {'project_id': 'test-game', 'event_id': 'step', 'backend': 'sfx', 'prompt': 'Single footstep on wood', 'duration': 2}

    def test_invalid_request_cannot_escape_project_or_switch_provider(self):
        for update in ({'project_id': '../escape'}, {'event_id': '/tmp/x'}, {'backend': 'elevenlabs'}, {'variants': 99}, {'duration': float('nan')}, {'duration': 31}, {'seed': True}, {'url': 'https://example.com'}):
            with self.subTest(update=update), self.assertRaises(ValueError):
                factory.validate(dict(self.request(), **update))

    def test_generation_environment_is_offline(self):
        with patch.dict('os.environ', {'HF_HUB_OFFLINE': '0'}):
            self.assertEqual(factory.backend_env()['HF_HUB_OFFLINE'], '1')

    def test_partial_model_download_is_not_ready(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / 'model_index.json').write_text('{}')
            self.assertFalse(factory.cached_model_ready(tmp, 'sfx'))
            for name in factory.SFX_FILES:
                target = Path(tmp) / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(b'fixture')
            self.assertTrue(factory.cached_model_ready(tmp, 'sfx'))

    def test_missing_runtime_never_invokes_alternative_generator(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(factory.BACKENDS, {'sfx': dict(factory.BACKENDS['sfx'], python=str(Path(tmp) / 'missing'))}), patch('subprocess.run') as run:
            with self.assertRaisesRegex(RuntimeError, '未安装'):
                factory.generate(self.request(), tmp, 0)
            run.assert_not_called()

    @unittest.skipUnless(sys.platform == 'linux', '服务器内核锁仅在 Linux 验证')
    def test_busy_gpu_rejects_without_starting_inference(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(factory.BACKENDS, {'sfx': dict(factory.BACKENDS['sfx'], python=sys.executable)}), patch('subprocess.check_output', return_value='44000, 80'), patch('subprocess.run') as run:
            with self.assertRaisesRegex(RuntimeError, '忙碌'):
                factory.generate(self.request(), tmp, 0)
            run.assert_not_called()

    @unittest.skipUnless(sys.platform == 'linux', '服务器内核锁仅在 Linux 验证')
    def test_valid_cache_reused_but_tampered_output_regenerated(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(factory.BACKENDS, {'sfx': dict(factory.BACKENDS['sfx'], python=sys.executable)}), patch('subprocess.check_output', return_value='44000, 0'):
            def infer(argv, **kwargs):
                directory = Path(argv[-1]).parent
                output = directory / 'step.wav'
                output.write_bytes(b'test fixture only, not generated audio')
                factory.write_json(directory / 'inference.json', {'device': 'cuda:0', 'outputs': [{'file': output.name, 'sha256': factory.digest(output)}]})
            with patch('subprocess.run', side_effect=infer) as run:
                a = factory.generate(self.request(), tmp, 0)
                self.assertEqual(a['review'], 'pending')
                self.assertEqual(a['status'], 'review')
                b = factory.generate(self.request(), tmp, 0)
                self.assertEqual(a['job_id'], b['job_id'])
                self.assertEqual(run.call_count, 1)
                (Path(a['manifest']).parent / 'step.wav').write_bytes(b'tampered')
                factory.generate(self.request(), tmp, 0)
                self.assertEqual(run.call_count, 2)
                other = factory.generate(dict(self.request(), project_id='another-game'), tmp, 0)
                self.assertNotEqual(a['job_id'], other['job_id'])


if __name__ == '__main__':
    unittest.main()
