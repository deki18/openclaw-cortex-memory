import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Optional


class TaskType(Enum):
    CONFIGURATION = "configuration"
    DEVELOPMENT = "development"
    DEBUGGING = "debugging"
    QUERY = "query"
    ANALYSIS = "analysis"
    WRITING = "writing"
    COMMUNICATION = "communication"
    MAINTENANCE = "maintenance"
    LEARNING = "learning"
    OTHER = "other"


class TaskOutcome(Enum):
    SUCCESS = "success"
    FAILURE = "failure"
    PARTIAL = "partial"
    ABANDONED = "abandoned"
    ONGOING = "ongoing"


TASK_TYPE_LABELS = {
    TaskType.CONFIGURATION: "Configuration task",
    TaskType.DEVELOPMENT: "Development task",
    TaskType.DEBUGGING: "Debugging task",
    TaskType.QUERY: "Query task",
    TaskType.ANALYSIS: "Analysis task",
    TaskType.WRITING: "Writing task",
    TaskType.COMMUNICATION: "Communication task",
    TaskType.MAINTENANCE: "Maintenance task",
    TaskType.LEARNING: "Learning task",
    TaskType.OTHER: "Other task",
}

TASK_OUTCOME_LABELS = {
    TaskOutcome.SUCCESS: "Success",
    TaskOutcome.FAILURE: "Failure",
    TaskOutcome.PARTIAL: "Partial success",
    TaskOutcome.ABANDONED: "Abandoned",
    TaskOutcome.ONGOING: "Ongoing",
}


@dataclass
class EpisodicEvent:
    id: str
    timestamp: str
    date: str
    summary: str
    cause: str = ""
    solution: str = ""
    outcome: str = ""
    
    session_id: str = ""
    task_type: str = "other"
    memory_ids: List[str] = field(default_factory=list)
    entities: List[str] = field(default_factory=list)
    importance: int = 1
    
    start_time: str = ""
    end_time: str = ""
    duration_seconds: int = 0
    
    user_intent: str = ""
    agent_actions: List[str] = field(default_factory=list)
    
    def __post_init__(self):
        if not self.id:
            self.id = f"evt_{uuid.uuid4().hex[:12]}"
        if not self.timestamp:
            self.timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        if not self.date:
            self.date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "timestamp": self.timestamp,
            "date": self.date,
            "summary": self.summary,
            "cause": self.cause,
            "solution": self.solution,
            "outcome": self.outcome,
            "session_id": self.session_id,
            "task_type": self.task_type,
            "memory_ids": self.memory_ids,
            "entities": self.entities,
            "importance": self.importance,
            "start_time": self.start_time,
            "end_time": self.end_time,
            "duration_seconds": self.duration_seconds,
            "user_intent": self.user_intent,
            "agent_actions": self.agent_actions,
        }
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "EpisodicEvent":
        return cls(
            id=data.get("id", ""),
            timestamp=data.get("timestamp", ""),
            date=data.get("date", ""),
            summary=data.get("summary", ""),
            cause=data.get("cause", ""),
            solution=data.get("solution", ""),
            outcome=data.get("outcome", ""),
            session_id=data.get("session_id", ""),
            task_type=data.get("task_type", "other"),
            memory_ids=data.get("memory_ids", []),
            entities=data.get("entities", []),
            importance=data.get("importance", 1),
            start_time=data.get("start_time", ""),
            end_time=data.get("end_time", ""),
            duration_seconds=data.get("duration_seconds", 0),
            user_intent=data.get("user_intent", ""),
            agent_actions=data.get("agent_actions", []),
        )
    
    def get_search_text(self) -> str:
        parts = [self.summary]
        if self.cause:
            parts.append(self.cause)
        if self.solution:
            parts.append(self.solution)
        if self.outcome:
            parts.append(self.outcome)
        if self.entities:
            parts.extend(self.entities)
        return " ".join(parts)


@dataclass
class SessionContext:
    session_id: str
    start_time: str
    messages: List[Dict[str, Any]] = field(default_factory=list)
    memory_ids: List[str] = field(default_factory=list)
    
    def add_message(self, role: str, content: str, memory_id: str = None):
        message = {
            "role": role,
            "content": content,
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }
        if memory_id:
            message["memory_id"] = memory_id
            if memory_id not in self.memory_ids:
                self.memory_ids.append(memory_id)
        self.messages.append(message)
    
    def get_full_text(self) -> str:
        lines = []
        for msg in self.messages:
            role = msg.get("role", "unknown")
            content = msg.get("content", "")
            lines.append(f"[{role}]: {content}")
        return "\n".join(lines)
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "session_id": self.session_id,
            "start_time": self.start_time,
            "messages": self.messages,
            "memory_ids": self.memory_ids,
        }
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "SessionContext":
        return cls(
            session_id=data.get("session_id", ""),
            start_time=data.get("start_time", ""),
            messages=data.get("messages", []),
            memory_ids=data.get("memory_ids", []),
        )
