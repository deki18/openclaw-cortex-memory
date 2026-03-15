import logging
import os
from datetime import datetime, timezone

from .episodic_memory import EpisodicMemory
from .llm_client import LLMClient

logger = logging.getLogger(__name__)


class ReflectionEngine:
    def __init__(self, cortex_rules_file=None):
        self.episodic_memory = EpisodicMemory()
        self.llm = LLMClient()
        
        if cortex_rules_file is None:
            from .config import get_openclaw_base_path
            base_path = get_openclaw_base_path()
            cortex_rules_file = os.path.join(base_path, "workspace", "CORTEX_RULES.md")
        self.cortex_rules_file = os.path.expanduser(cortex_rules_file)
        self.local_cortex_rules_file = os.path.join(
            os.path.dirname(__file__), "..", "data", "memory", "CORTEX_RULES.md"
        )

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
        
        self._write_to_cortex_rules(knowledge)
        logger.info("Reflection complete, knowledge stored to CORTEX_RULES.md")

    def _summarize_events(self, events):
        text = " ".join([e.get("summary", "") for e in events]).strip()
        if not text:
            return ""
        return self.llm.summarize(text)

    def _extract_knowledge(self, summary):
        if not summary:
            return ""
        return self.llm.extract_knowledge(summary)

    def _write_to_cortex_rules(self, knowledge: str):
        target_file = None
        for path in [self.cortex_rules_file, self.local_cortex_rules_file]:
            if os.path.exists(path):
                target_file = path
                break
        
        if target_file is None:
            target_file = self.local_cortex_rules_file
            os.makedirs(os.path.dirname(target_file), exist_ok=True)
        
        try:
            timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
            with open(target_file, "a", encoding="utf-8") as f:
                f.write(f"\n## Reflected Knowledge ({timestamp})\n{knowledge}\n")
            logger.info(f"Wrote reflected knowledge to {target_file}")
        except Exception as e:
            logger.error(f"Failed to write to CORTEX_RULES.md: {e}")
