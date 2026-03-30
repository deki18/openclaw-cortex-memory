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
  layer: "archive";
  gate_source: "sync" | "session_end" | "manual";
  embedding_status: "ok" | "failed" | "pending";
  quality_score: number;
  quality_level: "low" | "medium" | "high";
  char_count: number;
  token_count: number;
  vector_chunks_total?: number;
  vector_chunks_ok?: number;
  embedding?: number[];
}

interface ArchiveStoreOptions {
  projectRoot: string;
  memoryRoot: string;
  logger: LoggerLike;
  embedding?: EmbeddingConfig;
  vectorChunking?: {
    chunkSize?: number;
    chunkOverlap?: number;
  };
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
      layer: "active" | "archive";
      source_memory_id: string;
      source_memory_canonical_id?: string;
      char_count: number;
      token_count: number;
      chunk_index?: number;
      chunk_total?: number;
      chunk_start?: number;
      chunk_end?: number;
    }): Promise<void>;
    deleteBySourceMemory(args: { layer: "active" | "archive"; sourceMemoryId: string }): Promise<void>;
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

function estimateTokenCount(text: string): number {
  const parts = text
    .split(/[\s,.;:!?，。；：！？、()（）[\]{}"'`~]+/)
    .map(part => part.trim())
    .filter(Boolean);
  return parts.length;
}

function inferGateSource(event: ExtractedEvent): "sync" | "session_end" | "manual" {
  const sourceFile = (event.source_file || "").toLowerCase();
  const actor = (event.actor || "").toLowerCase();
  if (sourceFile.includes("session_end") || actor.includes("session_end")) {
    return "session_end";
  }
  if (sourceFile.includes("sync") || actor.includes("sync")) {
    return "sync";
  }
  return "manual";
}

function buildArchiveVectorText(event: ExtractedEvent, normalizedEventType: string, entities: string[]): string {
  const lines = [
    `event_type: ${normalizedEventType}`,
    `summary: ${(event.summary || "").trim()}`,
    `outcome: ${(event.outcome || "").trim()}`,
    `entities: ${entities.join(", ")}`,
    `source_file: ${(event.source_file || "").trim()}`,
    `actor: ${(event.actor || "").trim()}`,
  ].map(line => line.trim()).filter(Boolean);
  if (Array.isArray(event.relations) && event.relations.length > 0) {
    const relationLines = event.relations
      .map(relation => {
        if (!relation || typeof relation !== "object") return "";
        const source = typeof relation.source === "string" ? relation.source.trim() : "";
        const target = typeof relation.target === "string" ? relation.target.trim() : "";
        const type = typeof relation.type === "string" ? relation.type.trim() : "related_to";
        if (!source || !target) return "";
        return `${source} -[${type}]-> ${target}`;
      })
      .filter(Boolean);
    if (relationLines.length > 0) {
      lines.push(`relations: ${relationLines.join(" ; ")}`);
    }
  }
  return lines.join("\n").trim();
}

function splitTextChunks(text: string, chunkSize: number, chunkOverlap: number): Array<{
  index: number;
  start: number;
  end: number;
  text: string;
}> {
  const normalizedSize = Number.isFinite(chunkSize) && chunkSize >= 200 ? Math.floor(chunkSize) : 600;
  const normalizedOverlap = Number.isFinite(chunkOverlap) && chunkOverlap >= 0
    ? Math.floor(chunkOverlap)
    : 100;
  const overlap = Math.min(normalizedOverlap, Math.max(0, normalizedSize - 50));
  const output: Array<{ index: number; start: number; end: number; text: string }> = [];
  let cursor = 0;
  let index = 0;
  const punctuationSet = new Set(["。", "！", "？", ".", "!", "?", "\n", "；", ";"]);
  while (cursor < text.length) {
    const rawEnd = Math.min(text.length, cursor + normalizedSize);
    let end = rawEnd;
    if (rawEnd < text.length) {
      const backwardStart = Math.max(cursor + Math.floor(normalizedSize * 0.45), cursor + 1);
      let found = -1;
      for (let i = rawEnd - 1; i >= backwardStart; i -= 1) {
        if (punctuationSet.has(text[i])) {
          found = i + 1;
          break;
        }
      }
      if (found < 0) {
        const forwardEnd = Math.min(text.length, rawEnd + Math.floor(normalizedSize * 0.2));
        for (let i = rawEnd; i < forwardEnd; i += 1) {
          if (punctuationSet.has(text[i])) {
            found = i + 1;
            break;
          }
        }
      }
      if (found > cursor) {
        end = found;
      }
    }
    if (end <= cursor) {
      end = Math.min(text.length, cursor + normalizedSize);
    }
    const chunkText = text.slice(cursor, end).trim();
    if (chunkText) {
      output.push({ index, start: cursor, end, text: chunkText });
      index += 1;
    }
    if (end >= text.length) {
      break;
    }
    const nextCursor = Math.max(cursor + 1, end - overlap);
    cursor = nextCursor <= cursor ? end : nextCursor;
  }
  return output;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  maxConcurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const concurrency = Math.max(1, Math.min(maxConcurrency, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const current = cursor;
      cursor += 1;
      if (current >= items.length) {
        break;
      }
      results[current] = await mapper(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
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
        options.logger.info("archive_skip reason=empty_summary");
        continue;
      }
      const confidence = typeof event.confidence === "number"
        ? Math.max(0, Math.min(1, event.confidence))
        : undefined;
      if (typeof confidence === "number" && confidence < 0.35) {
        skipped.push({ summary, reason: "low_confidence" });
        options.logger.info("archive_skip reason=filtered_low_quality detail=low_confidence");
        continue;
      }
      const quality = scoreQuality(summary);
      if (quality.level === "low") {
        skipped.push({ summary, reason: "low_quality" });
        options.logger.info("archive_skip reason=filtered_low_quality detail=low_quality");
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
        options.logger.info("archive_skip reason=relation_validation_failed");
        continue;
      }
      const id = `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      let embedding: number[] | undefined = undefined;
      let embeddingStatus: "ok" | "failed" | "pending" = "pending";
      let vectorChunksTotal = 0;
      let vectorChunksOk = 0;
      const vectorUpsertRows: Array<{
        id: string;
        summary: string;
        embedding: number[];
        chunk_index: number;
        chunk_total: number;
        chunk_start: number;
        chunk_end: number;
      }> = [];
      const embeddingModel = options.embedding?.model || "";
      const embeddingApiKey = options.embedding?.apiKey || "";
      const embeddingBaseUrl = normalizeBaseUrl(options.embedding?.baseURL || options.embedding?.baseUrl);
      const maxParallel = 6;
      if (embeddingModel && embeddingApiKey && embeddingBaseUrl) {
        const chunkSize = options.vectorChunking?.chunkSize ?? 600;
        const chunkOverlap = options.vectorChunking?.chunkOverlap ?? 100;
        const vectorText = buildArchiveVectorText(event, normalizedEventType, entities);
        const chunks = splitTextChunks(vectorText, chunkSize, chunkOverlap);
        vectorChunksTotal = chunks.length;
        const chunkEmbeddings = await mapWithConcurrency(chunks, maxParallel, async (chunk) => {
          try {
            const chunkEmbedding = await requestEmbedding({
              text: chunk.text,
              model: embeddingModel,
              apiKey: embeddingApiKey,
              baseUrl: embeddingBaseUrl,
              dimensions: options.embedding?.dimensions,
              timeoutMs: options.embedding?.timeoutMs,
              maxRetries: options.embedding?.maxRetries,
            }) || undefined;
            if (chunkEmbedding && chunkEmbedding.length > 0) {
              return {
                chunk,
                embedding: chunkEmbedding,
              };
            }
            return null;
          } catch (error) {
            options.logger.warn(`Archive chunk embedding failed id=${id} chunk=${chunk.index} error=${error}`);
            return null;
          }
        });
        const validEmbeddings = chunkEmbeddings
          .filter((item): item is { chunk: { index: number; start: number; end: number; text: string }; embedding: number[] } => Boolean(item))
          .sort((a, b) => a.chunk.index - b.chunk.index);
        if (validEmbeddings.length > 0) {
          embedding = validEmbeddings[0].embedding;
        }
        for (const item of validEmbeddings) {
          vectorUpsertRows.push({
            id: `${id}_c${item.chunk.index}`,
            summary: item.chunk.text,
            embedding: item.embedding,
            chunk_index: item.chunk.index,
            chunk_total: chunks.length,
            chunk_start: item.chunk.start,
            chunk_end: item.chunk.end,
          });
        }
        vectorChunksOk = validEmbeddings.length;
        embeddingStatus = vectorChunksTotal > 0 && vectorChunksOk === vectorChunksTotal ? "ok" : "failed";
      }
      const dedup = options.deduplicator.check({
        id,
        summary: `${normalizedEventType}: ${summary}`,
        embedding,
      });
      if (dedup.duplicate) {
        skipped.push({ summary, reason: `duplicate_${dedup.stage || "unknown"}` });
        options.logger.info(`archive_skip reason=duplicate_dedup_stage_${dedup.stage || "unknown"}`);
        continue;
      }
      const gateSource = inferGateSource(event);
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
        layer: "archive",
        gate_source: gateSource,
        embedding_status: embeddingStatus,
        quality_score: quality.score,
        quality_level: quality.level,
        char_count: buildArchiveVectorText(event, normalizedEventType, entities).length,
        token_count: estimateTokenCount(buildArchiveVectorText(event, normalizedEventType, entities)),
        vector_chunks_total: vectorChunksTotal,
        vector_chunks_ok: vectorChunksOk,
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
      options.logger.info(`archive_write reason=archived_success gate_source=${record.gate_source} id=${record.id}`);
      if (vectorUpsertRows.length > 0) {
        await options.vectorStore.deleteBySourceMemory({ layer: "archive", sourceMemoryId: record.id });
        const upsertResults = await mapWithConcurrency(vectorUpsertRows, maxParallel, async (chunkRow) => {
          try {
            await options.vectorStore.upsert({
              id: chunkRow.id,
              session_id: record.session_id,
              event_type: record.event_type,
              summary: chunkRow.summary,
              timestamp: record.timestamp,
              outcome: record.outcome,
              entities: record.entities,
              relations: record.relations,
              embedding: chunkRow.embedding,
              quality_score: record.quality_score,
              layer: "archive",
              source_memory_id: record.id,
              source_memory_canonical_id: record.canonical_id,
              char_count: chunkRow.summary.length,
              token_count: estimateTokenCount(chunkRow.summary),
              chunk_index: chunkRow.chunk_index,
              chunk_total: chunkRow.chunk_total,
              chunk_start: chunkRow.chunk_start,
              chunk_end: chunkRow.chunk_end,
            });
            return true;
          } catch (error) {
            options.logger.warn(`Archive chunk upsert failed id=${record.id} chunk=${chunkRow.chunk_index} error=${error}`);
            return false;
          }
        });
        const upsertOk = upsertResults.filter(Boolean).length;
        if (upsertOk !== vectorUpsertRows.length) {
          options.logger.warn(`archive_vector_upsert_partial id=${record.id} ok=${upsertOk}/${vectorUpsertRows.length}`);
        }
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
