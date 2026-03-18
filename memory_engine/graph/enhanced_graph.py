import json
import logging
import os
import threading
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

logger = logging.getLogger(__name__)

SCHEMA_PATH = os.path.join(os.path.dirname(__file__), "schema.yaml")


@dataclass
class GraphNode:
    id: str
    node_type: str
    name: str
    attributes: Dict[str, Any] = field(default_factory=dict)
    memory_ids: List[str] = field(default_factory=list)
    created_at: float = field(default_factory=lambda: datetime.now(timezone.utc).timestamp())
    updated_at: float = field(default_factory=lambda: datetime.now(timezone.utc).timestamp())

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "node_type": self.node_type,
            "name": self.name,
            "attributes": self.attributes,
            "memory_ids": self.memory_ids,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "GraphNode":
        return cls(
            id=data.get("id", ""),
            node_type=data.get("node_type", ""),
            name=data.get("name", ""),
            attributes=data.get("attributes", {}),
            memory_ids=data.get("memory_ids", []),
            created_at=data.get("created_at", datetime.now(timezone.utc).timestamp()),
            updated_at=data.get("updated_at", datetime.now(timezone.utc).timestamp()),
        )

    def validate(self, type_schema: Dict[str, Any]) -> List[str]:
        errors = []
        
        required = type_schema.get("required", [])
        for prop in required:
            if prop not in self.attributes and not (prop == "name" and self.name):
                errors.append(f"Missing required property: {prop}")
        
        forbidden = type_schema.get("forbidden_properties", [])
        for prop in forbidden:
            if prop in self.attributes:
                errors.append(f"Forbidden property found: {prop}")
        
        for key, value in self.attributes.items():
            enum_key = f"{key}_enum"
            if enum_key in type_schema:
                allowed = type_schema[enum_key]
                if value not in allowed:
                    errors.append(f"Invalid enum value for '{key}': {value}, allowed: {allowed}")
        
        return errors


@dataclass
class GraphEdge:
    source_id: str
    target_id: str
    relation_type: str
    weight: float = 1.0
    attributes: Dict[str, Any] = field(default_factory=dict)
    evidence: List[str] = field(default_factory=list)
    created_at: float = field(default_factory=lambda: datetime.now(timezone.utc).timestamp())

    def to_dict(self) -> Dict[str, Any]:
        return {
            "source_id": self.source_id,
            "target_id": self.target_id,
            "relation_type": self.relation_type,
            "weight": self.weight,
            "attributes": self.attributes,
            "evidence": self.evidence,
            "created_at": self.created_at,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "GraphEdge":
        return cls(
            source_id=data.get("source_id", ""),
            target_id=data.get("target_id", ""),
            relation_type=data.get("relation_type", ""),
            weight=data.get("weight", 1.0),
            attributes=data.get("attributes", {}),
            evidence=data.get("evidence", []),
            created_at=data.get("created_at", datetime.now(timezone.utc).timestamp()),
        )


@dataclass
class GraphPath:
    nodes: List[GraphNode]
    edges: List[GraphEdge]
    total_weight: float
    length: int


@dataclass
class ValidationResult:
    valid: bool
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)


class SchemaManager:
    def __init__(self, schema_path: str = None):
        self.schema_path = schema_path or SCHEMA_PATH
        self._schema: Dict[str, Any] = {}
        self._load_schema()

    def _load_schema(self):
        if not os.path.exists(self.schema_path):
            logger.warning(f"Schema file not found: {self.schema_path}")
            return
        
        try:
            import yaml
            with open(self.schema_path, "r", encoding="utf-8") as f:
                self._schema = yaml.safe_load(f) or {}
            logger.info(f"Loaded schema with {len(self._schema.get('types', {}))} types and {len(self._schema.get('relations', {}))} relations")
        except Exception as e:
            logger.error(f"Failed to load schema: {e}")

    def get_type_schema(self, type_name: str) -> Dict[str, Any]:
        return self._schema.get("types", {}).get(type_name, {})

    def get_relation_schema(self, relation_type: str) -> Dict[str, Any]:
        return self._schema.get("relations", {}).get(relation_type, {})

    def get_all_types(self) -> List[str]:
        return list(self._schema.get("types", {}).keys())

    def get_all_relations(self) -> List[str]:
        return list(self._schema.get("relations", {}).keys())

    def is_valid_type(self, type_name: str) -> bool:
        return type_name in self._schema.get("types", {})

    def is_valid_relation(self, relation_type: str) -> bool:
        return relation_type in self._schema.get("relations", {})

    def validate_node_type(self, type_name: str) -> List[str]:
        if not self.is_valid_type(type_name):
            known = self.get_all_types()
            return [f"Unknown type: '{type_name}'. Known types: {known[:10]}..."]
        return []

    def validate_relation_type(self, relation_type: str) -> List[str]:
        if not self.is_valid_relation(relation_type):
            known = self.get_all_relations()
            return [f"Unknown relation: '{relation_type}'. Known relations: {known[:10]}..."]
        return []


class EnhancedMemoryGraph:
    def __init__(self, config: dict = None, graph_path: str = None):
        config = config or {}
        
        if graph_path is None:
            from ..config import get_openclaw_base_path
            base_path = get_openclaw_base_path()
            graph_path = os.path.join(base_path, "knowledge_graph.jsonl")
        self.graph_path = os.path.expanduser(graph_path)
        
        self._nodes: Dict[str, GraphNode] = {}
        self._edges: Dict[Tuple[str, str, str], GraphEdge] = {}
        self._node_index: Dict[str, Set[str]] = defaultdict(set)
        self._type_index: Dict[str, Set[str]] = defaultdict(set)
        self._memory_index: Dict[str, Set[str]] = defaultdict(set)
        self._edge_index: Dict[str, Set[Tuple[str, str, str]]] = defaultdict(set)
        
        self._lock = threading.RLock()
        
        self.max_path_length = config.get("max_path_length", 5)
        self.min_edge_weight = config.get("min_edge_weight", 0.1)
        self.enable_validation = config.get("enable_validation", True)
        
        self.schema = SchemaManager()
        
        os.makedirs(os.path.dirname(self.graph_path), exist_ok=True)
        self._load()

    def _generate_id(self, type_name: str) -> str:
        prefix = type_name.lower()[:4]
        suffix = uuid.uuid4().hex[:8]
        return f"{prefix}_{suffix}"

    def validate_node(self, node_type: str, name: str, attributes: dict = None) -> ValidationResult:
        errors = []
        warnings = []
        
        if self.enable_validation:
            type_errors = self.schema.validate_node_type(node_type)
            errors.extend(type_errors)
            
            if not errors:
                type_schema = self.schema.get_type_schema(node_type)
                temp_node = GraphNode(
                    id="temp",
                    node_type=node_type,
                    name=name,
                    attributes=attributes or {}
                )
                validation_errors = temp_node.validate(type_schema)
                errors.extend(validation_errors)
        
        return ValidationResult(
            valid=len(errors) == 0,
            errors=errors,
            warnings=warnings
        )

    def validate_edge(
        self,
        source_type: str,
        target_type: str,
        relation_type: str
    ) -> ValidationResult:
        errors = []
        warnings = []
        
        if self.enable_validation:
            rel_errors = self.schema.validate_relation_type(relation_type)
            if rel_errors:
                warnings.extend(rel_errors)
            else:
                rel_schema = self.schema.get_relation_schema(relation_type)
                
                from_types = rel_schema.get("from_types", [])
                to_types = rel_schema.get("to_types", [])
                
                if from_types and source_type not in from_types:
                    errors.append(
                        f"Relation '{relation_type}' cannot connect from type '{source_type}'. "
                        f"Allowed: {from_types}"
                    )
                
                if to_types and target_type not in to_types:
                    errors.append(
                        f"Relation '{relation_type}' cannot connect to type '{target_type}'. "
                        f"Allowed: {to_types}"
                    )
        
        return ValidationResult(
            valid=len(errors) == 0,
            errors=errors,
            warnings=warnings
        )

    def _check_cardinality(
        self,
        source_id: str,
        relation_type: str,
        cardinality: str
    ) -> bool:
        if cardinality in ("one_to_one", "many_to_one"):
            existing = [
                key for key in self._edges
                if key[0] == source_id and key[2] == relation_type
            ]
            if existing:
                return False
        return True

    def _would_create_cycle(
        self,
        source_id: str,
        target_id: str,
        relation_type: str
    ) -> bool:
        visited = set()
        stack = [target_id]
        
        while stack:
            current = stack.pop()
            if current == source_id:
                return True
            if current in visited:
                continue
            visited.add(current)
            
            for key in self._edge_index.get(current, set()):
                if key[2] == relation_type:
                    stack.append(key[1])
        
        return False

    def add_node(
        self,
        node_type: str,
        name: str,
        attributes: dict = None,
        memory_id: str = None,
        node_id: str = None,
        validate: bool = True
    ) -> Tuple[Optional[GraphNode], List[str]]:
        warnings = []
        
        if validate and self.enable_validation:
            validation = self.validate_node(node_type, name, attributes)
            if not validation.valid:
                logger.warning(f"Node validation failed: {validation.errors}")
                return None, validation.errors
            warnings = validation.warnings
        
        with self._lock:
            if node_id and node_id in self._nodes:
                node = self._nodes[node_id]
                if memory_id and memory_id not in node.memory_ids:
                    node.memory_ids.append(memory_id)
                if attributes:
                    node.attributes.update(attributes)
                node.updated_at = datetime.now(timezone.utc).timestamp()
                self._append_op("update_node", {
                    "id": node.id,
                    "properties": attributes or {},
                    "memory_id": memory_id
                })
                return node, warnings
            
            node_id = node_id or self._generate_id(node_type)
            
            node = GraphNode(
                id=node_id,
                node_type=node_type,
                name=name,
                attributes=attributes or {},
                memory_ids=[memory_id] if memory_id else []
            )
            
            self._nodes[node_id] = node
            self._type_index[node_type].add(node_id)
            self._node_index[name.lower()].add(node_id)
            
            if memory_id:
                self._memory_index[memory_id].add(node_id)
            
            self._append_op("create_node", {"entity": node.to_dict()})
            
            return node, warnings

    def add_edge(
        self,
        source_id: str,
        target_id: str,
        relation_type: str,
        weight: float = 1.0,
        attributes: dict = None,
        evidence: str = None,
        validate: bool = True
    ) -> Tuple[Optional[GraphEdge], List[str]]:
        errors = []
        warnings = []
        
        with self._lock:
            if source_id not in self._nodes:
                return None, [f"Source node not found: {source_id}"]
            if target_id not in self._nodes:
                return None, [f"Target node not found: {target_id}"]
            
            source = self._nodes[source_id]
            target = self._nodes[target_id]
            
            if validate and self.enable_validation:
                validation = self.validate_edge(
                    source.node_type,
                    target.node_type,
                    relation_type
                )
                errors.extend(validation.errors)
                warnings.extend(validation.warnings)
                
                if not errors:
                    rel_schema = self.schema.get_relation_schema(relation_type)
                    
                    cardinality = rel_schema.get("cardinality")
                    if cardinality and not self._check_cardinality(source_id, relation_type, cardinality):
                        errors.append(
                            f"Cardinality violation: '{relation_type}' has cardinality '{cardinality}'"
                        )
                    
                    if rel_schema.get("acyclic") and self._would_create_cycle(source_id, target_id, relation_type):
                        errors.append(f"Would create cycle for acyclic relation: {relation_type}")
            
            if errors:
                return None, errors
            
            edge_key = (source_id, target_id, relation_type)
            
            if edge_key in self._edges:
                edge = self._edges[edge_key]
                edge.weight = max(edge.weight, weight)
                if evidence and evidence not in edge.evidence:
                    edge.evidence.append(evidence)
                if attributes:
                    edge.attributes.update(attributes)
                self._append_op("update_edge", {
                    "source_id": source_id,
                    "target_id": target_id,
                    "relation_type": relation_type,
                    "weight": weight,
                    "evidence": evidence
                })
                return edge, warnings
            
            edge = GraphEdge(
                source_id=source_id,
                target_id=target_id,
                relation_type=relation_type,
                weight=weight,
                attributes=attributes or {},
                evidence=[evidence] if evidence else []
            )
            
            self._edges[edge_key] = edge
            self._edge_index[source_id].add(edge_key)
            
            self._append_op("create_edge", edge.to_dict())
            
            return edge, warnings

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
            
            return list({n.id: n for n in results}.values())

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
                for edge_key in self._edge_index.get(node_id, set()):
                    edge = self._edges.get(edge_key)
                    if edge:
                        if relation_type is None or edge.relation_type == relation_type:
                            target = self._nodes.get(edge.target_id)
                            if target:
                                results.append((target, edge))
            
            if direction in ("in", "both"):
                for edge_key, edge in self._edges.items():
                    if edge.target_id == node_id:
                        if relation_type is None or edge.relation_type == relation_type:
                            source = self._nodes.get(edge.source_id)
                            if source:
                                results.append((source, edge))
            
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
                self._append_op("link_memory", {
                    "memory_id": memory_id,
                    "node_id": node_id
                })

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
                self._edge_index[key[0]].discard(key)
            
            del self._nodes[node_id]
            self._append_op("delete_node", {"id": node_id})

    def update_node(self, node_id: str, attributes: dict) -> Optional[GraphNode]:
        with self._lock:
            if node_id not in self._nodes:
                return None
            
            node = self._nodes[node_id]
            node.attributes.update(attributes)
            node.updated_at = datetime.now(timezone.utc).timestamp()
            
            self._append_op("update_node", {
                "id": node_id,
                "properties": attributes
            })
            
            return node

    def delete_edge(self, source_id: str, target_id: str, relation_type: str) -> bool:
        with self._lock:
            edge_key = (source_id, target_id, relation_type)
            if edge_key not in self._edges:
                return False
            
            del self._edges[edge_key]
            self._edge_index[source_id].discard(edge_key)
            
            self._append_op("delete_edge", {
                "source_id": source_id,
                "target_id": target_id,
                "relation_type": relation_type
            })
            
            return True

    def validate_graph(self) -> ValidationResult:
        errors = []
        warnings = []
        
        with self._lock:
            for node_id, node in self._nodes.items():
                type_schema = self.schema.get_type_schema(node.node_type)
                node_errors = node.validate(type_schema)
                for err in node_errors:
                    errors.append(f"Node {node_id}: {err}")
            
            for edge_key, edge in self._edges.items():
                source = self._nodes.get(edge.source_id)
                target = self._nodes.get(edge.target_id)
                
                if not source or not target:
                    errors.append(f"Edge {edge_key}: references missing node")
                    continue
                
                validation = self.validate_edge(
                    source.node_type,
                    target.node_type,
                    edge.relation_type
                )
                for err in validation.errors:
                    errors.append(f"Edge {edge_key}: {err}")
                warnings.extend(validation.warnings)
        
        return ValidationResult(
            valid=len(errors) == 0,
            errors=errors,
            warnings=warnings
        )

    def _append_op(self, op_type: str, data: Dict[str, Any]):
        try:
            record = {
                "op": op_type,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                **data
            }
            
            with open(self.graph_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(record, ensure_ascii=False) + "\n")
        except Exception as e:
            logger.error(f"Failed to append operation: {e}")

    def _load(self):
        if not os.path.exists(self.graph_path):
            legacy_path = self.graph_path.replace(".jsonl", ".json")
            if os.path.exists(legacy_path):
                self._load_legacy(legacy_path)
            return
        
        try:
            with open(self.graph_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    
                    record = json.loads(line)
                    op = record.get("op")
                    
                    if op == "create_node":
                        entity = record.get("entity", {})
                        node = GraphNode.from_dict(entity)
                        self._nodes[node.id] = node
                        self._type_index[node.node_type].add(node.id)
                        self._node_index[node.name.lower()].add(node.id)
                        for memory_id in node.memory_ids:
                            self._memory_index[memory_id].add(node.id)
                    
                    elif op == "update_node":
                        node_id = record.get("id")
                        if node_id in self._nodes:
                            props = record.get("properties", {})
                            self._nodes[node_id].attributes.update(props)
                            memory_id = record.get("memory_id")
                            if memory_id and memory_id not in self._nodes[node_id].memory_ids:
                                self._nodes[node_id].memory_ids.append(memory_id)
                                self._memory_index[memory_id].add(node_id)
                    
                    elif op == "delete_node":
                        node_id = record.get("id")
                        if node_id in self._nodes:
                            node = self._nodes[node_id]
                            self._type_index[node.node_type].discard(node_id)
                            self._node_index[node.name.lower()].discard(node_id)
                            for memory_id in node.memory_ids:
                                self._memory_index[memory_id].discard(memory_id)
                            del self._nodes[node_id]
                    
                    elif op == "create_edge":
                        edge = GraphEdge.from_dict(record)
                        edge_key = (edge.source_id, edge.target_id, edge.relation_type)
                        self._edges[edge_key] = edge
                        self._edge_index[edge.source_id].add(edge_key)
                    
                    elif op == "update_edge":
                        source_id = record.get("source_id")
                        target_id = record.get("target_id")
                        relation_type = record.get("relation_type")
                        edge_key = (source_id, target_id, relation_type)
                        if edge_key in self._edges:
                            evidence = record.get("evidence")
                            if evidence and evidence not in self._edges[edge_key].evidence:
                                self._edges[edge_key].evidence.append(evidence)
                    
                    elif op == "delete_edge":
                        source_id = record.get("source_id")
                        target_id = record.get("target_id")
                        relation_type = record.get("relation_type")
                        edge_key = (source_id, target_id, relation_type)
                        if edge_key in self._edges:
                            del self._edges[edge_key]
                            self._edge_index[source_id].discard(edge_key)
                    
                    elif op == "link_memory":
                        memory_id = record.get("memory_id")
                        node_id = record.get("node_id")
                        if node_id in self._nodes and memory_id:
                            if memory_id not in self._nodes[node_id].memory_ids:
                                self._nodes[node_id].memory_ids.append(memory_id)
                            self._memory_index[memory_id].add(node_id)
            
            logger.info(f"Loaded graph with {len(self._nodes)} nodes and {len(self._edges)} edges")
        except Exception as e:
            logger.error(f"Failed to load graph: {e}")

    def _load_legacy(self, legacy_path: str):
        try:
            with open(legacy_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            
            for node_data in data.get("nodes", []):
                node = GraphNode.from_dict(node_data)
                self._nodes[node.id] = node
                self._type_index[node.node_type].add(node.id)
                self._node_index[node.name.lower()].add(node.id)
                for memory_id in node.memory_ids:
                    self._memory_index[memory_id].add(node.id)
                
                self._append_op("create_node", {"entity": node.to_dict()})
            
            for edge_data in data.get("edges", []):
                edge = GraphEdge.from_dict(edge_data)
                edge_key = (edge.source_id, edge.target_id, edge.relation_type)
                self._edges[edge_key] = edge
                self._edge_index[edge.source_id].add(edge_key)
                
                self._append_op("create_edge", edge.to_dict())
            
            logger.info(f"Migrated legacy graph with {len(self._nodes)} nodes and {len(self._edges)} edges")
        except Exception as e:
            logger.error(f"Failed to load legacy graph: {e}")

    def clear(self):
        with self._lock:
            self._nodes.clear()
            self._edges.clear()
            self._node_index.clear()
            self._type_index.clear()
            self._memory_index.clear()
            self._edge_index.clear()
            
            if os.path.exists(self.graph_path):
                os.remove(self.graph_path)

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
                "memory_links": len(self._memory_index),
                "schema_types": len(self.schema.get_all_types()),
                "schema_relations": len(self.schema.get_all_relations()),
            }

    def export_graph(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "nodes": [node.to_dict() for node in self._nodes.values()],
                "edges": [edge.to_dict() for edge in self._edges.values()],
                "stats": self.get_stats(),
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
        top_k: int = 10,
        filters: Dict[str, Any] = None
    ) -> List[Dict[str, Any]]:
        results = []
        seen_memory_ids = set()
        has_filters = self._has_valid_filters(filters)
        
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
                        
                        if has_filters and not self._match_filters(m_dict, filters):
                            continue
                        
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
                                
                                if has_filters and not self._match_filters(m_dict, filters):
                                    continue
                                
                                m_dict["graph_context"] = {
                                    "entity": neighbor.name,
                                    "entity_type": neighbor.node_type,
                                    "via": node.name,
                                    "relation": edge.relation_type
                                }
                                results.append(m_dict)
                                seen_memory_ids.add(memory_id)
        
        return results[:top_k]

    def _has_valid_filters(self, filters: Dict[str, Any]) -> bool:
        return bool(filters and any(v is not None for v in filters.values()))

    def _match_filters(self, item: Dict[str, Any], filters: Dict[str, Any]) -> bool:
        for key, value in filters.items():
            if value is None:
                continue
            item_value = item.get(key)
            if item_value != value:
                return False
        return True
