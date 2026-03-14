import logging
import os
import re
from typing import Optional, List

import lancedb
from lancedb.pydantic import LanceModel, Vector

logger = logging.getLogger(__name__)

DEFAULT_VECTOR_DIM = 3072
VECTOR_DIM = None

VALID_MEMORY_TYPES = {"core_rule", "daily_log", "event", "episodic", "procedural"}
ID_PATTERN = re.compile(r'^[a-zA-Z0-9_-]{1,128}$')
DATE_PATTERN = re.compile(r'^\d{4}-\d{2}-\d{2}$')
MEMORY_TYPE_PATTERN = re.compile(r'^[a-z_]{1,32}$')
MAX_TEXT_LENGTH = 100000
MAX_ID_LENGTH = 128


def _escape_sql_string(value: str) -> str:
    if not isinstance(value, str):
        return ""
    value = value.replace("'", "''")
    value = value.replace("\\", "\\\\")
    value = value.replace("\x00", "")
    return value


def _validate_id(memory_id: str) -> bool:
    if not memory_id or not isinstance(memory_id, str):
        return False
    if len(memory_id) > MAX_ID_LENGTH:
        return False
    return bool(ID_PATTERN.match(memory_id))


def _validate_date(date_str: str) -> bool:
    if not date_str or not isinstance(date_str, str):
        return False
    return bool(DATE_PATTERN.match(date_str))


def _validate_memory_type(memory_type: str) -> bool:
    if not memory_type or not isinstance(memory_type, str):
        return False
    if len(memory_type) > 32:
        return False
    return memory_type in VALID_MEMORY_TYPES


def _validate_text(text: str) -> bool:
    if not text or not isinstance(text, str):
        return False
    if len(text) > MAX_TEXT_LENGTH:
        logger.warning(f"Text exceeds maximum length: {len(text)} > {MAX_TEXT_LENGTH}")
        return False
    return True


def get_vector_dim() -> int:
    global VECTOR_DIM
    if VECTOR_DIM is not None:
        return VECTOR_DIM
    from .config import get_config
    config = get_config()
    VECTOR_DIM = config.get("embedding_dimensions") or DEFAULT_VECTOR_DIM
    return VECTOR_DIM


def create_memory_model(vector_dim: int):
    class OpenClawMemory(LanceModel):
        id: str
        vector: Vector(vector_dim)
        text: str
        type: str
        date: str
        agent: str
        source_file: Optional[str] = None
        hit_count: int = 0
        weight: int = 1

        class Config:
            extra = "allow"
    
    return OpenClawMemory


OpenClawMemory = None


def get_memory_model():
    global OpenClawMemory
    if OpenClawMemory is None:
        OpenClawMemory = create_memory_model(get_vector_dim())
    return OpenClawMemory


def get_db_path() -> str:
    from .config import get_config, get_openclaw_base_path
    config = get_config()
    if config.get("lancedb_path"):
        return os.path.expanduser(config.get("lancedb_path"))
    base_path = get_openclaw_base_path()
    return os.path.join(base_path, "agents", "main", "lancedb_store")


class LanceDBStore:
    def __init__(self, db_path: Optional[str] = None):
        self.db_path = db_path or get_db_path()
        os.makedirs(self.db_path, exist_ok=True)
        self.db = lancedb.connect(self.db_path)
        self.table_name = "memories"
        self._fts_indexed = False
        self._ensure_table()

    def _ensure_table(self):
        if self.table_name not in self.db.table_names():
            MemoryModel = get_memory_model()
            self.db.create_table(self.table_name, schema=MemoryModel)
            logger.info(f"Created LanceDB table: {self.table_name}")

    def _get_table(self):
        return self.db.open_table(self.table_name)

    def add_memories(self, memories: List):
        if not memories:
            return
        table = self._get_table()
        try:
            unique_memories = []
            for memory in memories:
                existing = self._find_similar_memory(memory.text, threshold=0.95)
                if not existing:
                    unique_memories.append(memory)
                else:
                    logger.debug(f"Skipping duplicate memory: {memory.text[:50]}...")
            
            if unique_memories:
                table.add([m.model_dump() for m in unique_memories])
                if not self._fts_indexed:
                    self._ensure_fts_index()
                    self._fts_indexed = True
                logger.info(f"Added {len(unique_memories)} memories to LanceDB (skipped {len(memories) - len(unique_memories)} duplicates)")
        except Exception as e:
            logger.error(f"Failed to add memories: {e}")
            raise

    def _find_similar_memory(self, text: str, threshold: float = 0.95):
        table = self._get_table()
        try:
            results = table.search(text).limit(1).to_list()
            if results:
                existing_text = results[0].get("text", "")
                similarity = self._text_similarity(text, existing_text)
                if similarity >= threshold:
                    return results[0]
        except Exception:
            pass
        return None

    def _text_similarity(self, text1: str, text2: str) -> float:
        text1_words = set(text1.lower().split())
        text2_words = set(text2.lower().split())
        if not text1_words or not text2_words:
            return 0.0
        intersection = text1_words & text2_words
        union = text1_words | text2_words
        return len(intersection) / len(union)

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
    ) -> List:
        MemoryModel = get_memory_model()
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
                if not _validate_memory_type(memory_type):
                    logger.warning(f"Invalid memory_type: {memory_type}")
                    return []
                query_builder = query_builder.where(f"type = '{_escape_sql_string(memory_type)}'")
            
            return query_builder.to_pydantic(MemoryModel)
        except Exception as e:
            logger.error(f"Search failed: {e}")
            return []

    def search_by_date_range(
        self,
        start_date: str,
        end_date: str,
        limit: int = 100
    ) -> List:
        MemoryModel = get_memory_model()
        if not _validate_date(start_date) or not _validate_date(end_date):
            logger.warning(f"Invalid date format: {start_date} or {end_date}")
            return []
        table = self._get_table()
        try:
            return (
                table.search()
                .where(f"date >= '{_escape_sql_string(start_date)}' AND date <= '{_escape_sql_string(end_date)}'")
                .limit(limit)
                .to_pydantic(MemoryModel)
            )
        except Exception as e:
            logger.error(f"Date range search failed: {e}")
            return []

    def get_core_rules(self, limit: int = 50) -> List:
        MemoryModel = get_memory_model()
        table = self._get_table()
        try:
            return (
                table.search()
                .where("type = 'core_rule'")
                .limit(limit)
                .to_pydantic(MemoryModel)
            )
        except Exception as e:
            logger.error(f"Failed to get core rules: {e}")
            return []

    def get_by_id(self, memory_id: str) -> Optional:
        MemoryModel = get_memory_model()
        if not _validate_id(memory_id):
            logger.warning(f"Invalid memory_id format: {memory_id}")
            return None
        table = self._get_table()
        try:
            results = (
                table.search()
                .where(f"id = '{_escape_sql_string(memory_id)}'")
                .limit(1)
                .to_pydantic(MemoryModel)
            )
            return results[0] if results else None
        except Exception as e:
            logger.error(f"Failed to get memory by id: {e}")
            return None

    def update_hit_count(self, memory_id: str, increment: int = 1):
        if not _validate_id(memory_id):
            logger.warning(f"Invalid memory_id format: {memory_id}")
            return
        table = self._get_table()
        try:
            memory = self.get_by_id(memory_id)
            if memory:
                new_hit_count = memory.hit_count + increment
                table.update(where=f"id = '{_escape_sql_string(memory_id)}'", values={"hit_count": new_hit_count})
        except Exception as e:
            logger.warning(f"Failed to update hit count: {e}")

    def delete_by_id(self, memory_id: str):
        if not _validate_id(memory_id):
            logger.warning(f"Invalid memory_id format: {memory_id}")
            return
        table = self._get_table()
        try:
            table.delete(f"id = '{_escape_sql_string(memory_id)}'")
            logger.info(f"Deleted memory: {memory_id}")
        except Exception as e:
            logger.error(f"Failed to delete memory: {e}")

    def update_memory(self, memory_id: str, updates: dict):
        if not _validate_id(memory_id):
            logger.warning(f"Invalid memory_id format: {memory_id}")
            return
        table = self._get_table()
        try:
            valid_fields = {"text", "type", "weight", "hit_count", "source_file"}
            filtered_updates = {k: v for k, v in updates.items() if k in valid_fields}
            if filtered_updates:
                table.update(where=f"id = '{_escape_sql_string(memory_id)}'", values=filtered_updates)
                logger.info(f"Updated memory: {memory_id}")
        except Exception as e:
            logger.error(f"Failed to update memory: {e}")

    def count(self) -> int:
        table = self._get_table()
        return table.count_rows()

    def count_by_type(self, memory_type: str) -> int:
        if not _validate_memory_type(memory_type):
            logger.warning(f"Invalid memory_type: {memory_type}")
            return 0
        table = self._get_table()
        try:
            return table.count_rows(where=f"type = '{_escape_sql_string(memory_type)}'")
        except Exception as e:
            logger.error(f"Failed to count by type: {e}")
            return 0

    def list_all(self, limit: int = 100, offset: int = 0) -> List:
        MemoryModel = get_memory_model()
        table = self._get_table()
        try:
            results = table.search().limit(limit + offset).to_pydantic(MemoryModel)
            return results[offset:] if offset > 0 else results
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
