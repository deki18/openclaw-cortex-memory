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
| `embedding.dimensions` | No | 3072 | Vector dimensions (1536 for text-embedding-3-small) |
| `embedding.apiKey` | No | `${OPENAI_API_KEY}` | API key for embedding |
| `embedding.baseURL` | No | - | Custom API endpoint |
| `llm.provider` | Yes | - | LLM provider for reflection |
| `llm.model` | Yes | - | LLM model name |
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

### delete_memory
Delete a specific memory by ID.

**Parameters:**
- `memory_id` (string, required): Memory ID to delete

### update_memory
Update a specific memory's content, type, or weight.

**Parameters:**
- `memory_id` (string, required): Memory ID to update
- `text` (string, optional): New text content
- `type` (string, optional): New memory type
- `weight` (number, optional): New weight value

### cleanup_memories
Clean up old memories beyond specified days.

**Parameters:**
- `days_old` (number, optional): Delete memories older than this many days (default: 90)
- `memory_type` (string, optional): Only clean up memories of this type

### diagnostics
Run system diagnostics to check configuration and connectivity.

Returns:
- `status`: Overall health status ("healthy" or "issues_found")
- `checks`: List of diagnostic checks with pass/fail status
- `recommendations`: List of fixes for any issues found

### cortex_memory_status
Get the current status of the Cortex Memory plugin.

Returns:
- `enabled`: Whether the plugin is enabled
- `service_running`: Whether the Python backend is running
- `fallback_enabled`: Whether fallback to builtin memory is enabled
- `builtin_memory_available`: Whether OpenClaw builtin memory is available

## Hot-plug Support

Enable/disable the plugin without restarting OpenClaw.

### CLI Commands

```bash
cortex-memory enable    # Enable plugin
cortex-memory disable   # Disable plugin (fallback to builtin)
cortex-memory status    # Check status
```

### Configuration

```json
{
  "plugins": {
    "cortex-memory": {
      "enabled": true,
      "fallbackToBuiltin": true
    }
  }
}
```

When disabled with `fallbackToBuiltin: true`, memory operations fall back to OpenClaw's builtin system.

### Uninstall

```bash
cortex-memory uninstall           # Full uninstall
cortex-memory uninstall --keep-data  # Keep memory data
```

| Option | Description |
|--------|-------------|
| `--keep-data` | Keep memory data files |
| `--keep-config` | Keep plugin entry in openclaw.json |

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

## 架构设计

### 四大记忆库协作关系

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

### 写入流程

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

### 读取流程

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

---

## Agent Memory Tools Guide

This section provides guidance for AI Agents on how to use the Cortex Memory tools effectively.

### Overview

Cortex Memory is a long-term memory system that allows you to store, search, and retrieve information across sessions. It helps you remember important facts, events, and context from previous conversations.

---

### Tool Usage Guide

#### 1. search_memory

**Purpose**: Search for relevant memories using semantic search.

**When to use**:
- User asks about past conversations or decisions
- You need context about a topic discussed before
- User mentions something that might have been stored in memory

**Parameters**:
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| query | string | required | The search query |
| top_k | number | 10 | Number of results to return |

**Example**:
```json
{
  "query": "authentication system design decisions",
  "top_k": 5
}
```

**Returns**: List of relevant memories with scores and metadata.

---

#### 2. get_auto_context

**Purpose**: Get automatically retrieved memories based on recent user messages, plus hot context.

**When to use**:
- At the start of a response to get relevant context
- When you want proactive memory retrieval without explicit search
- To check what memories were automatically found relevant

**Parameters**:
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| include_hot | boolean | true | Include hot context (CORTEX_RULES.md + recent data) |

**Returns**:
- `auto_search`: Cached search results from recent user messages (max 60 seconds old)
- `hot_context`: Current hot context including core rules

**Note**: Auto-search is triggered on every user message, but results are cached. Call this tool to retrieve the cached results.

---

#### 3. get_hot_context

**Purpose**: Get the current hot context including CORTEX_RULES.md (core rules) and recent important data.

**When to use**:
- You need to understand the user's core preferences and rules
- At the beginning of important tasks
- When context about user preferences is needed

**Parameters**:
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| limit | number | 20 | Maximum items to return |

---

#### 4. store_event

**Purpose**: Store an episodic event (something significant that happened).

**When to use**:
- A significant task was completed
- An important decision was made
- A problem was solved
- Something worth remembering for future reference

**Parameters**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| summary | string | yes | Brief description of the event |
| entities | array | no | Related entities (people, projects, etc.) |
| outcome | string | no | Result or outcome of the event |
| relations | array | no | Relationships between entities |

**Example**:
```json
{
  "summary": "Successfully implemented OAuth2 authentication",
  "entities": [
    { "name": "OAuth2", "type": "technology" },
    { "name": "AuthService", "type": "component" }
  ],
  "outcome": "Authentication system is now production-ready"
}
```

---

#### 5. query_graph

**Purpose**: Query the knowledge graph for entity relationships.

**When to use**:
- You want to understand relationships between entities
- You need to find connected information
- Exploring the knowledge network

**Parameters**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| entity | string | yes | Entity name to query |

---

#### 6. sync_memory

**Purpose**: Import historical session data from OpenClaw workspace.

**When to use**:
- After installing the plugin to import past conversations
- When you want to ensure all historical data is indexed

**Note**: Incremental processing - won't reprocess already imported data.

---

#### 7. reflect_memory

**Purpose**: Trigger reflection process to convert episodic events into semantic knowledge.

**When to use**:
- After significant events have been stored
- Periodically to consolidate memories
- When you want to extract patterns from events

---

#### 8. promote_memory

**Purpose**: Promote frequently accessed memories to core rules.

**When to use**:
- When a memory should become a permanent rule
- After reflection identifies important patterns

---

### Best Practices

#### When to Search

1. **Proactive Search**: Call `get_auto_context` at the start of complex tasks
2. **Explicit Search**: Use `search_memory` when user asks about specific past information
3. **Context Building**: Use `get_hot_context` to understand user preferences

#### When to Store

1. **Significant Events**: Store important completions, decisions, and solutions
2. **User Preferences**: Store when user expresses strong preferences
3. **Problem-Solution Pairs**: Store when you solve a problem that might recur

#### Memory Lifecycle

```
User Message → Auto-Search (cached) → Your Response
     ↓
Store if Significant → Episodic Memory
     ↓
Reflect Periodically → Semantic Memory
     ↓
Promote if Important → Core Rules (CORTEX_RULES.md)
```

---

### Quick Reference

| Task | Tool | Priority |
|------|------|----------|
| Find past information | `search_memory` | High |
| Get recent context | `get_auto_context` | High |
| Understand preferences | `get_hot_context` | Medium |
| Store significant event | `store_event` | High |
| Query relationships | `query_graph` | Low |
| Import history | `sync_memory` | Low |
| Consolidate memories | `reflect_memory` | Low |

---

### Important Notes

1. **Auto-search cache expires in 60 seconds** - Call `get_auto_context` promptly after user messages
2. **Only the most recent auto-search is cached** - Previous searches are overwritten
3. **Quality matters** - The system evaluates memory quality before storing
4. **Duplicates are prevented** - Similar content won't be stored twice
5. **Hot context includes CORTEX_RULES.md** - Core rules are always available via `get_hot_context`

### 记忆生命周期

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
