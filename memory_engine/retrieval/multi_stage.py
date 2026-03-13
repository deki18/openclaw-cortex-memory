import logging
import math
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


class RetrievalStage(Enum):
    COARSE = "coarse"
    FINE = "fine"
    RERANK = "rerank"


@dataclass
class RetrievedItem:
    id: str
    text: str
    score: float
    source: str
    metadata: Dict[str, Any] = field(default_factory=dict)
    vector: Optional[List[float]] = None


@dataclass
class RetrievalResult:
    items: List[RetrievedItem]
    total_candidates: int
    stage: RetrievalStage
    query_understanding: Optional[Dict] = None
    elapsed_ms: float = 0.0


class CoarseRetriever(ABC):
    @abstractmethod
    def retrieve(self, query: str, top_k: int = 100) -> List[RetrievedItem]:
        pass


class FineRanker(ABC):
    @abstractmethod
    def rank(self, query: str, items: List[RetrievedItem], top_k: int = 20) -> List[RetrievedItem]:
        pass


class VectorRetriever(CoarseRetriever):
    def __init__(self, store, embedding_module):
        self.store = store
        self.embedding_module = embedding_module

    def retrieve(self, query: str, top_k: int = 100) -> List[RetrievedItem]:
        embedding = self.embedding_module.embed_text([query])[0]
        
        results = self.store.search(
            query_vector=embedding,
            query_text=query,
            limit=top_k,
            query_type="hybrid"
        )
        
        items = []
        for r in results:
            r_dict = r.model_dump() if hasattr(r, 'model_dump') else r
            items.append(RetrievedItem(
                id=r_dict.get("id", ""),
                text=r_dict.get("text", ""),
                score=r_dict.get("_distance", 0.0),
                source="vector",
                metadata=r_dict
            ))
        
        return items


class KeywordRetriever(CoarseRetriever):
    def __init__(self, store):
        self.store = store

    def retrieve(self, query: str, top_k: int = 100) -> List[RetrievedItem]:
        results = self.store.search(
            query_vector=None,
            query_text=query,
            limit=top_k,
            query_type="fts"
        )
        
        items = []
        for r in results:
            r_dict = r.model_dump() if hasattr(r, 'model_dump') else r
            items.append(RetrievedItem(
                id=r_dict.get("id", ""),
                text=r_dict.get("text", ""),
                score=r_dict.get("_score", 0.0),
                source="keyword",
                metadata=r_dict
            ))
        
        return items


class MultiPathRecaller:
    def __init__(self, retrievers: List[CoarseRetriever]):
        self.retrievers = retrievers

    def recall(self, query: str, top_k_per_path: int = 50) -> List[RetrievedItem]:
        all_items = []
        
        for retriever in self.retrievers:
            try:
                items = retriever.retrieve(query, top_k_per_path)
                all_items.extend(items)
            except Exception as e:
                logger.warning(f"Retriever failed: {e}")
        
        return self._merge_and_dedupe(all_items)

    def _merge_and_dedupe(self, items: List[RetrievedItem]) -> List[RetrievedItem]:
        seen = {}
        
        for item in items:
            if item.id not in seen:
                seen[item.id] = item
            else:
                existing = seen[item.id]
                if item.score > existing.score:
                    seen[item.id] = item
                elif item.source != existing.source:
                    existing.metadata["sources"] = [existing.source, item.source]
        
        return list(seen.values())


class SemanticRanker(FineRanker):
    def __init__(self, embedding_module):
        self.embedding_module = embedding_module

    def rank(self, query: str, items: List[RetrievedItem], top_k: int = 20) -> List[RetrievedItem]:
        if not items:
            return []
        
        query_embedding = self.embedding_module.embed_text([query])[0]
        
        scored_items = []
        for item in items:
            if item.vector:
                similarity = self._cosine_similarity(query_embedding, item.vector)
                item.score = similarity
            scored_items.append(item)
        
        scored_items.sort(key=lambda x: x.score, reverse=True)
        
        return scored_items[:top_k]

    def _cosine_similarity(self, vec1: List[float], vec2: List[float]) -> float:
        if len(vec1) != len(vec2):
            return 0.0
        
        dot = sum(a * b for a, b in zip(vec1, vec2))
        norm1 = math.sqrt(sum(a * a for a in vec1))
        norm2 = math.sqrt(sum(b * b for b in vec2))
        
        if norm1 == 0 or norm2 == 0:
            return 0.0
        
        return dot / (norm1 * norm2)


class ContextAwareReranker:
    def __init__(self, config: dict = None):
        config = config or {}
        self.weights = config.get("weights", {
            "relevance": 0.4,
            "recency": 0.2,
            "importance": 0.2,
            "hit_count": 0.1,
            "context_match": 0.1
        })
        self.context_history: List[Dict] = []
        self.max_history = 10

    def add_context(self, query: str, result: Dict):
        self.context_history.append({
            "query": query,
            "result": result,
            "timestamp": datetime.now(timezone.utc).isoformat()
        })
        
        if len(self.context_history) > self.max_history:
            self.context_history.pop(0)

    def rerank(
        self, 
        query: str, 
        items: List[RetrievedItem], 
        top_k: int = 10
    ) -> List[RetrievedItem]:
        if not items:
            return []
        
        context_score = self._calculate_context_score(query)
        
        now = datetime.now(timezone.utc)
        
        for item in items:
            scores = {}
            
            scores["relevance"] = item.score
            
            date_str = item.metadata.get("date", "")
            days_old = self._calculate_days_old(date_str, now)
            scores["recency"] = max(0.1, 1.0 - days_old / 365.0)
            
            scores["importance"] = item.metadata.get("importance_score", 0.5)
            
            hit_count = item.metadata.get("hit_count", 0)
            scores["hit_count"] = min(1.0, hit_count / 10.0)
            
            scores["context_match"] = context_score.get(item.id, 0.0)
            
            final_score = sum(
                scores.get(k, 0) * v 
                for k, v in self.weights.items()
            )
            item.score = final_score
        
        items.sort(key=lambda x: x.score, reverse=True)
        
        return items[:top_k]

    def _calculate_context_score(self, query: str) -> Dict[str, float]:
        scores = {}
        
        query_words = set(query.lower().split())
        
        for ctx in self.context_history[-5:]:
            ctx_words = set(ctx["query"].lower().split())
            overlap = len(query_words & ctx_words) / max(len(query_words), 1)
            
            if overlap > 0.3:
                result = ctx.get("result", {})
                if "id" in result:
                    scores[result["id"]] = scores.get(result["id"], 0) + overlap * 0.5
        
        return scores

    def _calculate_days_old(self, date_str: str, now: datetime) -> float:
        if not date_str:
            return 0.0
        
        try:
            if len(date_str) == 10:
                memory_date = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            else:
                cleaned = date_str.replace("Z", "").replace("+00:00", "")
                memory_date = datetime.fromisoformat(cleaned)
                if memory_date.tzinfo is None:
                    memory_date = memory_date.replace(tzinfo=timezone.utc)
            
            delta = now - memory_date
            return max(0.0, delta.total_seconds() / 86400.0)
        except Exception:
            return 0.0

    def clear_context(self):
        self.context_history.clear()


class MultiStageRetrievalPipeline:
    def __init__(
        self,
        store,
        embedding_module,
        reranker=None,
        config: dict = None
    ):
        config = config or {}
        
        vector_retriever = VectorRetriever(store, embedding_module)
        keyword_retriever = KeywordRetriever(store)
        
        self.recaller = MultiPathRecaller([vector_retriever, keyword_retriever])
        self.semantic_ranker = SemanticRanker(embedding_module)
        self.context_reranker = ContextAwareReranker(config.get("rerank", {}))
        self.external_reranker = reranker
        
        self.coarse_k = config.get("coarse_k", 100)
        self.fine_k = config.get("fine_k", 20)
        self.final_k = config.get("final_k", 5)

    def search(
        self, 
        query: str, 
        top_k: int = None,
        query_understanding: Dict = None
    ) -> RetrievalResult:
        import time
        start_time = time.time()
        
        final_k = top_k or self.final_k
        
        coarse_items = self.recaller.recall(query, self.coarse_k // 2)
        
        fine_items = self.semantic_ranker.rank(query, coarse_items, self.fine_k)
        
        if self.external_reranker and self.external_reranker.is_available():
            fine_items = self._apply_external_rerank(query, fine_items)
        
        final_items = self.context_reranker.rerank(query, fine_items, final_k)
        
        elapsed_ms = (time.time() - start_time) * 1000
        
        return RetrievalResult(
            items=final_items,
            total_candidates=len(coarse_items),
            stage=RetrievalStage.RERANK,
            query_understanding=query_understanding,
            elapsed_ms=elapsed_ms
        )

    def _apply_external_rerank(
        self, 
        query: str, 
        items: List[RetrievedItem]
    ) -> List[RetrievedItem]:
        texts = [item.text for item in items]
        
        try:
            scores = self.external_reranker.rerank(query, texts)
            
            for i, item in enumerate(items):
                if i < len(scores):
                    item.score = scores[i]
            
            items.sort(key=lambda x: x.score, reverse=True)
        except Exception as e:
            logger.warning(f"External rerank failed: {e}")
        
        return items

    def search_with_context(
        self,
        query: str,
        context_queries: List[str] = None,
        top_k: int = None
    ) -> RetrievalResult:
        if context_queries:
            for ctx_query in context_queries:
                self.context_reranker.add_context(ctx_query, {})
        
        return self.search(query, top_k)


class FusionStrategy:
    @staticmethod
    def reciprocal_rank_fusion(
        result_lists: List[List[RetrievedItem]],
        k: int = 60
    ) -> List[RetrievedItem]:
        scores = {}
        
        for result_list in result_lists:
            for rank, item in enumerate(result_list):
                if item.id not in scores:
                    scores[item.id] = {
                        "item": item,
                        "score": 0.0
                    }
                scores[item.id]["score"] += 1.0 / (k + rank + 1)
        
        sorted_items = sorted(
            scores.values(),
            key=lambda x: x["score"],
            reverse=True
        )
        
        result = []
        for entry in sorted_items:
            item = entry["item"]
            item.score = entry["score"]
            result.append(item)
        
        return result

    @staticmethod
    def weighted_fusion(
        result_lists: List[Tuple[List[RetrievedItem], float]]
    ) -> List[RetrievedItem]:
        scores = {}
        
        for result_list, weight in result_lists:
            for item in result_list:
                if item.id not in scores:
                    scores[item.id] = {
                        "item": item,
                        "score": 0.0
                    }
                scores[item.id]["score"] += item.score * weight
        
        sorted_items = sorted(
            scores.values(),
            key=lambda x: x["score"],
            reverse=True
        )
        
        result = []
        for entry in sorted_items:
            item = entry["item"]
            item.score = entry["score"]
            result.append(item)
        
        return result
