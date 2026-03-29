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
        "env": ["EMBEDDING_API_KEY", "LLM_API_KEY", "RERANKER_API_KEY"]
      },
      "primaryEnv": "EMBEDDING_API_KEY"
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

快速安装（推荐，显式来源）：

```bash
cd ~/openclaw
pnpm openclaw plugins install clawhub:openclaw-cortex-memory
pnpm openclaw plugins enable openclaw-cortex-memory
pnpm openclaw gateway restart
```

npm 安装方式：

```bash
cd ~/openclaw
pnpm openclaw plugins install openclaw-cortex-memory@alpha
pnpm openclaw plugins enable openclaw-cortex-memory
pnpm openclaw gateway restart
```

第三种安装方式（当 ClawHub/npm 解析受网络影响时）：

```bash
curl -L -o /tmp/cortex.tgz https://registry.npmjs.org/openclaw-cortex-memory/-/openclaw-cortex-memory-0.1.0-Alpha.8.tgz
cd ~/openclaw
pnpm openclaw plugins install /tmp/cortex.tgz
pnpm openclaw plugins enable openclaw-cortex-memory
pnpm openclaw gateway restart
rm -f /tmp/cortex.tgz
```

### 后续更新

```bash
cd ~/openclaw
pnpm openclaw plugins uninstall openclaw-cortex-memory
pnpm openclaw plugins install clawhub:openclaw-cortex-memory
pnpm openclaw plugins enable openclaw-cortex-memory
pnpm openclaw gateway restart
```

说明：
- 推荐显式安装来源，减少 ClawHub-first 时代的来源歧义。
- 使用 `plugins install` 的安装记录方式，避免 `loaded without install/load-path provenance`。
- 保持 `plugins.allow` 显式包含 `openclaw-cortex-memory`，避免运行时把插件判定为未绑定信任源。
- 若 `plugins install openclaw-cortex-memory` 在 ClawHub 解析阶段失败，可使用上述 tgz 方式直接安装。

### 本地打包安装（源码模式）

```bash
git clone https://github.com/deki18/openclaw-cortex-memory.git ~/openclaw-cortex-memory-src
cd ~/openclaw-cortex-memory-src
npm install && npm run build && npm pack
cd ~/openclaw
pnpm openclaw plugins install ~/openclaw-cortex-memory-src/openclaw-cortex-memory-0.1.0-Alpha.8.tgz
pnpm openclaw gateway restart
```

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
          "dbPath": "<optional-memory-dir>",
          "autoSync": true,
          "autoReflect": false,
          "autoReflectIntervalMinutes": 30,
          "readFusion": {
            "enabled": true,
            "maxCandidates": 10,
            "authoritative": true
          },
          "memoryDecay": {
            "enabled": true,
            "minFloor": 0.15,
            "defaultHalfLifeDays": 90,
            "halfLifeByEventType": {
              "issue": 30,
              "fix": 30,
              "action_item": 30,
              "decision": 120,
              "preference": 240,
              "constraint": 240,
              "requirement": 240
            },
            "antiDecay": {
              "enabled": true,
              "maxBoost": 1.6,
              "hitWeight": 0.08,
              "recentWindowDays": 30
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

首次接入后，建议把下面这段发给主 Agent，确保它会主动使用记忆工具：

```text
你已接入 Cortex Memory。请遵循以下规则：
1) 当用户询问历史对话、偏好、项目上下文时，先调用 search_memory 再回答。
2) 需要当前会话热上下文时调用 get_hot_context。
3) 需要自动召回相关记忆时调用 get_auto_context。
4) 在一件重要事情结束并形成明确结果后，再调用 store_event 记录（不要在过程进行中频繁记录）。
5) 需要实体关联关系时调用 query_graph。
6) 当任务经历“失败→调整→最终成功”时，优先用 store_event 记录失败原因与成功方案，再调用 reflect_memory 沉淀可复用规则。
7) 需要导入历史会话时调用 sync_memory。
8) 出现配置校验失败、记忆读写异常、检索结果异常或数据目录问题时，优先调用 diagnostics。
9) 同一任务内不要反复调用 store_event 或 reflect_memory；仅在关键节点或任务收尾时触发一次。
10) 不要臆造历史事实；无法确认时必须先检索。
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
| readFusion.maxCandidates | 否 | 10 | 融合候选上限 |
| readFusion.authoritative | 否 | true | 仅返回融合权威记忆包 |
| memoryDecay.enabled | 否 | true | 启用按事件类型半衰期衰减 |
| memoryDecay.minFloor | 否 | 0.15 | 衰减系数下限 |
| memoryDecay.defaultHalfLifeDays | 否 | 90 | 未配置类型默认半衰期（天） |
| memoryDecay.halfLifeByEventType | 否 | - | 各事件类型半衰期覆盖配置 |
| memoryDecay.antiDecay.enabled | 否 | true | 启用命中频次反衰减 |
| memoryDecay.antiDecay.maxBoost | 否 | 1.6 | 反衰减最大增益 |
| memoryDecay.antiDecay.hitWeight | 否 | 0.08 | 命中次数增益系数 |
| memoryDecay.antiDecay.recentWindowDays | 否 | 30 | 命中新鲜度窗口（天） |

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
