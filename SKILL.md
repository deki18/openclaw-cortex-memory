---
name: cortex-memory
description: OpenClaw 长期记忆系统（TypeScript）。用于跨会话上下文复用、偏好记忆、历史追溯与图谱关系检索。
homepage: https://github.com/deki18/openclaw-cortex-memory
metadata:
  {
    "openclaw": {
      "emoji": "🧠",
      "os": ["darwin", "linux", "win32"],
      "requires": {
        "env": ["EMBEDDING_API_KEY", "LLM_API_KEY", "RERANKER_API_KEY"]
      },
      "primaryEnv": "EMBEDDING_API_KEY"
    }
  }
---

# Cortex Memory

## 使用场景

推荐使用：
- 需要跨会话记住用户偏好、项目背景、历史决策
- 需要查询实体关系（依赖、上下游、关联）
- 需要把对话沉淀成可复用规则

不建议使用：
- 仅当前会话的一次性临时信息
- 实时互联网数据查询（天气、新闻、股价）

## 可用工具（与代码一致）

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

### 参数速览

| 工具 | 关键参数 |
|------|------|
| `search_memory` | `query`, `top_k` |
| `store_event` | `summary`, `entities`, `entity_types`, `outcome`, `relations` |
| `query_graph` | `entity`, `rel`, `dir`, `path_to`, `max_depth` |
| `get_hot_context` | `limit` |
| `get_auto_context` | `include_hot` |
| `backfill_embeddings` | `layer`, `batch_size`, `max_retries`, `retry_failed_only`, `rebuild_mode` |
| `delete_memory` | `memory_id` |

## 使用建议

1. 回答历史问题前先调 `search_memory`。
2. 涉及实体关系优先调 `query_graph`。
3. 会话收尾或批量导入后再调 `sync_memory` / `reflect_memory`。
4. 诊断发现向量缺失时调 `backfill_embeddings`。

## 配置策略

先用最小配置跑通：`embedding`、`llm`、`reranker` + `autoSync`。
高级项（`readFusion`、`memoryDecay`、`vectorChunking`、`writePolicy`、`readTuning`）都有默认值，不需要一开始就调整。

## 安全与端点声明

- 本插件需要外部端点：`/embeddings`、`/chat/completions`、`/rerank`
- 凭证来源：环境变量或插件配置中的 `*.apiKey`
- 仅发送推理所需文本片段，不主动上传本地配置文件全集或环境变量全集

## 关键事实

- `backfill_embeddings` 已实现且已注册。
- `query_graph` 支持参数：`entity`、`rel`、`dir`、`path_to`、`max_depth`。
