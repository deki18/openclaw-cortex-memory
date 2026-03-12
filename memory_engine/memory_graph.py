import networkx as nx
import json
import os

class MemoryGraph:
    def __init__(self, graph_path="~/.openclaw/memory_graph.json"):
        self.graph_path = os.path.expanduser(graph_path)
        self.graph = nx.DiGraph()
        self._load()

    def _load(self):
        if os.path.exists(self.graph_path):
            try:
                with open(self.graph_path, "r") as f:
                    data = json.load(f)
                self.graph = nx.node_link_graph(data)
            except Exception as e:
                print(f"Failed to load graph: {e}")

    def _save(self):
        os.makedirs(os.path.dirname(self.graph_path), exist_ok=True)
        data = nx.node_link_data(self.graph)
        with open(self.graph_path, "w") as f:
            json.dump(data, f)

    def add_node(self, node_id: str, node_type: str, attributes: dict = None):
        """Node types: Person, Project, Technology, Error, Decision"""
        attrs = attributes or {}
        attrs["type"] = node_type
        self.graph.add_node(node_id, **attrs)
        self._save()

    def add_edge(self, source: str, target: str, edge_type: str, attributes: dict = None):
        """Edge types: uses, develops, causes, fixes"""
        attrs = attributes or {}
        attrs["type"] = edge_type
        self.graph.add_edge(source, target, **attrs)
        self._save()

    def query_entity(self, entity: str):
        if entity not in self.graph:
            return None
            
        neighbors = list(self.graph.successors(entity)) + list(self.graph.predecessors(entity))
        subgraph = self.graph.subgraph([entity] + neighbors)
        return nx.node_link_data(subgraph)
