import logging

from .config import get_config
from .episodic_memory import EpisodicMemory
from .hot_memory import HotMemory
from .memory_graph import MemoryGraph
from .procedural_memory import ProceduralMemory
from .promotion_engine import PromotionEngine
from .reflection_engine import ReflectionEngine
from .retrieval_pipeline import RetrievalPipeline
from .semantic_memory import SemanticMemory
from .write_pipeline import WritePipeline
from .services import (
    MemoryWriteService,
    MemorySearchService,
    MemorySyncService,
    MemoryMaintenanceService,
    MemoryEventService
)

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
        
        self._write_service = MemoryWriteService(self.semantic)
        self._search_service = MemorySearchService(self.retrieval, self.semantic)
        self._sync_service = MemorySyncService(self.write_pipeline, self.semantic)
        self._maintenance_service = MemoryMaintenanceService(self.semantic, self.episodic)
        self._event_service = MemoryEventService(self.episodic, self.graph)

    @property
    def write_service(self) -> MemoryWriteService:
        return self._write_service

    @property
    def search_service(self) -> MemorySearchService:
        return self._search_service

    @property
    def sync_service(self) -> MemorySyncService:
        return self._sync_service

    @property
    def maintenance_service(self) -> MemoryMaintenanceService:
        return self._maintenance_service

    @property
    def event_service(self) -> MemoryEventService:
        return self._event_service

    def write_memory(self, text: str, source: str = "manual"):
        return self._write_service.write_memory(text, source)

    def search_memory(self, query: str):
        return self._search_service.search(query)

    def store_event(self, summary: str, entities: list = None, outcome: str = "", relations: list = None):
        return self._event_service.store_event(summary, entities, outcome, relations)

    def reflect_memory(self):
        self._maintenance_service.reflect()

    def query_graph(self, entity: str):
        return self._event_service.query_graph(entity)

    def get_hot_context(self, limit: int = 20):
        return self._search_service.get_hot_context(limit)

    def sync_memory(self):
        self._sync_service.sync_sessions()

    def promote_memory(self):
        self._maintenance_service.promote_memories()

    def import_legacy_data(self, data_dir: str = None):
        self._sync_service.import_legacy_data(data_dir)

    def inject_core_rule(self):
        self._sync_service.inject_core_rule()

    def cleanup_old_memories(self, days_old: int = 90, memory_type: str = None):
        return self._maintenance_service.cleanup_old_memories(days_old, memory_type)
