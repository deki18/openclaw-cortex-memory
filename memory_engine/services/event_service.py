import logging
from typing import List, Dict, Any, Optional

from .episodic_memory import EpisodicMemory
from .memory_graph import MemoryGraph

logger = logging.getLogger(__name__)


class MemoryEventService:
    def __init__(self, episodic_memory: EpisodicMemory = None, memory_graph: MemoryGraph = None):
        self.episodic = episodic_memory or EpisodicMemory()
        self.graph = memory_graph or MemoryGraph()

    def store_event(self, summary: str, entities: list = None, 
                    outcome: str = "", relations: list = None) -> Optional[str]:
        if not summary or not summary.strip():
            logger.warning("Empty summary provided, skipping event storage")
            return None

        try:
            event_id = self.episodic.store_event(summary, entities, outcome, relations)
            if not event_id:
                return None
                
            if entities:
                for entity in entities:
                    if isinstance(entity, dict):
                        node_id = entity.get("id") or entity.get("name")
                        node_type = entity.get("type") or "Person"
                        if node_id:
                            self.graph.add_node(node_id, node_type, entity.get("attributes"))
                    else:
                        self.graph.add_node(str(entity), "Person")
            
            if relations:
                for rel in relations:
                    if isinstance(rel, dict):
                        source = rel.get("source")
                        target = rel.get("target")
                        edge_type = rel.get("type")
                    else:
                        source, target, edge_type = rel
                    if source and target and edge_type:
                        self.graph.add_edge(source, target, edge_type)
            
            return event_id
        except Exception as e:
            logger.error(f"Failed to store event: {e}")
            return None

    def get_events(self, limit: int = 100) -> List[Dict[str, Any]]:
        try:
            return self.episodic.load_events(limit=limit)
        except Exception as e:
            logger.error(f"Failed to get events: {e}")
            return []

    def get_event_by_id(self, event_id: str) -> Optional[Dict[str, Any]]:
        try:
            return self.episodic.get_event_by_id(event_id)
        except Exception as e:
            logger.error(f"Failed to get event by id: {e}")
            return None

    def query_graph(self, entity: str) -> List[Dict[str, Any]]:
        try:
            return self.graph.query_entity(entity)
        except Exception as e:
            logger.error(f"Failed to query graph: {e}")
            return []
