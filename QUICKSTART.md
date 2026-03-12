# OpenClaw Cortex Memory - Quick Start

## 安装

```bash
cd /path/to/your/openclaw/workspace
git clone https://github.com/deki18/openclaw-cortex-memory.git plugins/openclaw-cortex-memory
cd plugins/openclaw-cortex-memory/plugin
npm install
```

`npm install` 会自动完成：
- 创建 Python 虚拟环境
- 安装 Python 依赖
- 构建 TypeScript 插件

## 配置

在 `openclaw.json` 中添加插件配置：

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
            "apiKey": "${OPENAI_API_KEY}"
          },
          "llm": {
            "provider": "openai",
            "model": "gpt-4"
          },
          "reranker": {
            "provider": "siliconflow",
            "model": "BAAI/bge-reranker-v2-m3",
            "apiKey": "${SILICONFLOW_API_KEY}",
            "endpoint": "https://api.siliconflow.cn/v1/rerank"
          },
          "dbPath": "~/.openclaw/agents/main/lancedb_store",
          "autoSync": true,
          "autoReflect": false
        }
      }
    }
  }
}
```

### 配置说明

| 配置项 | 必填 | 说明 |
|--------|------|------|
| `embedding.provider` | 是 | Embedding 提供商：`openai`, `openai-compatible`, `jina` |
| `embedding.model` | 是 | Embedding 模型名称 |
| `embedding.apiKey` | 否 | Embedding API Key，默认从 OpenClaw 主配置读取 |
| `embedding.baseURL` | 否 | 自定义 API 端点，默认从 OpenClaw 主配置读取 |
| `llm.provider` | 是 | LLM 提供商：`openai`, `anthropic`, `azure` 等 |
| `llm.model` | 是 | LLM 模型名称 |
| `reranker.provider` | 否 | Reranker 提供商 |
| `reranker.model` | 是 | Reranker 模型名称 |
| `reranker.apiKey` | 否 | Reranker API Key，默认从 OpenClaw 主配置读取 |
| `reranker.endpoint` | 否 | Reranker API 端点，默认从 OpenClaw 主配置读取 |
| `dbPath` | 否 | LanceDB 存储路径 |
| `autoSync` | 否 | 会话结束时自动同步，默认 `true` |
| `autoReflect` | 否 | 自动触发反思，默认 `false` |

## 启动

```bash
openclaw config validate
openclaw gateway restart
```

Python 服务会在插件加载时自动启动。

---

## 完整流程

```bash
# 1. 克隆插件
cd %USERPROFILE%\.openclaw\workspace
git clone https://github.com/deki18/openclaw-cortex-memory.git plugins/openclaw-cortex-memory

# 2. 安装（自动处理 Python 环境）
cd plugins/openclaw-cortex-memory/plugin
npm install

# 3. 编辑 openclaw.json 添加配置
notepad %USERPROFILE%\.openclaw\openclaw.json

# 4. 验证配置并重启
openclaw config validate
openclaw gateway restart
```

---

## 资源消耗

- **内存**：约 200-500 MB（Python 基础 + LanceDB + 模型缓存）
- **CPU**：空闲时接近 0%，搜索时根据数据量波动
- **磁盘**：记忆文件默认存放在 `~/.openclaw/agents/main/lancedb_store`

## 文件位置

| 类型 | 默认位置 |
|------|---------|
| 插件安装目录 | `~/.openclaw/workspace/plugins/openclaw-cortex-memory/` |
| LanceDB 数据 | `~/.openclaw/agents/main/lancedb_store/` |
| 记忆规则 | `~/.openclaw/workspace/procedures/` |
| 事件记忆 | `~/.openclaw/episodic_memory.jsonl` |
| 记忆图谱 | `~/.openclaw/memory_graph.json` |
