# OpenClaw Cortex Memory

A production-ready AI Agent long-term memory system.

## Features
1. Semantic Memory (vector knowledge memory)
2. Episodic Memory (event memory)
3. Procedural Memory (rules and skills)
4. Memory Graph (entity relationships)
5. Reflection Engine (experience → knowledge)

## Installation & Setup

### 1. Clone & Install Dependencies
Clone this repository into your OpenClaw plugins directory (or anywhere you prefer):
```bash
git clone https://github.com/yourusername/openclaw-cortex-memory.git
cd openclaw-cortex-memory
pip install -r requirements.txt
```

### 2. Configure Environment
Ensure your `OPENAI_API_KEY` is set in your environment variables, as the engine requires it for generating embeddings and reflections.
```bash
export OPENAI_API_KEY="your-api-key-here"
```

Update `config.yaml` with your chosen models after installation:
- `embedding_model`
- `llm_model`
- `reranker_api.model`

Reranker requires `RERANKER_API_KEY` and a non-empty `reranker_api.model` to take effect.

This plugin exposes a registration entrypoint in openclaw_plugin.py and must be registered by the OpenClaw host.

### 3. Inject Core Rules into OpenClaw
Run the `install` command to automatically inject the Cortex Memory rules into OpenClaw's long-term memory (`~/.openclaw/workspace/MEMORY.md`). This tells the OpenClaw Agent how to use this new memory system.
```bash
python -m cli.memory_cli install
```

### 4. (Optional) Import Legacy Data
If you have been using OpenClaw previously, you can import your old conversation logs and daily records into the new Cortex Memory engine:
```bash
python -m cli.memory_cli import --path ~/.openclaw
```

## CLI Commands
- `python -m cli.memory_cli status`
- `python -m cli.memory_cli search <query>`
- `python -m cli.memory_cli sync`
- `python -m cli.memory_cli rebuild`
- `python -m cli.memory_cli promote`
- `python -m cli.memory_cli events`
- `python -m cli.memory_cli graph <entity>`
- `python -m cli.memory_cli reflect`

## Testing
Run tests using `python -m unittest discover tests`
