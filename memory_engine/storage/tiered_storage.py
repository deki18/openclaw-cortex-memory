import logging
import os
import threading
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Optional, Set

logger = logging.getLogger(__name__)


class MemoryTier(Enum):
    HOT = "hot"
    WARM = "warm"
    COLD = "cold"


@dataclass
class TierConfig:
    hot_max_items: int = 100
    hot_max_age_hours: int = 24
    warm_max_items: int = 1000
    warm_max_age_days: int = 30
    cold_max_age_days: int = 365
    
    hot_access_threshold: int = 3
    warm_access_threshold: int = 1
    
    promotion_check_interval: int = 3600
    demotion_check_interval: int = 7200


@dataclass
class TieredMemoryItem:
    id: str
    text: str
    tier: MemoryTier
    access_count: int = 0
    last_accessed: float = 0.0
    created_at: float = 0.0
    importance_score: float = 0.5
    metadata: Dict[str, Any] = field(default_factory=dict)
    vector: Optional[List[float]] = None


class HotMemoryCache:
    def __init__(self, max_size: int = 100):
        self.max_size = max_size
        self._cache: OrderedDict[str, TieredMemoryItem] = OrderedDict()
        self._lock = threading.RLock()

    def get(self, item_id: str) -> Optional[TieredMemoryItem]:
        with self._lock:
            if item_id in self._cache:
                item = self._cache.pop(item_id)
                item.access_count += 1
                item.last_accessed = datetime.now(timezone.utc).timestamp()
                self._cache[item_id] = item
                return item
            return None

    def put(self, item: TieredMemoryItem):
        with self._lock:
            if item.id in self._cache:
                self._cache.pop(item.id)
            
            while len(self._cache) >= self.max_size:
                self._cache.popitem(last=False)
            
            item.tier = MemoryTier.HOT
            self._cache[item.id] = item

    def remove(self, item_id: str) -> Optional[TieredMemoryItem]:
        with self._lock:
            return self._cache.pop(item_id, None)

    def get_all(self) -> List[TieredMemoryItem]:
        with self._lock:
            return list(self._cache.values())

    def size(self) -> int:
        with self._lock:
            return len(self._cache)

    def clear(self):
        with self._lock:
            self._cache.clear()


class WarmMemoryStore:
    def __init__(self, store, max_size: int = 1000):
        self.store = store
        self.max_size = max_size
        self._index: Dict[str, float] = {}
        self._lock = threading.RLock()

    def get(self, item_id: str) -> Optional[TieredMemoryItem]:
        with self._lock:
            if item_id not in self._index:
                return None
            
            memory = self.store.get_by_id(item_id)
            if memory:
                m_dict = memory.model_dump() if hasattr(memory, 'model_dump') else memory
                return TieredMemoryItem(
                    id=m_dict.get("id", ""),
                    text=m_dict.get("text", ""),
                    tier=MemoryTier.WARM,
                    access_count=m_dict.get("hit_count", 0),
                    importance_score=m_dict.get("importance_score", 0.5),
                    metadata=m_dict
                )
            return None

    def put(self, item: TieredMemoryItem):
        with self._lock:
            self._index[item.id] = datetime.now(timezone.utc).timestamp()
            item.tier = MemoryTier.WARM

    def remove(self, item_id: str):
        with self._lock:
            self._index.pop(item_id, None)

    def get_ids(self) -> Set[str]:
        with self._lock:
            return set(self._index.keys())

    def size(self) -> int:
        with self._lock:
            return len(self._index)


class ColdMemoryArchive:
    def __init__(self, store):
        self.store = store

    def get(self, item_id: str) -> Optional[TieredMemoryItem]:
        memory = self.store.get_by_id(item_id)
        if memory:
            m_dict = memory.model_dump() if hasattr(memory, 'model_dump') else memory
            return TieredMemoryItem(
                id=m_dict.get("id", ""),
                text=m_dict.get("text", ""),
                tier=MemoryTier.COLD,
                access_count=m_dict.get("hit_count", 0),
                importance_score=m_dict.get("importance_score", 0.5),
                metadata=m_dict
            )
        return None

    def archive(self, item: TieredMemoryItem):
        item.tier = MemoryTier.COLD


class TieredMemoryManager:
    def __init__(self, store, config: TierConfig = None):
        self.config = config or TierConfig()
        
        self.hot_cache = HotMemoryCache(self.config.hot_max_items)
        self.warm_store = WarmMemoryStore(store, self.config.warm_max_items)
        self.cold_archive = ColdMemoryArchive(store)
        
        self.store = store
        self._lock = threading.RLock()
        self._last_promotion_check = 0.0
        self._last_demotion_check = 0.0

    def get(self, item_id: str) -> Optional[TieredMemoryItem]:
        item = self.hot_cache.get(item_id)
        if item:
            return item
        
        item = self.warm_store.get(item_id)
        if item:
            self._maybe_promote_to_hot(item)
            return item
        
        item = self.cold_archive.get(item_id)
        if item:
            self._maybe_promote_to_warm(item)
            return item
        
        return None

    def put(self, item: TieredMemoryItem):
        with self._lock:
            item.created_at = datetime.now(timezone.utc).timestamp()
            item.last_accessed = item.created_at
            
            if item.importance_score >= 0.7:
                self.hot_cache.put(item)
            else:
                self.warm_store.put(item)

    def access(self, item_id: str) -> Optional[TieredMemoryItem]:
        item = self.get(item_id)
        if item:
            item.access_count += 1
            item.last_accessed = datetime.now(timezone.utc).timestamp()
            
            self._check_tier_transition(item)
        
        return item

    def _check_tier_transition(self, item: TieredMemoryItem):
        now = datetime.now(timezone.utc).timestamp()
        
        if item.tier == MemoryTier.HOT:
            age_hours = (now - item.created_at) / 3600
            if (age_hours > self.config.hot_max_age_hours and 
                item.access_count < self.config.hot_access_threshold):
                self._demote_to_warm(item)
        
        elif item.tier == MemoryTier.WARM:
            if item.access_count >= self.config.hot_access_threshold:
                self._promote_to_hot(item)
            
            age_days = (now - item.created_at) / 86400
            if age_days > self.config.warm_max_age_days:
                self._demote_to_cold(item)
        
        elif item.tier == MemoryTier.COLD:
            if item.access_count >= self.config.warm_access_threshold:
                self._promote_to_warm(item)

    def _promote_to_hot(self, item: TieredMemoryItem):
        self.warm_store.remove(item.id)
        self.hot_cache.put(item)
        logger.debug(f"Promoted {item.id} to HOT tier")

    def _demote_to_warm(self, item: TieredMemoryItem):
        self.hot_cache.remove(item.id)
        self.warm_store.put(item)
        logger.debug(f"Demoted {item.id} to WARM tier")

    def _promote_to_warm(self, item: TieredMemoryItem):
        self.warm_store.put(item)
        logger.debug(f"Promoted {item.id} to WARM tier")

    def _demote_to_cold(self, item: TieredMemoryItem):
        self.warm_store.remove(item.id)
        self.cold_archive.archive(item)
        logger.debug(f"Demoted {item.id} to COLD tier")

    def _maybe_promote_to_hot(self, item: TieredMemoryItem):
        if item.access_count >= self.config.hot_access_threshold:
            self._promote_to_hot(item)

    def _maybe_promote_to_warm(self, item: TieredMemoryItem):
        if item.access_count >= self.config.warm_access_threshold:
            self._promote_to_warm(item)

    def search_hot(self, query_vector: List[float], top_k: int = 10) -> List[TieredMemoryItem]:
        import math
        
        hot_items = self.hot_cache.get_all()
        
        scored = []
        for item in hot_items:
            if item.vector:
                similarity = self._cosine_similarity(query_vector, item.vector)
                scored.append((similarity, item))
        
        scored.sort(key=lambda x: x[0], reverse=True)
        return [item for _, item in scored[:top_k]]

    def _cosine_similarity(self, vec1: List[float], vec2: List[float]) -> float:
        if not vec1 or not vec2 or len(vec1) != len(vec2):
            return 0.0
        
        dot = sum(a * b for a, b in zip(vec1, vec2))
        norm1 = math.sqrt(sum(a * a for a in vec1))
        norm2 = math.sqrt(sum(b * b for b in vec2))
        
        if norm1 == 0 or norm2 == 0:
            return 0.0
        
        return dot / (norm1 * norm2)

    def get_stats(self) -> Dict[str, Any]:
        return {
            "hot": {
                "count": self.hot_cache.size(),
                "max_size": self.config.hot_max_items
            },
            "warm": {
                "count": self.warm_store.size(),
                "max_size": self.config.warm_max_items
            },
            "cold": {
                "description": "Archived in LanceDB"
            }
        }

    def run_maintenance(self):
        now = datetime.now(timezone.utc).timestamp()
        
        if now - self._last_promotion_check > self.config.promotion_check_interval:
            self._check_promotions()
            self._last_promotion_check = now
        
        if now - self._last_demotion_check > self.config.demotion_check_interval:
            self._check_demotions()
            self._last_demotion_check = now

    def _check_promotions(self):
        warm_items = []
        for item_id in self.warm_store.get_ids():
            item = self.warm_store.get(item_id)
            if item and item.access_count >= self.config.hot_access_threshold:
                warm_items.append(item)
        
        for item in warm_items[:10]:
            self._promote_to_hot(item)

    def _check_demotions(self):
        hot_items = self.hot_cache.get_all()
        now = datetime.now(timezone.utc).timestamp()
        
        for item in hot_items:
            age_hours = (now - item.created_at) / 3600
            if (age_hours > self.config.hot_max_age_hours and 
                item.access_count < self.config.hot_access_threshold):
                self._demote_to_warm(item)


class CoreRulesCache:
    CORE_RULES_PRIORITY = 1.0
    CORE_RULES_SOURCE = "core_rules"

    def __init__(self, cortex_rules_path: str = None, local_cortex_rules_path: str = None):
        self.cortex_rules_path = cortex_rules_path
        self.local_cortex_rules_path = local_cortex_rules_path
        self._content: Optional[str] = None
        self._loaded: bool = False
        self._last_modified: float = 0.0
        self._lock = threading.RLock()

    def load(self) -> bool:
        with self._lock:
            paths = []
            if self.cortex_rules_path:
                paths.append(self.cortex_rules_path)
            if self.local_cortex_rules_path:
                paths.append(self.local_cortex_rules_path)
            
            for path in paths:
                full_path = os.path.abspath(path)
                if os.path.exists(full_path):
                    try:
                        current_modified = os.path.getmtime(full_path)
                        if self._loaded and current_modified == self._last_modified:
                            return True
                        
                        with open(full_path, "r", encoding="utf-8") as f:
                            self._content = f.read()
                        self._loaded = True
                        self._last_modified = current_modified
                        logger.info(f"Loaded CORTEX_RULES.md from {full_path}")
                        return True
                    except Exception as e:
                        logger.warning(f"Failed to load CORTEX_RULES.md from {full_path}: {e}")
            
            self._content = None
            self._loaded = False
            return False

    def reload(self) -> bool:
        with self._lock:
            self._loaded = False
            return self.load()

    def get_content(self) -> Optional[str]:
        with self._lock:
            if not self._loaded:
                self.load()
            return self._content

    def is_loaded(self) -> bool:
        with self._lock:
            return self._loaded

    def get_as_search_item(self) -> Optional[TieredMemoryItem]:
        content = self.get_content()
        if not content:
            return None
        
        return TieredMemoryItem(
            id="CORTEX_RULES",
            text=content,
            tier=MemoryTier.HOT,
            access_count=999999,
            last_accessed=datetime.now(timezone.utc).timestamp(),
            created_at=0,
            importance_score=self.CORE_RULES_PRIORITY,
            metadata={
                "source": self.CORE_RULES_SOURCE,
                "priority": self.CORE_RULES_PRIORITY,
                "no_decay": True
            },
            vector=None
        )

    def clear(self):
        with self._lock:
            self._content = None
            self._loaded = False
            self._last_modified = 0.0
