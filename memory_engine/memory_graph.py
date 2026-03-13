import json
import logging
import os
import threading

import networkx as nx

logger = logging.getLogger(__name__)


class MemoryGraph:
    def __init__(self, graph_path=None):
        if graph_path is None:
            from .config import get_openclaw_base_path
            base_path = get_openclaw_base_path()
            graph_path = os.path.join(base_path, "memory_graph.json")
        self.graph_path = os.path.expanduser(graph_path)
        self.graph = nx.DiGraph()
        self._lock = threading.RLock()
        self._load()

    def _load(self):
        with self._lock:
            if os.path.exists(self.graph_path):
                try:
                    with open(self.graph_path, "r", encoding="utf-8") as f:
                        data = json.load(f)
                    self.graph = nx.node_link_graph(data)
                except Exception as e:
                    logger.error(f"Failed to load graph: {e}")

    def _save(self):
        with self._lock:
            os.makedirs(os.path.dirname(self.graph_path), exist_ok=True)
            try:
                data = nx.node_link_data(self.graph)
                with open(self.graph_path, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False)
            except Exception as e:
                logger.error(f"Failed to save graph: {e}")

    def add_node(self, node_id: str, node_type: str, attributes: dict = None):
        with self._lock:
            attrs = attributes or {}
            attrs["type"] = node_type
            self.graph.add_node(node_id, **attrs)
            self._save()

    def add_edge(self, source: str, target: str, edge_type: str, attributes: dict = None):
        with self._lock:
            attrs = attributes or {}
            attrs["type"] = edge_type
            self.graph.add_edge(source, target, **attrs)
            self._save()

    def query_entity(self, entity: str):
        with self._lock:
            if entity not in self.graph:
                return None
            
            node_data = dict(self.graph.nodes[entity])
            node_type = node_data.get("type", "unknown")
            
            relationships = []
            for _, target, edge_data in self.graph.out_edges(entity, data=True):
                target_type = self.graph.nodes[target].get("type", "unknown") if target in self.graph else "unknown"
                relationships.append({
                    "direction": "outgoing",
                    "target": target,
                    "target_type": target_type,
                    "relationship": edge_data.get("type", "related_to"),
                    "details": {k: v for k, v in edge_data.items() if k != "type"}
                })
            
            for source, _, edge_data in self.graph.in_edges(entity, data=True):
                source_type = self.graph.nodes[source].get("type", "unknown") if source in self.graph else "unknown"
                relationships.append({
                    "direction": "incoming",
                    "source": source,
                    "source_type": source_type,
                    "relationship": edge_data.get("type", "related_to"),
                    "details": {k: v for k, v in edge_data.items() if k != "type"}
                })
            
            return {
                "entity": entity,
                "type": node_type,
                "attributes": {k: v for k, v in node_data.items() if k != "type"},
                "relationships": relationships,
                "relationship_count": len(relationships)
            }

    def get_node(self, node_id: str):
        with self._lock:
            if node_id not in self.graph:
                return None
            return dict(self.graph.nodes[node_id])

    def get_edges(self, node_id: str = None):
        with self._lock:
            if node_id:
                if node_id not in self.graph:
                    return []
                out_edges = [(u, v, d) for u, v, d in self.graph.out_edges(node_id, data=True)]
                in_edges = [(u, v, d) for u, v, d in self.graph.in_edges(node_id, data=True)]
                return out_edges + in_edges
            return list(self.graph.edges(data=True))

    def delete_node(self, node_id: str):
        with self._lock:
            if node_id in self.graph:
                self.graph.remove_node(node_id)
                self._save()

    def delete_edge(self, source: str, target: str):
        with self._lock:
            if self.graph.has_edge(source, target):
                self.graph.remove_edge(source, target)
                self._save()
