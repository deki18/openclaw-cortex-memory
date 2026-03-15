import json
import logging
import os
import re
import threading
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Optional, Set, Tuple

from ..models.memory_unit import (
    StructuredSummary, SystemMetadata, Chunk,
    L0MemoryUnit, L1MemoryUnit, L2MemoryUnit
)

logger = logging.getLogger(__name__)


class StorageLevel(Enum):
    L0_SENTENCE = "L0"
    L1_SUMMARY = "L1"
    L2_FULL = "L2"


class L0Index:
    """L0层：单句索引
    
    元数据：存在L0层（最高层级）
    """
    
    def __init__(self):
        self._units: Dict[str, L0MemoryUnit] = {}
        self._keyword_index: Dict[str, Set[str]] = defaultdict(set)
        self._lock = threading.RLock()

    def add(self, unit: L0MemoryUnit) -> str:
        with self._lock:
            if not unit.id:
                unit.id = f"L0-{uuid.uuid4().hex[:8]}"
            
            self._units[unit.id] = unit
            
            keywords = self._extract_keywords(unit.text)
            for kw in keywords:
                self._keyword_index[kw.lower()].add(unit.id)
            
            return unit.id
    
    def _extract_keywords(self, text: str) -> List[str]:
        english_words = re.findall(r'\b[a-zA-Z]{3,}\b', text.lower())
        chinese_chars = re.findall(r'[\u4e00-\u9fff]{2,}', text)
        stop_words = {"the", "a", "an", "is", "are", "was", "were", "be", "been", "being"}
        english_words = [w for w in english_words if w not in stop_words]
        return (english_words + chinese_chars)[:10]

    def search_by_keyword(self, keyword: str, limit: int = 10) -> List[L0MemoryUnit]:
        with self._lock:
            keyword_lower = keyword.lower()
            item_ids = self._keyword_index.get(keyword_lower, set())
            
            results = []
            for item_id in list(item_ids)[:limit]:
                unit = self._units.get(item_id)
                if unit:
                    results.append(unit)
            
            return results

    def get(self, item_id: str) -> Optional[L0MemoryUnit]:
        with self._lock:
            return self._units.get(item_id)

    def remove(self, item_id: str):
        with self._lock:
            unit = self._units.get(item_id)
            if unit:
                keywords = self._extract_keywords(unit.text)
                for kw in keywords:
                    self._keyword_index[kw.lower()].discard(item_id)
                
                del self._units[item_id]

    def get_all_ids(self) -> List[str]:
        with self._lock:
            return list(self._units.keys())


class L1SummaryLayer:
    """L1层：结构化摘要层
    
    元数据：如果parent_id存在则不存储，否则存储在L1层
    """
    
    def __init__(self):
        self._units: Dict[str, L1MemoryUnit] = {}
        self._parent_index: Dict[str, str] = {}
        self._child_index: Dict[str, List[str]] = defaultdict(list)
        self._lock = threading.RLock()

    def add(self, unit: L1MemoryUnit) -> str:
        with self._lock:
            if not unit.id:
                unit.id = f"L1-{uuid.uuid4().hex[:8]}"
            
            self._units[unit.id] = unit
            
            if unit.parent_id:
                self._parent_index[unit.id] = unit.parent_id
                self._child_index[unit.parent_id].append(unit.id)
            
            return unit.id

    def get(self, item_id: str) -> Optional[L1MemoryUnit]:
        with self._lock:
            return self._units.get(item_id)

    def get_by_parent(self, parent_id: str) -> Optional[L1MemoryUnit]:
        with self._lock:
            summary_ids = self._child_index.get(parent_id, [])
            if summary_ids:
                return self._units.get(summary_ids[0])
            return None
    
    def get_by_child(self, child_id: str) -> Optional[L1MemoryUnit]:
        with self._lock:
            parent_id = self._parent_index.get(child_id)
            if parent_id:
                return self._units.get(parent_id)
            return None

    def get_children(self, parent_id: str) -> List[L1MemoryUnit]:
        with self._lock:
            child_ids = self._child_index.get(parent_id, [])
            return [self._units[cid] for cid in child_ids if cid in self._units]

    def remove(self, item_id: str):
        with self._lock:
            parent_id = self._parent_index.get(item_id)
            if parent_id and parent_id in self._child_index:
                self._child_index[parent_id].remove(item_id)
            
            self._parent_index.pop(item_id, None)
            self._units.pop(item_id, None)

    def get_parent(self, item_id: str) -> Optional[str]:
        with self._lock:
            return self._parent_index.get(item_id)

    def get_all_ids(self) -> List[str]:
        with self._lock:
            return list(self._units.keys())


class L2FullLayer:
    """L2层：完整存储层
    
    元数据：存在L2层（最高层级）
    """
    
    def __init__(self):
        self._units: Dict[str, L2MemoryUnit] = {}
        self._lock = threading.RLock()

    def add(self, unit: L2MemoryUnit) -> str:
        with self._lock:
            if not unit.id:
                unit.id = f"L2-{uuid.uuid4().hex[:8]}"
            
            self._units[unit.id] = unit
            
            return unit.id

    def get(self, item_id: str) -> Optional[L2MemoryUnit]:
        with self._lock:
            return self._units.get(item_id)

    def update(self, item_id: str, new_text: str) -> bool:
        with self._lock:
            if item_id not in self._units:
                return False
            
            unit = self._units[item_id]
            unit.text = new_text
            unit.metadata.update_timestamp()
            return True

    def remove(self, item_id: str):
        with self._lock:
            self._units.pop(item_id, None)

    def get_all_ids(self) -> List[str]:
        with self._lock:
            return list(self._units.keys())


class LayeredMemoryStorage:
    """分层存储管理器 - 重构版
    
    设计原则：
    1. 元数据只在最高层级存储
    2. L0层：单句，元数据存在L0层
    3. L1层：结构化摘要，如果有L2父层则不存元数据
    4. L2层：原文，元数据存在L2层
    5. 切片：不存储元数据
    """
    
    def __init__(self, config: dict = None):
        config = config or {}
        
        self.l0_index = L0Index()
        self.l1_layer = L1SummaryLayer()
        self.l2_layer = L2FullLayer()
        
        self._hierarchy: Dict[str, Dict[str, Any]] = {}
        self._chunk_index: Dict[str, str] = {}
        
        self.persist_path = config.get("persist_path")
        self._lock = threading.RLock()
        
        if self.persist_path:
            self._load()

    def store_memory(
        self,
        text: str,
        structured_summary: StructuredSummary = None,
        vector: List[float] = None,
        metadata: SystemMetadata = None,
        chunks: List[Chunk] = None
    ) -> Tuple[str, StorageLevel]:
        """存储记忆
        
        Args:
            text: 原始文本
            structured_summary: 结构化摘要（L1层使用）
            vector: 原文向量
            metadata: 系统元数据（只在最高层级存储）
            chunks: 切片列表（可选）
        
        Returns:
            (memory_id, level)
        """
        with self._lock:
            metadata = metadata or SystemMetadata.create()
            
            level = self._determine_level(text)
            
            if level == StorageLevel.L0_SENTENCE:
                return self._store_l0(text, vector, metadata)
            elif level == StorageLevel.L1_SUMMARY:
                return self._store_l1(text, structured_summary, vector, metadata, chunks)
            else:
                return self._store_l2(text, structured_summary, vector, metadata, chunks)

    def _determine_level(self, text: str) -> StorageLevel:
        sentences = [s.strip() for s in text.replace('。', '.').split('.') if s.strip()]
        
        if len(sentences) <= 1 and len(text) < 100:
            return StorageLevel.L0_SENTENCE
        elif len(sentences) <= 3 and len(text) < 500:
            return StorageLevel.L1_SUMMARY
        else:
            return StorageLevel.L2_FULL

    def _store_l0(
        self, 
        text: str, 
        vector: List[float], 
        metadata: SystemMetadata
    ) -> Tuple[str, StorageLevel]:
        """存储L0层单句
        
        元数据：存在L0层（最高层级）
        """
        unit = L0MemoryUnit.create(text=text, vector=vector, metadata=metadata)
        item_id = self.l0_index.add(unit)
        
        self._hierarchy[item_id] = {
            "level": StorageLevel.L0_SENTENCE,
            "parent": None,
            "children": [],
            "metadata": metadata.to_dict()
        }
        
        if self.persist_path:
            self._save()
        
        return item_id, StorageLevel.L0_SENTENCE

    def _store_l1(
        self, 
        text: str,
        structured_summary: StructuredSummary,
        vector: List[float], 
        metadata: SystemMetadata,
        chunks: List[Chunk]
    ) -> Tuple[str, StorageLevel]:
        """存储L1层结构化摘要
        
        元数据：存在L1层（最高层级，因为没有L2父层）
        """
        if not structured_summary:
            structured_summary = StructuredSummary.create(summary_text=text[:200])
        
        unit = L1MemoryUnit.create(
            structured_summary=structured_summary,
            vector=vector,
            metadata=metadata,
            chunks=chunks
        )
        item_id = self.l1_layer.add(unit)
        
        self._hierarchy[item_id] = {
            "level": StorageLevel.L1_SUMMARY,
            "parent": None,
            "children": [],
            "metadata": metadata.to_dict(),
            "structured_summary": structured_summary.to_dict(),
            "chunk_ids": [c.id for c in chunks] if chunks else []
        }
        
        if chunks:
            self._store_chunks(item_id, chunks)
        
        if self.persist_path:
            self._save()
        
        return item_id, StorageLevel.L1_SUMMARY

    def _store_l2(
        self, 
        text: str,
        structured_summary: StructuredSummary,
        vector: List[float], 
        metadata: SystemMetadata,
        chunks: List[Chunk]
    ) -> Tuple[str, StorageLevel]:
        """存储L2层原文
        
        元数据：存在L2层（最高层级）
        L1层摘要：不存储元数据
        """
        unit = L2MemoryUnit.create(
            text=text,
            vector=vector,
            metadata=metadata,
            chunks=chunks
        )
        item_id = self.l2_layer.add(unit)
        
        l1_id = None
        if structured_summary:
            l1_unit = L1MemoryUnit.create(
                structured_summary=structured_summary,
                vector=None,
                parent_id=item_id
            )
            l1_id = self.l1_layer.add(l1_unit)
            unit.l1_summary_id = l1_id
        
        self._hierarchy[item_id] = {
            "level": StorageLevel.L2_FULL,
            "parent": None,
            "children": [l1_id] if l1_id else [],
            "metadata": metadata.to_dict(),
            "chunk_ids": [c.id for c in chunks] if chunks else []
        }
        
        if chunks:
            self._store_chunks(item_id, chunks)
        
        if self.persist_path:
            self._save()
        
        return item_id, StorageLevel.L2_FULL

    def _store_chunks(self, parent_id: str, chunks: List[Chunk]):
        for chunk in chunks:
            self._chunk_index[chunk.id] = parent_id
            
            if parent_id in self._hierarchy:
                if "chunk_ids" not in self._hierarchy[parent_id]:
                    self._hierarchy[parent_id]["chunk_ids"] = []
                self._hierarchy[parent_id]["chunk_ids"].append(chunk.id)

    def get_metadata(self, item_id: str) -> Optional[SystemMetadata]:
        """获取元数据（统一从hierarchy索引获取，避免多层查找）"""
        with self._lock:
            if item_id not in self._hierarchy:
                return None
            
            info = self._hierarchy[item_id]
            metadata_dict = info.get("metadata")
            
            if metadata_dict:
                return SystemMetadata.from_dict(metadata_dict)
            
            return None

    def get_structured_summary(self, item_id: str) -> Optional[StructuredSummary]:
        """获取结构化摘要（只在L1层查找）"""
        with self._lock:
            if item_id not in self._hierarchy:
                return None
            
            info = self._hierarchy[item_id]
            level = info["level"]
            
            if level == StorageLevel.L1_SUMMARY:
                unit = self.l1_layer.get(item_id)
                return unit.structured_summary if unit else None
            
            elif level == StorageLevel.L2_FULL:
                l1_id = info.get("children", [None])[0]
                if l1_id:
                    unit = self.l1_layer.get(l1_id)
                    return unit.structured_summary if unit else None
            
            return None

    def get(self, item_id: str, level: StorageLevel = None):
        with self._lock:
            if item_id not in self._hierarchy:
                return None
            
            if level is None:
                level = self._hierarchy[item_id]["level"]
            
            if level == StorageLevel.L0_SENTENCE:
                return self.l0_index.get(item_id)
            elif level == StorageLevel.L1_SUMMARY:
                return self.l1_layer.get(item_id)
            else:
                return self.l2_layer.get(item_id)

    def get_hierarchy(self, item_id: str) -> Dict[str, Any]:
        with self._lock:
            if item_id not in self._hierarchy:
                return {}
            
            info = self._hierarchy[item_id]
            
            result = {
                "id": item_id,
                "level": info["level"].value,
                "parent": info["parent"],
                "children": info["children"],
                "chunk_count": len(info.get("chunk_ids", []))
            }
            
            metadata = self.get_metadata(item_id)
            if metadata:
                result["metadata"] = metadata.to_dict()
            
            structured_summary = self.get_structured_summary(item_id)
            if structured_summary:
                result["structured_summary"] = structured_summary.to_dict()
            
            return result

    def navigate_up(self, item_id: str) -> List:
        with self._lock:
            ancestors = []
            current_id = item_id
            
            while True:
                if current_id not in self._hierarchy:
                    break
                
                parent_id = self._hierarchy[current_id].get("parent")
                if not parent_id:
                    break
                
                parent_item = self.get(parent_id)
                if parent_item:
                    ancestors.append(parent_item)
                    current_id = parent_id
                else:
                    break
            
            return ancestors

    def navigate_down(self, item_id: str, max_depth: int = 2) -> List:
        with self._lock:
            descendants = []
            queue = [(item_id, 0)]
            visited = {item_id}
            
            while queue:
                current_id, depth = queue.pop(0)
                
                if depth >= max_depth:
                    continue
                
                children = self._get_children(current_id)
                for child in children:
                    child_id = child.id if hasattr(child, 'id') else str(child)
                    if child_id not in visited:
                        visited.add(child_id)
                        descendants.append(child)
                        queue.append((child_id, depth + 1))
            
            return descendants

    def _get_children(self, item_id: str) -> List:
        if item_id not in self._hierarchy:
            return []
        
        info = self._hierarchy[item_id]
        children = []
        
        for child_id in info.get("children", []):
            child = self.get(child_id)
            if child:
                children.append(child)
        
        return children

    def get_chunk_parent(self, chunk_id: str) -> Optional[str]:
        with self._lock:
            return self._chunk_index.get(chunk_id)

    def get_chunks(self, parent_id: str) -> List[str]:
        with self._lock:
            if parent_id not in self._hierarchy:
                return []
            return self._hierarchy[parent_id].get("chunk_ids", [])

    def remove(self, item_id: str, cascade: bool = True):
        with self._lock:
            if item_id not in self._hierarchy:
                return
            
            info = self._hierarchy[item_id]
            level = info["level"]
            
            if cascade:
                for child_id in info.get("children", []):
                    self.remove(child_id, cascade=False)
                
                for chunk_id in info.get("chunk_ids", []):
                    self._chunk_index.pop(chunk_id, None)
            
            if level == StorageLevel.L0_SENTENCE:
                self.l0_index.remove(item_id)
            elif level == StorageLevel.L1_SUMMARY:
                self.l1_layer.remove(item_id)
            else:
                self.l2_layer.remove(item_id)
            
            del self._hierarchy[item_id]
            
            if self.persist_path:
                self._save()

    def _save(self):
        try:
            data = {
                "hierarchy": {
                    k: {
                        "level": v["level"].value,
                        "parent": v["parent"],
                        "children": v["children"],
                        "metadata": v.get("metadata", {}),
                        "structured_summary": v.get("structured_summary"),
                        "chunk_ids": v.get("chunk_ids", [])
                    }
                    for k, v in self._hierarchy.items()
                },
                "chunk_index": self._chunk_index
            }
            
            os.makedirs(os.path.dirname(self.persist_path), exist_ok=True)
            with open(self.persist_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
                
        except Exception as e:
            logger.error(f"Failed to save layered storage: {e}")

    def _load(self):
        if not os.path.exists(self.persist_path):
            return
        
        try:
            with open(self.persist_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            
            hierarchy = data.get("hierarchy", {})
            self._hierarchy = {
                k: {
                    "level": StorageLevel(v["level"]),
                    "parent": v["parent"],
                    "children": v["children"],
                    "metadata": v.get("metadata", {}),
                    "structured_summary": v.get("structured_summary"),
                    "chunk_ids": v.get("chunk_ids", [])
                }
                for k, v in hierarchy.items()
            }
            
            self._chunk_index = data.get("chunk_index", {})
            
            logger.info(f"Loaded {len(self._hierarchy)} items from layered storage")
            
        except Exception as e:
            logger.error(f"Failed to load layered storage: {e}")

    def get_stats(self) -> Dict[str, Any]:
        with self._lock:
            level_counts = {
                StorageLevel.L0_SENTENCE: 0,
                StorageLevel.L1_SUMMARY: 0,
                StorageLevel.L2_FULL: 0
            }
            
            chunk_count = 0
            
            for info in self._hierarchy.values():
                level_counts[info["level"]] += 1
                chunk_count += len(info.get("chunk_ids", []))
            
            return {
                "total_items": len(self._hierarchy),
                "by_level": {
                    level.value: count 
                    for level, count in level_counts.items()
                },
                "total_chunks": chunk_count
            }
