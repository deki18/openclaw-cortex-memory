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

        daily_records_pattern = os.path.join(base_dir, "workspace", "memory", "*.md")
        daily_files = glob.glob(daily_records_pattern)
        logger.info(f"Found {len(daily_files)} daily record files")
        
        imported_daily = 0
        for file_path in daily_files:
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
                        imported_daily += 1
            except Exception as e:
                logger.error(f"Failed to import {file_path}: {e}")
        
        logger.info(f"Imported {imported_daily} daily records")

        sessions_pattern = os.path.join(base_dir, "agents", "main", "sessions", "*.jsonl")
        session_files = glob.glob(sessions_pattern)
        logger.info(f"Found {len(session_files)} session files")
        
        imported_sessions = 0
        for file_path in session_files:
            logger.info(f"Importing session log: {file_path}")
            try:
                self.write_pipeline.process_sessions(file_path)
                imported_sessions += 1
            except Exception as e:
                logger.error(f"Failed to import {file_path}: {e}")
            
        logger.info(f"Import complete. Daily records: {imported_daily}, Sessions: {imported_sessions}")

    def inject_core_rule(self):
        base_path = get_openclaw_base_path()
        memory_md_path = os.path.join(base_path, "workspace", "MEMORY.md")
        os.makedirs(os.path.dirname(memory_md_path), exist_ok=True)
        
        rule_header = "## Cortex Memory Integration Rules"
        rule_content = """
You are equipped with the **Cortex Memory** engine. You must proactively manage and utilize your memory using the provided skills.

1. **Proactive Retrieval**: If a user asks about past interactions, projects, preferences, or technical context that is not in your immediate short-term memory, you MUST use the `search_memory` tool to retrieve semantic memory before answering. Do not guess or hallucinate past events.

2. **Auto Context**: For proactive memory retrieval without explicit search, use `get_auto_context` to get automatically retrieved relevant memories based on recent user messages, plus hot context.

3. **Hot Context**: When you need current session context including CORTEX_RULES.md and recent data, use `get_hot_context` to retrieve the hot memory layer.

4. **Relational Queries**: If the user asks about the relationship between entities (e.g., "Who worked on Project X?", "What technologies does Person Y use?"), use the `query_graph` tool to query the memory graph. The graph supports 16 entity types (Person, Task, Project, Event, Document, Concept, Location, Organization, Credential, Preference, Goal, Note, Resource, Topic, Entity, Unknown) and 19 relation types with schema validation.

5. **Memory Consolidation**: When you learn a new, important fact about the user, complete a significant milestone, or resolve a complex bug, you should summarize it and use `store_event` to record it. Include entity type and attributes for better graph integration.

6. **Self-Reflection**: Periodically, or when asked to review past performance, use the `reflect_memory` tool to generate insights from your episodic memory.

7. **Historical Sync**: To import historical session data from OpenClaw workspace, use `sync_memory` tool. This is incremental and won't reprocess already imported data.

8. **Graph Statistics**: To check the memory graph status, use CLI command `cortex-memory graph --stats` to see total nodes, edges, and type distribution. Use `cortex-memory graph --validate` to check graph integrity.

9. **Schema Awareness**: The graph memory enforces schema constraints including type validation, cardinality (one_to_one, many_to_one, many_to_many), and acyclic detection for dependency relations. Invalid relations will be rejected.

10. **Trust the Engine**: The memory engine handles vector search, BM25 keyword matching, and time-decay automatically. Trust its top results.
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
