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
        
        events = self.event_generator.generate_from_session(self._current_session)
        
        if events:
            self._store_events(events)
        
        session_id = self._current_session.session_id
        self._current_session = None
        self._last_activity_time = None
        
        logger.info(f"Ended session {session_id}, generated {len(events)} events")
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
        tasks = self.task_detector.detect_tasks(messages)
        
        events = []
        for task in tasks:
            if task.is_complete:
                event = self._create_event_from_task(task)
                if event:
                    events.append(event)
        
        return events
    
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
        return self.episodic.store_events_batch(events)
    
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
