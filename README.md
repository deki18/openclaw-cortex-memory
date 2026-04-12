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
- 冲突治理：单值事实冲突进入队列，支持人工 `accept/reject` 闭环
- 可视化导出：`export_graph_view` 输出状态化图谱快照（含来源证据）
- 质量门禁：`graphQualityMode` 支持 `off/warn/strict`

### 4) 规则演进
- 反思沉淀：`reflect_memory` 将事件抽象为规则
- 去重治理：规则与事件均有去重控制，避免污染
- 规则复用：规则写入 `CORTEX_RULES.md` 供后续任务复用

### 5) 运维诊断
- `diagnostics`：模型连通、层级状态、字段对齐检查
- `backfill_embeddings`：支持 `incremental / vector_only / full`
- `lint_memory_wiki`：Wiki/图谱一致性巡检与修复建议
- 完整状态文件：便于快速定位同步、回填、质量问题

---

## 已注册工具（与当前代码一致）

- `search_memory`
- `store_event`
- `query_graph`
- `export_graph_view`
- `lint_memory_wiki`
- `list_graph_conflicts`
- `resolve_graph_conflict`
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
| `export_graph_view` | `write_snapshot` |
| `lint_memory_wiki` | 无 |
| `list_graph_conflicts` | `status`, `limit` |
| `resolve_graph_conflict` | `conflict_id`, `action`, `note` |
| `get_hot_context` | `limit` |
| `get_auto_context` | `include_hot` |
| `reflect_memory` | 无 |
| `sync_memory` | 无 |
| `backfill_embeddings` | `layer`, `batch_size`, `max_retries`, `retry_failed_only`, `rebuild_mode` |
| `diagnostics` | 无 |
| `delete_memory` | `memory_id` |

---

## Agent 使用手册（系统提示词）

> 可直接粘贴到 Agent 的系统提示词中使用

**Cortex Memory 记忆插件使用规则（核心规则，不允许删除）**

你已接入 Cortex Memory。必须遵循以下规则：

1. 禁止臆造历史事实；凡涉及历史对话、用户偏好、项目既有决策，先检索再回答。  
2. 单个任务内避免重复写入：`store_event` / `reflect_memory` 仅在关键节点或收尾触发一次。  
3. 用户询问历史信息、偏好、项目上下文时：先调用 `search_memory`，再回答。  
4. 需要当前会话热上下文时：调用 `get_hot_context`。  
5. 需要自动召回相关记忆时：调用 `get_auto_context`。  
6. 需要实体关系、依赖链路或路径关系时：调用 `query_graph`。  
7. 仅在“重要事项已结束且结论明确”后调用 `store_event` 记录结果（过程进行中不频繁记录）。  
8. 当任务经历“失败 -> 调整 -> 成功”时：先用 `store_event` 记录失败原因与成功方案，再调用 `reflect_memory` 沉淀可复用规则。  
9. 需要导入历史会话时：调用 `sync_memory`。  
10. 当 `diagnostics` 显示 active/archive 有未向量化记录，或迁移后需重建向量层时：调用 `backfill_embeddings`（按需选择 `incremental` / `vector_only` / `full`）。  
11. 出现配置校验失败、记忆读写异常、检索结果异常或数据目录问题时：优先调用 `diagnostics`。  
12. 仅在用户明确要求删除记忆，且已确认 `memory_id` 时，才调用 `delete_memory`；禁止在未确认情况下自动删除。  
13. 任一工具调用失败时，先重试一次；仍失败则明确告知用户，并基于当前可得上下文继续完成任务。  
14. 调用任意 Cortex Memory 工具前，先确认当前运行环境可见该工具；若工具不可见，必须立即报告“当前 lane 不可用”，不得虚构执行结果。  
15. `sync_memory` 属于关键路径任务：执行前后应避免并发重复触发；若已有同任务进行中，复用当前结果或等待完成。  
16. 当用户明确请求 Cortex Memory 任务（如 `sync_memory` / `search_memory` / `store_event`）时，禁止切换到无关流程（如心跳巡检、日报、闲聊任务）；若被系统任务打断，先完成用户请求再处理后台任务。  
17. 当 `query_graph` 返回 `conflict_hint` 时，不得静默覆盖冲突事实；应先调用 `list_graph_conflicts`，并与用户确认后再 `resolve_graph_conflict`。  
18. 需要解释图谱状态分布或排查投影异常时，优先调用 `export_graph_view` 与 `lint_memory_wiki`。  

---

## 快速开始

### 安装

```bash
cd ~/openclaw
openclaw plugins install clawhub:openclaw-cortex-memory
openclaw plugins enable openclaw-cortex-memory
```

如果 `clawhub:` 安装出现 `fetch failed`，可改用 npm 包本地安装（推荐兜底）：

```bash
npm pack openclaw-cortex-memory@0.1.0-Alpha.31
openclaw plugins install ./openclaw-cortex-memory-0.1.0-Alpha.31.tgz
openclaw plugins enable openclaw-cortex-memory
rm ./openclaw-cortex-memory-0.1.0-Alpha.31.tgz
```

完成安装后，请先按下方"最小配置"示例配置 `openclaw.json`，确认配置无误后再启动 gateway。

### 更新

```bash
rm -r ~/.openclaw/extensions/openclaw-cortex-memory
npm pack openclaw-cortex-memory@0.1.0-Alpha.31
openclaw plugins install ./openclaw-cortex-memory-0.1.0-Alpha.31.tgz
openclaw plugins enable openclaw-cortex-memory
rm ./openclaw-cortex-memory-0.1.0-Alpha.31.tgz
openclaw plugins list  --enabled
openclaw gateway restart
```

### 卸载

```bash
cd ~/openclaw
openclaw plugins disable openclaw-cortex-memory
openclaw plugins uninstall openclaw-cortex-memory
```

如需卸载插件但保留记忆数据：

```bash
cd ~/openclaw
openclaw plugins disable openclaw-cortex-memory
openclaw plugins uninstall openclaw-cortex-memory --keep-data
```

### 最小配置（推荐先跑起来）

```json
{
  "plugins": {
    "allow": ["openclaw-cortex-memory"],
    "slots": { "memory": "none" },
    "entries": {
      "openclaw-cortex-memory": {
        "enabled": true,
        "config": {
          "autoSync": true,
          "autoReflect": false,
          "graphQualityMode": "warn",
          "wikiProjection": {
            "enabled": true,
            "mode": "incremental",
            "maxBatch": 100
          },
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

默认情况下（未配置 `dbPath`），数据目录为 OpenClaw workspace 下：

- Linux/macOS: `~/.openclaw/workspace/memory/openclaw-cortex-memory`
- Windows: `%USERPROFILE%\\.openclaw\\workspace\\memory\\openclaw-cortex-memory`

如果当前进程无法识别 OpenClaw 基础目录（例如离线脚本直接运行且无相关环境变量），会回退到项目目录：

- `<projectRoot>/data/memory`

如果在插件配置里设置了 `dbPath`，则以下文件都会写到你指定的 `dbPath` 下：

- `<memoryRoot>/MEMORY.md`
- `<memoryRoot>/CORTEX_RULES.md`
- `<memoryRoot>/sessions/active/sessions.jsonl`
- `<memoryRoot>/sessions/archive/sessions.jsonl`
- `<memoryRoot>/graph/memory.jsonl`
- `<memoryRoot>/graph/mutation_log.jsonl`
- `<memoryRoot>/graph/conflict_queue.jsonl`
- `<memoryRoot>/graph/superseded_relations.jsonl`
- `<memoryRoot>/wiki/index.md`
- `<memoryRoot>/wiki/log.md`
- `<memoryRoot>/wiki/entities/*.md`
- `<memoryRoot>/wiki/topics/*.md`
- `<memoryRoot>/wiki/graph/view.json`
- `<memoryRoot>/wiki/graph/timeline.jsonl`
- `<memoryRoot>/wiki/.projection_index.json`
- `<memoryRoot>/wiki/.rebuild_queue.jsonl`
- `<memoryRoot>/vector/lancedb`
- `<memoryRoot>/vector/lancedb_events.jsonl`
- `<memoryRoot>/.sync_state.json`
- `<memoryRoot>/.session_end_state.json`
- `<memoryRoot>/.rule_store_state.json`
- `<memoryRoot>/.dedup_index.json`
- `<memoryRoot>/.read_hit_stats.json`

---

## 常用命令

```bash
npm run typecheck
npm run test:graph-quality
npm run test:graph-quality-zh
```

---

MIT License
