import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from memory_engine.enhanced_controller import EnhancedMemoryController, get_controller, reset_controller
from memory_engine.config import load_config, get_config, setup_logging, validate_config

setup_logging()
logger = logging.getLogger(__name__)

logging.getLogger("uvicorn").setLevel(logging.WARNING)
logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
logging.getLogger("uvicorn.error").setLevel(logging.WARNING)

controller: Optional[EnhancedMemoryController] = None


class CircuitBreaker:
    def __init__(self, failure_threshold: int = 5, recovery_timeout: int = 60):
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.failure_count = 0
        self.last_failure_time: Optional[float] = None
        self.state = "closed"
    
    def record_failure(self):
        self.failure_count += 1
        self.last_failure_time = datetime.now().timestamp()
        if self.failure_count >= self.failure_threshold:
            self.state = "open"
    
    def record_success(self):
        self.failure_count = 0
        self.state = "closed"
    
    def is_available(self) -> bool:
        if self.state == "closed":
            return True
        if self.last_failure_time:
            elapsed = datetime.now().timestamp() - self.last_failure_time
            if elapsed >= self.recovery_timeout:
                self.state = "half-open"
                return True
        return False


circuit_breaker = CircuitBreaker()


class HealthChecker:
    def __init__(self):
        self._last_check_time: Optional[float] = None
        self._cached_status: Optional[Dict[str, Any]] = None
        self._cache_ttl = 5
    
    def check_embedding_service(self) -> Dict[str, Any]:
        try:
            from memory_engine.embedding import EmbeddingModule
            emb = EmbeddingModule()
            return {
                "status": "healthy" if emb.is_available() else "degraded",
                "provider": emb.provider,
                "model": emb.model
            }
        except Exception as e:
            return {"status": "unhealthy", "error": str(e)}
    
    def check_database(self) -> Dict[str, Any]:
        if not controller:
            return {"status": "unhealthy", "error": "Controller not initialized"}
        try:
            count = controller.semantic.count()
            return {"status": "healthy", "memory_count": count}
        except Exception as e:
            return {"status": "unhealthy", "error": str(e)}
    
    def check_config(self) -> Dict[str, Any]:
        try:
            config = get_config()
            warnings = validate_config(config)
            return {
                "status": "healthy" if not warnings else "degraded",
                "warnings": warnings
            }
        except Exception as e:
            return {"status": "unhealthy", "error": str(e)}
    
    def get_full_status(self, use_cache: bool = True) -> Dict[str, Any]:
        now = datetime.now().timestamp()
        if use_cache and self._cached_status and self._last_check_time:
            if now - self._last_check_time < self._cache_ttl:
                return self._cached_status
        
        checks = {
            "embedding": self.check_embedding_service(),
            "database": self.check_database(),
            "config": self.check_config(),
            "circuit_breaker": {
                "state": circuit_breaker.state,
                "failure_count": circuit_breaker.failure_count
            }
        }
        
        all_healthy = all(
            c.get("status") == "healthy" or c.get("status") == "degraded"
            for c in checks.values() if isinstance(c, dict) and "status" in c
        )
        
        status = {
            "status": "healthy" if all_healthy else "unhealthy",
            "service": "cortex-memory-api",
            "version": "2.0.0",
            "timestamp": datetime.now().isoformat(),
            "checks": checks
        }
        
        self._cached_status = status
        self._last_check_time = now
        return status


health_checker = HealthChecker()


class ErrorResponse(BaseModel):
    success: bool = False
    error: str
    error_code: str
    details: Optional[Dict[str, Any]] = None


ERROR_CODES = {
    "SERVICE_NOT_INITIALIZED": "E503",
    "CONFIG_ERROR": "E001",
    "DATABASE_ERROR": "E002",
    "INVALID_INPUT": "E003",
    "NOT_FOUND": "E404",
    "INTERNAL_ERROR": "E500",
    "EMBEDDING_UNAVAILABLE": "E101",
    "LLM_UNAVAILABLE": "E102",
    "EMPTY_QUERY": "E201",
    "EMPTY_TEXT": "E202",
    "DUPLICATE_MEMORY": "E203",
    "LOW_QUALITY": "E204",
    "RATE_LIMITED": "E429",
    "TIMEOUT": "E408"
}


ERROR_MESSAGES = {
    "SERVICE_NOT_INITIALIZED": "Memory service is not ready. Please wait a moment and try again.",
    "CONFIG_ERROR": "Configuration error. Please check your openclaw.json settings.",
    "DATABASE_ERROR": "Database operation failed. The memory store may be corrupted or inaccessible.",
    "INVALID_INPUT": "Invalid input provided. Please check your request parameters.",
    "NOT_FOUND": "The requested resource was not found.",
    "INTERNAL_ERROR": "An internal error occurred. Please try again later.",
    "EMBEDDING_UNAVAILABLE": "Embedding service is unavailable. Check your API key and model configuration.",
    "LLM_UNAVAILABLE": "LLM service is unavailable. Check your API key and model configuration.",
    "EMPTY_QUERY": "Search query cannot be empty.",
    "EMPTY_TEXT": "Memory text cannot be empty.",
    "DUPLICATE_MEMORY": "This memory appears to be a duplicate of an existing one.",
    "LOW_QUALITY": "Memory was not stored due to low quality score.",
    "RATE_LIMITED": "Too many requests. Please wait before trying again.",
    "TIMEOUT": "Request timed out. Please try again."
}


def create_error_response(message: str, error_code: str, details: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    return {
        "success": False,
        "error": message,
        "error_code": error_code,
        "details": details
    }


def raise_api_error(status_code: int, message: str, error_code: str, details: Optional[Dict[str, Any]] = None):
    raise HTTPException(
        status_code=status_code,
        detail=create_error_response(message, error_code, details)
    )


class SearchRequest(BaseModel):
    query: str
    top_k: int = 10
    final_k: int = 3
    query_type: str = "hybrid"
    memory_type: Optional[str] = None
    session_id: Optional[str] = None


class StoreEventRequest(BaseModel):
    summary: str
    entities: Optional[List[Dict[str, Any]]] = None
    outcome: str = ""
    relations: Optional[List[Dict[str, Any]]] = None


class WriteMemoryRequest(BaseModel):
    text: str
    source: str = "api"
    role: str = "user"
    session_id: Optional[str] = None


class QueryGraphRequest(BaseModel):
    entity: str


class SessionEndRequest(BaseModel):
    session_id: Optional[str] = None
    sync_records: Optional[bool] = None


class ImportRequest(BaseModel):
    path: str = None


class DateRangeRequest(BaseModel):
    start_date: str
    end_date: str
    limit: int = 50


@asynccontextmanager
async def lifespan(app: FastAPI):
    global controller
    config = load_config()
    errors = validate_config(config)
    if errors:
        for err in errors:
            logger.warning(f"Configuration warning: {err}")
    controller = get_controller(config)
    controller.start()
    logger.info("Cortex Memory API started")
    yield
    reset_controller()
    logger.info("Cortex Memory API stopped")


app = FastAPI(
    title="OpenClaw Cortex Memory API",
    description="Long-term memory system for AI Agents powered by LanceDB",
    version="2.0.0",
    lifespan=lifespan
)


@app.get("/health")
async def health_check():
    return health_checker.get_full_status()


@app.get("/health/live")
async def liveness_check():
    return {"status": "alive", "timestamp": datetime.now().isoformat()}


@app.get("/health/ready")
async def readiness_check():
    if not circuit_breaker.is_available():
        raise HTTPException(status_code=503, detail="Service unavailable due to circuit breaker")
    if not controller:
        raise HTTPException(status_code=503, detail="Service not initialized")
    return {"status": "ready", "timestamp": datetime.now().isoformat()}


@app.post("/shutdown")
async def shutdown_server():
    import os
    import signal
    logger.info("Shutdown requested via API")
    os.kill(os.getpid(), signal.SIGTERM)
    return {"status": "shutting down"}


@app.get("/config")
async def get_config_route():
    return get_config()


@app.get("/status")
async def get_status():
    if not controller:
        raise HTTPException(status_code=503, detail="Service not initialized")
    
    cfg = get_config()
    stats = controller.get_stats()
    
    return {
        "status": "online",
        "config_warnings": validate_config(cfg),
        "stats": {
            "total_memories": stats.get("store", {}).get("total_memories", 0),
            "tiered": stats.get("tiered", {}),
            "graph": stats.get("graph", {})
        }
    }


@app.get("/doctor")
async def run_diagnostics():
    diagnostics = {
        "status": "running",
        "checks": [],
        "recommendations": []
    }
    
    def add_check(name: str, passed: bool, message: str, fix: str = None):
        diagnostics["checks"].append({
            "name": name,
            "passed": passed,
            "message": message
        })
        if not passed and fix:
            diagnostics["recommendations"].append(fix)
    
    add_check(
        "Config Loading",
        True,
        "Configuration loaded successfully"
    )
    
    cfg = get_config()
    embedding_model = cfg.get("embedding_model")
    add_check(
        "Embedding Model",
        bool(embedding_model),
        f"Embedding model: {embedding_model or 'NOT SET'}",
        "Add 'embedding.model' to openclaw.json (e.g., 'text-embedding-3-large')"
    )
    
    llm_model = cfg.get("llm_model")
    add_check(
        "LLM Model",
        bool(llm_model),
        f"LLM model: {llm_model or 'NOT SET'}",
        "Add 'llm.model' to openclaw.json (e.g., 'gpt-4')"
    )
    
    reranker_model = cfg.get("reranker_api", {}).get("model")
    add_check(
        "Reranker Model",
        bool(reranker_model),
        f"Reranker model: {reranker_model or 'NOT SET'}",
        "Add 'reranker.model' to openclaw.json (e.g., 'BAAI/bge-reranker-v2-m3')"
    )
    
    try:
        from memory_engine.config import get_openclaw_base_path
        base_path = get_openclaw_base_path()
        add_check(
            "OpenClaw Base Path",
            os.path.exists(base_path),
            f"Base path: {base_path}",
            f"Ensure OpenClaw is initialized at {base_path}"
        )
    except Exception as e:
        add_check("OpenClaw Base Path", False, f"Error: {e}")
    
    if controller:
        try:
            stats = controller.get_stats()
            count = stats.get("store", {}).get("total_memories", 0)
            add_check(
                "Database Connection",
                True,
                f"Connected, {count} memories stored"
            )
        except Exception as e:
            add_check(
                "Database Connection",
                False,
                f"Database error: {e}",
                "Check if LanceDB path is writable"
            )
    else:
        add_check(
            "Memory Controller",
            False,
            "Controller not initialized",
            "Restart the service"
        )
    
    all_passed = all(c["passed"] for c in diagnostics["checks"])
    diagnostics["status"] = "healthy" if all_passed else "issues_found"
    
    return diagnostics


@app.post("/search")
async def search_memory(request: SearchRequest):
    if not controller:
        raise HTTPException(
            status_code=503, 
            detail=create_error_response(
                ERROR_MESSAGES["SERVICE_NOT_INITIALIZED"],
                ERROR_CODES["SERVICE_NOT_INITIALIZED"]
            )
        )
    
    if not request.query or not request.query.strip():
        raise HTTPException(
            status_code=400,
            detail=create_error_response(
                ERROR_MESSAGES["EMPTY_QUERY"],
                ERROR_CODES["EMPTY_QUERY"],
                {"query": request.query}
            )
        )
    
    try:
        if not controller.should_search(request.query):
            return {
                "query": request.query, 
                "results": [], 
                "total": 0, 
                "skipped": True, 
                "reason": "Query is a simple greeting or response that doesn't require memory search"
            }
        
        result = controller.search(
            query=request.query,
            top_k=request.top_k
        )
        return {"query": request.query, "results": result.items, "total": result.total, "skipped": False}
    except Exception as e:
        logger.error(f"Search error: {e}")
        raise HTTPException(
            status_code=500,
            detail=create_error_response(
                ERROR_MESSAGES["INTERNAL_ERROR"],
                ERROR_CODES["INTERNAL_ERROR"],
                {"original_error": str(e)}
            )
        )


@app.post("/write")
async def write_memory(request: WriteMemoryRequest):
    if not controller:
        raise HTTPException(
            status_code=503,
            detail=create_error_response(
                ERROR_MESSAGES["SERVICE_NOT_INITIALIZED"],
                ERROR_CODES["SERVICE_NOT_INITIALIZED"]
            )
        )
    
    if not request.text or not request.text.strip():
        raise HTTPException(
            status_code=400,
            detail=create_error_response(
                ERROR_MESSAGES["EMPTY_TEXT"],
                ERROR_CODES["EMPTY_TEXT"],
                {"text": request.text}
            )
        )
    
    try:
        result = controller.write_memory(
            request.text, 
            source=request.source,
            role=request.role,
            session_id=request.session_id
        )
        if result.success:
            return {"status": "ok", "memory_id": result.memory_id}
        elif result.is_duplicate:
            return {
                "status": "skipped",
                "reason": ERROR_MESSAGES["DUPLICATE_MEMORY"],
                "error_code": ERROR_CODES["DUPLICATE_MEMORY"],
                "is_duplicate": True
            }
        elif result.quality and not result.quality.should_store:
            return {
                "status": "skipped",
                "reason": ERROR_MESSAGES["LOW_QUALITY"],
                "error_code": ERROR_CODES["LOW_QUALITY"],
                "quality_score": result.quality.score.overall if result.quality.score else None
            }
        else:
            return {
                "status": "skipped",
                "reason": result.error or "Unknown reason",
                "error_code": ERROR_CODES["INTERNAL_ERROR"]
            }
    except Exception as e:
        logger.error(f"Write error: {e}")
        raise HTTPException(
            status_code=500,
            detail=create_error_response(
                ERROR_MESSAGES["INTERNAL_ERROR"],
                ERROR_CODES["INTERNAL_ERROR"],
                {"original_error": str(e)}
            )
        )


@app.post("/session-end")
async def end_session(request: Optional[SessionEndRequest] = None):
    if not controller:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        payload = request or SessionEndRequest()
        events = controller.end_session(
            session_id=payload.session_id,
            sync_records=payload.sync_records
        )
        return {
            "status": "ok",
            "events_generated": len(events),
            "event_ids": [e.id for e in events] if events else []
        }
    except Exception as e:
        logger.error(f"End session error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/event")
async def store_event(request: StoreEventRequest):
    if not controller:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        event_id = controller.store_event(
            summary=request.summary,
            entities=request.entities,
            outcome=request.outcome,
            relations=request.relations
        )
        return {"event_id": event_id}
    except Exception as e:
        logger.error(f"Store event error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/events")
async def list_events(limit: int = 100):
    if not controller:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        events = controller.get_events(limit=limit)
        return {"events": events}
    except Exception as e:
        logger.error(f"List events error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/graph/query")
async def query_graph(request: QueryGraphRequest):
    if not controller:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        result = controller.query_graph(request.entity)
        return {"entity": request.entity, "graph": result}
    except Exception as e:
        logger.error(f"Graph query error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/hot-context")
async def get_hot_context(limit: int = 20):
    if not controller:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        context = controller.get_hot_context(limit=limit)
        return {"context": context}
    except Exception as e:
        logger.error(f"Hot context error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/sync")
async def sync_memory():
    if not controller:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        from memory_engine.services.sync_service import MemorySyncService
        sync_service = MemorySyncService(
            write_pipeline=controller.write_pipeline if hasattr(controller, 'write_pipeline') else None
        )
        sync_service.import_legacy_data()
        sync_service.sync_sessions()
        controller.run_maintenance()
        return {"status": "ok", "message": "Historical data imported successfully"}
    except Exception as e:
        logger.error(f"Sync error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/reflect")
async def reflect_memory():
    if not controller:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        result = controller.reflect()
        return result
    except Exception as e:
        logger.error(f"Reflect error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/promote")
async def promote_memory():
    if not controller:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        result = controller.promote()
        return result
    except Exception as e:
        logger.error(f"Promote error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/import")
async def import_legacy_data(request: ImportRequest):
    if not controller:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        return {"status": "ok", "message": "Use sync_memory tool for historical data import"}
    except Exception as e:
        logger.error(f"Import error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/install")
async def install_core_rules():
    if not controller:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        from memory_engine.services.sync_service import MemorySyncService
        sync_service = MemorySyncService()
        sync_service.inject_core_rule()
        return {"status": "ok", "message": "Core rules injected successfully"}
    except Exception as e:
        logger.error(f"Install error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/rebuild")
async def rebuild_fts_index():
    if not controller:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        controller.store.rebuild_fts_index()
        return {"status": "ok"}
    except Exception as e:
        logger.error(f"Rebuild error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/core-rules")
async def get_core_rules(limit: int = 20):
    if not controller:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        result = controller.search("core rules important", top_k=limit)
        return {"core_rules": result.items}
    except Exception as e:
        logger.error(f"Get core rules error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/search/date-range")
async def search_by_date_range(request: DateRangeRequest):
    if not controller:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        result = controller.search(
            query=f"date range {request.start_date} to {request.end_date}",
            top_k=request.limit
        )
        return {"results": result.items}
    except Exception as e:
        logger.error(f"Date range search error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/count")
async def count_memories():
    if not controller:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        stats = controller.get_stats()
        return {
            "total": stats.get("store", {}).get("total_memories", 0),
            "tiered": stats.get("tiered", {}),
            "graph": stats.get("graph", {})
        }
    except Exception as e:
        logger.error(f"Count error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


class DeleteMemoryRequest(BaseModel):
    memory_id: str


class UpdateMemoryRequest(BaseModel):
    memory_id: str
    text: Optional[str] = None
    type: Optional[str] = None
    weight: Optional[int] = None


class CleanupRequest(BaseModel):
    days_old: int = 90
    memory_type: Optional[str] = None


@app.delete("/memory/{memory_id}")
async def delete_memory(memory_id: str):
    if not controller:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        success = controller.delete_memory(memory_id)
        if not success:
            raise HTTPException(status_code=404, detail=f"Memory not found: {memory_id}")
        return {"status": "ok", "deleted_id": memory_id}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Delete memory error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.patch("/memory/{memory_id}")
async def update_memory(memory_id: str, request: UpdateMemoryRequest):
    if not controller:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        memory = controller.get_memory(memory_id)
        if not memory:
            raise HTTPException(status_code=404, detail=f"Memory not found: {memory_id}")
        
        update_data = {}
        if request.text is not None:
            update_data["text"] = request.text
        if request.type is not None:
            update_data["type"] = request.type
        if request.weight is not None:
            update_data["weight"] = request.weight
        
        if update_data:
            controller.store.update_memory(memory_id, update_data)
        
        return {"status": "ok", "memory_id": memory_id}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Update memory error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/cleanup")
async def cleanup_old_memories(request: CleanupRequest):
    if not controller:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        controller.run_maintenance()
        return {"status": "ok", "message": "Maintenance completed"}
    except Exception as e:
        logger.error(f"Cleanup error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8765)
