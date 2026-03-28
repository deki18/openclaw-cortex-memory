import * as fs from "fs";
import * as path from "path";

interface LoggerLike {
  debug: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
}

export interface ReadStoreSearchArgs {
  query: string;
  topK: number;
}

export interface ReadStoreHotArgs {
  limit: number;
}

export interface ReadStoreAutoArgs {
  includeHot: boolean;
  sessionId: string;
  cachedAutoSearch?: {
    query: string;
    results: unknown[];
    ageSeconds: number;
  };
}

interface ReadDocument {
  id: string;
  text: string;
  source: string;
  timestamp?: number;
  embedding?: number[];
  eventType?: string;
  qualityScore?: number;
  sessionId?: string;
  entities?: string[];
  relations?: Array<{ source: string; target: string; type: string }>;
}

interface ReadStoreOptions {
  projectRoot: string;
  dbPath?: string;
  logger: LoggerLike;
  embedding?: {
    provider: string;
    model: string;
    apiKey?: string;
    baseURL?: string;
    baseUrl?: string;
    dimensions?: number;
  };
  reranker?: {
    provider?: string;
    model: string;
    apiKey?: string;
    baseURL?: string;
    baseUrl?: string;
  };
  llm?: {
    provider: string;
    model: string;
    apiKey?: string;
    baseURL?: string;
    baseUrl?: string;
  };
  fusion?: {
    enabled?: boolean;
    maxCandidates?: number;
    authoritative?: boolean;
  };
  memoryDecay?: {
    enabled?: boolean;
    minFloor?: number;
    defaultHalfLifeDays?: number;
    halfLifeByEventType?: Record<string, number>;
    antiDecay?: {
      enabled?: boolean;
      maxBoost?: number;
      hitWeight?: number;
      recentWindowDays?: number;
    };
  };
}

export interface ReadStore {
  searchMemory(args: ReadStoreSearchArgs): Promise<{ results: unknown[] }>;
  getHotContext(args: ReadStoreHotArgs): Promise<{ context: unknown[] }>;
  getAutoContext(args: ReadStoreAutoArgs): Promise<{
    auto_search?: { query: string; results: unknown[]; age_seconds: number };
    hot_context?: unknown[];
  }>;
}

function safeReadFile(filePath: string): string {
  try {
    if (!fs.existsSync(filePath)) {
      return "";
    }
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function scoreText(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (!q || !t) {
    return 0;
  }
  let score = 0;
  if (t.includes(q)) {
    score += 5;
  }
  const tokens = q.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    if (t.includes(token)) {
      score += 1;
    }
  }
  return score;
}

function normalizeRecordText(record: Record<string, unknown>): string {
  const direct = [record.content, record.summary, record.text, record.message]
    .find(v => typeof v === "string" && v.trim()) as string | undefined;
  if (direct) {
    return direct.trim();
  }
  if (Array.isArray(record.messages)) {
    const merged = record.messages
      .map(item => {
        if (typeof item === "string") return item;
        if (typeof item === "object" && item !== null) {
          const obj = item as Record<string, unknown>;
          const role = typeof obj.role === "string" ? obj.role : "unknown";
          const content = [obj.content, obj.text, obj.body].find(v => typeof v === "string" && v.trim()) as string | undefined;
          if (content) {
            return `${role}: ${content}`;
          }
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
    if (merged) {
      return merged;
    }
  }
  return JSON.stringify(record);
}

function parseJsonlFile(filePath: string, sourceLabel: string, logger: LoggerLike): ReadDocument[] {
  const content = safeReadFile(filePath);
  if (!content) {
    return [];
  }
  const docs: ReadDocument[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const text = normalizeRecordText(parsed);
      if (!text.trim()) {
        continue;
      }
      const id = typeof parsed.id === "string" ? parsed.id : `${sourceLabel}:${docs.length + 1}`;
      const timestampValue = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : NaN;
      const entities = Array.isArray(parsed.entities)
        ? parsed.entities.map(item => (typeof item === "string" ? item.trim() : "")).filter(Boolean)
        : [];
      const relations = Array.isArray(parsed.relations)
        ? parsed.relations
            .map(item => {
              if (typeof item !== "object" || item === null) return null;
              const relation = item as Record<string, unknown>;
              const source = typeof relation.source === "string" ? relation.source.trim() : "";
              const target = typeof relation.target === "string" ? relation.target.trim() : "";
              const type = typeof relation.type === "string" ? relation.type.trim() : "related_to";
              if (!source || !target) return null;
              return { source, target, type };
            })
            .filter((item): item is { source: string; target: string; type: string } => Boolean(item))
        : [];
      docs.push({
        id,
        text,
        source: sourceLabel,
        timestamp: Number.isFinite(timestampValue) ? timestampValue : undefined,
        embedding: Array.isArray(parsed.embedding) ? parsed.embedding.filter(item => Number.isFinite(item as number)) as number[] : undefined,
        eventType: typeof parsed.event_type === "string" ? parsed.event_type.trim() : undefined,
        qualityScore: typeof parsed.quality_score === "number" ? parsed.quality_score : undefined,
        sessionId: typeof parsed.session_id === "string" ? parsed.session_id : undefined,
        entities,
        relations,
      });
    } catch (error) {
      logger.debug(`Skipping invalid JSONL line in ${filePath}: ${error}`);
    }
  }
  return docs;
}

function parseMarkdownFile(filePath: string, sourceLabel: string): ReadDocument[] {
  const content = safeReadFile(filePath);
  if (!content.trim()) {
    return [];
  }
  const lines = content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#"));
  if (lines.length === 0) {
    return [];
  }
  return [
    {
      id: sourceLabel,
      text: lines.join("\n"),
      source: sourceLabel,
    },
  ];
}

function withRecencyBoost(score: number, timestamp?: number): number {
  if (!timestamp) {
    return score;
  }
  const ageHours = (Date.now() - timestamp) / (1000 * 60 * 60);
  if (ageHours < 24) {
    return score + 0.6;
  }
  if (ageHours < 168) {
    return score + 0.3;
  }
  return score;
}

function recencyScore(timestamp?: number): number {
  if (!timestamp) {
    return 0;
  }
  const ageHours = (Date.now() - timestamp) / (1000 * 60 * 60);
  if (ageHours < 12) return 1;
  if (ageHours < 24) return 0.8;
  if (ageHours < 72) return 0.6;
  if (ageHours < 168) return 0.4;
  if (ageHours < 720) return 0.2;
  return 0.05;
}

function eventTypeHalfLifeDays(eventType: string | undefined, options?: ReadStoreOptions["memoryDecay"]): number {
  const fallback = typeof options?.defaultHalfLifeDays === "number" && options.defaultHalfLifeDays > 0
    ? options.defaultHalfLifeDays
    : 90;
  const type = (eventType || "").trim().toLowerCase();
  if (!type) return fallback;
  const configured = options?.halfLifeByEventType || {};
  if (typeof configured[type] === "number" && configured[type] > 0) {
    return configured[type];
  }
  if (["issue", "fix", "action_item", "blocker"].includes(type)) return 30;
  if (["plan", "milestone", "follow_up"].includes(type)) return 60;
  if (["decision", "insight", "retrospective"].includes(type)) return 120;
  if (["preference", "constraint", "requirement", "dependency", "assumption"].includes(type)) return 240;
  return fallback;
}

function computeAntiDecayBoost(id: string, hitStats: HitStatState, options?: ReadStoreOptions["memoryDecay"]): number {
  const anti = options?.antiDecay;
  if (anti?.enabled === false) {
    return 1;
  }
  const item = hitStats.items[id];
  if (!item) {
    return 1;
  }
  const hitWeight = typeof anti?.hitWeight === "number" && anti.hitWeight > 0 ? anti.hitWeight : 0.08;
  const maxBoost = typeof anti?.maxBoost === "number" && anti.maxBoost >= 1 ? anti.maxBoost : 1.6;
  const recentWindowDays = typeof anti?.recentWindowDays === "number" && anti.recentWindowDays > 0 ? anti.recentWindowDays : 30;
  const lastHitTs = Date.parse(item.lastHitAt || "");
  const ageDays = Number.isFinite(lastHitTs) ? Math.max(0, (Date.now() - lastHitTs) / (1000 * 60 * 60 * 24)) : recentWindowDays * 2;
  const freshness = ageDays <= recentWindowDays ? (1 - ageDays / recentWindowDays) : 0;
  const countFactor = Math.log1p(Math.max(0, item.count));
  const boost = 1 + countFactor * hitWeight * (0.5 + 0.5 * freshness);
  return Math.min(maxBoost, Math.max(1, boost));
}

function computeDecayFactor(
  id: string,
  eventType: string | undefined,
  timestamp: number | undefined,
  options: ReadStoreOptions["memoryDecay"] | undefined,
  hitStats: HitStatState,
): number {
  const enabled = options?.enabled !== false;
  if (!enabled || !timestamp) {
    return computeAntiDecayBoost(id, hitStats, options);
  }
  const ageDays = Math.max(0, (Date.now() - timestamp) / (1000 * 60 * 60 * 24));
  const halfLife = eventTypeHalfLifeDays(eventType, options);
  const base = Math.pow(2, -ageDays / Math.max(1, halfLife));
  const floor = typeof options?.minFloor === "number"
    ? Math.max(0, Math.min(1, options.minFloor))
    : 0.15;
  const decay = Math.max(floor, base);
  const boost = computeAntiDecayBoost(id, hitStats, options);
  return Math.min(1, decay * boost);
}

function normalizeBaseUrl(value?: string): string {
  if (!value) return "";
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

type QueryIntent =
  | "FACT_LOOKUP"
  | "DECISION_SUPPORT"
  | "TROUBLESHOOTING"
  | "PREFERENCE_PROFILE"
  | "RELATION_DISCOVERY"
  | "TIMELINE_REVIEW";

interface RankedCandidate {
  doc: ReadDocument;
  source: "rules" | "archive" | "vector" | "graph";
  lexical: number;
  semantic: number;
  recency: number;
  quality: number;
  typeMatch: number;
  graphMatch: number;
  decayFactor: number;
  weighted: number;
}

interface FusionOutput {
  canonical_answer: string;
  coverage_note?: string;
  facts: Array<{ text: string; evidence_ids: string[] }>;
  timeline?: Array<{ when: string; event: string; evidence_ids: string[] }>;
  entities?: Array<{ name: string; role?: string }>;
  decisions?: Array<{ decision: string; rationale?: string; evidence_ids: string[] }>;
  fixes?: Array<{ issue: string; fix: string; evidence_ids: string[] }>;
  preferences?: Array<{ subject: string; preference: string; evidence_ids: string[] }>;
  risks?: Array<{ risk: string; mitigation?: string; evidence_ids: string[] }>;
  action_items?: Array<{ item: string; owner?: string; status?: string; evidence_ids: string[] }>;
  conflicts: Array<{ topic: string; details: string }>;
  evidence_ids: string[];
  confidence: number;
}

interface HitStatItem {
  count: number;
  lastHitAt: string;
}

interface HitStatState {
  items: Record<string, HitStatItem>;
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  const size = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < size; i += 1) {
    const a = left[i];
    const b = right[i];
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

async function requestEmbedding(args: {
  text: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  dimensions?: number;
}): Promise<number[] | null> {
  const endpoint = args.baseUrl.endsWith("/embeddings") ? args.baseUrl : `${args.baseUrl}/embeddings`;
  const body: Record<string, unknown> = {
    input: args.text,
    model: args.model,
  };
  if (typeof args.dimensions === "number" && Number.isFinite(args.dimensions) && args.dimensions > 0) {
    body.dimensions = args.dimensions;
  }
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${args.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!response.ok) {
        lastError = new Error(`embedding_http_${response.status}`);
        continue;
      }
      const json = await response.json() as { data?: Array<{ embedding?: number[] }> };
      const embedding = json?.data?.[0]?.embedding;
      if (Array.isArray(embedding) && embedding.length > 0) {
        return embedding.filter(item => Number.isFinite(item));
      }
      lastError = new Error("embedding_empty");
    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error;
    }
  }
  if (lastError) {
    throw lastError;
  }
  return null;
}

async function requestRerank(args: {
  query: string;
  candidates: Array<{ id: string; text: string; source: string; score: number }>;
  model: string;
  apiKey: string;
  baseUrl: string;
}): Promise<Array<{ id: string; text: string; source: string; score: number }>> {
  const endpoint = args.baseUrl.endsWith("/rerank") ? args.baseUrl : `${args.baseUrl}/rerank`;
  const documents = args.candidates.map(item => item.text);
  const body = {
    model: args.model,
    query: args.query,
    documents,
    top_n: args.candidates.length,
  };
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${args.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!response.ok) {
        lastError = new Error(`rerank_http_${response.status}`);
        continue;
      }
      const json = await response.json() as {
        results?: Array<{ index?: number; relevance_score?: number; score?: number }>;
        data?: Array<{ index?: number; relevance_score?: number; score?: number }>;
      };
      const list = Array.isArray(json.results) ? json.results : (Array.isArray(json.data) ? json.data : []);
      if (!Array.isArray(list) || list.length === 0) {
        lastError = new Error("rerank_empty");
        continue;
      }
      const mapped = list
        .map((item, rank) => {
          const index = typeof item.index === "number" ? item.index : rank;
          const hit = args.candidates[index];
          if (!hit) return null;
          const score = typeof item.relevance_score === "number" ? item.relevance_score : (typeof item.score === "number" ? item.score : hit.score);
          return { ...hit, score };
        })
        .filter((item): item is { id: string; text: string; source: string; score: number } => Boolean(item));
      if (mapped.length > 0) {
        return mapped;
      }
      lastError = new Error("rerank_map_empty");
    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || "rerank_failed"));
}

function classifyIntent(query: string): QueryIntent {
  const text = query.toLowerCase();
  const relationHints = /(关系|依赖|关联|上下游|graph|relation|entity|拓扑)/i;
  if (relationHints.test(text)) return "RELATION_DISCOVERY";
  const troubleHints = /(报错|错误|异常|失败|超时|无法|崩溃|error|failed|timeout|fix)/i;
  if (troubleHints.test(text)) return "TROUBLESHOOTING";
  const preferenceHints = /(偏好|习惯|口味|喜欢|不喜欢|偏向|preference)/i;
  if (preferenceHints.test(text)) return "PREFERENCE_PROFILE";
  const timelineHints = /(最近|上次|之前|时间线|timeline|history)/i;
  if (timelineHints.test(text)) return "TIMELINE_REVIEW";
  const decisionHints = /(方案|决策|选择|建议|取舍|tradeoff|plan)/i;
  if (decisionHints.test(text)) return "DECISION_SUPPORT";
  return "FACT_LOOKUP";
}

function preferredEventTypes(intent: QueryIntent): string[] {
  if (intent === "TROUBLESHOOTING") return ["issue", "fix", "risk", "blocker", "dependency", "retrospective"];
  if (intent === "PREFERENCE_PROFILE") return ["preference", "decision", "constraint", "requirement"];
  if (intent === "DECISION_SUPPORT") return ["decision", "plan", "insight", "assumption", "constraint", "requirement"];
  if (intent === "TIMELINE_REVIEW") return ["action_item", "follow_up", "milestone", "plan", "decision", "issue", "fix"];
  return [];
}

function sourceWeight(source: RankedCandidate["source"], intent: QueryIntent): number {
  if (source === "rules") {
    return intent === "DECISION_SUPPORT" || intent === "TROUBLESHOOTING" ? 1.15 : 0.9;
  }
  if (source === "graph") {
    return intent === "RELATION_DISCOVERY" ? 1.25 : 0.85;
  }
  if (source === "vector") {
    return 1.05;
  }
  return 1;
}

async function searchLanceDb(args: {
  memoryRoot: string;
  queryEmbedding: number[];
  limit: number;
  logger: LoggerLike;
}): Promise<ReadDocument[]> {
  try {
    const lancedbDir = path.join(args.memoryRoot, "vector", "lancedb");
    if (!fs.existsSync(lancedbDir)) {
      return [];
    }
    const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
    const moduleValue = await dynamicImport("@lancedb/lancedb");
    const connect = (moduleValue as { connect?: (uri: string) => Promise<unknown> }).connect;
    if (typeof connect !== "function") {
      return [];
    }
    const db = await connect(lancedbDir) as { openTable?: (name: string) => Promise<unknown> };
    if (!db || typeof db.openTable !== "function") {
      return [];
    }
    const table = await db.openTable("events") as {
      search?: (vector: number[]) => unknown;
    };
    if (!table || typeof table.search !== "function") {
      return [];
    }
    const searchObj = table.search(args.queryEmbedding) as { limit?: (n: number) => unknown; toArray?: () => Promise<unknown[]> };
    if (!searchObj || typeof searchObj.limit !== "function") {
      return [];
    }
    const limited = searchObj.limit(args.limit) as { toArray?: () => Promise<unknown[]> };
    if (!limited || typeof limited.toArray !== "function") {
      return [];
    }
    const rows = await limited.toArray();
    const docs: ReadDocument[] = [];
    for (const row of rows) {
      if (typeof row !== "object" || row === null) continue;
      const record = row as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id : "";
      const summary = typeof record.summary === "string" ? record.summary : "";
      if (!id || !summary) continue;
      const ts = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
      const entities = typeof record.entities_json === "string"
        ? (JSON.parse(record.entities_json) as string[]).filter(item => typeof item === "string" && item.trim()) as string[]
        : [];
      const relations = typeof record.relations_json === "string"
        ? (JSON.parse(record.relations_json) as Array<{ source: string; target: string; type: string }>)
        : [];
      docs.push({
        id,
        text: summary,
        source: "vector_lancedb",
        timestamp: Number.isFinite(ts) ? ts : undefined,
        embedding: Array.isArray(record.vector) ? (record.vector as number[]).filter(item => Number.isFinite(item)) : undefined,
        eventType: typeof record.event_type === "string" ? record.event_type : undefined,
        qualityScore: typeof record.quality_score === "number" ? record.quality_score : undefined,
        sessionId: typeof record.session_id === "string" ? record.session_id : undefined,
        entities,
        relations: Array.isArray(relations) ? relations : [],
      });
    }
    return docs;
  } catch (error) {
    args.logger.debug(`LanceDB search fallback: ${error}`);
    return [];
  }
}

function parseVectorFallback(filePath: string, logger: LoggerLike): ReadDocument[] {
  const content = safeReadFile(filePath);
  if (!content) {
    return [];
  }
  const docs: ReadDocument[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const id = typeof parsed.id === "string" ? parsed.id : "";
      const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
      if (!id || !summary) continue;
      const ts = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : NaN;
      const entities = Array.isArray(parsed.entities)
        ? parsed.entities.map(item => (typeof item === "string" ? item.trim() : "")).filter(Boolean)
        : [];
      const relations = Array.isArray(parsed.relations)
        ? parsed.relations
            .map(item => {
              if (typeof item !== "object" || item === null) return null;
              const relation = item as Record<string, unknown>;
              const source = typeof relation.source === "string" ? relation.source.trim() : "";
              const target = typeof relation.target === "string" ? relation.target.trim() : "";
              const type = typeof relation.type === "string" ? relation.type.trim() : "related_to";
              if (!source || !target) return null;
              return { source, target, type };
            })
            .filter((item): item is { source: string; target: string; type: string } => Boolean(item))
        : [];
      docs.push({
        id,
        text: summary,
        source: "vector_jsonl",
        timestamp: Number.isFinite(ts) ? ts : undefined,
        embedding: Array.isArray(parsed.embedding) ? parsed.embedding.filter(item => Number.isFinite(item as number)) as number[] : undefined,
        eventType: typeof parsed.event_type === "string" ? parsed.event_type.trim() : undefined,
        qualityScore: typeof parsed.quality_score === "number" ? parsed.quality_score : undefined,
        sessionId: typeof parsed.session_id === "string" ? parsed.session_id : undefined,
        entities,
        relations,
      });
    } catch (error) {
      logger.debug(`Skip invalid vector jsonl line: ${error}`);
    }
  }
  return docs;
}

async function requestFusion(args: {
  query: string;
  candidates: Array<{
    id: string;
    text: string;
    source: string;
    event_type: string;
    quality_score: number;
    timestamp: string;
    score: number;
    reason_tags: string[];
  }>;
  llm: {
    model: string;
    apiKey: string;
    baseUrl: string;
  };
}): Promise<FusionOutput | null> {
  const endpoint = args.llm.baseUrl.endsWith("/chat/completions")
    ? args.llm.baseUrl
    : `${args.llm.baseUrl}/chat/completions`;
  const evidenceText = args.candidates
    .map((item, index) => `${index + 1}. [${item.id}] (${item.source}, score=${item.score.toFixed(4)}) ${item.text}`)
    .join("\n")
    .slice(0, 18000);
  const prompt = [
    "你是记忆检索融合器。请融合多路召回结果，产出可直接给 Agent 使用的完整记忆包，不要让 Agent 再去翻历史。",
    "必须严格返回 JSON：",
    "{\"canonical_answer\": string, \"coverage_note\": string, \"facts\": [{\"text\": string, \"evidence_ids\": string[]}], \"timeline\": [{\"when\": string, \"event\": string, \"evidence_ids\": string[]}], \"entities\": [{\"name\": string, \"role\": string}], \"decisions\": [{\"decision\": string, \"rationale\": string, \"evidence_ids\": string[]}], \"fixes\": [{\"issue\": string, \"fix\": string, \"evidence_ids\": string[]}], \"preferences\": [{\"subject\": string, \"preference\": string, \"evidence_ids\": string[]}], \"risks\": [{\"risk\": string, \"mitigation\": string, \"evidence_ids\": string[]}], \"action_items\": [{\"item\": string, \"owner\": string, \"status\": string, \"evidence_ids\": string[]}], \"conflicts\": [{\"topic\": string, \"details\": string}], \"evidence_ids\": string[], \"confidence\": number}",
    "要求：",
    "1) canonical_answer 是完整可执行答案，不要只写摘要",
    "2) facts 3-12 条，优先高分证据",
    "3) evidence_ids 必须来自输入候选 id",
    "4) 若存在冲突写入 conflicts，否则返回空数组",
    "5) confidence 0~1",
    "6) 不确定信息必须在 coverage_note 标注",
  ].join("\n");
  const body = {
    model: args.llm.model,
    temperature: 0.1,
    messages: [
      { role: "system", content: "你只输出 JSON，不要额外解释。" },
      { role: "user", content: `${prompt}\n\n问题:\n${args.query}\n\n候选证据:\n${evidenceText}` },
    ],
  };
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${args.llm.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!response.ok) {
        lastError = new Error(`fusion_http_${response.status}`);
        continue;
      }
      const json = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json?.choices?.[0]?.message?.content?.trim() || "";
      if (!content) {
        lastError = new Error("fusion_empty");
        continue;
      }
      const parsed = JSON.parse(content) as FusionOutput;
      if (!parsed || typeof parsed.canonical_answer !== "string" || !parsed.canonical_answer.trim()) {
        lastError = new Error("fusion_invalid");
        continue;
      }
      const evidenceIds = Array.isArray(parsed.evidence_ids)
        ? parsed.evidence_ids.filter(item => typeof item === "string" && item.trim())
        : [];
      return {
        canonical_answer: parsed.canonical_answer.trim().slice(0, 6000),
        coverage_note: typeof parsed.coverage_note === "string" ? parsed.coverage_note.trim().slice(0, 1200) : "",
        facts: Array.isArray(parsed.facts) ? parsed.facts : [],
        timeline: Array.isArray(parsed.timeline) ? parsed.timeline : [],
        entities: Array.isArray(parsed.entities) ? parsed.entities : [],
        decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
        fixes: Array.isArray(parsed.fixes) ? parsed.fixes : [],
        preferences: Array.isArray(parsed.preferences) ? parsed.preferences : [],
        risks: Array.isArray(parsed.risks) ? parsed.risks : [],
        action_items: Array.isArray(parsed.action_items) ? parsed.action_items : [],
        conflicts: Array.isArray(parsed.conflicts) ? parsed.conflicts : [],
        evidence_ids: evidenceIds,
        confidence: typeof parsed.confidence === "number"
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0.5,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || "fusion_failed"));
}

export function createReadStore(options: ReadStoreOptions): ReadStore {
  const memoryRoot = options.dbPath ? path.resolve(options.dbPath) : path.join(options.projectRoot, "data", "memory");
  const vectorFallbackPath = path.join(memoryRoot, "vector", "lancedb_events.jsonl");
  const hitStatsPath = path.join(memoryRoot, ".read_hit_stats.json");

  function loadHitStats(): HitStatState {
    try {
      if (!fs.existsSync(hitStatsPath)) {
        return { items: {} };
      }
      const content = fs.readFileSync(hitStatsPath, "utf-8").trim();
      if (!content) {
        return { items: {} };
      }
      const parsed = JSON.parse(content) as HitStatState;
      if (!parsed || typeof parsed !== "object" || !parsed.items || typeof parsed.items !== "object") {
        return { items: {} };
      }
      return parsed;
    } catch {
      return { items: {} };
    }
  }

  function saveHitStats(state: HitStatState): void {
    try {
      const dir = path.dirname(hitStatsPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(hitStatsPath, JSON.stringify(state, null, 2), "utf-8");
    } catch (error) {
      options.logger.warn(`Failed to persist read hit stats: ${error}`);
    }
  }

  function markHit(ids: string[]): void {
    if (!ids.length) {
      return;
    }
    const state = loadHitStats();
    const now = new Date().toISOString();
    for (const id of ids) {
      const key = (id || "").trim();
      if (!key) continue;
      const prev = state.items[key];
      state.items[key] = {
        count: (prev?.count || 0) + 1,
        lastHitAt: now,
      };
    }
    const entries = Object.entries(state.items)
      .sort((a, b) => {
        const ta = Date.parse(a[1].lastHitAt || "");
        const tb = Date.parse(b[1].lastHitAt || "");
        return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
      })
      .slice(0, 20000);
    state.items = Object.fromEntries(entries);
    saveHitStats(state);
  }

  function loadAllDocuments(): ReadDocument[] {
    const cortexRulesPath = path.join(memoryRoot, "CORTEX_RULES.md");
    const memoryMdPath = path.join(memoryRoot, "MEMORY.md");
    const activeSessionsPath = path.join(memoryRoot, "sessions", "active", "sessions.jsonl");
    const archiveSessionsPath = path.join(memoryRoot, "sessions", "archive", "sessions.jsonl");

    return [
      ...parseMarkdownFile(cortexRulesPath, "CORTEX_RULES.md"),
      ...parseMarkdownFile(memoryMdPath, "MEMORY.md"),
      ...parseJsonlFile(activeSessionsPath, "sessions_active", options.logger),
      ...parseJsonlFile(archiveSessionsPath, "sessions_archive", options.logger),
    ];
  }

  async function searchMemory(args: ReadStoreSearchArgs): Promise<{ results: unknown[] }> {
    const query = args.query?.trim();
    if (!query) {
      return { results: [] };
    }
    const docs = loadAllDocuments();
    const hitStats = loadHitStats();
    const intent = classifyIntent(query);
    const preferredTypes = preferredEventTypes(intent);
    let queryEmbedding: number[] | null = null;
    const embeddingModel = options.embedding?.model || "";
    const embeddingApiKey = options.embedding?.apiKey || "";
    const embeddingBaseUrl = normalizeBaseUrl(options.embedding?.baseURL || options.embedding?.baseUrl);
    if (embeddingModel && embeddingApiKey && embeddingBaseUrl) {
      try {
        queryEmbedding = await requestEmbedding({
          text: query,
          model: embeddingModel,
          apiKey: embeddingApiKey,
          baseUrl: embeddingBaseUrl,
          dimensions: options.embedding?.dimensions,
        });
      } catch (error) {
        options.logger.warn(`Embedding query failed, fallback to lexical search: ${error}`);
      }
    }
    const vectorDocsFromLance = queryEmbedding && queryEmbedding.length > 0
      ? await searchLanceDb({ memoryRoot, queryEmbedding, limit: Math.max(20, args.topK * 8), logger: options.logger })
      : [];
    const vectorDocsFallback = vectorDocsFromLance.length > 0
      ? []
      : parseVectorFallback(vectorFallbackPath, options.logger);
    const vectorDocs = [...vectorDocsFromLance, ...vectorDocsFallback];

    const graphDocs = docs
      .filter(doc => Array.isArray(doc.relations) && doc.relations.length > 0)
      .map(doc => {
        const graphText = [
          doc.text,
          ...(doc.relations || []).map(relation => `${relation.source} ${relation.type} ${relation.target}`),
        ].join(" | ");
        return {
          ...doc,
          text: graphText,
        };
      });

    const rulesDocs = docs.filter(doc => doc.source === "CORTEX_RULES.md");
    const archiveDocs = docs.filter(doc => doc.source.startsWith("sessions_"));

    const combinedCandidates: RankedCandidate[] = [];
    const channels: Record<RankedCandidate["source"], RankedCandidate[]> = {
      rules: [],
      archive: [],
      vector: [],
      graph: [],
    };

    const evaluateDoc = (doc: ReadDocument, source: RankedCandidate["source"]): RankedCandidate | null => {
      const lexical = scoreText(query, doc.text);
      const semantic = queryEmbedding && Array.isArray(doc.embedding) && doc.embedding.length > 0
        ? Math.max(0, cosineSimilarity(queryEmbedding, doc.embedding) * 5)
        : 0;
      if (lexical <= 0 && semantic <= 0) {
        return null;
      }
      const recency = recencyScore(doc.timestamp);
      const quality = typeof doc.qualityScore === "number" ? Math.max(0, Math.min(1, doc.qualityScore)) : 0.5;
      const typeMatch = preferredTypes.length > 0 && doc.eventType
        ? (preferredTypes.includes(doc.eventType) ? 1 : 0)
        : 0.5;
      const graphMatch = source === "graph" ? 1 : 0;
      const baseWeighted = (
        0.2 * lexical +
        0.3 * semantic +
        0.1 * recency +
        0.15 * quality +
        0.15 * typeMatch +
        0.1 * graphMatch
      ) * sourceWeight(source, intent);
      const decayFactor = computeDecayFactor(doc.id, doc.eventType, doc.timestamp, options.memoryDecay, hitStats);
      const weighted = baseWeighted * decayFactor;
      return {
        doc,
        source,
        lexical,
        semantic,
        recency,
        quality,
        typeMatch,
        graphMatch,
        decayFactor,
        weighted,
      };
    };

    for (const doc of rulesDocs) {
      const candidate = evaluateDoc(doc, "rules");
      if (candidate) channels.rules.push(candidate);
    }
    for (const doc of archiveDocs) {
      const candidate = evaluateDoc(doc, "archive");
      if (candidate) channels.archive.push(candidate);
    }
    for (const doc of vectorDocs) {
      const candidate = evaluateDoc(doc, "vector");
      if (candidate) channels.vector.push(candidate);
    }
    for (const doc of graphDocs) {
      const candidate = evaluateDoc(doc, "graph");
      if (candidate) channels.graph.push(candidate);
    }

    for (const key of Object.keys(channels) as Array<keyof typeof channels>) {
      channels[key].sort((a, b) => b.weighted - a.weighted);
      combinedCandidates.push(...channels[key].slice(0, Math.max(20, args.topK * 5)));
    }

    const rrfMap = new Map<string, number>();
    const weightedMap = new Map<string, RankedCandidate>();
    const rrfK = 60;
    for (const key of Object.keys(channels) as Array<keyof typeof channels>) {
      const list = channels[key];
      for (let i = 0; i < list.length; i += 1) {
        const candidate = list[i];
        const rrf = 1 / (rrfK + i + 1);
        rrfMap.set(candidate.doc.id, (rrfMap.get(candidate.doc.id) || 0) + rrf);
        const current = weightedMap.get(candidate.doc.id);
        if (!current || candidate.weighted > current.weighted) {
          weightedMap.set(candidate.doc.id, candidate);
        }
      }
    }

    const preRanked = [...weightedMap.values()]
      .map(candidate => ({
        id: candidate.doc.id,
        text: candidate.doc.text,
        source: candidate.doc.source,
        event_type: candidate.doc.eventType || "",
        quality_score: candidate.quality,
        timestamp: candidate.doc.timestamp ? new Date(candidate.doc.timestamp).toISOString() : "",
        score: candidate.weighted + (rrfMap.get(candidate.doc.id) || 0) * 1.5,
        reason_tags: [
          `intent:${intent.toLowerCase()}`,
          candidate.semantic > 0 ? "vector_hit" : "lexical_hit",
          candidate.typeMatch >= 1 ? "event_type_match" : "event_type_weak",
          candidate.recency >= 0.8 ? "recent" : "historical",
          candidate.quality >= 0.7 ? "high_quality" : "normal_quality",
          candidate.decayFactor < 1 ? `decay:${candidate.decayFactor.toFixed(3)}` : "decay:1.000",
          `source:${candidate.source}`,
        ],
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.max(args.topK, 20)));

    const lexicalRanked = preRanked
      .map(doc => {
        const boost = withRecencyBoost(doc.score, doc.timestamp ? Date.parse(doc.timestamp) : undefined);
        return { ...doc, score: Number(boost.toFixed(4)) };
      });
    const rerankerModel = options.reranker?.model || "";
    const rerankerApiKey = options.reranker?.apiKey || "";
    const rerankerBaseUrl = normalizeBaseUrl(options.reranker?.baseURL || options.reranker?.baseUrl);
    let rerankedSimple: Array<{ id: string; text: string; source: string; score: number }> = lexicalRanked.map(item => ({
      id: item.id,
      text: item.text,
      source: item.source,
      score: item.score,
    }));
    if (rerankerModel && rerankerApiKey && rerankerBaseUrl && lexicalRanked.length > 1) {
      try {
        rerankedSimple = await requestRerank({
          query,
          candidates: lexicalRanked.map(item => ({ id: item.id, text: item.text, source: item.source, score: item.score })),
          model: rerankerModel,
          apiKey: rerankerApiKey,
          baseUrl: rerankerBaseUrl,
        });
      } catch (error) {
        options.logger.warn(`Reranker failed, keep hybrid ranking: ${error}`);
      }
    }
    const ranked = rerankedSimple.slice(0, Math.max(1, args.topK)).map(item => {
      const hit = lexicalRanked.find(entry => entry.id === item.id);
      return {
      id: item.id,
      text: item.text,
      source: item.source,
      event_type: hit?.event_type || "",
      quality_score: hit?.quality_score ?? 0,
      timestamp: hit?.timestamp || "",
      score: Number(item.score.toFixed(4)),
      reason_tags: Array.isArray(hit?.reason_tags) ? hit?.reason_tags : [],
    };
    });
    const fusionEnabled = options.fusion?.enabled !== false;
    const llmModel = options.llm?.model || "";
    const llmApiKey = options.llm?.apiKey || "";
    const llmBaseUrl = normalizeBaseUrl(options.llm?.baseURL || options.llm?.baseUrl);
    if (fusionEnabled && llmModel && llmApiKey && llmBaseUrl && ranked.length > 1) {
      try {
        const maxCandidates = Math.max(4, Math.min(20, options.fusion?.maxCandidates ?? 10));
        const fusion = await requestFusion({
          query,
          candidates: ranked.slice(0, maxCandidates).map(item => ({
            id: item.id,
            text: item.text,
            source: item.source,
            event_type: item.event_type,
            quality_score: item.quality_score,
            timestamp: item.timestamp,
            score: item.score,
            reason_tags: Array.isArray(item.reason_tags) ? item.reason_tags : [],
          })),
          llm: {
            model: llmModel,
            apiKey: llmApiKey,
            baseUrl: llmBaseUrl,
          },
        });
        if (fusion && fusion.canonical_answer) {
          const fusedItem = {
            id: `fusion_${Date.now().toString(36)}`,
            text: fusion.canonical_answer,
            source: "llm_fusion",
            event_type: "fusion",
            quality_score: Number(fusion.confidence.toFixed(4)),
            timestamp: new Date().toISOString(),
            score: Number((Math.max(...ranked.map(item => item.score)) + 1).toFixed(4)),
            reason_tags: ["llm_fused_authoritative", `evidence:${fusion.evidence_ids.length}`],
            fused_coverage_note: fusion.coverage_note || "",
            fused_facts: fusion.facts,
            fused_timeline: fusion.timeline || [],
            fused_entities: fusion.entities || [],
            fused_decisions: fusion.decisions || [],
            fused_fixes: fusion.fixes || [],
            fused_preferences: fusion.preferences || [],
            fused_risks: fusion.risks || [],
            fused_action_items: fusion.action_items || [],
            fused_conflicts: fusion.conflicts,
            fused_evidence_ids: fusion.evidence_ids,
          };
          const authoritative = options.fusion?.authoritative !== false;
          if (authoritative) {
            markHit(Array.isArray(fusion.evidence_ids) ? fusion.evidence_ids : []);
            return { results: [fusedItem] };
          }
          const merged = [fusedItem, ...ranked];
          markHit([
            ...(Array.isArray(fusion.evidence_ids) ? fusion.evidence_ids : []),
            ...ranked.map(item => item.id),
          ]);
          return { results: merged.slice(0, Math.max(1, args.topK)) };
        }
      } catch (error) {
        options.logger.warn(`LLM fusion failed, fallback to reranked results: ${error}`);
      }
    }
    markHit(ranked.map(item => item.id));
    return { results: ranked };
  }

  async function getHotContext(args: ReadStoreHotArgs): Promise<{ context: unknown[] }> {
    const limit = Math.max(1, args.limit);
    const docs = loadAllDocuments();
    const coreRules = docs.find(doc => doc.source === "CORTEX_RULES.md");
    const archiveDocs = docs
      .filter(doc => doc.source === "sessions_archive")
      .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
      .slice(0, limit);
    const issueFixPairs = docs
      .filter(doc => doc.source === "sessions_archive" && (doc.eventType === "issue" || doc.eventType === "fix"))
      .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
      .slice(0, 2);
    const result: Array<{ id: string; text: string; source: string }> = [];
    if (coreRules) {
      result.push({ id: coreRules.id, text: coreRules.text, source: coreRules.source });
    }
    for (const doc of [...issueFixPairs, ...archiveDocs]) {
      result.push({ id: doc.id, text: doc.text, source: doc.source });
    }
    return { context: result.slice(0, limit) };
  }

  async function getAutoContext(args: ReadStoreAutoArgs): Promise<{
    auto_search?: { query: string; results: unknown[]; age_seconds: number };
    hot_context?: unknown[];
  }> {
    const result: {
      auto_search?: { query: string; results: unknown[]; age_seconds: number };
      hot_context?: unknown[];
    } = {};
    if (args.cachedAutoSearch) {
      result.auto_search = {
        query: args.cachedAutoSearch.query,
        results: args.cachedAutoSearch.results,
        age_seconds: args.cachedAutoSearch.ageSeconds,
      };
    }
    if (!result.auto_search) {
      const docs = loadAllDocuments()
        .filter(doc => doc.source === "sessions_archive" && doc.sessionId === args.sessionId)
        .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
      const latest = docs[0];
      if (latest && latest.text.trim()) {
        const light = await searchMemory({ query: latest.text.slice(0, 80), topK: 3 });
        result.auto_search = {
          query: latest.text.slice(0, 80),
          results: light.results,
          age_seconds: 0,
        };
      }
    }
    if (args.includeHot) {
      const hot = await getHotContext({ limit: 20 });
      result.hot_context = hot.context;
    }
    return result;
  }

  options.logger.debug(`TS read store initialized at ${memoryRoot}`);

  return {
    searchMemory,
    getHotContext,
    getAutoContext,
  };
}
