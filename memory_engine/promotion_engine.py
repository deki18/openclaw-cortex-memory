import os
from .config import CONFIG

class PromotionEngine:
    def __init__(self, memory_file="~/.openclaw/workspace/MEMORY.md"):
        self.memory_file = os.path.expanduser(memory_file)
        self.threshold = CONFIG.get("promotion_hit_threshold", 3)
        os.makedirs(os.path.dirname(self.memory_file), exist_ok=True)

    def check_and_promote(self, hit_count: int, content: str) -> bool:
        if hit_count >= self.threshold:
            self._promote_to_core_rule(content)
            return True
        return False

    def _promote_to_core_rule(self, content: str):
        with open(self.memory_file, "a") as f:
            f.write(f"\n## Promoted Rule\n{content}\n")
