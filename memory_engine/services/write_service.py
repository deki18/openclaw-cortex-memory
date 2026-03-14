import logging
from datetime import datetime, timezone

from .metadata_schema import MemoryMetadata
from .semantic_memory import SemanticMemory

logger = logging.getLogger(__name__)


class MemoryWriteService:
    def __init__(self, semantic_memory: SemanticMemory = None):
        self.semantic = semantic_memory or SemanticMemory()

    def write_memory(self, text: str, source: str = "manual", category: str = "event") -> str:
        if not text or not text.strip():
            logger.warning("Empty text provided, skipping memory write")
            return None
        
        meta = MemoryMetadata(
            category=category,
            date=datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            agent="openclaw",
            source=source
        )
        try:
            return self.semantic.add_memory(text.strip(), meta)
        except Exception as e:
            logger.error(f"Failed to write memory: {e}")
            return None

    def write_batch(self, texts: list, source: str = "batch") -> list:
        results = []
        for text in texts:
            memory_id = self.write_memory(text, source)
            results.append(memory_id)
        return results

    def update_memory(self, memory_id: str, **kwargs) -> bool:
        try:
            return self.semantic.update_memory(memory_id, **kwargs)
        except Exception as e:
            logger.error(f"Failed to update memory {memory_id}: {e}")
            return False

    def delete_memory(self, memory_id: str) -> bool:
        try:
            return self.semantic.delete_by_id(memory_id)
        except Exception as e:
            logger.error(f"Failed to delete memory {memory_id}: {e}")
            return False
