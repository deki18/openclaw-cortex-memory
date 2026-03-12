# OpenClaw Cortex Memory

A production-ready AI Agent long-term memory system for OpenClaw.

## Features
1. **Semantic Memory** - Vector-based knowledge storage with LanceDB
2. **Episodic Memory** - Event memory with timestamps
3. **Procedural Memory** - Rules and skills storage
4. **Memory Graph** - Entity relationship graph with NetworkX
5. **Reflection Engine** - Convert experiences into knowledge
6. **Native Hybrid Retrieval** - Vector + BM25 (FTS) via LanceDB Tantivy engine

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     OpenClaw Agent                           │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              TypeScript Plugin (openclaw-plugin)             │
│         registerTool() / registerHook() integration          │
└─────────────────────────────────────────────────────────────┘
                              │ HTTP API
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                Python Core (FastAPI Server)                  │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │   Semantic   │  │   Episodic   │  │  Procedural  │       │
│  │    Memory    │  │    Memory    │  │    Memory    │       │
│  └──────────────┘  └──────────────┘  └──────────────┘       │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │    Memory    │  │  Reflection  │  │  Promotion   │       │
│  │     Graph    │  │    Engine    │  │    Engine    │       │
│  └──────────────┘  └──────────────┘  └──────────────┘       │
│                                                              │
│  ┌──────────────────────────────────────────────────┐       │
│  │              Retrieval Pipeline                   │       │
│  │   Native Hybrid Search → Time Decay → Rerank     │       │
│  └──────────────────────────────────────────────────┘       │
│                                                              │
│  ┌──────────────────────────────────────────────────┐       │
│  │              LanceDB (Zero-Copy Storage)          │       │
│  │         Vector Index + FTS (Tantivy Engine)       │       │
│  └──────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────┘
```

## Key Improvements (v2.0)

### LanceDB Migration
- **Zero-Copy Storage**: Columnar storage with disk-direct reads, dramatically reducing memory footprint
- **Native Hybrid Search**: Built-in Tantivy FTS engine for seamless vector + BM25 fusion
- **Strong Schema**: Pydantic/LanceModel for strict type constraints

### Simplified Architecture
- Removed separate ChromaDB + BM25 dual-store complexity
- Single LanceDB table handles both vector and full-text search
- Cleaner retrieval pipeline with native hybrid search

## Installation

### Prerequisites
- Python 3.10+
- Node.js 22+ (for TypeScript plugin)
- OpenClaw installed

### Step 1: Clone & Install Python Dependencies
```bash
git clone https://github.com/deki18/openclaw-cortex-memory.git
cd openclaw-cortex-memory
pip install -r requirements.txt
```

### Step 2: Configure Environment
```bash
# Required
export OPENAI_API_KEY="your-api-key-here"

# Optional
export RERANKER_API_KEY="your-reranker-key"
export OPENAI_BASE_URL="https://api.openai.com/v1"
```

Update `config.yaml`:
```yaml
embedding_model: "text-embedding-3-large"
llm_model: "gpt-4"
reranker_api:
  model: "BAAI/bge-reranker-v2-m3"
```

### Step 3: Start the Python API Server
```bash
# Development
python -m api.server

# Production
uvicorn api.server:app --host 127.0.0.1 --port 8765
```

### Step 4: Build & Install TypeScript Plugin
```bash
cd plugin
npm install
npm run build

# Install to OpenClaw
openclaw plugins install .
```

### Step 5: Initialize Memory System
```bash
# Inject core rules into OpenClaw's MEMORY.md
python -m cli.memory_cli install

# Import existing OpenClaw data (optional)
python -m cli.memory_cli import --path ~/.openclaw
```

## Usage

### Via OpenClaw Agent
Once installed, the agent can use memory tools automatically:

```
User: What projects have I worked on recently?
Agent: [Uses search_memory tool to retrieve relevant memories]
```

### Via CLI
```bash
# Search memory
python -m cli.memory_cli search "project configuration"

# Sync new session data
python -m cli.memory_cli sync

# Trigger reflection
python -m cli.memory_cli reflect

# Query entity relationships
python -m cli.memory_cli graph "ProjectX"
```

### Via HTTP API
```bash
# Search
curl -X POST http://localhost:8765/search \
  -H "Content-Type: application/json" \
  -d '{"query": "database configuration", "top_k": 5}'

# Store event
curl -X POST http://localhost:8765/event \
  -H "Content-Type: application/json" \
  -d '{"summary": "Deployed new API endpoint", "outcome": "success"}'
```

## Configuration

### config.yaml
```yaml
embedding_model: "text-embedding-3-large"  # OpenAI embedding model
llm_model: "gpt-4"                         # LLM for summarization
openai_base_url: ""                        # Custom API endpoint
openclaw_base_path: ~/.openclaw            # OpenClaw data directory
lancedb_path: ~/.openclaw/agents/main/lancedb_store  # LanceDB path
reranker_api:
  url: https://api.siliconflow.cn/v1/rerank
  model: "BAAI/bge-reranker-v2-m3"
chunk:
  size: 600
  overlap: 100
time_decay_halflife: 30                    # Days for 50% score decay
promotion_hit_threshold: 3                 # Hits to promote to core rule
```

### Environment Variables
| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | OpenAI API key |
| `RERANKER_API_KEY` | No | Reranker API key |
| `OPENAI_BASE_URL` | No | Custom OpenAI endpoint |
| `CORTEX_MEMORY_API_URL` | No | API server URL (default: http://127.0.0.1:8765) |

## Data Schema

### OpenClawMemory (LanceDB Table)
```python
class OpenClawMemory(LanceModel):
    id: str                    # Unique identifier
    vector: Vector(3072)       # Embedding vector
    text: str                  # Memory content (FTS indexed)
    type: str                  # 'core_rule' or 'daily_log'
    date: str                  # YYYY-MM-DD format
    agent: str                 # Scope isolation
    source_file: Optional[str] # Archive pointer
    hit_count: int             # Access frequency
    weight: int                # Retrieval weight (10 = immune to decay)
```

## API Reference

### Tools Registered with OpenClaw

| Tool | Description |
|------|-------------|
| `search_memory` | Search semantic memory |
| `store_event` | Store episodic event |
| `query_graph` | Query entity relationships |
| `get_hot_context` | Get current context |
| `reflect_memory` | Trigger reflection |
| `sync_memory` | Sync session data |
| `promote_memory` | Promote to core rules |

### HTTP API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/status` | GET | System status |
| `/search` | POST | Search memory |
| `/write` | POST | Write memory |
| `/event` | POST | Store event |
| `/events` | GET | List events |
| `/graph/query` | POST | Query graph |
| `/hot-context` | GET | Get hot context |
| `/sync` | POST | Sync memory |
| `/reflect` | POST | Trigger reflection |
| `/promote` | POST | Promote memories |
| `/import` | POST | Import legacy data |
| `/install` | POST | Install core rules |
| `/rebuild` | POST | Rebuild FTS index |

## Testing
```bash
python -m unittest discover tests
```

## Project Structure
```
openclaw-cortex-memory/
├── api/                    # FastAPI HTTP server
│   ├── __init__.py
│   └── server.py
├── cli/                    # Command-line interface
│   ├── __init__.py
│   └── memory_cli.py
├── memory_engine/          # Core memory modules
│   ├── __init__.py
│   ├── config.py
│   ├── embedding.py
│   ├── lancedb_store.py    # LanceDB storage (NEW)
│   ├── semantic_memory.py
│   ├── episodic_memory.py
│   ├── procedural_memory.py
│   ├── memory_graph.py
│   ├── memory_controller.py
│   ├── retrieval_pipeline.py
│   ├── write_pipeline.py
│   ├── promotion_engine.py
│   ├── reflection_engine.py
│   ├── hot_memory.py
│   ├── llm_client.py
│   ├── reranker.py
│   └── metadata_schema.py
├── plugin/                 # TypeScript OpenClaw plugin
│   ├── src/
│   │   └── index.ts
│   ├── package.json
│   ├── tsconfig.json
│   └── openclaw.plugin.json
├── tools/                  # Standalone tools
├── tests/                  # Unit tests
├── data/                   # Local data storage
├── config.yaml             # Configuration file
├── requirements.txt        # Python dependencies
├── SKILL.md                # Skill documentation
└── README.md               # This file
```

## License
MIT
