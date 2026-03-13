import glob
import logging
import os
from datetime import datetime, timezone

from .config import get_config, get_openclaw_base_path
from .metadata_schema import MemoryMetadata
from .write_pipeline import WritePipeline
from .semantic_memory import SemanticMemory

logger = logging.getLogger(__name__)


class MemorySyncService:
    def __init__(self, write_pipeline: WritePipeline = None, semantic_memory: SemanticMemory = None):
        self.write_pipeline = write_pipeline or WritePipeline()
        self.semantic = semantic_memory or SemanticMemory()

    def sync_sessions(self):
        try:
            base_dir = self.write_pipeline.base_dir
            sessions_dir = os.path.join(base_dir, "agents", "main", "sessions")
            local_sessions_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "data", "memory", "sessions", "active"))
            
            if os.path.isdir(sessions_dir):
                self.write_pipeline.process_sessions_dir(sessions_dir)
            if os.path.isdir(local_sessions_dir):
                self.write_pipeline.process_sessions_dir(local_sessions_dir)
            
            logger.info("Memory sync complete")
        except Exception as e:
            logger.error(f"Failed to sync memory: {e}")

    def import_legacy_data(self, data_dir: str = None):
        if data_dir is None:
            data_dir = get_openclaw_base_path()
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
        base_path = get_openclaw_base_path()
        memory_md_path = os.path.join(base_path, "workspace", "MEMORY.md")
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
