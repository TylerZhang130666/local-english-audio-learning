"""Explicit model download, only needed once during setup."""
from faster_whisper import WhisperModel
try:
    model = WhisperModel('small.en', device='cpu', compute_type='int8', local_files_only=True)
except Exception:
    print('Downloading small.en model. No recordings are uploaded.', flush=True)
    model = WhisperModel('small.en', device='cpu', compute_type='int8')
print('Local English model ready.', flush=True)
