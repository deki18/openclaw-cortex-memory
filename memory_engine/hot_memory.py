import os
import json
from typing import List
from datetime import datetime

class HotMemory:
    def __init__(self, base_dir: str = "~/.openclaw"):
        self.base_dir = os.path.expanduser(base_dir)
        self.soul_path = os.path.join(self.base_dir, "workspace", "SOUL.md")
        self.local_soul_path = os.path.join(os.path.dirname(__file__), "..", "data", "memory", "SOUL.md")
        self.sessions_dir = os.path.join(self.base_dir, "agents", "main", "sessions")
        self.local_sessions_dir = os.path.join(os.path.dirname(__file__), "..", "data", "memory", "sessions", "active")

    def load_soul(self) -> str:
        for path in [self.soul_path, self.local_soul_path]:
            full_path = os.path.abspath(path)
            if os.path.exists(full_path):
                with open(full_path, "r", encoding="utf-8") as f:
                    return f.read()
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
        candidates.sort(key=lambda p: os.path.getmtime(p), reverse=True)
        return candidates

    def _read_last_lines(self, file_path: str, limit: int) -> List[str]:
        if not os.path.exists(file_path):
            return []
        lines = []
        with open(file_path, "r", encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                lines.append(line.strip())
        recent = lines[-limit:]
        results = []
        for line in recent:
            try:
                obj = json.loads(line)
                content = obj.get("content") or obj.get("text") or obj.get("message") or json.dumps(obj)
                results.append(content)
            except Exception:
                results.append(line)
        return results
