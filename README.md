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
            "dimensions": 3072,
            "apiKey": "${OPENAI_API_KEY}"
          },
          "llm": {
            "provider": "openai",
            "model": "gpt-4",
            "apiKey": "${OPENAI_API_KEY}"
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
| `delete_memory` | Delete a specific memory by ID |
| `update_memory` | Update memory content, type, or weight |
| `cleanup_memories` | Clean up old memories beyond specified days |
| `diagnostics` | Run system diagnostics |

## Memory System Architecture

### Four Memory Stores

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        MemoryController                                 │
├─────────────┬─────────────┬─────────────┬───────────────────────────────┤
│   Semantic  │   Episodic  │    Graph    │     Procedural                │
│   Memory    │   Memory    │   Memory    │      Memory                   │
├─────────────┼─────────────┼─────────────┼───────────────────────────────┤
│  LanceDB    │   JSONL     │    JSON     │      YAML                     │
│  向量+文本  │   时间线    │   关系网络  │     规则文件                  │
└──────┬──────┴──────┬──────┴──────┬──────┴───────────┬───────────────────┘
       │             │             │                  │
       └─────────────┴─────────────┴──────────────────┘
                         │
                    ┌────┴────┐
                    │ HotMemory│  (SOUL.md + 近期会话)
                    └────┬────┘
                         │
                    ┌────┴────┐
                    │ Retrieval│  (搜索+排序)
                    │ Pipeline │
                    └─────────┘
```

### Write Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           用户输入                                       │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐ │
│  │ 普通文本    │  │ 事件描述    │  │ 会话结束    │  │ 实体关系        │ │
│  │ write_memory│  │ store_event │  │ sync_memory │  │ (entities)      │ │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └─────────────────┘ │
│         │                │                │                              │
└─────────┼────────────────┼────────────────┼──────────────────────────────┘
          │                │                │
          ▼                ▼                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      四大记忆库并行写入                                  │
│                                                                         │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐ │
│  │  Semantic       │  │   Episodic      │  │        Graph            │ │
│  │  Memory         │  │   Memory        │  │       Memory            │ │
│  │  ├─向量嵌入     │  │   ├─事件记录    │  │   ├─节点(实体)          │ │
│  │  ├─文本内容     │  │   ├─时间戳      │  │   │  ├─name             │ │
│  │  ├─type=event   │  │   └─JSONL追加   │  │   │  ├─type             │ │
│  │  └─LanceDB      │  │                 │  │   │  └─attributes       │ │
│  │                 │  │                 │  │   ├─边(关系)            │ │
│  │  ┌───────────┐  │  │                 │  │   │  ├─source           │ │
│  │  │去重检测   │  │  │                 │  │   │  ├─target           │ │
│  │  │相似度>0.95│  │  │                 │  │   │  └─edge_type        │ │
│  │  └───────────┘  │  │                 │  │   └─JSON文件            │ │
│  └─────────────────┘  └─────────────────┘  └─────────────────────────┘ │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                     Procedural Memory                           │   │
│  │                     (通过 reflect/promote 触发)                 │   │
│  │                     ├─SOUL.md (热上下文)                        │   │
│  │                     └─MEMORY.md (核心规则)                      │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Read Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           查询请求                                       │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐ │
│  │ 语义搜索    │  │ 图谱查询    │  │ 热上下文    │  │ 时间范围搜索    │ │
│  │ search_     │  │ query_      │  │ get_hot_    │  │ search_by_date  │ │
│  │ memory()    │  │ graph()     │  │ context()   │  │ _range()        │ │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └─────────────────┘ │
│         │                │                │                              │
└─────────┼────────────────┼────────────────┼──────────────────────────────┘
          │                │                │
          ▼                ▼                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         数据检索层                                       │
│                                                                         │
│   ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────────┐ │
│   │  Retrieval      │    │   Graph         │    │    Hot Memory       │ │
│   │  Pipeline       │    │   Memory        │    │                     │ │
│   │                 │    │                 │    │  ┌───────────────┐  │ │
│   │  ├─向量搜索     │    │  ├─节点查找     │    │  │  SOUL.md      │  │ │
│   │  ├─BM25文本     │    │  ├─邻接遍历     │    │  │  (规则知识)   │  │ │
│   │  ├─混合搜索     │    │  ├─关系提取     │    │  └───────────────┘  │ │
│   │  │              │    │  └─结构化返回   │    │                     │ │
│   │  ├─时间衰减     │◄───┤                │    │  ┌───────────────┐  │ │
│   │  │ (半衰期30天) │    │                │    │  │ 近期会话      │  │ │
│   │  ├─重排序       │    │                │    │  │ (最近20条)    │  │ │
│   │  └─命中计数     │    │                │    │  └───────────────┘  │ │
│   │                 │    │                 │    │                     │ │
│   └────────┬────────┘    └────────┬────────┘    └──────────┬──────────┘ │
│            │                      │                        │            │
└────────────┼──────────────────────┼────────────────────────┼────────────┘
             │                      │                        │
             ▼                      ▼                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      结果融合与返回                                      │
│                                                                         │
│   ┌─────────────────────────────────────────────────────────────────┐   │
│   │                      智能融合层                                  │   │
│   │                                                                 │   │
│   │   ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐ │   │
│   │   │ 语义结果    │    │ 关系结果    │    │ 上下文增强          │ │   │
│   │   │ ├─相关记忆  │    │ ├─实体信息  │    │ ├─规则注入          │ │   │
│   │   │ ├─评分排序  │    │ ├─关系链    │    │ ├─近期背景          │ │   │
│   │   │ └─来源追溯  │    │ └─关联实体  │    │ └─时间线            │ │   │
│   │   └──────┬──────┘    └──────┬──────┘    └──────────┬──────────┘ │   │
│   │          │                  │                      │             │   │
│   │          └──────────────────┼──────────────────────┘             │   │
│   │                             ▼                                    │   │
│   │                    ┌─────────────────┐                          │   │
│   │                    │   综合答案生成   │                          │   │
│   │                    │  (供LLM使用)     │                          │   │
│   │                    └─────────────────┘                          │   │
│   │                                                                 │   │
│   └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Memory Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         记忆生命周期                                     │
│                                                                         │
│   写入 ──────► 活跃期 ──────► 衰退期 ──────► 沉淀/删除                  │
│                                                                         │
│    │            │             │             │                           │
│    ▼            ▼             ▼             ▼                           │
│ ┌──────┐   ┌────────┐   ┌──────────┐   ┌──────────┐                    │
│ │新记忆│   │ 高频访问 │   │ 时间衰减  │   │ 核心规则  │                    │
│ │      │   │        │   │ (30天半衰)│   │ (promote)│                    │
│ │event │   │ hit++  │   │ 权重下降  │   │          │                    │
│ │daily │   │        │   │          │   │ 或删除    │                    │
│ │_log  │   │        │   │          │   │ (cleanup)│                    │
│ └──────┘   └────────┘   └──────────┘   └──────────┘                    │
│                                                                         │
│   ┌─────────────────────────────────────────────────────────────────┐   │
│   │                        触发机制                                  │   │
│   │                                                                 │   │
│   │  写入: write_memory / store_event / sync                        │   │
│   │  活跃: 每次search命中 +1                                        │   │
│   │  衰退: 自动时间衰减 (search时计算)                              │   │
│   │  沉淀: hit > threshold (默认3次)                                │   │
│   │  删除: cleanup_memories (默认90天)                              │   │
│   │                                                                 │   │
│   └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

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
