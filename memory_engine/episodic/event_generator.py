import json
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from ..llm_client import LLMClient
from ..models.episodic_event import EpisodicEvent, SessionContext, TaskType, TaskOutcome
from .task_detector import TaskDetector, TaskSegment

logger = logging.getLogger(__name__)


class EventGenerator:
    EXTRACTION_PROMPT = """Analyze the following conversation segment and extract event information.

Conversation:
{conversation}

Please extract and return a JSON object with the following fields:
1. summary: A one-sentence summary of what the task was (e.g., "Configure Cloudflare DNS")
2. cause: If there was a problem or failure, what caused it (e.g., "CloudNS configuration error")
3. solution: How the problem was solved (e.g., "Reset NS settings")
4. outcome: Final result - one of: "success", "failure", "partial", "abandoned"
5. entities: List of key entities mentioned (e.g., ["Cloudflare", "DNS", "Nameserver"])
6. importance: Importance level 1-5 (5 being most important)

Return ONLY valid JSON, no other text.
Example output:
{{"summary": "Configure Cloudflare DNS", "cause": "CloudNS configuration error", "solution": "Reset NS settings", "outcome": "success", "entities": ["Cloudflare", "DNS"], "importance": 3}}"""
    
    def __init__(self, llm_client: LLMClient = None):
        self.llm_client = llm_client or LLMClient()
        self.task_detector = TaskDetector()
    
    def generate_from_session(self, session: SessionContext) -> List[EpisodicEvent]:
        if not session.messages:
            return []
        
        tasks = self.task_detector.detect_tasks(session.messages)
        events = []
        
        for task in tasks:
            event = self._generate_event_from_task(session, task)
            if event:
                events.append(event)
        
        return events
    
    def generate_from_messages(
        self, 
        messages: List[Dict[str, Any]], 
        session_id: str = ""
    ) -> List[EpisodicEvent]:
        if not messages:
            return []
        
        tasks = self.task_detector.detect_tasks(messages)
        events = []
        
        for task in tasks:
            event = self._generate_event_from_messages(messages, task, session_id)
            if event:
                events.append(event)
        
        return events
    
    def generate_single_event(
        self,
        summary: str,
        cause: str = "",
        solution: str = "",
        outcome: str = "",
        session_id: str = "",
        memory_ids: List[str] = None,
        entities: List[str] = None,
        task_type: str = "other"
    ) -> EpisodicEvent:
        now = datetime.now(timezone.utc)
        
        return EpisodicEvent(
            id=f"evt_{uuid.uuid4().hex[:12]}",
            timestamp=now.isoformat().replace("+00:00", "Z"),
            date=now.strftime("%Y-%m-%d"),
            summary=summary,
            cause=cause,
            solution=solution,
            outcome=outcome,
            session_id=session_id,
            task_type=task_type,
            memory_ids=memory_ids or [],
            entities=entities or [],
            importance=self._calculate_importance(summary, cause, solution),
        )
    
    def _generate_event_from_task(
        self, 
        session: SessionContext, 
        task: TaskSegment
    ) -> Optional[EpisodicEvent]:
        task_messages = session.messages[task.start_idx:task.end_idx + 1]
        conversation = self._format_conversation(task_messages)
        
        extracted = self._extract_with_llm(conversation)
        
        if not extracted:
            extracted = self._extract_with_rules(task_messages, task)
        
        now = datetime.now(timezone.utc)
        
        return EpisodicEvent(
            id=f"evt_{uuid.uuid4().hex[:12]}",
            timestamp=now.isoformat().replace("+00:00", "Z"),
            date=now.strftime("%Y-%m-%d"),
            summary=extracted.get("summary", task.summary),
            cause=extracted.get("cause", ""),
            solution=extracted.get("solution", ""),
            outcome=extracted.get("outcome", self._outcome_to_string(task.outcome_signal)),
            session_id=session.session_id,
            task_type=task.task_type,
            memory_ids=task.memory_ids,
            entities=extracted.get("entities", []),
            importance=extracted.get("importance", 2),
            user_intent=task.user_intent[:200] if task.user_intent else "",
            agent_actions=task.agent_actions[:5] if task.agent_actions else [],
        )
    
    def _generate_event_from_messages(
        self,
        messages: List[Dict[str, Any]],
        task: TaskSegment,
        session_id: str
    ) -> Optional[EpisodicEvent]:
        task_messages = messages[task.start_idx:task.end_idx + 1]
        conversation = self._format_conversation(task_messages)
        
        extracted = self._extract_with_llm(conversation)
        
        if not extracted:
            extracted = self._extract_with_rules(task_messages, task)
        
        now = datetime.now(timezone.utc)
        
        return EpisodicEvent(
            id=f"evt_{uuid.uuid4().hex[:12]}",
            timestamp=now.isoformat().replace("+00:00", "Z"),
            date=now.strftime("%Y-%m-%d"),
            summary=extracted.get("summary", task.summary),
            cause=extracted.get("cause", ""),
            solution=extracted.get("solution", ""),
            outcome=extracted.get("outcome", self._outcome_to_string(task.outcome_signal)),
            session_id=session_id,
            task_type=task.task_type,
            memory_ids=task.memory_ids,
            entities=extracted.get("entities", []),
            importance=extracted.get("importance", 2),
            user_intent=task.user_intent[:200] if task.user_intent else "",
            agent_actions=task.agent_actions[:5] if task.agent_actions else [],
        )
    
    def _format_conversation(self, messages: List[Dict]) -> str:
        lines = []
        for msg in messages:
            role = msg.get("role", "unknown")
            content = msg.get("content", "")
            if len(content) > 500:
                content = content[:500] + "..."
            lines.append(f"[{role}]: {content}")
        return "\n".join(lines)
    
    def _extract_with_llm(self, conversation: str) -> Optional[Dict[str, Any]]:
        if not self.llm_client.is_available():
            return None
        
        try:
            prompt = self.EXTRACTION_PROMPT.format(conversation=conversation)
            response = self.llm_client.client.chat.completions.create(
                model=self.llm_client.model,
                messages=[
                    {"role": "system", "content": "You are an event extraction assistant. Extract structured event information from conversations."},
                    {"role": "user", "content": prompt}
                ],
                temperature=0.2,
                max_tokens=500
            )
            
            content = response.choices[0].message.content.strip()
            
            json_match = re.search(r'\{[^{}]*\}', content, re.DOTALL)
            if json_match:
                return json.loads(json_match.group())
            
            return None
        except Exception as e:
            logger.warning(f"LLM extraction failed: {e}")
            return None
    
    def _extract_with_rules(self, messages: List[Dict], task: TaskSegment) -> Dict[str, Any]:
        result = {
            "summary": task.summary,
            "cause": "",
            "solution": "",
            "outcome": self._outcome_to_string(task.outcome_signal),
            "entities": [],
            "importance": 2
        }
        
        entities = set()
        for msg in messages:
            content = msg.get("content", "")
            
            tech_terms = re.findall(r'\b[A-Z][a-zA-Z]+\b', content)
            entities.update(tech_terms[:3])
        
        result["entities"] = list(entities)[:5]
        
        if task.outcome_signal == "success":
            result["importance"] = 2
        elif task.outcome_signal == "failure":
            result["importance"] = 4
            result["cause"] = "Unknown cause"
        
        return result
    
    def _outcome_to_string(self, outcome_signal: str) -> str:
        mapping = {
            "success": "success",
            "failure": "failure",
            "": "ongoing"
        }
        return mapping.get(outcome_signal, "ongoing")
    
    def _calculate_importance(self, summary: str, cause: str, solution: str) -> int:
        importance = 2
        
        if cause and solution:
            importance += 1
        
        important_keywords = ["配置", "部署", "修复", "调试", "安装", "configure", "deploy", "fix", "debug", "install"]
        summary_lower = summary.lower()
        for keyword in important_keywords:
            if keyword in summary_lower:
                importance += 1
                break
        
        return min(importance, 5)
