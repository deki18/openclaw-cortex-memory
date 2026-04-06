import * as fs from "fs";
import * as path from "path";
import {
  buildCanonicalId,
  loadGraphSchema,
  normalizeEventType,
} from "../graph/ontology";
import { validateJsonlLine } from "../quality/llm_output_validator";

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
  relations?: Array<{ source: string; target: string; type: string; evidence_span?: string; confidence?: number }>;
  entity_types?: Record<string, string>;
  outcome?: string;
  source_text?: string;
  session_id: string;
  source_file: string;
  confidence?: number;
  source_event_id?: string;
  actor?: string;
  canonical_id?: string;
}

interface StoredEvent {
  id: string;
  timestamp: string;
  layer: "archive";
  event_type: string;
  summary: string;
  source_text?: string;
  outcome?: string;
  session_id: string;
  source_file: string;
  gate_source: "sync" | "session_end" | "manual";
  embedding_status: "ok" | "failed" | "pending";
  quality_score: number;
  quality_level: "low" | "medium" | "high";
  char_count: number;
  token_count: number;
  vector_chunks_total?: number;
  vector_chunks_ok?: number;
  embedding?: number[];
  confidence?: number;
  source_event_id?: string;
  actor?: string;
  canonical_id?: string;
}

interface ArchiveStoreOptions {
  projectRoot: string;
  memoryRoot: string;
  logger: LoggerLike;
  embedding?: EmbeddingConfig;
  vectorChunking?: {
    chunkSize?: number;
    chunkOverlap?: number;
    evidenceMaxChunks?: number;
  };
  writePolicy?: {
    archiveMinConfidence?: number;
    archiveMinQualityScore?: number;
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
      embedding: number[];
      quality_score: number;
      layer: "active" | "archive";
      source_memory_id: string;
      source_memory_canonical_id?: string;
      source_field?: "summary" | "evidence";
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

function buildArchiveVectorText(event: ExtractedEvent, normalizedEventType: string): string {
  const lines = [
    `event_type: ${normalizedEventType}`,
    `summary: ${(event.summary || "").trim()}`,
    `outcome: ${(event.outcome || "").trim()}`,
    `source_file: ${(event.source_file || "").trim()}`,
  ].map(line => line.trim()).filter(Boolean);
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

function pickEvidenceChunks(
  chunks: Array<{ index: number; start: number; end: number; text: string }>,
  maxCount: number,
): Array<{ index: number; start: number; end: number; text: string }> {
  if (!chunks.length || maxCount <= 0) return [];
  if (chunks.length <= maxCount) return chunks;
  const picked = new Map<number, { index: number; start: number; end: number; text: string }>();
  picked.set(chunks[0].index, chunks[0]);
  if (maxCount >= 2) {
    const mid = chunks[Math.floor(chunks.length / 2)];
    picked.set(mid.index, mid);
  }
  if (maxCount >= 3) {
    const last = chunks[chunks.length - 1];
    picked.set(last.index, last);
  }
  if (picked.size < maxCount) {
    for (const chunk of chunks) {
      if (!picked.has(chunk.index)) {
        picked.set(chunk.index, chunk);
      }
      if (picked.size >= maxCount) break;
    }
  }
  return [...picked.values()].sort((a, b) => a.index - b.index).slice(0, maxCount);
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
  const mutationLogPath = path.join(options.memoryRoot, "sessions", "archive", "mutation_log.jsonl");
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
      const archiveMinConfidence = typeof options.writePolicy?.archiveMinConfidence === "number"
        ? Math.max(0, Math.min(1, options.writePolicy.archiveMinConfidence))
        : 0.35;
      if (typeof confidence === "number" && confidence < archiveMinConfidence) {
        skipped.push({ summary, reason: "low_confidence" });
        options.logger.info("archive_skip reason=filtered_low_quality detail=low_confidence");
        continue;
      }
      const quality = scoreQuality(summary);
      const archiveMinQualityScore = typeof options.writePolicy?.archiveMinQualityScore === "number"
        ? Math.max(0, Math.min(1, options.writePolicy.archiveMinQualityScore))
        : 0.4;
      if (quality.score < archiveMinQualityScore) {
        skipped.push({ summary, reason: "low_quality" });
        options.logger.info("archive_skip reason=filtered_low_quality detail=low_quality");
        continue;
      }
      const normalizedEventType = normalizeEventType(event.event_type || "insight", graphSchema);
      const id = `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const sourceText = typeof event.source_text === "string" ? event.source_text.trim().slice(0, 12000) : "";
      let embedding: number[] | undefined = undefined;
      let embeddingStatus: "ok" | "failed" | "pending" = "pending";
      let vectorChunksTotal = 0;
      let vectorChunksOk = 0;
      const vectorUpsertRows: Array<{
        id: string;
        summary: string;
        embedding: number[];
        source_field?: "summary" | "evidence";
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
        const evidenceMaxChunks = typeof options.vectorChunking?.evidenceMaxChunks === "number"
          ? Math.max(0, Math.min(8, Math.floor(options.vectorChunking.evidenceMaxChunks)))
          : 2;
        const summaryText = buildArchiveVectorText(event, normalizedEventType);
        const evidenceChunks = sourceText
          ? pickEvidenceChunks(splitTextChunks(sourceText, chunkSize, chunkOverlap), evidenceMaxChunks)
          : [];
        const embeddingInputs: Array<{
          text: string;
          source_field: "summary" | "evidence";
          index: number;
          total: number;
          start: number;
          end: number;
        }> = [
          {
            text: summaryText,
            source_field: "summary",
            index: 0,
            total: 1 + evidenceChunks.length,
            start: 0,
            end: summaryText.length,
          },
          ...evidenceChunks.map((chunk, idx) => ({
            text: chunk.text,
            source_field: "evidence" as const,
            index: idx + 1,
            total: 1 + evidenceChunks.length,
            start: chunk.start,
            end: chunk.end,
          })),
        ];
        vectorChunksTotal = embeddingInputs.length;
        const chunkEmbeddings = await mapWithConcurrency(embeddingInputs, maxParallel, async (chunk) => {
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
            options.logger.warn(`Archive chunk embedding failed id=${id} chunk=${chunk.index} field=${chunk.source_field} error=${error}`);
            return null;
          }
        });
        const validEmbeddings = chunkEmbeddings
          .filter((item): item is { chunk: { text: string; source_field: "summary" | "evidence"; index: number; total: number; start: number; end: number }; embedding: number[] } => Boolean(item))
          .sort((a, b) => a.chunk.index - b.chunk.index);
        const primary = validEmbeddings.find(item => item.chunk.source_field === "summary");
        if (primary) {
          embedding = primary.embedding;
        } else if (validEmbeddings.length > 0) {
          embedding = validEmbeddings[0].embedding;
        }
        for (const item of validEmbeddings) {
          vectorUpsertRows.push({
            id: `${id}_c${item.chunk.index}`,
            summary: item.chunk.text,
            embedding: item.embedding,
            source_field: item.chunk.source_field,
            chunk_index: item.chunk.index,
            chunk_total: item.chunk.total,
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
        id,
        timestamp: new Date().toISOString(),
        layer: "archive",
        event_type: normalizedEventType,
        summary,
        source_text: sourceText || undefined,
        outcome: event.outcome,
        session_id: event.session_id,
        source_file: event.source_file,
        gate_source: gateSource,
        embedding_status: embeddingStatus,
        quality_score: quality.score,
        quality_level: quality.level,
        char_count: (sourceText || summary).length,
        token_count: estimateTokenCount(sourceText || summary),
        vector_chunks_total: vectorChunksTotal,
        vector_chunks_ok: vectorChunksOk,
        embedding,
        confidence,
        source_event_id: event.source_event_id,
        actor: event.actor || "system",
        canonical_id: event.canonical_id || buildCanonicalId({
          eventType: normalizedEventType,
          summary,
          outcome: event.outcome,
        }),
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
              embedding: chunkRow.embedding,
              quality_score: record.quality_score,
              layer: "archive",
              source_memory_id: record.id,
              source_memory_canonical_id: record.canonical_id,
              source_field: chunkRow.source_field,
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
      for (let i = 0; i < lines.length; i++) {
        const validation = validateJsonlLine(lines[i]);
        if (!validation.valid && validation.errors.length > 0) {
          options.logger.warn(`archive_write_integrity_check_failed line=${i} errors=${validation.errors.join("|")}`);
        }
      }
      ensureDirForFile(mutationLogPath);
      fs.appendFileSync(mutationLogPath, `${mutationLines.join("\n")}\n`, "utf-8");
    }
    return { stored, skipped };
  }

  options.logger.info(`Archive store initialized at ${archivePath}`);
  return { storeEvents };
}
