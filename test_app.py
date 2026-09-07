import copy
import json
from pathlib import Path
import uuid
import shutil
import threading
import unittest
import urllib.request
import urllib.error
import app


class LocalServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = app.ROOT / ('test-' + uuid.uuid4().hex)
        cls.temp.mkdir()
        app.AUDIO = cls.temp / 'audio'
        app.DATA = cls.temp / 'data'
        app.AUDIO.mkdir()
        app.DATA.mkdir()
        (app.AUDIO / 'meeting.mp3').write_bytes(b'0123456789')
        cls.key = next(iter(app.recordings()))
        app.write_doc(cls.key, {'name': 'meeting.mp3', 'revision': 1, 'segments': [
             {'id': 0, 'start': 0, 'end': 1, 'text': 'Hello', 'original': 'Hello',
             'note': '', 'highlight': False, 'favorite': False, 'listening': False}]})
        cls.server = app.ThreadingHTTPServer(('127.0.0.1', 0), app.Handler)
        cls.url = 'http://127.0.0.1:' + str(cls.server.server_port)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        assert cls.temp.resolve().parent == app.ROOT.resolve()
        shutil.rmtree(cls.temp)

    def request(self, path, data=None, headers=None):
        req = urllib.request.Request(self.url + path, data=json.dumps(data).encode() if data else None, headers=headers or {})
        try:
            with urllib.request.urlopen(req) as r: return r.status, r.read(), r.headers
        except urllib.error.HTTPError as e:
            return e.code, e.read(), e.headers

    def test_range_seek(self):
        status, content, headers = self.request('/audio/' + self.key, headers={'Range': 'bytes=3-6'})
        self.assertEqual((status, content), (206, b'3456'))
        self.assertEqual(headers['Content-Range'], 'bytes 3-6/10')
        self.assertEqual(self.request('/audio/' + self.key, headers={'Range': 'bytes=99-'})[0], 416)

    def test_save_and_conflict(self):
        doc = copy.deepcopy(app.read_doc(self.key))
        doc['segments'][0].update(text='Corrected English', note='中文学习笔记', favorite=True,
                                  highlight=True, listening=True, speaking=True,
                                  meaning='中文含义', my_response='My response.',
                                  focus_stress='corrected, English', mismatch_words=['english'])
        self.assertEqual(self.request('/api/save', {'id': self.key, 'doc': doc})[0], 200)
        stored = json.loads(self.request('/api/doc?id=' + self.key)[1])['doc']
        self.assertEqual(stored['segments'][0]['note'], '中文学习笔记')
        self.assertEqual(stored['segments'][0]['original'], 'Hello')
        self.assertTrue(stored['segments'][0]['listening'])
        self.assertTrue(stored['segments'][0]['speaking'])
        self.assertEqual(stored['segments'][0]['meaning'], '中文含义')
        self.assertEqual(stored['segments'][0]['my_response'], 'My response.')
        self.assertEqual(stored['segments'][0]['mismatch_words'], ['english'])
        self.assertEqual(self.request('/api/save', {'id': self.key, 'doc': doc})[0], 409)

    def test_local_access_and_paths(self):
        self.assertEqual(self.request('/api/files', headers={'Origin': 'https://example.com'})[0], 403)
        self.assertEqual(self.request('/api/files', headers={'Host': 'evil.example'})[0], 403)
        self.assertEqual(self.request('/audio/../../app.py')[0], 404)
        self.assertEqual(self.request('/')[0], 200)

    def test_offline_pronunciation_lookup(self):
        status, content, _ = self.request('/api/pronunciation?word=feasible')
        result = json.loads(content)
        self.assertEqual(status, 200)
        self.assertEqual(result['ipa'], '/ˈfiː.zə.bəl/')
        self.assertEqual(result['primary_stress'], 1)
        self.assertFalse(json.loads(self.request('/api/pronunciation?word=Ksat')[1])['found'])


if __name__ == '__main__':
    unittest.main()
