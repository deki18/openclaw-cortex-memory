# OpenClaw Cortex Memory

OpenClaw 长期记忆插件 - 专为 OpenClaw AI 助手设计的智能记忆系统

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js: 22+](https://img.shields.io/badge/Node.js-22+-green.svg)](https://nodejs.org/)
[![OpenClaw: Plugin](https://img.shields.io/badge/OpenClaw-Plugin-orange.svg)](https://github.com/openclaw)

面向 OpenClaw 的长期记忆插件，集成多路检索、事件归档、图谱关系、向量化与反衰减排序，支持历史增量导入、规则反思和可观测诊断，帮助 Agent 在跨会话中持续积累并稳定调用高价值记忆。

---

## 核心能力

### 1) 语义检索
- 多路召回：`keyword / BM25 / vector / graph` 混合检索
- 排序融合：加权打分 + RRF + 可选 reranker
- 结果融合：可选 `readFusion`，支持权威融合返回
- 时序建模：`memoryDecay` + 命中反衰减（anti-decay）

### 2) 事件存储
- 分层写入：`active`（会话）与 `archive`（结构化事件）
- 摘要优先：归档记录保留 `summary` 与 `source_text`
- 向量分块：支持 summary/evidence 双通道向量记录
- 增量同步：按状态文件增量导入历史会话

### 3) 图谱关系
- 图谱独立层：`graph/memory.jsonl` 独立于 archive 文本层
- 关系追溯：每条关系可追溯 `source_event_id`
- 关系查询：`query_graph` 支持方向、关系类型、路径搜索
- 质量门禁：`graphQualityMode` 支持 `off/warn/strict`

### 4) 规则演进
- 反思沉淀：`reflect_memory` 将事件抽象为规则
- 去重治理：规则与事件均有去重控制，避免污染
- 规则复用：规则写入 `CORTEX_RULES.md` 供后续任务复用

### 5) 运维诊断
- `diagnostics`：模型连通、层级状态、字段对齐检查
- `backfill_embeddings`：支持 `incremental / vector_only / full`
- 完整状态文件：便于快速定位同步、回填、质量问题

---

## 已注册工具（与当前代码一致）

- `search_memory`
- `store_event`
- `query_graph`
- `get_hot_context`
- `get_auto_context`
- `reflect_memory`
- `sync_memory`
- `backfill_embeddings`
- `delete_memory`
- `diagnostics`

### 工具参数速览

| 工具 | 关键参数 |
|------|------|
| `search_memory` | `query`, `top_k` |
| `store_event` | `summary`, `entities`, `entity_types`, `outcome`, `relations` |
| `query_graph` | `entity`, `rel`, `dir`, `path_to`, `max_depth` |
| `get_hot_context` | `limit` |
| `get_auto_context` | `include_hot` |
| `backfill_embeddings` | `layer`, `batch_size`, `max_retries`, `retry_failed_only`, `rebuild_mode` |
| `delete_memory` | `memory_id` |

---

## 快速开始

### 安装

```bash
cd ~/openclaw
openclaw plugins install clawhub:openclaw-cortex-memory
openclaw plugins enable openclaw-cortex-memory
openclaw gateway restart
```

### 卸载

```bash
cd ~/openclaw
openclaw plugins disable openclaw-cortex-memory
openclaw plugins uninstall openclaw-cortex-memory
openclaw gateway restart
```

如需卸载插件但保留记忆数据：

```bash
cd ~/openclaw
openclaw plugins disable openclaw-cortex-memory
openclaw plugins uninstall openclaw-cortex-memory --keep-data
openclaw gateway restart
```

### 最小配置（推荐先跑起来）

```json
{
  "plugins": {
    "allow": ["openclaw-cortex-memory"],
    "slots": { "memory": "openclaw-cortex-memory" },
    "entries": {
      "openclaw-cortex-memory": {
        "enabled": true,
        "config": {
          "autoSync": true,
          "autoReflect": false,
          "graphQualityMode": "warn",
          "embedding": {
            "provider": "api",
            "model": "text-embedding-3-large",
            "apiKey": "${EMBEDDING_API_KEY}",
            "baseURL": "https://your-embedding-endpoint/v1",
            "dimensions": 3072
          },
          "llm": {
            "provider": "api",
            "model": "gpt-4",
            "apiKey": "${LLM_API_KEY}",
            "baseURL": "https://your-llm-endpoint/v1"
          },
          "reranker": {
            "provider": "api",
            "model": "BAAI/bge-reranker-v2-m3",
            "apiKey": "${RERANKER_API_KEY}",
            "baseURL": "https://your-reranker-endpoint/v1/rerank"
          }
        }
      }
    }
  }
}
```

## 外部端点与凭证声明（审查说明）

本插件是本地长期记忆系统，但以下能力依赖用户自配置的外部模型端点：

- `embedding`：向量化（`/embeddings`）
- `llm`：写入门控、规则反思、读融合（`/chat/completions`）
- `reranker`：候选重排序（`/rerank`）

对应凭证要求：

- 环境变量（可选）：`EMBEDDING_API_KEY`、`LLM_API_KEY`、`RERANKER_API_KEY`
- 插件配置（常用）：`embedding.apiKey`、`llm.apiKey`、`reranker.apiKey`
- 端点配置：`embedding.baseURL`、`llm.baseURL`、`reranker.baseURL`

### 网络发送的数据边界

- 会发送：用于模型推理的文本片段（如 query、候选摘要、转写片段、待向量化文本）
- 不会主动发送：本地配置文件原文、系统环境变量全集、插件状态文件全集
- 凭证使用方式：仅作为 `Authorization: Bearer` 请求头调用你配置的端点

### 风险与建议

- 你应只配置可信模型网关，密钥权限最小化（建议专用 key）
- 生产环境建议启用网关审计与请求日志脱敏
- 如不希望联网推理，不要配置外部端点/密钥（相关能力将降级或跳过）

<details>
<summary>高级配置（默认已内置，不懂可以不改）</summary>

- `readFusion`：融合候选数、通道权重、通道 TopK、最小 lexical/semantic 命中、长度归一
- `memoryDecay`：最小衰减地板、默认半衰期、事件类型半衰期、anti-decay 参数
- `vectorChunking`：分块大小、重叠、evidence 最大分块数
- `writePolicy`：archive/active 质量阈值与文本长度限制
- `readTuning`：打分权重、RRF 参数、recency 分桶、auto-context 轻量检索

</details>

---

## 数据目录

- `<dbPath>/MEMORY.md`
- `<dbPath>/CORTEX_RULES.md`
- `<dbPath>/sessions/active/sessions.jsonl`
- `<dbPath>/sessions/archive/sessions.jsonl`
- `<dbPath>/graph/memory.jsonl`
- `<dbPath>/graph/mutation_log.jsonl`
- `<dbPath>/vector/lancedb`
- `<dbPath>/vector/lancedb_events.jsonl`
- `<dbPath>/.sync_state.json`
- `<dbPath>/.session_end_state.json`
- `<dbPath>/.rule_store_state.json`
- `<dbPath>/.dedup_index.json`
- `<dbPath>/.read_hit_stats.json`

---

## 常用命令

```bash
npm run typecheck
npm run test:graph-quality
npm run test:graph-quality-zh
```

---

MIT License
