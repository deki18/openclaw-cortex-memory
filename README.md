# OpenClaw Cortex Memory

OpenClaw 长期记忆插件 - 专为 OpenClaw AI 助手设计的智能记忆系统

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js: 22+](https://img.shields.io/badge/Node.js-22+-green.svg)](https://nodejs.org/)
[![OpenClaw: Plugin](https://img.shields.io/badge/OpenClaw-Plugin-orange.svg)](https://github.com/openclaw)

面向 OpenClaw 的长期记忆插件，集成多路检索、事件归档、图谱关系、向量化与反衰减排序，支持历史增量导入、规则反思和可观测诊断，帮助 Agent 在跨会话中持续积累并稳定调用高价值记忆。

---

## ✨ 特性

### 🔍 语义检索
- **多路召回**: 关键词/BM25 + 向量召回统一融合重排
- **智能排序**: 支持长度归一化防止长文本天然占优
- **反衰减机制**: 命中频次反衰减，避免高价值老记忆被过度遗忘

### 📝 事件存储
- **分层记忆**: 原始会话、结构化事件、抽象规则拆分存储
- **全文分块向量化**: Active 与 Archive 统一按 `chunk_size/chunk_overlap` 做全文分块向量化
- **增量同步**: 按状态文件增量导入，避免全量重复扫描

### 🕸️ 图谱关系
- **实体关系层**: 基于归档事件中的 `entities` / `relations` 字段动态构图
- **图谱治理**: 写入前按 `schema/graph.schema.yaml` 做规范化与关系规则校验
- **关系查询**: 支撑 `query_graph` 的实体共现与关系查询

### ⚙️ 规则演进
- **自动反思**: `reflect_memory` 自动将事件转化为规则
- **规则去重**: 对规则写入做签名判重，减少重复沉淀
- **可复用规则**: 存储于 `CORTEX_RULES.md` 供后续任务复用

### 🔧 运维诊断
- **系统诊断**: `diagnostics` 检查本地存储状态与 API 连通性
- **向量回填**: `backfill_embeddings` 支持 incremental / vector_only / full 三种模式重建向量层
- **可观测性**: 通过状态文件快速定位数据目录、同步与反思异常

---

## 🚀 快速开始

### 前置要求

- Node.js 22+
- OpenAI API Key（或其他兼容 API）

### 安装

**快速安装（推荐）:**

```bash
cd ~/openclaw
openclaw plugins install clawhub:openclaw-cortex-memory
openclaw plugins enable openclaw-cortex-memory
```

**npm 安装方式:**

```bash
cd ~/openclaw
openclaw plugins install openclaw-cortex-memory@alpha
openclaw plugins enable openclaw-cortex-memory
```
**本地包安装方式（当 ClawHub/npm 解析受网络影响时）:**

```bash
curl -L -o /tmp/cortex.tgz https://registry.npmjs.org/openclaw-cortex-memory/-/openclaw-cortex-memory-0.1.0-Alpha.13.tgz
cd ~/openclaw
openclaw plugins install /tmp/cortex.tgz
openclaw plugins enable openclaw-cortex-memory
rm -f /tmp/cortex.tgz
```

**本地开发模式:**

```bash
cd ~/.openclaw/extensions
git clone https://github.com/deki18/openclaw-cortex-memory.git
cd openclaw-cortex-memory
npm install && npm run build
```

### 配置

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

### 启动

```bash
openclaw config validate
openclaw gateway restart
```

---

## 🛠️ 可用工具

| 工具 | 说明 |
|------|------|
| `search_memory` | 语义搜索记忆库，支持 query + top_k |
| `store_event` | 存储事件，可包含实体和关系 |
| `query_graph` | 查询实体关系图谱，支持关系过滤、方向过滤与路径查询 |
| `get_hot_context` | 获取热上下文（CORTEX_RULES.md + 近期会话） |
| `get_auto_context` | 自动检索相关记忆 + 热上下文 |
| `reflect_memory` | 触发记忆反思，将事件转化为规则 |
| `sync_memory` | 同步 OpenClaw 历史会话（增量），并通过 LLM 判定后写入事件/图谱 |
| `backfill_embeddings` | 向量回填/重建（支持 `incremental`、`vector_only`、`full`） |
| `delete_memory` | 删除指定记忆 |
| `diagnostics` | 系统诊断（含 embedding/LLM/reranker 连通性检查） |

---

## 💻 CLI 命令

CLI 命令需在插件目录运行：

```bash
npx cortex-memory status              # 查看插件状态
npx cortex-memory enable              # 启用插件
npx cortex-memory disable             # 禁用插件（回退到内置记忆）
npx cortex-memory uninstall           # 卸载插件
npx cortex-memory uninstall --keep-data  # 卸载但保留数据
npx cortex-memory help                # 查看命令帮助
```

---

## 📁 数据存储结构

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
| `<dbPath>/graph/mutation_log.jsonl` | 图谱写入审计日志 |

---

## 📋 核心特点

- **分层记忆**: 把"原始会话、结构化事件、抽象规则"拆分存储，便于分别检索与治理
- **图谱派生**: 实体关系来自事件层的 `entities` / `relations`，查询时动态生成图结构
- **会话结束写入**: message hook 默认仅缓存，会在 `session_end` 后批量抽取并落盘
- **严格导入门禁**: 历史导入内容必须经 LLM 提取判定后才写入事件层与图谱层
- **三阶段去重**: SimHash 预过滤 → MinHash 精比对 → 向量余弦相似度
- **自动演进**: 可结合 `autoSync`、`autoReflect` 持续把会话经验转化为长期可复用记忆

---

## ⚠️ 注意事项

1. **API Key 安全**: 使用 `${EMBEDDING_API_KEY}`、`${LLM_API_KEY}`、`${RERANKER_API_KEY}` 等环境变量而非硬编码
2. **向量维度**: 必须与嵌入模型匹配，如 `text-embedding-3-large` 为 3072
3. **重排序**: 可选配置 `reranker` 以提升检索精度
4. **外部传输**: 检索与反思会调用你配置的 embedding/llm/reranker endpoint，请使用可信服务并最小化密钥权限
5. **会话数据**: 启用 `autoSync` 时会读取 OpenClaw 会话文件并写入本地记忆目录，生产环境建议先小范围验证

---

## 📄 许可证

MIT License

发布签名见 [SIGNATURE.md](SIGNATURE.md)
