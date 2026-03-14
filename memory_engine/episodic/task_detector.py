import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


@dataclass
class TaskSegment:
    start_idx: int
    end_idx: int
    task_type: str
    summary: str
    user_intent: str
    agent_actions: List[str] = field(default_factory=list)
    memory_ids: List[str] = field(default_factory=list)
    is_complete: bool = False
    outcome_signal: str = ""
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "start_idx": self.start_idx,
            "end_idx": self.end_idx,
            "task_type": self.task_type,
            "summary": self.summary,
            "user_intent": self.user_intent,
            "agent_actions": self.agent_actions,
            "memory_ids": self.memory_ids,
            "is_complete": self.is_complete,
            "outcome_signal": self.outcome_signal,
        }


class TaskDetector:
    SUCCESS_SIGNALS = [
        r"成功[了\s]",
        r"完成[了\s]",
        r"好[了\s]",
        r"搞定[了\s]",
        r"可以[了\s]",
        r"没问题[了\s]",
        r"谢谢",
        r"感谢",
        r"太棒[了\s]",
        r"完美",
        r"解决了",
        r"修好了",
        r"配置好了",
        r"设置好了",
    ]
    
    FAILURE_SIGNALS = [
        r"失败[了\s]",
        r"不行",
        r"还是报错",
        r"还是不行",
        r"出错了",
        r"有问题",
        r"不对",
        r"错误",
        r"无法",
        r"没成功",
    ]
    
    TASK_START_PATTERNS = [
        (r"帮我(配置|设置|安装|部署)", "configuration"),
        (r"帮我(写|开发|实现|创建)", "development"),
        (r"(调试|debug|排查|修复)", "debugging"),
        (r"(查询|搜索|查找|找)", "query"),
        (r"(分析|评估|检查)", "analysis"),
        (r"(写|生成|创建).*(文档|报告|文章)", "writing"),
        (r"(发送|回复|联系)", "communication"),
        (r"(维护|更新|升级|清理)", "maintenance"),
        (r"(学习|了解|研究)", "learning"),
    ]
    
    def __init__(self):
        self._compile_patterns()
    
    def _compile_patterns(self):
        self._success_patterns = [re.compile(p, re.IGNORECASE) for p in self.SUCCESS_SIGNALS]
        self._failure_patterns = [re.compile(p, re.IGNORECASE) for p in self.FAILURE_SIGNALS]
        self._task_start_patterns = [
            (re.compile(p, re.IGNORECASE), t) for p, t in self.TASK_START_PATTERNS
        ]
    
    def detect_tasks(self, messages: List[Dict[str, Any]]) -> List[TaskSegment]:
        if not messages:
            return []
        
        tasks = []
        current_task = None
        
        for idx, msg in enumerate(messages):
            role = msg.get("role", "")
            content = msg.get("content", "")
            memory_id = msg.get("memory_id")
            
            if role == "user":
                task_type = self._detect_task_type(content)
                
                if current_task is None or self._is_new_task_start(content, current_task):
                    if current_task and current_task.is_complete:
                        current_task.end_idx = idx - 1
                        tasks.append(current_task)
                        current_task = None
                    
                    if current_task is None:
                        current_task = TaskSegment(
                            start_idx=idx,
                            end_idx=idx,
                            task_type=task_type,
                            summary="",
                            user_intent=content[:100],
                            is_complete=False,
                        )
                else:
                    if current_task:
                        current_task.end_idx = idx
                
                outcome = self._detect_outcome_signal(content)
                if outcome and current_task:
                    current_task.is_complete = True
                    current_task.outcome_signal = outcome
            
            elif role == "assistant" and current_task:
                current_task.end_idx = idx
                action_summary = content[:200] if len(content) > 200 else content
                current_task.agent_actions.append(action_summary)
                
                if memory_id and memory_id not in current_task.memory_ids:
                    current_task.memory_ids.append(memory_id)
        
        if current_task:
            current_task.end_idx = len(messages) - 1
            tasks.append(current_task)
        
        for task in tasks:
            task.summary = self._generate_task_summary(messages, task)
        
        return tasks
    
    def _detect_task_type(self, content: str) -> str:
        for pattern, task_type in self._task_start_patterns:
            if pattern.search(content):
                return task_type
        return "other"
    
    def _is_new_task_start(self, content: str, current_task: TaskSegment) -> bool:
        new_type = self._detect_task_type(content)
        if new_type != "other" and new_type != current_task.task_type:
            return True
        
        new_task_patterns = [
            r"^(另外|还有|对了|顺便)",
            r"帮我(再|重新)",
            r"现在(要|需要)",
        ]
        for pattern in new_task_patterns:
            if re.search(pattern, content, re.IGNORECASE):
                return True
        
        return False
    
    def _detect_outcome_signal(self, content: str) -> str:
        for pattern in self._success_patterns:
            if pattern.search(content):
                return "success"
        for pattern in self._failure_patterns:
            if pattern.search(content):
                return "failure"
        return ""
    
    def _generate_task_summary(self, messages: List[Dict], task: TaskSegment) -> str:
        user_messages = []
        for i in range(task.start_idx, min(task.end_idx + 1, len(messages))):
            msg = messages[i]
            if msg.get("role") == "user":
                user_messages.append(msg.get("content", ""))
        
        if user_messages:
            first_msg = user_messages[0]
            if len(first_msg) > 50:
                return first_msg[:50] + "..."
            return first_msg
        
        return "Unknown task"
    
    def detect_session_end(self, messages: List[Dict[str, Any]]) -> bool:
        if len(messages) < 2:
            return False
        
        last_user_msg = None
        for msg in reversed(messages):
            if msg.get("role") == "user":
                last_user_msg = msg.get("content", "")
                break
        
        if not last_user_msg:
            return False
        
        end_patterns = [
            r"^(好的|好|ok|okay|谢谢|感谢|再见|拜拜)",
            r"(就这样|先这样|暂时这样)",
        ]
        
        for pattern in end_patterns:
            if re.search(pattern, last_user_msg, re.IGNORECASE):
                return True
        
        return False
    
    def get_task_boundaries(self, messages: List[Dict[str, Any]]) -> List[Tuple[int, int, str]]:
        tasks = self.detect_tasks(messages)
        boundaries = []
        for task in tasks:
            boundaries.append((task.start_idx, task.end_idx, task.task_type))
        return boundaries
