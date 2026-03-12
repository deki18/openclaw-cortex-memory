from typing import Any, Dict, Optional
from memory_engine.memory_controller import MemoryController

class CortexMemoryPlugin:
    def __init__(self, config: Optional[Dict[str, Any]] = None):
        self.config = config or {}
        self.controller = MemoryController()
        self.context = None
        self.enabled = True

    def register(self, app_context: Any = None) -> Dict[str, Any]:
        self.context = app_context
        return {
            "name": "cortex-memory",
            "version": "0.1.0",
            "hooks": ["on_message", "on_session_end", "on_timer"],
            "skills": []
        }

    def on_message(self, message: Dict[str, Any]):
        if not self.enabled:
            return None
        text = message.get("content") or message.get("text") or ""
        source = message.get("source") or "message"
        if text:
            self.controller.write_memory(text, source=source)
        return None

    def on_session_end(self, session: Dict[str, Any]):
        if not self.enabled:
            return None
        path = session.get("path")
        if path:
            self.controller.write_pipeline.process_sessions(path)
        return None

    def on_timer(self, payload: Dict[str, Any]):
        if not self.enabled:
            return None
        action = payload.get("action")
        if action == "sync":
            self.controller.sync_memory()
        elif action == "reflect":
            self.controller.reflect_memory()
        elif action == "promote":
            self.controller.promote_memory()
        return None

def create_plugin(config: Optional[Dict[str, Any]] = None) -> CortexMemoryPlugin:
    return CortexMemoryPlugin(config)
