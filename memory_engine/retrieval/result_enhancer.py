import logging
from typing import Any, Dict, List, Optional

from ..episodic_memory import EpisodicMemory
from ..models.episodic_event import EpisodicEvent

logger = logging.getLogger(__name__)


class ResultEnhancer:
    def __init__(
        self, 
        episodic_memory: EpisodicMemory = None,
        lancedb_store = None
    ):
        self.episodic = episodic_memory or EpisodicMemory()
        self.store = lancedb_store
    
    def enhance_result(self, item: Dict[str, Any]) -> Dict[str, Any]:
        if not item:
            return item
        
        enhanced = dict(item)
        
        is_episodic = item.get("metadata", {}).get("is_episodic_event", False)
        
        if is_episodic:
            enhanced = self._enhance_episodic_result(enhanced)
        else:
            enhanced = self._enhance_lancedb_result(enhanced)
        
        return enhanced
    
    def enhance_results(self, items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return [self.enhance_result(item) for item in items]
    
    def _enhance_episodic_result(self, item: Dict[str, Any]) -> Dict[str, Any]:
        memory_ids = item.get("metadata", {}).get("memory_ids", [])
        
        if not memory_ids or not self.store:
            return item
        
        detailed_memories = []
        for memory_id in memory_ids[:3]:
            try:
                memory = self._get_memory_by_id(memory_id)
                if memory:
                    detailed_memories.append({
                        "id": memory_id,
                        "text": memory.get("text", "")[:500],
                        "date": memory.get("date", ""),
                    })
            except Exception as e:
                logger.warning(f"Failed to get memory {memory_id}: {e}")
        
        if detailed_memories:
            item["detailed_memories"] = detailed_memories
        
        return item
    
    def _enhance_lancedb_result(self, item: Dict[str, Any]) -> Dict[str, Any]:
        memory_id = item.get("id")
        
        if not memory_id:
            return item
        
        try:
            events = self.episodic.get_events_by_memory_id(memory_id)
            
            if events:
                event_summaries = []
                for event in events[:2]:
                    event_summaries.append({
                        "id": event.id,
                        "summary": event.summary,
                        "cause": event.cause,
                        "solution": event.solution,
                        "outcome": event.outcome,
                        "date": event.date,
                    })
                
                item["related_events"] = event_summaries
        except Exception as e:
            logger.warning(f"Failed to get events for memory {memory_id}: {e}")
        
        return item
    
    def _get_memory_by_id(self, memory_id: str) -> Optional[Dict[str, Any]]:
        if not self.store:
            return None
        
        try:
            results = self.store.search(
                query_vector=None,
                query_text=memory_id,
                limit=1,
                query_type="fts"
            )
            
            if results:
                r = results[0]
                if hasattr(r, 'model_dump'):
                    return r.model_dump()
                return r
        except Exception as e:
            logger.warning(f"Failed to search memory: {e}")
        
        return None
    
    def get_event_context(self, event_id: str) -> Dict[str, Any]:
        event = self.episodic.get_episodic_event_by_id(event_id)
        
        if not event:
            return {}
        
        context = {
            "event": event.to_dict(),
            "detailed_memories": [],
        }
        
        if self.store and event.memory_ids:
            for memory_id in event.memory_ids[:3]:
                memory = self._get_memory_by_id(memory_id)
                if memory:
                    context["detailed_memories"].append({
                        "id": memory_id,
                        "text": memory.get("text", "")[:500],
                    })
        
        return context
    
    def build_timeline_view(
        self, 
        items: List[Dict[str, Any]], 
        start_date: str = None,
        end_date: str = None
    ) -> Dict[str, List[Dict[str, Any]]]:
        timeline = {}
        
        for item in items:
            date = item.get("metadata", {}).get("date", "")
            
            if not date:
                continue
            
            if start_date and end_date:
                if not (start_date <= date <= end_date):
                    continue
            
            if date not in timeline:
                timeline[date] = []
            
            timeline[date].append(item)
        
        return dict(sorted(timeline.items(), reverse=True))
    
    def build_cause_chain(self, event_id: str) -> List[Dict[str, Any]]:
        event = self.episodic.get_episodic_event_by_id(event_id)
        
        if not event:
            return []
        
        chain = [event.to_dict()]
        
        if event.entities and self.store:
            for entity in event.entities[:3]:
                related_events = self.episodic.get_events_by_entity(entity)
                for related_event in related_events[:2]:
                    if related_event.id != event_id:
                        chain.append({
                            "event": related_event.to_dict(),
                            "relation": f"shared_entity:{entity}",
                        })
        
        return chain
