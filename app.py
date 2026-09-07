"""Local English listening notebook. No remote services or telemetry."""
import hashlib
import json
import math
import mimetypes
import os
from pathlib import Path
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote
import webbrowser
import argparse

ROOT = Path(__file__).resolve().parent
AUDIO = ROOT / 'audio'
DATA = ROOT / 'data'
for folder in (AUDIO, DATA):
    folder.mkdir(exist_ok=True)
LOCK = threading.RLock()
JOBS = {}
MODEL = None
PRONUNCIATIONS = None
EXTENSIONS = {'.m4a', '.mp3', '.wav', '.flac', '.ogg', '.mp4', '.aac'}
CMUDICT = ROOT / 'resources' / 'cmudict.dict'

IPA_PHONES = {
    'AA': 'ɑ', 'AE': 'æ', 'AH': 'ʌ', 'AO': 'ɔ', 'AW': 'aʊ', 'AY': 'aɪ',
    'EH': 'ɛ', 'ER': 'ɝ', 'EY': 'eɪ', 'IH': 'ɪ', 'IY': 'iː', 'OW': 'oʊ',
    'OY': 'ɔɪ', 'UH': 'ʊ', 'UW': 'uː', 'B': 'b', 'CH': 'tʃ', 'D': 'd',
    'DH': 'ð', 'F': 'f', 'G': 'ɡ', 'HH': 'h', 'JH': 'dʒ', 'K': 'k',
    'L': 'l', 'M': 'm', 'N': 'n', 'NG': 'ŋ', 'P': 'p', 'R': 'r', 'S': 's',
    'SH': 'ʃ', 'T': 't', 'TH': 'θ', 'V': 'v', 'W': 'w', 'Y': 'j', 'Z': 'z', 'ZH': 'ʒ'
}
VOWELS = {'AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY', 'IH', 'IY', 'OW', 'OY', 'UH', 'UW'}
VALID_ONSETS = {tuple(x.split()) for x in '''B,CH,D,DH,F,G,HH,JH,K,L,M,N,P,R,S,SH,T,TH,V,W,Y,Z,ZH,
B L,B R,D R,F L,F R,G L,G R,K L,K R,P L,P R,T R,V R,TH R,SH R,S L,S M,S N,S P,S T,S K,S W,
CH R,JH R,K W,G W,F Y,V Y,K Y,P Y,T Y,B Y,D Y,G Y,HH Y,M Y,N Y,R Y,S Y,Z Y,TH Y'''.replace('\n', '').split(',') if x.strip()}

def load_pronunciations():
    global PRONUNCIATIONS
    if PRONUNCIATIONS is not None:
        return PRONUNCIATIONS
    dictionary = {}
    if CMUDICT.exists():
        for line in CMUDICT.read_text('utf-8', errors='ignore').splitlines():
            if not line or line.startswith(';;;') or ' ' not in line:
                continue
            word, phones = line.split(maxsplit=1)
            base = word.split('(')[0].lower()
            dictionary.setdefault(base, phones.split())
    PRONUNCIATIONS = dictionary
    return dictionary

def phone_base(phone):
    return phone.rstrip('012')

def arpabet_to_ipa(phones):
    vowel_positions = [i for i, p in enumerate(phones) if phone_base(p) in VOWELS]
    if not vowel_positions:
        return '', []
    syllables = []
    start = 0
    for number, vowel_at in enumerate(vowel_positions):
        if number == 0:
            onset_at = start
        else:
            previous_vowel = vowel_positions[number - 1]
            between = [phone_base(p) for p in phones[previous_vowel + 1:vowel_at]]
            onset_length = 0
            for length in range(len(between), 0, -1):
                if tuple(between[-length:]) in VALID_ONSETS:
                    onset_length = length
                    break
            coda_length = len(between) - onset_length
            syllables[-1].extend(phones[previous_vowel + 1:previous_vowel + 1 + coda_length])
            onset_at = vowel_at - onset_length
        syllables.append(list(phones[onset_at:vowel_at + 1]))
    syllables[-1].extend(phones[vowel_positions[-1] + 1:])

    rendered = []
    stress_pattern = []
    for syllable in syllables:
        stress = next((int(p[-1]) for p in syllable if p[-1:].isdigit()), 0)
        stress_pattern.append(stress)
        text = ''
        for phone in syllable:
            base = phone_base(phone)
            if base == 'AH' and phone.endswith('0'):
                text += 'ə'
            elif base == 'ER' and phone.endswith('0'):
                text += 'ɚ'
            else:
                text += IPA_PHONES.get(base, '')
        rendered.append(('ˈ' if stress == 1 else 'ˌ' if stress == 2 else '') + text)
    return '/'+'.'.join(rendered)+'/', stress_pattern

def pronunciation_for(word):
    clean = ''.join(ch for ch in word.lower() if ch.isalpha() or ch in "'-")
    phones = load_pronunciations().get(clean)
    if not phones:
        return {'word': word, 'found': False}
    ipa, stresses = arpabet_to_ipa(phones)
    primary = stresses.index(1) + 1 if 1 in stresses else None
    return {'word': clean, 'found': True, 'ipa': ipa, 'syllables': len(stresses),
            'primary_stress': primary, 'arpabet': ' '.join(phones),
            'phones': [{'arpabet': phone_base(phone),
                        'ipa': ('ə' if phone_base(phone) == 'AH' and phone.endswith('0') else
                                'ɚ' if phone_base(phone) == 'ER' and phone.endswith('0') else
                                IPA_PHONES.get(phone_base(phone), ''))}
                       for phone in phones]}

def recordings():
    return {hashlib.sha256(p.name.encode()).hexdigest()[:24]: p for p in AUDIO.iterdir()
            if p.is_file() and not p.is_symlink() and p.suffix.lower() in EXTENSIONS}

def read_doc(key):
    path = DATA / (key + '.json')
    if not path.exists():
        return None
    doc = json.loads(path.read_text('utf-8'))
    # Backward-compatible default for transcripts created before this marker existed.
    for segment in doc.get('segments', []):
        segment.setdefault('listening', False)
        segment.setdefault('speaking', False)
        segment.setdefault('mastered', False)
        segment.setdefault('meaning', '')
        segment.setdefault('my_response', '')
        segment.setdefault('focus_stress', '')
        segment.setdefault('focus_weak', '')
        segment.setdefault('focus_links', '')
        segment.setdefault('mismatch_words', [])
    return doc

def write_doc(key, doc):
    path = DATA / (key + '.json')
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(temp, path)

def transcribe(key, path):
    global MODEL
    try:
        with LOCK:
            JOBS[key] = {'state': 'running', 'message': '正在加载本地英文模型…', 'progress': 0}
        from faster_whisper import WhisperModel
        if MODEL is None:
            MODEL = WhisperModel('small.en', device='cpu', compute_type='int8', local_files_only=True)
        segments, info = MODEL.transcribe(str(path), language='en', vad_filter=True,
                                         word_timestamps=True, condition_on_previous_text=False)
        result = []
        for s in segments:
            result.append({'id': len(result), 'start': s.start, 'end': s.end,
                           'text': s.text.strip(), 'original': s.text.strip(),
                           'words': [{'start': w.start, 'end': w.end, 'word': w.word} for w in (s.words or [])],
                           'highlight': False, 'favorite': False, 'listening': False,
                           'speaking': False, 'mastered': False, 'meaning': '',
                           'my_response': '', 'focus_stress': '', 'focus_weak': '',
                           'focus_links': '', 'mismatch_words': [], 'note': ''})
            with LOCK:
                JOBS[key] = {'state': 'running', 'message': f'已处理 {int(s.end)} / {int(info.duration)} 秒',
                             'progress': min(99, round(s.end / max(info.duration, 1) * 100))}
        with LOCK:
            write_doc(key, {'name': path.name, 'revision': 1, 'model': 'small.en', 'segments': result})
            JOBS[key] = {'state': 'done', 'message': '转录完成' if result else '未检测到英语语音', 'progress': 100}
    except Exception as exc:
        with LOCK:
            JOBS[key] = {'state': 'error', 'message': f'转录失败：{exc}。请检查依赖及本地模型，详见使用说明。'}

class Handler(BaseHTTPRequestHandler):
    def json_response(self, obj, status=200):
        raw = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(raw)

    def allowed(self):
        host = self.headers.get('Host', '')
        expected = f'127.0.0.1:{self.server.server_port}'
        return host == expected and self.headers.get('Origin', 'http://' + expected) == 'http://' + expected

    def do_GET(self):
        if not self.allowed():
            return self.json_response({'error': '仅允许本机访问'}, 403)
        parsed = urlparse(self.path)
        if parsed.path == '/api/files':
            with LOCK:
                return self.json_response([{'id': k, 'name': p.name, 'ready': (DATA / (k + '.json')).exists()} for k, p in recordings().items()])
        if parsed.path == '/api/doc':
            key = parse_qs(parsed.query).get('id', [''])[0]
            if key not in recordings():
                return self.json_response({'error': '录音不存在'}, 404)
            with LOCK:
                return self.json_response({'doc': read_doc(key), 'job': JOBS.get(key)})
        if parsed.path == '/api/pronunciation':
            word = parse_qs(parsed.query).get('word', [''])[0]
            if not word or len(word) > 80:
                return self.json_response({'error': '单词格式不正确'}, 400)
            return self.json_response(pronunciation_for(word))
        if parsed.path.startswith('/audio/'):
            path = recordings().get(unquote(parsed.path[7:]))
        else:
            path = {'/': ROOT / 'web/index.html', '/app.js': ROOT / 'web/app.js', '/style.css': ROOT / 'web/style.css'}.get(parsed.path)
        if not path or not path.is_file():
            return self.json_response({'error': '未找到文件'}, 404)
        size = path.stat().st_size
        start, end, status = 0, size - 1, 200
        header = self.headers.get('Range')
        if header:
            try:
                unit, interval = header.split('=')
                first, last = interval.split('-')
                if unit != 'bytes' or ',' in interval: raise ValueError()
                if first:
                    start, end = int(first), min(int(last), end) if last else end
                else:
                    start = max(0, size - int(last))
                if start < 0 or start > end or start >= size: raise ValueError()
                status = 206
            except ValueError:
                self.send_response(416)
                self.send_header('Content-Range', f'bytes */{size}')
                self.end_headers()
                return
        self.send_response(status)
        self.send_header('Content-Type', mimetypes.guess_type(path)[0] or 'application/octet-stream')
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Length', str(end - start + 1))
        if parsed.path in ('/', '/app.js', '/style.css'):
            self.send_header('Cache-Control', 'no-store')
        if status == 206: self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.end_headers()
        try:
            with path.open('rb') as f:
                f.seek(start)
                remaining = end - start + 1
                while remaining > 0:
                    chunk = f.read(min(65536, remaining))
                    if not chunk: break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        if not self.allowed():
            return self.json_response({'error': '仅允许本机访问'}, 403)
        try:
            length = int(self.headers.get('Content-Length', 0))
            if not 0 < length <= 20_000_000: raise ValueError('请求大小不正确')
            payload = json.loads(self.rfile.read(length))
            key = payload.get('id')
            path = recordings().get(key)
            if path is None: raise ValueError('录音不存在')
            with LOCK:
                if self.path == '/api/transcribe':
                    if read_doc(key): return self.json_response({'error': '已有逐字稿，保留现有修改'}, 409)
                    if any(j['state'] == 'running' for j in JOBS.values()):
                        return self.json_response({'error': '另一项转录正在运行，请稍后再试'}, 409)
                    JOBS[key] = {'state': 'running', 'message': '准备转录…', 'progress': 0}
                    threading.Thread(target=transcribe, args=(key, path), daemon=True).start()
                    return self.json_response({'ok': True})
                if self.path == '/api/save':
                    old = read_doc(key)
                    doc = payload['doc']
                    if not old or old['revision'] != doc.get('revision'):
                        return self.json_response({'error': '文件已在其他页面更新，请先导出当前修改，再刷新页面'}, 409)
                    if len(doc['segments']) != len(old['segments']): raise ValueError('句子数量不正确')
                    for new, saved in zip(doc['segments'], old['segments']):
                        if new['id'] != saved['id']: raise ValueError('句子顺序不正确')
                        for field in ('text', 'note', 'meaning', 'my_response',
                                      'focus_stress', 'focus_weak', 'focus_links'):
                            if not isinstance(new[field], str) or len(new[field]) > 100000: raise ValueError('文字格式不正确')
                            saved[field] = new[field]
                        for field in ('highlight', 'favorite', 'listening', 'speaking', 'mastered'):
                            if not isinstance(new[field], bool): raise ValueError('标记格式不正确')
                            saved[field] = new[field]
                        mismatch = new['mismatch_words']
                        if (not isinstance(mismatch, list) or len(mismatch) > 100 or
                                any(not isinstance(word, str) or len(word) > 80 for word in mismatch)):
                            raise ValueError('发音标记格式不正确')
                        saved['mismatch_words'] = list(dict.fromkeys(word.lower() for word in mismatch))
                    old['revision'] += 1
                    write_doc(key, old)
                    return self.json_response({'revision': old['revision']})
            return self.json_response({'error': '未知请求'}, 404)
        except (ValueError, KeyError, TypeError) as exc:
            return self.json_response({'error': str(exc)}, 400)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    url = f'http://127.0.0.1:{args.port}'
    print('English listening notebook: ' + url, flush=True)
    if not args.no_browser: webbrowser.open(url)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close()
