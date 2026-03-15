import argparse
import sys
from memory_engine.enhanced_controller import EnhancedMemoryController

def main():
    parser = argparse.ArgumentParser(description="OpenClaw Cortex Memory CLI")
    subparsers = parser.add_subparsers(dest="command")

    # Status
    status_parser = subparsers.add_parser("status", help="Show memory status")

    # Search
    search_parser = subparsers.add_parser("search", help="Search memory")
    search_parser.add_argument("query", type=str, help="Search query")
    search_parser.add_argument("--top-k", type=int, default=5, help="Number of results")

    # Sync
    sync_parser = subparsers.add_parser("sync", help="Sync memory")

    # Rebuild
    rebuild_parser = subparsers.add_parser("rebuild", help="Rebuild FTS index")

    # Promote
    promote_parser = subparsers.add_parser("promote", help="Promote memory")

    # Events
    events_parser = subparsers.add_parser("events", help="List episodic events")
    events_parser.add_argument("--limit", type=int, default=50, help="Max events to show")

    # Graph
    graph_parser = subparsers.add_parser("graph", help="Query memory graph")
    graph_parser.add_argument("entity", type=str, help="Entity to query")

    # Reflect
    reflect_parser = subparsers.add_parser("reflect", help="Trigger reflection engine")

    # Import
    import_parser = subparsers.add_parser("import", help="Import legacy OpenClaw memory data")
    import_parser.add_argument("--path", type=str, default="~/.openclaw", help="Path to legacy data directory")

    # Install
    install_parser = subparsers.add_parser("install", help="Install Cortex Memory core rules into OpenClaw")

    # Count
    count_parser = subparsers.add_parser("count", help="Count total memories")

    args = parser.parse_args()
    controller = EnhancedMemoryController()
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
        res = controller.query_graph(args.entity)
        print(res)
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

if __name__ == "__main__":
    main()
