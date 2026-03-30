# OpenClaw Cortex Memory

面向 OpenClaw 的长期记忆插件，集成多路检索、事件归档、图谱关系、向量化与反衰减排序，支持历史增量导入、规则反思和可观测诊断，帮助 Agent 在跨会话中持续积累并稳定调用高价值记忆。  

发布签名见 [SIGNATURE.md]

## 功能特性

| 特性 | 说明 |
|------|------|
| 语义检索 | `search_memory` 支持 query + top_k |
| 事件存储 | `store_event` 将摘要写入归档 |
| 全文分块向量化 | Active 与 Archive 统一按 `chunk_size/chunk_overlap` 做全文分块向量化 |
| 上下文注入 | `get_hot_context` / `get_auto_context` |
| 增量同步 | `sync_memory` 按状态文件增量导入，并统一走 LLM 提取后写入事件/图谱 |
| 向量回填重建 | `backfill_embeddings` 支持 incremental / vector_only / full 三种模式 |
| 规则演进 | `reflect_memory` 更新 `CORTEX_RULES.md` |
| 运行诊断 | `diagnostics` 检查本地存储状态 |

## 记忆库组成与特点

### 组成结构

| 层级 | 核心文件/数据 | 作用 |
|------|---------------|------|
| 会话记忆层 | `sessions/active/sessions.jsonl` | 存储最近会话消息，支撑实时检索与上下文注入 |
| 事件归档层 | `sessions/archive/sessions.jsonl` | 存储已沉淀事件（摘要、实体、结果），用于长期回顾 |
| 实体关系层 | 基于归档事件中的 `entities` / `relations` 字段动态构图 | 支撑 `query_graph` 的实体共现与关系查询（派生图谱，不单独落盘） |
| 向量检索层 | `vector/lancedb`（可用时）或 `vector/lancedb_events.jsonl`（回退） | 存储 active/archive 全文分块向量（含 `source_memory_id` 与 chunk 元信息），用于语义检索与同源融合 |
| 规则知识层 | `CORTEX_RULES.md` | 存储由反思生成的可复用规则，供后续任务复用 |
| 运行状态层 | `.sync_state.json` / `.session_end_state.json` / `.rule_store_state.json` / `.dedup_index.json` / `graph/mutation_log.jsonl` | 记录增量同步、session_end 幂等、规则去重、三阶段去重索引、图谱变更审计日志 |
| 说明与入口层 | `MEMORY.md` | 记忆库说明与使用约定入口 |

### 核心特点

- 分层记忆：把“原始会话、结构化事件、抽象规则”拆分存储，便于分别检索与治理
- 图谱派生：实体关系来自事件层的 `entities` / `relations`，查询时动态生成图结构
- 图谱治理：写入前按 `schema/graph.schema.yaml` 做 event/relation 规范化与关系规则校验
- 会话结束写入：message hook 默认仅缓存，会在 `session_end` 后批量抽取并落盘
- 严格导入门禁：历史导入内容必须经 LLM 提取判定后才写入事件层与图谱层
- 增量导入：通过状态文件只处理新增会话内容，避免全量重复扫描
- 幂等去重：对 session_end 事件和规则写入做签名判重，减少重复沉淀
- 三阶段去重：SimHash 预过滤 → MinHash 精比对 → 向量余弦相似度
- 全文分块向量化：active/archive 两层统一使用可配置 chunk 策略（默认 `600/100`，语义断句优先）
- 混合检索：关键词/BM25 + 向量召回统一融合重排，并支持长度归一化防止长文本天然占优
- 自动演进：可结合 `autoSync`、`autoReflect` 持续把会话经验转化为长期可复用记忆
- 可观测可诊断：通过 `diagnostics` 与状态文件快速定位数据目录、同步与反思异常

## 安装

### 前置要求

- Node.js 22+
- OpenAI API Key（或其他兼容 API）

### 安装步骤

命令前缀说明：
- 若你是全局安装 OpenClaw，请直接使用 `openclaw ...`
- 若你使用源码安装的 OpenClaw ，请使用 `pnpm openclaw ...`

快速安装（推荐，显式来源）：

```bash
cd ~/openclaw
openclaw plugins install clawhub:openclaw-cortex-memory
openclaw plugins enable openclaw-cortex-memory
```

npm 安装方式：

```bash
cd ~/openclaw
openclaw plugins install openclaw-cortex-memory@alpha
openclaw plugins enable openclaw-cortex-memory
```

第三种安装方式（当 ClawHub/npm 解析受网络影响时）：

```bash
curl -L -o /tmp/cortex.tgz https://registry.npmjs.org/openclaw-cortex-memory/-/openclaw-cortex-memory-0.1.0-Alpha.10.tgz
cd ~/openclaw
openclaw plugins install /tmp/cortex.tgz
openclaw plugins enable openclaw-cortex-memory
rm -f /tmp/cortex.tgz
```

后续更新：

```bash
cd ~/openclaw
openclaw plugins uninstall openclaw-cortex-memory
openclaw plugins install clawhub:openclaw-cortex-memory
openclaw plugins enable openclaw-cortex-memory
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

`npm install` 不会自动构建 `dist/`，源码模式请显式执行 `npm run build`，且这种方式默认不写 OpenClaw 安装记录。

## 配置

在 `openclaw.json` 中添加：

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

### 关键功能开关（建议显式配置）

- `readFusion.enabled`：开启多路召回后 LLM 融合
- `readFusion.authoritative`：开启后仅返回融合后的权威记忆包
- `readFusion.channelWeights/channelTopK`：控制各召回通道权重与配额
- `readFusion.lengthNorm`：长度归一化参数，抑制超长文本得分偏置
- `vectorChunking.chunkSize/chunkOverlap`：全文分块向量化参数（默认 `600/100`）
- `memoryDecay.enabled`：开启按 `event_type` 半衰期衰减
- `memoryDecay.antiDecay.enabled`：开启命中频次反衰减，避免高价值老记忆被过度衰减
- `autoReflect`：建议在验证稳定后再开启；默认 `false`

### 配置项说明

| 配置项 | 必填 | 说明 |
|--------|------|------|
| `embedding.provider` | 是 | 建议使用 `api`（统一第三方接口模式） |
| `embedding.model` | 是 | 嵌入模型名称 |
| `embedding.apiKey` | 是 | Embedding API Key（建议 `${EMBEDDING_API_KEY}`） |
| `embedding.baseURL` | 是 | Embedding API 端点 |
| `llm.provider` | 是 | 建议使用 `api` |
| `llm.model` | 是 | LLM 模型名称 |
| `llm.apiKey` | 是 | LLM API Key（建议 `${LLM_API_KEY}`） |
| `llm.baseURL` | 是 | LLM API 端点 |
| `reranker.provider` | 否 | 建议使用 `api` |
| `reranker.model` | 是 | Reranker 模型名称 |
| `reranker.apiKey` | 是 | Reranker API Key（建议 `${RERANKER_API_KEY}`） |
| `reranker.baseURL` | 是 | Reranker API 端点 |
| `engineMode` | 否 | 固定 `ts` |
| `dbPath` | 否 | 数据目录，默认 `<plugin-dir>/data/memory` |
| `autoSync` | 否 | 会话结束时自动同步历史记录，默认 `true` |
| `autoReflect` | 否 | 自动触发记忆反思，默认 `false` |
| `autoReflectIntervalMinutes` | 否 | 自动反思扫描间隔（分钟），默认 `30`，最小 `5` |
| `readFusion.enabled` | 否 | 启用重排后 LLM 融合，默认 `true` |
| `readFusion.authoritative` | 否 | 仅返回融合权威记忆包，默认 `true` |
| `memoryDecay.enabled` | 否 | 启用按 `event_type` 的半衰期衰减，默认 `true` |
| `memoryDecay.antiDecay.enabled` | 否 | 启用命中频次反衰减，默认 `true` |

### 启动

```bash
openclaw config validate
openclaw gateway restart
```

### 主 Agent 注入说明

首次接入后，建议把下面这段发给主 Agent，确保其按记忆工作流执行：

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

| 工具 | 说明 |
|------|------|
| `search_memory` | 语义搜索记忆库，支持 top_k 参数 |
| `store_event` | 存储事件，可包含实体和关系 |
| `query_graph` | 查询实体关系图谱，支持关系过滤、方向过滤与路径查询 |
| `get_hot_context` | 获取热上下文（CORTEX_RULES.md + 近期会话） |
| `get_auto_context` | 自动检索相关记忆 + 热上下文 |
| `reflect_memory` | 触发记忆反思，将事件转化为规则 |
| `sync_memory` | 同步 OpenClaw 历史会话（增量），并通过 LLM 判定后写入事件/图谱 |
| `backfill_embeddings` | 向量回填/重建（支持 `incremental`、`vector_only`、`full`） |
| `delete_memory` | 删除指定记忆 |
| `diagnostics` | 系统诊断（含 embedding/LLM/reranker 连通性检查） |

## CLI 命令

CLI 命令需在插件目录运行：

```bash
npx cortex-memory status              # 查看插件状态
npx cortex-memory enable              # 启用插件
npx cortex-memory disable             # 禁用插件（回退到内置记忆）
npx cortex-memory uninstall           # 卸载插件
npx cortex-memory uninstall --keep-data  # 卸载但保留数据
npx cortex-memory help                # 查看命令帮助
```

## 数据存储

| 路径 | 说明 |
|------|------|
| `<dbPath>/MEMORY.md` | 记忆说明 |
| `<dbPath>/CORTEX_RULES.md` | 规则文件 |
| `<dbPath>/sessions/active/sessions.jsonl` | 活跃会话 |
| `<dbPath>/sessions/archive/sessions.jsonl` | 归档事件 |
| `<dbPath>/vector/lancedb` | LanceDB 向量表（可用时） |
| `<dbPath>/vector/lancedb_events.jsonl` | 向量回退存储（LanceDB不可用时） |
| `<dbPath>/.sync_state.json` | 同步增量状态 |
| `<dbPath>/.session_end_state.json` | session_end 幂等状态 |
| `<dbPath>/.rule_store_state.json` | 规则去重状态 |
| `<dbPath>/.dedup_index.json` | 三阶段去重索引 |
| `<dbPath>/.read_hit_stats.json` | 检索命中频次统计（用于反衰减增益） |
| `<dbPath>/graph/mutation_log.jsonl` | 图谱写入审计日志（canonical_id/source_event_id/actor/timestamp） |

## 注意事项

1. **API Key 安全**：使用 `${EMBEDDING_API_KEY}`、`${LLM_API_KEY}`、`${RERANKER_API_KEY}` 等环境变量而非硬编码
2. **向量维度**：必须与嵌入模型匹配，如 `text-embedding-3-large` 为 3072
3. **重排序**：可选配置 `reranker` 以提升检索精度
4. **外部传输**：检索与反思会调用你配置的 embedding/llm/reranker endpoint，请使用可信服务并最小化密钥权限
5. **会话数据**：启用 `autoSync` 时会读取 OpenClaw 会话文件并写入本地记忆目录，生产环境建议先小范围验证
6. **历史导入来源**：`sync_memory` 会同时导入 `<openclaw_base>/agents/main/sessions/*.jsonl` 与 `<openclaw_base>/workspace/memory/*.md`
7. **重复导入防护**：每日总结 `.md` 会按文件内容哈希标记在 `.sync_state.json`，未变化文件不会重复导入

## 许可证

MIT License
