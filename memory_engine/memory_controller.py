import glob
import logging
import os
from datetime import datetime, timezone

from .config import CONFIG
from .episodic_memory import EpisodicMemory
from .hot_memory import HotMemory
from .memory_graph import MemoryGraph
from .metadata_schema import MemoryMetadata
from .procedural_memory import ProceduralMemory
from .promotion_engine import PromotionEngine
from .reflection_engine import ReflectionEngine
from .retrieval_pipeline import RetrievalPipeline
from .semantic_memory import SemanticMemory
from .write_pipeline import WritePipeline

logger = logging.getLogger(__name__)


class MemoryController:
    def __init__(self):
        self.semantic = SemanticMemory()
        self.episodic = EpisodicMemory()
        self.procedural = ProceduralMemory()
        self.graph = MemoryGraph()
        self.retrieval = RetrievalPipeline()
        self.write_pipeline = WritePipeline()
        self.promotion = PromotionEngine()
        self.reflection = ReflectionEngine()
        self.hot = HotMemory()

    def write_memory(self, text: str, source: str = "manual"):
        meta = MemoryMetadata(
            type="event",
            date=datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            agent="openclaw",
            source_file=source
        )
        try:
            return self.semantic.add_memory(text, meta)
        except Exception as e:
            logger.error(f"Failed to write memory: {e}")
            return None

    def search_memory(self, query: str):
        try:
            return self.retrieval.search(query)
        except Exception as e:
            logger.error(f"Failed to search memory: {e}")
            return []

    def store_event(self, summary: str, entities: list = None, outcome: str = "", relations: list = None):
        try:
            event_id = self.episodic.store_event(summary, entities, outcome, relations)
            if not event_id:
                return None
                
            if entities:
                for entity in entities:
                    if isinstance(entity, dict):
                        node_id = entity.get("id") or entity.get("name")
                        node_type = entity.get("type") or "Person"
                        if node_id:
                            self.graph.add_node(node_id, node_type, entity.get("attributes"))
                    else:
                        self.graph.add_node(str(entity), "Person")
            if relations:
                for rel in relations:
                    if isinstance(rel, dict):
                        source = rel.get("source")
                        target = rel.get("target")
                        edge_type = rel.get("type")
                    else:
                        source, target, edge_type = rel
                    if source and target and edge_type:
                        self.graph.add_edge(source, target, edge_type)
            return event_id
        except Exception as e:
            logger.error(f"Failed to store event: {e}")
            return None

    def reflect_memory(self):
        try:
            self.reflection.reflect()
        except Exception as e:
            logger.error(f"Failed to reflect memory: {e}")

    def query_graph(self, entity: str):
        try:
            return self.graph.query_entity(entity)
        except Exception as e:
            logger.error(f"Failed to query graph: {e}")
            return []

    def get_hot_context(self, limit: int = 20):
        try:
            return self.hot.build_hot_context(limit=limit)
        except Exception as e:
            logger.error(f"Failed to get hot context: {e}")
            return []

    def sync_memory(self):
        try:
            base_dir = os.path.expanduser(os.environ.get("OPENCLAW_BASE_PATH") or self.write_pipeline.base_dir or "~/.openclaw")
            sessions_dir = os.path.join(base_dir, "agents", "main", "sessions")
            local_sessions_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data", "memory", "sessions", "active"))
            
            if os.path.isdir(sessions_dir):
                self.write_pipeline.process_sessions_dir(sessions_dir)
            if os.path.isdir(local_sessions_dir):
                self.write_pipeline.process_sessions_dir(local_sessions_dir)
            
            logger.info("Memory sync complete")
        except Exception as e:
            logger.error(f"Failed to sync memory: {e}")

    def promote_memory(self):
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
        except Exception as e:
            logger.error(f"Failed to promote memory: {e}")

    def import_legacy_data(self, data_dir: str = "~/.openclaw"):
        logger.info(f"Importing legacy data from {data_dir}...")
        base_dir = os.path.expanduser(data_dir)
        if not os.path.exists(base_dir):
            logger.warning(f"Directory not found: {base_dir}")
            return

        memory_md_path = os.path.join(base_dir, "workspace", "MEMORY.md")
        if os.path.exists(memory_md_path):
            logger.info(f"Importing long-term memory: {memory_md_path}")
            try:
                with open(memory_md_path, "r", encoding="utf-8") as f:
                    content = f.read()
                    if content.strip():
                        meta = MemoryMetadata(
                            type="core_rule",
                            date=datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                            agent="openclaw",
                            source_file=memory_md_path
                        )
                        self.semantic.add_memory(content, meta)
            except Exception as e:
                logger.error(f"Failed to import {memory_md_path}: {e}")
        
        daily_records_pattern = os.path.join(base_dir, "workspace", "memory", "*.md")
        for file_path in glob.glob(daily_records_pattern):
            logger.info(f"Importing daily record: {file_path}")
            try:
                with open(file_path, "r", encoding="utf-8") as f:
                    content = f.read()
                    if content.strip():
                        meta = MemoryMetadata(
                            type="daily_log",
                            date=datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                            agent="openclaw",
                            source_file=file_path
                        )
                        self.semantic.add_memory(content, meta)
            except Exception as e:
                logger.error(f"Failed to import {file_path}: {e}")

        sessions_pattern = os.path.join(base_dir, "agents", "main", "sessions", "*.jsonl")
        for file_path in glob.glob(sessions_pattern):
            logger.info(f"Importing session log: {file_path}")
            try:
                self.write_pipeline.process_sessions(file_path)
            except Exception as e:
                logger.error(f"Failed to import {file_path}: {e}")
            
        logger.info("Import complete.")

    def inject_core_rule(self):
        memory_md_path = os.path.expanduser("~/.openclaw/workspace/MEMORY.md")
        os.makedirs(os.path.dirname(memory_md_path), exist_ok=True)
        
        rule_header = "## Cortex Memory Integration Rules"
        rule_content = """
You are equipped with the **Cortex Memory** engine. You must proactively manage and utilize your memory using the provided skills.

1. **Proactive Retrieval**: If a user asks about past interactions, projects, preferences, or technical context that is not in your immediate short-term memory, you MUST use the `search_memory` tool to retrieve semantic memory before answering. Do not guess or hallucinate past events.
2. **Relational Queries**: If the user asks about the relationship between entities (e.g., "Who worked on Project X?", "What technologies does Person Y use?"), use the `query_graph` tool to query the memory graph.
3. **Memory Consolidation**: When you learn a new, important fact about the user, complete a significant milestone, or resolve a complex bug, you should summarize it and use `store_event` to record it.
4. **Self-Reflection**: Periodically, or when asked to review past performance, use the `reflect_memory` tool to generate insights from your episodic memory.
5. **Trust the Engine**: The memory engine handles vector search, BM25 keyword matching, and time-decay automatically. Trust its top results.
"""
        
        content = ""
        if os.path.exists(memory_md_path):
            try:
                with open(memory_md_path, "r", encoding="utf-8") as f:
                    content = f.read()
            except Exception as e:
                logger.error(f"Failed to read MEMORY.md: {e}")
                
        if rule_header in content:
            logger.info("Core rules already injected in MEMORY.md.")
            return
            
        try:
            with open(memory_md_path, "a", encoding="utf-8") as f:
                f.write(f"\n\n{rule_header}\n{rule_content}")
            logger.info(f"Successfully injected Cortex Memory core rules into {memory_md_path}.")
        except Exception as e:
            logger.error(f"Failed to inject core rules: {e}")
