import * as fs from "fs";
import * as path from "path";
import {
  buildCanonicalId,
  loadGraphSchema,
  normalizeEventType,
  validateRelations,
} from "../graph/ontology";

interface LoggerLike {
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
}

interface EmbeddingConfig {
  provider: string;
  model: string;
  apiKey?: string;
  baseURL?: string;
  baseUrl?: string;
  dimensions?: number;
  timeoutMs?: number;
  maxRetries?: number;
}

interface ExtractedEvent {
  event_type: string;
  summary: string;
  entities?: string[];
  relations?: Array<{ source: string; target: string; type: string }>;
  entity_types?: Record<string, string>;
  outcome?: string;
  session_id: string;
  source_file: string;
  confidence?: number;
  source_event_id?: string;
  actor?: string;
  canonical_id?: string;
}

interface StoredEvent extends ExtractedEvent {
  id: string;
  timestamp: string;
  quality_score: number;
  quality_level: "low" | "medium" | "high";
  embedding?: number[];
}

interface ArchiveStoreOptions {
  projectRoot: string;
  memoryRoot: string;
  logger: LoggerLike;
  embedding?: EmbeddingConfig;
  deduplicator: {
    check(input: { id: string; summary: string; embedding?: number[] }): { duplicate: boolean; stage?: string; matchedId?: string };
    append(input: { id: string; summary: string; embedding?: number[] }): void;
  };
  vectorStore: {
    upsert(record: {
      id: string;
      session_id: string;
      event_type: string;
      summary: string;
      timestamp: string;
      outcome?: string;
      entities?: string[];
      relations?: Array<{ source: string; target: string; type: string }>;
      embedding: number[];
      quality_score: number;
    }): Promise<void>;
  };
}

function normalizeBaseUrl(value?: string): string {
  if (!value) return "";
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function scoreQuality(text: string): { score: number; level: "low" | "medium" | "high" } {
  const length = text.length;
  const score = Math.max(0, Math.min(1, Number((Math.min(length, 320) / 320).toFixed(2))));
  if (score >= 0.75) {
    return { score, level: "high" };
  }
  if (score >= 0.4) {
    return { score, level: "medium" };
  }
  return { score, level: "low" };
}

async function requestEmbedding(args: {
  text: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  dimensions?: number;
  timeoutMs?: number;
  maxRetries?: number;
}): Promise<number[] | null> {
  const endpoint = args.baseUrl.endsWith("/embeddings") ? args.baseUrl : `${args.baseUrl}/embeddings`;
  const body: Record<string, unknown> = {
    input: args.text,
    model: args.model,
  };
  if (typeof args.dimensions === "number" && Number.isFinite(args.dimensions) && args.dimensions > 0) {
    body.dimensions = args.dimensions;
  }
  const timeoutMs = typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs) && args.timeoutMs >= 1000
    ? Math.floor(args.timeoutMs)
    : 20000;
  const maxRetries = typeof args.maxRetries === "number" && Number.isFinite(args.maxRetries) && args.maxRetries >= 1
    ? Math.min(8, Math.floor(args.maxRetries))
    : 4;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
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
    if (attempt < maxRetries - 1) {
      await new Promise(resolve => setTimeout(resolve, 300 * Math.pow(2, attempt)));
    }
  }
  if (lastError) {
    throw lastError;
  }
  return null;
}

function ensureDirForFile(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function createArchiveStore(options: ArchiveStoreOptions): {
  storeEvents(events: ExtractedEvent[]): Promise<{ stored: StoredEvent[]; skipped: Array<{ summary: string; reason: string }> }>;
} {
  const archivePath = path.join(options.memoryRoot, "sessions", "archive", "sessions.jsonl");
  const mutationLogPath = path.join(options.memoryRoot, "graph", "mutation_log.jsonl");
  const graphSchema = loadGraphSchema(options.projectRoot);

  async function storeEvents(events: ExtractedEvent[]): Promise<{ stored: StoredEvent[]; skipped: Array<{ summary: string; reason: string }> }> {
    const stored: StoredEvent[] = [];
    const skipped: Array<{ summary: string; reason: string }> = [];
    if (!events.length) {
      return { stored, skipped };
    }
    const lines: string[] = [];
    const mutationLines: string[] = [];
    for (const event of events) {
      const summary = (event.summary || "").trim();
      if (!summary) {
        skipped.push({ summary: "", reason: "empty_summary" });
        continue;
      }
      const confidence = typeof event.confidence === "number"
        ? Math.max(0, Math.min(1, event.confidence))
        : undefined;
      if (typeof confidence === "number" && confidence < 0.35) {
        skipped.push({ summary, reason: "low_confidence" });
        continue;
      }
      const quality = scoreQuality(summary);
      if (quality.level === "low") {
        skipped.push({ summary, reason: "low_quality" });
        continue;
      }
      const normalizedEventType = normalizeEventType(event.event_type || "insight", graphSchema);
      const entities = Array.isArray(event.entities)
        ? [...new Set(event.entities.map(item => (typeof item === "string" ? item.trim() : "")).filter(Boolean))]
        : [];
      const relationValidation = validateRelations({
        relations: Array.isArray(event.relations) ? event.relations : [],
        entities,
        entityTypes: event.entity_types,
        schema: graphSchema,
      });
      if (relationValidation.accepted.length === 0 && Array.isArray(event.relations) && event.relations.length > 0) {
        skipped.push({ summary, reason: "relation_validation_failed" });
        continue;
      }
      const id = `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      let embedding: number[] | undefined = undefined;
      const embeddingModel = options.embedding?.model || "";
      const embeddingApiKey = options.embedding?.apiKey || "";
      const embeddingBaseUrl = normalizeBaseUrl(options.embedding?.baseURL || options.embedding?.baseUrl);
      if (embeddingModel && embeddingApiKey && embeddingBaseUrl) {
        try {
          embedding = await requestEmbedding({
            text: summary,
            model: embeddingModel,
            apiKey: embeddingApiKey,
            baseUrl: embeddingBaseUrl,
            dimensions: options.embedding?.dimensions,
            timeoutMs: options.embedding?.timeoutMs,
            maxRetries: options.embedding?.maxRetries,
          }) || undefined;
        } catch (error) {
          options.logger.warn(`Archive embedding failed: ${error}`);
        }
      }
      const dedup = options.deduplicator.check({
        id,
        summary: `${normalizedEventType}: ${summary}`,
        embedding,
      });
      if (dedup.duplicate) {
        skipped.push({ summary, reason: `duplicate_${dedup.stage || "unknown"}` });
        continue;
      }
      const record: StoredEvent = {
        ...event,
        event_type: normalizedEventType,
        entities,
        relations: relationValidation.accepted,
        canonical_id: event.canonical_id || buildCanonicalId({
          eventType: normalizedEventType,
          summary,
          entities,
          relations: relationValidation.accepted,
          outcome: event.outcome,
        }),
        actor: event.actor || "system",
        confidence,
        id,
        timestamp: new Date().toISOString(),
        quality_score: quality.score,
        quality_level: quality.level,
        embedding,
      };
      lines.push(JSON.stringify(record));
      stored.push(record);
      options.deduplicator.append({
        id: record.id,
        summary: `${record.event_type}: ${summary}`,
        embedding: embedding,
      });
      mutationLines.push(JSON.stringify({
        op: "insert_event",
        id: record.id,
        canonical_id: record.canonical_id,
        source_event_id: record.source_event_id || "",
        actor: record.actor || "system",
        timestamp: record.timestamp,
        event_type: record.event_type,
        summary: record.summary,
      }));
      if (embedding && embedding.length > 0) {
        await options.vectorStore.upsert({
          id: record.id,
          session_id: record.session_id,
          event_type: record.event_type,
          summary: record.summary,
          timestamp: record.timestamp,
          outcome: record.outcome,
          entities: record.entities,
          relations: record.relations,
          embedding,
          quality_score: record.quality_score,
        });
      }
    }
    if (lines.length > 0) {
      ensureDirForFile(archivePath);
      fs.appendFileSync(archivePath, `${lines.join("\n")}\n`, "utf-8");
      ensureDirForFile(mutationLogPath);
      fs.appendFileSync(mutationLogPath, `${mutationLines.join("\n")}\n`, "utf-8");
    }
    return { stored, skipped };
  }

  options.logger.info(`Archive store initialized at ${archivePath}`);
  return { storeEvents };
}
