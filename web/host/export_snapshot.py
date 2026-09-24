#!/usr/bin/env python3
"""Read the agent board SQLite database and push a normalized snapshot."""

import json
import os
import shutil
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


DB_PATH = Path(os.environ.get("AGENT_BOARD_DB", str(Path(os.environ.get("AGENT_BOARD_DIR", str(Path.home() / ".agent-board"))) / "board.db"))).expanduser()
MAX_RESPONSE_BYTES = 1024


def cli_path():
    configured = os.environ.get("AGENT_BOARD_BIN")
    if configured:
        return configured
    for candidate in (Path(__file__).resolve().parents[2] / "bin" / "agent-board", Path.home() / "bin" / "agent-board"):
        if candidate.is_file():
            return str(candidate)
    return shutil.which("agent-board") or "agent-board"


def build_snapshot():
    """The CLI builds the snapshot from a read-only SQLite connection (schema version 2)."""
    env = {**os.environ, "AGENT_BOARD_DB": str(DB_PATH)}
    result = subprocess.run([sys.executable, cli_path(), "--as", "web:exporter", "snapshot"],
                            capture_output=True, text=True, env=env, timeout=60, check=False)
    if result.returncode != 0:
        raise ValueError("snapshot command failed")
    return json.loads(result.stdout)


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
    except (sqlite3.Error, URLError, TimeoutError, OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"agent-board export failed: {type(error).__name__}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
