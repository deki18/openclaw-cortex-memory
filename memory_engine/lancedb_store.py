import logging
import os
from typing import Optional, List

import lancedb
from lancedb.pydantic import LanceModel, Vector

logger = logging.getLogger(__name__)

VECTOR_DIM = 3072


class OpenClawMemory(LanceModel):
    id: str
    vector: Vector(VECTOR_DIM)
    text: str
    type: str
    date: str
    agent: str
    source_file: Optional[str] = None
    hit_count: int = 0
    weight: int = 1

    class Config:
        extra = "allow"


def get_lancedb_path() -> str:
    from .config import CONFIG
    return os.path.expanduser(CONFIG.get("lancedb_path", "~/.openclaw/agents/main/lancedb_store"))


class LanceDBStore:
    def __init__(self, db_path: Optional[str] = None):
        self.db_path = db_path or get_lancedb_path()
        os.makedirs(self.db_path, exist_ok=True)
        self.db = lancedb.connect(self.db_path)
        self.table_name = "memories"
        self._ensure_table()

    def _ensure_table(self):
        if self.table_name not in self.db.table_names():
            self.db.create_table(self.table_name, schema=OpenClawMemory)
            logger.info(f"Created LanceDB table: {self.table_name}")

    def _get_table(self):
        return self.db.open_table(self.table_name)

    def add_memories(self, memories: List[OpenClawMemory]):
        if not memories:
            return
        table = self._get_table()
        try:
            table.add([m.model_dump() for m in memories])
            self._ensure_fts_index()
            logger.info(f"Added {len(memories)} memories to LanceDB")
        except Exception as e:
            logger.error(f"Failed to add memories: {e}")
            raise

    def _ensure_fts_index(self):
        table = self._get_table()
        try:
            table.create_fts_index("text", replace=True)
        except Exception as e:
            logger.warning(f"FTS index creation skipped: {e}")

    def search(
        self,
        query_vector: List[float],
        query_text: str,
        limit: int = 10,
        query_type: str = "hybrid",
        memory_type: Optional[str] = None,
    ) -> List[OpenClawMemory]:
        table = self._get_table()
        try:
            if query_type == "hybrid":
                query_builder = (
                    table.search(query_type="hybrid")
                    .vector(query_vector)
                    .text(query_text)
                    .limit(limit)
                )
            elif query_type == "vector":
                query_builder = table.search(query_vector, query_type="vector").limit(limit)
            else:
                query_builder = table.search(query_text, query_type="fts").limit(limit)
            
            if memory_type:
                query_builder = query_builder.where(f"type = '{memory_type}'")
            
            return query_builder.to_pydantic(OpenClawMemory)
        except Exception as e:
            logger.error(f"Search failed: {e}")
            return []

    def search_by_date_range(
        self,
        start_date: str,
        end_date: str,
        limit: int = 100
    ) -> List[OpenClawMemory]:
        table = self._get_table()
        try:
            return (
                table.search()
                .where(f"date >= '{start_date}' AND date <= '{end_date}'")
                .limit(limit)
                .to_pydantic(OpenClawMemory)
            )
        except Exception as e:
            logger.error(f"Date range search failed: {e}")
            return []

    def get_core_rules(self, limit: int = 50) -> List[OpenClawMemory]:
        table = self._get_table()
        try:
            return (
                table.search()
                .where("type = 'core_rule'")
                .limit(limit)
                .to_pydantic(OpenClawMemory)
            )
        except Exception as e:
            logger.error(f"Failed to get core rules: {e}")
            return []

    def get_by_id(self, memory_id: str) -> Optional[OpenClawMemory]:
        table = self._get_table()
        try:
            results = (
                table.search()
                .where(f"id = '{memory_id}'")
                .limit(1)
                .to_pydantic(OpenClawMemory)
            )
            return results[0] if results else None
        except Exception as e:
            logger.error(f"Failed to get memory by id: {e}")
            return None

    def update_hit_count(self, memory_id: str, increment: int = 1):
        table = self._get_table()
        try:
            memory = self.get_by_id(memory_id)
            if memory:
                new_hit_count = memory.hit_count + increment
                table.update(where=f"id = '{memory_id}'", values={"hit_count": new_hit_count})
        except Exception as e:
            logger.warning(f"Failed to update hit count: {e}")

    def delete_by_id(self, memory_id: str):
        table = self._get_table()
        try:
            table.delete(f"id = '{memory_id}'")
            logger.info(f"Deleted memory: {memory_id}")
        except Exception as e:
            logger.error(f"Failed to delete memory: {e}")

    def count(self) -> int:
        table = self._get_table()
        return table.count_rows()

    def count_by_type(self, memory_type: str) -> int:
        table = self._get_table()
        try:
            return len(table.search().where(f"type = '{memory_type}'").to_pydantic(OpenClawMemory))
        except Exception as e:
            logger.error(f"Failed to count by type: {e}")
            return 0

    def list_all(self, limit: int = 100) -> List[OpenClawMemory]:
        table = self._get_table()
        try:
            return table.search().limit(limit).to_pydantic(OpenClawMemory)
        except Exception as e:
            logger.error(f"Failed to list memories: {e}")
            return []

    def rebuild_fts_index(self):
        table = self._get_table()
        try:
            table.create_fts_index("text", replace=True)
            logger.info("Rebuilt FTS index")
        except Exception as e:
            logger.error(f"Failed to rebuild FTS index: {e}")

    def clear_all(self):
        try:
            self.db.drop_table(self.table_name)
            self._ensure_table()
            logger.info("Cleared all memories")
        except Exception as e:
            logger.error(f"Failed to clear memories: {e}")
