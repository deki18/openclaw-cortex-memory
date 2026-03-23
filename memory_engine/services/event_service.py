import logging
from typing import List, Dict, Any, Optional

from ..episodic_memory import EpisodicMemory
from ..graph.enhanced_graph import EnhancedMemoryGraph

logger = logging.getLogger(__name__)


class MemoryEventService:
    def __init__(
        self, 
        episodic_memory: EpisodicMemory = None, 
        graph: EnhancedMemoryGraph = None
    ):
        self.episodic = episodic_memory or EpisodicMemory()
        self.graph = graph or EnhancedMemoryGraph()

    @staticmethod
    def _normalize_graph_node_type(raw_type: Optional[str]) -> str:
        if not raw_type:
            return "Concept"
        normalized = str(raw_type).strip().lower()
        type_mapping = {
            "person": "Person",
            "organization": "Organization",
            "project": "Project",
            "task": "Task",
            "goal": "Goal",
            "event": "Event",
            "location": "Location",
            "document": "Document",
            "message": "Message",
            "thread": "Thread",
            "note": "Note",
            "account": "Account",
            "device": "Device",
            "credential": "Credential",
            "concept": "Concept",
            "technology": "Technology",
            "topic": "Topic",
            "entity": "Concept",
            "other": "Concept",
        }
        return type_mapping.get(normalized, "Concept")

    def store_event(
        self, 
        summary: str, 
        memory_id: str = None,
        entities: list = None, 
        relations: list = None,
        outcome: str = ""
    ) -> Optional[str]:
        if not summary or not summary.strip():
            logger.warning("Empty summary provided, skipping event storage")
            return None

        try:
            entity_refs = []
            
            if entities:
                for entity in entities:
                    if isinstance(entity, dict):
                        node_id = entity.get("id") or entity.get("name")
                        node_name = entity.get("name", node_id)
                        node_type = self._normalize_graph_node_type(entity.get("type"))
                        attributes = entity.get("attributes")
                        
                        if node_id:
                            self.graph.add_node(
                                node_id=node_id,
                                node_type=node_type,
                                name=node_name,
                                attributes=attributes,
                                memory_id=memory_id
                            )
                            entity_refs.append(node_name)
                    else:
                        entity_name = str(entity)
                        self.graph.add_node(
                            node_id=entity_name,
                            node_type="Concept",
                            name=entity_name,
                            memory_id=memory_id
                        )
                        entity_refs.append(entity_name)
            
            if relations:
                for rel in relations:
                    if isinstance(rel, dict):
                        source = rel.get("source")
                        target = rel.get("target")
                        relation_type = rel.get("type") or rel.get("relation")
                        weight = rel.get("weight", 1.0)
                    else:
                        source, target, relation_type = rel
                        weight = 1.0
                    
                    if source and target and relation_type:
                        self.graph.add_edge(
                            source_id=source,
                            target_id=target,
                            relation_type=relation_type,
                            weight=weight,
                            evidence=memory_id
                        )
            
            event_id = self.episodic.store_event(
                summary=summary,
                memory_id=memory_id,
                entity_refs=entity_refs,
                outcome=outcome
            )
            
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
            nodes = self.graph.find_nodes_by_name(entity)
            results = []
            for node in nodes:
                neighbors = self.graph.get_connected_nodes(node.id)
                for neighbor, edge in neighbors:
                    results.append({
                        "source": node.name,
                        "target": neighbor.name,
                        "relation": edge.relation_type,
                        "weight": edge.weight
                    })
            return results
        except Exception as e:
            logger.error(f"Failed to query graph: {e}")
            return []

    def get_memories_for_entity(self, entity: str) -> List[str]:
        try:
            nodes = self.graph.find_nodes_by_name(entity)
            memory_ids = []
            for node in nodes:
                memory_ids.extend(self.graph.get_memories_for_node(node.id))
            return list(set(memory_ids))
        except Exception as e:
            logger.error(f"Failed to get memories for entity: {e}")
            return []

    def get_graph_stats(self) -> Dict[str, Any]:
        try:
            return self.graph.get_stats()
        except Exception as e:
            logger.error(f"Failed to get graph stats: {e}")
            return {}
