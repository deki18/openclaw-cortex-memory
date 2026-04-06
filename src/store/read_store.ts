import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";
import { postJsonWithTimeout } from "../net/http_post";

interface LoggerLike {
  debug: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
}

export interface ReadStoreSearchArgs {
  query: string;
  topK: number;
  mode?: "default" | "lightweight";
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
  summaryText?: string;
  sourceText?: string;
  sourceField?: "summary" | "evidence";
  sourceEventId?: string;
  sourceFile?: string;
  source: string;
  timestamp?: number;
  layer?: "active" | "archive";
  sourceMemoryId?: string;
  sourceMemoryCanonicalId?: string;
  embedding?: number[];
  eventType?: string;
  qualityScore?: number;
  charCount?: number;
  tokenCount?: number;
  sessionId?: string;
  entities?: string[];
  relations?: Array<{ source: string; target: string; type: string }>;
}

function buildEntityGraphSummaryDocs(graphDocs: ReadDocument[]): ReadDocument[] {
  const entityEdges = new Map<string, Array<{ source: string; target: string; type: string }>>();
  const entityLatestTs = new Map<string, number>();
  const entitySession = new Map<string, string>();

  for (const doc of graphDocs) {
    const ts = typeof doc.timestamp === "number" ? doc.timestamp : 0;
    const sessionId = typeof doc.sessionId === "string" ? doc.sessionId : "";
    const relations = Array.isArray(doc.relations) ? doc.relations : [];
    for (const relation of relations) {
      const source = (relation.source || "").trim();
      const target = (relation.target || "").trim();
      const type = (relation.type || "").trim();
      if (!source || !target || !type) continue;
      if (!entityEdges.has(source)) entityEdges.set(source, []);
      if (!entityEdges.has(target)) entityEdges.set(target, []);
      entityEdges.get(source)?.push({ source, target, type });
      entityEdges.get(target)?.push({ source, target, type });
      entityLatestTs.set(source, Math.max(entityLatestTs.get(source) || 0, ts));
      entityLatestTs.set(target, Math.max(entityLatestTs.get(target) || 0, ts));
      if (sessionId) {
        if (!entitySession.has(source)) entitySession.set(source, sessionId);
        if (!entitySession.has(target)) entitySession.set(target, sessionId);
      }
    }
  }

  const output: ReadDocument[] = [];
  for (const [entity, edges] of entityEdges.entries()) {
    if (!edges.length) continue;
    const outgoing = edges.filter(edge => edge.source === entity);
    const incoming = edges.filter(edge => edge.target === entity);
    const typeCounter = new Map<string, number>();
    for (const edge of edges) {
      typeCounter.set(edge.type, (typeCounter.get(edge.type) || 0) + 1);
    }
    const typeSummary = [...typeCounter.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => `${type}:${count}`)
      .join(", ");
    const sortedOutgoing = [...outgoing].sort((a, b) => a.type.localeCompare(b.type));
    const sortedIncoming = [...incoming].sort((a, b) => a.type.localeCompare(b.type));
    const cappedOutgoing = sortedOutgoing.slice(0, 20);
    const cappedIncoming = sortedIncoming.slice(0, 20);
    const relationFacts = edges
      .slice(0, 40)
      .map(edge => `${edge.source} ${edge.type} ${edge.target}`)
      .join(" | ");
    const outgoingBlock = cappedOutgoing.length > 0
      ? cappedOutgoing.map((edge, index) => `${index + 1}. ${edge.source} -[${edge.type}]-> ${edge.target}`).join("\n")
      : "none";
    const incomingBlock = cappedIncoming.length > 0
      ? cappedIncoming.map((edge, index) => `${index + 1}. ${edge.source} -[${edge.type}]-> ${edge.target}`).join("\n")
      : "none";
    const summaryText = [
      `# Graph Entity Summary`,
      `entity: ${entity}`,
      ``,
      `## Stats`,
      `relation_total: ${edges.length}`,
      `outgoing_total: ${outgoing.length}`,
      `incoming_total: ${incoming.length}`,
      typeSummary ? `relation_type_distribution: ${typeSummary}` : "relation_type_distribution: none",
      ``,
      `## Outgoing Relations`,
      outgoingBlock,
      outgoing.length > cappedOutgoing.length ? `...truncated_outgoing: ${outgoing.length - cappedOutgoing.length}` : "",
      ``,
      `## Incoming Relations`,
      incomingBlock,
      incoming.length > cappedIncoming.length ? `...truncated_incoming: ${incoming.length - cappedIncoming.length}` : "",
      ``,
      `## Relation Facts`,
      relationFacts || "none",
    ].filter(Boolean).join("\n");
    output.push({
      id: `gph_entity_${entity.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "_")}`,
      text: summaryText,
      source: "sessions_graph_entity",
      timestamp: (entityLatestTs.get(entity) || 0) > 0 ? entityLatestTs.get(entity) : undefined,
      layer: "archive",
      sourceMemoryId: entity,
      sessionId: entitySession.get(entity) || undefined,
      entities: [entity],
      relations: edges,
      eventType: "graph_summary",
      qualityScore: 1,
    });
  }
  return output;
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
    channelWeights?: {
      rules?: number;
      archive?: number;
      vector?: number;
      graph?: number;
    };
    channelTopK?: {
      rules?: number;
      archive?: number;
      vector?: number;
      graph?: number;
    };
    minLexicalHits?: number;
    minSemanticHits?: number;
    lengthNorm?: {
      enabled?: boolean;
      pivotChars?: number;
      strength?: number;
      minFactor?: number;
    };
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
  readTuning?: {
    scoring?: {
      lexicalWeight?: number;
      bm25Scale?: number;
      semanticWeight?: number;
      recencyWeight?: number;
      qualityWeight?: number;
      typeMatchWeight?: number;
      graphMatchWeight?: number;
    };
    rrf?: {
      k?: number;
      weight?: number;
    };
    recency?: {
      buckets?: Array<{
        maxAgeHours: number;
        score: number;
        bonus: number;
      }>;
    };
    autoContext?: {
      queryMaxChars?: number;
      lightweightSearch?: boolean;
    };
  };
}

interface ResolvedReadTuning {
  scoring: {
    lexicalWeight: number;
    bm25Scale: number;
    semanticWeight: number;
    recencyWeight: number;
    qualityWeight: number;
    typeMatchWeight: number;
    graphMatchWeight: number;
  };
  rrf: {
    k: number;
    weight: number;
  };
  recency: {
    buckets: Array<{
      maxAgeHours: number;
      score: number;
      bonus: number;
    }>;
  };
  autoContext: {
    queryMaxChars: number;
    lightweightSearch: boolean;
  };
}

const DEFAULT_READ_TUNING: ResolvedReadTuning = {
  scoring: {
    lexicalWeight: 0.2,
    bm25Scale: 2,
    semanticWeight: 0.3,
    recencyWeight: 0.1,
    qualityWeight: 0.15,
    typeMatchWeight: 0.15,
    graphMatchWeight: 0.1,
  },
  rrf: {
    k: 60,
    weight: 1.5,
  },
  recency: {
    buckets: [
      { maxAgeHours: 12, score: 1, bonus: 0.6 },
      { maxAgeHours: 24, score: 0.8, bonus: 0.6 },
      { maxAgeHours: 72, score: 0.6, bonus: 0.3 },
      { maxAgeHours: 168, score: 0.4, bonus: 0.3 },
      { maxAgeHours: 720, score: 0.2, bonus: 0 },
      { maxAgeHours: Number.POSITIVE_INFINITY, score: 0.05, bonus: 0 },
    ],
  },
  autoContext: {
    queryMaxChars: 80,
    lightweightSearch: true,
  },
};

function resolveReadTuning(options?: ReadStoreOptions["readTuning"]): ResolvedReadTuning {
  const configuredBuckets = Array.isArray(options?.recency?.buckets)
    ? options?.recency?.buckets
        .filter(item =>
          item &&
          Number.isFinite(item.maxAgeHours) &&
          item.maxAgeHours > 0 &&
          Number.isFinite(item.score) &&
          item.score >= 0 &&
          Number.isFinite(item.bonus),
        )
        .map(item => ({
          maxAgeHours: item.maxAgeHours,
          score: Math.max(0, item.score),
          bonus: Math.max(0, item.bonus),
        }))
    : [];
  const sortedBuckets = configuredBuckets
    .sort((a, b) => a.maxAgeHours - b.maxAgeHours);
  const buckets = sortedBuckets.length > 0 ? sortedBuckets : DEFAULT_READ_TUNING.recency.buckets;

  const numberOr = (value: unknown, fallback: number, min: number): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
      return fallback;
    }
    return value;
  };

  return {
    scoring: {
      lexicalWeight: numberOr(options?.scoring?.lexicalWeight, DEFAULT_READ_TUNING.scoring.lexicalWeight, 0),
      bm25Scale: numberOr(options?.scoring?.bm25Scale, DEFAULT_READ_TUNING.scoring.bm25Scale, 0),
      semanticWeight: numberOr(options?.scoring?.semanticWeight, DEFAULT_READ_TUNING.scoring.semanticWeight, 0),
      recencyWeight: numberOr(options?.scoring?.recencyWeight, DEFAULT_READ_TUNING.scoring.recencyWeight, 0),
      qualityWeight: numberOr(options?.scoring?.qualityWeight, DEFAULT_READ_TUNING.scoring.qualityWeight, 0),
      typeMatchWeight: numberOr(options?.scoring?.typeMatchWeight, DEFAULT_READ_TUNING.scoring.typeMatchWeight, 0),
      graphMatchWeight: numberOr(options?.scoring?.graphMatchWeight, DEFAULT_READ_TUNING.scoring.graphMatchWeight, 0),
    },
    rrf: {
      k: Math.floor(numberOr(options?.rrf?.k, DEFAULT_READ_TUNING.rrf.k, 1)),
      weight: numberOr(options?.rrf?.weight, DEFAULT_READ_TUNING.rrf.weight, 0),
    },
    recency: {
      buckets,
    },
    autoContext: {
      queryMaxChars: Math.floor(numberOr(options?.autoContext?.queryMaxChars, DEFAULT_READ_TUNING.autoContext.queryMaxChars, 20)),
      lightweightSearch: options?.autoContext?.lightweightSearch !== false,
    },
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

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/i)
    .map(token => token.trim())
    .filter(Boolean);
}

function buildBm25Stats(
  docs: ReadDocument[],
  queryTerms: string[],
  getTokens?: (doc: ReadDocument) => string[],
): {
  avgDocLen: number;
  docFreq: Map<string, number>;
} {
  const docFreq = new Map<string, number>();
  let totalLen = 0;
  for (const doc of docs) {
    const tokens = typeof getTokens === "function" ? getTokens(doc) : tokenize(doc.text);
    totalLen += tokens.length;
    if (queryTerms.length === 0) {
      continue;
    }
    const termSet = new Set(tokens);
    for (const term of queryTerms) {
      if (termSet.has(term)) {
        docFreq.set(term, (docFreq.get(term) || 0) + 1);
      }
    }
  }
  const avgDocLen = docs.length > 0 ? Math.max(1, totalLen / docs.length) : 1;
  return { avgDocLen, docFreq };
}

function bm25Score(args: {
  queryTerms: string[];
  docText: string;
  docTokens?: string[];
  docCount: number;
  avgDocLen: number;
  docFreq: Map<string, number>;
}): number {
  const tokens = Array.isArray(args.docTokens) ? args.docTokens : tokenize(args.docText);
  if (tokens.length === 0 || args.queryTerms.length === 0 || args.docCount <= 0) {
    return 0;
  }
  const termFreq = new Map<string, number>();
  for (const token of tokens) {
    termFreq.set(token, (termFreq.get(token) || 0) + 1);
  }
  const k1 = 1.2;
  const b = 0.75;
  let score = 0;
  for (const term of args.queryTerms) {
    const tf = termFreq.get(term) || 0;
    if (tf <= 0) continue;
    const df = args.docFreq.get(term) || 0;
    const idf = Math.log(1 + ((args.docCount - df + 0.5) / (df + 0.5)));
    const denominator = tf + k1 * (1 - b + b * (tokens.length / Math.max(1, args.avgDocLen)));
    score += idf * (((k1 + 1) * tf) / Math.max(1e-6, denominator));
  }
  return score;
}

function normalizeRecordText(record: Record<string, unknown>): string {
  const summary = typeof record.summary === "string" ? record.summary.trim() : "";
  const sourceText = typeof record.source_text === "string" ? record.source_text.trim() : "";
  if (summary && sourceText) {
    return [
      `summary: ${summary}`,
      `source_text: ${sourceText}`,
    ].join("\n");
  }
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
      const summaryText = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
      const sourceText = typeof parsed.source_text === "string" ? parsed.source_text.trim() : "";
      const text = summaryText || normalizeRecordText(parsed);
      if (!text.trim()) {
        continue;
      }
      const id = typeof parsed.id === "string" ? parsed.id : `${sourceLabel}:${docs.length + 1}`;
      const timestampValue = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : NaN;
      docs.push({
        id,
        text,
        summaryText: summaryText || text,
        sourceText: sourceText || undefined,
        sourceEventId: typeof parsed.source_event_id === "string" ? parsed.source_event_id : undefined,
        sourceFile: typeof parsed.source_file === "string" ? parsed.source_file : undefined,
        source: sourceLabel,
        timestamp: Number.isFinite(timestampValue) ? timestampValue : undefined,
        layer: parsed.layer === "active" || parsed.layer === "archive"
          ? parsed.layer
          : (sourceLabel === "sessions_active" ? "active" : (sourceLabel === "sessions_archive" ? "archive" : undefined)),
        sourceMemoryId: typeof parsed.source_memory_id === "string"
          ? parsed.source_memory_id
          : id,
        sourceMemoryCanonicalId: typeof parsed.source_memory_canonical_id === "string"
          ? parsed.source_memory_canonical_id
          : (typeof parsed.canonical_id === "string" ? parsed.canonical_id : undefined),
        embedding: Array.isArray(parsed.embedding) ? parsed.embedding.filter(item => Number.isFinite(item as number)) as number[] : undefined,
        eventType: typeof parsed.event_type === "string" ? parsed.event_type.trim() : undefined,
        qualityScore: typeof parsed.quality_score === "number" ? parsed.quality_score : undefined,
        charCount: typeof parsed.char_count === "number" ? parsed.char_count : undefined,
        tokenCount: typeof parsed.token_count === "number" ? parsed.token_count : undefined,
        sessionId: typeof parsed.session_id === "string" ? parsed.session_id : undefined,
        entities: [],
        relations: [],
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

function extractPrioritizedRuleLines(text: string, maxRules: number): string[] {
  if (!text.trim() || maxRules <= 0) {
    return [];
  }
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^core rules and knowledge extracted/i.test(line))
    .filter(line => !/^core rules\b/i.test(line));
  if (lines.length === 0) {
    return [];
  }
  const dedupedFromTail: string[] = [];
  const seen = new Set<string>();
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const key = line.toLowerCase().replace(/\s+/g, " ").trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    dedupedFromTail.push(line);
  }
  const scored = dedupedFromTail.map((line, indexFromTail) => {
    let score = 0;
    if (/(must|should|ensure|avoid|prefer|always|never|fallback|verify|validate|retry|sanitize)/i.test(line)) {
      score += 3;
    }
    if (/(fix|resolved|success|stable|deploy|release|incident|rollback|constraint|decision)/i.test(line)) {
      score += 2;
    }
    if (/(确保|避免|优先|必须|建议|回退|重试|校验|稳定|发布|决策)/.test(line)) {
      score += 2;
    }
    if (line.length >= 30 && line.length <= 220) {
      score += 2;
    } else if (line.length > 220) {
      score -= 1;
    }
    if (/[.!?]$/.test(line)) {
      score += 1;
    }
    score += Math.max(0, 2 - indexFromTail * 0.08);
    return { line, score, indexFromTail };
  });
  const selected = scored
    .sort((a, b) => (b.score - a.score) || (a.indexFromTail - b.indexFromTail))
    .slice(0, maxRules)
    .sort((a, b) => a.indexFromTail - b.indexFromTail)
    .map(item => item.line);
  return selected;
}

function withRecencyBoost(
  score: number,
  timestamp: number | undefined,
  buckets: Array<{ maxAgeHours: number; score: number; bonus: number }>,
): number {
  if (!timestamp) {
    return score;
  }
  const ageHours = (Date.now() - timestamp) / (1000 * 60 * 60);
  for (const bucket of buckets) {
    if (ageHours <= bucket.maxAgeHours) {
      return score + bucket.bonus;
    }
  }
  return score;
}

function recencyScore(
  timestamp: number | undefined,
  buckets: Array<{ maxAgeHours: number; score: number; bonus: number }>,
): number {
  if (!timestamp) {
    return 0;
  }
  const ageHours = (Date.now() - timestamp) / (1000 * 60 * 60);
  for (const bucket of buckets) {
    if (ageHours <= bucket.maxAgeHours) {
      return bucket.score;
    }
  }
  return 0;
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
  bm25: number;
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
  need_fulltext_event_ids?: string[];
  confidence: number;
}

interface HitStatItem {
  count: number;
  lastHitAt: string;
}

interface HitStatState {
  items: Record<string, HitStatItem>;
}

const READ_FUSION_PROMPT_VERSION = "read-fusion.v1.2.0";
const READ_FUSION_REGRESSION_SAMPLES = [
  "Example A: if archive and vector refer to the same source_memory_id, keep one main conclusion and keep the rest as supporting evidence.",
  "Example B: if conclusions conflict, write conflicts and explain prioritization in canonical_answer (time, quality, explicitness).",
  "Example C: if summary/excerpt is insufficient, return event ids in need_fulltext_event_ids for full-text lookup.",
];

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
    const response = await postJsonWithTimeout({
      endpoint,
      apiKey: args.apiKey,
      body,
      timeoutMs: 10000,
    });
    if (!response.ok) {
      lastError = new Error(response.status > 0 ? `embedding_http_${response.status}` : (response.error || "embedding_network_error"));
      continue;
    }
    try {
      const json = (response.json || {}) as { data?: Array<{ embedding?: number[] }> };
      const embedding = json?.data?.[0]?.embedding;
      if (Array.isArray(embedding) && embedding.length > 0) {
        return embedding.filter(item => Number.isFinite(item));
      }
      lastError = new Error("embedding_empty");
    } catch (error) {
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
    const response = await postJsonWithTimeout({
      endpoint,
      apiKey: args.apiKey,
      body,
      timeoutMs: 12000,
    });
    if (!response.ok) {
      lastError = new Error(response.status > 0 ? `rerank_http_${response.status}` : (response.error || "rerank_network_error"));
      continue;
    }
    try {
      const json = (response.json || {}) as {
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
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || "rerank_failed"));
}

function classifyIntent(query: string): QueryIntent {
  const text = query.toLowerCase();
  const relationHints = /(关系|依赖|关联|上下游|图谱|拓扑|graph|relation|entity|dependency)/i;
  if (relationHints.test(text)) return "RELATION_DISCOVERY";
  const troubleHints = /(报错|错误|异常|失败|超时|无法|崩溃|故障|修复|bug|error|failed|timeout|fix)/i;
  if (troubleHints.test(text)) return "TROUBLESHOOTING";
  const preferenceHints = /(偏好|习惯|口味|喜欢|不喜欢|偏向|preference)/i;
  if (preferenceHints.test(text)) return "PREFERENCE_PROFILE";
  const timelineHints = /(最近|上次|之前|时间线|历史|timeline|history)/i;
  if (timelineHints.test(text)) return "TIMELINE_REVIEW";
  const decisionHints = /(方案|决策|选择|建议|取舍|权衡|tradeoff|plan)/i;
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

function mergeKeyFromDoc(doc: ReadDocument): string {
  const canonical = typeof doc.sourceMemoryCanonicalId === "string" ? doc.sourceMemoryCanonicalId.trim() : "";
  if (canonical) {
    return `canonical:${canonical}`;
  }
  const sourceMemoryId = typeof doc.sourceMemoryId === "string" ? doc.sourceMemoryId.trim() : "";
  if (sourceMemoryId) {
    return `source:${sourceMemoryId}`;
  }
  return `id:${doc.id}`;
}

function customChannelWeight(source: RankedCandidate["source"], options?: ReadStoreOptions["fusion"]): number {
  const weights = options?.channelWeights;
  if (!weights) return 1;
  const value = weights[source];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 1;
  }
  return value;
}

function lengthNormalizeFactor(doc: ReadDocument, options?: ReadStoreOptions["fusion"]): number {
  const lengthNorm = options?.lengthNorm;
  if (lengthNorm?.enabled === false) {
    return 1;
  }
  const pivotChars = typeof lengthNorm?.pivotChars === "number" && lengthNorm.pivotChars > 0
    ? lengthNorm.pivotChars
    : 1200;
  const strength = typeof lengthNorm?.strength === "number" && lengthNorm.strength > 0
    ? lengthNorm.strength
    : 0.75;
  const minFactor = typeof lengthNorm?.minFactor === "number" && lengthNorm.minFactor > 0 && lengthNorm.minFactor <= 1
    ? lengthNorm.minFactor
    : 0.45;
  const charCount = typeof doc.charCount === "number" && Number.isFinite(doc.charCount)
    ? doc.charCount
    : doc.text.length;
  if (charCount <= pivotChars) {
    return 1;
  }
  const over = (charCount - pivotChars) / pivotChars;
  const factor = 1 / (1 + over * strength);
  return Math.max(minFactor, Math.min(1, factor));
}

function channelQuota(
  source: RankedCandidate["source"],
  topK: number,
  options?: ReadStoreOptions["fusion"],
): number {
  const configured = options?.channelTopK?.[source];
  if (typeof configured === "number" && Number.isFinite(configured) && configured >= 1) {
    return Math.floor(configured);
  }
  if (source === "rules") return Math.max(6, topK * 2);
  if (source === "graph") return Math.max(8, topK * 3);
  return Math.max(12, topK * 4);
}

function parseJsonStringArray(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map(item => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function parseJsonRelations(value: unknown): Array<{ source: string; target: string; type: string }> {
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map(item => {
        if (typeof item !== "object" || item === null) return null;
        const relation = item as Record<string, unknown>;
        const source = typeof relation.source === "string" ? relation.source.trim() : "";
        const target = typeof relation.target === "string" ? relation.target.trim() : "";
        const type = typeof relation.type === "string" && relation.type.trim() ? relation.type.trim() : "related_to";
        if (!source || !target) return null;
        return { source, target, type };
      })
      .filter((item): item is { source: string; target: string; type: string } => Boolean(item));
  } catch {
    return [];
  }
}

async function searchLanceDb(args: {
  memoryRoot: string;
  queryEmbedding: number[];
  limit: number;
  logger: LoggerLike;
}): Promise<ReadDocument[]> {
  try {
    const require = createRequire(__filename);
    const lancedbDir = path.join(args.memoryRoot, "vector", "lancedb");
    if (!fs.existsSync(lancedbDir)) {
      return [];
    }
    const moduleValue = require("@lancedb/lancedb") as unknown;
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
      const entities = parseJsonStringArray(record.entities_json);
      const relations = parseJsonRelations(record.relations_json);
      docs.push({
        id,
        text: summary,
        source: "vector_lancedb",
        timestamp: Number.isFinite(ts) ? ts : undefined,
        layer: record.layer === "active" || record.layer === "archive" ? record.layer : undefined,
        sourceMemoryId: typeof record.source_memory_id === "string" ? record.source_memory_id : undefined,
        sourceMemoryCanonicalId: typeof record.source_memory_canonical_id === "string" ? record.source_memory_canonical_id : undefined,
        sourceEventId: typeof record.source_event_id === "string" ? record.source_event_id : undefined,
        sourceField: record.source_field === "summary" || record.source_field === "evidence"
          ? record.source_field
          : undefined,
        embedding: Array.isArray(record.vector) ? (record.vector as number[]).filter(item => Number.isFinite(item)) : undefined,
        eventType: typeof record.event_type === "string" ? record.event_type : undefined,
        qualityScore: typeof record.quality_score === "number" ? record.quality_score : undefined,
        charCount: typeof record.char_count === "number" ? record.char_count : undefined,
        tokenCount: typeof record.token_count === "number" ? record.token_count : undefined,
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
        layer: parsed.layer === "active" || parsed.layer === "archive" ? parsed.layer : undefined,
        sourceMemoryId: typeof parsed.source_memory_id === "string" ? parsed.source_memory_id : undefined,
        sourceMemoryCanonicalId: typeof parsed.source_memory_canonical_id === "string" ? parsed.source_memory_canonical_id : undefined,
        sourceEventId: typeof parsed.source_event_id === "string" ? parsed.source_event_id : undefined,
        sourceField: parsed.source_field === "summary" || parsed.source_field === "evidence"
          ? parsed.source_field
          : undefined,
        embedding: Array.isArray(parsed.embedding) ? parsed.embedding.filter(item => Number.isFinite(item as number)) as number[] : undefined,
        eventType: typeof parsed.event_type === "string" ? parsed.event_type.trim() : undefined,
        qualityScore: typeof parsed.quality_score === "number" ? parsed.quality_score : undefined,
        charCount: typeof parsed.char_count === "number" ? parsed.char_count : undefined,
        tokenCount: typeof parsed.token_count === "number" ? parsed.token_count : undefined,
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
    source_excerpt?: string;
    source_file?: string;
    source_memory_id?: string;
    source_memory_canonical_id?: string;
    source_layer?: string;
    source_event_id?: string;
    source_field?: "summary" | "evidence" | "";
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
  const candidateIdSet = new Set(args.candidates.map(item => item.id));
  const endpoint = args.llm.baseUrl.endsWith("/chat/completions")
    ? args.llm.baseUrl
    : `${args.llm.baseUrl}/chat/completions`;
  const evidenceText = args.candidates
    .map((item, index) => {
      const excerpt = (item.source_excerpt || "").trim();
      const sourceFile = (item.source_file || "").trim();
      const sourceMemoryId = (item.source_memory_id || "").trim();
      const sourceMemoryCanonicalId = (item.source_memory_canonical_id || "").trim();
      const sourceLayer = (item.source_layer || "").trim();
      const sourceEventId = (item.source_event_id || "").trim();
      const sourceField = (item.source_field || "").trim();
      const extraParts: string[] = [];
      if (sourceMemoryId) extraParts.push(`source_memory_id=${sourceMemoryId}`);
      if (sourceMemoryCanonicalId) extraParts.push(`source_memory_canonical_id=${sourceMemoryCanonicalId}`);
      if (sourceLayer) extraParts.push(`source_layer=${sourceLayer}`);
      if (sourceEventId) extraParts.push(`source_event_id=${sourceEventId}`);
      if (sourceField) extraParts.push(`source_field=${sourceField}`);
      if (sourceFile) extraParts.push(`source_file=${sourceFile}`);
      if (excerpt) extraParts.push(`source_excerpt=${excerpt}`);
      const extra = extraParts.length > 0 ? `\n   ${extraParts.join("\n   ")}` : "";
      return `${index + 1}. [${item.id}] (${item.source}, score=${item.score.toFixed(4)}) ${item.text}${extra}`;
    })
    .join("\n")
    .slice(0, 18000);
  const prompt = [
    `prompt_version=${READ_FUSION_PROMPT_VERSION}`,
    "You are a memory retrieval fusion engine. Fuse multi-channel evidence into a structured answer package for the agent.",
    "Core values and principles:",
    "A) Truthfulness first: do not fabricate; do not infer beyond evidence.",
    "B) Evidence first: every key conclusion must be traceable via evidence_ids.",
    "C) Make conflicts explicit: write conflicts instead of silently overriding.",
    "D) Be transparent about uncertainty: put uncertain parts in coverage_note.",
    "E) Summary-first: prefer summary evidence for conclusions; source_excerpt is supporting evidence.",
    "F) Same-source dedup: merge duplicate evidence from the same source_memory_id/source_memory_canonical_id.",
    "G) Full-text recall: if summary/excerpt is insufficient, return event ids in need_fulltext_event_ids.",
    "Source channel semantics:",
    "- rules: policy/constraints; use for what should be done.",
    "- archive: event-level stable facts (summary-first).",
    "- vector: semantic neighbors for recall; source_field=summary/evidence indicates chunk role.",
    "- graph: entity-relation structure; prefer for dependency/relationship questions.",
    "Query alignment:",
    "- answer the user query first; ignore evidence unrelated to the query.",
    "- when evidence conflicts, prioritize recency + quality + explicitness and record the conflict.",
    "Return strict JSON only:",
    "{\"canonical_answer\": string, \"coverage_note\": string, \"facts\": [{\"text\": string, \"evidence_ids\": string[]}], \"timeline\": [{\"when\": string, \"event\": string, \"evidence_ids\": string[]}], \"entities\": [{\"name\": string, \"role\": string}], \"decisions\": [{\"decision\": string, \"rationale\": string, \"evidence_ids\": string[]}], \"fixes\": [{\"issue\": string, \"fix\": string, \"evidence_ids\": string[]}], \"preferences\": [{\"subject\": string, \"preference\": string, \"evidence_ids\": string[]}], \"risks\": [{\"risk\": string, \"mitigation\": string, \"evidence_ids\": string[]}], \"action_items\": [{\"item\": string, \"owner\": string, \"status\": string, \"evidence_ids\": string[]}], \"conflicts\": [{\"topic\": string, \"details\": string}], \"evidence_ids\": string[], \"need_fulltext_event_ids\": string[], \"confidence\": number}",
    "Output constraints:",
    "1) canonical_answer must be directly usable.",
    "2) facts: usually 3-12 items; prefer high-quality evidence.",
    "3) evidence_ids must come from input candidate ids.",
    "4) conflicts must be [] when no conflict exists.",
    "5) confidence must be within [0, 1].",
    "6) uncertain parts must be explicitly stated in coverage_note.",
    ...READ_FUSION_REGRESSION_SAMPLES,
  ].join("\n");
  const body = {
    model: args.llm.model,
    temperature: 0.1,
    messages: [
      { role: "system", content: "Output JSON only. No extra text." },
      { role: "user", content: `${prompt}\n\nQuery:\n${args.query}\n\nCandidate Evidence:\n${evidenceText}` },
    ],
  };
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await postJsonWithTimeout({
      endpoint,
      apiKey: args.llm.apiKey,
      body,
      timeoutMs: 20000,
    });
    if (!response.ok) {
      lastError = new Error(response.status > 0 ? `fusion_http_${response.status}` : (response.error || "fusion_network_error"));
      continue;
    }
    try {
      const json = (response.json || {}) as { choices?: Array<{ message?: { content?: string } }> };
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
      const whitelistedEvidenceIds = [...new Set(evidenceIds.filter(id => candidateIdSet.has(id)))];
      const needFulltextEventIds = Array.isArray(parsed.need_fulltext_event_ids)
        ? [...new Set(parsed.need_fulltext_event_ids
            .filter(item => typeof item === "string")
            .map(item => item.trim())
            .filter(Boolean))]
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
        evidence_ids: whitelistedEvidenceIds,
        need_fulltext_event_ids: needFulltextEventIds,
        confidence: typeof parsed.confidence === "number"
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0.5,
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || "fusion_failed"));
}

export function createReadStore(options: ReadStoreOptions): ReadStore {
  const memoryRoot = options.dbPath ? path.resolve(options.dbPath) : path.join(options.projectRoot, "data", "memory");
  const vectorFallbackPath = path.join(memoryRoot, "vector", "lancedb_events.jsonl");
  const hitStatsPath = path.join(memoryRoot, ".read_hit_stats.json");
  let docsCache: { signature: string; docs: ReadDocument[] } | null = null;
  let vectorFallbackCache: { signature: string; docs: ReadDocument[] } | null = null;
  let bm25TokenCacheSignature = "";
  let bm25TokenCache = new Map<string, string[]>();
  let hitStatsCache: HitStatState | null = null;
  let hitStatsDirty = false;
  let hitStatsPendingMutations = 0;
  let lastHitStatsFlushAt = 0;
  const hitStatsFlushIntervalMs = 5000;
  const hitStatsFlushBatch = 24;
  const readTuning = resolveReadTuning(options.readTuning);

  function fileSignature(filePath: string): string {
    try {
      if (!fs.existsSync(filePath)) {
        return `${filePath}:missing`;
      }
      const stat = fs.statSync(filePath);
      return `${filePath}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
    } catch {
      return `${filePath}:error`;
    }
  }

  function loadHitStats(): HitStatState {
    if (hitStatsCache) {
      return hitStatsCache;
    }
    try {
      if (!fs.existsSync(hitStatsPath)) {
        hitStatsCache = { items: {} };
        return hitStatsCache;
      }
      const content = fs.readFileSync(hitStatsPath, "utf-8").trim();
      if (!content) {
        hitStatsCache = { items: {} };
        return hitStatsCache;
      }
      const parsed = JSON.parse(content) as HitStatState;
      if (!parsed || typeof parsed !== "object" || !parsed.items || typeof parsed.items !== "object") {
        hitStatsCache = { items: {} };
        return hitStatsCache;
      }
      hitStatsCache = parsed;
      return hitStatsCache;
    } catch {
      hitStatsCache = { items: {} };
      return hitStatsCache;
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

  function maybeFlushHitStats(force: boolean): void {
    if (!hitStatsDirty || !hitStatsCache) {
      return;
    }
    const now = Date.now();
    if (
      !force &&
      hitStatsPendingMutations < hitStatsFlushBatch &&
      (now - lastHitStatsFlushAt) < hitStatsFlushIntervalMs
    ) {
      return;
    }
    saveHitStats(hitStatsCache);
    hitStatsDirty = false;
    hitStatsPendingMutations = 0;
    lastHitStatsFlushAt = now;
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
    hitStatsCache = state;
    hitStatsDirty = true;
    hitStatsPendingMutations += ids.length;
    maybeFlushHitStats(false);
  }

  function loadAllDocuments(): ReadDocument[] {
    const cortexRulesPath = path.join(memoryRoot, "CORTEX_RULES.md");
    const memoryMdPath = path.join(memoryRoot, "MEMORY.md");
    const activeSessionsPath = path.join(memoryRoot, "sessions", "active", "sessions.jsonl");
    const archiveSessionsPath = path.join(memoryRoot, "sessions", "archive", "sessions.jsonl");
    const graphMemoryPath = path.join(memoryRoot, "graph", "memory.jsonl");
    const signature = [
      fileSignature(cortexRulesPath),
      fileSignature(memoryMdPath),
      fileSignature(activeSessionsPath),
      fileSignature(archiveSessionsPath),
      fileSignature(graphMemoryPath),
    ].join("|");
    if (docsCache && docsCache.signature === signature) {
      return docsCache.docs;
    }
    const archiveEventTypeById = new Map<string, string>();
    if (fs.existsSync(archiveSessionsPath)) {
      const archiveContent = safeReadFile(archiveSessionsPath);
      for (const line of archiveContent.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          const id = typeof parsed.id === "string" ? parsed.id.trim() : "";
          const eventType = typeof parsed.event_type === "string" ? parsed.event_type.trim() : "";
          if (id && eventType) {
            archiveEventTypeById.set(id, eventType);
          }
        } catch {}
      }
    }
    const graphDocs: ReadDocument[] = [];
    if (fs.existsSync(graphMemoryPath)) {
      const graphContent = safeReadFile(graphMemoryPath);
      for (const line of graphContent.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          const id = typeof parsed.id === "string" ? parsed.id : "";
          const sourceEventId = typeof parsed.source_event_id === "string" ? parsed.source_event_id : "";
          const archiveEventId = typeof parsed.archive_event_id === "string" ? parsed.archive_event_id : "";
          const eventRefId = archiveEventId || sourceEventId;
          const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : "";
          const sourceLayer = typeof parsed.source_layer === "string" ? parsed.source_layer : "";
          const sourceFile = typeof parsed.source_file === "string" ? parsed.source_file : "";
          const timestamp = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : NaN;
          const entities = Array.isArray(parsed.entities)
            ? parsed.entities.map((item: string) => (typeof item === "string" ? item.trim() : "")).filter(Boolean)
            : [];
          const entityTypes = typeof parsed.entity_types === "object" && parsed.entity_types !== null
            ? parsed.entity_types as Record<string, string>
            : {};
          const relations = Array.isArray(parsed.relations)
            ? parsed.relations
                .map((item: unknown) => {
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
          const eventType = (typeof parsed.event_type === "string" ? parsed.event_type : "") || archiveEventTypeById.get(eventRefId) || "";
          const entityLines = entities.length > 0
            ? entities.map((entity, index) => {
                const entityType = entityTypes[entity];
                return `${index + 1}. ${entity}${entityType ? ` (${entityType})` : ""}`;
              }).join("\n")
            : "none";
          const relationLines = relations.length > 0
            ? relations.map((relation, index) => `${index + 1}. ${relation.source} -[${relation.type}]-> ${relation.target}`).join("\n")
            : "none";
          const relationFacts = relations.length > 0
            ? relations.map(relation => `${relation.source} ${relation.type} ${relation.target}`).join(" | ")
            : "none";
          const text = [
            `# Graph Record`,
            `record_id: ${id}`,
            `source_event_id: ${sourceEventId || archiveEventId || "unknown"}`,
            `source_layer: ${sourceLayer || "unknown"}`,
            `archive_event_id: ${archiveEventId || "n/a"}`,
            `event_type: ${eventType || "unknown"}`,
            `session_id: ${sessionId || "unknown"}`,
            `source_file: ${sourceFile || "unknown"}`,
            ``,
            `## Entities`,
            entityLines,
            ``,
            `## Relations`,
            relationLines,
            ``,
            `## Relation Facts`,
            relationFacts,
          ].join("\n");
          if (id && text.trim()) {
            graphDocs.push({
              id,
              text,
              source: "sessions_graph",
              timestamp: Number.isFinite(timestamp) ? timestamp : undefined,
              layer: sourceLayer === "active_only" ? "active" : "archive",
              sourceMemoryId: eventRefId || id,
              sourceEventId: sourceEventId || archiveEventId || undefined,
              sessionId,
              entities,
              relations,
            });
          }
        } catch (error) {
          options.logger.debug(`Skipping invalid graph memory line: ${error}`);
        }
      }
    }
    const entitySummaryDocs = buildEntityGraphSummaryDocs(graphDocs);
    const docs = [
      ...parseMarkdownFile(cortexRulesPath, "CORTEX_RULES.md"),
      ...parseMarkdownFile(memoryMdPath, "MEMORY.md"),
      ...parseJsonlFile(activeSessionsPath, "sessions_active", options.logger),
      ...parseJsonlFile(archiveSessionsPath, "sessions_archive", options.logger),
      ...graphDocs,
      ...entitySummaryDocs,
    ];
    docsCache = { signature, docs };
    return docs;
  }

  function loadVectorFallbackCached(): ReadDocument[] {
    const signature = fileSignature(vectorFallbackPath);
    if (vectorFallbackCache && vectorFallbackCache.signature === signature) {
      return vectorFallbackCache.docs;
    }
    const docs = parseVectorFallback(vectorFallbackPath, options.logger);
    vectorFallbackCache = { signature, docs };
    return docs;
  }

  function getBm25Tokens(doc: ReadDocument, signature: string): string[] {
    if (bm25TokenCacheSignature !== signature) {
      bm25TokenCacheSignature = signature;
      bm25TokenCache = new Map<string, string[]>();
    }
    const key = `${doc.source}|${doc.id}|${doc.text.length}|${doc.text.slice(0, 64)}`;
    const cached = bm25TokenCache.get(key);
    if (cached) {
      return cached;
    }
    const tokens = tokenize(doc.text);
    bm25TokenCache.set(key, tokens);
    return tokens;
  }

  async function searchMemory(args: ReadStoreSearchArgs): Promise<{ results: unknown[] }> {
    const query = args.query?.trim();
    if (!query) {
      return { results: [] };
    }
    const mode = args.mode === "lightweight" ? "lightweight" : "default";
    const lightweightMode = mode === "lightweight";
    const docs = loadAllDocuments();
    const hitStats = loadHitStats();
    const intent = classifyIntent(query);
    const preferredTypes = preferredEventTypes(intent);
    let queryEmbedding: number[] | null = null;
    const embeddingModel = options.embedding?.model || "";
    const embeddingApiKey = options.embedding?.apiKey || "";
    const embeddingBaseUrl = normalizeBaseUrl(options.embedding?.baseURL || options.embedding?.baseUrl);
    if (!lightweightMode && embeddingModel && embeddingApiKey && embeddingBaseUrl) {
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
      : loadVectorFallbackCached();
    const vectorDocs = [...vectorDocsFromLance, ...vectorDocsFallback];
    const archiveSourceById = new Map<string, { sourceText?: string; summaryText?: string; sourceFile?: string }>();
    for (const doc of docs) {
      if (doc.source !== "sessions_archive") continue;
      const key = (doc.sourceMemoryId || doc.id || "").trim();
      if (!key) continue;
      archiveSourceById.set(key, {
        sourceText: doc.sourceText,
        summaryText: doc.summaryText || doc.text,
        sourceFile: doc.sourceFile,
      });
    }
    for (const doc of vectorDocs) {
      const key = (doc.sourceMemoryId || "").trim();
      if (!key) continue;
      const linked = archiveSourceById.get(key);
      if (!linked) continue;
      if (!doc.sourceText && linked.sourceText) {
        doc.sourceText = linked.sourceText;
      }
      if (!doc.summaryText && linked.summaryText) {
        doc.summaryText = linked.summaryText;
      }
      if (!doc.sourceFile && linked.sourceFile) {
        doc.sourceFile = linked.sourceFile;
      }
    }

    const graphDocs = docs
      .filter(doc => doc.source === "sessions_graph" || doc.source === "sessions_graph_entity")
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
    const archiveDocs = docs.filter(doc => doc.source === "sessions_active" || doc.source === "sessions_archive");
    const bm25Terms = tokenize(query);
    const bm25Corpus = [...rulesDocs, ...archiveDocs, ...vectorDocs, ...graphDocs];
    const bm25Signature = `${docsCache?.signature || "na"}|vector:${vectorDocs.length}:${vectorDocs.slice(0, 40).map(item => `${item.id}:${item.text.length}`).join(",")}`;
    const bm25Stats = buildBm25Stats(
      bm25Corpus,
      bm25Terms,
      doc => getBm25Tokens(doc, bm25Signature),
    );

    const combinedCandidates: RankedCandidate[] = [];
    const channels: Record<RankedCandidate["source"], RankedCandidate[]> = {
      rules: [],
      archive: [],
      vector: [],
      graph: [],
    };

    const evaluateDoc = (doc: ReadDocument, source: RankedCandidate["source"]): RankedCandidate | null => {
      const lexical = scoreText(query, doc.text);
      const bm25 = bm25Score({
        queryTerms: bm25Terms,
        docText: doc.text,
        docTokens: getBm25Tokens(doc, bm25Signature),
        docCount: bm25Corpus.length,
        avgDocLen: bm25Stats.avgDocLen,
        docFreq: bm25Stats.docFreq,
      });
      const lexicalCombined = lexical + bm25 * readTuning.scoring.bm25Scale;
      const semantic = queryEmbedding && Array.isArray(doc.embedding) && doc.embedding.length > 0
        ? Math.max(0, cosineSimilarity(queryEmbedding, doc.embedding) * 5)
        : 0;
      if (lexicalCombined <= 0 && semantic <= 0) {
        return null;
      }
      const recency = recencyScore(doc.timestamp, readTuning.recency.buckets);
      const quality = typeof doc.qualityScore === "number" ? Math.max(0, Math.min(1, doc.qualityScore)) : 0.5;
      const typeMatch = preferredTypes.length > 0 && doc.eventType
        ? (preferredTypes.includes(doc.eventType) ? 1 : 0)
        : 0.5;
      const graphMatch = source === "graph" ? 1 : 0;
      const sourceBaseWeight = sourceWeight(source, intent);
      const sourceConfigWeight = customChannelWeight(source, options.fusion);
      const lengthNorm = lengthNormalizeFactor(doc, options.fusion);
      const baseWeighted = (
        readTuning.scoring.lexicalWeight * lexicalCombined +
        readTuning.scoring.semanticWeight * (semantic * lengthNorm) +
        readTuning.scoring.recencyWeight * recency +
        readTuning.scoring.qualityWeight * quality +
        readTuning.scoring.typeMatchWeight * typeMatch +
        readTuning.scoring.graphMatchWeight * graphMatch
      ) * sourceBaseWeight * sourceConfigWeight;
      const decayFactor = computeDecayFactor(doc.id, doc.eventType, doc.timestamp, options.memoryDecay, hitStats);
      const weighted = baseWeighted * decayFactor;
      return {
        doc,
        source,
        lexical: lexicalCombined,
        bm25,
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
      combinedCandidates.push(...channels[key].slice(0, channelQuota(key, args.topK, options.fusion)));
    }

    const rrfMap = new Map<string, number>();
    const weightedMap = new Map<string, RankedCandidate>();
    const rrfK = readTuning.rrf.k;
    for (const key of Object.keys(channels) as Array<keyof typeof channels>) {
      const list = channels[key];
      for (let i = 0; i < list.length; i += 1) {
        const candidate = list[i];
        const rrf = 1 / (rrfK + i + 1);
        const mergeKey = mergeKeyFromDoc(candidate.doc);
        rrfMap.set(mergeKey, (rrfMap.get(mergeKey) || 0) + rrf);
        const current = weightedMap.get(mergeKey);
        if (!current || candidate.weighted > current.weighted) {
          weightedMap.set(mergeKey, candidate);
        }
      }
    }

    const preRanked = [...weightedMap.entries()]
      .map(([mergeKey, candidate]) => ({
        id: candidate.doc.id,
        merge_key: mergeKey,
        source_memory_id: candidate.doc.sourceMemoryId || "",
        source_memory_canonical_id: candidate.doc.sourceMemoryCanonicalId || "",
        source_event_id: candidate.doc.sourceEventId || "",
        source_field: candidate.doc.sourceField || "",
        text: candidate.doc.summaryText || candidate.doc.text,
        source_text: candidate.doc.sourceText ? candidate.doc.sourceText.slice(0, 4000) : "",
        source_excerpt: candidate.doc.sourceText ? candidate.doc.sourceText.slice(0, 360) : "",
        source_file: candidate.doc.sourceFile || "",
        source: candidate.doc.source,
        layer: candidate.doc.layer || "",
        event_type: candidate.doc.eventType || "",
        quality_score: candidate.quality,
        timestamp: candidate.doc.timestamp ? new Date(candidate.doc.timestamp).toISOString() : "",
        score: candidate.weighted + (rrfMap.get(mergeKey) || 0) * readTuning.rrf.weight,
        score_breakdown: {
          lexical: Number(candidate.lexical.toFixed(4)),
          bm25: Number(candidate.bm25.toFixed(4)),
          semantic: Number(candidate.semantic.toFixed(4)),
          recency: Number(candidate.recency.toFixed(4)),
          quality: Number(candidate.quality.toFixed(4)),
          type: Number(candidate.typeMatch.toFixed(4)),
          graph: Number(candidate.graphMatch.toFixed(4)),
          decay: Number(candidate.decayFactor.toFixed(4)),
          rrf: Number(((rrfMap.get(mergeKey) || 0) * readTuning.rrf.weight).toFixed(4)),
          weighted: Number(candidate.weighted.toFixed(4)),
        },
        reason_tags: [
          `intent:${intent.toLowerCase()}`,
          candidate.semantic > 0 ? "vector_hit" : "lexical_hit",
          candidate.typeMatch >= 1 ? "event_type_match" : "event_type_weak",
          candidate.recency >= 0.8 ? "recent" : "historical",
          candidate.quality >= 0.7 ? "high_quality" : "normal_quality",
          candidate.decayFactor < 1 ? `decay:${candidate.decayFactor.toFixed(3)}` : "decay:1.000",
          `source:${candidate.source}`,
          `merge_key:${mergeKey}`,
        ],
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.max(args.topK, 20)));

    const lexicalRanked = preRanked
      .map(doc => {
        const boost = withRecencyBoost(
          doc.score,
          doc.timestamp ? Date.parse(doc.timestamp) : undefined,
          readTuning.recency.buckets,
        );
        return { ...doc, score: Number(boost.toFixed(4)) };
      });
    const rerankerModel = options.reranker?.model || "";
    const rerankerApiKey = options.reranker?.apiKey || "";
    const rerankerBaseUrl = normalizeBaseUrl(options.reranker?.baseURL || options.reranker?.baseUrl);
    const fusionEnabled = !lightweightMode && options.fusion?.enabled !== false;
    const llmModel = options.llm?.model || "";
    const llmApiKey = options.llm?.apiKey || "";
    const llmBaseUrl = normalizeBaseUrl(options.llm?.baseURL || options.llm?.baseUrl);
    const fusionAuthoritative = options.fusion?.authoritative !== false;
    const skipRerankerForFusion = fusionEnabled && fusionAuthoritative && llmModel && llmApiKey && llmBaseUrl;
    let rerankedSimple: Array<{ id: string; merge_key?: string; text: string; source: string; score: number }> = lexicalRanked.map(item => ({
      id: item.id,
      merge_key: item.merge_key,
      text: item.text,
      source: item.source,
      score: item.score,
    }));
    if (!lightweightMode && rerankerModel && rerankerApiKey && rerankerBaseUrl && lexicalRanked.length > 1 && !skipRerankerForFusion) {
      try {
        rerankedSimple = await requestRerank({
          query,
          candidates: lexicalRanked.map(item => ({ id: item.id, text: item.text, source: item.source, score: item.score })),
          model: rerankerModel,
          apiKey: rerankerApiKey,
          baseUrl: rerankerBaseUrl,
        });
        rerankedSimple = rerankedSimple.map(item => {
          const found = lexicalRanked.find(entry => entry.id === item.id);
          return { ...item, merge_key: found?.merge_key || item.id };
        });
      } catch (error) {
        options.logger.warn(`Reranker failed, keep hybrid ranking: ${error}`);
      }
    }
    const ranked = rerankedSimple.slice(0, Math.max(1, args.topK)).map(item => {
      const hit = lexicalRanked.find(entry => entry.id === item.id);
      return {
      id: item.id,
      merge_key: hit?.merge_key || item.merge_key || item.id,
      source_memory_id: hit?.source_memory_id || "",
      source_memory_canonical_id: hit?.source_memory_canonical_id || "",
      source_event_id: hit?.source_event_id || "",
      source_field: hit?.source_field || "",
      fulltext_event_id: (hit?.source_event_id || hit?.source_memory_id || item.id || ""),
      text: item.text,
      source_text: hit?.source_text || "",
      source_excerpt: hit?.source_excerpt || "",
      source_file: hit?.source_file || "",
      source: item.source,
      layer: hit?.layer || "",
      event_type: hit?.event_type || "",
      quality_score: hit?.quality_score ?? 0,
      timestamp: hit?.timestamp || "",
      score: Number(item.score.toFixed(4)),
      score_breakdown: hit?.score_breakdown || {},
      reason_tags: Array.isArray(hit?.reason_tags) ? hit?.reason_tags : [],
      explain: {
        merge_key: hit?.merge_key || item.merge_key || item.id,
            source_memory_id: hit?.source_memory_id || "",
            source_memory_canonical_id: hit?.source_memory_canonical_id || "",
            source_event_id: hit?.source_event_id || "",
            source_field: hit?.source_field || "",
            channel: item.source,
        source_file: hit?.source_file || "",
        layer: hit?.layer || "",
        score_breakdown: hit?.score_breakdown || {},
        reason_tags: Array.isArray(hit?.reason_tags) ? hit?.reason_tags : [],
      },
    };
    });
    const minLexicalHits = Math.max(0, Math.floor(options.fusion?.minLexicalHits ?? 1));
    const minSemanticHits = Math.max(0, Math.floor(options.fusion?.minSemanticHits ?? 1));
    const fallbackPool = lexicalRanked.filter(item => !ranked.some(existing => existing.id === item.id));
    const lexicalCount = ranked.filter(item => item.reason_tags.includes("lexical_hit")).length;
    const semanticCount = ranked.filter(item => item.reason_tags.includes("vector_hit")).length;
    if (semanticCount < minSemanticHits) {
      const needed = minSemanticHits - semanticCount;
      const supplement = fallbackPool.filter(item => item.reason_tags.includes("vector_hit")).slice(0, needed);
      for (const item of supplement) {
        ranked.push({
          id: item.id,
          merge_key: item.merge_key,
          source_memory_id: item.source_memory_id,
          source_memory_canonical_id: item.source_memory_canonical_id,
          source_event_id: item.source_event_id || "",
          source_field: item.source_field || "",
          fulltext_event_id: item.source_event_id || item.source_memory_id || item.id,
          text: item.text,
          source_text: item.source_text || "",
          source_excerpt: item.source_excerpt || "",
          source_file: item.source_file || "",
          source: item.source,
          layer: item.layer,
          event_type: item.event_type,
          quality_score: item.quality_score,
          timestamp: item.timestamp,
          score: Number(item.score.toFixed(4)),
          score_breakdown: item.score_breakdown || {},
          reason_tags: Array.isArray(item.reason_tags) ? item.reason_tags : [],
          explain: {
            merge_key: item.merge_key,
            source_memory_id: item.source_memory_id,
            source_memory_canonical_id: item.source_memory_canonical_id,
            source_event_id: item.source_event_id || "",
            source_field: item.source_field || "",
            channel: item.source,
            source_file: item.source_file || "",
            layer: item.layer,
            score_breakdown: item.score_breakdown || {},
            reason_tags: Array.isArray(item.reason_tags) ? item.reason_tags : [],
          },
        });
      }
    }
    if (lexicalCount < minLexicalHits) {
      const needed = minLexicalHits - lexicalCount;
      const supplement = fallbackPool.filter(item => item.reason_tags.includes("lexical_hit")).slice(0, needed);
      for (const item of supplement) {
        if (ranked.some(existing => existing.id === item.id)) {
          continue;
        }
        ranked.push({
          id: item.id,
          merge_key: item.merge_key,
          source_memory_id: item.source_memory_id,
          source_memory_canonical_id: item.source_memory_canonical_id,
          source_event_id: item.source_event_id || "",
          source_field: item.source_field || "",
          fulltext_event_id: item.source_event_id || item.source_memory_id || item.id,
          text: item.text,
          source_text: item.source_text || "",
          source_excerpt: item.source_excerpt || "",
          source_file: item.source_file || "",
          source: item.source,
          layer: item.layer,
          event_type: item.event_type,
          quality_score: item.quality_score,
          timestamp: item.timestamp,
          score: Number(item.score.toFixed(4)),
          score_breakdown: item.score_breakdown || {},
          reason_tags: Array.isArray(item.reason_tags) ? item.reason_tags : [],
          explain: {
            merge_key: item.merge_key,
            source_memory_id: item.source_memory_id,
            source_memory_canonical_id: item.source_memory_canonical_id,
            source_event_id: item.source_event_id || "",
            source_field: item.source_field || "",
            channel: item.source,
            source_file: item.source_file || "",
            layer: item.layer,
            score_breakdown: item.score_breakdown || {},
            reason_tags: Array.isArray(item.reason_tags) ? item.reason_tags : [],
          },
        });
      }
    }
    ranked.sort((a, b) => b.score - a.score);
    if (fusionEnabled && llmModel && llmApiKey && llmBaseUrl && ranked.length > 1) {
      try {
        const maxCandidates = Math.max(4, Math.min(20, options.fusion?.maxCandidates ?? 10));
        const fusion = await requestFusion({
          query,
          candidates: ranked.slice(0, maxCandidates).map(item => ({
            id: item.id,
            text: item.text,
            source_excerpt: typeof item.source_excerpt === "string" ? item.source_excerpt : "",
            source_file: typeof item.source_file === "string" ? item.source_file : "",
            source_memory_id: typeof item.source_memory_id === "string" ? item.source_memory_id : "",
            source_memory_canonical_id: typeof item.source_memory_canonical_id === "string" ? item.source_memory_canonical_id : "",
            source_layer: typeof item.layer === "string" ? item.layer : "",
            source_event_id: typeof item.source_event_id === "string" ? item.source_event_id : "",
            source_field: item.source_field === "summary" || item.source_field === "evidence" ? item.source_field : "",
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
          if (!Array.isArray(fusion.evidence_ids) || fusion.evidence_ids.length === 0) {
            throw new Error("fusion_missing_whitelisted_evidence");
          }
          const fulltextFetchHints = (Array.isArray(fusion.need_fulltext_event_ids) ? fusion.need_fulltext_event_ids : [])
            .map(eventId => {
              const linked = ranked.find(item =>
                item.source_memory_id === eventId ||
                item.source_memory_canonical_id === eventId ||
                item.id === eventId,
              );
              return {
                event_id: eventId,
                source_file: linked?.source_file || "",
                source_excerpt: linked?.source_excerpt || "",
              };
            });
          const fusedItem = {
            id: `fusion_${Date.now().toString(36)}`,
            text: fusion.canonical_answer,
            source: "llm_fusion",
            event_type: "fusion",
            quality_score: Number(fusion.confidence.toFixed(4)),
            timestamp: new Date().toISOString(),
            score: Number((Math.max(...ranked.map(item => item.score)) + 1).toFixed(4)),
            reason_tags: ["llm_fused_authoritative", `evidence:${fusion.evidence_ids.length}`],
            explain: {
              channel: "llm_fusion",
              fused_from: ranked.slice(0, maxCandidates).map(item => item.id),
              reason_tags: ["llm_fused_authoritative", `evidence:${fusion.evidence_ids.length}`],
            },
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
            fused_need_fulltext_event_ids: fusion.need_fulltext_event_ids || [],
            fulltext_fetch_hints: fulltextFetchHints,
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
    const finalRanked = ranked.slice(0, Math.max(1, args.topK));
    markHit(finalRanked.map(item => item.id));
    return { results: finalRanked };
  }

  async function getHotContext(args: ReadStoreHotArgs): Promise<{ context: unknown[] }> {
    const limit = Math.max(1, args.limit);
    const docs = loadAllDocuments();
    const coreRules = docs.find(doc => doc.source === "CORTEX_RULES.md");
    const ruleBudget = Math.max(1, Math.min(6, Math.floor(limit / 3)));
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
      const selectedRules = extractPrioritizedRuleLines(coreRules.text, ruleBudget);
      if (selectedRules.length > 0) {
        result.push({
          id: `${coreRules.id}.hot`,
          text: `# Hot Rules\n${selectedRules.map((line, index) => `${index + 1}. ${line}`).join("\n")}`,
          source: coreRules.source,
        });
      }
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
        const autoQuery = latest.text.slice(0, Math.max(20, readTuning.autoContext.queryMaxChars));
        const light = await searchMemory({
          query: autoQuery,
          topK: 3,
          mode: readTuning.autoContext.lightweightSearch ? "lightweight" : "default",
        });
        result.auto_search = {
          query: autoQuery,
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

