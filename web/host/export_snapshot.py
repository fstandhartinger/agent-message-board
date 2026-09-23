#!/usr/bin/env python3
"""Read the agent board SQLite database and push a normalized snapshot."""

import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from urllib.parse import quote


DB_PATH = Path(os.environ.get("AGENT_BOARD_DB", str(Path(os.environ.get("AGENT_BOARD_DIR", str(Path.home() / ".agent-board"))) / "board.db"))).expanduser()
MAX_RESPONSE_BYTES = 1024


def build_snapshot():
    db_uri = "file:" + quote(str(DB_PATH.resolve()), safe="/") + "?mode=ro"
    connection = sqlite3.connect(db_uri, uri=True, timeout=10, isolation_level=None)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA query_only=ON")
        connection.execute("BEGIN")
        rows = connection.execute(
            "SELECT id,title,created_at,updated_at,archived_at "
            "FROM threads ORDER BY updated_at DESC,id DESC"
        ).fetchall()
        threads = {
            int(row["id"]): {
                "id": str(row["id"]),
                "title": row["title"],
                "createdAt": row["created_at"],
                "lastActivity": row["updated_at"],
                "archived": row["archived_at"] is not None,
                "tags": [],
                "entries": [],
            }
            for row in rows
        }

        for row in connection.execute("SELECT thread_id,tag FROM thread_tags ORDER BY tag"):
            thread = threads.get(int(row["thread_id"]))
            if thread is not None:
                thread["tags"].append(row["tag"])

        for row in connection.execute(
            "SELECT id,thread_id,author,kind,body,created_at "
            "FROM entries ORDER BY thread_id,id"
        ):
            thread = threads.get(int(row["thread_id"]))
            if thread is not None:
                thread["entries"].append({
                    "id": str(row["id"]),
                    "author": row["author"],
                    "kind": row["kind"],
                    "body": row["body"],
                    "createdAt": row["created_at"],
                    "attachments": [],
                })

        entry_index = {
            int(entry["id"]): entry
            for thread in threads.values()
            for entry in thread["entries"]
        }
        for row in connection.execute("SELECT entry_id,path FROM attachments ORDER BY id"):
            entry = entry_index.get(int(row["entry_id"]))
            if entry is not None:
                entry["attachments"].append(row["path"])

        return {
            "schemaVersion": 1,
            "exportedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "threads": list(threads.values()),
        }
    finally:
        connection.close()


def main():
    app_url = os.environ.get("BOARD_APP_URL", "").rstrip("/")
    token = os.environ.get("BOARD_EXPORT_TOKEN", "")
    local_http = app_url.startswith(("http://127.0.0.1:", "http://localhost:"))
    if not (app_url.startswith("https://") or local_http) or not token:
        print("agent-board export failed: configuration missing", file=sys.stderr)
        return 1

    try:
        snapshot = build_snapshot()
        payload = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        request = Request(
            f"{app_url}/api/snapshot",
            data=payload,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "User-Agent": "agent-board-host-exporter/1.0",
            },
            method="POST",
        )
        with urlopen(request, timeout=25) as response:
            response.read(MAX_RESPONSE_BYTES)
            if response.status != 202:
                print(f"agent-board export failed: HTTP {response.status}", file=sys.stderr)
                return 1
        return 0
    except HTTPError as error:
        print(f"agent-board export failed: HTTP {error.code}", file=sys.stderr)
        return 1
    except (sqlite3.Error, URLError, TimeoutError, OSError, ValueError) as error:
        print(f"agent-board export failed: {type(error).__name__}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
