import datetime as dt
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "bin" / "agent-board"
LOADER = SourceFileLoader("agent_board_delivery", str(SCRIPT))
SPEC = importlib.util.spec_from_loader("agent_board_delivery", LOADER)
ab = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = ab
SPEC.loader.exec_module(ab)


class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="agent-board-v2-")
        self.root = Path(self.tmp.name)
        self.jobs = self.root / "jobs"
        self.jobs.mkdir()
        self.env = {"AGENT_BOARD_JOBS_ROOT": str(self.jobs), "AGENT_BOARD_DIGEST_CMD": "off"}
        self.saved = {k: os.environ.get(k) for k in [*self.env, "AGENT_BOARD_JOBDIR", "AGENT_BOARD_NAME"]}
        os.environ.update(self.env)
        os.environ.pop("AGENT_BOARD_JOBDIR", None)
        os.environ.pop("AGENT_BOARD_NAME", None)
        self.db = self.root / "board.db"
        self.board = ab.Board(self.db)
        self.site = self.jobs / "jev-page-fixes-20260924"
        self.scout = self.jobs / "jev-new-models-scout-20260924"
        for job in (self.site, self.scout):
            job.mkdir()
        self.board.touch_agent("codex:jev-page-fixes-20260924", str(self.site))
        self.board.touch_agent("codex:session-abc", str(self.scout))
        self.tid, _ = self.board.create_thread("Coordination", ["test"], "owner:test", None)

    def tearDown(self):
        for key, value in self.saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.tmp.cleanup()

    def cli(self, *args, name="owner:test", cwd=None, stdin=""):
        env = dict(os.environ, AGENT_BOARD_DB=str(self.db), PYTHONDONTWRITEBYTECODE="1", AGENT_BOARD_DIR=str(self.root))
        env.pop("AGENT_BOARD_NAME", None)
        cmd = [sys.executable, str(SCRIPT)] + (["--as", name] if name else []) + list(args)
        return subprocess.run(cmd, capture_output=True, text=True, env=env, cwd=cwd or self.root, input=stdin, timeout=30)

    def test_addressing_by_job_name_alias_and_group(self):
        self.board.group_add("site-jobs", ["jev-page-*"])
        self.board.post(str(self.tid), "owner:test", "@jev-page-fixes check the chart", "question")
        self.board.post(str(self.tid), "owner:test", "Heads up @site-jobs: deploy frozen", "warning")
        self.board.post(str(self.tid), "owner:test", "@jev-new-models-scout measure CLM", "note")
        site = self.board.inbox("codex:jev-page-fixes-20260924", jobdir=str(self.site))
        self.assertEqual([r["kind"] for r in site], ["question", "warning"])
        self.assertTrue(all(r["addressed"] for r in site))
        # A new identity in the same job folder still receives entries addressed to the legacy session name.
        scout = self.board.inbox("claude:jev-new-models-scout-20260924", jobdir=str(self.scout))
        self.assertEqual([r["body"] for r in scout], ["@jev-new-models-scout measure CLM"])
        pointer = (self.site / "BOARD-INBOX.md").read_text()
        self.assertIn("**@you**", pointer)
        self.assertEqual(pointer.count("\n"), 2)
        self.assertNotIn("measure CLM", pointer)
        self.assertFalse((self.scout / "BOARD-INBOX.md").read_text().count("deploy frozen"))

    def test_leading_job_prefix_and_explicit_to(self):
        eid = self.board.post(str(self.tid), "claude:laptop", "jev-new-models-scout + jev-page-fixes: please do X", "decision")
        self.assertEqual(self.board.entry(eid)["addresses"], ["jev-new-models-scout", "jev-page-fixes"])
        eid = self.board.post(str(self.tid), "claude:laptop", "Disk: freed space", "note")
        self.assertEqual(self.board.entry(eid)["addresses"], [])
        eid = self.board.post(str(self.tid), "claude:laptop", "plain", "note", to=["@jev-page-fixes"])
        self.assertEqual(self.board.entry(eid)["addresses"], ["jev-page-fixes"])

    def test_inbox_lists_addressed_before_subscribed(self):
        self.board.subscribe("codex:jev-page-fixes-20260924", str(self.tid), str(self.site))
        self.board.post(str(self.tid), "owner:test", "general finding", "finding")
        self.board.post(str(self.tid), "owner:test", "@jev-page-fixes specific", "question")
        rows = self.board.inbox("codex:jev-page-fixes-20260924", jobdir=str(self.site))
        self.assertEqual([r["body"] for r in rows], ["@jev-page-fixes specific", "general finding"])
        out = self.cli("inbox", name="codex:other")
        self.assertEqual(out.returncode, 0, out.stderr)

    def test_decision_ack_cycle_with_redelivery_and_escalation(self):
        sent = self.root / "digest.txt"
        os.environ["AGENT_BOARD_DIGEST_CMD"] = f"sh -c 'printf \"%s\\n\" \"$0\" >> {sent}'"
        eid = self.board.post(str(self.tid), "claude:laptop", "@jev-page-fixes Decision: ship it", "decision")
        self.assertEqual(len(self.board.open_acks()), 1)
        self.assertIn("ACK NEEDED", (self.site / "BOARD-INBOX.md").read_text())
        with self.board.transaction() as conn:
            conn.execute("UPDATE entries SET created_at=? WHERE id=?", (ab.iso(dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=16)), eid))
        self.assertEqual(self.board.tick()["reminded"], [eid])
        self.assertIn("REMINDER 1", (self.site / "BOARD-INBOX.md").read_text())
        self.assertEqual(self.board.tick()["reminded"], [])
        items, _ = self.board.push_items("codex:jev-page-fixes-20260924", str(self.site), 10**6)
        self.assertEqual([(i["id"], i["push"]) for i in items], [(eid, "reminder")])
        with self.board.transaction() as conn:
            conn.execute("UPDATE entries SET created_at=? WHERE id=?", (ab.iso(dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=61)), eid))
        self.assertEqual(self.board.tick()["escalated"], [eid])
        self.assertIn(f"decision #{eid}", sent.read_text())
        self.assertEqual(self.board.tick()["escalated"], [])
        self.assertEqual(self.board.digest()["unacked"][0]["id"], eid)
        status = self.board.ack(eid, "codex:session-xyz", jobdir=str(self.site))
        self.assertEqual(status["state"], "acked")
        self.assertEqual(self.board.open_acks(), [])

    def test_ack_needs_every_addressee_and_humans_are_exempt(self):
        eid = self.board.post(str(self.tid), "claude:laptop", "@jev-page-fixes @jev-new-models-scout @human go", "decision")
        self.assertEqual(self.board.ack(eid, "codex:jev-page-fixes-20260924")["missing"], ["jev-new-models-scout"])
        out = self.cli("ack", str(eid), name="codex:session-abc")
        self.assertIn("closed", out.stdout)
        eid = self.board.post(str(self.tid), "claude:laptop", "@human please decide", "decision")
        self.assertEqual(self.board.entry(eid)["ack_required"], 0)
        self.assertEqual(self.board.digest()["for_humans"][-1]["id"], eid)

    def test_redirected_thread_routes_by_topic_and_keeps_old_subscribers(self):
        site, _ = self.board.create_thread("Site and deploy", ["site"], "owner:test", None)
        gpu, _ = self.board.create_thread("GPU pods", ["gpu"], "owner:test", None)
        self.board.set_topic(str(site), "site", ["deploy", "checkout", "writer"])
        self.board.set_topic(str(gpu), "infra", ["gpu", "pod", "disk"])
        self.board.subscribe("codex:old", str(self.tid), str(self.scout))
        self.board.set_redirect(str(self.tid), [str(site), str(gpu)])
        self.board.archive(str(self.tid))
        a = self.board.post(str(self.tid), "writer:x", "Disk is at 90%, pod terminated", "warning")
        b = self.board.post(str(self.tid), "writer:x", "Unrelated note", "note")
        self.assertEqual(self.board.entry(a)["thread_id"], gpu)
        self.assertEqual(self.board.entry(a)["routed_from"], self.tid)
        self.assertEqual(self.board.entry(b)["thread_id"], site)
        self.assertEqual(self.board.resolve_thread("infra")["id"], gpu)
        rows = self.board.inbox("codex:old", jobdir=str(self.scout))
        self.assertEqual(len(rows), 2)
        self.assertEqual((self.scout / "BOARD-INBOX.md").read_text().count("Agent board"), 2)
        out = self.cli("post", str(self.tid), "writer deploy queue", name="writer:y")
        self.assertIn(f"thread #{site}", out.stdout)
        self.assertIn("redirects by topic", out.stdout)
        self.board.rename(str(gpu), "GPU pods & infrastructure")
        self.assertEqual(self.board.resolve_thread("GPU pods")["id"], gpu)

    def test_auto_archive_skips_pinned_topic_threads(self):
        quiet, _ = self.board.create_thread("Quiet", [], "owner:test", "x")
        topic, _ = self.board.create_thread("Topic", [], "owner:test", "y")
        self.board.set_topic(str(topic), "releases")
        old = ab.iso(dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=8))
        with self.board.transaction() as conn:
            conn.execute("UPDATE threads SET updated_at=?", (old,))
        self.assertEqual(self.board.tick()["archived"], 2)
        archived = {t["id"] for t in self.board.list_threads(archived=True) if t["archived_at"]}
        self.assertIn(quiet, archived)
        self.assertNotIn(topic, archived)

    def test_hook_injects_only_new_relevant_items_once_and_stays_lean(self):
        env_name = "codex:jev-page-fixes-20260924"
        first = self.cli("hook", "--interval", "0", name=None, cwd=self.site, stdin=json.dumps({"hook_event_name": "PostToolUse", "cwd": str(self.site)}))
        self.assertEqual(first.stdout, "")
        self.board.post(str(self.tid), "owner:test", "@jev-page-fixes " + "long text " * 400, "question")
        self.board.post(str(self.tid), "owner:test", "not for you", "note")
        second = self.cli("hook", "--interval", "0", name=None, cwd=self.site, stdin=json.dumps({"hook_event_name": "PostToolUse", "cwd": str(self.site)}))
        payload = json.loads(second.stdout)
        text = payload["hookSpecificOutput"]["additionalContext"]
        self.assertEqual(payload["hookSpecificOutput"]["hookEventName"], "PostToolUse")
        self.assertIn("@you", text)
        self.assertNotIn("not for you", text)
        self.assertLess(len(text), 1500)
        third = self.cli("hook", "--interval", "0", name=None, cwd=self.site, stdin="{}")
        self.assertEqual(third.stdout, "")
        outside = self.cli("hook", "--interval", "0", name=None, cwd=self.root, stdin="{}")
        self.assertEqual(outside.stdout, "")
        self.assertTrue(env_name)

    def test_hook_cap_and_errors_never_break_the_agent(self):
        self.board.subscribe("codex:jev-page-fixes-20260924", str(self.tid), str(self.site))
        items = [{"id": i, "thread_id": 1, "title": "T", "push": "new", "addressed": False, "kind": "note",
                  "author": "a", "body": "x" * 500, "ack": None} for i in range(100)]
        text = ab.format_push(items, "me", 2000)
        self.assertLessEqual(len(text), 2200)
        self.assertIn("more; run `agent-board inbox`", text)
        broken = self.cli("hook", name="x:y", stdin="not json")
        self.assertEqual(broken.returncode, 0)

    def test_snapshot_v2_has_addresses_ack_and_topics(self):
        eid = self.board.post(str(self.tid), "claude:laptop", "@jev-page-fixes go", "decision")
        self.board.set_topic(str(self.tid), "site")
        snap = self.board.snapshot()
        self.assertEqual(snap["schemaVersion"], 2)
        thread = next(t for t in snap["threads"] if t["id"] == str(self.tid))
        self.assertEqual(thread["topic"], "site")
        entry = next(e for e in thread["entries"] if e["id"] == str(eid))
        self.assertEqual(entry["addresses"], ["jev-page-fixes"])
        self.assertEqual(entry["ack"]["state"], "open")

    def test_migration_from_v1_database_backfills_mentions_without_acks(self):
        legacy = self.root / "legacy.db"
        import sqlite3
        conn = sqlite3.connect(legacy)
        conn.executescript(
            "CREATE TABLE threads (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT);"
            "CREATE TABLE entries (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id INTEGER NOT NULL, author TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);"
            "INSERT INTO threads(title,created_at,updated_at) VALUES('Old','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z');"
            "INSERT INTO entries(thread_id,author,kind,body,created_at) VALUES(1,'a','decision','@bob do it','2026-09-01T00:00:00Z');"
        )
        conn.commit()
        conn.close()
        board = ab.Board(legacy)
        entry = board.entry(1)
        self.assertEqual(entry["addresses"], ["bob"])
        self.assertEqual(entry["ack_required"], 0)
        self.assertEqual(board.groups()["humans"], ["human", "owner"])


if __name__ == "__main__":
    unittest.main()
