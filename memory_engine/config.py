import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    import yaml
except Exception:
    yaml = None

LOG_FORMAT = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
LOG_LEVEL = logging.INFO

logger = logging.getLogger(__name__)

DEFAULTS = {
    "embedding_provider": None,
    "embedding_model": None,
    "embedding_api_key": None,
    "embedding_base_url": None,
    "embedding_dimensions": None,
    "llm_provider": None,
    "llm_model": None,
    "llm_api_key": None,
    "llm_base_url": None,
    "reranker_provider": None,
    "reranker_api_key": None,
    "reranker_api": {
        "url": None,
        "model": None
    },
    "openclaw_base_path": None,
    "lancedb_path": None,
    "chunk": {
        "size": 600,
        "overlap": 100,
        "min_chunk_size": 100,
        "max_chunk_size": 600,
        "target_chunk_size": 300,
        "overlap_size": 100,
        "respect_sentence_boundary": True,
        "respect_paragraph_boundary": True
    },
    "time_decay_halflife": 30,
    "promotion_hit_threshold": 3,
    "log_level": "INFO"
}

_CONFIG: Optional[Dict[str, Any]] = None


def get_config() -> Dict[str, Any]:
    global _CONFIG
    if _CONFIG is None:
        _CONFIG = load_config()
    return _CONFIG


def get_openclaw_base_path() -> str:
    config = get_config()
    base_path = config.get("openclaw_base_path")
    if base_path:
        return os.path.expanduser(base_path)
    if os.environ.get("OPENCLAW_BASE_PATH"):
        return os.path.expanduser(os.environ["OPENCLAW_BASE_PATH"])
    home = Path.home()
    default_path = home / ".openclaw"
    return str(default_path)


def setup_logging(level: str = None):
    config = get_config()
    log_level_str = level or config.get("log_level", "INFO")
    log_level = getattr(logging, log_level_str.upper(), logging.INFO)
    logging.basicConfig(
        level=log_level,
        format=LOG_FORMAT,
        force=True
    )
    for name in logging.root.manager.loggerDict:
        if name.startswith("memory_engine") or name.startswith("api"):
            logging.getLogger(name).setLevel(log_level)


def load_config(config_path: str = "config.yaml") -> Dict[str, Any]:
    config = dict(DEFAULTS)
    
    if yaml is not None:
        if not os.path.exists(config_path):
            config_path = os.path.join(os.path.dirname(__file__), "..", "config.yaml")
        
        if os.path.exists(config_path):
            try:
                with open(config_path, "r", encoding="utf-8") as f:
                    user_config = yaml.safe_load(f) or {}
                config = _deep_merge(config, user_config)
            except Exception as e:
                logger.warning(f"Failed to load config from {config_path}: {e}")
    else:
        logger.warning("PyYAML not installed, skipping config file loading")
    
    if os.environ.get("CORTEX_MEMORY_EMBEDDING_PROVIDER"):
        config["embedding_provider"] = os.environ["CORTEX_MEMORY_EMBEDDING_PROVIDER"]
    if os.environ.get("CORTEX_MEMORY_EMBEDDING_MODEL"):
        config["embedding_model"] = os.environ["CORTEX_MEMORY_EMBEDDING_MODEL"]
    
    if os.environ.get("CORTEX_MEMORY_LLM_PROVIDER"):
        config["llm_provider"] = os.environ["CORTEX_MEMORY_LLM_PROVIDER"]
    if os.environ.get("CORTEX_MEMORY_LLM_MODEL"):
        config["llm_model"] = os.environ["CORTEX_MEMORY_LLM_MODEL"]
    
    if os.environ.get("CORTEX_MEMORY_RERANKER_PROVIDER"):
        config["reranker_provider"] = os.environ["CORTEX_MEMORY_RERANKER_PROVIDER"]
    if os.environ.get("CORTEX_MEMORY_RERANKER_MODEL"):
        config["reranker_api"]["model"] = os.environ["CORTEX_MEMORY_RERANKER_MODEL"]
    
    if os.environ.get("CORTEX_MEMORY_DB_PATH"):
        config["lancedb_path"] = os.environ["CORTEX_MEMORY_DB_PATH"]
    
    if os.environ.get("CORTEX_MEMORY_EMBEDDING_API_KEY"):
        config["embedding_api_key"] = os.environ["CORTEX_MEMORY_EMBEDDING_API_KEY"]
    if os.environ.get("CORTEX_MEMORY_EMBEDDING_BASE_URL"):
        config["embedding_base_url"] = os.environ["CORTEX_MEMORY_EMBEDDING_BASE_URL"]
    if os.environ.get("CORTEX_MEMORY_EMBEDDING_DIMENSIONS"):
        config["embedding_dimensions"] = int(os.environ["CORTEX_MEMORY_EMBEDDING_DIMENSIONS"])
    if os.environ.get("CORTEX_MEMORY_LLM_API_KEY"):
        config["llm_api_key"] = os.environ["CORTEX_MEMORY_LLM_API_KEY"]
    if os.environ.get("CORTEX_MEMORY_LLM_BASE_URL"):
        config["llm_base_url"] = os.environ["CORTEX_MEMORY_LLM_BASE_URL"]
    if os.environ.get("CORTEX_MEMORY_RERANKER_API_KEY"):
        config["reranker_api_key"] = os.environ["CORTEX_MEMORY_RERANKER_API_KEY"]
    if os.environ.get("CORTEX_MEMORY_RERANKER_ENDPOINT"):
        config["reranker_api"]["url"] = os.environ["CORTEX_MEMORY_RERANKER_ENDPOINT"]
    
    if config.get("lancedb_path"):
        config["lancedb_path"] = os.path.expanduser(config["lancedb_path"])
    if config.get("openclaw_base_path"):
        config["openclaw_base_path"] = os.path.expanduser(config["openclaw_base_path"])
        
    return config


def _deep_merge(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
    result = dict(base)
    for key, value in override.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def validate_config(config: Dict[str, Any]) -> List[str]:
    warnings = []
    
    if not config.get("embedding_provider") or not config.get("embedding_model"):
        warnings.append("embedding.provider and embedding.model are required. Set them in openclaw.json plugin config.")
    
    if not config.get("llm_provider") or not config.get("llm_model"):
        warnings.append("llm.provider and llm.model are required. Set them in openclaw.json plugin config.")
    
    reranker_config = config.get("reranker_api", {})
    if not reranker_config.get("model"):
        warnings.append("reranker.model is required. Set it in openclaw.json plugin config.")
    
    chunk_config = config.get("chunk", {})
    chunk_size = chunk_config.get("size", 600)
    chunk_overlap = chunk_config.get("overlap", 100)
    if chunk_overlap >= chunk_size:
        warnings.append(f"chunk.overlap ({chunk_overlap}) should be less than chunk.size ({chunk_size}).")
    
    return warnings
