import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from ..episodic_memory import EpisodicMemory
from ..models.episodic_event import EpisodicEvent

logger = logging.getLogger(__name__)


@dataclass
class EpisodicSearchResult:
    event: EpisodicEvent
    score: float = 0.0
    match_type: str = "hybrid"
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.event.id,
            "summary": self.event.summary,
            "cause": self.event.cause,
            "solution": self.event.solution,
            "outcome": self.event.outcome,
            "date": self.event.date,
            "task_type": self.event.task_type,
            "entities": self.event.entities,
            "memory_ids": self.event.memory_ids,
            "importance": self.event.importance,
            "score": self.score,
            "match_type": self.match_type,
        }


class EpisodicSearcher:
    def __init__(self, episodic_memory: EpisodicMemory = None):
        self.episodic = episodic_memory or EpisodicMemory()
    
    def search(
        self,
        query: str,
        query_vector: List[float] = None,
        top_k: int = 20,
        filters: Dict[str, Any] = None,
        search_mode: str = "hybrid"
    ) -> List[EpisodicSearchResult]:
        if search_mode == "timeline":
            return self._search_timeline(filters, top_k)
        elif search_mode == "cause_solution":
            return self._search_cause_solution(query, filters, top_k)
        else:
            return self._search_hybrid(query, query_vector, filters, top_k)
    
    def _search_timeline(
        self, 
        filters: Dict[str, Any], 
        top_k: int
    ) -> List[EpisodicSearchResult]:
        results = []
        
        date_filter = filters.get("date", {}) if filters else {}
        
        if date_filter.get("type") == "range":
            start = date_filter.get("start", "")
            end = date_filter.get("end", "")
            events = self.episodic.get_events_by_date_range(start, end)
        else:
            events = self.episodic.load_episodic_events(limit=top_k * 2)
        
        events = self._apply_filters(events, filters)
        
        events.sort(key=lambda e: e.timestamp, reverse=True)
        
        for event in events[:top_k]:
            results.append(EpisodicSearchResult(
                event=event,
                score=1.0,
                match_type="timeline"
            ))
        
        return results
    
    def _search_cause_solution(
        self,
        query: str,
        filters: Dict[str, Any],
        top_k: int
    ) -> List[EpisodicSearchResult]:
        events = self.episodic.load_episodic_events(limit=500)
        events = self._apply_filters(events, filters)
        
        query_lower = query.lower()
        scored_events = []
        
        cause_keywords = ["原因", "为什么", "why", "cause", "reason", "失败"]
        solution_keywords = ["怎么解决", "如何解决", "解决方案", "how to", "solution", "fix"]
        
        is_cause_query = any(kw in query_lower for kw in cause_keywords)
        is_solution_query = any(kw in query_lower for kw in solution_keywords)
        
        for event in events:
            score = 0
            
            if is_cause_query and event.cause:
                if any(kw in event.cause.lower() for kw in query_lower.split()):
                    score += 10
                score += len(event.cause) / 100
            
            if is_solution_query and event.solution:
                if any(kw in event.solution.lower() for kw in query_lower.split()):
                    score += 10
                score += len(event.solution) / 100
            
            if event.outcome == "failure":
                score += 2
            
            if score > 0:
                scored_events.append((event, score))
        
        scored_events.sort(key=lambda x: x[1], reverse=True)
        
        results = []
        for event, score in scored_events[:top_k]:
            results.append(EpisodicSearchResult(
                event=event,
                score=min(score / 10, 1.0),
                match_type="cause_solution"
            ))
        
        return results
    
    def _search_hybrid(
        self,
        query: str,
        query_vector: List[float],
        filters: Dict[str, Any],
        top_k: int
    ) -> List[EpisodicSearchResult]:
        events = self.episodic.load_episodic_events(limit=500)
        events = self._apply_filters(events, filters)
        
        query_lower = query.lower()
        query_words = set(query_lower.split())
        
        scored_events = []
        
        for event in events:
            score = 0
            
            summary_lower = event.summary.lower()
            if query_lower in summary_lower:
                score += 10
            else:
                summary_words = set(summary_lower.split())
                overlap = len(query_words & summary_words)
                score += overlap * 2
            
            if event.cause:
                cause_lower = event.cause.lower()
                if query_lower in cause_lower:
                    score += 5
                else:
                    cause_words = set(cause_lower.split())
                    overlap = len(query_words & cause_words)
                    score += overlap
            
            if event.solution:
                solution_lower = event.solution.lower()
                if query_lower in solution_lower:
                    score += 5
                else:
                    solution_words = set(solution_lower.split())
                    overlap = len(query_words & solution_words)
                    score += overlap
            
            for entity in event.entities:
                if entity.lower() in query_lower:
                    score += 3
            
            recency_bonus = self._calculate_recency_bonus(event.date)
            score += recency_bonus
            
            importance_bonus = event.importance * 0.5
            score += importance_bonus
            
            if score > 0:
                scored_events.append((event, score))
        
        scored_events.sort(key=lambda x: x[1], reverse=True)
        
        results = []
        for event, score in scored_events[:top_k]:
            results.append(EpisodicSearchResult(
                event=event,
                score=min(score / 15, 1.0),
                match_type="hybrid"
            ))
        
        return results
    
    def _apply_filters(
        self, 
        events: List[EpisodicEvent], 
        filters: Dict[str, Any]
    ) -> List[EpisodicEvent]:
        if not filters:
            return events
        
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
        
        entity = filters.get("entity")
        if entity:
            entity_lower = entity.lower()
            result = [e for e in result if any(entity_lower in ent.lower() for ent in e.entities)]
        
        return result
    
    def _calculate_recency_bonus(self, date_str: str) -> float:
        if not date_str:
            return 0
        
        try:
            event_date = datetime.strptime(date_str, "%Y-%m-%d")
            now = datetime.now()
            days_diff = (now - event_date).days
            
            if days_diff <= 1:
                return 3.0
            elif days_diff <= 7:
                return 2.0
            elif days_diff <= 30:
                return 1.0
            elif days_diff <= 90:
                return 0.5
            else:
                return 0
        except Exception:
            return 0
    
    def get_timeline(
        self,
        start_date: str = None,
        end_date: str = None,
        limit: int = 100
    ) -> Dict[str, List[EpisodicSearchResult]]:
        timeline = self.episodic.get_timeline(start_date, end_date)
        
        result = {}
        for date, events in timeline.items():
            result[date] = [
                EpisodicSearchResult(event=event, score=1.0, match_type="timeline")
                for event in events[:limit]
            ]
        
        return result
    
    def get_related_events(
        self,
        memory_id: str,
        top_k: int = 10
    ) -> List[EpisodicSearchResult]:
        events = self.episodic.get_events_by_memory_id(memory_id)
        
        results = []
        for event in events[:top_k]:
            results.append(EpisodicSearchResult(
                event=event,
                score=0.9,
                match_type="memory_link"
            ))
        
        return results
