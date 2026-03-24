---
name: cortex-memory
description: 长期记忆系统（纯 TypeScript）。Use when user asks about past conversations, preferences, project history, or needs to remember information across sessions.
homepage: https://github.com/deki18/openclaw-cortex-memory
metadata:
  {
    "openclaw": {
      "emoji": "🧠",
      "os": ["darwin", "linux", "win32"],
      "requires": {
        "env": ["OPENAI_API_KEY"]
      },
      "primaryEnv": "OPENAI_API_KEY"
    }
  }
---

# Cortex Memory - 长期记忆系统

为 OpenClaw Agent 提供持久化记忆能力，当前为纯 TypeScript 单栈实现。

## 使用场景

**USE when:**
- 用户询问过去的对话内容或决策
- 需要记住用户偏好、项目信息
- 跨会话保持上下文
- 查询实体关系（人物、项目、技术）
- 存储重要事件或里程碑

**DON'T use when:**
- 仅需当前会话的临时信息
- 查询实时数据（天气、新闻等）

## 快速开始

### 安装

首次安装（从 Git 克隆）：

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

### 启动

```bash
openclaw config validate
openclaw gateway restart
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

查询归档事件中的实体共现关系。

**参数：**
| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| entity | string | 是 | 实体名称 |

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

增量同步会话记录到本地记忆（无参数）。

### delete_memory

删除指定记忆。

**参数：**
| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| memory_id | string | 是 | 记忆 ID |

### diagnostics

运行本地系统诊断，检查数据目录与基础状态。

## 配置选项

| 选项 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| embedding.provider | 是 | - | `api`（推荐） |
| embedding.model | 是 | - | Embedding 模型名称 |
| embedding.dimensions | 否 | 3072 | 向量维度 |
| embedding.apiKey | 否 | ${OPENAI_API_KEY} | API Key |
| embedding.baseURL | 否 | - | 自定义端点 |
| llm.provider | 是 | - | `api`（推荐） |
| llm.model | 是 | - | LLM 模型名称 |
| llm.apiKey | 否 | ${LLM_API_KEY} | LLM API Key |
| llm.baseURL | 否 | - | LLM API 端点 |
| reranker.provider | 否 | - | `api`（推荐） |
| reranker.model | 是 | - | Reranker 模型 |
| reranker.apiKey | 否 | ${RERANKER_API_KEY} | Reranker API Key |
| reranker.baseURL | 否 | - | Reranker API 端点 |
| dbPath | 否 | `<plugin-dir>/data/memory` | 记忆目录路径 |
| engineMode | 否 | `ts` | 固定为 TS 引擎 |
| autoSync | 否 | true | 会话结束自动同步 |
| autoReflect | 否 | false | 自动触发反思 |

## 数据文件

| 路径 | 说明 |
|------|------|
| `<dbPath>/MEMORY.md` | 记忆说明文件 |
| `<dbPath>/CORTEX_RULES.md` | 规则文件 |
| `<dbPath>/sessions/active/sessions.jsonl` | 活跃会话记忆 |
| `<dbPath>/sessions/archive/sessions.jsonl` | 归档事件 |
| `<dbPath>/.sync_state.json` | 同步增量状态 |
| `<dbPath>/.session_end_state.json` | session_end 幂等状态 |
| `<dbPath>/.rule_store_state.json` | 规则去重状态 |

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
- OPENAI_API_KEY（或兼容 API 配置）
