import json
import logging
import os
import threading
import uuid
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional

logger = logging.getLogger(__name__)


class EpisodicMemory:
    MAX_FILE_SIZE = 50 * 1024 * 1024
    MAX_EVENTS = 10000
    
    def __init__(self, store_path=None):
        if store_path is None:
            from .config import get_openclaw_base_path
            base_path = get_openclaw_base_path()
            store_path = os.path.join(base_path, "episodic_memory.jsonl")
        self.store_path = os.path.expanduser(store_path)
        self._lock = threading.RLock()
        self._write_buffer: List[Dict[str, Any]] = []
        self._buffer_size = 10
        os.makedirs(os.path.dirname(self.store_path), exist_ok=True)

    def store_event(
        self, 
        summary: str, 
        memory_id: str = None,
        entity_refs: list = None, 
        outcome: str = "", 
        source_file: str = ""
    ):
        if not summary or not summary.strip():
            logger.warning("Empty summary provided, skipping event storage")
            return None
            
        event = {
            "id": str(uuid.uuid4()),
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "summary": summary.strip(),
            "memory_id": memory_id,
            "entity_refs": entity_refs or [],
            "outcome": outcome,
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

    def load_events(self, limit=100) -> List[Dict[str, Any]]:
        events: List[Dict[str, Any]] = []
        if not os.path.exists(self.store_path):
            return events
        
        with self._lock:
            try:
                file_size = os.path.getsize(self.store_path)
                if file_size > self.MAX_FILE_SIZE:
                    logger.warning(f"Episodic memory file is large ({file_size} bytes), consider cleanup")
                
                with open(self.store_path, "r", encoding="utf-8") as f:
                    lines = f.readlines()
                    for line in lines[-limit * 2:]:
                        line = line.strip()
                        if line:
                            try:
                                events.append(json.loads(line))
                            except json.JSONDecodeError:
                                continue
            except Exception as e:
                logger.error(f"Failed to load events: {e}")
                
        return events[-limit:]

    def get_event_by_id(self, event_id: str) -> Optional[Dict[str, Any]]:
        if not event_id:
            return None
        if not os.path.exists(self.store_path):
            return None
        
        with self._lock:
            try:
                with open(self.store_path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line:
                            try:
                                event = json.loads(line)
                                if event.get("id") == event_id:
                                    return event
                            except json.JSONDecodeError:
                                continue
            except Exception as e:
                logger.error(f"Failed to get event by id: {e}")
        return None
    
    def count_events(self) -> int:
        if not os.path.exists(self.store_path):
            return 0
        count = 0
        with self._lock:
            try:
                with open(self.store_path, "r", encoding="utf-8") as f:
                    for _ in f:
                        count += 1
            except Exception as e:
                logger.error(f"Failed to count events: {e}")
        return count
    
    def cleanup_old_events(self, max_events: int = None) -> int:
        max_events = max_events or self.MAX_EVENTS
        if not os.path.exists(self.store_path):
            return 0
            
        with self._lock:
            try:
                with open(self.store_path, "r", encoding="utf-8") as f:
                    all_events = [line.strip() for line in f if line.strip()]
                
                if len(all_events) <= max_events:
                    return 0
                
                events_to_keep = all_events[-max_events:]
                temp_path = self.store_path + ".tmp"
                
                with open(temp_path, "w", encoding="utf-8") as f:
                    for event in events_to_keep:
                        f.write(event + "\n")
                
                os.replace(temp_path, self.store_path)
                removed_count = len(all_events) - max_events
                logger.info(f"Cleaned up {removed_count} old events")
                return removed_count
            except Exception as e:
                logger.error(f"Failed to cleanup old events: {e}")
                return 0
