import glob
import json
import logging
import os
from datetime import datetime, timezone
from typing import Dict, List

from .config import get_config
from .llm_client import LLMClient
from .metadata_schema import MemoryMetadata
from .semantic_memory import SemanticMemory

logger = logging.getLogger(__name__)


def _parse_timestamp(ts) -> str:
    if ts is None:
        return datetime.now(timezone.utc).strftime("%Y-%m-%d")
    try:
        if isinstance(ts, (int, float)):
            return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")
        if isinstance(ts, str):
            ts_clean = ts.replace("Z", "").replace("+00:00", "")
            if "T" in ts_clean:
                dt = datetime.fromisoformat(ts_clean)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return dt.strftime("%Y-%m-%d")
            return ts_clean[:10]
    except Exception:
        pass
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


class WritePipeline:
    def __init__(self, base_dir: str = None):
        self.semantic_memory = SemanticMemory()
        self.llm = LLMClient()
        config = get_config()
        if base_dir is None:
            from .config import get_openclaw_base_path
            base_dir = get_openclaw_base_path()
        self.base_dir = os.path.expanduser(base_dir)
        self.chunk_size = config.get("chunk", {}).get("size", 600)
        self.chunk_overlap = config.get("chunk", {}).get("overlap", 100)

    def process_sessions(self, sessions_file: str, archive_dir: str = None, daily_summary_dir: str = None, state_path: str = None):
        if not os.path.exists(sessions_file):
            logger.debug(f"Sessions file not found: {sessions_file}")
            return
            
        archive_dir = archive_dir or os.path.join(self.base_dir, "workspace", "memory", "sessions", "archive")
        daily_summary_dir = daily_summary_dir or os.path.join(self.base_dir, "workspace", "memory", "daily-summary")
        state_path = state_path or os.path.join(self.base_dir, "workspace", "memory", ".cortex_sync_state.json")
        
        os.makedirs(archive_dir, exist_ok=True)
        os.makedirs(daily_summary_dir, exist_ok=True)

        state = self._load_state(state_path)
        last_index = state.get(os.path.abspath(sessions_file), -1)
        new_items = []
        last_seen_idx = last_index

        try:
            with open(sessions_file, "r", encoding="utf-8") as f:
                for idx, line in enumerate(f):
                    if idx <= last_index:
                        continue
                    if not line.strip():
                        continue
                    try:
                        session = json.loads(line.strip())
                        content = self._extract_content(session)
                        if content:
                            new_items.append((self._extract_date(session), content, session))
                        last_seen_idx = idx
                    except json.JSONDecodeError as e:
                        logger.warning(f"Error parsing session line {idx}: {e}")
        except Exception as e:
            logger.error(f"Error reading sessions file: {e}")
            return

        if not new_items:
            logger.info(f"No new items to process in {sessions_file}")
            return

        logger.info(f"Processing {len(new_items)} new items from {sessions_file}")
        grouped = self._group_by_date(new_items)
        logger.info(f"Grouped into {len(grouped)} dates")
        
        for date_key, contents in grouped.items():
            combined = "\n".join(contents).strip()
            logger.info(f"Summarizing {len(contents)} items for date {date_key}")
            summary = self.llm.summarize(combined)
            if summary:
                self._write_daily_summary(daily_summary_dir, date_key, summary)
                self._chunk_and_store(summary, f"daily-summary:{date_key}")
                logger.info(f"Stored summary for {date_key}: {len(summary)} chars")

        self._archive_file(sessions_file, archive_dir)
        state[os.path.abspath(sessions_file)] = last_seen_idx
        self._save_state(state_path, state)

    def process_sessions_dir(self, sessions_dir: str, archive_dir: str = None, daily_summary_dir: str = None, state_path: str = None):
        if not os.path.isdir(sessions_dir):
            logger.debug(f"Sessions directory not found: {sessions_dir}")
            return
        for name in os.listdir(sessions_dir):
            if name.endswith(".jsonl"):
                self.process_sessions(
                    os.path.join(sessions_dir, name),
                    archive_dir=archive_dir,
                    daily_summary_dir=daily_summary_dir,
                    state_path=state_path
                )

    def _write_daily_summary(self, daily_summary_dir: str, date_key: str, summary: str):
        path = os.path.join(daily_summary_dir, f"{date_key}.md")
        try:
            with open(path, "a", encoding="utf-8") as f:
                f.write(summary.strip() + "\n")
        except Exception as e:
            logger.error(f"Failed to write daily summary: {e}")

    def _group_by_date(self, items: List[tuple]) -> Dict[str, List[str]]:
        grouped: Dict[str, List[str]] = {}
        for date_key, content, _ in items:
            grouped.setdefault(date_key, []).append(content)
        return grouped

    def _extract_content(self, session: Dict) -> str:
        content = (
            session.get("content") or 
            session.get("summary") or 
            session.get("text") or 
            session.get("message")
        )
        
        if content:
            return content
        
        messages = session.get("messages", [])
        if messages and isinstance(messages, list):
            parts = []
            for msg in messages:
                if isinstance(msg, dict):
                    role = msg.get("role", "")
                    text = msg.get("content", "")
                    if text and isinstance(text, str):
                        parts.append(f"[{role}]: {text}")
            if parts:
                return "\n".join(parts)
        
        if session:
            return json.dumps(session, ensure_ascii=False)
        
        return ""

    def _extract_date(self, session: Dict) -> str:
        ts = session.get("timestamp") or session.get("date") or session.get("created_at")
        return _parse_timestamp(ts)

    def _archive_file(self, sessions_file: str, archive_dir: str):
        try:
            name = os.path.basename(sessions_file)
            archive_path = os.path.join(archive_dir, name)
            if os.path.abspath(archive_path) != os.path.abspath(sessions_file):
                with open(sessions_file, "r", encoding="utf-8") as src, open(archive_path, "w", encoding="utf-8") as dst:
                    dst.write(src.read())
                logger.debug(f"Archived {sessions_file} to {archive_path}")
        except Exception as e:
            logger.error(f"Archive error: {e}")

    def _load_state(self, state_path: str) -> Dict:
        if os.path.exists(state_path):
            try:
                with open(state_path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception as e:
                logger.warning(f"Failed to load sync state: {e}")
        return {}

    def _save_state(self, state_path: str, state: Dict):
        try:
            os.makedirs(os.path.dirname(state_path), exist_ok=True)
            with open(state_path, "w", encoding="utf-8") as f:
                json.dump(state, f)
        except Exception as e:
            logger.error(f"Failed to save sync state: {e}")

    def _chunk_and_store(self, text: str, source: str):
        if not text or not text.strip():
            logger.warning(f"Empty text provided, skipping storage for source: {source}")
            return
        
        text = text.strip()
        min_chunk_size = 50
        if len(text) < min_chunk_size:
            meta = MemoryMetadata(
                type="daily_log",
                date=datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                agent="openclaw",
                source_file=source
            )
            try:
                self.semantic_memory.add_memory(text, meta)
                logger.debug(f"Stored small text as single chunk: {len(text)} chars")
            except Exception as e:
                logger.error(f"Failed to store chunk: {e}")
            return
        
        chunks = []
        start = 0
        size = self.chunk_size
        overlap = self.chunk_overlap
        while start < len(text):
            end = start + size
            chunk = text[start:end].strip()
            if chunk:
                chunks.append(chunk)
            start += max(size - overlap, 1)
        
        if not chunks:
            logger.warning(f"No valid chunks generated for source: {source}")
            return
            
        for chunk in chunks:
            if not chunk or len(chunk) < 10:
                continue
            meta = MemoryMetadata(
                type="daily_log",
                date=datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                agent="openclaw",
                source_file=source
            )
            try:
                self.semantic_memory.add_memory(chunk, meta)
            except Exception as e:
                logger.error(f"Failed to store chunk: {e}")
