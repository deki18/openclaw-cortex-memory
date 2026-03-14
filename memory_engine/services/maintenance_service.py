import logging
from datetime import datetime, timezone, timedelta
from typing import Optional

from ..config import get_config
from ..episodic_memory import EpisodicMemory
from ..graph.enhanced_graph import EnhancedMemoryGraph
from ..promotion_engine import PromotionEngine
from ..reflection_engine import ReflectionEngine
from ..semantic_memory import SemanticMemory

logger = logging.getLogger(__name__)


class MemoryMaintenanceService:
    def __init__(
        self, 
        semantic_memory: SemanticMemory = None, 
        episodic_memory: EpisodicMemory = None,
        graph: EnhancedMemoryGraph = None
    ):
        self.semantic = semantic_memory or SemanticMemory()
        self.episodic = episodic_memory or EpisodicMemory()
        self.graph = graph or EnhancedMemoryGraph()
        self.promotion = PromotionEngine()
        self.reflection = ReflectionEngine()

    def cleanup_old_memories(self, days_old: int = 90, memory_type: str = None) -> int:
        cutoff_date = (datetime.now(timezone.utc) - timedelta(days=days_old)).strftime("%Y-%m-%d")
        deleted_count = 0
        
        try:
            all_memories = self.semantic.list_all(limit=10000)
            for memory in all_memories:
                if memory.date < cutoff_date:
                    if memory_type and memory.type != memory_type:
                        continue
                    if memory.type == "core_rule":
                        continue
                    self.semantic.delete_by_id(memory.id)
                    deleted_count += 1
            logger.info(f"Cleaned up {deleted_count} old memories")
        except Exception as e:
            logger.error(f"Failed to cleanup old memories: {e}")
        
        return deleted_count

    def cleanup_old_events(self, max_events: int = 10000) -> int:
        try:
            return self.episodic.cleanup_old_events(max_events)
        except Exception as e:
            logger.error(f"Failed to cleanup old events: {e}")
            return 0

    def promote_memories(self) -> int:
        try:
            memories = self.semantic.list_all(limit=1000)
            promoted_count = 0
            for memory in memories:
                if memory.type != "core_rule" and self.promotion.check_and_promote(memory.hit_count, memory.text):
                    memory.type = "core_rule"
                    memory.weight = 10
                    self.semantic.store.add_memories([memory])
                    promoted_count += 1
            logger.info(f"Promoted {promoted_count} memories to core rules")
            return promoted_count
        except Exception as e:
            logger.error(f"Failed to promote memory: {e}")
            return 0

    def reflect(self):
        try:
            self.reflection.reflect()
        except Exception as e:
            logger.error(f"Failed to reflect memory: {e}")

    def rebuild_index(self) -> bool:
        try:
            self.semantic.store.rebuild_fts_index()
            logger.info("FTS index rebuilt successfully")
            return True
        except Exception as e:
            logger.error(f"Failed to rebuild FTS index: {e}")
            return False

    def get_statistics(self) -> dict:
        try:
            return {
                "total_memories": self.semantic.count(),
                "core_rules": self.semantic.count_by_type("core_rule"),
                "daily_logs": self.semantic.count_by_type("daily_log"),
                "events": self.episodic.count_events()
            }
        except Exception as e:
            logger.error(f"Failed to get statistics: {e}")
            return {}
