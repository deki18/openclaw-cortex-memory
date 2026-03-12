# OpenClaw Cortex Memory

A long-term memory plugin for OpenClaw, providing semantic search, episodic event tracking, and procedural memory management.

## Features

- **Semantic Search**: Vector-based memory retrieval with LanceDB
- **Episodic Memory**: Track events and milestones across sessions
- **Procedural Memory**: Store and retrieve operational rules (SOUL.md)
- **Memory Graph**: Relationship tracking between entities
- **Hot Context**: Real-time context injection for LLM interactions
- **Memory Lifecycle**: Automatic decay, reflection, and promotion

## Quick Start

### Prerequisites
- Python 3.10+
- Node.js 22+
- OpenAI API Key

### Install

```bash
cd /path/to/your/openclaw/workspace
git clone https://github.com/deki18/openclaw-cortex-memory.git plugins/openclaw-cortex-memory
cd plugins/openclaw-cortex-memory/plugin
npm install
```

`npm install` automatically sets up the Python environment.

### Configure

Add to your `openclaw.json`:

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
          },
          "reranker": {
            "provider": "siliconflow",
            "model": "BAAI/bge-reranker-v2-m3",
            "apiKey": "${SILICONFLOW_API_KEY}",
            "endpoint": "https://api.siliconflow.cn/v1/rerank"
          },
          "autoSync": true,
          "autoReflect": false
        }
      }
    }
  }
}
```

### Start

```bash
openclaw config validate
openclaw gateway restart
```

The Python backend service starts automatically when the plugin loads.

## Usage

### Search Memory

```javascript
// The agent can search its memory
const results = await tools.search_memory({
  query: "What did we discuss about the authentication system?",
  top_k: 5
});
```

### Store Events

```javascript
// Store significant events
await tools.store_event({
  summary: "Successfully deployed the new API",
  entities: [
    { name: "API Server", type: "service" },
    { name: "Production", type: "environment" }
  ],
  outcome: "Zero downtime deployment completed"
});
```

### Query Graph

```javascript
// Query relationships
const graph = await tools.query_graph({
  entity: "API Server"
});
```

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   OpenClaw      │────▶│  TypeScript      │────▶│  Python         │
│   Gateway       │     │  Plugin          │     │  Backend        │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                               │                         │
                               ▼                         ▼
                        ┌──────────────┐          ┌──────────────┐
                        │  openclaw.json│          │  LanceDB     │
                        │  Config      │          │  Vector DB   │
                        └──────────────┘          └──────────────┘
```

## Available Tools

| Tool | Description |
|------|-------------|
| `search_memory` | Semantic search across all memory stores |
| `store_event` | Store episodic events with entities and relations |
| `query_graph` | Query entity relationship graph |
| `get_hot_context` | Retrieve current hot context for LLM |
| `reflect_memory` | Trigger reflection process |
| `sync_memory` | Sync OpenClaw session data |
| `promote_memory` | Promote hot memories to rules |

## Configuration Options

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `embedding.provider` | Yes | - | Provider type: `openai`, `openai-compatible`, `jina` |
| `embedding.model` | Yes | - | Embedding model name |
| `embedding.apiKey` | No | `${OPENAI_API_KEY}` | API key for embeddings |
| `embedding.baseURL` | No | - | Custom API endpoint |
| `llm.model` | Yes | - | LLM model for reflection/extraction |
| `llm.apiKey` | No | `${OPENAI_API_KEY}` | API key for LLM |
| `llm.baseURL` | No | - | Custom API endpoint |
| `reranker.provider` | No | - | Reranker provider |
| `reranker.model` | Yes | - | Reranker model name |
| `reranker.apiKey` | No | - | API key for reranker |
| `reranker.endpoint` | No | - | Reranker API endpoint |
| `dbPath` | No | `~/.openclaw/agents/main/lancedb_store` | Database path |
| `autoSync` | No | `true` | Auto-sync on session end |
| `autoReflect` | No | `false` | Auto-trigger reflection |

## Development

```bash
# Install dependencies
cd plugin
npm install

# Build TypeScript
npm run build

# Watch mode
npm run dev
```

## License

MIT
