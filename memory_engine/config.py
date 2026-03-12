import logging
import os
from pathlib import Path
from typing import Any, Dict, List

try:
    import yaml
except Exception:
    yaml = None

logger = logging.getLogger(__name__)

DEFAULTS = {
    "embedding_model": "",
    "llm_model": "",
    "openai_base_url": "",
    "openclaw_base_path": "~/.openclaw",
    "lancedb_path": "~/.openclaw/agents/main/lancedb_store",
    "reranker_api": {
        "url": "https://api.siliconflow.cn/v1/rerank",
        "model": ""
    },
    "chunk": {"size": 600, "overlap": 100},
    "time_decay_halflife": 30,
    "promotion_hit_threshold": 3
}


def load_config(config_path: str = "config.yaml") -> Dict[str, Any]:
    config = dict(DEFAULTS)
    
    if yaml is None:
        logger.warning("PyYAML not installed, using default configuration")
        return config
    
    if not os.path.exists(config_path):
        config_path = os.path.join(os.path.dirname(__file__), "..", "config.yaml")
    
    if os.path.exists(config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                user_config = yaml.safe_load(f) or {}
            config = _deep_merge(config, user_config)
        except Exception as e:
            logger.error(f"Failed to load config from {config_path}: {e}")
    
    if "lancedb_path" in config:
        config["lancedb_path"] = os.path.expanduser(config["lancedb_path"])
    if "openclaw_base_path" in config:
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
    
    if not config.get("embedding_model"):
        warnings.append("embedding_model is not configured. Vector embeddings will be zero vectors.")
    
    if not config.get("llm_model"):
        warnings.append("llm_model is not configured. LLM features will use fallback (truncation).")
    
    reranker_config = config.get("reranker_api", {})
    if not reranker_config.get("model"):
        warnings.append("reranker_api.model is not configured. Reranking will be skipped.")
    
    chunk_config = config.get("chunk", {})
    chunk_size = chunk_config.get("size", 600)
    chunk_overlap = chunk_config.get("overlap", 100)
    if chunk_overlap >= chunk_size:
        warnings.append(f"chunk.overlap ({chunk_overlap}) should be less than chunk.size ({chunk_size}).")
    
    halflife = config.get("time_decay_halflife", 30)
    if halflife <= 0:
        warnings.append("time_decay_halflife should be a positive number.")
    
    threshold = config.get("promotion_hit_threshold", 3)
    if threshold <= 0:
        warnings.append("promotion_hit_threshold should be a positive number.")
    
    return warnings


def check_environment() -> List[str]:
    issues = []
    
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        issues.append("OPENAI_API_KEY environment variable is not set.")
    
    reranker_key = os.environ.get("RERANKER_API_KEY")
    reranker_model = CONFIG.get("reranker_api", {}).get("model")
    if reranker_model and not reranker_key:
        issues.append("RERANKER_API_KEY is required when reranker_api.model is configured.")
    
    return issues


CONFIG = load_config()


def print_config_status():
    warnings = validate_config(CONFIG)
    env_issues = check_environment()
    
    if warnings or env_issues:
        logger.warning("Configuration issues detected:")
        for w in warnings:
            logger.warning(f"  - {w}")
        for e in env_issues:
            logger.warning(f"  - {e}")
    else:
        logger.info("Configuration validated successfully")
