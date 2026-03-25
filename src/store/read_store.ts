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
      docs.push({
        id,
        text,
        source: sourceLabel,
        timestamp: Number.isFinite(timestampValue) ? timestampValue : undefined,
        embedding: Array.isArray(parsed.embedding) ? parsed.embedding.filter(item => Number.isFinite(item as number)) as number[] : undefined,
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

function normalizeBaseUrl(value?: string): string {
  if (!value) return "";
  return value.endsWith("/") ? value.slice(0, -1) : value;
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

export function createReadStore(options: ReadStoreOptions): ReadStore {
  const memoryRoot = options.dbPath ? path.resolve(options.dbPath) : path.join(options.projectRoot, "data", "memory");

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
    const lexicalRanked = docs
      .map(doc => {
        const lexicalScore = scoreText(query, doc.text);
        const semanticScore = queryEmbedding && Array.isArray(doc.embedding) && doc.embedding.length > 0
          ? Math.max(0, cosineSimilarity(queryEmbedding, doc.embedding) * 5)
          : 0;
        const hybrid = lexicalScore + semanticScore;
        const total = withRecencyBoost(hybrid, doc.timestamp);
        return { doc, score: total };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.max(args.topK, 12)))
      .map(item => ({
        id: item.doc.id,
        text: item.doc.text,
        source: item.doc.source,
        score: Number(item.score.toFixed(4)),
      }));
    const rerankerModel = options.reranker?.model || "";
    const rerankerApiKey = options.reranker?.apiKey || "";
    const rerankerBaseUrl = normalizeBaseUrl(options.reranker?.baseURL || options.reranker?.baseUrl);
    let ranked = lexicalRanked;
    if (rerankerModel && rerankerApiKey && rerankerBaseUrl && lexicalRanked.length > 1) {
      try {
        ranked = await requestRerank({
          query,
          candidates: lexicalRanked,
          model: rerankerModel,
          apiKey: rerankerApiKey,
          baseUrl: rerankerBaseUrl,
        });
      } catch (error) {
        options.logger.warn(`Reranker failed, keep hybrid ranking: ${error}`);
      }
    }
    ranked = ranked.slice(0, Math.max(1, args.topK)).map(item => ({
      id: item.id,
      text: item.text,
      source: item.source,
      score: Number(item.score.toFixed(4)),
    }));
    return { results: ranked };
  }

  async function getHotContext(args: ReadStoreHotArgs): Promise<{ context: unknown[] }> {
    const limit = Math.max(1, args.limit);
    const docs = loadAllDocuments();
    const coreRules = docs.find(doc => doc.source === "CORTEX_RULES.md");
    const sessionDocs = docs
      .filter(doc => doc.source.startsWith("sessions_"))
      .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
      .slice(0, limit);
    const result: Array<{ id: string; text: string; source: string }> = [];
    if (coreRules) {
      result.push({ id: coreRules.id, text: coreRules.text, source: coreRules.source });
    }
    for (const doc of sessionDocs) {
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
