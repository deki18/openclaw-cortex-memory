import math
from datetime import datetime
from typing import List, Dict, Any
from .embedding import EmbeddingModule
from .vector_store import VectorStore
from .bm25_store import BM25Store
from .reranker import Reranker
from .promotion_engine import PromotionEngine
from .config import CONFIG

class RetrievalPipeline:
    def __init__(self):
        self.embedding_module = EmbeddingModule()
        self.vector_store = VectorStore()
        self.bm25_store = BM25Store()
        self.reranker = Reranker()
        self.promotion = PromotionEngine()
        self.halflife = CONFIG.get("time_decay_halflife", 30)

    def retrieve(self, query: str, top_k: int = 3) -> List[Dict[str, Any]]:
        # 1. Embed query
        query_emb = self.embedding_module.embed_text([query])[0]
        
        # 2. Vector search (Top20)
        vector_results = self.vector_store.query([query_emb], n_results=20)
        
        # 3. BM25 search (Top20)
        bm25_results = self.bm25_store.search(query, top_k=20)
        
        # 4. RRF merge
        merged_results = self._rrf_merge(vector_results, bm25_results)
        
        # 5. Time decay
        decayed_results = self._apply_time_decay(merged_results)
        
        # 6. Reranker
        if not decayed_results:
            return []
            
        texts_to_rerank = [res["document"] for res in decayed_results]
        rerank_scores = self.reranker.rerank(query, texts_to_rerank)
        
        for idx, res in enumerate(decayed_results):
            res["final_score"] = rerank_scores[idx]
            
        # 7. Return Top3
        final_sorted = sorted(decayed_results, key=lambda x: x["final_score"], reverse=True)
        top_results = final_sorted[:top_k]
        self._increment_hit_counts(top_results)
        return top_results

    def _rrf_merge(self, vector_res, bm25_res):
        scores = {}
        docs = {}
        metas = {}
        
        # Process vector results
        if vector_res and vector_res["ids"] and len(vector_res["ids"]) > 0:
            for rank, (doc_id, doc, meta) in enumerate(zip(vector_res["ids"][0], vector_res["documents"][0], vector_res["metadatas"][0])):
                scores[doc_id] = scores.get(doc_id, 0) + 1.0 / (60 + rank + 1)
                docs[doc_id] = doc
                metas[doc_id] = meta
                
        # Process BM25 results
        for rank, res in enumerate(bm25_res):
            doc_id = res["id"]
            scores[doc_id] = scores.get(doc_id, 0) + 1.0 / (60 + rank + 1)
            docs[doc_id] = res["document"]
            metas[doc_id] = res["metadata"]
            
        merged = []
        for doc_id, score in scores.items():
            merged.append({
                "id": doc_id,
                "document": docs[doc_id],
                "metadata": metas[doc_id],
                "rrf_score": score
            })
            
        return sorted(merged, key=lambda x: x["rrf_score"], reverse=True)

    def _apply_time_decay(self, results):
        now = datetime.utcnow()
        for res in results:
            meta = res["metadata"]
            score = res["rrf_score"]
            
            if meta.get("type") != "core_rule":
                try:
                    date_str = meta.get("date", now.isoformat())
                    # Handle basic ISO format parsing
                    if date_str.endswith('Z'):
                        date_str = date_str[:-1]
                    doc_date = datetime.fromisoformat(date_str)
                    delta_t = (now - doc_date).days
                    if delta_t > 0:
                        score = score * math.exp(-delta_t / self.halflife)
                except Exception as e:
                    pass # Ignore parsing errors
            
            res["decayed_score"] = score
        
        return sorted(results, key=lambda x: x["decayed_score"], reverse=True)

    def _increment_hit_counts(self, results: List[Dict[str, Any]]):
        ids = []
        metadatas = []
        for res in results:
            meta = res.get("metadata") or {}
            hit_count = int(meta.get("hit_count") or 0) + 1
            meta["hit_count"] = hit_count
            promoted = False
            if meta.get("type") != "core_rule":
                promoted = self.promotion.check_and_promote(hit_count, res.get("document", ""))
            if promoted:
                meta["type"] = "core_rule"
            doc_id = res.get("id")
            if doc_id:
                ids.append(doc_id)
                metadatas.append(meta)
            res["metadata"] = meta
        self.vector_store.update_metadatas(ids, metadatas)
        self.bm25_store.update_metadatas(ids, metadatas)
