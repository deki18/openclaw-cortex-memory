import logging
import os
import json
import sys
from pathlib import Path
from logging.handlers import RotatingFileHandler
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


def find_openclaw_config() -> Optional[str]:
    possible_paths = [
        os.path.join(os.getcwd(), "openclaw.json"),
        os.path.join(Path.home(), ".openclaw", "openclaw.json"),
        os.environ.get("OPENCLAW_CONFIG_PATH", ""),
    ]
    
    for path in possible_paths:
        if path and os.path.exists(path):
            return path
    return None


def load_openclaw_config() -> Dict[str, Any]:
    config_path = find_openclaw_config()
    if not config_path:
        return {}
    
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        logger.warning(f"Failed to load openclaw.json from {config_path}: {e}")
        return {}


def extract_plugin_config(openclaw_config: Dict[str, Any]) -> Dict[str, Any]:
    plugin_config = openclaw_config.get("plugins", {}).get("@openclaw/cortex-memory", {})
    result = {}
    
    embedding = plugin_config.get("embedding", {})
    if embedding:
        if embedding.get("provider"):
            result["embedding_provider"] = embedding["provider"]
        if embedding.get("model"):
            result["embedding_model"] = embedding["model"]
        if embedding.get("apiKey"):
            result["embedding_api_key"] = embedding["apiKey"]
        if embedding.get("baseURL"):
            result["embedding_base_url"] = embedding["baseURL"]
        if embedding.get("dimensions"):
            result["embedding_dimensions"] = embedding["dimensions"]
    
    llm = plugin_config.get("llm", {})
    if llm:
        if llm.get("provider"):
            result["llm_provider"] = llm["provider"]
        if llm.get("model"):
            result["llm_model"] = llm["model"]
        if llm.get("apiKey"):
            result["llm_api_key"] = llm["apiKey"]
        if llm.get("baseURL"):
            result["llm_base_url"] = llm["baseURL"]
    
    reranker = plugin_config.get("reranker", {})
    if reranker:
        if reranker.get("provider"):
            result["reranker_provider"] = reranker["provider"]
        if reranker.get("model"):
            result["reranker_api"] = {"model": reranker["model"]}
        if reranker.get("apiKey"):
            result["reranker_api_key"] = reranker["apiKey"]
        if reranker.get("endpoint"):
            if "reranker_api" not in result:
                result["reranker_api"] = {}
            result["reranker_api"]["url"] = reranker["endpoint"]
    
    if plugin_config.get("dbPath"):
        result["lancedb_path"] = plugin_config["dbPath"]
    
    return result


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
    
    root_logger = logging.getLogger()
    root_logger.setLevel(log_level)
    
    formatter = logging.Formatter(LOG_FORMAT, datefmt="%Y-%m-%d %H:%M:%S")
    
    if not root_logger.handlers:
        console_handler = logging.StreamHandler(sys.stdout)
        console_handler.setLevel(log_level)
        console_handler.setFormatter(formatter)
        root_logger.addHandler(console_handler)
        
        try:
            base_path = get_openclaw_base_path()
            log_dir = os.path.join(base_path, "logs")
            os.makedirs(log_dir, exist_ok=True)
            log_file = os.path.join(log_dir, "cortex_memory.log")
            
            file_handler = RotatingFileHandler(
                log_file,
                maxBytes=10 * 1024 * 1024,
                backupCount=5,
                encoding="utf-8"
            )
            file_handler.setLevel(log_level)
            file_handler.setFormatter(formatter)
            root_logger.addHandler(file_handler)
        except Exception as e:
            root_logger.warning(f"Failed to setup file logging: {e}")
    
    for name in logging.root.manager.loggerDict:
        if name.startswith("memory_engine") or name.startswith("api"):
            logging.getLogger(name).setLevel(log_level)
    
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("urllib3").setLevel(logging.WARNING)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)


_initialized = False


def ensure_logging_initialized():
    global _initialized
    if not _initialized:
        setup_logging()
        _initialized = True


def load_config(config_path: str = "config.yaml") -> Dict[str, Any]:
    config = dict(DEFAULTS)
    
    openclaw_config = load_openclaw_config()
    if openclaw_config:
        plugin_config = extract_plugin_config(openclaw_config)
        config = _deep_merge(config, plugin_config)
        logger.info("Loaded configuration from openclaw.json")
    
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


SENSITIVE_KEYS = {"api_key", "apikey", "secret", "token", "password", "credential"}


def sanitize_for_logging(data: Any, max_depth: int = 5) -> Any:
    if max_depth <= 0:
        return "...(max depth reached)"
    
    if isinstance(data, dict):
        sanitized = {}
        for key, value in data.items():
            key_lower = key.lower().replace("-", "").replace("_", "")
            if any(sensitive in key_lower for sensitive in SENSITIVE_KEYS):
                sanitized[key] = "***REDACTED***"
            else:
                sanitized[key] = sanitize_for_logging(value, max_depth - 1)
        return sanitized
    elif isinstance(data, list):
        return [sanitize_for_logging(item, max_depth - 1) for item in data]
    elif isinstance(data, str):
        if len(data) > 500:
            return data[:500] + "...(truncated)"
        return data
    else:
        return data


def safe_log(logger_instance: logging.Logger, level: str, message: str, data: Any = None):
    if data is not None:
        sanitized_data = sanitize_for_logging(data)
        log_message = f"{message}: {sanitized_data}"
    else:
        log_message = message
    
    log_func = getattr(logger_instance, level, logger_instance.info)
    log_func(log_message)
