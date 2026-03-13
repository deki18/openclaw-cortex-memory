import logging
import os
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from .config import get_config
from .embedding import EmbeddingModule
from .lancedb_store import LanceDBStore, get_memory_model
from .llm_client import LLMClient
from .reranker import Reranker

from .chunking import SemanticChunker
from .chunking.llm_extractor import LLMExtractor, MetadataEnricher
from .dedup import ThreeStageDeduplicator
from .quality import MemoryQualityEvaluator, MemoryQuality, QualityLevel
from .queue import AsyncWriteQueue, WriteBuffer, BatchEmbeddingProcessor
from .retrieval import (
    TimeDecayCalculator, DecayConfig, DecayConfigBuilder,
    QueryUnderstandingPipeline, QueryUnderstanding,
    UnifiedSearchPipeline, SearchConfig, UnifiedSearchItem
)
from .storage import (
    TieredMemoryManager, TierConfig, TieredMemoryItem, MemoryTier,
    LayeredMemoryStorage, StorageLevel
)
from .graph import EnhancedMemoryGraph, GraphEnhancedRetriever
from .models.memory_unit import (
    StructuredSummary, SystemMetadata, Chunk,
    L0MemoryUnit, L1MemoryUnit, L2MemoryUnit
)
from .preprocess import TextPreprocessor, PreprocessConfig

logger = logging.getLogger(__name__)


@dataclass
class WriteResult:
    success: bool
    memory_id: Optional[str] = None
    level: Optional[str] = None
    quality: Optional[MemoryQuality] = None
    is_duplicate: bool = False
    error: Optional[str] = None


@dataclass
class SearchResult:
    items: List[Dict[str, Any]]
    total: int
    query_understanding: Optional[QueryUnderstanding] = None
    elapsed_ms: float = 0.0
    graph_context: Optional[Dict] = None


class EnhancedMemoryController:
    """增强型记忆控制器 - 重构版
    
    数据流：
    0. 原始文本 → 文本预处理
    1. 预处理文本 → LLM结构化摘要提取
    2. 结构化摘要 → 质量评估
    3. 原文 → 向量嵌入
    4. 向量 → 三阶段去重检测
    5. 完整数据包 → 分层存储（元数据只在最高层级）
    6. 数据包 → LanceDB存储
    7. memory_id → 去重索引添加
    8. memory_id → 冷热分层
    9. entities → 知识图谱
    """
    
    def __init__(self, config: dict = None):
        config = config or get_config()
        self.config = config
        
        self.store = LanceDBStore()
        self.embedding_module = EmbeddingModule()
        self.llm_client = LLMClient()
        self.reranker = Reranker()
        
        self.chunker = SemanticChunker(config.get("chunk", {}))
        self.llm_extractor = LLMExtractor(config)
        self.metadata_enricher = MetadataEnricher(self.llm_extractor)
        
        data_dir = config.get("data_dir", "./data")
        os.makedirs(data_dir, exist_ok=True)
        
        dedup_config = config.get("dedup", {})
        dedup_config["persist_path"] = dedup_config.get(
            "persist_path", 
            os.path.join(data_dir, "dedup_cache.json")
        )
        self.deduplicator = ThreeStageDeduplicator(dedup_config)
        
        self.quality_evaluator = MemoryQualityEvaluator(
            config.get("quality", {}),
            embedding_module=self.embedding_module,
            store=self.store
        )
        
        self.write_queue = AsyncWriteQueue(
            max_workers=config.get("write_workers", 2),
            batch_size=config.get("write_batch_size", 20)
        )
        self.write_buffer = WriteBuffer(
            max_size=config.get("buffer_size", 100),
            flush_interval=config.get("flush_interval", 2.0)
        )
        self.batch_embedding_processor = BatchEmbeddingProcessor(
            self.embedding_module,
            batch_size=config.get("embedding_batch_size", 20)
        )
        
        decay_config = DecayConfigBuilder.from_dict(config.get("decay", {}))
        self.time_decay = TimeDecayCalculator(decay_config)
        
        self.query_understanding = QueryUnderstandingPipeline()
        
        tier_config = TierConfig(
            hot_max_items=config.get("tier_hot_max", 100),
            warm_max_items=config.get("tier_warm_max", 1000)
        )
        self.tiered_manager = TieredMemoryManager(self.store, tier_config)
        
        self.memory_graph = EnhancedMemoryGraph(config.get("graph", {}))
        self.graph_retriever = GraphEnhancedRetriever(
            self.memory_graph,
            self.store,
            config.get("graph", {})
        )
        
        search_config = SearchConfig(
            coarse_k=config.get("search_coarse_k", 100),
            fine_k=config.get("search_fine_k", 20),
            final_k=config.get("search_final_k", 10),
            enable_hot_cache=config.get("search_enable_hot_cache", True),
            enable_vector=config.get("search_enable_vector", True),
            enable_keyword=config.get("search_enable_keyword", True),
            enable_graph=config.get("search_enable_graph", True),
            enable_rerank=config.get("search_enable_rerank", True),
            time_decay_halflife=config.get("time_decay_halflife", 30.0)
        )
        self.unified_search = UnifiedSearchPipeline(
            store=self.store,
            embedding_module=self.embedding_module,
            tiered_manager=self.tiered_manager,
            graph_retriever=self.graph_retriever,
            memory_graph=self.memory_graph,
            reranker=self.reranker,
            config=search_config
        )
        
        layered_config = config.get("layered", {})
        layered_config["persist_path"] = layered_config.get(
            "persist_path",
            os.path.join(data_dir, "layered_storage.json")
        )
        self.layered_storage = LayeredMemoryStorage(layered_config)
        
        preprocess_config = config.get("preprocess", {})
        self.preprocessor = TextPreprocessor(PreprocessConfig(
            remove_extra_whitespace=preprocess_config.get("remove_extra_whitespace", True),
            normalize_newlines=preprocess_config.get("normalize_newlines", True),
            remove_html_tags=preprocess_config.get("remove_html_tags", True),
            normalize_unicode=preprocess_config.get("normalize_unicode", True),
            remove_control_chars=preprocess_config.get("remove_control_chars", True),
            min_text_length=preprocess_config.get("min_text_length", 1),
            max_text_length=preprocess_config.get("max_text_length", 100000)
        ))
        
        self.enable_chunking = config.get("enable_chunking", False)
        
        self._lock = threading.RLock()
        self._started = False

    def start(self):
        if self._started:
            return
        
        self.write_queue.set_processor(self._process_write_task)
        self.write_queue.start()
        self._started = True
        logger.info("EnhancedMemoryController started")

    def stop(self):
        if not self._started:
            return
        
        self.write_queue.stop()
        self._started = False
        logger.info("EnhancedMemoryController stopped")

    def write_memory(
        self,
        text: str,
        source: str = "manual",
        metadata: dict = None,
        async_write: bool = False
    ) -> WriteResult:
        if not text or not text.strip():
            return WriteResult(
                success=False,
                error="Empty text provided"
            )
        
        text = self.preprocessor.preprocess(text)
        if not text:
            return WriteResult(
                success=False,
                error="Text preprocessing failed or text is empty after preprocessing"
            )
        
        system_metadata = SystemMetadata.create(
            source=source,
            quality_level="medium"
        )
        
        structured_summary = self.llm_extractor.extract(text)
        
        quality = self.quality_evaluator.evaluate(text, {
            "structured_summary": structured_summary.to_dict()
        })
        
        if not quality.should_store:
            return WriteResult(
                success=False,
                quality=quality,
                error=f"Quality below threshold: {quality.score.overall:.2f}"
            )
        
        system_metadata.quality_level = quality.score.level.value
        
        vector = self.embedding_module.embed_text([text])[0]
        
        dedup_result = self.deduplicator.check_duplicate(text, vector)
        if dedup_result.is_duplicate:
            logger.info(f"Duplicate memory detected, similar to: {dedup_result.similar_memory_id}")
            return WriteResult(
                success=False,
                is_duplicate=True,
                quality=quality,
                error=f"Duplicate of existing memory: {dedup_result.similar_memory_id}"
            )
        
        chunks = None
        if self.enable_chunking and len(text) > 500:
            chunks = self._create_chunks(text)
        
        if async_write:
            task_id = self.write_queue.submit(
                text, structured_summary, system_metadata, vector, chunks, quality
            )
            return WriteResult(
                success=True,
                memory_id=task_id,
                quality=quality
            )
        
        return self._write_sync(
            text, structured_summary, system_metadata, vector, chunks, quality
        )

    def _create_chunks(self, text: str) -> List[Chunk]:
        semantic_chunks = self.chunker.chunk(text)
        
        chunk_texts = [c.text for c in semantic_chunks]
        chunk_vectors = self.embedding_module.embed_text(chunk_texts)
        
        chunks = []
        for i, (semantic_chunk, chunk_vector) in enumerate(zip(semantic_chunks, chunk_vectors)):
            chunk = Chunk.create(
                parent_id="",
                text=semantic_chunk.text,
                vector=chunk_vector,
                position=i,
                start_pos=semantic_chunk.start_pos,
                end_pos=semantic_chunk.end_pos
            )
            chunks.append(chunk)
        
        return chunks

    def _write_sync(
        self,
        text: str,
        structured_summary: StructuredSummary,
        system_metadata: SystemMetadata,
        vector: List[float],
        chunks: List[Chunk],
        quality: MemoryQuality
    ) -> WriteResult:
        try:
            memory_id, level = self.layered_storage.store_memory(
                text=text,
                structured_summary=structured_summary,
                vector=vector,
                metadata=system_metadata,
                chunks=chunks
            )
            
            if chunks:
                for chunk in chunks:
                    chunk.parent_id = memory_id
            
            MemoryModel = get_memory_model()
            memory = MemoryModel(
                id=memory_id,
                vector=vector,
                text=text,
                type=structured_summary.category,
                date=datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                agent=system_metadata.agent,
                source_file=system_metadata.source,
                hit_count=0,
                weight=int(structured_summary.importance_score * 10)
            )
            
            self.store.add_memories([memory])
            
            if chunks:
                for chunk in chunks:
                    chunk_memory = MemoryModel(
                        id=chunk.id,
                        vector=chunk.vector,
                        text=chunk.text,
                        type="chunk",
                        date=datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                        agent="openclaw",
                        source_file=memory_id,
                        hit_count=0,
                        weight=0
                    )
                    self.store.add_memories([chunk_memory])
            
            self.deduplicator.add(memory_id, text, vector)
            
            tiered_item = TieredMemoryItem(
                id=memory_id,
                text=text,
                tier=MemoryTier.HOT if structured_summary.importance_score >= 0.7 else MemoryTier.WARM,
                importance_score=structured_summary.importance_score,
                metadata={"level": level.value},
                vector=vector
            )
            self.tiered_manager.put(tiered_item)
            
            entities = structured_summary.entities
            for entity in entities[:5]:
                self.memory_graph.add_node(
                    node_id=f"entity:{entity}",
                    node_type="entity",
                    name=entity,
                    memory_id=memory_id
                )
            
            logger.info(f"Memory saved: {memory_id}, level={level.value}, chunks={len(chunks) if chunks else 0}")
            
            return WriteResult(
                success=True,
                memory_id=memory_id,
                level=level.value,
                quality=quality
            )
        
        except Exception as e:
            logger.error(f"Failed to write memory: {e}")
            return WriteResult(
                success=False,
                error=str(e)
            )

    def _process_write_task(
        self, 
        text: str, 
        structured_summary: StructuredSummary,
        system_metadata: SystemMetadata,
        vector: List[float],
        chunks: List[Chunk],
        quality: MemoryQuality
    ):
        if vector is None:
            vector = self.embedding_module.embed_text([text])[0]
        
        result = self._write_sync(text, structured_summary, system_metadata, vector, chunks, quality)
        return result.memory_id

    def write_batch(
        self,
        texts: List[str],
        source: str = "batch",
        common_metadata: dict = None
    ) -> List[WriteResult]:
        results = []
        
        preprocessed_texts = []
        for text in texts:
            preprocessed = self.preprocessor.preprocess(text)
            if preprocessed:
                preprocessed_texts.append(preprocessed)
            else:
                results.append(WriteResult(
                    success=False,
                    error="Text preprocessing failed or text is empty after preprocessing"
                ))
        
        if not preprocessed_texts:
            return results
        
        structured_summaries = self.llm_extractor.batch_extract(preprocessed_texts)
        
        qualities = []
        for i, (text, summary) in enumerate(zip(preprocessed_texts, structured_summaries)):
            quality = self.quality_evaluator.evaluate(text, {
                "structured_summary": summary.to_dict()
            })
            qualities.append(quality)
        
        vectors = self.batch_embedding_processor.process_batch(preprocessed_texts)
        
        for i, (text, quality, summary, vector) in enumerate(
            zip(preprocessed_texts, qualities, structured_summaries, vectors)
        ):
            if not quality.should_store:
                results.append(WriteResult(
                    success=False,
                    quality=quality,
                    error=f"Quality below threshold: {quality.score.overall:.2f}"
                ))
                continue
            
            system_metadata = SystemMetadata.create(
                source=source,
                quality_level=quality.score.level.value
            )
            if common_metadata:
                system_metadata.batch_id = common_metadata.get("batch_id", "")
            
            chunks = None
            if self.enable_chunking and len(text) > 500:
                chunks = self._create_chunks(text)
            
            result = self._write_sync(text, summary, system_metadata, vector, chunks, quality)
            results.append(result)
        
        return results

    def search(
        self,
        query: str,
        top_k: int = 10,
        use_graph: bool = True,
        use_tier: bool = True
    ) -> SearchResult:
        import time
        start_time = time.time()
        
        understanding = self.query_understanding.understand(query)
        
        entities = None
        if use_graph and understanding.entities:
            entities = [e.text for e in understanding.entities]
        
        search_result = self.unified_search.search(
            query=query,
            top_k=top_k,
            query_understanding={
                "intent": understanding.intent.value,
                "entities": entities or [],
                "keywords": understanding.keywords
            },
            entities=entities
        )
        
        final_items = []
        for item in search_result.items:
            final_items.append({
                "id": item.id,
                "text": item.text,
                "score": item.score,
                "source": item.source.value if hasattr(item.source, 'value') else str(item.source),
                "sources": [s.value if hasattr(s, 'value') else str(s) for s in item.sources],
                "tier": item.tier,
                "metadata": item.metadata
            })
        
        for item in final_items:
            memory_id = item.get("id")
            if memory_id:
                self.unified_search.update_access(memory_id)
                
                metadata = self.layered_storage.get_metadata(memory_id)
                if metadata:
                    metadata.update_access()
        
        return SearchResult(
            items=final_items,
            total=search_result.total_candidates,
            query_understanding=understanding,
            elapsed_ms=search_result.elapsed_ms,
            graph_context=search_result.graph_context
        )

    def search_with_expansion(
        self,
        query: str,
        top_k: int = 10
    ) -> SearchResult:
        understanding = self.query_understanding.understand(query)
        
        if understanding.entities:
            expanded_queries = [query] + understanding.expanded_queries
            
            search_result = self.unified_search.search_with_context(
                query=query,
                context_queries=expanded_queries[:3],
                top_k=top_k
            )
            
            final_items = []
            for item in search_result.items:
                final_items.append({
                    "id": item.id,
                    "text": item.text,
                    "score": item.score,
                    "source": item.source.value if hasattr(item.source, 'value') else str(item.source),
                    "metadata": item.metadata
                })
            
            return SearchResult(
                items=final_items,
                total=search_result.total_candidates,
                query_understanding=understanding,
                elapsed_ms=search_result.elapsed_ms
            )
        
        return self.search(query, top_k)

    def get_memory(self, memory_id: str) -> Optional[Dict[str, Any]]:
        item = self.unified_search.get_item_by_id(memory_id)
        if item:
            metadata = self.layered_storage.get_metadata(memory_id)
            structured_summary = self.layered_storage.get_structured_summary(memory_id)
            
            result = {
                "id": item.id,
                "text": item.text,
                "tier": item.tier,
                "metadata": item.metadata
            }
            
            if metadata:
                result["metadata"] = metadata.to_dict()
            
            if structured_summary:
                result["structured_summary"] = structured_summary.to_dict()
            
            return result
        
        return None

    def get_memory_context(self, memory_id: str) -> Dict[str, Any]:
        context = self.layered_storage.get_hierarchy(memory_id)
        
        related = self.graph_retriever.find_related_memories(memory_id, max_related=5)
        context["related_memories"] = related
        
        chunk_ids = self.layered_storage.get_chunks(memory_id)
        if chunk_ids:
            context["chunks"] = []
            for chunk_id in chunk_ids:
                chunk_memory = self.store.get_by_id(chunk_id)
                if chunk_memory:
                    chunk_dict = chunk_memory.model_dump() if hasattr(chunk_memory, 'model_dump') else chunk_memory
                    context["chunks"].append({
                        "id": chunk_id,
                        "text": chunk_dict.get("text", "")[:200]
                    })
        
        metadata = self.layered_storage.get_metadata(memory_id)
        if metadata:
            context["metadata"] = metadata.to_dict()
        
        structured_summary = self.layered_storage.get_structured_summary(memory_id)
        if structured_summary:
            context["structured_summary"] = structured_summary.to_dict()
        
        return context

    def delete_memory(self, memory_id: str) -> bool:
        try:
            chunk_ids = self.layered_storage.get_chunks(memory_id)
            for chunk_id in chunk_ids:
                self.store.delete_by_id(chunk_id)
            
            self.store.delete_by_id(memory_id)
            self.deduplicator.remove(memory_id)
            self.tiered_manager.hot_cache.remove(memory_id)
            self.tiered_manager.warm_store.remove(memory_id)
            self.layered_storage.remove(memory_id)
            
            return True
        except Exception as e:
            logger.error(f"Failed to delete memory {memory_id}: {e}")
            return False

    def get_stats(self) -> Dict[str, Any]:
        return {
            "store": {
                "total_memories": self.store.count()
            },
            "tiered": self.tiered_manager.get_stats(),
            "layered": self.layered_storage.get_stats(),
            "graph": self.memory_graph.get_stats(),
            "dedup": self.deduplicator.get_stats(),
            "write_queue": self.write_queue.get_stats()
        }

    def run_maintenance(self):
        self.tiered_manager.run_maintenance()
        self.write_queue.clear_completed()
        logger.debug("Maintenance completed")
