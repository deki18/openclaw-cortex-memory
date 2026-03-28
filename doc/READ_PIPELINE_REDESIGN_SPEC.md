# Cortex Memory 读取流程重构设计文档（评审稿）

## 1. 背景与目标

当前写入链路已升级为“session_end 批量抽取 + 多事件归档 + 向量层 + 三阶段去重”。  
读取链路仍以 `read_store.ts` 的“文件全量加载 + 混合打分”为主，尚未充分利用：

- 多事件结构化字段（`event_type` / `entities` / `relations` / `outcome` / `quality_score`）
- 向量索引层（LanceDB 或 fallback 向量文件）
- 会话触发上下文（用户意图、问题类型、时效性）

本设计目标：

1. 从“条件触发”开始重建完整读取链路
2. 用现有存储资产提高召回、排序与可解释性
3. 保证降级可用（即使向量或 reranker 不可用）
4. 保持与当前工具接口兼容（`search_memory` / `get_hot_context` / `get_auto_context` / `query_graph`）

## 2. 现状核实（基于当前代码）

### 2.1 当前读取入口

- `search_memory` -> `readStore.searchMemory`（混合：词法 + 向量相似 + reranker）
- `get_hot_context` -> 规则 + 最近会话
- `get_auto_context` -> 会话缓存 auto_search + hot_context
- `query_graph` -> archive 动态构图（以共现为主）

### 2.2 当前读取数据源

- `CORTEX_RULES.md`
- `MEMORY.md`
- `sessions/active/sessions.jsonl`
- `sessions/archive/sessions.jsonl`
- 向量层已写入（`vector/lancedb` 或 `vector/lancedb_events.jsonl`），但读取流程尚未直接利用

### 2.3 当前主要短板

1. 检索前未做“问题类型识别”，所有查询都走同一条路径
2. 归档事件的结构化字段没有参与专门召回策略
3. 向量层写入后未进入主检索路径（仅依赖 JSONL 中 embedding）
4. 排序融合较单一，缺少“质量权重 / 事件类型权重 / 会话相关性权重”
5. `query_graph` 未优先消费 `relations` 显式边

## 3. 目标读取链路（端到端）

```text
用户输入 / Agent 工具调用
  -> 条件触发分类器（Query Intent Router）
  -> 选择检索策略（规则优先 / 事件优先 / 图谱优先 / 混合）
  -> 多源召回（规则层 + 归档层 + 向量层 + 图谱层）
  -> 归一化打分（词法/语义/质量/时效/关系相关性）
  -> 融合重排（RRF + 可选 reranker）
  -> 去重聚合（按 event_id / summary hash / relation signature）
  -> 结果裁剪与解释信息附带
  -> 返回工具结果（search_memory/get_hot_context/get_auto_context/query_graph）
```

## 4. 条件触发设计（第一跳）

新增 Query Intent Router，按输入语义和上下文打标签：

- `FACT_LOOKUP`：事实回忆、历史记录查询
- `DECISION_SUPPORT`：方案对比、决策建议
- `TROUBLESHOOTING`：报错/失败/修复类
- `PREFERENCE_PROFILE`：用户偏好、约束条件
- `RELATION_DISCOVERY`：实体关系、依赖关系
- `TIMELINE_REVIEW`：按时间回顾

路由规则：

1. 如果命中实体关系关键词或显式调用图谱参数 -> 图谱优先
2. 如果包含“报错/修复/失败/超时”等 -> issue/fix 事件优先
3. 如果包含“偏好/习惯/口味/喜欢/不喜欢” -> preference 事件优先
4. 未命中特殊规则 -> 混合检索

## 5. 多源召回策略

### 5.1 规则层召回（CORTEX_RULES）

用途：给“可执行经验规则”最高权重的补充上下文。  
触发：`DECISION_SUPPORT` / `TROUBLESHOOTING` 优先。  
策略：规则先召回 3-5 条，作为全局先验。

### 5.2 事件归档层召回（archive 主库）

用途：主事实来源。  
策略：

- 先按 `event_type` 过滤（由 Intent Router 决定）
- 再做词法召回（BM25-like/当前 scoreText 可迭代）
- 读取 `quality_score`、`timestamp`、`outcome` 参与打分

### 5.3 向量层召回（LanceDB 优先）

用途：语义近邻召回，解决同义改写问题。  
策略：

1. 若 LanceDB 可用：优先向量 ANN 检索 TopN（建议 30）
2. 若 LanceDB 不可用：读取 `vector/lancedb_events.jsonl` 做 brute-force 余弦
3. 若向量层完全不可用：降级为归档词法召回

### 5.4 图谱层召回（relations + 共现）

用途：关系问题专项召回。  
策略：

- 先消费显式 `relations` 边
- 再补充共现边
- 返回路径、关联实体、边类型统计

## 6. 排序融合策略（提高结果质量核心）

总分建议：

`S = w1*Lexical + w2*Vector + w3*Recency + w4*Quality + w5*TypeMatch + w6*GraphMatch`

推荐权重初值：

- `w1=0.20`
- `w2=0.30`
- `w3=0.10`
- `w4=0.15`
- `w5=0.15`
- `w6=0.10`

融合流程：

1. 分源打分（规则/事件/向量/图谱）
2. RRF 融合（避免单一源垄断）
3. 可选 reranker 精排 Top20 -> TopK
4. 结果级去重（同事件多通道命中只保留最高分）

## 7. 各工具的目标读取链路

### 7.1 search_memory

1. Intent Router
2. 多源召回（至少事件 + 向量）
3. 融合重排
4. 输出 `[{id, summary/text, source, score, reason_tags}]`

### 7.2 get_hot_context

1. 固定包含规则层摘要
2. 按 session 近时序取最近事件
3. 若本轮是故障类问题，补充最新 issue/fix 对

### 7.3 get_auto_context

1. 优先会话缓存 auto_search（低延迟）
2. 缓存缺失则触发轻量 `search_memory`
3. 结果附加 hot_context

### 7.4 query_graph

1. 优先显式 `relations`
2. 共现边作为 fallback
3. 输出 `nodes/edges + relation_type_distribution + top_paths`

## 8. 降级与容错

1. Embedding 失败 -> 词法召回
2. LanceDB 不可用 -> 向量 JSONL
3. Reranker 失败 -> 保留融合排序
4. 图谱解析失败 -> 返回空图 + 诊断建议
5. 任一单源失败不影响整体返回

## 9. 数据契约与返回格式建议

统一命中项结构：

```json
{
  "id": "evt_xxx",
  "source": "archive|rules|vector|graph",
  "event_type": "issue|fix|decision|...",
  "text": "summary or rule text",
  "score": 0.0,
  "quality_score": 0.0,
  "timestamp": "ISO8601",
  "reason_tags": ["intent_match", "vector_hit", "recent", "high_quality"]
}
```

## 10. 实施分期（建议）

### Phase A（低风险高收益）

1. 加 Intent Router
2. search_memory 支持 event_type 过滤 + quality_score 权重
3. query_graph 优先 relations 边

### Phase B（主能力升级）

1. 接入向量层读取（LanceDB -> JSONL fallback）
2. 融合排序（RRF + weighted score）
3. 返回 reason_tags 提升可解释性

### Phase C（精排与效果优化）

1. reranker 精排全链路
2. 质量评估闭环（命中点击/工具后续行为反馈）
3. 参数自动调优（权重/阈值）

## 11. 验收指标

功能验收：

- 同义问题召回率提升
- 故障类问题 fix 命中率提升
- 关系查询可解释性提升

工程验收：

- 任意单源故障下可返回可用结果
- P95 延迟受控（建议 < 1200ms，含 reranker 时 < 2200ms）
- 与现有工具接口兼容，无需改 Agent Prompt

## 12. 待你确认后再实施的改动点

1. 是否接受“Intent Router + 多源融合”作为默认读取链路
2. 是否把 LanceDB 读取设为默认优先
3. `search_memory` 返回结构是否加入 `reason_tags`
4. `query_graph` 是否升级为“relations 优先 + 共现补充”
5. 是否按 Phase A -> B -> C 分阶段上线
