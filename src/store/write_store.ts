import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { validateJsonlLine } from "../quality/llm_output_validator";

interface LoggerLike {
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
}

export interface WriteMemoryArgs {
  text: string;
  role: string;
  source: string;
  sessionId: string;
}

export interface WriteMemoryResult {
  status: "ok" | "skipped";
  memory_id?: string;
  reason?: string;
  error_code?: string;
  quality?: {
    level: "low" | "medium" | "high";
    score: number;
  };
}

interface WriteStoreOptions {
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
    timeoutMs?: number;
    maxRetries?: number;
  };
  vectorChunking?: {
    chunkSize?: number;
    chunkOverlap?: number;
  };
  writePolicy?: {
    activeMinQualityScore?: number;
    activeDedupTailLines?: number;
  };
  vectorStore?: {
    upsert(record: {
      id: string;
      session_id: string;
      event_type: string;
      summary: string;
      timestamp: string;
      layer: "active" | "archive";
      source_memory_id: string;
      source_memory_canonical_id?: string;
      source_field?: "summary" | "evidence";
      outcome?: string;
      entities?: string[];
      relations?: Array<{ source: string; target: string; type: string; evidence_span?: string; confidence?: number }>;
      embedding: number[];
      quality_score: number;
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

interface PersistedRecord {
  id: string;
  timestamp: string;
  session_id: string;
  role: string;
  source: string;
  content: string;
  layer: "active";
  embedding_status: "ok" | "failed" | "pending";
  llm_gate_decision: "active_only" | "archive_event" | "skip";
  quality_level: "low" | "medium" | "high";
  quality_score: number;
  text_hash: string;
  char_count: number;
  token_count: number;
  vector_chunks_total?: number;
  vector_chunks_ok?: number;
  embedding?: number[];
}

function normalizeText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function scoreQuality(text: string): { score: number; level: "low" | "medium" | "high" } {
  const length = text.length;
  const uniqueChars = new Set(text.toLowerCase()).size;
  let score = 0;
  if (length >= 20) score += 0.35;
  if (length >= 60) score += 0.2;
  if (length >= 120) score += 0.2;
  if (uniqueChars >= 10) score += 0.15;
  if (/\d/.test(text)) score += 0.05;
  if (/[a-zA-Z\u4e00-\u9fa5]/.test(text)) score += 0.05;
  const normalizedScore = Math.max(0, Math.min(1, Number(score.toFixed(2))));
  if (normalizedScore >= 0.75) {
    return { score: normalizedScore, level: "high" };
  }
  if (normalizedScore >= 0.45) {
    return { score: normalizedScore, level: "medium" };
  }
  return { score: normalizedScore, level: "low" };
}

function ensureDirForFile(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function safeReadTailLines(filePath: string, maxLines: number): string[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (lines.length <= maxLines) {
    return lines;
  }
  return lines.slice(lines.length - maxLines);
}

function computeHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function estimateTokenCount(text: string): number {
  const parts = text
    .split(/[\s,.;:!?，。；：！？、()（）[\]{}"'`~]+/)
    .map(part => part.trim())
    .filter(Boolean);
  return parts.length;
}

function normalizeBaseUrl(value?: string): string {
  if (!value) return "";
  return value.endsWith("/") ? value.slice(0, -1) : value;
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
  if (!text.trim()) {
    return output;
  }
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
    if (nextCursor <= cursor) {
      cursor = end;
    } else {
      cursor = nextCursor;
    }
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

export function createWriteStore(options: WriteStoreOptions): { writeMemory(args: WriteMemoryArgs): Promise<WriteMemoryResult> } {
  const memoryRoot = options.dbPath ? path.resolve(options.dbPath) : path.join(options.projectRoot, "data", "memory");
  const activeSessionsPath = path.join(memoryRoot, "sessions", "active", "sessions.jsonl");

  async function writeMemory(args: WriteMemoryArgs): Promise<WriteMemoryResult> {
    const cleaned = normalizeText(args.text || "");
    if (!cleaned) {
      return { status: "skipped", reason: "empty_text", error_code: "E204" };
    }

    const quality = scoreQuality(cleaned);
    const activeMinQualityScore = typeof options.writePolicy?.activeMinQualityScore === "number"
      ? Math.max(0, Math.min(1, options.writePolicy.activeMinQualityScore))
      : 0.45;
    if (quality.score < activeMinQualityScore) {
      return { status: "skipped", reason: "low_quality", error_code: "E204", quality };
    }

    const textHash = computeHash(cleaned);
    try {
      const dedupTailLines = typeof options.writePolicy?.activeDedupTailLines === "number"
        ? Math.max(20, Math.min(5000, Math.floor(options.writePolicy.activeDedupTailLines)))
        : 200;
      const tailLines = safeReadTailLines(activeSessionsPath, dedupTailLines);
      for (const line of tailLines) {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (
            parsed.session_id === args.sessionId &&
            parsed.role === args.role &&
            parsed.text_hash === textHash
          ) {
            return { status: "skipped", reason: "duplicate", error_code: "E203", quality };
          }
        } catch {}
      }
    } catch (error) {
      options.logger.warn(`Failed to evaluate write dedup, continue write: ${error}`);
    }

    const id = `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const record: PersistedRecord = {
      id,
      timestamp: new Date().toISOString(),
      session_id: args.sessionId,
      role: args.role || "user",
      source: args.source || "message",
      content: cleaned,
      layer: "active",
      embedding_status: "pending",
      llm_gate_decision: "active_only",
      quality_level: quality.level,
      quality_score: quality.score,
      text_hash: textHash,
      char_count: cleaned.length,
      token_count: estimateTokenCount(cleaned),
    };
    const embeddingModel = options.embedding?.model || "";
    const embeddingApiKey = options.embedding?.apiKey || "";
    const embeddingBaseUrl = normalizeBaseUrl(options.embedding?.baseURL || options.embedding?.baseUrl);
    const chunkSize = options.vectorChunking?.chunkSize ?? 600;
    const chunkOverlap = options.vectorChunking?.chunkOverlap ?? 100;
    const maxParallel = 6;
    const vectorStore = options.vectorStore;
    if (embeddingModel && embeddingApiKey && embeddingBaseUrl && vectorStore) {
      const chunks = splitTextChunks(cleaned, chunkSize, chunkOverlap);
      record.vector_chunks_total = chunks.length;
      record.vector_chunks_ok = 0;
      try {
        await vectorStore.deleteBySourceMemory({ layer: "active", sourceMemoryId: record.id });
      } catch (error) {
        options.logger.warn(`Active vector cleanup failed before upsert: ${error}`);
      }
      const chunkEmbeddings = await mapWithConcurrency(chunks, maxParallel, async (chunk) => {
        try {
          const embedding = await requestEmbedding({
            text: chunk.text,
            model: embeddingModel,
            apiKey: embeddingApiKey,
            baseUrl: embeddingBaseUrl,
            dimensions: options.embedding?.dimensions,
            timeoutMs: options.embedding?.timeoutMs,
            maxRetries: options.embedding?.maxRetries,
          });
          if (!embedding || embedding.length === 0) {
            return null;
          }
          return { chunk, embedding };
        } catch (error) {
          options.logger.warn(`Active chunk embedding failed id=${record.id} chunk=${chunk.index} error=${error}`);
          return null;
        }
      });
      const validEmbeddings = chunkEmbeddings
        .filter((item): item is { chunk: { index: number; start: number; end: number; text: string }; embedding: number[] } => Boolean(item))
        .sort((a, b) => a.chunk.index - b.chunk.index);
      if (validEmbeddings.length > 0) {
        record.embedding = validEmbeddings[0].embedding;
      }
      const upsertStatus = await mapWithConcurrency(validEmbeddings, maxParallel, async (item) => {
        const { chunk, embedding } = item;
        try {
          await vectorStore.upsert({
            id: `vec_${record.id}_c${chunk.index}`,
            session_id: record.session_id,
            event_type: "message",
            summary: chunk.text,
            timestamp: record.timestamp,
            layer: "active",
            source_memory_id: record.id,
            source_memory_canonical_id: record.id,
            embedding,
            quality_score: record.quality_score,
            char_count: chunk.text.length,
            token_count: estimateTokenCount(chunk.text),
            chunk_index: chunk.index,
            chunk_total: chunks.length,
            chunk_start: chunk.start,
            chunk_end: chunk.end,
          });
          return true;
        } catch (error) {
          options.logger.warn(`Active chunk embedding failed id=${record.id} chunk=${chunk.index} error=${error}`);
          return false;
        }
      });
      record.vector_chunks_ok = upsertStatus.filter(Boolean).length;
      record.embedding_status = record.vector_chunks_total > 0 && record.vector_chunks_ok === record.vector_chunks_total
        ? "ok"
        : "failed";
    }

    ensureDirForFile(activeSessionsPath);
    const recordLine = JSON.stringify(record);
    fs.appendFileSync(activeSessionsPath, `${recordLine}\n`, "utf-8");
    const validation = validateJsonlLine(recordLine);
    if (!validation.valid && validation.errors.length > 0) {
      options.logger.warn(`active_write_integrity_check_failed errors=${validation.errors.join("|")}`);
    }
    if (record.vector_chunks_total && record.vector_chunks_total > 0) {
      options.logger.info(`active_vector_chunks source=${record.id} ok=${record.vector_chunks_ok || 0}/${record.vector_chunks_total}`);
    }
    options.logger.info(`TS write stored message for session ${args.sessionId}`);
    return { status: "ok", memory_id: id, quality };
  }

  options.logger.debug(`TS write store initialized at ${memoryRoot}`);
  return { writeMemory };
}
