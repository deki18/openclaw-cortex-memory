# OpenClaw Cortex Memory

OpenClaw 长期记忆插件，提供语义搜索、事件追踪、知识图谱和规则管理功能。

## 功能特性

| 特性 | 说明 |
|------|------|
| 语义记忆 | 基于 LanceDB 的向量检索，支持混合搜索（向量+BM25）和重排序 |
| 情景记忆 | 事件时间线追踪，记录里程碑和重要节点，支持实体和关系 |
| 知识图谱 | 实体关系网络，支持关系查询、邻接遍历和关系链提取 |
| 规则记忆 | CORTEX_RULES.md 存储核心规则，通过反思和晋升机制自动更新 |
| 热上下文 | 当前会话上下文 + 近期数据实时注入，优先级最高 |
| 记忆生命周期 | 自动衰减（半衰期30天）、反思、晋升机制，确保记忆质量 |

## 安装

### 前置要求

- Python 3.10+
- Node.js 22+
- OpenAI API Key（或其他兼容 API）

### 安装步骤

```bash
cd ~/.openclaw/plugins
git clone https://github.com/deki18/openclaw-cortex-memory.git
cd openclaw-cortex-memory/plugin
npm install
```

`npm install` 会自动创建 Python 虚拟环境并安装依赖。

## 配置

在 `~/.openclaw/openclaw.json` 中添加：

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
          "autoSync": true,
          "autoReflect": false
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
| `embedding.dimensions` | 是 | 向量维度，需与模型匹配 |
| `llm.provider` | 是 | LLM 提供商，用于记忆提取和反思 |
| `llm.model` | 是 | LLM 模型名称 |
| `reranker` | 否 | 重排序模型配置，推荐配置以提升检索精度 |
| `autoSync` | 否 | 会话结束时自动同步历史记录，默认 `true` |
| `autoReflect` | 否 | 自动触发记忆反思，默认 `false` |

### 启动

```bash
openclaw config validate
openclaw gateway restart
```

Python 后端服务会在插件加载时自动启动。

## 数据迁移

首次安装后，可从 OpenClaw 原有记忆文件导入历史数据。

### 导入数据源

| 来源路径 | 说明 |
|----------|------|
| `~/.openclaw/workspace/memory/*.md` | 每日总结文件 |
| `~/.openclaw/agents/main/sessions/*.jsonl` | 会话记录 |

### 导入方式

**方式一：CLI 命令**

```bash
cortex-memory import --path ~/.openclaw
```

**方式二：工具调用**

在对话中让 Agent 调用 `sync_memory` 工具：

```
请帮我同步历史会话数据到记忆系统
```

导入过程为增量处理，已导入的数据不会重复处理。

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
| `promote_memory` | 晋升热记忆为规则 |
| `delete_memory` | 删除指定记忆 |
| `update_memory` | 更新记忆内容、类型或权重 |
| `cleanup_memories` | 清理指定天数前的记忆 |
| `diagnostics` | 系统诊断 |

## CLI 命令

```bash
cortex-memory status              # 查看插件状态
cortex-memory enable              # 启用插件
cortex-memory disable             # 禁用插件（回退到内置记忆）
cortex-memory uninstall           # 卸载插件
cortex-memory uninstall --keep-data  # 卸载但保留数据
cortex-memory config --validate   # 验证配置
cortex-memory import --path PATH  # 导入历史数据
cortex-memory doctor              # 系统诊断
```

## 数据存储

| 路径 | 说明 |
|------|------|
| `~/.openclaw/workspace/cortex_memory/` | 记忆数据库（LanceDB） |
| `~/.openclaw/workspace/cortex_memory/episodic.jsonl` | 情景记忆 |
| `~/.openclaw/workspace/cortex_memory/graph.json` | 知识图谱 |
| `~/.openclaw/workspace/CORTEX_RULES.md` | 核心规则文件 |

## 记忆写入触发

| 触发方式 | 说明 |
|----------|------|
| 消息钩子 | 用户消息自动触发实时写入（需插件启用） |
| 会话结束 | 批量处理会话记录和每日总结 |
| 工具调用 | `store_event`、`sync_memory` 手动触发 |

## 注意事项

1. **API Key 安全**：使用环境变量 `${OPENAI_API_KEY}` 而非硬编码
2. **向量维度**：必须与嵌入模型匹配，如 `text-embedding-3-large` 为 3072
3. **重排序**：推荐配置 reranker 以提升检索精度
4. **热插拔**：支持启用/禁用插件而无需重启 OpenClaw
5. **数据迁移**：卸载时使用 `--keep-data` 保留记忆数据
6. **首次使用**：安装后运行 `cortex-memory import` 导入历史数据

## 许可证

MIT License
