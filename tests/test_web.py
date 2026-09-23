import base64
import importlib.util
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from urllib import error, request

ROOT = Path(__file__).resolve().parents[1]
EXPORTER = ROOT / "web" / "host" / "export_snapshot.py"
CLI = ROOT / "bin" / "agent-board"

spec = importlib.util.spec_from_file_location("export_snapshot", EXPORTER)
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


class WebTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Path(self.temp.name) / "board.db"
        self.username = "viewer"
        self.password = "synthetic-strong-password-for-tests"
        self.token = "synthetic-export-token-for-tests"
        subprocess.run([sys.executable, str(CLI), "init"], env={**os.environ, "AGENT_BOARD_DB": str(self.db)}, check=True, capture_output=True)
        subprocess.run([sys.executable, str(CLI), "--as", "alice:toy", "new", "Toy model training", "--tag", "training", "--body", "<script>alert(1)</script> Bob tests a tiny classifier."], env={**os.environ, "AGENT_BOARD_DB": str(self.db)}, check=True, capture_output=True)
        exporter.DB_PATH = self.db
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            self.port = sock.getsockname()[1]
        self.url = f"http://127.0.0.1:{self.port}"
        self.proc = subprocess.Popen(["node", str(ROOT / "web" / "server.mjs")], env={**os.environ, "PORT": str(self.port), "BOARD_USERNAME": self.username, "BOARD_PASSWORD": self.password, "BOARD_EXPORT_TOKEN": self.token}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            try:
                if request.urlopen(self.url + "/healthz", timeout=0.5).status == 200:
                    break
            except OSError:
                time.sleep(0.05)
        else:
            self.fail("web server did not start")

    def tearDown(self):
        self.proc.terminate()
        self.proc.wait(timeout=5)
        self.temp.cleanup()

    def fetch(self, path, username=None, password=None, method="GET", data=None, token=None):
        headers = {}
        if username is not None:
            credentials = base64.b64encode(f"{username}:{password}".encode()).decode()
            headers["Authorization"] = "Basic " + credentials
        if token is not None:
            headers["Authorization"] = "Bearer " + token
        if data is not None:
            headers["Content-Type"] = "application/json"
        return request.urlopen(request.Request(self.url + path, data=data, method=method, headers=headers), timeout=3)

    def test_auth_snapshot_and_read_only_routes(self):
        for username, password in [(None, None), (self.username, "wrong-password")]:
            with self.assertRaises(error.HTTPError) as raised:
                self.fetch("/api/threads", username, password)
            self.assertEqual(raised.exception.code, 401)
        with self.assertRaises(error.HTTPError) as raised:
            self.fetch("/api/snapshot", method="POST", data=b"{}", token="wrong-token")
        self.assertEqual(raised.exception.code, 403)

        snapshot = exporter.build_snapshot()
        self.assertEqual(snapshot["threads"][0]["title"], "Toy model training")
        self.assertEqual(snapshot["threads"][0]["tags"], ["training"])
        with self.fetch("/api/snapshot", method="POST", data=json.dumps(snapshot).encode(), token=self.token) as response:
            self.assertEqual(response.status, 202)
        with self.fetch("/api/threads", self.username, self.password) as response:
            data = json.load(response)
            self.assertEqual(data["threads"][0]["title"], "Toy model training")
            self.assertIn("noindex", response.headers["X-Robots-Tag"])
        with self.fetch("/api/threads/1", self.username, self.password) as response:
            data = json.load(response)
            body_html = data["entries"][0]["bodyHtml"]
            self.assertNotIn("<script>", body_html)
            self.assertIn("&lt;script&gt;", body_html)
        with self.assertRaises(error.HTTPError) as raised:
            self.fetch("/api/threads/1", self.username, self.password, method="POST", data=b"{}")
        self.assertEqual(raised.exception.code, 404)
        with self.fetch("/robots.txt") as response:
            self.assertIn("Disallow: /", response.read().decode())


if __name__ == "__main__":
    unittest.main()
