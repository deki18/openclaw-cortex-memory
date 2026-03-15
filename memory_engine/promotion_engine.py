import logging
import os
import threading

from .config import get_config

logger = logging.getLogger(__name__)


class PromotionEngine:
    def __init__(self, cortex_rules_file=None):
        config = get_config()
        if cortex_rules_file is None:
            from .config import get_openclaw_base_path
            base_path = get_openclaw_base_path()
            cortex_rules_file = os.path.join(base_path, "workspace", "CORTEX_RULES.md")
        self.cortex_rules_file = os.path.expanduser(cortex_rules_file)
        self.local_cortex_rules_file = os.path.join(
            os.path.dirname(__file__), "..", "data", "memory", "CORTEX_RULES.md"
        )
        self.threshold = config.get("promotion_hit_threshold", 3)
        self._lock = threading.Lock()
        os.makedirs(os.path.dirname(self.cortex_rules_file), exist_ok=True)

    def check_and_promote(self, hit_count: int, content: str) -> bool:
        if hit_count >= self.threshold:
            self._promote_to_core_rule(content)
            return True
        return False

    def _promote_to_core_rule(self, content: str):
        with self._lock:
            target_file = None
            for path in [self.cortex_rules_file, self.local_cortex_rules_file]:
                if os.path.exists(path):
                    target_file = path
                    break
            
            if target_file is None:
                target_file = self.local_cortex_rules_file
                os.makedirs(os.path.dirname(target_file), exist_ok=True)
            
            try:
                with open(target_file, "a", encoding="utf-8") as f:
                    f.write(f"\n## Promoted Rule\n{content}\n")
                logger.info(f"Promoted content to core rule in {target_file}")
            except Exception as e:
                logger.error(f"Failed to promote to core rule: {e}")
