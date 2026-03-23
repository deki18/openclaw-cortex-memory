#!/usr/bin/env python3
import argparse
import json
import os
import sys
from pathlib import Path
from typing import Dict, List, Any, Optional

COLORS = {
    'RED': '\033[91m',
    'GREEN': '\033[92m',
    'YELLOW': '\033[93m',
    'BLUE': '\033[94m',
    'RESET': '\033[0m',
    'BOLD': '\033[1m'
}

def colorize(text: str, color: str) -> str:
    if sys.platform == 'win32' and not os.environ.get('ANSICON'):
        return text
    return f"{COLORS.get(color, '')}{text}{COLORS['RESET']}"

def print_header(text: str):
    print(f"\n{colorize('=' * 60, 'BLUE')}")
    print(f"{colorize(text, 'BOLD')}")
    print(f"{colorize('=' * 60, 'BLUE')}\n")

def print_check(name: str, passed: bool, message: str = "", fix: str = ""):
    status = colorize("[PASS]", "GREEN") if passed else colorize("[FAIL]", "RED")
    print(f"  {status} {name}")
    if message:
        print(f"         {message}")
    if not passed and fix:
        print(f"         {colorize('Fix: ' + fix, 'YELLOW')}")

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
        print(colorize(f"Error reading openclaw.json: {e}", "RED"))
        return {}

def extract_plugin_config(openclaw_config: Dict[str, Any]) -> Dict[str, Any]:
    entries = openclaw_config.get("plugins", {}).get("entries", {})
    plugin_config = entries.get("openclaw-cortex-memory", {}).get("config", {})
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
        elif embedding.get("baseUrl"):
            result["embedding_base_url"] = embedding["baseUrl"]
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
        elif llm.get("baseUrl"):
            result["llm_base_url"] = llm["baseUrl"]
    
    reranker = plugin_config.get("reranker", {})
    if reranker:
        if reranker.get("provider"):
            result["reranker_provider"] = reranker["provider"]
        if reranker.get("model"):
            result["reranker_model"] = reranker["model"]
        if reranker.get("apiKey"):
            result["reranker_api_key"] = reranker["apiKey"]
        if reranker.get("endpoint"):
            result["reranker_endpoint"] = reranker["endpoint"]
        elif reranker.get("baseURL"):
            result["reranker_endpoint"] = reranker["baseURL"]
        elif reranker.get("baseUrl"):
            result["reranker_endpoint"] = reranker["baseUrl"]
    
    if plugin_config.get("dbPath"):
        result["lancedb_path"] = plugin_config["dbPath"]
    if plugin_config.get("autoSync") is not None:
        result["auto_sync"] = plugin_config["autoSync"]
    if plugin_config.get("autoReflect") is not None:
        result["auto_reflect"] = plugin_config["autoReflect"]
    
    return result

def load_config_from_env() -> Dict[str, Any]:
    result = {}
    
    env_mappings = {
        "embedding_provider": "CORTEX_MEMORY_EMBEDDING_PROVIDER",
        "embedding_model": "CORTEX_MEMORY_EMBEDDING_MODEL",
        "embedding_api_key": "CORTEX_MEMORY_EMBEDDING_API_KEY",
        "embedding_base_url": "CORTEX_MEMORY_EMBEDDING_BASE_URL",
        "embedding_dimensions": "CORTEX_MEMORY_EMBEDDING_DIMENSIONS",
        "llm_provider": "CORTEX_MEMORY_LLM_PROVIDER",
        "llm_model": "CORTEX_MEMORY_LLM_MODEL",
        "llm_api_key": "CORTEX_MEMORY_LLM_API_KEY",
        "llm_base_url": "CORTEX_MEMORY_LLM_BASE_URL",
        "reranker_provider": "CORTEX_MEMORY_RERANKER_PROVIDER",
        "reranker_model": "CORTEX_MEMORY_RERANKER_MODEL",
        "reranker_api_key": "CORTEX_MEMORY_RERANKER_API_KEY",
        "reranker_endpoint": "CORTEX_MEMORY_RERANKER_ENDPOINT",
        "lancedb_path": "CORTEX_MEMORY_DB_PATH",
    }
    
    for key, env_var in env_mappings.items():
        env_value = os.environ.get(env_var)
        if env_value:
            if key == "embedding_dimensions":
                try:
                    result[key] = int(env_value)
                except ValueError:
                    pass
            else:
                result[key] = env_value
    
    return result

def load_config() -> Dict[str, Any]:
    config = {}
    
    openclaw_config = load_openclaw_config()
    if openclaw_config:
        config = extract_plugin_config(openclaw_config)
    
    env_config = load_config_from_env()
    config.update(env_config)
    
    return config

def validate_embedding_config(config: Dict[str, Any]) -> List[str]:
    errors = []
    
    provider = config.get("embedding_provider")
    model = config.get("embedding_model")
    api_key = config.get("embedding_api_key") or os.environ.get("OPENAI_API_KEY")
    
    if not provider:
        errors.append("embedding.provider is required")
    if not model:
        errors.append("embedding.model is required")
    if provider and not api_key:
        errors.append("embedding API key is required (set OPENAI_API_KEY or CORTEX_MEMORY_EMBEDDING_API_KEY)")
    
    return errors

def validate_llm_config(config: Dict[str, Any]) -> List[str]:
    errors = []
    
    provider = config.get("llm_provider")
    model = config.get("llm_model")
    api_key = config.get("llm_api_key") or os.environ.get("OPENAI_API_KEY")
    
    if not provider:
        errors.append("llm.provider is required")
    if not model:
        errors.append("llm.model is required")
    if provider and not api_key:
        errors.append("LLM API key is required (set OPENAI_API_KEY or CORTEX_MEMORY_LLM_API_KEY)")
    
    return errors

def validate_reranker_config(config: Dict[str, Any]) -> List[str]:
    errors = []
    
    model = config.get("reranker_model")
    
    if not model:
        errors.append("reranker.model is recommended for better retrieval quality")
    
    return errors

def check_python_dependencies() -> List[str]:
    errors = []
    required = ["lancedb", "openai", "fastapi", "uvicorn", "pydantic", "networkx", "tantivy"]
    
    for package in required:
        try:
            __import__(package)
        except ImportError:
            errors.append(f"Python package '{package}' is not installed")
    
    return errors

def check_api_connectivity(config: Dict[str, Any]) -> Dict[str, Any]:
    results = {}
    
    api_key = config.get("embedding_api_key") or os.environ.get("OPENAI_API_KEY")
    if api_key:
        try:
            from openai import OpenAI
            client = OpenAI(api_key=api_key, base_url=config.get("embedding_base_url"))
            client.models.list()
            results["embedding_api"] = {"status": "connected", "error": None}
        except Exception as e:
            results["embedding_api"] = {"status": "failed", "error": str(e)}
    else:
        results["embedding_api"] = {"status": "skipped", "error": "No API key configured"}
    
    return results

def run_diagnostics(config: Dict[str, Any], verbose: bool = False) -> bool:
    all_passed = True
    
    print_header("Cortex Memory Configuration Validator")
    
    print(colorize("Configuration Source:", "BOLD"))
    config_path = find_openclaw_config()
    if config_path:
        print(f"  File: {config_path} (found)")
    else:
        print(f"  File: openclaw.json (not found)")
    
    env_vars = [k for k in os.environ if k.startswith("CORTEX_MEMORY_")]
    if env_vars:
        print(f"  Environment variables: {len(env_vars)} set")
    else:
        print(f"  Environment variables: 0 set")
    
    print_header("Embedding Configuration")
    embedding_errors = validate_embedding_config(config)
    print_check(
        "Embedding Provider",
        bool(config.get("embedding_provider")),
        f"Provider: {config.get('embedding_provider', 'NOT SET')}",
        "Set CORTEX_MEMORY_EMBEDDING_PROVIDER or add to openclaw.json"
    )
    print_check(
        "Embedding Model",
        bool(config.get("embedding_model")),
        f"Model: {config.get('embedding_model', 'NOT SET')}",
        "Set CORTEX_MEMORY_EMBEDDING_MODEL or add to openclaw.json"
    )
    has_api_key = bool(config.get("embedding_api_key") or os.environ.get("OPENAI_API_KEY"))
    print_check(
        "Embedding API Key",
        has_api_key,
        "Key: " + ("***" + (config.get("embedding_api_key") or os.environ.get("OPENAI_API_KEY", ""))[-4:] if has_api_key else "NOT SET"),
        "Set OPENAI_API_KEY or CORTEX_MEMORY_EMBEDDING_API_KEY"
    )
    print_check(
        "Embedding Dimensions",
        bool(config.get("embedding_dimensions")),
        f"Dimensions: {config.get('embedding_dimensions', 'default')}",
    )
    if embedding_errors:
        all_passed = False
    
    print_header("LLM Configuration")
    llm_errors = validate_llm_config(config)
    print_check(
        "LLM Provider",
        bool(config.get("llm_provider")),
        f"Provider: {config.get('llm_provider', 'NOT SET')}",
        "Set CORTEX_MEMORY_LLM_PROVIDER or add to openclaw.json"
    )
    print_check(
        "LLM Model",
        bool(config.get("llm_model")),
        f"Model: {config.get('llm_model', 'NOT SET')}",
        "Set CORTEX_MEMORY_LLM_MODEL or add to openclaw.json"
    )
    if llm_errors:
        all_passed = False
    
    print_header("Reranker Configuration")
    reranker_errors = validate_reranker_config(config)
    print_check(
        "Reranker Model",
        bool(config.get("reranker_model")),
        f"Model: {config.get('reranker_model', 'NOT SET (optional)')}",
        "Add reranker.model to openclaw.json for better retrieval"
    )
    print_check(
        "Reranker Endpoint",
        bool(config.get("reranker_endpoint")),
        f"Endpoint: {config.get('reranker_endpoint', 'NOT SET')}",
    )
    
    print_header("Python Dependencies")
    dep_errors = check_python_dependencies()
    for package in ["lancedb", "openai", "fastapi", "uvicorn", "pydantic", "networkx", "tantivy"]:
        try:
            __import__(package)
            print_check(f"Package: {package}", True)
        except ImportError:
            print_check(f"Package: {package}", False, fix="Run: pip install " + package)
            all_passed = False
    
    if verbose:
        print_header("API Connectivity Test")
        connectivity = check_api_connectivity(config)
        for service, result in connectivity.items():
            status = result["status"]
            if status == "connected":
                print_check(f"{service}", True, "Connection successful")
            elif status == "skipped":
                print_check(f"{service}", True, "Skipped - no API key")
            else:
                print_check(f"{service}", False, f"Error: {result['error']}")
    
    print_header("Summary")
    if all_passed:
        print(colorize("All checks passed! Configuration is valid.", "GREEN"))
    else:
        print(colorize("Some checks failed. Please fix the issues above.", "RED"))
    
    return all_passed

def main():
    parser = argparse.ArgumentParser(
        description="Validate Cortex Memory configuration",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python validate_config.py              Run basic validation
  python validate_config.py --verbose    Include API connectivity test
  python validate_config.py --json       Output as JSON
        """
    )
    parser.add_argument("--verbose", "-v", action="store_true", help="Include API connectivity test")
    parser.add_argument("--json", action="store_true", help="Output results as JSON")
    
    args = parser.parse_args()
    
    config = load_config()
    
    if args.json:
        embedding_errors = validate_embedding_config(config)
        llm_errors = validate_llm_config(config)
        reranker_errors = validate_reranker_config(config)
        dep_errors = check_python_dependencies()
        
        result = {
            "valid": not (embedding_errors or llm_errors or dep_errors),
            "embedding": {"errors": embedding_errors},
            "llm": {"errors": llm_errors},
            "reranker": {"errors": reranker_errors},
            "dependencies": {"errors": dep_errors},
            "config": {
                "embedding_provider": config.get("embedding_provider"),
                "embedding_model": config.get("embedding_model"),
                "llm_provider": config.get("llm_provider"),
                "llm_model": config.get("llm_model"),
                "reranker_model": config.get("reranker_model"),
            }
        }
        print(json.dumps(result, indent=2))
        sys.exit(0 if result["valid"] else 1)
    
    passed = run_diagnostics(config, verbose=args.verbose)
    sys.exit(0 if passed else 1)

if __name__ == "__main__":
    main()
