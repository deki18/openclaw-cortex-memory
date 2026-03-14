import json
import logging
import os
import threading
import uuid
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional

from .models.episodic_event import EpisodicEvent, SessionContext

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
    ) -> Optional[str]:
        if not summary or not summary.strip():
            logger.warning("Empty summary provided, skipping event storage")
            return None
            
        event = {
            "id": f"evt_{uuid.uuid4().hex[:12]}",
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "summary": summary.strip(),
            "cause": "",
            "solution": "",
            "outcome": outcome,
            "session_id": "",
            "task_type": "other",
            "memory_ids": [memory_id] if memory_id else [],
            "entities": entity_refs or [],
            "importance": 2,
            "start_time": "",
            "end_time": "",
            "duration_seconds": 0,
            "user_intent": "",
            "agent_actions": [],
        }
        
        return self._save_event(event)

    def store_episodic_event(self, event: EpisodicEvent) -> Optional[str]:
        if not event or not event.summary:
            logger.warning("Invalid event provided, skipping storage")
            return None
        
        event_dict = event.to_dict()
        return self._save_event(event_dict)

    def store_events_batch(self, events: List[EpisodicEvent]) -> List[str]:
        stored_ids = []
        for event in events:
            event_id = self.store_episodic_event(event)
            if event_id:
                stored_ids.append(event_id)
        return stored_ids

    def _save_event(self, event_dict: Dict[str, Any]) -> Optional[str]:
        with self._lock:
            try:
                with open(self.store_path, "a", encoding="utf-8") as f:
                    f.write(json.dumps(event_dict, ensure_ascii=False) + "\n")
                return event_dict.get("id")
            except Exception as e:
                logger.error(f"Failed to store event: {e}")
                return None

    def load_events(self, limit: int = 100) -> List[Dict[str, Any]]:
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

    def load_episodic_events(self, limit: int = 100) -> List[EpisodicEvent]:
        raw_events = self.load_events(limit=limit)
        events = []
        for raw in raw_events:
            try:
                event = EpisodicEvent.from_dict(raw)
                events.append(event)
            except Exception as e:
                logger.warning(f"Failed to parse event: {e}")
        return events

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

    def get_episodic_event_by_id(self, event_id: str) -> Optional[EpisodicEvent]:
        raw = self.get_event_by_id(event_id)
        if raw:
            try:
                return EpisodicEvent.from_dict(raw)
            except Exception as e:
                logger.warning(f"Failed to parse event: {e}")
        return None
    
    def get_events_by_date(self, date: str) -> List[EpisodicEvent]:
        events = self.load_episodic_events(limit=1000)
        return [e for e in events if e.date == date]

    def get_events_by_date_range(self, start_date: str, end_date: str) -> List[EpisodicEvent]:
        events = self.load_episodic_events(limit=1000)
        return [e for e in events if start_date <= e.date <= end_date]

    def get_events_by_memory_id(self, memory_id: str) -> List[EpisodicEvent]:
        events = self.load_episodic_events(limit=1000)
        return [e for e in events if memory_id in e.memory_ids]

    def get_events_by_entity(self, entity: str) -> List[EpisodicEvent]:
        events = self.load_episodic_events(limit=1000)
        entity_lower = entity.lower()
        return [e for e in events if any(entity_lower in ent.lower() for ent in e.entities)]

    def search_events(
        self, 
        query: str, 
        limit: int = 20,
        filters: Dict[str, Any] = None
    ) -> List[EpisodicEvent]:
        events = self.load_episodic_events(limit=1000)
        
        if filters:
            events = self._apply_filters(events, filters)
        
        query_lower = query.lower()
        scored_events = []
        
        for event in events:
            score = 0
            search_text = event.get_search_text().lower()
            
            if query_lower in event.summary.lower():
                score += 10
            if query_lower in search_text:
                score += 5
            if query_lower in event.cause.lower():
                score += 3
            if query_lower in event.solution.lower():
                score += 3
            
            if score > 0:
                scored_events.append((event, score))
        
        scored_events.sort(key=lambda x: x[1], reverse=True)
        return [e[0] for e in scored_events[:limit]]

    def _apply_filters(self, events: List[EpisodicEvent], filters: Dict[str, Any]) -> List[EpisodicEvent]:
        result = events
        
        date_filter = filters.get("date")
        if date_filter:
            if date_filter.get("type") == "exact":
                exact_date = date_filter.get("value")
                result = [e for e in result if e.date == exact_date]
            elif date_filter.get("type") == "range":
                start = date_filter.get("start", "")
                end = date_filter.get("end", "")
                result = [e for e in result if start <= e.date <= end]
        
        task_type = filters.get("task_type")
        if task_type:
            result = [e for e in result if e.task_type == task_type]
        
        outcome = filters.get("outcome")
        if outcome:
            result = [e for e in result if e.outcome == outcome]
        
        min_importance = filters.get("min_importance")
        if min_importance:
            result = [e for e in result if e.importance >= min_importance]
        
        return result
    
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

    def get_timeline(self, start_date: str = None, end_date: str = None) -> Dict[str, List[EpisodicEvent]]:
        events = self.load_episodic_events(limit=1000)
        
        if start_date and end_date:
            events = [e for e in events if start_date <= e.date <= end_date]
        
        timeline = {}
        for event in events:
            if event.date not in timeline:
                timeline[event.date] = []
            timeline[event.date].append(event)
        
        return dict(sorted(timeline.items(), reverse=True))

    def get_stats(self) -> Dict[str, Any]:
        events = self.load_episodic_events(limit=10000)
        
        task_types = {}
        outcomes = {}
        importance_dist = {}
        
        for event in events:
            task_types[event.task_type] = task_types.get(event.task_type, 0) + 1
            outcomes[event.outcome] = outcomes.get(event.outcome, 0) + 1
            importance_dist[event.importance] = importance_dist.get(event.importance, 0) + 1
        
        return {
            "total_events": len(events),
            "task_types": task_types,
            "outcomes": outcomes,
            "importance_distribution": importance_dist,
        }
