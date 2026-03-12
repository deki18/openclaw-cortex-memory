import logging
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from .embedding import EmbeddingModule
from .lancedb_store import LanceDBStore, OpenClawMemory
from .metadata_schema import MemoryMetadata

logger = logging.getLogger(__name__)


class SemanticMemory:
    def __init__(self):
        self.store = LanceDBStore()
        self.embedding_module = EmbeddingModule()

    def add_memory(self, text: str, metadata: MemoryMetadata) -> str:
        doc_id = str(uuid.uuid4())
        embedding = self.embedding_module.embed_text([text])[0]
        
        memory = OpenClawMemory(
            id=doc_id,
            vector=embedding,
            text=text,
            type=metadata.type or "daily_log",
            date=metadata.date or datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            agent=metadata.agent or "openclaw",
            source_file=metadata.source_file,
            hit_count=metadata.hit_count or 0,
            weight=metadata.weight or 1
        )
        
        try:
            self.store.add_memories([memory])
            logger.debug(f"Added memory {doc_id}")
            return doc_id
        except Exception as e:
            logger.error(f"Failed to add memory: {e}")
            raise

    def search(
        self,
        query: str,
        top_k: int = 10,
        query_type: str = "hybrid",
        memory_type: Optional[str] = None
    ) -> List[OpenClawMemory]:
        embedding = self.embedding_module.embed_text([query])[0]
        return self.store.search(
            query_vector=embedding,
            query_text=query,
            limit=top_k,
            query_type=query_type,
            memory_type=memory_type
        )

    def get_by_id(self, memory_id: str) -> Optional[OpenClawMemory]:
        return self.store.get_by_id(memory_id)

    def update_hit_count(self, memory_id: str, increment: int = 1):
        self.store.update_hit_count(memory_id, increment)

    def delete_by_id(self, memory_id: str):
        self.store.delete_by_id(memory_id)

    def count(self) -> int:
        return self.store.count()

    def count_by_type(self, memory_type: str) -> int:
        return self.store.count_by_type(memory_type)

    def list_all(self, limit: int = 100) -> List[OpenClawMemory]:
        return self.store.list_all(limit)

    def get_core_rules(self, limit: int = 50) -> List[OpenClawMemory]:
        return self.store.get_core_rules(limit)

    def search_by_date_range(
        self,
        start_date: str,
        end_date: str,
        limit: int = 100
    ) -> List[OpenClawMemory]:
        return self.store.search_by_date_range(start_date, end_date, limit)
