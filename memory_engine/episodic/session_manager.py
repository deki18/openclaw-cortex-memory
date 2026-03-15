import logging
import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from ..episodic_memory import EpisodicMemory
from ..models.episodic_event import SessionContext, EpisodicEvent
from ..episodic.task_detector import TaskDetector
from ..episodic.event_generator import EventGenerator

logger = logging.getLogger(__name__)


class SessionManager:
    def __init__(
        self,
        episodic_memory: EpisodicMemory = None,
        llm_client = None
    ):
        self.episodic = episodic_memory or EpisodicMemory()
        self.event_generator = EventGenerator(llm_client)
        self.task_detector = TaskDetector()
        
        self._current_session: Optional[SessionContext] = None
        self._lock = threading.RLock()
        
        self._session_timeout_seconds = 1800
        self._last_activity_time = None
        self._last_processed_index = -1
        self._session_failures: List[EpisodicEvent] = []
        self._auto_reflect_enabled = True
    
    def start_session(self, session_id: str = None) -> SessionContext:
        with self._lock:
            if self._current_session and self._current_session.messages:
                self._end_session_internal()
            
            session_id = session_id or f"sess_{uuid.uuid4().hex[:12]}"
            
            self._current_session = SessionContext(
                session_id=session_id,
                start_time=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            )
            
            self._last_activity_time = datetime.now(timezone.utc)
            self._last_processed_index = -1
            self._session_failures = []
            
            logger.info(f"Started new session: {session_id}")
            return self._current_session
    
    def add_message(
        self, 
        role: str, 
        content: str, 
        memory_id: str = None
    ) -> Optional[str]:
        with self._lock:
            if not self._current_session:
                self.start_session()
            
            self._current_session.add_message(role, content, memory_id)
            self._last_activity_time = datetime.now(timezone.utc)
            
            if self._should_trigger_event_generation(content, role):
                events = self._generate_event_for_current_task()
                if events:
                    self._store_events(events)
            
            return memory_id
    
    def end_session(self) -> List[EpisodicEvent]:
        with self._lock:
            return self._end_session_internal()
    
    def _end_session_internal(self) -> List[EpisodicEvent]:
        if not self._current_session or not self._current_session.messages:
            return []
        
        messages = self._current_session.messages
        start_idx = self._last_processed_index + 1
        
        events = []
        
        if start_idx < len(messages):
            unprocessed_messages = messages[start_idx:]
            
            temp_session = SessionContext(
                session_id=self._current_session.session_id,
                start_time=self._current_session.start_time,
            )
            temp_session.messages = unprocessed_messages
            temp_session.memory_ids = self._current_session.memory_ids
            
            new_events = self.event_generator.generate_from_session(temp_session)
            
            for event in new_events:
                event.memory_ids = [
                    messages[start_idx + i].get("memory_id")
                    for i, m in enumerate(unprocessed_messages)
                    if i < len(unprocessed_messages) and messages[start_idx + i].get("memory_id")
                ]
            
            events.extend(new_events)
        
        if events:
            self._store_events(events)
        
        session_id = self._current_session.session_id
        total_messages = len(messages)
        processed_during_session = self._last_processed_index + 1
        processed_at_end = len(messages) - processed_during_session
        
        self._current_session = None
        self._last_activity_time = None
        self._last_processed_index = -1
        
        logger.info(f"Ended session {session_id}: {total_messages} messages, {processed_during_session} processed during session, {processed_at_end} processed at end, {len(events)} events generated")
        return events
    
    def _should_trigger_event_generation(self, content: str, role: str) -> bool:
        if role != "user":
            return False
        
        completion_signals = [
            "成功了", "完成了", "好了", "搞定",
            "失败了", "不行", "还是报错",
            "谢谢", "感谢",
        ]
        
        content_lower = content.lower()
        return any(signal in content_lower for signal in completion_signals)
    
    def _generate_event_for_current_task(self) -> List[EpisodicEvent]:
        if not self._current_session or not self._current_session.messages:
            return []
        
        messages = self._current_session.messages
        start_idx = self._last_processed_index + 1
        
        if start_idx >= len(messages):
            return []
        
        unprocessed_messages = messages[start_idx:]
        tasks = self.task_detector.detect_tasks(unprocessed_messages)
        
        events = []
        max_processed_idx = self._last_processed_index
        
        for task in tasks:
            if task.is_complete:
                adjusted_task = self._adjust_task_indices(task, start_idx)
                event = self._create_event_from_task(adjusted_task)
                if event:
                    events.append(event)
                    max_processed_idx = max(max_processed_idx, adjusted_task.end_idx)
        
        if max_processed_idx > self._last_processed_index:
            self._last_processed_index = max_processed_idx
            logger.debug(f"Updated last processed index to {max_processed_idx}")
        
        return events
    
    def _adjust_task_indices(self, task, offset: int):
        task.start_idx += offset
        task.end_idx += offset
        return task
    
    def _create_event_from_task(self, task) -> Optional[EpisodicEvent]:
        task_messages = self._current_session.messages[task.start_idx:task.end_idx + 1]
        
        extracted = self._extract_event_info(task_messages, task)
        
        from ..models.episodic_event import EpisodicEvent
        now = datetime.now(timezone.utc)
        
        return EpisodicEvent(
            id=f"evt_{uuid.uuid4().hex[:12]}",
            timestamp=now.isoformat().replace("+00:00", "Z"),
            date=now.strftime("%Y-%m-%d"),
            summary=extracted.get("summary", task.summary),
            cause=extracted.get("cause", ""),
            solution=extracted.get("solution", ""),
            outcome=extracted.get("outcome", "success" if task.outcome_signal == "success" else "failure"),
            session_id=self._current_session.session_id,
            task_type=task.task_type,
            memory_ids=task.memory_ids,
            entities=extracted.get("entities", []),
            importance=extracted.get("importance", 2),
            user_intent=task.user_intent[:200] if task.user_intent else "",
            agent_actions=task.agent_actions[:5] if task.agent_actions else [],
        )
    
    def _extract_event_info(self, messages: List[Dict], task) -> Dict[str, Any]:
        conversation = "\n".join([
            f"[{m.get('role', 'unknown')}]: {m.get('content', '')[:200]}"
            for m in messages
        ])
        
        extracted = self.event_generator._extract_with_llm(conversation)
        
        if not extracted:
            extracted = self.event_generator._extract_with_rules(messages, task)
        
        return extracted or {}
    
    def _store_events(self, events: List[EpisodicEvent]) -> List[str]:
        stored_ids = self.episodic.store_events_batch(events)
        
        if not self._auto_reflect_enabled:
            return stored_ids
        
        should_reflect = False
        reflect_reason = ""
        
        for event in events:
            if event.outcome == "failure":
                self._session_failures.append(event)
                logger.debug(f"Recorded failure event: {event.summary[:50]}")
            
            elif event.outcome == "success" and self._session_failures:
                related_failure = self._find_related_failure(event)
                if related_failure:
                    should_reflect = True
                    reflect_reason = f"Success after failure: '{related_failure.summary[:30]}...' -> '{event.summary[:30]}...'"
                    break
        
        if should_reflect:
            self._trigger_auto_reflect(reflect_reason)
        
        return stored_ids
    
    def _find_related_failure(self, success_event: EpisodicEvent) -> Optional[EpisodicEvent]:
        success_entities = set(success_event.entities or [])
        success_words = set(success_event.summary.lower().split())
        
        for failure in self._session_failures:
            failure_entities = set(failure.entities or [])
            if success_entities and failure_entities and success_entities & failure_entities:
                return failure
            
            failure_words = set(failure.summary.lower().split())
            common_words = success_words & failure_words
            meaningful_words = common_words - {"the", "a", "an", "is", "are", "was", "were", "to", "for", "and", "or", "in", "on", "at"}
            if len(meaningful_words) >= 2:
                return failure
        
        return None
    
    def _trigger_auto_reflect(self, reason: str):
        logger.info(f"Auto-reflect triggered: {reason}")
        try:
            from ..reflection_engine import ReflectionEngine
            engine = ReflectionEngine()
            engine.reflect()
            logger.info("Auto-reflect completed successfully")
        except Exception as e:
            logger.error(f"Auto-reflect failed: {e}")
    
    def get_current_session(self) -> Optional[SessionContext]:
        return self._current_session
    
    def get_session_stats(self) -> Dict[str, Any]:
        if not self._current_session:
            return {"active": False}
        
        return {
            "active": True,
            "session_id": self._current_session.session_id,
            "start_time": self._current_session.start_time,
            "message_count": len(self._current_session.messages),
            "memory_count": len(self._current_session.memory_ids),
        }
    
    def check_session_timeout(self) -> bool:
        if not self._last_activity_time or not self._current_session:
            return False
        
        elapsed = (datetime.now(timezone.utc) - self._last_activity_time).total_seconds()
        
        if elapsed > self._session_timeout_seconds:
            self.end_session()
            return True
        
        return False
    
    def process_messages_batch(
        self, 
        messages: List[Dict[str, Any]], 
        session_id: str = None
    ) -> List[EpisodicEvent]:
        if not messages:
            return []
        
        events = self.event_generator.generate_from_messages(messages, session_id or "")
        
        if events:
            self._store_events(events)
        
        return events
