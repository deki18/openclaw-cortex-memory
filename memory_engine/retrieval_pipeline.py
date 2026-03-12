import logging
import math
from datetime import datetime
from typing import Any, Dict, List, Optional

from .config import CONFIG
from .lancedb_store import OpenClawMemory
from .reranker import Reranker
from .semantic_memory import SemanticMemory

logger = logging.getLogger(__name__)


class RetrievalPipeline:
    def __init__(self):
        self.semantic_memory = SemanticMemory()
        self.reranker = Reranker()
        self.time_decay_halflife = CONFIG.get("time_decay_halflife", 30)

    def search(
        self,
        query: str,
        top_k: int = 10,
        final_k: int = 3,
        query_type: str = "hybrid",
        memory_type: Optional[str] = None,
        apply_time_decay: bool = True,
        apply_rerank: bool = True
    ) -> List[Dict[str, Any]]:
        results = self.semantic_memory.search(
            query=query,
            top_k=top_k,
            query_type=query_type,
            memory_type=memory_type
        )
        
        if not results:
            return []
        
        if apply_time_decay:
            results = self._apply_time_decay(results)
        
        if apply_rerank and self.reranker.is_available():
            results = self._apply_rerank(query, results)
        
        results.sort(key=lambda x: x.get("final_score", 0), reverse=True)
        
        for r in results[:final_k]:
            memory_id = r.get("id")
            if memory_id:
                self.semantic_memory.update_hit_count(memory_id)
        
        return results[:final_k]

    def _apply_time_decay(self, results: List[OpenClawMemory]) -> List[Dict[str, Any]]:
        now = datetime.utcnow()
        processed = []
        
        for memory in results:
            memory_dict = memory.model_dump()
            weight = memory_dict.get("weight", 1)
            
            if weight >= 10:
                memory_dict["time_decay_score"] = 1.0
                memory_dict["final_score"] = 1.0
                processed.append(memory_dict)
                continue
            
            date_str = memory_dict.get("date", "")
            memory_date = self._parse_date(date_str)
            if memory_date:
                days_old = (now - memory_date).days
                decay = math.exp(-days_old * math.log(2) / self.time_decay_halflife)
            else:
                decay = 1.0
            
            memory_dict["time_decay_score"] = decay
            memory_dict["final_score"] = decay
            processed.append(memory_dict)
        
        return processed

    def _parse_date(self, date_str: str) -> Optional[datetime]:
        if not date_str:
            return None
        try:
            if len(date_str) == 10:
                return datetime.strptime(date_str, "%Y-%m-%d")
            cleaned = date_str.replace("Z", "")
            return datetime.fromisoformat(cleaned)
        except Exception:
            return None

    def _apply_rerank(self, query: str, results: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        if not results:
            return results
        
        texts = [r.get("text", "") for r in results]
        rerank_scores = self.reranker.rerank(query, texts)
        
        for i, r in enumerate(results):
            if i < len(rerank_scores):
                r["rerank_score"] = rerank_scores[i]
                decay = r.get("time_decay_score", 1.0)
                r["final_score"] = 0.6 * rerank_scores[i] + 0.4 * decay
        
        return results

    def search_by_type(
        self,
        query: str,
        memory_type: str,
        top_k: int = 5
    ) -> List[Dict[str, Any]]:
        return self.search(
            query=query,
            top_k=top_k,
            final_k=top_k,
            memory_type=memory_type
        )

    def get_core_rules(self, limit: int = 10) -> List[Dict[str, Any]]:
        memories = self.semantic_memory.store.get_core_rules(limit=limit)
        return [m.model_dump() for m in memories]

    def search_by_date_range(
        self,
        start_date: str,
        end_date: str,
        limit: int = 50
    ) -> List[Dict[str, Any]]:
        memories = self.semantic_memory.store.search_by_date_range(
            start_date=start_date,
            end_date=end_date,
            limit=limit
        )
        return [m.model_dump() for m in memories]
