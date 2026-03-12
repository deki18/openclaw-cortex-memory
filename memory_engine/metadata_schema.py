from dataclasses import dataclass
from typing import Optional

@dataclass
class MemoryMetadata:
    type: str
    date: str
    agent: str
    source_file: Optional[str] = None
    hit_count: int = 0
    weight: int = 1

    def to_dict(self):
        return {
            "type": self.type,
            "date": self.date,
            "agent": self.agent,
            "source_file": self.source_file or "",
            "hit_count": self.hit_count,
            "weight": self.weight
        }
