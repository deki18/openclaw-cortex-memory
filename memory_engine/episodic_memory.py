import json
import logging
import os
import threading
import uuid
from datetime import datetime, timezone

logger = logging.getLogger(__name__)


class EpisodicMemory:
    def __init__(self, store_path=None):
        if store_path is None:
            from .config import get_openclaw_base_path
            base_path = get_openclaw_base_path()
            store_path = os.path.join(base_path, "episodic_memory.jsonl")
        self.store_path = os.path.expanduser(store_path)
        self._lock = threading.Lock()
        os.makedirs(os.path.dirname(self.store_path), exist_ok=True)

    def store_event(self, summary: str, entities: list = None, outcome: str = "", relations: list = None, source_file: str = ""):
        event = {
            "id": str(uuid.uuid4()),
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "summary": summary,
            "entities": entities or [],
            "outcome": outcome,
            "relations": relations or [],
            "source_file": source_file
        }
        
        with self._lock:
            try:
                with open(self.store_path, "a", encoding="utf-8") as f:
                    f.write(json.dumps(event, ensure_ascii=False) + "\n")
            except Exception as e:
                logger.error(f"Failed to store event: {e}")
                return None
            
        return event["id"]

    def load_events(self, limit=100):
        events = []
        if not os.path.exists(self.store_path):
            return events
        
        with self._lock:
            try:
                with open(self.store_path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line:
                            events.append(json.loads(line))
            except Exception as e:
                logger.error(f"Failed to load events: {e}")
                
        return events[-limit:]

    def get_event_by_id(self, event_id: str):
        if not os.path.exists(self.store_path):
            return None
        
        with self._lock:
            try:
                with open(self.store_path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line:
                            event = json.loads(line)
                            if event.get("id") == event_id:
                                return event
            except Exception as e:
                logger.error(f"Failed to get event by id: {e}")
        return None
