import json
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
    LayeredMemoryStorage, StorageLevel, CoreRulesCache
)
from .graph import EnhancedMemoryGraph, GraphEnhancedRetriever
from .models.memory_unit import (
    StructuredSummary, SystemMetadata, Chunk,
    L0MemoryUnit, L1MemoryUnit, L2MemoryUnit
)
from .preprocess import TextPreprocessor, PreprocessConfig
from .episodic_memory import EpisodicMemory
from .episodic.session_manager import SessionManager
from .models.episodic_event import EpisodicEvent
from .write_pipeline import WritePipeline

logger = logging.getLogger(__name__)

_controller_instance: Optional["EnhancedMemoryController"] = None
_controller_lock = threading.Lock()


def get_controller(config: dict = None) -> "EnhancedMemoryController":
    global _controller_instance
    if _controller_instance is None:
        with _controller_lock:
            if _controller_instance is None:
                _controller_instance = EnhancedMemoryController(config)
    return _controller_instance


def reset_controller():
    global _controller_instance
    with _controller_lock:
        if _controller_instance is not None:
            try:
                _controller_instance.stop()
            except Exception:
                pass
        _controller_instance = None


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
        
        self.episodic = EpisodicMemory()
        self._session_manager = SessionManager(
            self.episodic, 
            self.llm_client,
            on_session_end=self._on_session_end
        )
        
        self.write_pipeline = WritePipeline()
        
        cortex_rules_path = os.path.join(data_dir, "CORTEX_RULES.md")
        local_cortex_rules_path = os.path.join(os.path.dirname(__file__), "..", "data", "memory", "CORTEX_RULES.md")
        self.core_rules_cache = CoreRulesCache(cortex_rules_path, local_cortex_rules_path)
        
        self._lock = threading.RLock()
        self._started = False
        self._session_end_sync_enabled: Optional[bool] = None

    def start(self):
        if self._started:
            return
        
        self.write_queue.set_processor(self._process_write_task)
        self.write_queue.start()
        
        if self.core_rules_cache.load():
            logger.info("Core rules cache loaded successfully")
            if hasattr(self.unified_search, 'core_rules_searcher') and self.unified_search.core_rules_searcher:
                self.unified_search.core_rules_searcher.set_core_rules_cache(self.core_rules_cache)
                self.unified_search.core_rules_searcher.load()
        
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
        async_write: bool = False,
        role: str = "user",
        session_id: str = None
    ) -> WriteResult:
        if not text or not text.strip():
            return WriteResult(
                success=False,
                error="Empty text provided"
            )
        
        self._session_manager.add_message(role, text, None, session_id=session_id)
        
        preprocessed = self.preprocessor.preprocess(text)
        if not preprocessed:
            return WriteResult(
                success=False,
                error="Text preprocessing failed or text is empty after preprocessing"
            )
        
        try:
            structured_summary = self.llm_extractor.extract(preprocessed)
        except Exception as e:
            logger.warning(f"LLM extraction failed, using fallback: {e}")
            structured_summary = StructuredSummary(
                summary_text=preprocessed[:500],
                category="other",
                importance_score=0.5,
                entities=[],
                key_facts=[]
            )
        
        quality = self.quality_evaluator.evaluate(preprocessed, {
            "structured_summary": structured_summary.to_dict()
        })
        
        if not quality.should_store:
            logger.debug(f"Memory not stored due to low quality: {quality.score.overall:.2f}")
            return WriteResult(
                success=False,
                quality=quality,
                error=f"Quality below threshold: {quality.score.overall:.2f}"
            )
        
        summary_text = structured_summary.summary_text or preprocessed[:500]
        dedup_result = self.deduplicator.check_duplicate(summary_text, None)
        if dedup_result.is_duplicate:
            logger.debug(f"Duplicate memory detected: {dedup_result.similar_memory_id}")
            return WriteResult(
                success=False,
                is_duplicate=True,
                quality=quality,
                error=f"Duplicate of existing memory: {dedup_result.similar_memory_id}"
            )
        
        vector = self.embedding_module.embed_text([preprocessed])[0]
        
        system_metadata = SystemMetadata.create(
            source=source,
            quality_level=quality.score.level.value
        )
        if metadata:
            if metadata.get("agent"):
                system_metadata.agent = metadata["agent"]
        
        chunks = None
        if self.enable_chunking and len(preprocessed) > 500:
            chunks = self._create_chunks(preprocessed)
        
        if async_write:
            self.write_queue.submit(
                preprocessed, 
                structured_summary, 
                system_metadata, 
                vector, 
                chunks, 
                quality
            )
            return WriteResult(
                success=True,
                memory_id=None,
                quality=quality
            )
        
        result = self._write_sync(preprocessed, structured_summary, system_metadata, vector, chunks, quality)
        if result.success and result.memory_id:
            self._session_manager.set_last_message_memory_id(result.memory_id, session_id=session_id)
        return result

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
                category=structured_summary.category,
                date=datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                agent=system_metadata.agent,
                source=system_metadata.source,
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
                        category="chunk",
                        date=datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                        agent="openclaw",
                        source=memory_id,
                        hit_count=0,
                        weight=0
                    )
                    self.store.add_memories([chunk_memory])
            
            self.deduplicator.add(memory_id, structured_summary.summary_text or text[:500], vector)
            
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
                entity_text = entity.text if hasattr(entity, 'text') else str(entity)
                self.memory_graph.add_node(
                    node_id=f"entity:{entity_text}",
                    node_type="entity",
                    name=entity_text,
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
        
        texts_to_embed = []
        indices_to_embed = []
        for i, (text, quality, summary) in enumerate(zip(preprocessed_texts, qualities, structured_summaries)):
            if quality.should_store:
                summary_text = summary.summary_text or text[:500]
                dedup_result = self.deduplicator.check_duplicate(summary_text, None)
                if not dedup_result.is_duplicate:
                    texts_to_embed.append(text)
                    indices_to_embed.append(i)
                else:
                    results.append(WriteResult(
                        success=False,
                        is_duplicate=True,
                        quality=quality,
                        error=f"Duplicate of existing memory: {dedup_result.similar_memory_id}"
                    ))
            else:
                results.append(WriteResult(
                    success=False,
                    quality=quality,
                    error=f"Quality below threshold: {quality.score.overall:.2f}"
                ))
        
        if not texts_to_embed:
            return results
        
        vectors = self.batch_embedding_processor.process_batch(texts_to_embed)
        
        for j, (text_idx, vector) in enumerate(zip(indices_to_embed, vectors)):
            text = preprocessed_texts[text_idx]
            quality = qualities[text_idx]
            summary = structured_summaries[text_idx]
            
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

    def should_search(self, query: str) -> bool:
        if not query or not query.strip():
            return False
        
        query_stripped = query.strip()
        
        GREETINGS = {
            "hi", "hello", "hey", "hiya", "yo", "howdy",
            "你好", "您好", "嗨", "哈喽", "喂",
            "早上好", "下午好", "晚上好", "早安", "晚安",
            "good morning", "good afternoon", "good evening",
        }
        
        if query_stripped.lower() in GREETINGS:
            return False
        
        SIMPLE_RESPONSES = {
            "ok", "okay", "yes", "no", "sure", "thanks", "thx",
            "好的", "好", "嗯", "行", "可以", "谢谢", "感谢",
            "明白", "知道了", "了解", "收到",
            "继续", "好的继续", "请继续",
        }
        
        if query_stripped.lower() in SIMPLE_RESPONSES:
            return False
        
        if len(query_stripped) < 3:
            return False
        
        NO_SEARCH_PATTERNS = [
            r'^[.。,，!！?？;；:：]+$',  # 纯标点
            r'^[\d\s]+$',  # 纯数字
            r'^[a-zA-Z]$',  # 单个字母
        ]
        
        import re
        for pattern in NO_SEARCH_PATTERNS:
            if re.match(pattern, query_stripped):
                return False
        
        return True

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
        entity_types = None
        if use_graph and understanding.entities:
            entities = understanding.get_entity_texts()
            entity_types = understanding.get_entity_types()
        
        search_result = self.unified_search.search(
            query=query,
            top_k=top_k,
            query_understanding=understanding.to_dict(),
            entities=entities,
            entity_types=entity_types,
            search_strategy=understanding.search_strategy
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
            search_result = self.unified_search.search_with_context(
                query=query,
                context_queries=[query],
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
    
    def end_session(self, session_id: str = None, sync_records: bool = None) -> List[EpisodicEvent]:
        if not self._session_manager:
            return []
        
        self._session_end_sync_enabled = sync_records
        events = self._session_manager.end_session(session_id=session_id)
        
        for event in events:
            self._update_graph_from_event(event)
        
        self._session_end_sync_enabled = None
        logger.info(f"Session ended, {len(events)} events generated")
        return events
    
    def start_session(self, session_id: str = None):
        if self._session_manager:
            return self._session_manager.start_session(session_id)
        return None
    
    def _update_graph_from_event(self, event: EpisodicEvent):
        if not event.entities:
            return
        
        try:
            for entity_name in event.entities:
                node, warnings = self.memory_graph.add_node(
                    node_type="Entity",
                    name=entity_name,
                    memory_id=event.id,
                    validate=False
                )
                if warnings:
                    logger.debug(f"Node warnings for {entity_name}: {warnings}")
            
            if len(event.entities) >= 2:
                for i, source in enumerate(event.entities):
                    for target in event.entities[i+1:]:
                        source_nodes = self.memory_graph.find_nodes_by_name(source, fuzzy=False)
                        target_nodes = self.memory_graph.find_nodes_by_name(target, fuzzy=False)
                        
                        if source_nodes and target_nodes:
                            edge, errors = self.memory_graph.add_edge(
                                source_id=source_nodes[0].id,
                                target_id=target_nodes[0].id,
                                relation_type="co_occurred_with",
                                weight=1.0,
                                evidence=event.id,
                                validate=False
                            )
                            if errors:
                                logger.debug(f"Edge creation skipped: {errors}")
            
            logger.debug(f"Updated graph with {len(event.entities)} entities from event {event.id}")
        except Exception as e:
            logger.warning(f"Failed to update graph from event: {e}")
    
    def store_event(
        self,
        summary: str,
        memory_id: str = None,
        entities: list = None,
        relations: list = None,
        outcome: str = ""
    ) -> Optional[str]:
        if not summary or not summary.strip():
            logger.warning("Empty summary provided, skipping event storage")
            return None
        
        try:
            entity_refs = []
            entity_nodes = {}
            
            if entities:
                for entity in entities:
                    if isinstance(entity, dict):
                        entity_text = entity.get("name") or entity.get("text") or str(entity)
                        entity_type = entity.get("type", "Entity")
                        entity_attrs = entity.get("attributes", {})
                    else:
                        entity_text = str(entity)
                        entity_type = "Entity"
                        entity_attrs = {}
                    
                    node, warnings = self.memory_graph.add_node(
                        node_type=entity_type,
                        name=entity_text,
                        attributes=entity_attrs,
                        memory_id=memory_id,
                        validate=False
                    )
                    
                    if node:
                        entity_refs.append(entity_text)
                        entity_nodes[entity_text] = node
                    if warnings:
                        logger.debug(f"Entity node warnings: {warnings}")
            
            if relations:
                for rel in relations:
                    if isinstance(rel, dict):
                        source = rel.get("source")
                        target = rel.get("target")
                        relation_type = rel.get("type") or rel.get("relation")
                        weight = rel.get("weight", 1.0)
                    else:
                        source, target, relation_type = rel
                        weight = 1.0
                    
                    if source and target and relation_type:
                        source_node = entity_nodes.get(source) or self.memory_graph.find_nodes_by_name(source, fuzzy=False)
                        target_node = entity_nodes.get(target) or self.memory_graph.find_nodes_by_name(target, fuzzy=False)
                        
                        source_id = source_node.id if hasattr(source_node, 'id') else (source_node[0].id if source_node else None)
                        target_id = target_node.id if hasattr(target_node, 'id') else (target_node[0].id if target_node else None)
                        
                        if source_id and target_id:
                            edge, errors = self.memory_graph.add_edge(
                                source_id=source_id,
                                target_id=target_id,
                                relation_type=relation_type,
                                weight=weight,
                                evidence=memory_id,
                                validate=False
                            )
                            if errors:
                                logger.debug(f"Relation edge warnings: {errors}")
            
            event_id = self.episodic.store_event(
                summary=summary,
                memory_id=memory_id,
                entity_refs=entity_refs,
                outcome=outcome
            )
            
            return event_id
        except Exception as e:
            logger.error(f"Failed to store event: {e}")
            return None
    
    def get_events(self, limit: int = 100) -> List[Dict[str, Any]]:
        try:
            return self.episodic.load_events(limit=limit)
        except Exception as e:
            logger.error(f"Failed to get events: {e}")
            return []
    
    def query_graph(self, entity: str) -> List[Dict[str, Any]]:
        try:
            nodes = self.memory_graph.find_nodes_by_name(entity)
            results = []
            for node in nodes:
                neighbors = self.memory_graph.get_connected_nodes(node.id)
                for neighbor, edge in neighbors:
                    results.append({
                        "source": node.name,
                        "source_type": node.node_type,
                        "target": neighbor.name,
                        "target_type": neighbor.node_type,
                        "relation": edge.relation_type,
                        "weight": edge.weight
                    })
            return results
        except Exception as e:
            logger.error(f"Failed to query graph: {e}")
            return []
    
    def get_graph_stats(self) -> Dict[str, Any]:
        try:
            return self.memory_graph.get_stats()
        except Exception as e:
            logger.error(f"Failed to get graph stats: {e}")
            return {}
    
    def validate_graph(self) -> Dict[str, Any]:
        try:
            result = self.memory_graph.validate_graph()
            return {
                "valid": result.valid,
                "errors": result.errors,
                "warnings": result.warnings
            }
        except Exception as e:
            logger.error(f"Failed to validate graph: {e}")
            return {"valid": False, "errors": [str(e)], "warnings": []}
    
    def get_schema_types(self) -> List[str]:
        try:
            return self.memory_graph.schema.get_all_types()
        except Exception as e:
            logger.error(f"Failed to get schema types: {e}")
            return []
    
    def get_schema_relations(self) -> List[str]:
        try:
            return self.memory_graph.schema.get_all_relations()
        except Exception as e:
            logger.error(f"Failed to get schema relations: {e}")
            return []
    
    def get_hot_context(self, limit: int = 20) -> List[Dict[str, Any]]:
        try:
            hot_items = self.tiered_manager.hot_cache.get_recent(limit)
            return [
                {
                    "id": item.id,
                    "text": item.text[:500] if len(item.text) > 500 else item.text,
                    "importance_score": item.importance_score
                }
                for item in hot_items
            ]
        except Exception as e:
            logger.error(f"Failed to get hot context: {e}")
            return []
    
    def reflect(self) -> Dict[str, Any]:
        from .reflection_engine import ReflectionEngine
        try:
            engine = ReflectionEngine()
            engine.reflect()
            
            if self.core_rules_cache.reload():
                if hasattr(self.unified_search, 'core_rules_searcher') and self.unified_search.core_rules_searcher:
                    self.unified_search.core_rules_searcher.reload()
            
            logger.info("Memory reflection completed")
            return {"status": "ok", "message": "Reflection completed"}
        except Exception as e:
            logger.error(f"Reflection failed: {e}")
            return {"status": "error", "message": str(e)}
    
    def promote(self) -> Dict[str, Any]:
        from .promotion_engine import PromotionEngine
        try:
            engine = PromotionEngine()
            promoted_count = 0
            
            all_memories = self.store.list_all(limit=1000)
            for memory in all_memories:
                memory_dict = memory.model_dump() if hasattr(memory, 'model_dump') else memory
                hit_count = memory_dict.get("hit_count", 0)
                text = memory_dict.get("text", "")
                
                if engine.check_and_promote(hit_count, text):
                    promoted_count += 1
            
            if self.core_rules_cache.reload():
                if hasattr(self.unified_search, 'core_rules_searcher') and self.unified_search.core_rules_searcher:
                    self.unified_search.core_rules_searcher.reload()
            
            logger.info(f"Promoted {promoted_count} memories to core rules")
            return {"status": "ok", "promoted_count": promoted_count}
        except Exception as e:
            logger.error(f"Promotion failed: {e}")
            return {"status": "error", "message": str(e)}
    
    def _on_session_end(self, session_id: str):
        sync_enabled = self._session_end_sync_enabled
        if sync_enabled is None:
            sync_enabled = bool(self.config.get("auto_sync", True))
        if not sync_enabled:
            logger.info(f"Session {session_id} ended, auto sync disabled")
            return {"status": "ok", "skipped": True}
        logger.info(f"Session {session_id} ended, triggering batch memory write")
        return self.process_session_records()
    
    def process_session_records(self) -> Dict[str, Any]:
        try:
            from .config import get_openclaw_base_path
            
            openclaw_base = get_openclaw_base_path()
            state_path = os.path.join(openclaw_base, ".cortex_sync_state.json")
            
            total_processed = 0
            total_sessions = 0
            results = {
                "sessions_processed": 0,
                "memory_md_segments": 0,
                "total_memories": 0
            }
            
            sessions_dir = os.path.join(openclaw_base, "agents", "main", "sessions")
            if os.path.isdir(sessions_dir):
                session_result = self._process_openclaw_sessions(sessions_dir, state_path)
                results["sessions_processed"] = session_result.get("sessions", 0)
                total_processed += session_result.get("processed", 0)
                total_sessions = session_result.get("sessions", 0)
            
            daily_memory_dir = os.path.join(openclaw_base, "workspace", "memory")
            if os.path.isdir(daily_memory_dir):
                daily_result = self._process_daily_memories(daily_memory_dir, state_path)
                if daily_result.get("processed"):
                    results["daily_memories"] = daily_result.get("processed", 0)
                    total_processed += daily_result.get("processed", 0)
            
            results["total_memories"] = total_processed
            
            logger.info(f"Processed {total_processed} memories from {total_sessions} sessions")
            return {"status": "ok", **results}
            
        except Exception as e:
            logger.error(f"Failed to process session records: {e}")
            return {"status": "error", "message": str(e)}
    
    def _process_openclaw_sessions(self, sessions_dir: str, state_path: str) -> Dict[str, Any]:
        import glob
        
        state = self._load_sync_state(state_path)
        total_processed = 0
        total_sessions = 0
        
        for sessions_file in glob.glob(os.path.join(sessions_dir, "*.jsonl")):
            file_key = os.path.abspath(sessions_file)
            last_index = state.get(file_key, -1)
            
            new_records = []
            last_seen_idx = last_index
            
            try:
                with open(sessions_file, "r", encoding="utf-8") as f:
                    for idx, line in enumerate(f):
                        if idx <= last_index:
                            continue
                        if not line.strip():
                            continue
                        try:
                            record = json.loads(line.strip())
                            new_records.append(record)
                            last_seen_idx = idx
                        except json.JSONDecodeError as e:
                            logger.warning(f"Error parsing {sessions_file} line {idx}: {e}")
            except Exception as e:
                logger.error(f"Error reading {sessions_file}: {e}")
                continue
            
            if not new_records:
                continue
            
            for record in new_records:
                content = record.get("content") or record.get("summary") or record.get("text")
                if not content or not content.strip():
                    continue
                
                segments = self.llm_extractor.split_session(content)
                
                for seg in segments:
                    seg_content = seg.get("content", "")
                    seg_topic = seg.get("topic", "")
                    
                    if seg_content and len(seg_content.strip()) >= 30:
                        result = self._write_memory_internal(
                            text=seg_content.strip(),
                            source=f"openclaw_session:{record.get('id', os.path.basename(sessions_file))}:{seg_topic}"
                        )
                        if result.success:
                            total_processed += 1
            
            state[file_key] = last_seen_idx
            total_sessions += len(new_records)
        
        self._save_sync_state(state_path, state)
        
        return {"processed": total_processed, "sessions": total_sessions}
    
    def _process_daily_memories(self, daily_memory_dir: str, state_path: str) -> Dict[str, Any]:
        import glob
        
        state = self._load_sync_state(state_path)
        total_processed = 0
        
        for daily_file in glob.glob(os.path.join(daily_memory_dir, "*.md")):
            file_key = f"daily_memory:{os.path.abspath(daily_file)}"
            
            try:
                current_mtime = os.path.getmtime(daily_file)
                last_mtime = state.get(file_key, 0)
                
                if current_mtime <= last_mtime:
                    continue
                
                with open(daily_file, "r", encoding="utf-8") as f:
                    content = f.read()
                
                if not content or not content.strip():
                    continue
                
                segments = self.llm_extractor.split_session(content)
                file_processed = 0
                
                for seg in segments:
                    seg_content = seg.get("content", "")
                    seg_topic = seg.get("topic", "")
                    
                    if seg_content and len(seg_content.strip()) >= 30:
                        result = self._write_memory_internal(
                            text=seg_content.strip(),
                            source=f"daily_memory:{os.path.basename(daily_file)}:{seg_topic}"
                        )
                        if result.success:
                            file_processed += 1
                            total_processed += 1
                
                state[file_key] = current_mtime
                
            except Exception as e:
                logger.error(f"Error processing daily memory {daily_file}: {e}")
        
        self._save_sync_state(state_path, state)
        
        return {"processed": total_processed}
    
    def _load_sync_state(self, state_path: str) -> Dict[str, Any]:
        if os.path.exists(state_path):
            try:
                with open(state_path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception as e:
                logger.warning(f"Failed to load sync state: {e}")
        return {}
    
    def _save_sync_state(self, state_path: str, state: Dict[str, Any]):
        try:
            os.makedirs(os.path.dirname(state_path), exist_ok=True)
            with open(state_path, "w", encoding="utf-8") as f:
                json.dump(state, f)
        except Exception as e:
            logger.error(f"Failed to save sync state: {e}")
    
    def _write_memory_internal(
        self,
        text: str,
        source: str = "session"
    ) -> WriteResult:
        if not text or not text.strip():
            return WriteResult(success=False, error="Empty text")
        
        text = self.preprocessor.preprocess(text)
        if not text:
            return WriteResult(success=False, error="Preprocessing failed")
        
        system_metadata = SystemMetadata.create(source=source, quality_level="medium")
        
        structured_summary = self.llm_extractor.extract(text)
        
        quality = self.quality_evaluator.evaluate(text, {
            "structured_summary": structured_summary.to_dict()
        })
        
        if not quality.should_store:
            return WriteResult(success=False, quality=quality, error="Quality below threshold")
        
        system_metadata.quality_level = quality.score.level.value
        
        summary_text = structured_summary.summary_text or text[:500]
        dedup_result = self.deduplicator.check_duplicate(summary_text, None)
        if dedup_result.is_duplicate:
            return WriteResult(success=False, is_duplicate=True, error="Duplicate")
        
        vector = self.embedding_module.embed_text([text])[0]
        
        chunks = None
        if self.enable_chunking and len(text) > 500:
            chunks = self._create_chunks(text)
        
        return self._write_sync(text, structured_summary, system_metadata, vector, chunks, quality)
