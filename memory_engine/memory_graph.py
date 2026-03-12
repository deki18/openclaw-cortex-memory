import json
import logging
import os
import threading

import networkx as nx

logger = logging.getLogger(__name__)


class MemoryGraph:
    def __init__(self, graph_path="~/.openclaw/memory_graph.json"):
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
                
            neighbors = list(self.graph.successors(entity)) + list(self.graph.predecessors(entity))
            subgraph = self.graph.subgraph([entity] + neighbors)
            return nx.node_link_data(subgraph)

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
