import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import socket
import time
from urllib.request import urlopen
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
CLI = Path(os.environ.get('ARTIFACT_TEST_CLI', REPO / 'bin' / 'agent-board'))
BASELINE = HERE / 'agent-board.baseline'
loader = importlib.machinery.SourceFileLoader('artifact_board', str(CLI))
spec = importlib.util.spec_from_loader(loader.name, loader)
b = importlib.util.module_from_spec(spec)
loader.exec_module(b)


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = Path(self.temp.name) / 'board.db'
        self.env = {**os.environ, 'AGENT_BOARD_DB': str(self.db), 'AGENT_BOARD_DIR': self.temp.name,
                    'AGENT_BOARD_NAME': 'test:writer', 'AGENT_BOARD_JOBS_ROOT': self.temp.name, 'AGENT_BOARD_JOBDIR': self.temp.name + '/no-job', 'AGENT_BOARD_REACH_SKIP': '1'}
        # An old-schema fixture; all writes are isolated.
        self.cli('init')
        with sqlite3.connect(self.db) as c:
            c.execute('ALTER TABLE entries DROP COLUMN artifact_ids')
            c.execute("INSERT INTO threads(title,created_at,updated_at) VALUES('Artifacts','2026-10-31','2026-10-31')")
            c.execute("INSERT INTO entries(thread_id,author,kind,body,created_at) VALUES(1,'test:writer','note','Old client entry','2026-10-31')")

    def cli(self, *args, cli=CLI, check=True):
        r = subprocess.run([sys.executable, str(cli), *args], env=self.env,
                           text=True, capture_output=True, timeout=35)
        if check:
            self.assertEqual(r.returncode, 0, r.stderr)
        return r

    def test_old_schema_readonly_and_migration(self):
        before = self.db.read_bytes()
        data = json.loads(self.cli('snapshot').stdout)
        self.assertEqual(data['threads'][0]['entries'][0]['artifact_ids'], [])
        self.assertEqual(before, self.db.read_bytes())
        self.cli('init')
        self.cli('init')
        with sqlite3.connect(self.db) as c:
            col = [r for r in c.execute('pragma table_info(entries)') if r[1] == 'artifact_ids']
            self.assertEqual(len(col), 1)
            self.assertEqual(col[0][3:5], (1, "'[]'"))
            self.assertEqual(c.execute('select artifact_ids from entries').fetchone()[0], '[]')
        # Old client omits the new column and continues to write.
        with sqlite3.connect(self.db) as c:
            c.execute("INSERT INTO entries(thread_id,author,kind,body,created_at) VALUES(1,'test:writer','note','Still old','2026-10-31')")
        self.assertEqual(json.loads(self.cli('read', '1', '--json').stdout)[-1]['artifact_ids'], [])

    def test_post_read_search_export_json_inbox(self):
        self.cli('post', '1', 'Body a#B8C3FF and A#00FF12 duplicate a#b8c3ff.',
                 '--artifact', 'A#B8C3FF', '--artifact', 'abcdef', '--to', 'test:reader')
        ids = ['b8c3ff', 'abcdef', '00ff12']
        rows = json.loads(self.cli('read', '1', '--json').stdout)
        self.assertEqual(rows[-1]['artifact_ids'], ids)
        self.assertIn(' · a#b8c3ff · a#abcdef · a#00ff12', self.cli('read', '1').stdout)
        self.assertEqual(len(json.loads(self.cli('search', '--artifact', 'B8C3FF', '--json').stdout)), 1)
        self.assertEqual(json.loads(self.cli('search', 'absent', '--artifact', 'b8c3ff', '--json').stdout), [])
        self.assertEqual(json.loads(self.cli('search', '--artifact', 'aaaaaa', '--json').stdout), [])
        for command in ['snapshot', 'export']:
            self.assertEqual(json.loads(self.cli(command).stdout)['threads'][0]['entries'][-1]['artifact_ids'], ids)
        self.assertEqual(json.loads(self.cli('--as', 'test:reader', 'inbox', '--json').stdout)[0]['artifact_ids'], ids)
        self.cli('post', '1', 'Next a#b8c3ff', '--to', 'test:reader')
        self.assertIn(' · a#b8c3ff', self.cli('--as', 'test:reader', 'inbox').stdout)

    def test_extraction_boundaries_and_invalid_ids(self):
        self.assertEqual(b.collect_artifacts('a#1234567 a#12345g za#abcdef a#abcdefz _a#abcdef A#B8C3FF, a#00ff12.'), ['b8c3ff', '00ff12'])
        for aid in ['gggggg', 'a#12345', '1234567', 'a#123456\n', '', '<script>']:
            r = self.cli('post', '1', 'Invalid', '--artifact', aid, check=False)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn('Invalid artifact id', r.stderr)
        self.assertEqual(len(json.loads(self.cli('snapshot').stdout)['threads'][0]['entries']), 1)

    def test_no_registry_or_side_effect_dependency(self):
        with patch.object(b.Board, '_after_entry'):
            board = b.Board(self.db)
            with patch('urllib.request.urlopen', side_effect=AssertionError('network forbidden')):
                eid = board.post('1', 'test:offline', 'a#b8c3ff', artifacts=['00ff12'])
            self.assertEqual(board.entry(eid)['artifact_ids'], ['00ff12', 'b8c3ff'])

    def test_http_snapshot_and_title_extraction(self):
        self.cli('new', 'Title A#B8C3FF', '--body', 'Body a#00ff12')
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        proc = subprocess.Popen([sys.executable, str(CLI), 'web', '--port', str(port)],
                                env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            for _ in range(100):
                try:
                    with urlopen(f'http://127.0.0.1:{port}/api/board', timeout=0.5) as response:
                        data = json.load(response)
                    break
                except OSError:
                    time.sleep(0.02)
            else:
                self.fail('isolated HTTP server did not start')
            rows = [e for t in data['threads'] for e in t['entries'] if e['body'].startswith('Body')]
            self.assertEqual(rows[0]['artifact_ids'], ['b8c3ff', '00ff12'])
        finally:
            proc.terminate()
            proc.communicate(timeout=5)

    def test_two_concurrent_migrating_writers(self):
        args = [[sys.executable, str(CLI), 'post', '1', 'Concurrent a#b8c3ff', '--artifact', aid]
                for aid in ['00ff12', 'abcdef']]
        procs = [subprocess.Popen(a, env=self.env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE) for a in args]
        for proc in procs:
            out, err = proc.communicate(timeout=35)
            self.assertEqual(proc.returncode, 0, err)
        rows = json.loads(self.cli('read', '1', '--json').stdout)
        self.assertEqual(len(rows), 3)
        self.assertEqual({tuple(r['artifact_ids']) for r in rows[1:]}, {('00ff12', 'b8c3ff'), ('abcdef', 'b8c3ff')})
        with sqlite3.connect(self.db) as c:
            self.assertEqual(c.execute('pragma integrity_check').fetchone()[0], 'ok')


if __name__ == '__main__':
    unittest.main(verbosity=2)
