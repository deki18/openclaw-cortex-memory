import logging
from typing import List, Dict, Any, Optional

from .retrieval_pipeline import RetrievalPipeline
from .semantic_memory import SemanticMemory

logger = logging.getLogger(__name__)


class MemorySearchService:
    def __init__(self, retrieval_pipeline: RetrievalPipeline = None, semantic_memory: SemanticMemory = None):
        self.retrieval = retrieval_pipeline or RetrievalPipeline()
        self.semantic = semantic_memory or SemanticMemory()

    def search(self, query: str, top_k: int = 10, final_k: int = 3, 
               query_type: str = "hybrid", memory_type: Optional[str] = None) -> List[Dict[str, Any]]:
        if not query or not query.strip():
            logger.warning("Empty query provided, returning empty results")
            return []
        
        try:
            return self.retrieval.search(
                query=query.strip(),
                top_k=top_k,
                final_k=final_k,
                query_type=query_type,
                memory_type=memory_type
            )
        except Exception as e:
            logger.error(f"Failed to search memory: {e}")
            return []

    def search_by_date_range(self, start_date: str, end_date: str, limit: int = 50) -> List[Dict[str, Any]]:
        try:
            return self.retrieval.search_by_date_range(
                start_date=start_date,
                end_date=end_date,
                limit=limit
            )
        except Exception as e:
            logger.error(f"Failed to search by date range: {e}")
            return []

    def get_core_rules(self, limit: int = 20) -> List[Dict[str, Any]]:
        try:
            return self.retrieval.get_core_rules(limit=limit)
        except Exception as e:
            logger.error(f"Failed to get core rules: {e}")
            return []

    def get_hot_context(self, limit: int = 20) -> List[Dict[str, Any]]:
        try:
            from .hot_memory import HotMemory
            hot = HotMemory()
            return hot.build_hot_context(limit=limit)
        except Exception as e:
            logger.error(f"Failed to get hot context: {e}")
            return []

    def count_memories(self) -> Dict[str, int]:
        try:
            return {
                "total": self.semantic.count(),
                "core_rules": self.semantic.count_by_type("core_rule"),
                "daily_logs": self.semantic.count_by_type("daily_log")
            }
        except Exception as e:
            logger.error(f"Failed to count memories: {e}")
            return {"total": 0, "core_rules": 0, "daily_logs": 0}
