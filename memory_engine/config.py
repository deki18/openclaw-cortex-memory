import os
from pathlib import Path
try:
    import yaml
except Exception:
    yaml = None

def load_config(config_path="config.yaml"):
    defaults = {
        "embedding_model": "",
        "llm_model": "",
        "openai_base_url": "",
        "openclaw_base_path": "~/.openclaw",
        "vector_db_path": "~/.openclaw/vector_store",
        "reranker_api": {
            "url": "https://api.siliconflow.cn/v1/rerank",
            "model": ""
        },
        "chunk": {"size": 600, "overlap": 100},
        "time_decay_halflife": 30,
        "promotion_hit_threshold": 3
    }
    if yaml is None:
        return defaults
    if not os.path.exists(config_path):
        config_path = os.path.join(os.path.dirname(__file__), "..", "config.yaml")
    with open(config_path, "r") as f:
        config = yaml.safe_load(f) or {}
    for key, value in defaults.items():
        config.setdefault(key, value)
    
    if "vector_db_path" in config:
        config["vector_db_path"] = os.path.expanduser(config["vector_db_path"])
    if "openclaw_base_path" in config:
        config["openclaw_base_path"] = os.path.expanduser(config["openclaw_base_path"])
        
    return config

CONFIG = load_config()
