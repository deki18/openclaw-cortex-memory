# 🚀 OpenClaw Cortex Memory

## Agent级长期记忆系统开发文档（最终完整版）

------------------------------------------------------------------------

# 1 项目目标

OpenClaw Cortex Memory 是一个为 **AI Agent 设计的长期记忆系统插件**。

它解决传统 RAG 的三大问题：

  问题         传统RAG
  ------------ --------------------
  上下文膨胀   所有历史塞进Prompt
  知识丢失     旧信息无法检索
  长期学习     没有

Cortex Memory 的目标：

-   构建 **可持续学习的 AI Agent**
-   提供 **长期记忆能力**
-   将 Token 消耗降低 **90%+**

------------------------------------------------------------------------

# 2 核心设计理念

系统模拟 **人类记忆结构**。

AI记忆被分为：

  类型                说明
  ------------------- ------------
  Hot Memory          当前上下文
  Semantic Memory     知识记忆
  Episodic Memory     事件记忆
  Procedural Memory   规则与技能

系统结构：

LLM Agent\
↓\
Memory Controller\
↓\
Hot Memory / Semantic Memory / Episodic Memory / Procedural Memory

------------------------------------------------------------------------

# 3 记忆层级架构

## 3.1 Hot Memory（热记忆）

用于 **当前会话上下文**。

内容：

-   SOUL.md\
-   当前对话

特点：

-   永远加载
-   不进入向量库
-   Token最优先

------------------------------------------------------------------------

## 3.2 Semantic Memory（知识记忆）

存储：

-   技术经验
-   配置规则
-   长期知识

示例：

Cursor + Claude 是目前最适合 AI IDE 的组合

存储结构：

ChromaDB + BM25 + Reranker

------------------------------------------------------------------------

## 3.3 Episodic Memory（事件记忆）

记录 **Agent经历过的事件**。

示例：

2026-03-12\
Joe配置Cloudflare Nameserver失败\
原因：CloudNS配置错误\
解决：重新设置NS

特点：

-   时间维度
-   可追溯
-   可反思总结

------------------------------------------------------------------------

## 3.4 Procedural Memory（规则记忆）

存储 **Agent行为策略**。

例如：

Debug流程：\
1 搜索memory\
2 搜索docs\
3 调用web

存储位置：

-   MEMORY.md\
-   procedures/\*.yaml

------------------------------------------------------------------------

# 4 技术栈选型

## 向量数据库

ChromaDB

原因：

-   轻量
-   本地
-   Metadata过滤

------------------------------------------------------------------------

## Embedding模型

text-embedding-3-large

特点：

-   3072维
-   高语义质量

------------------------------------------------------------------------

## BM25

rank_bm25

解决关键词检索问题，例如：

-   N100
-   40014
-   UUID

------------------------------------------------------------------------

## Reranker

推荐：

BAAI/bge-reranker-v2-m3

API：

-   SiliconFlow
-   Jina

------------------------------------------------------------------------

## Memory Graph

可选：

-   networkx（轻量）
-   Neo4j（大型系统）

------------------------------------------------------------------------

# 5 项目目录结构

openclaw-cortex-memory

memory_engine\
config.py\
metadata_schema.py

embedding.py\
reranker.py

vector_store.py\
bm25_store.py

semantic_memory.py\
episodic_memory.py\
procedural_memory.py

memory_graph.py\
memory_controller.py

retrieval_pipeline.py\
write_pipeline.py\
promotion_engine.py

reflection_engine.py

tools\
search_memory.py\
read_cold_archive.py\
store_event.py\
query_graph.py

cli\
memory_cli.py

data\
memory\
SOUL.md\
MEMORY.md\
today.md

daily-summary

sessions\
active\
archive

vector_store

------------------------------------------------------------------------

# 6 配置文件示例

MEMORY_PRO_ENABLED=true

VECTOR_DB_PATH=\~/.openclaw/vector_store

EMBEDDING_MODEL=text-embedding-3-large

RERANKER_API_URL=https://api.siliconflow.cn/v1/rerank\
RERANKER_MODEL=BAAI/bge-reranker-v2-m3

TIME_DECAY_HALFLIFE=30

CHUNK_SIZE=600\
CHUNK_OVERLAP=100

PROMOTION_HIT_THRESHOLD=3

------------------------------------------------------------------------

# 7 Metadata Schema

示例：

{ "type": "daily_log", "date": "2026-03-12", "agent": "openclaw_main",
"source_file": "archive/session-2026-03-12.jsonl", "hit_count": 0,
"weight": 1 }

字段说明：

type：记忆类型\
date：时间\
agent：Agent隔离\
source_file：冷归档指针\
hit_count：命中次数\
weight：权重

------------------------------------------------------------------------

# 8 写入链路（Write Path）

session.jsonl\
↓\
LLM Extraction\
↓\
Daily Summary\
↓\
Chunking\
↓\
Embedding\
↓\
Metadata\
↓\
ChromaDB + BM25\
↓\
Archive

触发方式：

-   cron任务
-   /memory sync

------------------------------------------------------------------------

# 9 检索链路（Read Path）

Query\
↓\
Embedding\
↓\
Vector Search Top20\
↓\
BM25 Search Top20\
↓\
RRF Fusion\
↓\
Time Decay\
↓\
Reranker\
↓\
Top3

RRF公式：

score = 1/(60 + rank_v) + 1/(60 + rank_b)

时间衰减：

score = score × e\^(-Δt / halflife)

core_rule 不衰减

------------------------------------------------------------------------

# 10 Memory Graph

Graph Node：

-   Person
-   Project
-   Technology
-   Error
-   Decision

关系示例：

Joe → developing → OpenClaw\
OpenClaw → uses → ChromaDB

作用：

-   关系检索
-   扩展上下文

------------------------------------------------------------------------

# 11 Reflection Engine（反思机制）

流程：

Episodic Event\
↓\
LLM Reflection\
↓\
Semantic Knowledge

示例：

事件：Cloudflare配置失败

总结：CloudNS必须正确配置nameserver

写入：MEMORY.md

------------------------------------------------------------------------

# 12 记忆晋升机制

daily_log\
↓\
hit_count ≥ threshold\
↓\
LLM总结\
↓\
core_rule

core_rule：

-   永久保留
-   不衰减

------------------------------------------------------------------------

# 13 Tool接口

search_memory(query:str)

返回 Top3 memory chunks

read_cold_archive(source_file:str)

读取原始对话

store_event(summary:str)

记录事件

query_graph(entity:str)

查询记忆图谱

------------------------------------------------------------------------

# 14 CLI命令

/memory status\
/memory search\
/memory sync\
/memory rebuild\
/memory promote\
/memory events\
/memory graph\
/memory reflect

------------------------------------------------------------------------

# 15 性能优化

Embedding Cache：避免重复embedding

Incremental Index：只处理新增数据

Parallel Retrieval：

vector search\
bm25 search

------------------------------------------------------------------------

# 16 异常处理

embedding失败 → 重试\
vector损坏 → rebuild\
archive缺失 → 忽略\
reranker超时 → 降级

------------------------------------------------------------------------

# 17 部署

本地：

pip install openclaw-cortex-memory

Docker：

docker run openclaw-cortex-memory

------------------------------------------------------------------------

# 18 开发阶段

Phase1：基础RAG（Vector + BM25）

Phase2：写入链路（memory sync）

Phase3：Reranker + 时间衰减

Phase4：Graph + Reflection

------------------------------------------------------------------------

# 19 最终效果

长期记忆：∞

检索速度：\<50ms

Token成本：减少90%

知识积累：持续增长
