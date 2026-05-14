import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { postJsonWithTimeout } from "../net/http_post";
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
  summary?: string;
  sourceText?: string;
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
    activeTextMaxChars?: number;
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
      source_event_id?: string;
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
  summary?: string;
  source_text?: string;
  layer: "active";
  source_memory_id?: string;
  source_memory_canonical_id?: string;
  source_event_id?: string;
  canonical_id?: string;
  embedding_status: "ok" | "failed" | "pending";
  llm_gate_decision: "active_only" | "archive_event" | "skip";
  quality_level: "low" | "medium" | "high";
  quality_score: number;
  text_hash: string;
  semantic_hash?: string;
  semantic_simhash?: string;
  char_count: number;
  token_count: number;
  vector_chunks_total?: number;
  vector_chunks_ok?: number;
  embedding?: number[];
}

const ACTIVE_LOW_INFORMATION_LINE = /^(ok|okay|got it|roger|noted|sure|thanks|thank you|received|copy that|understood|好的|收到|明白|了解|谢谢|感谢|可以|行|嗯|嗯嗯|没问题)(?:\b|$)/i;
const ACTIVE_LOW_VALUE_ONLY = /^(ok|okay|got it|roger|noted|thanks|thank you|received|copy that|understood|sounds good|好的|收到|明白|了解|谢谢|感谢|可以|行|嗯|嗯嗯|没问题|辛苦了)[\s.!?,。！？、]*$/i;
const ACTIVE_SEMANTIC_SIGNAL = /(decision|trade-?off|constraint|requirement|fix|error|exception|blocked|rollback|deploy|progress|milestone|action item|owner|next step|todo|deadline|eta|issue|bug|metric|latency|error rate|cost|url|link|path|file|config|parameter|version|commit|pr|ticket|test|verify|passed|failed|success|import|memory|wiki|决策|决定|取舍|约束|需求|要求|修复|错误|异常|阻塞|回滚|部署|进展|里程碑|行动项|负责人|下一步|待办|截止|问题|缺陷|指标|延迟|成本|链接|路径|文件|配置|参数|版本|提交|工单|测试|验证|通过|失败|成功|优化|导入|记忆|wiki)/i;
const ACTIVE_EVIDENCE_SIGNAL = /(https?:\/\/|www\.|[`#/:\\]|[A-Za-z]:\\|\/[A-Za-z0-9._\-\/]+|\b\d+(?:\.\d+)?%?\b|#\d{1,8}|npm run|pnpm |yarn |node |git )/i;
const ACTIVE_WORKFLOW_SIGNAL = /(done|completed|fixed|implemented|resolved|passed|verified|accepted|approved|已完成|完成了|修复了|实现了|已修复|已实现|已通过|通过了|验证通过|测试通过|接受|确认)/i;

function denoiseActiveText(input: string): string {
  const raw = (input || "").trim();
  if (!raw) return "";
  const output: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const content = trimmed.replace(/^\[[^\]]+\]\s*/, "").trim();
    if (!content) continue;
    const hasSignal = /(https?:\/\/|www\.|[A-Za-z0-9._-]+\.[A-Za-z]{2,}|[`#/:\\]|@\w+|\b\d{2,}\b)/.test(content);
    if (!hasSignal && ACTIVE_LOW_INFORMATION_LINE.test(content)) {
      continue;
    }
    const dedupKey = content.toLowerCase();
    if (!hasSignal && seen.has(dedupKey)) {
      continue;
    }
    seen.add(dedupKey);
    output.push(trimmed);
  }
  return output.length > 0 ? output.join("\n") : raw;
}

function normalizeText(input: string, maxChars: number): string {
  const cleaned = denoiseActiveText(input);
  if (!cleaned) return "";
  if (!Number.isFinite(maxChars) || maxChars <= 0 || cleaned.length <= maxChars) {
    return cleaned;
  }
  return cleaned.slice(-Math.floor(maxChars)).trim();
}

function normalizeSummary(input: string): string {
  return String(input || "").replace(/\s+/g, " ").trim();
}

function normalizeSemanticText(input: string): string {
  return String(input || "")
    .replace(/^\[[^\]]+\]\s*/gm, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}:./\\#@_-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildSimilarityTokens(input: string): string[] {
  const normalized = normalizeSemanticText(input);
  if (!normalized) return [];
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const output = new Set<string>();
  for (const token of tokens) {
    output.add(token);
    const cjkChars = [...token].filter(char => /[\u3400-\u9fff]/.test(char));
    if (cjkChars.length > 1) {
      for (let index = 0; index < cjkChars.length - 1; index += 1) {
        output.add(`${cjkChars[index]}${cjkChars[index + 1]}`);
      }
    }
  }
  return [...output];
}

function hashToken64(value: string): bigint {
  const digest = crypto.createHash("sha1").update(value).digest();
  let output = 0n;
  for (let index = 0; index < 8; index += 1) {
    output = (output << 8n) + BigInt(digest[index]);
  }
  return output;
}

function computeSimhashHex(text: string): string {
  const tokens = buildSimilarityTokens(text);
  const vector = Array.from({ length: 64 }, () => 0);
  for (const token of tokens) {
    const hash = hashToken64(token);
    for (let bit = 0; bit < 64; bit += 1) {
      vector[bit] += (hash & (1n << BigInt(bit))) !== 0n ? 1 : -1;
    }
  }
  let result = 0n;
  for (let bit = 0; bit < 64; bit += 1) {
    if (vector[bit] >= 0) {
      result |= 1n << BigInt(bit);
    }
  }
  return result.toString(16).padStart(16, "0");
}

function hammingDistanceHex(left: string, right: string): number {
  let value = BigInt(`0x${left || "0"}`) ^ BigInt(`0x${right || "0"}`);
  let count = 0;
  while (value > 0n) {
    count += Number(value & 1n);
    value >>= 1n;
  }
  return count;
}

function seedHash(seed: number, token: string): number {
  return crypto.createHash("sha1").update(`${seed}:${token}`).digest().readUInt32BE(0);
}

function computeMinhash(text: string, signatures = 48): number[] {
  const tokens = buildSimilarityTokens(text);
  if (tokens.length === 0) return Array.from({ length: signatures }, () => 0);
  const output: number[] = [];
  for (let seed = 0; seed < signatures; seed += 1) {
    let min = Number.MAX_SAFE_INTEGER;
    for (const token of tokens) {
      const value = seedHash(seed, token);
      if (value < min) min = value;
    }
    output.push(min === Number.MAX_SAFE_INTEGER ? 0 : min);
  }
  return output;
}

function minhashSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const size = Math.min(left.length, right.length);
  let same = 0;
  for (let index = 0; index < size; index += 1) {
    if (left[index] === right[index]) same += 1;
  }
  return same / size;
}

function buildActiveDedupText(args: { text: string; summary?: string; sourceText?: string }): string {
  const summary = normalizeSummary(args.summary || "");
  const text = normalizeSummary(args.text || "");
  const sourceText = normalizeSummary(args.sourceText || "");
  const base = summary || text;
  return base || sourceText;
}

function scoreQuality(args: { text: string; summary?: string; sourceText?: string }): { score: number; level: "low" | "medium" | "high" } {
  const text = args.text;
  const summary = normalizeSummary(args.summary || "");
  const sourceText = normalizeSummary(args.sourceText || "");
  const merged = [summary, text, sourceText].filter(Boolean).join("\n");
  const normalized = normalizeSemanticText(merged);
  if (!normalized || ACTIVE_LOW_VALUE_ONLY.test(normalized)) {
    return { score: 0, level: "low" };
  }
  const length = text.length;
  const uniqueChars = new Set(normalized).size;
  const hasSemanticSignal = ACTIVE_SEMANTIC_SIGNAL.test(merged);
  const hasEvidence = ACTIVE_EVIDENCE_SIGNAL.test(merged);
  const hasWorkflowSignal = ACTIVE_WORKFLOW_SIGNAL.test(merged);
  let score = 0;
  if (length >= 20) score += 0.18;
  if (length >= 60) score += 0.14;
  if (length >= 120) score += 0.1;
  if (uniqueChars >= 10) score += 0.08;
  if (uniqueChars >= 24) score += 0.04;
  if (hasSemanticSignal) score += 0.26;
  if (hasEvidence) score += 0.16;
  if (hasWorkflowSignal) score += 0.12;
  if (summary && sourceText && sourceText.toLowerCase().includes(summary.toLowerCase().slice(0, Math.min(32, summary.length)))) {
    score += 0.06;
  }
  if (!hasSemanticSignal && !hasEvidence && !hasWorkflowSignal) {
    score = Math.min(score, 0.35);
  }
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
    const response = await postJsonWithTimeout({
      endpoint,
      apiKey: args.apiKey,
      body,
      timeoutMs,
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
    const activeTextMaxChars = typeof options.writePolicy?.activeTextMaxChars === "number" && Number.isFinite(options.writePolicy.activeTextMaxChars)
      ? Math.max(500, Math.floor(options.writePolicy.activeTextMaxChars))
      : 200000;
    const cleaned = normalizeText(args.text || "", activeTextMaxChars);
    if (!cleaned) {
      return { status: "skipped", reason: "empty_text", error_code: "E204" };
    }
    const sourceTextRaw = typeof args.sourceText === "string" ? args.sourceText.trim() : "";
    const sourceText = sourceTextRaw || cleaned;

    const quality = scoreQuality({ text: cleaned, summary: args.summary, sourceText });
    const activeMinQualityScore = typeof options.writePolicy?.activeMinQualityScore === "number"
      ? Math.max(0, Math.min(1, options.writePolicy.activeMinQualityScore))
      : 0.45;
    if (quality.score < activeMinQualityScore) {
      return { status: "skipped", reason: "low_quality", error_code: "E204", quality };
    }

    const textHash = computeHash(cleaned);
    const semanticDedupText = buildActiveDedupText({ text: cleaned, summary: args.summary, sourceText });
    const semanticHash = computeHash(normalizeSemanticText(semanticDedupText));
    const semanticSimhash = computeSimhashHex(semanticDedupText);
    const semanticMinhash = computeMinhash(semanticDedupText);
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
          const existingSemanticHash = typeof parsed.semantic_hash === "string"
            ? parsed.semantic_hash
            : computeHash(normalizeSemanticText(String(parsed.summary || parsed.source_text || "")));
          if (existingSemanticHash && existingSemanticHash === semanticHash) {
            return { status: "skipped", reason: "duplicate_semantic", error_code: "E203", quality };
          }
          const existingSemanticText = buildActiveDedupText({
            text: String(parsed.summary || parsed.source_text || ""),
            summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
            sourceText: typeof parsed.source_text === "string" ? parsed.source_text : undefined,
          });
          const existingSimhash = typeof parsed.semantic_simhash === "string"
            ? parsed.semantic_simhash
            : computeSimhashHex(existingSemanticText);
          if (
            normalizeSemanticText(semanticDedupText).length >= 24 &&
            normalizeSemanticText(existingSemanticText).length >= 24 &&
            hammingDistanceHex(semanticSimhash, existingSimhash) <= 3
          ) {
            return { status: "skipped", reason: "duplicate_simhash", error_code: "E203", quality };
          }
          if (minhashSimilarity(semanticMinhash, computeMinhash(existingSemanticText)) >= 0.92) {
            return { status: "skipped", reason: "duplicate_minhash", error_code: "E203", quality };
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
      summary: normalizeSummary(args.summary || "") || normalizeSummary(cleaned),
      source_text: sourceText || undefined,
      layer: "active",
      source_memory_id: id,
      source_memory_canonical_id: id,
      source_event_id: id,
      canonical_id: id,
      embedding_status: "pending",
      llm_gate_decision: "active_only",
      quality_level: quality.level,
      quality_score: quality.score,
      text_hash: textHash,
      semantic_hash: semanticHash,
      semantic_simhash: semanticSimhash,
      char_count: sourceText.length,
      token_count: estimateTokenCount(sourceText),
    };
    const embeddingModel = options.embedding?.model || "";
    const embeddingApiKey = options.embedding?.apiKey || "";
    const embeddingBaseUrl = normalizeBaseUrl(options.embedding?.baseURL || options.embedding?.baseUrl);
    const chunkSize = options.vectorChunking?.chunkSize ?? 600;
    const chunkOverlap = options.vectorChunking?.chunkOverlap ?? 100;
    const maxParallel = 6;
    const vectorStore = options.vectorStore;
    if (embeddingModel && embeddingApiKey && embeddingBaseUrl && vectorStore) {
      const chunks = splitTextChunks(sourceText, chunkSize, chunkOverlap);
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
            source_event_id: record.id,
            source_field: "summary",
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
