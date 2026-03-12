from .semantic_memory import SemanticMemory
from .episodic_memory import EpisodicMemory
from .procedural_memory import ProceduralMemory
from .memory_graph import MemoryGraph
from .retrieval_pipeline import RetrievalPipeline
from .write_pipeline import WritePipeline
from .promotion_engine import PromotionEngine
from .reflection_engine import ReflectionEngine
from .hot_memory import HotMemory
from .metadata_schema import MemoryMetadata
from datetime import datetime
import os
import glob

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
            date=datetime.utcnow().isoformat() + "Z",
            agent="openclaw",
            source_file=source
        )
        self.semantic.add_memory(text, meta)

    def search_memory(self, query: str):
        return self.retrieval.retrieve(query)

    def store_event(self, summary: str, entities: list = None, outcome: str = "", relations: list = None):
        event_id = self.episodic.store_event(summary, entities, outcome)
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

    def reflect_memory(self):
        self.reflection.reflect()

    def query_graph(self, entity: str):
        return self.graph.query_entity(entity)

    def get_hot_context(self, limit: int = 20):
        return self.hot.build_hot_context(limit=limit)

    def sync_memory(self):
        base_dir = os.path.expanduser(os.environ.get("OPENCLAW_BASE_PATH") or self.write_pipeline.base_dir or "~/.openclaw")
        sessions_dir = os.path.join(base_dir, "agents", "main", "sessions")
        local_sessions_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data", "memory", "sessions", "active"))
        if os.path.isdir(sessions_dir):
            self.write_pipeline.process_sessions_dir(sessions_dir)
        if os.path.isdir(local_sessions_dir):
            self.write_pipeline.process_sessions_dir(local_sessions_dir)

    def promote_memory(self):
        data = self.semantic.vector_store.get_all()
        ids = data.get("ids", [])
        documents = data.get("documents", [])
        metadatas = data.get("metadatas", [])
        updated_ids = []
        updated_metas = []
        for doc_id, doc, meta in zip(ids, documents, metadatas):
            if not meta:
                continue
            hit_count = int(meta.get("hit_count") or 0)
            if meta.get("type") != "core_rule" and self.promotion.check_and_promote(hit_count, doc):
                meta["type"] = "core_rule"
                updated_ids.append(doc_id)
                updated_metas.append(meta)
        if updated_ids:
            self.semantic.vector_store.update_metadatas(updated_ids, updated_metas)
            self.semantic.bm25_store.update_metadatas(updated_ids, updated_metas)

    def import_legacy_data(self, data_dir: str = "~/.openclaw"):
        print(f"Importing legacy data from {data_dir}...")
        base_dir = os.path.expanduser(data_dir)
        if not os.path.exists(base_dir):
            print(f"Directory not found: {base_dir}")
            return

        # 1. Import Long-term memory (MEMORY.md)
        memory_md_path = os.path.join(base_dir, "workspace", "MEMORY.md")
        if os.path.exists(memory_md_path):
            print(f"Importing long-term memory: {memory_md_path}")
            with open(memory_md_path, "r", encoding="utf-8") as f:
                content = f.read()
                if content.strip():
                    meta = MemoryMetadata(
                        type="core_rule",
                        date=datetime.utcnow().isoformat() + "Z",
                        agent="openclaw",
                        source_file=memory_md_path
                    )
                    self.semantic.add_memory(content, meta)
        
        # 2. Import Daily records (*.md in workspace/memory/)
        daily_records_pattern = os.path.join(base_dir, "workspace", "memory", "*.md")
        for file_path in glob.glob(daily_records_pattern):
            print(f"Importing daily record: {file_path}")
            with open(file_path, "r", encoding="utf-8") as f:
                content = f.read()
                if content.strip():
                    meta = MemoryMetadata(
                        type="daily_log",
                        date=datetime.utcnow().isoformat() + "Z",
                        agent="openclaw",
                        source_file=file_path
                    )
                    self.semantic.add_memory(content, meta)

        # 3. Import Conversation logs (*.jsonl in agents/main/sessions/)
        sessions_pattern = os.path.join(base_dir, "agents", "main", "sessions", "*.jsonl")
        for file_path in glob.glob(sessions_pattern):
            print(f"Importing session log: {file_path}")
            self.write_pipeline.process_sessions(file_path)
            
        print("Import complete.")

    def inject_core_rule(self):
        import os
        memory_md_path = os.path.expanduser("~/.openclaw/workspace/MEMORY.md")
        os.makedirs(os.path.dirname(memory_md_path), exist_ok=True)
        
        rule_header = "## Cortex Memory Integration Rules"
        rule_content = """
You are equipped with the **Cortex Memory** engine. You must proactively manage and utilize your memory using the provided skills.

1. **Proactive Retrieval**: If a user asks about past interactions, projects, preferences, or technical context that is not in your immediate short-term memory, you MUST use the `search` skill to retrieve semantic memory before answering. Do not guess or hallucinate past events.
2. **Relational Queries**: If the user asks about the relationship between entities (e.g., "Who worked on Project X?", "What technologies does Person Y use?"), use the `graph` skill to query the memory graph.
3. **Memory Consolidation**: When you learn a new, important fact about the user, complete a significant milestone, or resolve a complex bug, you should summarize it and ensure it is recorded.
4. **Self-Reflection**: Periodically, or when asked to review past performance, use the `reflect` skill to generate insights from your episodic memory.
5. **Trust the Engine**: The memory engine handles vector search, BM25 keyword matching, and time-decay automatically. Trust its top results.
"""
        
        content = ""
        if os.path.exists(memory_md_path):
            with open(memory_md_path, "r", encoding="utf-8") as f:
                content = f.read()
                
        if rule_header in content:
            print("Core rules already injected in MEMORY.md.")
            return
            
        with open(memory_md_path, "a", encoding="utf-8") as f:
            f.write(f"\n\n{rule_header}\n{rule_content}")
        print(f"Successfully injected Cortex Memory core rules into {memory_md_path}.")
