---
name: cortex-memory
description: 长期记忆系统（纯 TypeScript）。适用于历史对话回溯、偏好记忆、项目上下文延续与跨会话信息复用场景。
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

# Cortex Memory · 长期记忆系统

为 OpenClaw Agent 提供稳定的跨会话记忆能力。

## 使用场景

**建议使用场景（USE when）:**
- 用户询问过去的对话内容或决策
- 需要记住用户偏好、项目信息
- 跨会话保持上下文
- 查询实体关系（人物、项目、技术）
- 存储重要事件或里程碑

**不建议使用场景（DON'T use when）:**
- 仅需当前会话的临时信息
- 查询实时数据（天气、新闻等）

## 快速开始

### 安装

命令前缀说明：
- 若你是全局安装 OpenClaw，请直接使用 `openclaw ...`
- 若你使用源码安装的 OpenClaw ，请使用 `pnpm openclaw ...`

快速安装（推荐，显式来源）：

```bash
cd ~/openclaw
openclaw plugins install clawhub:openclaw-cortex-memory
openclaw plugins enable openclaw-cortex-memory
openclaw gateway restart
```

npm 安装方式：

```bash
cd ~/openclaw
openclaw plugins install openclaw-cortex-memory@alpha
openclaw plugins enable openclaw-cortex-memory
openclaw gateway restart
```

第三种安装方式（当 ClawHub/npm 解析受网络影响时）：

```bash
curl -L -o /tmp/cortex.tgz https://registry.npmjs.org/openclaw-cortex-memory/-/openclaw-cortex-memory-0.1.0-Alpha.19.tgz
cd ~/openclaw
openclaw plugins install /tmp/cortex.tgz
openclaw plugins enable openclaw-cortex-memory
rm -f /tmp/cortex.tgz
```

### 后续更新

```bash
cd ~/openclaw
rm -rf ~/.openclaw/extensions/openclaw-cortex-memory
openclaw plugins install clawhub:openclaw-cortex-memory
openclaw plugins enable openclaw-cortex-memory
openclaw gateway restart
```

说明：
- 推荐显式安装来源，减少 ClawHub-first 时代的来源歧义。
- 使用 `plugins install` 的安装记录方式，避免 `loaded without install/load-path provenance`。
- 保持 `plugins.allow` 显式包含 `openclaw-cortex-memory`，避免运行时把插件判定为未绑定信任源。
- 若 `plugins install openclaw-cortex-memory` 在 ClawHub 解析阶段失败，可使用上述 tgz 方式直接安装。

### 本地开发模式（无安装记录）

```bash
cd ~/.openclaw/extensions
git clone https://github.com/deki18/openclaw-cortex-memory.git
cd openclaw-cortex-memory
npm install
```

### 配置

在 `openclaw.json` 中配置插件：

```json
{
  "plugins": {
    "allow": ["openclaw-cortex-memory"],
    "slots": { "memory": "openclaw-cortex-memory" },
    "entries": {
      "openclaw-cortex-memory": {
        "enabled": true,
        "config": {
          "engineMode": "ts",
          "autoSync": true,
          "autoReflect": false,
          "autoReflectIntervalMinutes": 30,
          "readFusion": {
            "enabled": true,
            "authoritative": true
          },
          "memoryDecay": {
            "enabled": true,
            "antiDecay": {
              "enabled": true
            }
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

关键功能开关（建议显式配置）：

- `readFusion.enabled`：开启多路召回后的 LLM 融合
- `readFusion.authoritative`：仅返回融合后的权威记忆包
- `memoryDecay.enabled`：开启按事件类型的半衰期衰减
- `memoryDecay.antiDecay.enabled`：开启命中频次反衰减
- `autoReflect`：建议验证稳定后再开启（默认 false）

### 启动

```bash
openclaw config validate
openclaw gateway restart
```

### 主Agent注入说明

首次接入后，建议把下面这段发给主 Agent，确保其按统一记忆工作流调用工具：

```text
你已接入 Cortex Memory。请遵循以下规则：
1) 当用户询问历史对话、偏好、项目上下文时，先调用 search_memory 再回答。
2) 需要当前会话热上下文时调用 get_hot_context。
3) 需要自动召回相关记忆时调用 get_auto_context。
4) 在一件重要事情结束并形成明确结果后，再调用 store_event 记录（不要在过程进行中频繁记录）。
5) 需要实体关联关系时调用 query_graph。
6) 当任务经历“失败→调整→最终成功”时，优先用 store_event 记录失败原因与成功方案，再调用 reflect_memory 沉淀可复用规则。
7) 需要导入历史会话时调用 sync_memory。
8) 当 diagnostics 显示 active/archive 存在未向量化记录，或迁移后需要重建向量层时，调用 backfill_embeddings（按需选择 incremental/vector_only/full）。
9) 出现配置校验失败、记忆读写异常、检索结果异常或数据目录问题时，优先调用 diagnostics。
10) 同一任务内不要反复调用 store_event 或 reflect_memory；仅在关键节点或任务收尾时触发一次。
11) 不要臆造历史事实；无法确认时必须先检索。
```

## 可用工具

### search_memory

语义搜索长期记忆。

**参数：**
| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| query | string | 是 | 搜索查询 |
| top_k | number | 否 | 返回数量，默认 3 |

### store_event

写入事件摘要到归档记忆。

**参数：**
| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| summary | string | 是 | 事件摘要 |
| entities | array | 否 | 相关实体列表 |
| outcome | string | 否 | 事件结果 |
| relations | array | 否 | 实体关系 |

### query_graph

查询归档事件中的实体关系（relations 优先，共现关系回退）。

**参数：**
| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| entity | string | 是 | 实体名称 |
| rel | string | 否 | 关系类型过滤（如 `depends_on`） |
| dir | string | 否 | 方向过滤：`incoming` / `outgoing` / `both` |
| path_to | string | 否 | 查询从 `entity` 到目标实体的路径 |
| max_depth | number | 否 | 路径最大深度（2~4） |

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

将归档事件反思为规则并写入 `CORTEX_RULES.md`。

### sync_memory

增量同步会话记录，且必须经 LLM 提取判定后才写入事件/图谱记忆（无参数）。

### backfill_embeddings

按层回填或重建向量，支持全文分块向量重建。

**参数：**
| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| layer | string | 否 | `active` / `archive` / `all` |
| batch_size | number | 否 | 每批处理数量 |
| max_retries | number | 否 | 失败重试上限 |
| retry_failed_only | boolean | 否 | 仅处理失败记录 |
| rebuild_mode | string | 否 | `incremental` / `vector_only` / `full` |

### delete_memory

删除指定记忆。

**参数：**
| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| memory_id | string | 是 | 记忆 ID |

### diagnostics

运行本地系统诊断，检查数据目录、分层状态与 embedding/LLM/reranker 连通性。

## 配置选项

| 选项 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| embedding.provider | 是 | - | `api`（推荐） |
| embedding.model | 是 | - | Embedding 模型名称 |
| embedding.apiKey | 是 | ${EMBEDDING_API_KEY} | Embedding API Key |
| embedding.baseURL | 是 | - | Embedding API 端点 |
| llm.provider | 是 | - | `api`（推荐） |
| llm.model | 是 | - | LLM 模型名称 |
| llm.apiKey | 是 | ${LLM_API_KEY} | LLM API Key |
| llm.baseURL | 是 | - | LLM API 端点 |
| reranker.provider | 否 | - | `api`（推荐） |
| reranker.model | 是 | - | Reranker 模型 |
| reranker.apiKey | 是 | ${RERANKER_API_KEY} | Reranker API Key |
| reranker.baseURL | 是 | - | Reranker API 端点 |
| dbPath | 否 | `<plugin-dir>/data/memory` | 记忆目录路径 |
| engineMode | 否 | `ts` | 固定为 TS 引擎 |
| autoSync | 否 | true | 会话结束自动同步 |
| autoReflect | 否 | false | 自动触发反思 |
| autoReflectIntervalMinutes | 否 | 30 | 自动反思扫描间隔（分钟） |
| readFusion.enabled | 否 | true | 启用检索重排后的 LLM 融合 |
| readFusion.authoritative | 否 | true | 仅返回融合权威记忆包 |
| memoryDecay.enabled | 否 | true | 启用按事件类型半衰期衰减 |
| memoryDecay.antiDecay.enabled | 否 | true | 启用命中频次反衰减 |

## 数据文件

| 路径 | 说明 |
|------|------|
| `<dbPath>/MEMORY.md` | 记忆说明文件 |
| `<dbPath>/CORTEX_RULES.md` | 规则文件 |
| `<dbPath>/sessions/active/sessions.jsonl` | 活跃会话记忆 |
| `<dbPath>/sessions/archive/sessions.jsonl` | 归档事件 |
| `<dbPath>/vector/lancedb` | LanceDB 向量表（可用时） |
| `<dbPath>/vector/lancedb_events.jsonl` | 向量回退存储（LanceDB 不可用时） |
| `<dbPath>/.sync_state.json` | 同步增量状态 |
| `<dbPath>/.session_end_state.json` | session_end 幂等状态 |
| `<dbPath>/.rule_store_state.json` | 规则去重状态 |
| `<dbPath>/.dedup_index.json` | 三阶段去重索引 |
| `<dbPath>/.read_hit_stats.json` | 检索命中频次统计（反衰减） |
| `<dbPath>/graph/mutation_log.jsonl` | 图谱变更审计日志 |

## 错误处理

| 错误代码 | 说明 | 处理方式 |
|----------|------|----------|
| E203 | 重复记忆 | 相似度 > 0.95，已跳过 |
| E204 | 质量评分过低 | 信息密度不足，未存储 |

## 相关文件

- `index.ts` - 插件入口与工具注册
- `src/engine/ts_engine.ts` - TS 引擎实现
- `src/store/read_store.ts` - 读取能力
- `src/store/write_store.ts` - 写入能力

## 依赖

- Node.js >= 22
- EMBEDDING_API_KEY、LLM_API_KEY、RERANKER_API_KEY（或兼容 API 配置）
