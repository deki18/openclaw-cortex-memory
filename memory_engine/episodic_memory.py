import json
import os
import uuid
from datetime import datetime

class EpisodicMemory:
    def __init__(self, store_path="~/.openclaw/episodic_memory.jsonl"):
        self.store_path = os.path.expanduser(store_path)
        os.makedirs(os.path.dirname(self.store_path), exist_ok=True)

    def store_event(self, summary: str, entities: list = None, outcome: str = "", source_file: str = ""):
        event = {
            "id": str(uuid.uuid4()),
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "summary": summary,
            "entities": entities or [],
            "outcome": outcome,
            "source_file": source_file
        }
        
        with open(self.store_path, "a") as f:
            f.write(json.dumps(event) + "\n")
            
        return event["id"]

    def load_events(self, limit=100):
        events = []
        if not os.path.exists(self.store_path):
            return events
            
        with open(self.store_path, "r") as f:
            for line in f:
                events.append(json.loads(line.strip()))
                
        return events[-limit:]
