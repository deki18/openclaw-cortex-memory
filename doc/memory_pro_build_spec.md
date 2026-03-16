# OpenClaw Memory Pro v2

## Self-Executing AI Engineering Template

This document is a self-executing engineering specification designed for
AI coding IDEs such as Cursor, Windsurf, Trae, Claude Code, or GPT
coding environments.

The AI should autonomously implement the entire system defined below.

------------------------------------------------------------------------

# 1 Project Goal

Build a production-ready AI Agent long‑term memory system.

Project name: OpenClaw Memory Pro v2

Core capabilities:

1.  Semantic Memory (vector knowledge memory)
2.  Episodic Memory (event memory)
3.  Procedural Memory (rules and skills)
4.  Memory Graph (entity relationships)
5.  Reflection Engine (experience → knowledge)

Language: Python 3.11+

------------------------------------------------------------------------

# 2 System Architecture

LLM Agent ↓ Memory Controller ↓ Hot Memory \| Semantic Memory \|
Episodic Memory \| Procedural Memory ↓ Vector Store + Event Store + Rule
Store ↓ Memory Graph

------------------------------------------------------------------------

# 3 Project Structure

openclaw-memory-pro/

memory_engine/ config.py metadata_schema.py embedding.py reranker.py
vector_store.py bm25_store.py semantic_memory.py episodic_memory.py
procedural_memory.py memory_graph.py memory_controller.py
retrieval_pipeline.py write_pipeline.py promotion_engine.py
reflection_engine.py

tools/ search_memory.py read_cold_archive.py store_event.py
query_graph.py

cli/ memory_cli.py

data/ memory/ CORTEX_RULES.md MEMORY.md today.md daily-summary/ sessions/
active/ archive/

vector_store/

------------------------------------------------------------------------

# 4 Configuration

config.yaml example

embedding_model: text-embedding-3-large

vector_db_path: \~/.openclaw/vector_store

reranker_api: url: https://api.siliconflow.cn/v1/rerank model:
BAAI/bge-reranker-v2-m3

chunk: size: 600 overlap: 100

time_decay_halflife: 30 promotion_hit_threshold: 3

------------------------------------------------------------------------

# 5 Metadata Schema

Python dataclass:

@dataclass class MemoryMetadata: type: str date: str agent: str
source_file: str \| None hit_count: int = 0 weight: int = 1

Types: daily_log core_rule summary event

------------------------------------------------------------------------

# 6 Embedding Module

File: embedding.py

Function:

embed_text(texts: List\[str\]) -\> List\[List\[float\]\]

Use model: text-embedding-3-large

Add LRU cache to reduce repeated embedding calls.

------------------------------------------------------------------------

# 7 Vector Store

File: vector_store.py

Use LanceDB.

Functions: add_documents() query() delete() rebuild()

All stored documents must include metadata.

------------------------------------------------------------------------

# 8 BM25 Keyword Search

File: bm25_store.py

Library: rank_bm25

Functions: build_index() search(query) update()

------------------------------------------------------------------------

# 9 Retrieval Pipeline

Steps:

1 Embed query 2 Vector search (Top20) 3 BM25 search (Top20) 4 RRF merge
5 Time decay 6 Reranker 7 Return Top3

------------------------------------------------------------------------

# 10 RRF Formula

score = 1/(60 + rank_vector) + 1/(60 + rank_bm25)

------------------------------------------------------------------------

# 11 Time Decay

If metadata.type != core_rule

score = score \* exp(-Δt / halflife)

------------------------------------------------------------------------

# 12 Reranker

Send request:

{ "model": "...", "query": "...", "texts": \[...\] }

Receive relevance scores.

------------------------------------------------------------------------

# 13 Episodic Memory

File: episodic_memory.py

Store events in JSONL.

Fields: id timestamp summary entities outcome source_file

------------------------------------------------------------------------

# 14 Memory Graph

File: memory_graph.py

Library: networkx

Node types: Person Project Technology Error Decision

Edge types: uses develops causes fixes

------------------------------------------------------------------------

# 15 Reflection Engine

Process:

1 Load episodic events 2 Summarize with LLM 3 Extract knowledge 4 Store
into semantic memory

------------------------------------------------------------------------

# 16 Promotion Engine

If hit_count \>= threshold:

promote memory to core_rule

Write result into MEMORY.md.

------------------------------------------------------------------------

# 17 Memory Controller

Central orchestration module.

Responsibilities:

write_memory() search_memory() store_event() reflect_memory()
query_graph()

------------------------------------------------------------------------

# 18 Tools

Expose:

search_memory(query: str) read_cold_archive(path: str)
store_event(summary: str) query_graph(entity: str)

------------------------------------------------------------------------

# 19 CLI Commands

/memory status /memory search `<query>`{=html} /memory sync /memory
rebuild /memory promote /memory events /memory graph /memory reflect

------------------------------------------------------------------------

# 20 Write Pipeline

sessions.jsonl ↓ LLM extraction ↓ daily summary ↓ chunking ↓ embedding ↓
vector store

------------------------------------------------------------------------

# 21 Performance Targets

Vector search \<20ms Full retrieval \<50ms

Support at least 100k memory chunks.

------------------------------------------------------------------------

# 22 Error Handling

Handle: embedding errors vector corruption missing archive reranker
timeout

Provide fallback behavior.

------------------------------------------------------------------------

# 23 Development Phases

Phase 1: Vector + BM25 retrieval Phase 2: Write pipeline Phase 3:
Reranker + time decay Phase 4: Graph + reflection

------------------------------------------------------------------------

# 24 Deliverables

Complete Python project Working CLI Documentation Dockerfile Example
dataset Unit tests

------------------------------------------------------------------------

# Final Instruction

Implement the entire system described in this specification.
