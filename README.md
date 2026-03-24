# OpenClaw Cortex Memory

OpenClaw 长期记忆插件，提供跨会话检索、事件存储、规则反思、增量同步与运行诊断能力。  
可作为 OpenClaw 的 memory slot 直接接入，支持从历史会话持续沉淀可复用记忆。

## 功能特性

| 特性 | 说明 |
|------|------|
| 语义检索 | `search_memory` 支持 query + top_k |
| 事件存储 | `store_event` 将摘要写入归档 |
| 上下文注入 | `get_hot_context` / `get_auto_context` |
| 增量同步 | `sync_memory` 按状态文件增量导入 |
| 规则演进 | `reflect_memory` 更新 `CORTEX_RULES.md` |
| 运行诊断 | `diagnostics` 检查本地存储状态 |

## 安装

### 前置要求

- Node.js 22+
- OpenAI API Key（或其他兼容 API）

### 安装步骤

首次安装（从 Git 克隆）：

```bash
cd ~/.openclaw/extensions
git clone https://github.com/deki18/openclaw-cortex-memory.git
cd openclaw-cortex-memory
npm install
```

`npm install` 会自动执行 TypeScript 构建并生成 `dist/`。

## 配置

在 `openclaw.json` 中添加：

```json
{
  "plugins": {
    "slots": { "memory": "openclaw-cortex-memory" },
    "entries": {
      "openclaw-cortex-memory": {
        "enabled": true,
        "config": {
          "engineMode": "ts",
          "dbPath": "<optional-memory-dir>",
          "autoSync": true,
          "autoReflect": true,
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

### 配置项说明

| 配置项 | 必填 | 说明 |
|--------|------|------|
| `embedding.provider` | 是 | 建议使用 `api`（统一第三方接口模式） |
| `embedding.model` | 是 | 嵌入模型名称 |
| `embedding.dimensions` | 否 | 向量维度，需与模型匹配 |
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

### 启动

```bash
openclaw config validate
openclaw gateway restart
```

## 可用工具

| 工具 | 说明 |
|------|------|
| `search_memory` | 语义搜索记忆库，支持 top_k 参数 |
| `store_event` | 存储事件，可包含实体和关系 |
| `query_graph` | 查询实体关系图谱 |
| `get_hot_context` | 获取热上下文（CORTEX_RULES.md + 近期会话） |
| `get_auto_context` | 自动检索相关记忆 + 热上下文 |
| `reflect_memory` | 触发记忆反思，将事件转化为规则 |
| `sync_memory` | 同步 OpenClaw 历史会话（增量） |
| `delete_memory` | 删除指定记忆 |
| `diagnostics` | 系统诊断 |

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
| `<dbPath>/.sync_state.json` | 同步增量状态 |
| `<dbPath>/.session_end_state.json` | session_end 幂等状态 |
| `<dbPath>/.rule_store_state.json` | 规则去重状态 |

## 注意事项

1. **API Key 安全**：使用环境变量 `${OPENAI_API_KEY}` 而非硬编码
2. **向量维度**：必须与嵌入模型匹配，如 `text-embedding-3-large` 为 3072
3. **重排序**：可选配置 `reranker` 以提升检索精度
4. **单栈运行**：当前版本为纯 TS，无 Python 运行时依赖

## 许可证

MIT License
