import logging
from datetime import datetime, timezone

from .episodic_memory import EpisodicMemory
from .llm_client import LLMClient
from .metadata_schema import MemoryMetadata
from .semantic_memory import SemanticMemory

logger = logging.getLogger(__name__)


class ReflectionEngine:
    def __init__(self):
        self.episodic_memory = EpisodicMemory()
        self.semantic_memory = SemanticMemory()
        self.llm = LLMClient()

    def reflect(self):
        events = self.episodic_memory.load_events(limit=50)
        if not events:
            logger.info("No events to reflect on")
            return
        summary = self._summarize_events(events)
        if not summary:
            logger.warning("Failed to summarize events")
            return
        knowledge = self._extract_knowledge(summary)
        if not knowledge:
            logger.warning("Failed to extract knowledge from summary")
            return
        meta = MemoryMetadata(
            type="core_rule",
            date=datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            agent="openclaw",
            source_file="reflection"
        )
        try:
            self.semantic_memory.add_memory(knowledge, meta)
            logger.info("Reflection complete, knowledge stored")
        except Exception as e:
            logger.error(f"Failed to store reflected knowledge: {e}")

    def _summarize_events(self, events):
        text = " ".join([e.get("summary", "") for e in events]).strip()
        if not text:
            return ""
        return self.llm.summarize(text)

    def _extract_knowledge(self, summary):
        if not summary:
            return ""
        return self.llm.extract_knowledge(summary)
