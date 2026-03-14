from dataclasses import dataclass
from typing import Optional

@dataclass
class MemoryMetadata:
    category: str
    date: str
    agent: str
    source: Optional[str] = None
    hit_count: int = 0
    weight: int = 1

    def to_dict(self):
        return {
            "category": self.category,
            "date": self.date,
            "agent": self.agent,
            "source": self.source or "",
            "hit_count": self.hit_count,
            "weight": self.weight
        }
