import argparse
import sys
from memory_engine.memory_controller import MemoryController

def main():
    parser = argparse.ArgumentParser(description="OpenClaw Cortex Memory CLI")
    subparsers = parser.add_subparsers(dest="command")

    # Status
    status_parser = subparsers.add_parser("status", help="Show memory status")

    # Search
    search_parser = subparsers.add_parser("search", help="Search memory")
    search_parser.add_argument("query", type=str, help="Search query")

    # Sync
    sync_parser = subparsers.add_parser("sync", help="Sync memory")

    # Rebuild
    rebuild_parser = subparsers.add_parser("rebuild", help="Rebuild vector store")

    # Promote
    promote_parser = subparsers.add_parser("promote", help="Promote memory")

    # Events
    events_parser = subparsers.add_parser("events", help="List episodic events")

    # Graph
    graph_parser = subparsers.add_parser("graph", help="Query memory graph")
    graph_parser.add_argument("entity", type=str, help="Entity to query")

    # Reflect
    reflect_parser = subparsers.add_parser("reflect", help="Trigger reflection engine")

    # Import
    import_parser = subparsers.add_parser("import", help="Import legacy OpenClaw memory data")
    import_parser.add_argument("--path", type=str, default="~/.openclaw", help="Path to legacy data directory (default: ~/.openclaw)")

    # Install
    install_parser = subparsers.add_parser("install", help="Install Cortex Memory core rules into OpenClaw")

    args = parser.parse_args()
    controller = MemoryController()

    if args.command == "status":
        print("Memory system is online.")
    elif args.command == "search":
        results = controller.search_memory(args.query)
        print(f"Search results for '{args.query}':")
        for res in results:
            print(f"- {res}")
    elif args.command == "sync":
        controller.sync_memory()
        print("Sync complete.")
    elif args.command == "rebuild":
        controller.semantic.vector_store.rebuild()
        print("Vector store rebuilt.")
    elif args.command == "promote":
        controller.promote_memory()
        print("Promotion complete.")
    elif args.command == "events":
        events = controller.episodic.load_events()
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
    else:
        parser.print_help()

if __name__ == "__main__":
    main()
