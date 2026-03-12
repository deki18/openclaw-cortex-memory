# OpenClaw Cortex Memory

This skill integrates the OpenClaw Cortex Memory system into the main OpenClaw agent.

## Description
Provides advanced memory capabilities including Semantic Memory, Episodic Memory, Procedural Memory, Memory Graph, and a Reflection Engine.

## Commands

### Search Memory
Use this to search the long-term semantic memory for relevant information.
```bash
python /path/to/openclaw-cortex-memory/cli/memory_cli.py search "<query>"
```

### Store Event
Use this to store a new episodic event or daily record.
```bash
# Note: In a full integration, you would use the Python API directly or add a CLI command for storing events.
# For now, the memory controller automatically processes files in the workspace.
python /path/to/openclaw-cortex-memory/cli/memory_cli.py sync
```

### Query Graph
Use this to query the memory graph for relationships involving a specific entity.
```bash
python /path/to/openclaw-cortex-memory/cli/memory_cli.py graph "<entity>"
```

### Reflect
Trigger the reflection engine to process recent events into long-term semantic knowledge.
```bash
python /path/to/openclaw-cortex-memory/cli/memory_cli.py reflect
```

### Import Legacy Data
Import existing OpenClaw memory files into the new Cortex Memory system.
```bash
python /path/to/openclaw-cortex-memory/cli/memory_cli.py import --path ~/.openclaw
```
