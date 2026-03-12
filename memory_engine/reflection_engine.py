from .episodic_memory import EpisodicMemory
from .semantic_memory import SemanticMemory
from .metadata_schema import MemoryMetadata
from .llm_client import LLMClient
from datetime import datetime

class ReflectionEngine:
    def __init__(self):
        self.episodic_memory = EpisodicMemory()
        self.semantic_memory = SemanticMemory()
        self.llm = LLMClient()

    def reflect(self):
        events = self.episodic_memory.load_events(limit=50)
        if not events:
            return
        summary = self._summarize_events(events)
        knowledge = self._extract_knowledge(summary)
        if not knowledge:
            return
        meta = MemoryMetadata(
            type="core_rule",
            date=datetime.utcnow().isoformat() + "Z",
            agent="openclaw",
            source_file="reflection"
        )
        self.semantic_memory.add_memory(knowledge, meta)

    def _summarize_events(self, events):
        text = " ".join([e.get("summary", "") for e in events]).strip()
        return self.llm.summarize(text)

    def _extract_knowledge(self, summary):
        return self.llm.extract_knowledge(summary)
