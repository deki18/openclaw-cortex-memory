#!/usr/bin/env python3
import argparse
import json
import os
import sys
from pathlib import Path
from typing import Dict, List, Any, Optional

try:
    import yaml
except ImportError:
    yaml = None

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

def load_config() -> Dict[str, Any]:
    config = {}
    
    config_path = "config.yaml"
    if os.path.exists(config_path):
        if yaml is None:
            print(colorize("Warning: PyYAML not installed, cannot read config.yaml", "YELLOW"))
        else:
            try:
                with open(config_path, "r", encoding="utf-8") as f:
                    config = yaml.safe_load(f) or {}
            except Exception as e:
                print(colorize(f"Error reading config.yaml: {e}", "RED"))
    
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
        "reranker_api_key": "CORTEX_MEMORY_RERANKER_API_KEY",
    }
    
    for key, env_var in env_mappings.items():
        if os.environ.get(env_var):
            config[key] = os.environ[env_var]
    
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
    
    reranker_config = config.get("reranker_api", {})
    model = reranker_config.get("model")
    
    if not model:
        errors.append("reranker.model is recommended for better retrieval quality")
    
    return errors

def validate_paths(config: Dict[str, Any]) -> List[str]:
    errors = []
    
    db_path = config.get("lancedb_path")
    if db_path:
        db_path = os.path.expanduser(db_path)
        parent_dir = os.path.dirname(db_path)
        if not os.path.exists(parent_dir):
            errors.append(f"Parent directory for lancedb_path does not exist: {parent_dir}")
    
    return errors

def check_python_dependencies() -> List[str]:
    errors = []
    required = ["lancedb", "openai", "fastapi", "uvicorn", "pydantic", "networkx"]
    
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
    config_path = "config.yaml"
    if os.path.exists(config_path):
        print(f"  File: {config_path} (exists)")
    else:
        print(f"  File: {config_path} (not found, using environment variables)")
    
    env_vars = [k for k in os.environ if k.startswith("CORTEX_MEMORY_")]
    if env_vars:
        print(f"  Environment variables: {len(env_vars)} set")
    
    print_header("Embedding Configuration")
    embedding_errors = validate_embedding_config(config)
    print_check(
        "Embedding Provider",
        bool(config.get("embedding_provider")),
        f"Provider: {config.get('embedding_provider', 'NOT SET')}",
        "Set CORTEX_MEMORY_EMBEDDING_PROVIDER or add to config.yaml"
    )
    print_check(
        "Embedding Model",
        bool(config.get("embedding_model")),
        f"Model: {config.get('embedding_model', 'NOT SET')}",
        "Set CORTEX_MEMORY_EMBEDDING_MODEL or add to config.yaml"
    )
    has_api_key = bool(config.get("embedding_api_key") or os.environ.get("OPENAI_API_KEY"))
    print_check(
        "Embedding API Key",
        has_api_key,
        "Key: " + ("***" + (config.get("embedding_api_key") or os.environ.get("OPENAI_API_KEY", ""))[-4:] if has_api_key else "NOT SET"),
        "Set OPENAI_API_KEY or CORTEX_MEMORY_EMBEDDING_API_KEY"
    )
    if embedding_errors:
        all_passed = False
    
    print_header("LLM Configuration")
    llm_errors = validate_llm_config(config)
    print_check(
        "LLM Provider",
        bool(config.get("llm_provider")),
        f"Provider: {config.get('llm_provider', 'NOT SET')}",
        "Set CORTEX_MEMORY_LLM_PROVIDER or add to config.yaml"
    )
    print_check(
        "LLM Model",
        bool(config.get("llm_model")),
        f"Model: {config.get('llm_model', 'NOT SET')}",
        "Set CORTEX_MEMORY_LLM_MODEL or add to config.yaml"
    )
    if llm_errors:
        all_passed = False
    
    print_header("Reranker Configuration")
    reranker_config = config.get("reranker_api", {})
    print_check(
        "Reranker Model",
        bool(reranker_config.get("model")),
        f"Model: {reranker_config.get('model', 'NOT SET (optional)')}",
        "Add reranker.model to config.yaml for better retrieval"
    )
    
    print_header("Python Dependencies")
    dep_errors = check_python_dependencies()
    for package in ["lancedb", "openai", "fastapi", "uvicorn", "pydantic", "networkx"]:
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
            }
        }
        print(json.dumps(result, indent=2))
        sys.exit(0 if result["valid"] else 1)
    
    passed = run_diagnostics(config, verbose=args.verbose)
    sys.exit(0 if passed else 1)

if __name__ == "__main__":
    main()
