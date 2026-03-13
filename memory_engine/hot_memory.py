import json
import logging
import os
from datetime import datetime
from typing import List

logger = logging.getLogger(__name__)


class HotMemory:
    def __init__(self, base_dir=None):
        if base_dir is None:
            from .config import get_openclaw_base_path
            base_dir = get_openclaw_base_path()
        self.base_dir = os.path.expanduser(base_dir)
        self.soul_path = os.path.join(self.base_dir, "workspace", "SOUL.md")
        self.local_soul_path = os.path.join(os.path.dirname(__file__), "..", "data", "memory", "SOUL.md")
        self.sessions_dir = os.path.join(self.base_dir, "agents", "main", "sessions")
        self.local_sessions_dir = os.path.join(os.path.dirname(__file__), "..", "data", "memory", "sessions", "active")

    def load_soul(self) -> str:
        for path in [self.soul_path, self.local_soul_path]:
            full_path = os.path.abspath(path)
            if os.path.exists(full_path):
                try:
                    with open(full_path, "r", encoding="utf-8") as f:
                        return f.read()
                except Exception as e:
                    logger.warning(f"Failed to load SOUL.md from {full_path}: {e}")
        return ""

    def load_recent_sessions(self, limit: int = 20) -> List[str]:
        files = self._latest_session_files()
        items = []
        for file_path in files:
            items.extend(self._read_last_lines(file_path, limit))
            if len(items) >= limit:
                break
        return items[:limit]

    def build_hot_context(self, limit: int = 20) -> str:
        soul = self.load_soul().strip()
        recent = self.load_recent_sessions(limit)
        recent_text = "\n".join(recent).strip()
        parts = [p for p in [soul, recent_text] if p]
        return "\n\n".join(parts)

    def _latest_session_files(self) -> List[str]:
        candidates = []
        for base in [self.sessions_dir, self.local_sessions_dir]:
            base_path = os.path.abspath(base)
            if os.path.isdir(base_path):
                for name in os.listdir(base_path):
                    if name.endswith(".jsonl"):
                        candidates.append(os.path.join(base_path, name))
        try:
            candidates.sort(key=lambda p: os.path.getmtime(p), reverse=True)
        except Exception as e:
            logger.warning(f"Failed to sort session files: {e}")
        return candidates

    def _read_last_lines(self, file_path: str, limit: int) -> List[str]:
        if not os.path.exists(file_path):
            return []
        collected: List[str] = []
        try:
            with open(file_path, "rb") as f:
                f.seek(0, os.SEEK_END)
                position = f.tell()
                buffer = b""
                while position > 0 and len(collected) < limit:
                    read_size = min(4096, position)
                    position -= read_size
                    f.seek(position)
                    chunk = f.read(read_size)
                    buffer = chunk + buffer
                    parts = buffer.split(b"\n")
                    buffer = parts[0]
                    for line in reversed(parts[1:]):
                        if len(collected) >= limit:
                            break
                        if line.strip():
                            collected.append(line.decode("utf-8", errors="ignore").strip())
                if buffer.strip() and len(collected) < limit:
                    collected.append(buffer.decode("utf-8", errors="ignore").strip())
        except Exception as e:
            logger.warning(f"Failed to read session file {file_path}: {e}")
            return []

        recent = list(reversed(collected))
        results = []
        for line in recent:
            try:
                obj = json.loads(line)
                content = obj.get("content") or obj.get("text") or obj.get("message") or json.dumps(obj)
                results.append(content)
            except json.JSONDecodeError:
                results.append(line)
        return results
