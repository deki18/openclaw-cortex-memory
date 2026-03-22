---
name: cortex-memory
description: 长期记忆系统。Use when user asks about past conversations, preferences, project history, or needs to remember information across sessions. 提供语义搜索、事件追踪和知识图谱功能。
homepage: https://github.com/deki18/openclaw-cortex-memory
metadata:
  {
    "openclaw": {
      "emoji": "🧠",
      "os": ["darwin", "linux", "win32"],
      "requires": {
        "bins": ["python3"],
        "env": ["OPENAI_API_KEY"]
      },
      "primaryEnv": "OPENAI_API_KEY"
    }
  }
---

# Cortex Memory - 长期记忆系统

为 OpenClaw Agent 提供持久化记忆能力，支持语义搜索、事件追踪和知识图谱。

## 使用场景

**USE when:**
- 用户询问过去的对话内容或决策
- 需要记住用户偏好、项目信息
- 跨会话保持上下文
- 查询实体关系（人物、项目、技术）
- 存储重要事件或里程碑

**DON'T use when:**
- 仅需当前会话的临时信息
- 查询实时数据（天气、新闻等）

## 快速开始

### 安装

```bash
cd ~/.openclaw/extensions
git clone https://github.com/deki18/openclaw-cortex-memory.git
cd openclaw-cortex-memory
npm install
```

`npm install` 自动完成：创建 Python 虚拟环境、安装依赖、构建 TypeScript。

### 配置

在 `~/.openclaw/openclaw.json` 中添加：

```json
{
  "plugins": {
    "load": {
      "paths": ["~/.openclaw/extensions/openclaw-cortex-memory"]
    },
    "slots": { "memory": "openclaw-cortex-memory" },
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
            "baseURL": "https://api.siliconflow.cn/v1/rerank"
          },
          "autoSync": true,
          "autoReflect": false
        }
      }
    }
  }
}
```

### 启动

```bash
openclaw config validate
openclaw gateway restart
```

Python 后端服务随插件加载自动启动。

### 首次启动配置

本插件安装并首次启动 OpenClaw 后，请将以下内容发送给你的Agent：

```
请将以下内容写入 `~/.openclaw/workspace/MEMORY.md`：
## Cortex Memory Integration Rules

You are equipped with the Cortex Memory engine. You must proactively manage and utilize your memory using the provided skills.

1. Proactive Retrieval: If a user asks about past interactions, projects, preferences, or technical context that is not in your immediate short-term memory, you MUST use the search_memory tool to retrieve semantic memory before answering. Do not guess or hallucinate past events.

2. Auto Context: For proactive memory retrieval without explicit search, use get_auto_context to get automatically retrieved relevant memories based on recent user messages, plus hot context.

3. Hot Context: When you need current session context including CORTEX_RULES.md and recent data, use get_hot_context to retrieve the hot memory layer.

4. Relational Queries: If the user asks about the relationship between entities (e.g., "Who worked on Project X?", "What technologies does Person Y use?"), use the query_graph tool to query the memory graph. The graph supports 16 entity types (Person, Task, Project, Event, Document, Concept, Location, Organization, Credential, Preference, Goal, Note, Resource, Topic, Entity, Unknown) and 19 relation types with schema validation.

5. Memory Consolidation: When you learn a new, important fact about the user, complete a significant milestone, or resolve a complex bug, you should summarize it and use store_event to record it. Include entity type and attributes for better graph integration.

6. Self-Reflection: Periodically, or when asked to review past performance, use the reflect_memory tool to generate insights from your episodic memory.

7. Historical Sync: To import historical session data from OpenClaw workspace, use sync_memory tool. This is incremental and won't reprocess already imported data.

8. Graph Statistics: To check the memory graph status, use CLI command cortex-memory graph --stats to see total nodes, edges, and type distribution. Use cortex-memory graph --validate to check graph integrity.

9. Schema Awareness: The graph memory enforces schema constraints including type validation, cardinality (one_to_one, many_to_one, many_to_many), and acyclic detection for dependency relations. Invalid relations will be rejected.

10. Trust the Engine: The memory engine handles vector search, BM25 keyword matching, and time-decay automatically. Trust its top results.
```

### 导入历史记忆

如需导入 OpenClaw 原有记忆数据，发送以下提示词：

```
使用 sync_memory 工具导入历史会话记忆
```

## 可用工具

### search_memory

语义搜索长期记忆。

**参数：**
| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| query | string | 是 | 搜索查询 |
| top_k | number | 否 | 返回数量，默认 3 |

**示例：**
```json
{ "query": "我们讨论过的认证方案是什么？", "top_k": 5 }
```

### store_event

存储事件或里程碑。

**参数：**
| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| summary | string | 是 | 事件摘要 |
| entities | array | 否 | 相关实体列表 |
| outcome | string | 否 | 事件结果 |
| relations | array | 否 | 实体关系 |

**示例：**
```json
{
  "summary": "成功部署新版本 API",
  "entities": [{ "name": "API Server", "type": "service" }],
  "outcome": "零停机部署完成"
}
```

### query_graph

查询实体关系图谱。

**参数：**
| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| entity | string | 是 | 实体名称 |

### get_hot_context

获取当前热上下文（CORTEX_RULES.md + 近期会话）。

**参数：**
| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| limit | number | 否 | 最大条目数，默认 20 |

### get_auto_context

自动检索相关记忆（基于近期消息）。

**参数：**
| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| include_hot | boolean | 否 | 包含热上下文，默认 true |

### reflect_memory

触发反思引擎，将事件转化为语义知识。

### sync_memory

从 OpenClaw 工作区导入历史会话数据（增量处理）。

**使用场景：**
- 首次安装插件后导入历史数据
- 手动同步 OpenClaw 会话记录
- 导入每日总结文件

**处理路径：**
| 路径 | 说明 |
|------|------|
| `~/.openclaw/agents/main/sessions/*.jsonl` | 会话记录 |
| `~/.openclaw/workspace/memory/*.md` | 每日总结 |

**示例：**
```json
{}
```

无需参数，直接调用即可。增量处理，已导入数据不会重复。

### promote_memory

将高频访问记忆提升为核心规则。

### delete_memory

删除指定记忆。

**参数：**
| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| memory_id | string | 是 | 记忆 ID |

### update_memory

更新记忆内容。

**参数：**
| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| memory_id | string | 是 | 记忆 ID |
| text | string | 否 | 新文本内容 |
| type | string | 否 | 新记忆类型 |
| weight | number | 否 | 新权重值 |

### cleanup_memories

清理旧记忆。

**参数：**
| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| days_old | number | 否 | 超过天数，默认 90 |
| memory_type | string | 否 | 仅清理指定类型 |

### diagnostics

运行系统诊断，检查配置和连接状态。

## 配置选项

| 选项 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| embedding.provider | 是 | - | `openai` / `openai-compatible` / `jina` |
| embedding.model | 是 | - | Embedding 模型名称 |
| embedding.dimensions | 否 | 3072 | 向量维度 |
| embedding.apiKey | 否 | ${OPENAI_API_KEY} | API Key |
| embedding.baseURL | 否 | - | 自定义端点 |
| llm.provider | 是 | - | LLM 提供商 |
| llm.model | 是 | - | LLM 模型名称 |
| reranker.provider | 否 | - | Reranker 提供商 |
| reranker.model | 否 | - | Reranker 模型 |
| reranker.apiKey | 否 | - | Reranker API Key |
| reranker.endpoint | 否 | - | Reranker 端点 |
| dbPath | 否 | ~/.openclaw/agents/main/lancedb_store | 数据库路径 |
| autoSync | 否 | true | 会话结束自动同步 |
| autoReflect | 否 | false | 自动触发反思 |

## 记忆架构

```
┌─────────────────────────────────────────────────────────────┐
│                    MemoryController                         │
├─────────────┬─────────────┬─────────────┬───────────────────┤
│  Semantic   │  Episodic   │    Graph    │   Procedural      │
│  Memory     │  Memory     │   Memory    │     Memory        │
├─────────────┼─────────────┼─────────────┼───────────────────┤
│  LanceDB    │   JSONL     │   JSONL     │     YAML          │
│  向量+文本  │   时间线    │  关系网络   │    规则文件       │
│             │             │ +Schema验证 │                   │
└─────────────┴─────────────┴─────────────┴───────────────────┘
```

**四大记忆库：**
- **Semantic Memory**: LanceDB 向量存储，语义相似度检索
- **Episodic Memory**: JSONL 时间线，事件追踪
- **Graph Memory**: JSONL 关系网络，实体关联，支持 Schema 验证和关系约束
- **Procedural Memory**: YAML 规则文件，操作知识

**Graph Memory 特性：**
- Schema 定义：16 种实体类型、19 种关系类型
- 类型验证：必填属性、禁止属性、枚举值检查
- 关系约束：类型匹配、基数约束（one_to_one/many_to_one/many_to_many）、无环检测
- 操作审计：JSONL append-only 存储，记录所有创建/更新/删除操作

## 数据流

### 写入流程

**实时写入（消息钩子）：**
```
消息钩子 → 检查条件 → /write API → 文本预处理 → LLM结构化提取 → 质量评估
    → [可能跳过: 质量过低] → 向量嵌入 → 三阶段去重
    → [可能跳过: 重复检测] → 分层存储 → LanceDB → 冷热分层 → 知识图谱
```

**触发条件：**
- 插件已启用
- 消息包含文本内容（`content` 或 `text` 字段）
- 文本非空

**跳过条件：**
- 质量评分低于阈值（信息密度不足）
- 重复检测（相似度 > 0.95）

**批量写入（会话结束）：**
```
会话结束 → process_session_records → 读取 OpenClaw 会话记录
    → LLM分段 → 批量写入记忆库
```

**处理路径：**
| 路径 | 说明 |
|------|------|
| `~/.openclaw/agents/main/sessions/*.jsonl` | OpenClaw 会话记录 |
| `~/.openclaw/workspace/memory/*.md` | 每日总结文件 |

### 读取流程

```
查询 → 查询理解 → [可能跳过: 简单问候] → 多路召回（向量+关键词+图谱）
    → 融合排序 → 时间衰减 → 重排序 → 返回结果
```

### 触发机制

| 触发点 | 动作 |
|--------|------|
| 消息钩子 | 调用 /write API（需满足触发条件，可能因质量/重复跳过） |
| 用户消息 | 自动检索相关记忆（文本长度 > 5） |
| 会话结束 | 批量处理会话记录 + 生成事件 |
| 定时任务 | 反思 + 晋升（autoReflect=true） |

## 热插拔支持

### CLI 命令

CLI 命令需要在插件目录下运行：

```bash
cd ~/.openclaw/extensions/openclaw-cortex-memory
npx cortex-memory enable              # 启用插件
npx cortex-memory disable             # 禁用插件（回退到内置记忆）
npx cortex-memory status              # 查看状态
npx cortex-memory uninstall           # 完全卸载
npx cortex-memory uninstall --keep-data  # 卸载但保留数据
npx cortex-memory doctor              # 运行诊断
```

### 配置热插拔

```json
{
  "plugins": {
    "entries": {
      "openclaw-cortex-memory": {
        "enabled": false
      }
    }
  }
}
```

禁用时自动回退到 OpenClaw 内置记忆系统。

## 错误处理

| 错误代码 | 说明 | 处理方式 |
|----------|------|----------|
| E001 | 连接被拒绝 | 检查 Python 服务是否运行 |
| E002 | 请求超时 | 服务可能过载，稍后重试 |
| E003 | 记忆不存在 | 记忆可能已删除 |
| E101 | Embedding 服务不可用 | 检查 API Key 和模型配置 |
| E102 | LLM 服务不可用 | 检查 API Key 和模型配置 |
| E203 | 重复记忆 | 相似度 > 0.95，已跳过 |
| E204 | 质量评分过低 | 信息密度不足，未存储 |

## 资源消耗

| 资源 | 占用 |
|------|------|
| 内存 | 200-500 MB |
| CPU | 空闲 ~0%，搜索时波动 |
| 磁盘 | 按记忆量增长 |

## 文件位置

| 类型 | 默认位置 |
|------|---------|
| 插件目录 | ~/.openclaw/extensions/openclaw-cortex-memory/ |
| LanceDB 数据 | ~/.openclaw/agents/main/lancedb_store/ |
| 事件记忆 | ~/.openclaw/episodic_memory.jsonl |
| 记忆图谱 | ~/.openclaw/knowledge_graph.jsonl |
| Schema 定义 | ~/.openclaw/extensions/openclaw-cortex-memory/memory_engine/graph/schema.yaml |

## 安全注意

- API Key 通过环境变量或 openclaw.json 配置，不要硬编码
- 敏感信息建议使用 SecretRef
- 记忆数据存储在本地，不上传云端
- 定期运行 `cortex-memory doctor` 检查配置

## 相关文件

- [plugin/src/index.ts](plugin/src/index.ts) - TypeScript 插件入口
- [api/server.py](api/server.py) - FastAPI 后端服务
- [memory_engine/enhanced_controller.py](memory_engine/enhanced_controller.py) - 核心控制器
- [doc/PROJECT_OVERVIEW.md](doc/PROJECT_OVERVIEW.md) - 项目详细文档

## 依赖

- Python >= 3.10
- Node.js >= 22
- OpenAI API Key（或兼容 API）
