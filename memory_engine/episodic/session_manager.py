import logging
import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

from ..episodic_memory import EpisodicMemory
from ..models.episodic_event import SessionContext, EpisodicEvent
from ..episodic.task_detector import TaskDetector
from ..episodic.event_generator import EventGenerator

logger = logging.getLogger(__name__)


class SessionManager:
    def __init__(
        self,
        episodic_memory: EpisodicMemory = None,
        llm_client = None,
        on_session_end: Callable[[str], None] = None
    ):
        self.episodic = episodic_memory or EpisodicMemory()
        self.event_generator = EventGenerator(llm_client)
        self.task_detector = TaskDetector()
        
        self._sessions: Dict[str, SessionContext] = {}
        self._active_session_id: Optional[str] = None
        self._lock = threading.RLock()
        
        self._last_processed_index_by_session: Dict[str, int] = {}
        self._session_failures_by_session: Dict[str, List[EpisodicEvent]] = {}
        self._auto_reflect_enabled = True
        
        self.on_session_end = on_session_end
    
    def start_session(self, session_id: str = None) -> SessionContext:
        with self._lock:
            session_id = session_id or f"sess_{uuid.uuid4().hex[:12]}"
            existing = self._sessions.get(session_id)
            if existing:
                self._active_session_id = session_id
                return existing
            self._sessions[session_id] = SessionContext(
                session_id=session_id,
                start_time=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            )
            self._last_processed_index_by_session[session_id] = -1
            self._session_failures_by_session[session_id] = []
            self._active_session_id = session_id
            logger.info(f"Started new session: {session_id}")
            return self._sessions[session_id]
    
    def _resolve_session(self, session_id: str = None) -> SessionContext:
        target_session_id = session_id or self._active_session_id
        if target_session_id and target_session_id in self._sessions:
            return self._sessions[target_session_id]
        return self.start_session(target_session_id)
    
    def add_message(
        self, 
        role: str, 
        content: str, 
        memory_id: str = None,
        session_id: str = None
    ) -> Optional[str]:
        with self._lock:
            session = self._resolve_session(session_id)
            self._active_session_id = session.session_id
            session.add_message(role, content, memory_id)
            
            if self._should_trigger_event_generation(content, role):
                events = self._generate_event_for_current_task(session.session_id)
                if events:
                    self._store_events(events, session.session_id)
            
            if self._should_trigger_reflect(content, role):
                self._trigger_auto_reflect("User explicit feedback for reflection")
            
            return memory_id
    
    def set_last_message_memory_id(self, memory_id: str, session_id: str = None) -> bool:
        if not memory_id:
            return False
        with self._lock:
            session = self._resolve_session(session_id)
            if not session.messages:
                return False
            last_message = session.messages[-1]
            last_message["memory_id"] = memory_id
            if memory_id not in session.memory_ids:
                session.memory_ids.append(memory_id)
            return True
    
    def end_session(self, session_id: str = None) -> List[EpisodicEvent]:
        with self._lock:
            target_session_id = session_id or self._active_session_id
            return self._end_session_internal(target_session_id)
    
    def _end_session_internal(self, session_id: Optional[str]) -> List[EpisodicEvent]:
        if not session_id:
            return []
        session = self._sessions.get(session_id)
        if not session or not session.messages:
            self._sessions.pop(session_id, None)
            self._last_processed_index_by_session.pop(session_id, None)
            self._session_failures_by_session.pop(session_id, None)
            if self._active_session_id == session_id:
                self._active_session_id = None
            return []
        
        messages = session.messages
        last_processed_index = self._last_processed_index_by_session.get(session_id, -1)
        start_idx = last_processed_index + 1
        
        events = []
        
        if start_idx < len(messages):
            unprocessed_messages = messages[start_idx:]
            
            temp_session = SessionContext(
                session_id=session.session_id,
                start_time=session.start_time,
            )
            temp_session.messages = unprocessed_messages
            temp_session.memory_ids = session.memory_ids
            
            new_events = self.event_generator.generate_from_session(temp_session)
            
            for event in new_events:
                event.memory_ids = [
                    messages[start_idx + i].get("memory_id")
                    for i, _ in enumerate(unprocessed_messages)
                    if i < len(unprocessed_messages) and messages[start_idx + i].get("memory_id")
                ]
            
            events.extend(new_events)
        
        if events:
            self._store_events(events, session_id)
        
        total_messages = len(messages)
        processed_during_session = max(last_processed_index + 1, 0)
        processed_at_end = len(messages) - processed_during_session
        
        self._sessions.pop(session_id, None)
        self._last_processed_index_by_session.pop(session_id, None)
        self._session_failures_by_session.pop(session_id, None)
        if self._active_session_id == session_id:
            self._active_session_id = None
        
        logger.info(f"Ended session {session_id}: {total_messages} messages, {processed_during_session} processed during session, {processed_at_end} processed at end, {len(events)} events generated")
        
        if self.on_session_end:
            try:
                self.on_session_end(session_id)
            except Exception as e:
                logger.error(f"Error in on_session_end callback: {e}")
        
        return events
    
    def _should_trigger_event_generation(self, content: str, role: str) -> bool:
        if role != "user":
            return False
        
        SUCCESS_SIGNALS = [
            "成功了", "完成了", "好了", "搞定", "解决了",
            "没问题了", "可以了", "正常了", "修好了", "弄好了",
            "works", "worked", "solved", "fixed", "done", "success",
            "perfect", "great", "excellent", "awesome",
            "问题解决了", "问题修复了", "已经解决", "已经修复",
            "跑通了", "通过了", "成功了", "就这样吧",
        ]
        
        FAILURE_SIGNALS = [
            "失败了", "不行", "还是报错", "出错了", "有问题",
            "failed", "error", "bug", "crash", "broken", "issue",
            "还是不行", "又报错了", "又失败了", "没解决",
            "搞不定", "解决不了", "无法解决",
        ]
        
        GRATITUDE_SIGNALS = [
            "谢谢", "感谢", "多谢", "辛苦了", "麻烦你了",
            "thanks", "thank you", "thx", "appreciate",
        ]
        
        USER_EXPLICIT_SAVE_SIGNALS = [
            "记一下", "保存", "记录", "记住了", "记住这个",
            "帮我记", "帮我保存", "记下来", "写下来",
            "save this", "remember this", "note this", "keep this",
            "这个很重要", "重要信息", "关键信息",
        ]
        
        content_lower = content.lower()
        
        all_signals = SUCCESS_SIGNALS + FAILURE_SIGNALS + GRATITUDE_SIGNALS + USER_EXPLICIT_SAVE_SIGNALS
        return any(signal in content_lower for signal in all_signals)
    
    def _should_trigger_reflect(self, content: str, role: str) -> bool:
        if role != "user":
            return False
        
        REFLECT_SIGNALS = [
            "反思一下", "总结一下", "回顾一下", "整理一下",
            "帮我总结", "帮我反思", "帮我回顾",
            "reflect", "summarize", "review",
            "学到了什么", "有什么收获", "总结经验",
            "记住这个教训", "吸取教训", "下次注意",
            "这个很重要", "重要发现", "关键发现",
        ]
        
        content_lower = content.lower()
        return any(signal in content_lower for signal in REFLECT_SIGNALS)
    
    def _generate_event_for_current_task(self, session_id: str) -> List[EpisodicEvent]:
        session = self._sessions.get(session_id)
        if not session or not session.messages:
            return []
        
        messages = session.messages
        last_processed_index = self._last_processed_index_by_session.get(session_id, -1)
        start_idx = last_processed_index + 1
        
        if start_idx >= len(messages):
            return []
        
        unprocessed_messages = messages[start_idx:]
        tasks = self.task_detector.detect_tasks(unprocessed_messages)
        
        events = []
        max_processed_idx = last_processed_index
        
        for task in tasks:
            if task.is_complete:
                adjusted_task = self._adjust_task_indices(task, start_idx)
                event = self._create_event_from_task(adjusted_task, session_id)
                if event:
                    events.append(event)
                    max_processed_idx = max(max_processed_idx, adjusted_task.end_idx)
        
        if max_processed_idx > last_processed_index:
            self._last_processed_index_by_session[session_id] = max_processed_idx
            logger.debug(f"Updated last processed index to {max_processed_idx}")
        
        return events
    
    def _adjust_task_indices(self, task, offset: int):
        task.start_idx += offset
        task.end_idx += offset
        return task
    
    def _create_event_from_task(self, task, session_id: str) -> Optional[EpisodicEvent]:
        session = self._sessions.get(session_id)
        if not session:
            return None
        task_messages = session.messages[task.start_idx:task.end_idx + 1]
        
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
            session_id=session.session_id,
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
    
    def _store_events(self, events: List[EpisodicEvent], session_id: str) -> List[str]:
        stored_ids = self.episodic.store_events_batch(events)
        
        if not self._auto_reflect_enabled:
            return stored_ids
        
        should_reflect = False
        reflect_reason = ""
        session_failures = self._session_failures_by_session.setdefault(session_id, [])
        
        for event in events:
            if event.outcome == "failure":
                session_failures.append(event)
                logger.debug(f"Recorded failure event: {event.summary[:50]}")
            
            elif event.outcome == "success" and session_failures:
                related_failure = self._find_related_failure(event, session_id)
                if related_failure:
                    should_reflect = True
                    reflect_reason = f"Success after failure: '{related_failure.summary[:30]}...' -> '{event.summary[:30]}...'"
                    break
            
            if event.importance >= 4:
                should_reflect = True
                reflect_reason = f"High importance event: '{event.summary[:50]}...'"
                break
        
        if should_reflect:
            self._trigger_auto_reflect(reflect_reason)
        
        return stored_ids
    
    def _find_related_failure(self, success_event: EpisodicEvent, session_id: str) -> Optional[EpisodicEvent]:
        success_entities = set(success_event.entities or [])
        success_words = set(success_event.summary.lower().split())
        
        for failure in self._session_failures_by_session.get(session_id, []):
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
    
    def get_current_session(self, session_id: str = None) -> Optional[SessionContext]:
        with self._lock:
            target = session_id or self._active_session_id
            if not target:
                return None
            return self._sessions.get(target)
    
    def get_session_stats(self, session_id: str = None) -> Dict[str, Any]:
        with self._lock:
            session = self.get_current_session(session_id)
        if not session:
            return {"active": False}
        
        return {
            "active": True,
            "session_id": session.session_id,
            "start_time": session.start_time,
            "message_count": len(session.messages),
            "memory_count": len(session.memory_ids),
            "active_sessions": len(self._sessions),
        }
    
    def process_messages_batch(
        self, 
        messages: List[Dict[str, Any]], 
        session_id: str = None
    ) -> List[EpisodicEvent]:
        if not messages:
            return []
        
        events = self.event_generator.generate_from_messages(messages, session_id or "")
        
        if events:
            self._store_events(events, session_id or "batch")
        
        return events
