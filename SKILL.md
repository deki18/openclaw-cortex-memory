# OpenClaw Cortex Memory Plugin

Long-term memory system for OpenClaw agents with semantic search, episodic tracking, and procedural memory.

## Installation

```bash
cd /path/to/your/openclaw/workspace
git clone https://github.com/deki18/openclaw-cortex-memory.git plugins/openclaw-cortex-memory
cd plugins/openclaw-cortex-memory/plugin
npm install
```

Then add to your `openclaw.json`:

```json
{
  "plugins": {
    "slots": {
      "memory": "openclaw-cortex-memory"
    },
    "entries": {
      "openclaw-cortex-memory": {
        "enabled": true,
        "config": {
          "embedding": {
            "provider": "openai-compatible",
            "model": "text-embedding-3-large",
            "apiKey": "${OPENAI_API_KEY}"
          },
          "llm": {
            "provider": "openai",
            "model": "gpt-4"
            // apiKey and baseURL read from OpenClaw main config
          },
          "reranker": {
            "provider": "siliconflow",
            "model": "BAAI/bge-reranker-v2-m3",
            "apiKey": "${SILICONFLOW_API_KEY}",
            "endpoint": "https://api.siliconflow.cn/v1/rerank"
          },
          "dbPath": "~/.openclaw/agents/main/lancedb_store",
          "autoSync": true,
          "autoReflect": false
        }
      }
    }
  }
}
```

Run `openclaw config validate && openclaw gateway restart` to apply. The Python service starts automatically.

## Configuration Options

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `embedding.provider` | Yes | - | Provider: `openai`, `openai-compatible`, `jina` |
| `embedding.model` | Yes | - | Embedding model name |
| `embedding.apiKey` | No | `${OPENAI_API_KEY}` | API key for embedding |
| `embedding.baseURL` | No | - | Custom API endpoint |
| `llm.model` | Yes | - | LLM model for reflection |
| `llm.apiKey` | No | `${OPENAI_API_KEY}` | API key for LLM |
| `llm.baseURL` | No | - | Custom API endpoint |
| `reranker.provider` | No | - | Reranker provider |
| `reranker.model` | Yes | - | Reranker model name |
| `reranker.apiKey` | No | - | API key for reranker |
| `reranker.endpoint` | No | - | Reranker API endpoint |
| `dbPath` | No | `~/.openclaw/agents/main/lancedb_store` | Database path |
| `autoSync` | No | `true` | Auto-sync on session end |
| `autoReflect` | No | `false` | Auto-trigger reflection |

## Available Tools

### search_memory
Search long-term semantic memory for relevant information.

**Parameters:**
- `query` (string, required): Search query
- `top_k` (number, optional): Number of results, default 3

**Example:**
```json
{
  "query": "What authentication method did we choose?",
  "top_k": 5
}
```

### store_event
Store an episodic event or milestone.

**Parameters:**
- `summary` (string, required): Event summary
- `entities` (array, optional): Involved entities
- `outcome` (string, optional): Event outcome
- `relations` (array, optional): Entity relationships

**Example:**
```json
{
  "summary": "Deployed new API version",
  "entities": [
    {"name": "API", "type": "service"},
    {"name": "v2.0", "type": "version"}
  ],
  "outcome": "Successful deployment with zero downtime"
}
```

### query_graph
Query entity relationship graph.

**Parameters:**
- `entity` (string, required): Entity name to query

**Example:**
```json
{
  "entity": "API"
}
```

### get_hot_context
Get current hot context (SOUL.md + recent data).

**Parameters:**
- `limit` (number, optional): Max items, default 20

### reflect_memory
Trigger reflection to convert episodic events into semantic knowledge.

### sync_memory
Sync session data from OpenClaw to memory system.

### promote_memory
Promote frequently accessed memories to core rules.

## Memory Types

1. **Semantic**: Vector embeddings for similarity search
2. **Episodic**: Event timeline with entities and outcomes
3. **Procedural**: SOUL.md rules and operational knowledge
4. **Graph**: Entity relationship network

## Hooks

The plugin registers automatic hooks:
- `message`: Stores messages to memory
- `session_end`: Syncs memory (if autoSync enabled)
- `timer`: Scheduled sync/reflect/promote
