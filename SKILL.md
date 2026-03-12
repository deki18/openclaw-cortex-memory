# OpenClaw Cortex Memory

This skill integrates the OpenClaw Cortex Memory system into the main OpenClaw agent.

## Description
Provides advanced memory capabilities including Semantic Memory, Episodic Memory, Procedural Memory, Memory Graph, and a Reflection Engine.

## Architecture

This plugin uses a hybrid architecture:
- **Python Core**: Handles memory operations (LanceDB storage, embeddings, LLM)
- **HTTP API**: FastAPI server exposes the Python core functionality
- **TypeScript Plugin**: Integrates with OpenClaw's plugin system

### LanceDB (v2.0)
- **Zero-Copy Storage**: Columnar storage with disk-direct reads
- **Native Hybrid Search**: Built-in Tantivy FTS engine for vector + BM25 fusion
- **Strong Schema**: Pydantic/LanceModel for strict type constraints

## Installation

### 1. Install Python Dependencies
```bash
cd openclaw-cortex-memory
pip install -r requirements.txt
```

### 2. Configure Environment
Set the following environment variables:
```bash
export OPENAI_API_KEY="your-api-key-here"
export RERANKER_API_KEY="your-reranker-key"  # Optional, for reranking
```

Update `config.yaml` with your model settings:
```yaml
embedding_model: "text-embedding-3-large"
llm_model: "gpt-4"
reranker_api:
  model: "BAAI/bge-reranker-v2-m3"
```

### 3. Start the Python API Server
```bash
python -m api.server
# or with uvicorn:
uvicorn api.server:app --host 127.0.0.1 --port 8765
```

### 4. Install the TypeScript Plugin
```bash
cd plugin
npm install
npm run build
```

### 5. Register with OpenClaw
Copy the plugin directory to your OpenClaw plugins folder or install via npm:
```bash
openclaw plugins install @openclaw/cortex-memory
```

## Available Tools

### search_memory
Search the long-term semantic memory for relevant information.
```
Parameters:
  - query (string, required): The search query
  - top_k (number, optional): Number of results to return (default: 3)
```

### store_event
Store a new episodic event or significant milestone.
```
Parameters:
  - summary (string, required): Brief summary of the event
  - entities (array, optional): List of entities involved
  - outcome (string, optional): The outcome or result
  - relations (array, optional): Relationships between entities
```

### query_graph
Query the memory graph for entity relationships.
```
Parameters:
  - entity (string, required): The entity name to query
```

### get_hot_context
Get current hot context including SOUL.md and recent sessions.
```
Parameters:
  - limit (number, optional): Max items to include (default: 20)
```

### reflect_memory
Trigger reflection to process events into knowledge.
```
Parameters: none
```

### sync_memory
Synchronize memory by processing new session data.
```
Parameters: none
```

### promote_memory
Promote frequently accessed memories to core rules.
```
Parameters: none
```

## CLI Commands

The Python CLI can be used for direct operations:
```bash
python -m cli.memory_cli status
python -m cli.memory_cli search "<query>"
python -m cli.memory_cli sync
python -m cli.memory_cli rebuild
python -m cli.memory_cli promote
python -m cli.memory_cli events
python -m cli.memory_cli graph "<entity>"
python -m cli.memory_cli reflect
python -m cli.memory_cli import --path ~/.openclaw
python -m cli.memory_cli install
```

## API Endpoints

The HTTP API runs on `http://127.0.0.1:8765` by default:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/status` | GET | Memory system status |
| `/search` | POST | Search memory |
| `/write` | POST | Write memory |
| `/event` | POST | Store event |
| `/events` | GET | List events |
| `/graph/query` | POST | Query memory graph |
| `/hot-context` | GET | Get hot context |
| `/sync` | POST | Sync memory |
| `/reflect` | POST | Trigger reflection |
| `/promote` | POST | Promote memories |
| `/import` | POST | Import legacy data |
| `/install` | POST | Install core rules |
| `/rebuild` | POST | Rebuild FTS index |

## Configuration

### Environment Variables
- `OPENAI_API_KEY`: Required for embeddings and LLM
- `RERANKER_API_KEY`: Optional, for reranking API
- `OPENAI_BASE_URL`: Optional, custom OpenAI API endpoint
- `CORTEX_MEMORY_API_URL`: Optional, custom API URL (default: http://127.0.0.1:8765)

### config.yaml
```yaml
embedding_model: "text-embedding-3-large"
llm_model: "gpt-4"
openai_base_url: ""
openclaw_base_path: ~/.openclaw
lancedb_path: ~/.openclaw/agents/main/lancedb_store
reranker_api:
  url: https://api.siliconflow.cn/v1/rerank
  model: "BAAI/bge-reranker-v2-m3"
chunk:
  size: 600
  overlap: 100
time_decay_halflife: 30
promotion_hit_threshold: 3
```

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
