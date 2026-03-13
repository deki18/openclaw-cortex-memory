import logging
import math
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Optional, Set, Tuple

logger = logging.getLogger(__name__)


class SearchSource(Enum):
    HOT_CACHE = "hot_cache"
    VECTOR = "vector"
    KEYWORD = "keyword"
    GRAPH = "graph"
    FUSION = "fusion"


class SearchStage(Enum):
    RECALL = "recall"
    RANK = "rank"
    RERANK = "rerank"
    FINAL = "final"


@dataclass
class UnifiedSearchItem:
    id: str
    text: str
    score: float = 0.0
    source: SearchSource = SearchSource.VECTOR
    sources: List[SearchSource] = field(default_factory=list)
    tier: Optional[str] = None
    vector: Optional[List[float]] = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    
    def add_source(self, source: SearchSource):
        if source not in self.sources:
            self.sources.append(source)
        self.source = source


@dataclass
class UnifiedSearchResult:
    items: List[UnifiedSearchItem]
    total_candidates: int
    stage: SearchStage
    elapsed_ms: float = 0.0
    query_understanding: Optional[Dict] = None
    graph_context: Optional[Dict] = None
    recall_stats: Dict[str, int] = field(default_factory=dict)


@dataclass
class SearchConfig:
    coarse_k: int = 100
    fine_k: int = 20
    final_k: int = 10
    
    hot_cache_k: int = 50
    vector_k: int = 50
    keyword_k: int = 30
    graph_k: int = 20
    
    enable_hot_cache: bool = True
    enable_vector: bool = True
    enable_keyword: bool = True
    enable_graph: bool = True
    
    enable_time_decay: bool = True
    enable_rerank: bool = True
    
    fusion_k: int = 60
    
    time_decay_halflife: float = 30.0
    
    weights: Dict[str, float] = field(default_factory=lambda: {
        "relevance": 0.4,
        "recency": 0.2,
        "importance": 0.2,
        "hit_count": 0.1,
        "source_diversity": 0.1
    })


class HotCacheSearcher:
    def __init__(self, tiered_manager):
        self.tiered_manager = tiered_manager
    
    def search(self, query_vector: List[float], top_k: int = 50) -> List[UnifiedSearchItem]:
        hot_items = self.tiered_manager.search_hot(query_vector, top_k)
        
        results = []
        for item in hot_items:
            results.append(UnifiedSearchItem(
                id=item.id,
                text=item.text,
                score=1.0,
                source=SearchSource.HOT_CACHE,
                tier=item.tier.value if hasattr(item.tier, 'value') else str(item.tier),
                vector=item.vector,
                metadata=item.metadata
            ))
        
        return results


class VectorSearcher:
    def __init__(self, store, embedding_module):
        self.store = store
        self.embedding_module = embedding_module
    
    def search(self, query: str, query_vector: List[float] = None, top_k: int = 50) -> List[UnifiedSearchItem]:
        if query_vector is None:
            query_vector = self.embedding_module.embed_text([query])[0]
        
        results = self.store.search(
            query_vector=query_vector,
            query_text=query,
            limit=top_k,
            query_type="vector"
        )
        
        items = []
        for r in results:
            r_dict = r.model_dump() if hasattr(r, 'model_dump') else r
            distance = r_dict.get("_distance", 0.0)
            score = 1.0 - distance if distance <= 1.0 else 1.0 / (1.0 + distance)
            
            items.append(UnifiedSearchItem(
                id=r_dict.get("id", ""),
                text=r_dict.get("text", ""),
                score=score,
                source=SearchSource.VECTOR,
                metadata=r_dict
            ))
        
        return items


class KeywordSearcher:
    def __init__(self, store):
        self.store = store
    
    def search(self, query: str, top_k: int = 30) -> List[UnifiedSearchItem]:
        results = self.store.search(
            query_vector=None,
            query_text=query,
            limit=top_k,
            query_type="fts"
        )
        
        items = []
        for r in results:
            r_dict = r.model_dump() if hasattr(r, 'model_dump') else r
            score = r_dict.get("_score", 0.5)
            
            items.append(UnifiedSearchItem(
                id=r_dict.get("id", ""),
                text=r_dict.get("text", ""),
                score=score,
                source=SearchSource.KEYWORD,
                metadata=r_dict
            ))
        
        return items


class GraphSearcher:
    def __init__(self, graph_retriever, memory_graph):
        self.graph_retriever = graph_retriever
        self.memory_graph = memory_graph
    
    def search(self, query: str, entities: List[str] = None, top_k: int = 20) -> List[UnifiedSearchItem]:
        if not entities:
            return []
        
        items = []
        
        try:
            graph_items = self.graph_retriever.retrieve_with_graph(
                query=query,
                entities=entities,
                top_k=top_k
            )
            
            for item in graph_items:
                if isinstance(item, dict):
                    items.append(UnifiedSearchItem(
                        id=item.get("id", ""),
                        text=item.get("text", ""),
                        score=item.get("score", 0.5),
                        source=SearchSource.GRAPH,
                        metadata=item
                    ))
        except Exception as e:
            logger.warning(f"Graph search failed: {e}")
        
        return items


class ResultFusion:
    @staticmethod
    def reciprocal_rank_fusion(
        result_lists: List[List[UnifiedSearchItem]],
        k: int = 60
    ) -> List[UnifiedSearchItem]:
        scores: Dict[str, Dict] = {}
        
        for result_list in result_lists:
            for rank, item in enumerate(result_list):
                if item.id not in scores:
                    scores[item.id] = {
                        "item": item,
                        "rrf_score": 0.0,
                        "sources": []
                    }
                scores[item.id]["rrf_score"] += 1.0 / (k + rank + 1)
                if item.source not in scores[item.id]["sources"]:
                    scores[item.id]["sources"].append(item.source)
        
        sorted_items = sorted(
            scores.values(),
            key=lambda x: x["rrf_score"],
            reverse=True
        )
        
        result = []
        for entry in sorted_items:
            item = entry["item"]
            item.score = entry["rrf_score"]
            item.sources = entry["sources"]
            result.append(item)
        
        return result
    
    @staticmethod
    def weighted_fusion(
        result_lists: List[Tuple[List[UnifiedSearchItem], float]]
    ) -> List[UnifiedSearchItem]:
        scores: Dict[str, Dict] = {}
        
        for result_list, weight in result_lists:
            for item in result_list:
                if item.id not in scores:
                    scores[item.id] = {
                        "item": item,
                        "score": 0.0,
                        "sources": []
                    }
                scores[item.id]["score"] += item.score * weight
                if item.source not in scores[item.id]["sources"]:
                    scores[item.id]["sources"].append(item.source)
        
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


class TimeDecayScorer:
    def __init__(self, halflife: float = 30.0):
        self.halflife = halflife
    
    def score(self, item: UnifiedSearchItem) -> float:
        date_str = item.metadata.get("date", "")
        days_old = self._calculate_days_old(date_str)
        
        if days_old <= 0:
            return 1.0
        
        decay = math.exp(-days_old * math.log(2) / self.halflife)
        return max(0.1, decay)
    
    def _calculate_days_old(self, date_str: str) -> float:
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
            
            delta = datetime.now(timezone.utc) - memory_date
            return max(0.0, delta.total_seconds() / 86400.0)
        except Exception:
            return 0.0


class ContextAwareScorer:
    def __init__(self, max_history: int = 10):
        self.context_history: List[Dict] = []
        self.max_history = max_history
    
    def add_context(self, query: str, result: Dict):
        self.context_history.append({
            "query": query,
            "result": result,
            "timestamp": datetime.now(timezone.utc).isoformat()
        })
        
        if len(self.context_history) > self.max_history:
            self.context_history.pop(0)
    
    def score(self, item: UnifiedSearchItem, query: str) -> float:
        if not self.context_history:
            return 0.0
        
        query_words = set(query.lower().split())
        context_score = 0.0
        
        for ctx in self.context_history[-5:]:
            ctx_words = set(ctx["query"].lower().split())
            overlap = len(query_words & ctx_words) / max(len(query_words), 1)
            
            if overlap > 0.3:
                ctx_result = ctx.get("result", {})
                if ctx_result.get("id") == item.id:
                    context_score += overlap * 0.5
        
        return min(1.0, context_score)
    
    def clear(self):
        self.context_history.clear()


class UnifiedSearchPipeline:
    def __init__(
        self,
        store,
        embedding_module,
        tiered_manager=None,
        graph_retriever=None,
        memory_graph=None,
        reranker=None,
        config: SearchConfig = None
    ):
        self.config = config or SearchConfig()
        
        self.store = store
        self.embedding_module = embedding_module
        self.tiered_manager = tiered_manager
        self.graph_retriever = graph_retriever
        self.memory_graph = memory_graph
        self.reranker = reranker
        
        self._init_searchers()
        
        self.time_decay_scorer = TimeDecayScorer(self.config.time_decay_halflife)
        self.context_scorer = ContextAwareScorer()
        
        self._executor = ThreadPoolExecutor(max_workers=4)
        self._lock = threading.RLock()
    
    def _init_searchers(self):
        if self.tiered_manager:
            self.hot_cache_searcher = HotCacheSearcher(self.tiered_manager)
        else:
            self.hot_cache_searcher = None
        
        self.vector_searcher = VectorSearcher(self.store, self.embedding_module)
        self.keyword_searcher = KeywordSearcher(self.store)
        
        if self.graph_retriever and self.memory_graph:
            self.graph_searcher = GraphSearcher(self.graph_retriever, self.memory_graph)
        else:
            self.graph_searcher = None
    
    def search(
        self,
        query: str,
        top_k: int = None,
        query_understanding: Dict = None,
        entities: List[str] = None
    ) -> UnifiedSearchResult:
        start_time = time.time()
        
        final_k = top_k or self.config.final_k
        
        query_vector = self.embedding_module.embed_text([query])[0]
        
        recall_items, recall_stats = self._parallel_recall(
            query, query_vector, entities, query_understanding
        )
        
        fused_items = self._fusion(recall_items)
        
        ranked_items = self._rank(fused_items, query, query_vector)
        
        if self.config.enable_rerank and self.reranker and self.reranker.is_available():
            ranked_items = self._rerank(query, ranked_items)
        
        final_items = ranked_items[:final_k]
        
        graph_context = None
        if entities and self.memory_graph:
            graph_context = self._get_graph_context(entities)
        
        elapsed_ms = (time.time() - start_time) * 1000
        
        return UnifiedSearchResult(
            items=final_items,
            total_candidates=len(fused_items),
            stage=SearchStage.FINAL,
            elapsed_ms=elapsed_ms,
            query_understanding=query_understanding,
            graph_context=graph_context,
            recall_stats=recall_stats
        )
    
    def _parallel_recall(
        self,
        query: str,
        query_vector: List[float],
        entities: List[str] = None,
        query_understanding: Dict = None
    ) -> Tuple[List[UnifiedSearchItem], Dict[str, int]]:
        futures = []
        recall_stats = {}
        
        if self.config.enable_hot_cache and self.hot_cache_searcher:
            futures.append(
                (self._executor.submit(
                    self.hot_cache_searcher.search, 
                    query_vector, 
                    self.config.hot_cache_k
                ), "hot_cache")
            )
        
        if self.config.enable_vector:
            futures.append(
                (self._executor.submit(
                    self.vector_searcher.search,
                    query,
                    query_vector,
                    self.config.vector_k
                ), "vector")
            )
        
        if self.config.enable_keyword:
            futures.append(
                (self._executor.submit(
                    self.keyword_searcher.search,
                    query,
                    self.config.keyword_k
                ), "keyword")
            )
        
        if self.config.enable_graph and self.graph_searcher and entities:
            futures.append(
                (self._executor.submit(
                    self.graph_searcher.search,
                    query,
                    entities,
                    self.config.graph_k
                ), "graph")
            )
        
        all_items = []
        for future, source_name in futures:
            try:
                items = future.result(timeout=5.0)
                all_items.extend(items)
                recall_stats[source_name] = len(items)
            except Exception as e:
                logger.warning(f"Recall from {source_name} failed: {e}")
                recall_stats[source_name] = 0
        
        return all_items, recall_stats
    
    def _fusion(self, items: List[UnifiedSearchItem]) -> List[UnifiedSearchItem]:
        if not items:
            return []
        
        source_groups: Dict[SearchSource, List[UnifiedSearchItem]] = {}
        for item in items:
            if item.source not in source_groups:
                source_groups[item.source] = []
            source_groups[item.source].append(item)
        
        result_lists = list(source_groups.values())
        
        return ResultFusion.recipro_rank_fusion(result_lists, k=self.config.fusion_k)
    
    def _rank(
        self,
        items: List[UnifiedSearchItem],
        query: str,
        query_vector: List[float]
    ) -> List[UnifiedSearchItem]:
        if not items:
            return []
        
        now = datetime.now(timezone.utc)
        
        for item in items:
            scores = {}
            
            scores["relevance"] = item.score
            
            if self.config.enable_time_decay:
                scores["recency"] = self.time_decay_scorer.score(item)
            else:
                scores["recency"] = 1.0
            
            scores["importance"] = item.metadata.get("importance_score", 0.5)
            
            hit_count = item.metadata.get("hit_count", 0)
            scores["hit_count"] = min(1.0, hit_count / 10.0)
            
            scores["source_diversity"] = len(item.sources) / 4.0
            
            final_score = sum(
                scores.get(k, 0) * v
                for k, v in self.config.weights.items()
            )
            
            item.score = final_score
        
        items.sort(key=lambda x: x.score, reverse=True)
        
        return items
    
    def _rerank(self, query: str, items: List[UnifiedSearchItem]) -> List[UnifiedSearchItem]:
        if not items or len(items) < 2:
            return items
        
        texts = [item.text for item in items]
        
        try:
            rerank_scores = self.reranker.rerank(query, texts)
            
            for i, item in enumerate(items):
                if i < len(rerank_scores):
                    relevance = rerank_scores[i]
                    decay = self.time_decay_scorer.score(item)
                    item.score = 0.6 * relevance + 0.4 * decay
            
            items.sort(key=lambda x: x.score, reverse=True)
        except Exception as e:
            logger.warning(f"Rerank failed: {e}")
        
        return items
    
    def _get_graph_context(self, entities: List[str]) -> Optional[Dict]:
        if not self.memory_graph or not entities:
            return None
        
        try:
            for entity_name in entities[:2]:
                nodes = self.memory_graph.find_nodes_by_name(entity_name)
                if nodes:
                    return self.memory_graph.get_node_context(nodes[0].id)
        except Exception as e:
            logger.warning(f"Failed to get graph context: {e}")
        
        return None
    
    def search_with_context(
        self,
        query: str,
        context_queries: List[str] = None,
        top_k: int = None
    ) -> UnifiedSearchResult:
        if context_queries:
            for ctx_query in context_queries:
                self.context_scorer.add_context(ctx_query, {})
        
        return self.search(query, top_k)
    
    def get_item_by_id(self, item_id: str) -> Optional[UnifiedSearchItem]:
        if self.tiered_manager:
            tiered_item = self.tiered_manager.get(item_id)
            if tiered_item:
                return UnifiedSearchItem(
                    id=tiered_item.id,
                    text=tiered_item.text,
                    tier=tiered_item.tier.value if hasattr(tiered_item.tier, 'value') else str(tiered_item.tier),
                    metadata=tiered_item.metadata or {}
                )
        
        memory = self.store.get_by_id(item_id)
        if memory:
            m_dict = memory.model_dump() if hasattr(memory, 'model_dump') else memory
            return UnifiedSearchItem(
                id=m_dict.get("id", ""),
                text=m_dict.get("text", ""),
                metadata=m_dict
            )
        
        return None
    
    def update_access(self, item_id: str):
        if self.tiered_manager:
            self.tiered_manager.access(item_id)
    
    def clear_context(self):
        self.context_scorer.clear()
    
    def get_stats(self) -> Dict[str, Any]:
        stats = {
            "config": {
                "coarse_k": self.config.coarse_k,
                "fine_k": self.config.fine_k,
                "final_k": self.config.final_k,
                "enable_hot_cache": self.config.enable_hot_cache,
                "enable_vector": self.config.enable_vector,
                "enable_keyword": self.config.enable_keyword,
                "enable_graph": self.config.enable_graph,
                "enable_rerank": self.config.enable_rerank
            }
        }
        
        if self.tiered_manager:
            stats["tiered"] = self.tiered_manager.get_stats()
        
        return stats
