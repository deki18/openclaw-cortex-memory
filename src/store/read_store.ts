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
  relations?: Array<{
    source: string;
    target: string;
    type: string;
    relation_origin?: string;
    relation_definition?: string;
    evidence_span?: string;
    context_chunk?: string;
    confidence?: number;
    fact_status?: "active" | "pending_conflict" | "superseded" | "rejected";
    source_event_id?: string;
    conflict_id?: string;
    relation_key?: string;
  }>;
  factStatus?: "active" | "pending_conflict" | "superseded" | "rejected";
  wikiRef?: string;
  wikiAnchor?: string;
  evidenceIds?: string[];
}

function graphRelationKey(relation: { source: string; target: string; type: string }): string {
  const source = (relation.source || "").trim().toLowerCase();
  const type = (relation.type || "related_to").trim().toLowerCase();
  const target = (relation.target || "").trim().toLowerCase();
  return `${source}|${type}|${target}`;
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
  searchMemory(args: ReadStoreSearchArgs): Promise<{
    results: unknown[];
    semantic_results: unknown[];
    keyword_results: unknown[];
    strategy: string;
  }>;
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
      const causeText = typeof parsed.cause === "string" ? parsed.cause.trim() : "";
      const processText = typeof parsed.process === "string" ? parsed.process.trim() : "";
      const resultText = typeof parsed.result === "string" ? parsed.result.trim() : "";
      const sourceText = typeof parsed.source_text === "string" ? parsed.source_text.trim() : "";
      const activeContent = typeof parsed.content === "string" ? parsed.content.trim() : "";
      const effectiveSummary = summaryText;
      const text = [
        effectiveSummary,
        causeText ? `cause: ${causeText}` : "",
        processText ? `process: ${processText}` : "",
        resultText ? `result: ${resultText}` : "",
      ].filter(Boolean).join("\n") || normalizeRecordText(parsed);
      if (!text.trim()) {
        continue;
      }
      const id = typeof parsed.id === "string" ? parsed.id : `${sourceLabel}:${docs.length + 1}`;
      const timestampValue = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : NaN;
      docs.push({
        id,
        text,
        summaryText: effectiveSummary || undefined,
        sourceText: sourceText || activeContent || undefined,
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

function normalizeFactStatus(value: string): "active" | "pending_conflict" | "superseded" | "rejected" | null {
  const token = (value || "").trim().toLowerCase();
  if (!token) return null;
  if (token === "active") return "active";
  if (token === "pending" || token === "pending_conflict") return "pending_conflict";
  if (token === "superseded") return "superseded";
  if (token === "rejected") return "rejected";
  return null;
}

function uniqueStrings(values: string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = (value || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(key);
  }
  return output;
}

function buildGraphEvidenceIds(args: {
  source: string;
  target: string;
  type: string;
  sourceEventId?: string;
  evidenceSpan?: string;
  wikiRef?: string;
  wikiAnchor?: string;
}): string[] {
  const relationKey = graphRelationKey({
    source: args.source,
    target: args.target,
    type: args.type,
  });
  const evidenceIds = [
    relationKey ? `graph:relation:${relationKey}` : "",
    args.sourceEventId ? `graph:event:${args.sourceEventId}` : "",
    args.evidenceSpan
      ? `graph:evidence:${args.sourceEventId || relationKey}`
      : "",
    args.wikiRef
      ? `wiki:${args.wikiRef}${args.wikiAnchor ? `#${args.wikiAnchor}` : ""}`
      : "",
  ];
  return uniqueStrings(evidenceIds);
}

function toMemoryRelativePath(memoryRoot: string, filePath: string): string {
  return path.relative(memoryRoot, filePath).replace(/\\/g, "/");
}

function toAnchorToken(value: string): string {
  const token = (value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return token || "facts";
}

function parseWikiRelationLine(line: string): {
  relation: {
    source: string;
    target: string;
    type: string;
    evidence_span?: string;
    confidence?: number;
    fact_status?: "active" | "pending_conflict" | "superseded" | "rejected";
    source_event_id?: string;
    conflict_id?: string;
    relation_key?: string;
  };
} | null {
  const text = line.trim();
  if (!text.startsWith("- ")) return null;
  if (text === "- (none)") return null;
  const body = text
    .replace(/^-+\s*/, "")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
  const matched = body.match(/^(.+?)\s+--([^\/]+)\/([^-\s]+)-->\s+(.+?)\s*(?:\((.*)\))?$/);
  if (!matched) {
    return null;
  }
  const source = matched[1].trim();
  const type = matched[2].trim();
  const status = normalizeFactStatus(matched[3]);
  const target = matched[4].trim();
  const attrs = (matched[5] || "").trim();
  if (!source || !target || !type) {
    return null;
  }
  const attributeMap = new Map<string, string>();
  if (attrs) {
    const parts = attrs.split(",").map(item => item.trim()).filter(Boolean);
    for (const part of parts) {
      const eq = part.indexOf("=");
      if (eq <= 0) continue;
      const key = part.slice(0, eq).trim().toLowerCase();
      const value = part.slice(eq + 1).trim();
      if (!key) continue;
      attributeMap.set(key, value);
    }
  }
  const evidenceSpanRaw = attributeMap.get("evidence") || "";
  const confidenceRaw = attributeMap.get("confidence") || "";
  const sourceEventIdRaw = attributeMap.get("source_event_id") || "";
  const conflictIdRaw = attributeMap.get("conflict_id") || "";
  const confidenceNum = confidenceRaw ? Number(confidenceRaw) : NaN;
  const relationKey = graphRelationKey({ source, target, type });
  return {
    relation: {
      source,
      target,
      type,
      evidence_span: evidenceSpanRaw && evidenceSpanRaw.toLowerCase() !== "n/a" ? evidenceSpanRaw : undefined,
      confidence: Number.isFinite(confidenceNum) ? confidenceNum : undefined,
      fact_status: status || undefined,
      source_event_id: sourceEventIdRaw && sourceEventIdRaw.toLowerCase() !== "n/a" ? sourceEventIdRaw : undefined,
      conflict_id: conflictIdRaw && conflictIdRaw.toLowerCase() !== "n/a" ? conflictIdRaw : undefined,
      relation_key: relationKey,
    },
  };
}

function parseWikiProjectionDocuments(memoryRoot: string, logger: LoggerLike): ReadDocument[] {
  const wikiRoot = path.join(memoryRoot, "wiki");
  const folders: Array<{ dir: string; kind: "entity" | "topic" | "timeline" }> = [
    { dir: path.join(wikiRoot, "entities"), kind: "entity" },
    { dir: path.join(wikiRoot, "topics"), kind: "topic" },
    { dir: path.join(wikiRoot, "timelines"), kind: "timeline" },
  ];
  const docs: ReadDocument[] = [];
  for (const { dir, kind } of folders) {
    if (!fs.existsSync(dir)) continue;
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir)
        .filter(file => file.toLowerCase().endsWith(".md"))
        .sort((a, b) => a.localeCompare(b));
    } catch (error) {
      logger.debug(`Skipping wiki projection directory ${dir}: ${error}`);
      continue;
    }
    for (const file of files) {
      const filePath = path.join(dir, file);
      const markdown = safeReadFile(filePath);
      if (!markdown.trim()) continue;
      const relativePath = toMemoryRelativePath(memoryRoot, filePath);
      const mtime = (() => {
        try {
          return fs.statSync(filePath).mtimeMs;
        } catch {
          return NaN;
        }
      })();
      let section = "Facts";
      const sectionCounters = new Map<string, number>();
      const lines = markdown.split(/\r?\n/);
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        if (line.startsWith("## ")) {
          section = line.replace(/^##\s+/, "").trim() || "Facts";
          continue;
        }
        const parsed = parseWikiRelationLine(line);
        if (!parsed) continue;
        const sectionToken = toAnchorToken(section);
        const index = (sectionCounters.get(sectionToken) || 0) + 1;
        sectionCounters.set(sectionToken, index);
        const anchor = `${sectionToken}-${index}`;
        const relation = parsed.relation;
        const factStatus = relation.fact_status || "active";
        const evidenceIds = buildGraphEvidenceIds({
          source: relation.source,
          target: relation.target,
          type: relation.type,
          sourceEventId: relation.source_event_id,
          evidenceSpan: relation.evidence_span,
          wikiRef: relativePath,
          wikiAnchor: anchor,
        });
        docs.push({
          id: `wiki:${relativePath}#${anchor}`,
          text: [
            `# Wiki Projection`,
            `wiki_kind: ${kind}`,
            `wiki_path: ${relativePath}`,
            `wiki_section: ${section}`,
            `fact_status: ${factStatus}`,
            `${relation.source} ${relation.type} ${relation.target}`,
            line,
          ].join("\n"),
          source: "sessions_graph_wiki",
          timestamp: Number.isFinite(mtime) ? Math.floor(mtime) : undefined,
          layer: "archive",
          sourceFile: relativePath,
          sourceMemoryId: relation.relation_key || `wiki:${relativePath}`,
          sourceEventId: relation.source_event_id,
          eventType: "graph_wiki_projection",
          qualityScore: 0.95,
          entities: uniqueStrings([relation.source, relation.target]),
          relations: [relation],
          factStatus,
          wikiRef: relativePath,
          wikiAnchor: anchor,
          evidenceIds,
        });
      }
    }
  }
  return docs;
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
  summaryCombined: number;
  fulltextCombined: number;
  semantic: number;
  recency: number;
  quality: number;
  typeMatch: number;
  graphMatch: number;
  decayFactor: number;
  weighted: number;
}

interface RankedResultRow {
  id: string;
  merge_key: string;
  source_memory_id: string;
  source_memory_canonical_id: string;
  source_event_id: string;
  source_field: string;
  text: string;
  source_text: string;
  source_excerpt: string;
  source_file: string;
  source: string;
  layer: string;
  event_type: string;
  fact_status: "active" | "pending_conflict" | "superseded" | "rejected" | string;
  wiki_ref: string;
  quality_score: number;
  timestamp: string;
  evidence_ids: string[];
  score: number;
  score_breakdown: Record<string, number>;
  reason_tags: string[];
  matched_keywords: string[];
  query_plan_keywords?: string[];
  fulltext_fallback_used?: boolean;
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

const QUERY_PLAN_STOPWORDS = new Set([
  "what",
  "is",
  "the",
  "a",
  "an",
  "of",
  "for",
  "to",
  "in",
  "on",
  "and",
  "or",
  "with",
  "about",
  "this",
  "that",
  "这些",
  "那些",
  "这个",
  "那个",
  "之前",
  "提到",
  "提过",
  "一下",
  "请问",
  "关于",
  "相关",
  "什么",
  "怎么",
  "如何",
  "是否",
  "有没有",
  "是什么",
  "哪些",
  "哪个",
]);

function planQueryKeywords(query: string): string[] {
  const normalized = (query || "").trim().replace(/\s+/g, " ");
  if (!normalized) return [];
  const output: string[] = [];
  const seen = new Set<string>();
  const push = (value: string): void => {
    const item = (value || "").trim();
    if (!item) return;
    const key = item.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    output.push(item);
  };
  push(normalized);
  for (const match of normalized.matchAll(/["“”'‘’]([^"“”'‘’]{2,64})["“”'‘’]/g)) {
    push(match[1]);
  }
  for (const match of normalized.match(/https?:\/\/[^\s]+/gi) || []) {
    push(match);
  }
  for (const match of normalized.matchAll(/\b[A-Za-z0-9][A-Za-z0-9._/-]*(?:\s+[A-Za-z0-9][A-Za-z0-9._/-]*){0,3}\b/g)) {
    const phrase = match[0].trim();
    const words = phrase.split(/\s+/).filter(Boolean);
    const hasStrongSignal = words.length >= 2 || /[A-Z]{2,}/.test(phrase);
    if (hasStrongSignal && !QUERY_PLAN_STOPWORDS.has(phrase.toLowerCase())) {
      push(phrase);
    }
  }
  const normalizedForSplit = normalized
    .replace(/[(){}\[\]<>]/g, " ")
    .replace(/[，。！？；：,.!?;:、]/g, " ")
    .replace(
      /(之前提到的|之前提到|提到的|提到|请问|一下|是什么|什么|哪个|哪篇|哪里|如何|怎么|有关|关于|以及|还有|并且|然后|能否|可以|帮我|给我)/g,
      " ",
    );
  for (const raw of normalizedForSplit.split(/[\/\-\s]+/)) {
    const token = raw.trim();
    if (!token || token.length < 2) continue;
    if (QUERY_PLAN_STOPWORDS.has(token.toLowerCase())) continue;
    push(token);
  }
  return output.slice(0, 5);
}

function shouldTriggerFulltextFallback(
  ranked: Array<{ score: number; reason_tags?: string[]; source?: string }>,
  topK: number,
): boolean {
  const scoped = ranked.slice(0, Math.max(1, topK));
  if (scoped.length === 0) return true;
  const summaryHits = scoped.filter(item =>
    Array.isArray(item.reason_tags) && item.reason_tags.includes("summary_hit"),
  ).length;
  const sessionScoped = scoped.filter(item =>
    item.source === "sessions_active" || item.source === "sessions_archive",
  );
  if (sessionScoped.length === 0) {
    return summaryHits === 0;
  }
  const sessionSummaryHits = sessionScoped.filter(item =>
    Array.isArray(item.reason_tags) && item.reason_tags.includes("summary_hit"),
  ).length;
  return summaryHits === 0 || sessionSummaryHits === 0;
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

function docFactStatus(doc: ReadDocument): "active" | "pending_conflict" | "superseded" | "rejected" {
  const direct = normalizeFactStatus(typeof doc.factStatus === "string" ? doc.factStatus : "");
  if (direct) return direct;
  const relation = Array.isArray(doc.relations) && doc.relations.length > 0 ? doc.relations[0] : null;
  const relationStatus = normalizeFactStatus(typeof relation?.fact_status === "string" ? relation.fact_status : "");
  if (relationStatus) return relationStatus;
  return "active";
}

function docEvidenceIds(doc: ReadDocument): string[] {
  if (Array.isArray(doc.evidenceIds) && doc.evidenceIds.length > 0) {
    return uniqueStrings(doc.evidenceIds);
  }
  const relation = Array.isArray(doc.relations) && doc.relations.length > 0 ? doc.relations[0] : null;
  const source = relation?.source || "";
  const target = relation?.target || "";
  const type = relation?.type || "";
  const evidence = source && target && type
    ? buildGraphEvidenceIds({
        source,
        target,
        type,
        sourceEventId: relation?.source_event_id || doc.sourceEventId,
        evidenceSpan: relation?.evidence_span,
        wikiRef: doc.wikiRef,
        wikiAnchor: doc.wikiAnchor,
      })
    : [];
  return uniqueStrings([
    ...evidence,
    doc.sourceEventId ? `graph:event:${doc.sourceEventId}` : "",
    doc.wikiRef ? `wiki:${doc.wikiRef}${doc.wikiAnchor ? `#${doc.wikiAnchor}` : ""}` : "",
    `doc:${doc.id}`,
  ]);
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

  function directorySignature(dirPath: string, extension: string): string {
    try {
      if (!fs.existsSync(dirPath)) {
        return `${dirPath}:missing`;
      }
      const files = fs.readdirSync(dirPath)
        .filter(file => file.toLowerCase().endsWith(extension.toLowerCase()))
        .sort((a, b) => a.localeCompare(b));
      if (files.length === 0) {
        return `${dirPath}:empty`;
      }
      const signatures = files.map(file => fileSignature(path.join(dirPath, file)));
      return `${dirPath}:${signatures.join("|")}`;
    } catch {
      return `${dirPath}:error`;
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
    const activeSessionsPath = path.join(memoryRoot, "sessions", "active", "sessions.jsonl");
    const archiveSessionsPath = path.join(memoryRoot, "sessions", "archive", "sessions.jsonl");
    const graphMemoryPath = path.join(memoryRoot, "graph", "memory.jsonl");
    const supersededRelationPath = path.join(memoryRoot, "graph", "superseded_relations.jsonl");
    const conflictQueuePath = path.join(memoryRoot, "graph", "conflict_queue.jsonl");
    const wikiEntitiesDir = path.join(memoryRoot, "wiki", "entities");
    const wikiTopicsDir = path.join(memoryRoot, "wiki", "topics");
    const wikiTimelinesDir = path.join(memoryRoot, "wiki", "timelines");
    const wikiProjectionIndexPath = path.join(memoryRoot, "wiki", ".projection_index.json");
    const signature = [
      fileSignature(cortexRulesPath),
      fileSignature(activeSessionsPath),
      fileSignature(archiveSessionsPath),
      fileSignature(graphMemoryPath),
      fileSignature(supersededRelationPath),
      fileSignature(conflictQueuePath),
      directorySignature(wikiEntitiesDir, ".md"),
      directorySignature(wikiTopicsDir, ".md"),
      directorySignature(wikiTimelinesDir, ".md"),
      fileSignature(wikiProjectionIndexPath),
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
    const supersededRelationKeys = new Set<string>();
    if (fs.existsSync(supersededRelationPath)) {
      const supersededContent = safeReadFile(supersededRelationPath);
      for (const line of supersededContent.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          const relationKey = typeof parsed.relation_key === "string" ? parsed.relation_key.trim().toLowerCase() : "";
          if (relationKey) {
            supersededRelationKeys.add(relationKey);
          }
        } catch (error) {
          options.logger.debug(`Skipping invalid superseded relation line: ${error}`);
        }
      }
    }
    if (fs.existsSync(graphMemoryPath)) {
      const graphContent = safeReadFile(graphMemoryPath);
      for (const line of graphContent.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          const id = typeof parsed.id === "string" ? parsed.id : "";
          const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
          const sourceTextNav = typeof parsed.source_text_nav === "object" && parsed.source_text_nav !== null && !Array.isArray(parsed.source_text_nav)
            ? parsed.source_text_nav as Record<string, unknown>
            : undefined;
          const sourceEventId = typeof parsed.source_event_id === "string" ? parsed.source_event_id : "";
          const archiveEventId = typeof parsed.archive_event_id === "string" ? parsed.archive_event_id : "";
          const navSourceEventId = typeof sourceTextNav?.source_event_id === "string" ? sourceTextNav.source_event_id.trim() : "";
          const navSourceMemoryId = typeof sourceTextNav?.source_memory_id === "string" ? sourceTextNav.source_memory_id.trim() : "";
          const navSessionId = typeof sourceTextNav?.session_id === "string" ? sourceTextNav.session_id.trim() : "";
          const navSourceLayer = typeof sourceTextNav?.layer === "string" ? sourceTextNav.layer.trim() : "";
          const navSourceFile = typeof sourceTextNav?.source_file === "string" ? sourceTextNav.source_file.trim() : "";
          const eventRefId = navSourceMemoryId || archiveEventId || navSourceEventId || sourceEventId;
          const sessionId = navSessionId || (typeof parsed.session_id === "string" ? parsed.session_id : "");
          const sourceLayer = navSourceLayer || (typeof parsed.source_layer === "string" ? parsed.source_layer : "");
          const sourceFile = navSourceFile || (typeof parsed.source_file === "string" ? parsed.source_file : "");
          const timestamp = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : NaN;
          const entities = Array.isArray(parsed.entities)
            ? parsed.entities.map((item: string) => (typeof item === "string" ? item.trim() : "")).filter(Boolean)
            : [];
          const entityTypes = typeof parsed.entity_types === "object" && parsed.entity_types !== null
            ? parsed.entity_types as Record<string, string>
            : {};
          const relations = Array.isArray(parsed.relations) ? parsed.relations : [];
          const eventType = (typeof parsed.event_type === "string" ? parsed.event_type : "") || archiveEventTypeById.get(eventRefId) || "";
          let relationCount = 0;
          for (const relationRaw of relations) {
            if (typeof relationRaw !== "object" || relationRaw === null) continue;
            const relationRecord = relationRaw as Record<string, unknown>;
            const source = typeof relationRecord.source === "string" ? relationRecord.source.trim() : "";
            const target = typeof relationRecord.target === "string" ? relationRecord.target.trim() : "";
            const type = typeof relationRecord.type === "string" ? relationRecord.type.trim() : "related_to";
            if (!source || !target) continue;
            relationCount += 1;
            const relationKey = graphRelationKey({ source, target, type });
            const factStatus = supersededRelationKeys.has(relationKey) ? "superseded" : "active";
            const evidenceSpan = typeof relationRecord.evidence_span === "string" && relationRecord.evidence_span.trim()
              ? relationRecord.evidence_span.trim()
              : undefined;
            const confidenceValue = typeof relationRecord.confidence === "number" && Number.isFinite(relationRecord.confidence)
              ? relationRecord.confidence
              : undefined;
            const relationOrigin = typeof relationRecord.relation_origin === "string" && relationRecord.relation_origin.trim()
              ? relationRecord.relation_origin.trim()
              : undefined;
            const relationDefinition = typeof relationRecord.relation_definition === "string" && relationRecord.relation_definition.trim()
              ? relationRecord.relation_definition.trim()
              : undefined;
            const contextChunk = typeof relationRecord.context_chunk === "string" && relationRecord.context_chunk.trim()
              ? relationRecord.context_chunk.trim()
              : undefined;
            const relation = {
              source,
              target,
              type,
              relation_origin: relationOrigin,
              relation_definition: relationDefinition,
              evidence_span: evidenceSpan,
              context_chunk: contextChunk,
              confidence: confidenceValue,
              fact_status: factStatus as "active" | "superseded",
              source_event_id: sourceEventId || archiveEventId || undefined,
              relation_key: relationKey,
            };
            const relationEntities = uniqueStrings([...entities, source, target]);
            const entityLines = relationEntities.length > 0
              ? relationEntities.map((entity, index) => {
                  const entityType = entityTypes[entity];
                  return `${index + 1}. ${entity}${entityType ? ` (${entityType})` : ""}`;
                }).join("\n")
              : "none";
            const text = [
              `# Graph Relation`,
              `record_id: ${id}`,
              `relation_index: ${relationCount}`,
              `relation_key: ${relationKey}`,
              `fact_status: ${factStatus}`,
              `source_event_id: ${sourceEventId || archiveEventId || "unknown"}`,
              `source_layer: ${sourceLayer || "unknown"}`,
              `archive_event_id: ${archiveEventId || "n/a"}`,
              `event_type: ${eventType || "unknown"}`,
              `session_id: ${sessionId || "unknown"}`,
              `source_file: ${sourceFile || "unknown"}`,
              `evidence_span: ${evidenceSpan || "n/a"}`,
              `context_chunk: ${contextChunk || "n/a"}`,
              `relation_origin: ${relationOrigin || "n/a"}`,
              `relation_definition: ${relationDefinition || "n/a"}`,
              `confidence: ${typeof confidenceValue === "number" ? confidenceValue : "n/a"}`,
              ``,
              `## Summary`,
              summary || "n/a",
              ``,
              `## Source References`,
              `source_event_id: ${navSourceEventId || sourceEventId || archiveEventId || "unknown"}`,
              `source_memory_id: ${navSourceMemoryId || eventRefId || "unknown"}`,
              `source_layer: ${sourceLayer || "unknown"}`,
              `source_file: ${sourceFile || "unknown"}`,
              `session_id: ${sessionId || "unknown"}`,
              ``,
              `## Entities`,
              entityLines,
              ``,
              `## Relation`,
              `${source} -[${type}/${factStatus}]-> ${target}`,
            ].join("\n");
            graphDocs.push({
              id: `${id || "graph"}:rel:${relationCount}`,
              text,
              source: "sessions_graph",
              timestamp: Number.isFinite(timestamp) ? timestamp : undefined,
              layer: sourceLayer === "active_only" ? "active" : "archive",
              summaryText: summary || undefined,
              sourceText: contextChunk || undefined,
              sourceMemoryId: eventRefId || id,
              sourceEventId: navSourceEventId || sourceEventId || archiveEventId || undefined,
              sourceFile: sourceFile || undefined,
              sessionId,
              entities: relationEntities,
              relations: [relation],
              eventType: eventType || undefined,
              qualityScore: typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence) ? parsed.confidence : 1,
              factStatus,
              evidenceIds: buildGraphEvidenceIds({
                source,
                target,
                type,
                sourceEventId: relation.source_event_id,
                evidenceSpan,
              }),
            });
          }
        } catch (error) {
          options.logger.debug(`Skipping invalid graph memory line: ${error}`);
        }
      }
    }
    if (fs.existsSync(conflictQueuePath)) {
      const queueContent = safeReadFile(conflictQueuePath);
      for (const line of queueContent.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          const status = normalizeFactStatus(typeof parsed.status === "string" ? parsed.status : "");
          if (status !== "pending_conflict" && status !== "rejected") {
            continue;
          }
          const conflictId = typeof parsed.conflict_id === "string" ? parsed.conflict_id.trim() : "";
          const sourceEventId = typeof parsed.source_event_id === "string" ? parsed.source_event_id.trim() : "";
          const sessionId = typeof parsed.session_id === "string" ? parsed.session_id.trim() : "";
          const sourceFile = typeof parsed.source_file === "string" ? parsed.source_file.trim() : "";
          const sourceLayer = typeof parsed.source_layer === "string" ? parsed.source_layer.trim() : "";
          const updatedAt = typeof parsed.updated_at === "string" ? Date.parse(parsed.updated_at) : NaN;
          const candidate = typeof parsed.candidate === "object" && parsed.candidate !== null
            ? parsed.candidate as Record<string, unknown>
            : {};
          const candidateSummary = typeof candidate.summary === "string" ? candidate.summary.trim() : "";
          const candidateSourceTextNav = typeof candidate.source_text_nav === "object" && candidate.source_text_nav !== null && !Array.isArray(candidate.source_text_nav)
            ? candidate.source_text_nav as Record<string, unknown>
            : undefined;
          const navSourceEventId = typeof candidateSourceTextNav?.source_event_id === "string" ? candidateSourceTextNav.source_event_id.trim() : "";
          const navSourceMemoryId = typeof candidateSourceTextNav?.source_memory_id === "string" ? candidateSourceTextNav.source_memory_id.trim() : "";
          const navSourceLayer = typeof candidateSourceTextNav?.layer === "string" ? candidateSourceTextNav.layer.trim() : "";
          const navSourceFile = typeof candidateSourceTextNav?.source_file === "string" ? candidateSourceTextNav.source_file.trim() : "";
          const navSessionId = typeof candidateSourceTextNav?.session_id === "string" ? candidateSourceTextNav.session_id.trim() : "";
          const candidateEventType = typeof candidate.event_type === "string" ? candidate.event_type.trim() : "";
          const candidateRelations = Array.isArray(candidate.relations) ? candidate.relations : [];
          let relationIndex = 0;
          for (const relationRaw of candidateRelations) {
            if (typeof relationRaw !== "object" || relationRaw === null) continue;
            const relationRecord = relationRaw as Record<string, unknown>;
            const source = typeof relationRecord.source === "string" ? relationRecord.source.trim() : "";
            const target = typeof relationRecord.target === "string" ? relationRecord.target.trim() : "";
            const type = typeof relationRecord.type === "string" ? relationRecord.type.trim() : "related_to";
            if (!source || !target) continue;
            relationIndex += 1;
            const relationKey = graphRelationKey({ source, target, type });
            const evidenceSpan = typeof relationRecord.evidence_span === "string" && relationRecord.evidence_span.trim()
              ? relationRecord.evidence_span.trim()
              : undefined;
            const confidenceValue = typeof relationRecord.confidence === "number" && Number.isFinite(relationRecord.confidence)
              ? relationRecord.confidence
              : undefined;
            const relationOrigin = typeof relationRecord.relation_origin === "string" && relationRecord.relation_origin.trim()
              ? relationRecord.relation_origin.trim()
              : undefined;
            const relationDefinition = typeof relationRecord.relation_definition === "string" && relationRecord.relation_definition.trim()
              ? relationRecord.relation_definition.trim()
              : undefined;
            const contextChunk = typeof relationRecord.context_chunk === "string" && relationRecord.context_chunk.trim()
              ? relationRecord.context_chunk.trim()
              : undefined;
            const relation = {
              source,
              target,
              type,
              relation_origin: relationOrigin,
              relation_definition: relationDefinition,
              evidence_span: evidenceSpan,
              context_chunk: contextChunk,
              confidence: confidenceValue,
              fact_status: status,
              source_event_id: sourceEventId || undefined,
              conflict_id: conflictId || undefined,
              relation_key: relationKey,
            };
            const evidenceIds = uniqueStrings([
              ...buildGraphEvidenceIds({
                source,
                target,
                type,
                sourceEventId: sourceEventId || undefined,
                evidenceSpan,
              }),
              conflictId ? `graph:conflict:${conflictId}` : "",
            ]);
            const text = [
              `# Graph Conflict Candidate`,
              `conflict_id: ${conflictId || "unknown"}`,
              `fact_status: ${status}`,
              `source_event_id: ${sourceEventId || "unknown"}`,
              `source_layer: ${sourceLayer || "unknown"}`,
              `event_type: ${candidateEventType || "unknown"}`,
              `session_id: ${sessionId || "unknown"}`,
              `source_file: ${sourceFile || "unknown"}`,
              `relation_key: ${relationKey}`,
              `evidence_span: ${evidenceSpan || "n/a"}`,
              `context_chunk: ${contextChunk || "n/a"}`,
              `relation_origin: ${relationOrigin || "n/a"}`,
              `relation_definition: ${relationDefinition || "n/a"}`,
              `confidence: ${typeof confidenceValue === "number" ? confidenceValue : "n/a"}`,
              ``,
              `## Summary`,
              candidateSummary || "n/a",
              ``,
              `## Source References`,
              `source_event_id: ${navSourceEventId || sourceEventId || "unknown"}`,
              `source_memory_id: ${navSourceMemoryId || sourceEventId || "unknown"}`,
              `source_layer: ${navSourceLayer || sourceLayer || "unknown"}`,
              `source_file: ${navSourceFile || sourceFile || "unknown"}`,
              `session_id: ${navSessionId || sessionId || "unknown"}`,
              ``,
              `${source} -[${type}/${status}]-> ${target}`,
            ].join("\n");
            graphDocs.push({
              id: `gcf:${conflictId || "unknown"}:rel:${relationIndex}`,
              text,
              source: "sessions_graph_conflict",
              timestamp: Number.isFinite(updatedAt) ? updatedAt : undefined,
              layer: (navSourceLayer || sourceLayer) === "active_only" ? "active" : "archive",
              summaryText: candidateSummary || undefined,
              sourceText: contextChunk || undefined,
              sourceMemoryId: navSourceMemoryId || relationKey,
              sourceEventId: navSourceEventId || sourceEventId || undefined,
              sourceFile: navSourceFile || sourceFile || undefined,
              sessionId: navSessionId || sessionId || undefined,
              entities: uniqueStrings([source, target]),
              relations: [relation],
              eventType: candidateEventType || "graph_conflict",
              qualityScore: typeof confidenceValue === "number" ? confidenceValue : 0.8,
              factStatus: status,
              evidenceIds,
            });
          }
        } catch (error) {
          options.logger.debug(`Skipping invalid conflict queue line: ${error}`);
        }
      }
    }
    const entitySummaryDocs = buildEntityGraphSummaryDocs(
      graphDocs.filter(item => item.factStatus === "active"),
    );
    const wikiProjectionDocs = parseWikiProjectionDocuments(memoryRoot, options.logger);
    const docs = [
      ...parseMarkdownFile(cortexRulesPath, "CORTEX_RULES.md"),
      ...parseJsonlFile(activeSessionsPath, "sessions_active", options.logger),
      ...parseJsonlFile(archiveSessionsPath, "sessions_archive", options.logger),
      ...graphDocs,
      ...entitySummaryDocs,
      ...wikiProjectionDocs,
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

  function getBm25Tokens(doc: ReadDocument, signature: string, channel: "summary" | "fulltext"): string[] {
    if (bm25TokenCacheSignature !== signature) {
      bm25TokenCacheSignature = signature;
      bm25TokenCache = new Map<string, string[]>();
    }
    const isSessionMemory = doc.source === "sessions_active" || doc.source === "sessions_archive";
    const summaryChannelText = isSessionMemory
      ? ((doc.summaryText || "").trim())
      : ((doc.summaryText || doc.text || "").trim());
    const channelText = channel === "fulltext"
      ? ((doc.sourceText || "").trim() || summaryChannelText)
      : summaryChannelText;
    const key = `${channel}:${doc.source}|${doc.id}|${channelText.length}|${channelText.slice(0, 64)}`;
    const cached = bm25TokenCache.get(key);
    if (cached) {
      return cached;
    }
    const tokens = tokenize(channelText);
    bm25TokenCache.set(key, tokens);
    return tokens;
  }

  async function searchMemory(args: ReadStoreSearchArgs): Promise<{
    results: unknown[];
    semantic_results: unknown[];
    keyword_results: unknown[];
    strategy: string;
  }> {
    const query = args.query?.trim();
    if (!query) {
      return {
        results: [],
        semantic_results: [],
        keyword_results: [],
        strategy: "vector_sentence_and_keyword_parallel",
      };
    }
    const mode = args.mode === "lightweight" ? "lightweight" : "default";
    const lightweightMode = mode === "lightweight";
    const docs = loadAllDocuments();
    const hitStats = loadHitStats();
    const intent = classifyIntent(query);
    const preferredTypes = preferredEventTypes(intent);
    const plannedQueriesRaw = lightweightMode ? [query] : planQueryKeywords(query);
    const plannedQueries = plannedQueriesRaw.length > 0 ? plannedQueriesRaw : [query];
    const summaryChannelWeight = 1;
    const fulltextChannelWeight = 0.35;
    const maxCandidatePool = Math.max(1, Math.max(args.topK, 20));
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
      .filter(doc => doc.source.startsWith("sessions_graph"))
      .map(doc => {
        const graphText = [
          doc.text,
          ...(doc.relations || []).map(relation => `${relation.source} ${relation.type} ${relation.target} ${relation.fact_status || doc.factStatus || "active"}`),
        ].join(" | ");
        return {
          ...doc,
          text: graphText,
        };
      });

    const rulesDocs = docs.filter(doc => doc.source === "CORTEX_RULES.md");
    const archiveDocs = docs.filter(doc => doc.source === "sessions_active" || doc.source === "sessions_archive");
    const bm25Corpus = [...rulesDocs, ...archiveDocs, ...vectorDocs, ...graphDocs];
    const bm25Signature = `${docsCache?.signature || "na"}|vector:${vectorDocs.length}:${vectorDocs.slice(0, 40).map(item => `${item.id}:${item.text.length}`).join(",")}`;

    const rankByQuery = (plannedQuery: string, includeFulltext: boolean): RankedResultRow[] => {
      const bm25Terms = tokenize(plannedQuery);
      const bm25StatsSummary = buildBm25Stats(
        bm25Corpus,
        bm25Terms,
        doc => getBm25Tokens(doc, bm25Signature, "summary"),
      );
      const bm25StatsFulltext = includeFulltext
        ? buildBm25Stats(
            bm25Corpus,
            bm25Terms,
            doc => getBm25Tokens(doc, bm25Signature, "fulltext"),
          )
        : { avgDocLen: 1, docFreq: new Map<string, number>() };
      const channels: Record<RankedCandidate["source"], RankedCandidate[]> = {
        rules: [],
        archive: [],
        vector: [],
        graph: [],
      };

      const evaluateDoc = (doc: ReadDocument, source: RankedCandidate["source"]): RankedCandidate | null => {
        const isSessionMemory = doc.source === "sessions_active" || doc.source === "sessions_archive";
        const summaryText = isSessionMemory
          ? (doc.summaryText || "").trim()
          : (doc.summaryText || doc.text || "").trim();
        const fulltextText = (doc.sourceText || "").trim();
        const summaryBm25 = bm25Score({
          queryTerms: bm25Terms,
          docText: summaryText,
          docTokens: getBm25Tokens(doc, bm25Signature, "summary"),
          docCount: bm25Corpus.length,
          avgDocLen: bm25StatsSummary.avgDocLen,
          docFreq: bm25StatsSummary.docFreq,
        });
        const fulltextBm25 = includeFulltext
          ? bm25Score({
              queryTerms: bm25Terms,
              docText: fulltextText,
              docTokens: getBm25Tokens(doc, bm25Signature, "fulltext"),
              docCount: bm25Corpus.length,
              avgDocLen: bm25StatsFulltext.avgDocLen,
              docFreq: bm25StatsFulltext.docFreq,
            })
          : 0;
        const summaryCombined = scoreText(plannedQuery, summaryText) + summaryBm25 * readTuning.scoring.bm25Scale;
        const fulltextCombined = includeFulltext
          ? scoreText(plannedQuery, fulltextText) + fulltextBm25 * readTuning.scoring.bm25Scale
          : 0;
        const lexicalCombined = summaryCombined * summaryChannelWeight + fulltextCombined * fulltextChannelWeight;
        const semantic = plannedQuery === query && queryEmbedding && Array.isArray(doc.embedding) && doc.embedding.length > 0
          ? Math.max(0, cosineSimilarity(queryEmbedding, doc.embedding) * 5)
          : 0;
        if (lexicalCombined <= 0 && semantic <= 0) {
          return null;
        }
        if (source === "graph") {
          const status = docFactStatus(doc);
          if (status === "superseded" || status === "rejected") {
            return null;
          }
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
          bm25: summaryBm25 + fulltextBm25,
          semantic,
          recency,
          quality,
          typeMatch,
          graphMatch,
          decayFactor,
          weighted,
          summaryCombined,
          fulltextCombined,
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

      const rrfMap = new Map<string, number>();
      const weightedMap = new Map<string, RankedCandidate>();
      const rrfK = readTuning.rrf.k;
      for (const key of Object.keys(channels) as Array<keyof typeof channels>) {
        const list = channels[key].sort((a, b) => b.weighted - a.weighted);
        const capped = list.slice(0, channelQuota(key, args.topK, options.fusion));
        for (let i = 0; i < capped.length; i += 1) {
          const candidate = capped[i];
          const rrf = 1 / (rrfK + i + 1);
          const mergeKey = mergeKeyFromDoc(candidate.doc);
          rrfMap.set(mergeKey, (rrfMap.get(mergeKey) || 0) + rrf);
          const current = weightedMap.get(mergeKey);
          if (!current || candidate.weighted > current.weighted) {
            weightedMap.set(mergeKey, candidate);
          }
        }
      }

      return [...weightedMap.entries()]
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
          fact_status: docFactStatus(candidate.doc),
          wiki_ref: candidate.doc.wikiRef || "",
          quality_score: candidate.quality,
          timestamp: candidate.doc.timestamp ? new Date(candidate.doc.timestamp).toISOString() : "",
          evidence_ids: docEvidenceIds(candidate.doc),
          score: candidate.weighted + (rrfMap.get(mergeKey) || 0) * readTuning.rrf.weight,
          score_breakdown: {
            lexical: Number(candidate.lexical.toFixed(4)),
            bm25: Number(candidate.bm25.toFixed(4)),
            semantic: Number(candidate.semantic.toFixed(4)),
            recency: Number(candidate.recency.toFixed(4)),
            quality: Number(candidate.quality.toFixed(4)),
            type: Number(candidate.typeMatch.toFixed(4)),
            graph: Number(candidate.graphMatch.toFixed(4)),
            summary: Number(candidate.summaryCombined.toFixed(4)),
            fulltext: Number(candidate.fulltextCombined.toFixed(4)),
            decay: Number(candidate.decayFactor.toFixed(4)),
            rrf: Number(((rrfMap.get(mergeKey) || 0) * readTuning.rrf.weight).toFixed(4)),
            weighted: Number(candidate.weighted.toFixed(4)),
          },
          reason_tags: [
            `intent:${intent.toLowerCase()}`,
            candidate.summaryCombined > 0 ? "summary_hit" : "",
            candidate.fulltextCombined > 0 ? "fulltext_hit" : "",
            candidate.semantic > 0 ? "vector_hit" : "",
            candidate.lexical > 0 ? "lexical_hit" : "",
            candidate.typeMatch >= 1 ? "event_type_match" : "event_type_weak",
            candidate.recency >= 0.8 ? "recent" : "historical",
            candidate.quality >= 0.7 ? "high_quality" : "normal_quality",
            candidate.decayFactor < 1 ? `decay:${candidate.decayFactor.toFixed(3)}` : "decay:1.000",
            `source:${candidate.source}`,
            `merge_key:${mergeKey}`,
            `query_term:${plannedQuery}`,
          ].filter(Boolean),
          matched_keywords: [plannedQuery],
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, maxCandidatePool);
    };

    const queryRuns = await Promise.all(plannedQueries.map(async plannedQuery => {
      const stage1 = rankByQuery(plannedQuery, false);
      const needFallback = shouldTriggerFulltextFallback(stage1, args.topK);
      if (!needFallback || lightweightMode) {
        return { plannedQuery, ranked: stage1, fulltextFallback: false };
      }
      const stage2 = rankByQuery(plannedQuery, true);
      const merged = new Map<string, RankedResultRow>();
      for (const item of [...stage1, ...stage2]) {
        const mergeKey = item.merge_key || item.id || "";
        const existing = merged.get(mergeKey);
        if (!existing) {
          merged.set(mergeKey, { ...item });
          continue;
        }
        const best = Number(item.score || 0) > Number(existing.score || 0)
          ? { ...existing, ...item }
          : { ...item, ...existing };
        const mergedReasonTags = uniqueStrings([
          ...(Array.isArray(existing.reason_tags) ? existing.reason_tags.map(v => String(v)) : []),
          ...(Array.isArray(item.reason_tags) ? item.reason_tags.map(v => String(v)) : []),
        ]);
        const mergedEvidenceIds = uniqueStrings([
          ...(Array.isArray(existing.evidence_ids) ? existing.evidence_ids.map(v => String(v)) : []),
          ...(Array.isArray(item.evidence_ids) ? item.evidence_ids.map(v => String(v)) : []),
        ]);
        const mergedKeywords = uniqueStrings([
          ...(Array.isArray(existing.matched_keywords) ? existing.matched_keywords.map(v => String(v)) : []),
          ...(Array.isArray(item.matched_keywords) ? item.matched_keywords.map(v => String(v)) : []),
        ]);
        merged.set(mergeKey, {
          ...best,
          score: Math.max(existing.score || 0, item.score || 0),
          reason_tags: mergedReasonTags,
          evidence_ids: mergedEvidenceIds,
          matched_keywords: mergedKeywords,
        });
      }
      return {
        plannedQuery,
        ranked: [...merged.values()]
          .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
          .slice(0, maxCandidatePool)
          .map((item): RankedResultRow => ({
            ...item,
            reason_tags: uniqueStrings([
              ...(Array.isArray(item.reason_tags) ? item.reason_tags.map((v: string) => String(v)) : []),
              "fulltext_fallback",
            ]),
          })),
        fulltextFallback: true,
      };
    }));

    const mergedByQuery = new Map<string, RankedResultRow>();
    for (const run of queryRuns) {
      for (const item of run.ranked) {
        const mergeKey = item.merge_key || item.id || "";
        const existing = mergedByQuery.get(mergeKey);
        if (!existing) {
          mergedByQuery.set(mergeKey, {
            ...item,
            matched_keywords: uniqueStrings([run.plannedQuery]),
            fulltext_fallback_used: run.fulltextFallback,
          });
          continue;
        }
        const mergedReasonTags = uniqueStrings([
          ...(Array.isArray(existing.reason_tags) ? existing.reason_tags.map(v => String(v)) : []),
          ...(Array.isArray(item.reason_tags) ? item.reason_tags.map(v => String(v)) : []),
        ]);
        const mergedEvidenceIds = uniqueStrings([
          ...(Array.isArray(existing.evidence_ids) ? existing.evidence_ids.map(v => String(v)) : []),
          ...(Array.isArray(item.evidence_ids) ? item.evidence_ids.map(v => String(v)) : []),
        ]);
        const matchedKeywords = uniqueStrings([
          ...(Array.isArray(existing.matched_keywords) ? existing.matched_keywords.map(v => String(v)) : []),
          run.plannedQuery,
        ]);
        const preferred = Number(item.score || 0) > Number(existing.score || 0)
          ? { ...existing, ...item }
          : { ...item, ...existing };
        mergedByQuery.set(mergeKey, {
          ...preferred,
          score: Math.max(existing.score || 0, item.score || 0),
          reason_tags: mergedReasonTags,
          evidence_ids: mergedEvidenceIds,
          matched_keywords: matchedKeywords,
          fulltext_fallback_used: Boolean(existing.fulltext_fallback_used) || run.fulltextFallback,
        });
      }
    }

    const lexicalRanked: RankedResultRow[] = [...mergedByQuery.values()]
      .map((item): RankedResultRow => {
        const matchedKeywords = Array.isArray(item.matched_keywords)
          ? uniqueStrings(item.matched_keywords.map(v => String(v)))
          : [query];
        const keywordBonus = Math.max(0, matchedKeywords.length - 1) * 0.12;
        const boosted = withRecencyBoost(
          Number(item.score || 0) + keywordBonus,
          typeof item.timestamp === "string" ? Date.parse(item.timestamp) : undefined,
          readTuning.recency.buckets,
        );
        return {
          ...item,
          matched_keywords: matchedKeywords,
          query_plan_keywords: plannedQueries,
          score: Number(boosted.toFixed(4)),
          reason_tags: uniqueStrings([
            ...(Array.isArray(item.reason_tags) ? item.reason_tags.map((v: string) => String(v)) : []),
            `keyword_hits:${matchedKeywords.length}`,
            `query_plan:${plannedQueries.length}`,
            Boolean(item.fulltext_fallback_used) ? "fulltext_fallback_used" : "",
          ]),
        };
      })
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
      .slice(0, maxCandidatePool);
    const isVectorSource = (value: string): boolean => value.startsWith("vector_");
    const semanticResults = lexicalRanked
      .filter(item => isVectorSource(item.source) && Array.isArray(item.reason_tags) && item.reason_tags.includes("vector_hit"))
      .slice(0, Math.max(1, args.topK));
    const keywordResults = lexicalRanked
      .filter(item => isVectorSource(item.source) && Array.isArray(item.reason_tags) && item.reason_tags.includes("lexical_hit"))
      .slice(0, Math.max(1, args.topK));
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
      fact_status: hit?.fact_status || "active",
      wiki_ref: hit?.wiki_ref || "",
      quality_score: hit?.quality_score ?? 0,
      timestamp: hit?.timestamp || "",
      evidence_ids: Array.isArray(hit?.evidence_ids) ? hit?.evidence_ids : [],
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
        fact_status: hit?.fact_status || "active",
        wiki_ref: hit?.wiki_ref || "",
        evidence_ids: Array.isArray(hit?.evidence_ids) ? hit?.evidence_ids : [],
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
          fact_status: item.fact_status || "active",
          wiki_ref: item.wiki_ref || "",
          quality_score: item.quality_score,
          timestamp: item.timestamp,
          evidence_ids: Array.isArray(item.evidence_ids) ? item.evidence_ids : [],
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
            fact_status: item.fact_status || "active",
            wiki_ref: item.wiki_ref || "",
            evidence_ids: Array.isArray(item.evidence_ids) ? item.evidence_ids : [],
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
          fact_status: item.fact_status || "active",
          wiki_ref: item.wiki_ref || "",
          quality_score: item.quality_score,
          timestamp: item.timestamp,
          evidence_ids: Array.isArray(item.evidence_ids) ? item.evidence_ids : [],
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
            fact_status: item.fact_status || "active",
            wiki_ref: item.wiki_ref || "",
            evidence_ids: Array.isArray(item.evidence_ids) ? item.evidence_ids : [],
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
          const fusedEvidenceIds = uniqueStrings(
            fusion.evidence_ids.flatMap(item => {
              const linked = ranked.find(candidate => candidate.id === item);
              if (!linked) return [item];
              const linkedEvidence = Array.isArray(linked.evidence_ids) ? linked.evidence_ids : [];
              return linkedEvidence.length > 0 ? linkedEvidence : [item];
            }),
          );
          const wikiRefs = uniqueStrings(
            fusion.evidence_ids.flatMap(item => {
              const linked = ranked.find(candidate => candidate.id === item);
              const wikiRef = typeof linked?.wiki_ref === "string" ? linked.wiki_ref : "";
              return wikiRef ? [wikiRef] : [];
            }),
          );
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
            evidence_ids: fusedEvidenceIds,
            wiki_refs: wikiRefs,
            fused_evidence_ids: fusedEvidenceIds,
            fused_need_fulltext_event_ids: fusion.need_fulltext_event_ids || [],
            fulltext_fetch_hints: fulltextFetchHints,
          };
          const authoritative = options.fusion?.authoritative !== false;
          if (authoritative) {
            markHit(Array.isArray(fusion.evidence_ids) ? fusion.evidence_ids : []);
            return {
              results: [fusedItem],
              semantic_results: semanticResults,
              keyword_results: keywordResults,
              strategy: "vector_sentence_and_keyword_parallel",
            };
          }
          const merged = [fusedItem, ...ranked];
          markHit([
            ...(Array.isArray(fusion.evidence_ids) ? fusion.evidence_ids : []),
            ...ranked.map(item => item.id),
          ]);
          return {
            results: merged.slice(0, Math.max(1, args.topK)),
            semantic_results: semanticResults,
            keyword_results: keywordResults,
            strategy: "vector_sentence_and_keyword_parallel",
          };
        }
      } catch (error) {
        options.logger.warn(`LLM fusion failed, fallback to reranked results: ${error}`);
      }
    }
    const finalRanked = ranked.slice(0, Math.max(1, args.topK));
    markHit(finalRanked.map(item => item.id));
    return {
      results: finalRanked,
      semantic_results: semanticResults,
      keyword_results: keywordResults,
      strategy: "vector_sentence_and_keyword_parallel",
    };
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

