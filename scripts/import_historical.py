#!/usr/bin/env python3
import argparse
import sys
from pathlib import Path


def main() -> int:
    project_root = Path(__file__).resolve().parents[1]
    if str(project_root) not in sys.path:
        sys.path.insert(0, str(project_root))

    from memory_engine.enhanced_controller import get_controller
    from memory_engine.services.sync_service import MemorySyncService

    parser = argparse.ArgumentParser(description="Import historical OpenClaw data into Cortex Memory")
    parser.add_argument("--legacy-path", default="~/.openclaw", help="Legacy OpenClaw data directory")
    parser.add_argument("--mode", choices=["sync", "legacy"], default="sync", help="Import mode")
    args = parser.parse_args()

    controller = get_controller()
    controller.start()

    if args.mode == "legacy":
        sync_service = MemorySyncService(
            write_pipeline=controller.write_pipeline if hasattr(controller, "write_pipeline") else None,
            semantic_memory=controller.semantic if hasattr(controller, "semantic") else None,
        )
        sync_service.import_legacy_data(args.legacy_path)
        print("Legacy data import complete.")
        return 0

    result = controller.sync_memory()
    if isinstance(result, dict):
        processed = result.get("processed", 0)
        skipped = result.get("skipped", 0)
        failed = result.get("failed", 0)
        print(f"Historical sync complete. processed={processed}, skipped={skipped}, failed={failed}")
    else:
        print("Historical sync complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
