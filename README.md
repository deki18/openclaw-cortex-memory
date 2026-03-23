# OpenClaw Cortex Memory

OpenClaw 长期记忆插件（纯 TypeScript 实现），提供跨会话检索、事件存储、规则反思与增量同步能力。

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

```bash
cd <plugin-dir>
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
          "autoReflect": false,
          "embedding": {
            "provider": "openai-compatible",
            "model": "text-embedding-3-large",
            "dimensions": 3072
          },
          "llm": {
            "provider": "openai",
            "model": "gpt-4"
          },
          "reranker": {
            "provider": "siliconflow",
            "model": "BAAI/bge-reranker-v2-m3"
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
| `embedding.provider` | 是 | 嵌入模型提供商：`openai`、`openai-compatible`、`ollama` |
| `embedding.model` | 是 | 嵌入模型名称 |
| `embedding.dimensions` | 否 | 向量维度，需与模型匹配 |
| `llm.provider` | 是 | LLM 提供商，用于记忆提取和反思 |
| `llm.model` | 是 | LLM 模型名称 |
| `reranker` | 否 | 重排序模型配置，推荐配置以提升检索精度 |
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
