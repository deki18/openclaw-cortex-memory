import logging
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from memory_engine.memory_controller import MemoryController
from memory_engine.config import load_config, CONFIG, setup_logging

setup_logging()
logger = logging.getLogger(__name__)

controller: Optional[MemoryController] = None


class SearchRequest(BaseModel):
    query: str
    top_k: int = 10
    final_k: int = 3
    query_type: str = "hybrid"
    memory_type: Optional[str] = None


class StoreEventRequest(BaseModel):
    summary: str
    entities: Optional[List[Dict[str, Any]]] = None
    outcome: str = ""
    relations: Optional[List[Dict[str, Any]]] = None


class WriteMemoryRequest(BaseModel):
    text: str
    source: str = "api"


class QueryGraphRequest(BaseModel):
    entity: str


class ImportRequest(BaseModel):
    path: str = None


class DateRangeRequest(BaseModel):
    start_date: str
    end_date: str
    limit: int = 50


class MigrateRequest(BaseModel):
    chromadb_path: str


@asynccontextmanager
async def lifespan(app: FastAPI):
    global controller
    config = load_config()
    errors = validate_config(config)
    if errors:
        for err in errors:
            logger.warning(f"Configuration warning: {err}")
    controller = MemoryController()
    logger.info("Cortex Memory API started")
    yield
    logger.info("Cortex Memory API stopped")


app = FastAPI(
    title="OpenClaw Cortex Memory API",
    description="Long-term memory system for AI Agents powered by LanceDB",
    version="2.0.0",
    lifespan=lifespan
)


def validate_config(config: Dict[str, Any]) -> List[str]:
    errors = []
    if not config.get("embedding_provider"):
        errors.append("embedding.provider is required in openclaw.json (e.g., 'openai', 'openai-compatible')")
    if not config.get("embedding_model"):
        errors.append("embedding.model is required in openclaw.json (e.g., 'text-embedding-3-large')")
    if not config.get("llm_provider"):
        errors.append("llm.provider is required in openclaw.json (e.g., 'openai')")
    if not config.get("llm_model"):
        errors.append("llm.model is required in openclaw.json (e.g., 'gpt-4')")
    return errors


@app.get("/health")
async def health_check():
    health_status = {
        "status": "ok",
        "service": "cortex-memory-api",
        "version": "2.0.0",
        "checks": {}
    }
    
    try:
        from memory_engine.config import CONFIG
        health_status["checks"]["embedding_configured"] = bool(CONFIG.get("embedding_model"))
        health_status["checks"]["llm_configured"] = bool(CONFIG.get("llm_model"))
        health_status["checks"]["reranker_configured"] = bool(CONFIG.get("reranker_api", {}).get("model"))
        health_status["checks"]["db_path"] = CONFIG.get("lancedb_path", "not set")
    except Exception as e:
        health_status["checks"]["config_load"] = f"error: {str(e)}"
    
    if controller:
        try:
            health_status["checks"]["database"] = "connected"
            health_status["checks"]["total_memories"] = controller.semantic.count()
        except Exception as e:
            health_status["checks"]["database"] = f"error: {str(e)}"
    else:
        health_status["checks"]["controller"] = "not initialized"
    
    return health_status


@app.get("/config")
async def get_config():
    return CONFIG


@app.get("/status")
async def get_status():
    if not controller:
        raise HTTPException(status_code=503, detail="Service not initialized")
    
    total_count = controller.semantic.count()
    core_rules_count = controller.semantic.count_by_type("core_rule")
    daily_logs_count = controller.semantic.count_by_type("daily_log")
    
    return {
        "status": "online",
        "config_warnings": validate_config(CONFIG),
        "stats": {
            "total_memories": total_count,
            "core_rules": core_rules_count,
            "daily_logs": daily_logs_count
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
    
    embedding_model = CONFIG.get("embedding_model")
    add_check(
        "Embedding Model",
        bool(embedding_model),
        f"Embedding model: {embedding_model or 'NOT SET'}",
        "Add 'embedding.model' to openclaw.json (e.g., 'text-embedding-3-large')"
    )
    
    llm_model = CONFIG.get("llm_model")
    add_check(
        "LLM Model",
        bool(llm_model),
        f"LLM model: {llm_model or 'NOT SET'}",
        "Add 'llm.model' to openclaw.json (e.g., 'gpt-4')"
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
            count = controller.semantic.count()
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
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        results = controller.retrieval.search(
            query=request.query,
            top_k=request.top_k,
            final_k=request.final_k,
            query_type=request.query_type,
            memory_type=request.memory_type
        )
        return {"query": request.query, "results": results}
    except Exception as e:
        logger.error(f"Search error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/write")
async def write_memory(request: WriteMemoryRequest):
    if not controller:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        memory_id = controller.write_memory(request.text, source=request.source)
        return {"status": "ok", "memory_id": memory_id}
    except Exception as e:
        logger.error(f"Write error: {e}")
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
        events = controller.episodic.load_events(limit=limit)
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
        controller.sync_memory()
        return {"status": "ok"}
    except Exception as e:
        logger.error(f"Sync error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/reflect")
async def reflect_memory():
    if not controller:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        controller.reflect_memory()
        return {"status": "ok"}
    except Exception as e:
        logger.error(f"Reflect error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/promote")
async def promote_memory():
    if not controller:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        controller.promote_memory()
        return {"status": "ok"}
    except Exception as e:
        logger.error(f"Promote error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/import")
async def import_legacy_data(request: ImportRequest):
    if not controller:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        controller.import_legacy_data(request.path)
        return {"status": "ok"}
    except Exception as e:
        logger.error(f"Import error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/install")
async def install_core_rules():
    if not controller:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        controller.inject_core_rule()
        return {"status": "ok"}
    except Exception as e:
        logger.error(f"Install error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/rebuild")
async def rebuild_fts_index():
    if not controller:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        controller.semantic.store.rebuild_fts_index()
        return {"status": "ok"}
    except Exception as e:
        logger.error(f"Rebuild error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/core-rules")
async def get_core_rules(limit: int = 20):
    if not controller:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        rules = controller.retrieval.get_core_rules(limit=limit)
        return {"core_rules": rules}
    except Exception as e:
        logger.error(f"Get core rules error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/search/date-range")
async def search_by_date_range(request: DateRangeRequest):
    if not controller:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        results = controller.retrieval.search_by_date_range(
            start_date=request.start_date,
            end_date=request.end_date,
            limit=request.limit
        )
        return {"results": results}
    except Exception as e:
        logger.error(f"Date range search error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/migrate")
async def migrate_from_chromadb(request: MigrateRequest):
    if not controller:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        from memory_engine.migration import migrate_from_chromadb
        migrated = migrate_from_chromadb(request.chromadb_path, controller.semantic.store)
        return {"status": "ok", "migrated_count": migrated}
    except Exception as e:
        logger.error(f"Migration error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/count")
async def count_memories():
    if not controller:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        total = controller.semantic.count()
        core_rules = controller.semantic.count_by_type("core_rule")
        daily_logs = controller.semantic.count_by_type("daily_log")
        return {
            "total": total,
            "core_rules": core_rules,
            "daily_logs": daily_logs
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
        memory = controller.semantic.get_by_id(memory_id)
        if not memory:
            raise HTTPException(status_code=404, detail=f"Memory not found: {memory_id}")
        controller.semantic.delete_by_id(memory_id)
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
        memory = controller.semantic.get_by_id(memory_id)
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
            controller.semantic.update_memory(memory_id, update_data)
        
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
        deleted_count = controller.cleanup_old_memories(
            days_old=request.days_old,
            memory_type=request.memory_type
        )
        return {"status": "ok", "deleted_count": deleted_count}
    except Exception as e:
        logger.error(f"Cleanup error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8765)
