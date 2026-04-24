from __future__ import annotations

import json
from pathlib import Path
from threading import Lock
from typing import Any


class JsonlStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = Lock()

    def append(self, record: dict[str, Any]) -> None:
        line = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
        with self._lock:
            with self.path.open("a", encoding="utf-8") as f:
                f.write(line + "\n")

    def clear(self) -> None:
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text("", encoding="utf-8")

    def latest(self) -> dict[str, Any] | None:
        if not self.path.exists():
            return None
        with self._lock:
            with self.path.open("rb") as f:
                try:
                    f.seek(-1, 2)
                    while f.tell() > 0:
                        char = f.read(1)
                        if char == b"\n" and f.tell() != self.path.stat().st_size:
                            break
                        f.seek(-2, 1)
                except OSError:
                    f.seek(0)
                line = f.readline().decode("utf-8").strip()
        if not line:
            return None
        return json.loads(line)

    def read_tail(self, limit: int) -> list[dict[str, Any]]:
        if limit <= 0 or not self.path.exists():
            return []
        with self._lock:
            lines = self._read_tail_lines(limit)
        return [json.loads(line.decode("utf-8")) for line in lines if line.strip()]

    def _read_tail_lines(self, limit: int) -> list[bytes]:
        block_size = 8192
        with self.path.open("rb") as f:
            f.seek(0, 2)
            position = f.tell()
            buffer = b""
            while position > 0 and buffer.count(b"\n") <= limit:
                read_size = min(block_size, position)
                position -= read_size
                f.seek(position)
                buffer = f.read(read_size) + buffer
        return buffer.splitlines()[-limit:]
