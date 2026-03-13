import logging
import os
import threading

from .config import get_config

logger = logging.getLogger(__name__)


class PromotionEngine:
    def __init__(self, memory_file=None):
        config = get_config()
        if memory_file is None:
            from .config import get_openclaw_base_path
            base_path = get_openclaw_base_path()
            memory_file = os.path.join(base_path, "workspace", "MEMORY.md")
        self.memory_file = os.path.expanduser(memory_file)
        self.threshold = config.get("promotion_hit_threshold", 3)
        self._lock = threading.Lock()
        os.makedirs(os.path.dirname(self.memory_file), exist_ok=True)

    def check_and_promote(self, hit_count: int, content: str) -> bool:
        if hit_count >= self.threshold:
            self._promote_to_core_rule(content)
            return True
        return False

    def _promote_to_core_rule(self, content: str):
        with self._lock:
            try:
                with open(self.memory_file, "a", encoding="utf-8") as f:
                    f.write(f"\n## Promoted Rule\n{content}\n")
                logger.info(f"Promoted content to core rule in {self.memory_file}")
            except Exception as e:
                logger.error(f"Failed to promote to core rule: {e}")
