import argparse
import sys
import os
from memory_engine.enhanced_controller import get_controller
from memory_engine.config import get_config, validate_config, load_openclaw_config, find_openclaw_config

def main():
    parser = argparse.ArgumentParser(description="OpenClaw Cortex Memory CLI")
    subparsers = parser.add_subparsers(dest="command")

    status_parser = subparsers.add_parser("status", help="Show memory status")

    search_parser = subparsers.add_parser("search", help="Search memory")
    search_parser.add_argument("query", type=str, help="Search query")
    search_parser.add_argument("--top-k", type=int, default=5, help="Number of results")

    sync_parser = subparsers.add_parser("sync", help="Sync memory")

    rebuild_parser = subparsers.add_parser("rebuild", help="Rebuild FTS index")

    promote_parser = subparsers.add_parser("promote", help="Promote memory")

    events_parser = subparsers.add_parser("events", help="List episodic events")
    events_parser.add_argument("--limit", type=int, default=50, help="Max events to show")

    graph_parser = subparsers.add_parser("graph", help="Query memory graph")
    graph_parser.add_argument("entity", type=str, nargs="?", help="Entity to query")
    graph_parser.add_argument("--stats", action="store_true", help="Show graph statistics")
    graph_parser.add_argument("--validate", action="store_true", help="Validate graph integrity")
    graph_parser.add_argument("--types", action="store_true", help="List schema types")
    graph_parser.add_argument("--relations", action="store_true", help="List schema relations")

    reflect_parser = subparsers.add_parser("reflect", help="Trigger reflection engine")

    import_parser = subparsers.add_parser("import", help="Import legacy OpenClaw memory data")
    import_parser.add_argument("--path", type=str, default="~/.openclaw", help="Path to legacy data directory")

    install_parser = subparsers.add_parser("install", help="Install Cortex Memory core rules into OpenClaw")

    count_parser = subparsers.add_parser("count", help="Count total memories")

    config_parser = subparsers.add_parser("config", help="Validate and display configuration")
    config_parser.add_argument("--validate", action="store_true", help="Validate configuration")
    config_parser.add_argument("--show", action="store_true", help="Show current configuration")
    config_parser.add_argument("--check-openclaw", action="store_true", help="Check openclaw.json location")

    doctor_parser = subparsers.add_parser("doctor", help="Run diagnostics and check system health")

    args = parser.parse_args()

    if args.command == "config":
        handle_config_command(args)
        return
    
    if args.command == "doctor":
        run_doctor()
        return

    controller = get_controller()
    controller.start()

    if args.command == "status":
        count = controller.semantic.count()
        print(f"Memory system is online.")
        print(f"Total memories: {count}")
    elif args.command == "search":
        results = controller.search_memory(args.query)
        print(f"Search results for '{args.query}':")
        for i, res in enumerate(results, 1):
            text = res.get("text", "")[:100] + "..." if len(res.get("text", "")) > 100 else res.get("text", "")
            score = res.get("final_score", 0)
            print(f"{i}. [score: {score:.3f}] {text}")
    elif args.command == "sync":
        controller.sync_memory()
        print("Sync complete.")
    elif args.command == "rebuild":
        controller.semantic.store.rebuild_fts_index()
        print("FTS index rebuilt.")
    elif args.command == "promote":
        controller.promote_memory()
        print("Promotion complete.")
    elif args.command == "events":
        events = controller.episodic.load_events(limit=args.limit)
        for e in events:
            print(e)
    elif args.command == "graph":
        if args.stats:
            stats = controller.get_graph_stats()
            print("Graph Statistics:")
            print(f"  Total nodes: {stats.get('total_nodes', 0)}")
            print(f"  Total edges: {stats.get('total_edges', 0)}")
            print(f"  Schema types: {stats.get('schema_types', 0)}")
            print(f"  Schema relations: {stats.get('schema_relations', 0)}")
            if stats.get('node_types'):
                print("\n  Node types:")
                for t, c in stats['node_types'].items():
                    print(f"    - {t}: {c}")
            if stats.get('relation_types'):
                print("\n  Relation types:")
                for r, c in stats['relation_types'].items():
                    print(f"    - {r}: {c}")
        elif args.validate:
            result = controller.validate_graph()
            if result.get('valid'):
                print("[OK] Graph validation passed")
            else:
                print("[FAILED] Graph validation failed")
                for err in result.get('errors', []):
                    print(f"  Error: {err}")
            for warn in result.get('warnings', []):
                print(f"  Warning: {warn}")
        elif args.types:
            types = controller.get_schema_types()
            print("Schema Types:")
            for t in types:
                print(f"  - {t}")
        elif args.relations:
            relations = controller.get_schema_relations()
            print("Schema Relations:")
            for r in relations:
                print(f"  - {r}")
        elif args.entity:
            res = controller.query_graph(args.entity)
            if res:
                print(f"Graph query results for '{args.entity}':")
                for item in res:
                    print(f"  {item['source']} ({item['source_type']}) --[{item['relation']}]--> {item['target']} ({item['target_type']}) [weight: {item['weight']:.2f}]")
            else:
                print(f"No results found for '{args.entity}'")
        else:
            print("Usage: memory graph <entity> [--stats] [--validate] [--types] [--relations]")
    elif args.command == "reflect":
        controller.reflect_memory()
        print("Reflection complete.")
    elif args.command == "import":
        controller.import_legacy_data(args.path)
    elif args.command == "install":
        controller.inject_core_rule()
    elif args.command == "count":
        count = controller.semantic.count()
        print(f"Total memories: {count}")
    else:
        parser.print_help()


def handle_config_command(args):
    print("=" * 60)
    print("OpenClaw Cortex Memory Configuration")
    print("=" * 60)
    
    if args.check_openclaw:
        config_path = find_openclaw_config()
        if config_path:
            print(f"\n[OK] Found openclaw.json at: {config_path}")
            openclaw_config = load_openclaw_config()
            plugin_config = openclaw_config.get("plugins", {}).get("cortex-memory", {})
            if plugin_config:
                print(f"[OK] Cortex Memory plugin config found in openclaw.json")
            else:
                print(f"[WARNING] No cortex-memory plugin config in openclaw.json")
        else:
            print("\n[ERROR] openclaw.json not found")
            print("  Searched locations:")
            print("  - ./openclaw.json")
            print("  - ~/.openclaw/openclaw.json")
            print("  - $OPENCLAW_CONFIG_PATH")
    
    if args.validate or args.show:
        config = get_config()
        warnings = validate_config(config)
        
        if args.show:
            print("\nCurrent Configuration:")
            print("-" * 40)
            safe_keys = [
                "embedding_provider", "embedding_model", "embedding_dimensions",
                "llm_provider", "llm_model",
                "reranker_provider", "reranker_model",
                "time_decay_halflife", "enable_chunking"
            ]
            for key in safe_keys:
                value = config.get(key)
                if value is not None:
                    print(f"  {key}: {value}")
        
        if args.validate:
            print("\nValidation Results:")
            print("-" * 40)
            if warnings:
                for warning in warnings:
                    print(f"  [WARNING] {warning}")
                print(f"\n[FAILED] {len(warnings)} configuration issue(s) found")
            else:
                print("  [OK] All configuration checks passed")
    
    if not (args.validate or args.show or args.check_openclaw):
        config = get_config()
        warnings = validate_config(config)
        config_path = find_openclaw_config()
        
        print(f"\nConfig file: {config_path or 'Not found'}")
        print(f"Embedding: {config.get('embedding_provider', 'NOT SET')}/{config.get('embedding_model', 'NOT SET')}")
        print(f"LLM: {config.get('llm_provider', 'NOT SET')}/{config.get('llm_model', 'NOT SET')}")
        print(f"Reranker: {config.get('reranker_provider', 'NOT SET')}/{config.get('reranker_model', 'NOT SET')}")
        
        if warnings:
            print(f"\n[WARNING] {len(warnings)} issue(s) found:")
            for w in warnings:
                print(f"  - {w}")
        else:
            print("\n[OK] Configuration is valid")


def run_doctor():
    print("=" * 60)
    print("OpenClaw Cortex Memory Diagnostics")
    print("=" * 60)
    
    checks_passed = 0
    checks_failed = 0
    
    def check(name: str, passed: bool, message: str, fix: str = None):
        nonlocal checks_passed, checks_failed
        status = "[OK]" if passed else "[FAILED]"
        print(f"\n{status} {name}")
        print(f"     {message}")
        if not passed and fix:
            print(f"     Fix: {fix}")
        if passed:
            checks_passed += 1
        else:
            checks_failed += 1
    
    config_path = find_openclaw_config()
    check(
        "Config File",
        config_path is not None,
        f"Location: {config_path or 'Not found'}",
        "Create openclaw.json in project root or ~/.openclaw/"
    )
    
    config = get_config()
    warnings = validate_config(config)
    check(
        "Configuration",
        len(warnings) == 0,
        f"{len(warnings)} warning(s)" if warnings else "All required fields set",
        "Set embedding and llm configuration in openclaw.json"
    )
    
    embedding_provider = config.get("embedding_provider")
    embedding_model = config.get("embedding_model")
    check(
        "Embedding Service",
        bool(embedding_provider and embedding_model),
        f"Provider: {embedding_provider or 'NOT SET'}, Model: {embedding_model or 'NOT SET'}",
        "Add embedding config to openclaw.json plugins.cortex-memory"
    )
    
    llm_provider = config.get("llm_provider")
    llm_model = config.get("llm_model")
    check(
        "LLM Service",
        bool(llm_provider and llm_model),
        f"Provider: {llm_provider or 'NOT SET'}, Model: {llm_model or 'NOT SET'}",
        "Add llm config to openclaw.json plugins.cortex-memory"
    )
    
    try:
        from memory_engine.embedding import EmbeddingModule
        emb = EmbeddingModule()
        check(
            "Embedding Client",
            emb.is_available(),
            "Client initialized" if emb.is_available() else "Client not available",
            "Check API key and base URL"
        )
    except Exception as e:
        check("Embedding Client", False, f"Error: {e}", "Install openai package and configure API key")
    
    try:
        from memory_engine.config import get_openclaw_base_path
        base_path = get_openclaw_base_path()
        check(
            "Storage Path",
            os.path.exists(base_path),
            f"Path: {base_path}",
            f"Create directory: {base_path}"
        )
    except Exception as e:
        check("Storage Path", False, f"Error: {e}")
    
    print("\n" + "=" * 60)
    print(f"Results: {checks_passed} passed, {checks_failed} failed")
    if checks_failed == 0:
        print("[OK] All checks passed!")
    else:
        print("[WARNING] Some checks failed. Please fix the issues above.")
    print("=" * 60)


if __name__ == "__main__":
    main()
