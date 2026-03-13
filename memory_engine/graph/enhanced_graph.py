import json
import logging
import os
import threading
from collections import defaultdict
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set, Tuple

logger = logging.getLogger(__name__)


@dataclass
class GraphNode:
    id: str
    node_type: str
    name: str
    attributes: Dict[str, Any] = field(default_factory=dict)
    memory_ids: List[str] = field(default_factory=list)
    created_at: float = field(default_factory=lambda: datetime.now(timezone.utc).timestamp())


@dataclass
class GraphEdge:
    source_id: str
    target_id: str
    relation_type: str
    weight: float = 1.0
    attributes: Dict[str, Any] = field(default_factory=dict)
    evidence: List[str] = field(default_factory=list)


@dataclass
class GraphPath:
    nodes: List[GraphNode]
    edges: List[GraphEdge]
    total_weight: float
    length: int


class EnhancedMemoryGraph:
    def __init__(self, config: dict = None, graph_path: str = None):
        config = config or {}
        
        if graph_path is None:
            from ..config import get_openclaw_base_path
            base_path = get_openclaw_base_path()
            graph_path = os.path.join(base_path, "knowledge_graph.json")
        self.graph_path = os.path.expanduser(graph_path)
        
        self._nodes: Dict[str, GraphNode] = {}
        self._edges: Dict[Tuple[str, str], GraphEdge] = {}
        self._node_index: Dict[str, Set[str]] = defaultdict(set)
        self._type_index: Dict[str, Set[str]] = defaultdict(set)
        self._memory_index: Dict[str, Set[str]] = defaultdict(set)
        
        self._lock = threading.RLock()
        
        self.max_path_length = config.get("max_path_length", 5)
        self.min_edge_weight = config.get("min_edge_weight", 0.1)
        
        os.makedirs(os.path.dirname(self.graph_path), exist_ok=True)
        self._load()

    def add_node(
        self,
        node_id: str,
        node_type: str,
        name: str,
        attributes: dict = None,
        memory_id: str = None
    ) -> GraphNode:
        with self._lock:
            if node_id in self._nodes:
                node = self._nodes[node_id]
                if memory_id and memory_id not in node.memory_ids:
                    node.memory_ids.append(memory_id)
                if attributes:
                    node.attributes.update(attributes)
                self._save()
                return node
            
            node = GraphNode(
                id=node_id,
                node_type=node_type,
                name=name,
                attributes=attributes or {},
                memory_ids=[memory_id] if memory_id else []
            )
            
            self._nodes[node_id] = node
            self._type_index[node_type].add(node_id)
            
            name_lower = name.lower()
            self._node_index[name_lower].add(node_id)
            
            if memory_id:
                self._memory_index[memory_id].add(node_id)
            
            self._save()
            return node

    def add_edge(
        self,
        source_id: str,
        target_id: str,
        relation_type: str,
        weight: float = 1.0,
        attributes: dict = None,
        evidence: str = None
    ) -> Optional[GraphEdge]:
        with self._lock:
            if source_id not in self._nodes or target_id not in self._nodes:
                return None
            
            edge_key = (source_id, target_id)
            
            if edge_key in self._edges:
                edge = self._edges[edge_key]
                edge.weight = max(edge.weight, weight)
                if evidence and evidence not in edge.evidence:
                    edge.evidence.append(evidence)
                if attributes:
                    edge.attributes.update(attributes)
                self._save()
                return edge
            
            edge = GraphEdge(
                source_id=source_id,
                target_id=target_id,
                relation_type=relation_type,
                weight=weight,
                attributes=attributes or {},
                evidence=[evidence] if evidence else []
            )
            
            self._edges[edge_key] = edge
            self._save()
            return edge

    def get_node(self, node_id: str) -> Optional[GraphNode]:
        with self._lock:
            return self._nodes.get(node_id)

    def find_nodes_by_name(self, name: str, fuzzy: bool = True) -> List[GraphNode]:
        with self._lock:
            name_lower = name.lower()
            
            if not fuzzy:
                node_ids = self._node_index.get(name_lower, set())
                return [self._nodes[nid] for nid in node_ids if nid in self._nodes]
            
            results = []
            for node_name, node_ids in self._node_index.items():
                if name_lower in node_name or node_name in name_lower:
                    results.extend(
                        self._nodes[nid] for nid in node_ids 
                        if nid in self._nodes
                    )
            
            return results

    def get_nodes_by_type(self, node_type: str) -> List[GraphNode]:
        with self._lock:
            node_ids = self._type_index.get(node_type, set())
            return [self._nodes[nid] for nid in node_ids if nid in self._nodes]

    def get_connected_nodes(
        self,
        node_id: str,
        relation_type: str = None,
        direction: str = "both"
    ) -> List[Tuple[GraphNode, GraphEdge]]:
        with self._lock:
            if node_id not in self._nodes:
                return []
            
            results = []
            
            if direction in ("out", "both"):
                for (src, tgt), edge in self._edges.items():
                    if src == node_id:
                        if relation_type is None or edge.relation_type == relation_type:
                            if tgt in self._nodes:
                                results.append((self._nodes[tgt], edge))
            
            if direction in ("in", "both"):
                for (src, tgt), edge in self._edges.items():
                    if tgt == node_id:
                        if relation_type is None or edge.relation_type == relation_type:
                            if src in self._nodes:
                                results.append((self._nodes[src], edge))
            
            return results

    def find_path(
        self,
        source_id: str,
        target_id: str,
        max_length: int = None
    ) -> Optional[GraphPath]:
        max_length = max_length or self.max_path_length
        
        with self._lock:
            if source_id not in self._nodes or target_id not in self._nodes:
                return None
            
            if source_id == target_id:
                return GraphPath(
                    nodes=[self._nodes[source_id]],
                    edges=[],
                    total_weight=0.0,
                    length=0
                )
            
            visited = {source_id}
            queue = [(source_id, [self._nodes[source_id]], [], 0.0)]
            
            while queue:
                current_id, path_nodes, path_edges, total_weight = queue.pop(0)
                
                if len(path_nodes) > max_length:
                    continue
                
                neighbors = self.get_connected_nodes(current_id, direction="out")
                
                for neighbor, edge in neighbors:
                    if neighbor.id in visited:
                        continue
                    
                    new_weight = total_weight + edge.weight
                    new_nodes = path_nodes + [neighbor]
                    new_edges = path_edges + [edge]
                    
                    if neighbor.id == target_id:
                        return GraphPath(
                            nodes=new_nodes,
                            edges=new_edges,
                            total_weight=new_weight,
                            length=len(new_edges)
                        )
                    
                    visited.add(neighbor.id)
                    queue.append((neighbor.id, new_nodes, new_edges, new_weight))
            
            return None

    def find_all_paths(
        self,
        source_id: str,
        target_id: str,
        max_length: int = None,
        limit: int = 10
    ) -> List[GraphPath]:
        max_length = max_length or self.max_path_length
        
        with self._lock:
            if source_id not in self._nodes or target_id not in self._nodes:
                return []
            
            paths = []
            visited_edges = set()
            
            def dfs(current_id, path_nodes, path_edges, total_weight):
                if len(path_nodes) > max_length:
                    return
                
                if current_id == target_id and path_edges:
                    paths.append(GraphPath(
                        nodes=path_nodes.copy(),
                        edges=path_edges.copy(),
                        total_weight=total_weight,
                        length=len(path_edges)
                    ))
                    return
                
                neighbors = self.get_connected_nodes(current_id, direction="out")
                
                for neighbor, edge in neighbors:
                    edge_key = (edge.source_id, edge.target_id, edge.relation_type)
                    if edge_key in visited_edges:
                        continue
                    
                    if neighbor.id in [n.id for n in path_nodes]:
                        continue
                    
                    visited_edges.add(edge_key)
                    path_nodes.append(neighbor)
                    path_edges.append(edge)
                    
                    dfs(
                        neighbor.id,
                        path_nodes,
                        path_edges,
                        total_weight + edge.weight
                    )
                    
                    path_nodes.pop()
                    path_edges.pop()
                    visited_edges.remove(edge_key)
            
            dfs(source_id, [self._nodes[source_id]], [], 0.0)
            
            paths.sort(key=lambda p: p.total_weight, reverse=True)
            return paths[:limit]

    def get_node_context(self, node_id: str, depth: int = 2) -> Dict[str, Any]:
        with self._lock:
            node = self.get_node(node_id)
            if not node:
                return {}
            
            context = {
                "node": {
                    "id": node.id,
                    "type": node.node_type,
                    "name": node.name,
                    "attributes": node.attributes,
                    "memory_count": len(node.memory_ids)
                },
                "neighbors": [],
                "paths": []
            }
            
            neighbors = self.get_connected_nodes(node_id)
            for neighbor, edge in neighbors:
                context["neighbors"].append({
                    "node": {
                        "id": neighbor.id,
                        "type": neighbor.node_type,
                        "name": neighbor.name
                    },
                    "relation": edge.relation_type,
                    "weight": edge.weight
                })
            
            if depth >= 2:
                for neighbor, _ in neighbors[:5]:
                    second_neighbors = self.get_connected_nodes(neighbor.id)
                    for sn, se in second_neighbors[:3]:
                        if sn.id != node_id:
                            context["paths"].append({
                                "via": neighbor.name,
                                "to": sn.name,
                                "relation": se.relation_type
                            })
            
            return context

    def get_memories_for_node(self, node_id: str) -> List[str]:
        with self._lock:
            node = self._nodes.get(node_id)
            return node.memory_ids if node else []

    def get_nodes_for_memory(self, memory_id: str) -> List[GraphNode]:
        with self._lock:
            node_ids = self._memory_index.get(memory_id, set())
            return [self._nodes[nid] for nid in node_ids if nid in self._nodes]

    def link_memory_to_node(self, memory_id: str, node_id: str):
        with self._lock:
            if node_id in self._nodes:
                node = self._nodes[node_id]
                if memory_id not in node.memory_ids:
                    node.memory_ids.append(memory_id)
                self._memory_index[memory_id].add(node_id)

    def remove_node(self, node_id: str):
        with self._lock:
            if node_id not in self._nodes:
                return
            
            node = self._nodes[node_id]
            
            self._type_index[node.node_type].discard(node_id)
            self._node_index[node.name.lower()].discard(node_id)
            
            for memory_id in node.memory_ids:
                self._memory_index[memory_id].discard(node_id)
            
            edges_to_remove = [
                key for key in self._edges
                if key[0] == node_id or key[1] == node_id
            ]
            for key in edges_to_remove:
                del self._edges[key]
            
            del self._nodes[node_id]
            self._save()

    def _save(self):
        try:
            data = {
                "nodes": [
                    {
                        "id": node.id,
                        "node_type": node.node_type,
                        "name": node.name,
                        "attributes": node.attributes,
                        "memory_ids": node.memory_ids,
                        "created_at": node.created_at
                    }
                    for node in self._nodes.values()
                ],
                "edges": [
                    {
                        "source_id": edge.source_id,
                        "target_id": edge.target_id,
                        "relation_type": edge.relation_type,
                        "weight": edge.weight,
                        "attributes": edge.attributes,
                        "evidence": edge.evidence
                    }
                    for edge in self._edges.values()
                ]
            }
            
            temp_path = self.graph_path + ".tmp"
            with open(temp_path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            os.replace(temp_path, self.graph_path)
        except Exception as e:
            logger.error(f"Failed to save graph: {e}")

    def _load(self):
        if not os.path.exists(self.graph_path):
            return
        
        try:
            with open(self.graph_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            
            for node_data in data.get("nodes", []):
                node = GraphNode(
                    id=node_data["id"],
                    node_type=node_data["node_type"],
                    name=node_data["name"],
                    attributes=node_data.get("attributes", {}),
                    memory_ids=node_data.get("memory_ids", []),
                    created_at=node_data.get("created_at", datetime.now(timezone.utc).timestamp())
                )
                self._nodes[node.id] = node
                self._type_index[node.node_type].add(node.id)
                self._node_index[node.name.lower()].add(node.id)
                for memory_id in node.memory_ids:
                    self._memory_index[memory_id].add(node.id)
            
            for edge_data in data.get("edges", []):
                edge = GraphEdge(
                    source_id=edge_data["source_id"],
                    target_id=edge_data["target_id"],
                    relation_type=edge_data["relation_type"],
                    weight=edge_data.get("weight", 1.0),
                    attributes=edge_data.get("attributes", {}),
                    evidence=edge_data.get("evidence", [])
                )
                self._edges[(edge.source_id, edge.target_id)] = edge
            
            logger.info(f"Loaded graph with {len(self._nodes)} nodes and {len(self._edges)} edges")
        except Exception as e:
            logger.error(f"Failed to load graph: {e}")

    def clear(self):
        with self._lock:
            self._nodes.clear()
            self._edges.clear()
            self._node_index.clear()
            self._type_index.clear()
            self._memory_index.clear()
            self._save()

    def get_stats(self) -> Dict[str, Any]:
        with self._lock:
            type_counts = defaultdict(int)
            for node in self._nodes.values():
                type_counts[node.node_type] += 1
            
            relation_counts = defaultdict(int)
            for edge in self._edges.values():
                relation_counts[edge.relation_type] += 1
            
            return {
                "total_nodes": len(self._nodes),
                "total_edges": len(self._edges),
                "node_types": dict(type_counts),
                "relation_types": dict(relation_counts),
                "memory_links": len(self._memory_index)
            }


class GraphEnhancedRetriever:
    def __init__(self, graph: EnhancedMemoryGraph, store, config: dict = None):
        self.graph = graph
        self.store = store
        self.config = config or {}
        
        self.expansion_depth = self.config.get("expansion_depth", 2)
        self.max_expanded_nodes = self.config.get("max_expanded_nodes", 10)

    def retrieve_with_graph(
        self,
        query: str,
        entities: List[str],
        top_k: int = 10
    ) -> List[Dict[str, Any]]:
        results = []
        seen_memory_ids = set()
        
        for entity_name in entities[:5]:
            nodes = self.graph.find_nodes_by_name(entity_name)
            
            for node in nodes[:3]:
                memory_ids = self.graph.get_memories_for_node(node.id)
                
                for memory_id in memory_ids[:top_k // 2]:
                    if memory_id in seen_memory_ids:
                        continue
                    
                    memory = self.store.get_by_id(memory_id)
                    if memory:
                        m_dict = memory.model_dump() if hasattr(memory, 'model_dump') else memory
                        m_dict["graph_context"] = {
                            "entity": node.name,
                            "entity_type": node.node_type
                        }
                        results.append(m_dict)
                        seen_memory_ids.add(memory_id)
        
        if len(results) < top_k:
            for entity_name in entities[:3]:
                nodes = self.graph.find_nodes_by_name(entity_name)
                
                for node in nodes[:2]:
                    neighbors = self.graph.get_connected_nodes(node.id)
                    
                    for neighbor, edge in neighbors[:5]:
                        memory_ids = self.graph.get_memories_for_node(neighbor.id)
                        
                        for memory_id in memory_ids[:2]:
                            if memory_id in seen_memory_ids:
                                continue
                            
                            memory = self.store.get_by_id(memory_id)
                            if memory:
                                m_dict = memory.model_dump() if hasattr(memory, 'model_dump') else memory
                                m_dict["graph_context"] = {
                                    "entity": neighbor.name,
                                    "entity_type": neighbor.node_type,
                                    "via_relation": edge.relation_type,
                                    "via_entity": node.name
                                }
                                results.append(m_dict)
                                seen_memory_ids.add(memory_id)
        
        return results[:top_k]

    def expand_query_entities(
        self,
        entities: List[str],
        max_expansions: int = None
    ) -> List[str]:
        max_expansions = max_expansions or self.max_expanded_nodes
        expanded = set(entities)
        
        for entity in entities:
            nodes = self.graph.find_nodes_by_name(entity)
            
            for node in nodes[:2]:
                neighbors = self.graph.get_connected_nodes(node.id)
                
                for neighbor, edge in neighbors[:3]:
                    if edge.weight >= 0.5:
                        expanded.add(neighbor.name)
                        
                        if len(expanded) >= max_expansions:
                            return list(expanded)
        
        return list(expanded)

    def find_related_memories(
        self,
        memory_id: str,
        max_related: int = 5
    ) -> List[Dict[str, Any]]:
        nodes = self.graph.get_nodes_for_memory(memory_id)
        
        related = []
        seen_ids = {memory_id}
        
        for node in nodes:
            neighbors = self.graph.get_connected_nodes(node.id)
            
            for neighbor, edge in neighbors:
                neighbor_memories = self.graph.get_memories_for_node(neighbor.id)
                
                for related_id in neighbor_memories:
                    if related_id in seen_ids:
                        continue
                    
                    memory = self.store.get_by_id(related_id)
                    if memory:
                        m_dict = memory.model_dump() if hasattr(memory, 'model_dump') else memory
                        m_dict["relation"] = {
                            "via_node": node.name,
                            "relation_type": edge.relation_type,
                            "related_entity": neighbor.name
                        }
                        related.append(m_dict)
                        seen_ids.add(related_id)
                        
                        if len(related) >= max_related:
                            return related
        
        return related
