from __future__ import annotations

from contextlib import closing
import json
import sqlite3
import threading
from pathlib import Path
from typing import Any


class ActivityStore:
    def __init__(self, database_path: Path, retention_count: int = 200) -> None:
        self.database_path = database_path
        self.retention_count = retention_count
        self._lock = threading.Lock()
        self._latest: dict[str, Any] | None = None
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.database_path)

    def _init_db(self) -> None:
        with closing(self._connect()) as db:
            with db:
                db.execute(
                    """
                    CREATE TABLE IF NOT EXISTS events (
                        id TEXT PRIMARY KEY,
                        timestamp TEXT NOT NULL,
                        trigger TEXT NOT NULL,
                        payload TEXT NOT NULL
                    )
                    """
                )
                db.execute("CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp)")

    def set_retention_count(self, retention_count: int) -> None:
        self.retention_count = max(1, int(retention_count))
        self._enforce_retention()

    def add_event(self, event: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            self._latest = event
            with closing(self._connect()) as db:
                with db:
                    db.execute(
                        "INSERT OR REPLACE INTO events (id, timestamp, trigger, payload) VALUES (?, ?, ?, ?)",
                        (
                            str(event["id"]),
                            str(event["timestamp"]),
                            str(event.get("trigger", "unknown")),
                            json.dumps(event, ensure_ascii=False),
                        ),
                    )
            self._enforce_retention()
        return event

    def _enforce_retention(self) -> None:
        with closing(self._connect()) as db:
            with db:
                db.execute(
                    """
                    DELETE FROM events
                    WHERE id NOT IN (
                        SELECT id FROM events
                        ORDER BY timestamp DESC
                        LIMIT ?
                    )
                    """,
                    (self.retention_count,),
                )

    def latest(self) -> dict[str, Any] | None:
        if self._latest is not None:
            return self._latest

        events = self.list_events(limit=1)
        return events[0] if events else None

    def list_events(self, limit: int = 50) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit), 1000))
        with closing(self._connect()) as db:
            rows = db.execute(
                "SELECT payload FROM events ORDER BY timestamp DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [json.loads(row[0]) for row in rows]


def build_context_payload(event: dict[str, Any]) -> dict[str, Any]:
    """Future remote/API integration hook. V1 returns a local-only payload copy."""
    return dict(event)
