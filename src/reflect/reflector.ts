import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { postJsonWithTimeout } from "../net/http_post";

interface LoggerLike {
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
}

interface ReflectorOptions {
  projectRoot: string;
  dbPath?: string;
  logger: LoggerLike;
  ruleStore: {
    addRule(args: { sectionTitle: string; content: string }): { added: boolean; reason?: string };
  };
  llm?: {
    provider: string;
    model: string;
    apiKey?: string;
    baseURL?: string;
    baseUrl?: string;
  };
}

interface ReflectState {
  version: string;
  processed_event_ids: string[];
  total_runs: number;
  updated_at: string;
}

interface ReflectRunMetrics {
  run_id: string;
  started_at: string;
  finished_at: string;
  scanned: number;
  attempted: number;
  reflected: number;
  skipped_no_summary: number;
  skipped_processed: number;
  skipped_quality_gate: number;
  rule_store_duplicate: number;
  llm_generated: number;
  llm_failed: number;
  fallback_used: number;
  per_reason: Record<string, number>;
}

const MAX_PROCESSED_EVENT_IDS = 50000;

function readJsonl(filePath: string): Record<string, unknown>[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/).filter(Boolean);
  const results: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      results.push(parsed);
    } catch {}
  }
  return results;
}

function textOf(record: Record<string, unknown>): string {
  const candidates = [record.summary, record.content, record.text, record.message, record.outcome];
  for (const item of candidates) {
    if (typeof item === "string" && item.trim()) {
      return item.trim();
    }
  }
  return "";
}

function normalizeBaseUrl(value?: string): string {
  if (!value) return "";
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeRuleText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function bumpReason(metrics: ReflectRunMetrics, reason: string): void {
  const key = reason.trim() || "unknown";
  metrics.per_reason[key] = (metrics.per_reason[key] || 0) + 1;
}

function readReflectState(filePath: string): ReflectState {
  try {
    if (!fs.existsSync(filePath)) {
      return {
        version: "1",
        processed_event_ids: [],
        total_runs: 0,
        updated_at: nowIso(),
      };
    }
    const content = fs.readFileSync(filePath, "utf-8").trim();
    if (!content) {
      return {
        version: "1",
        processed_event_ids: [],
        total_runs: 0,
        updated_at: nowIso(),
      };
    }
    const parsed = JSON.parse(content) as ReflectState;
    return {
      version: "1",
      processed_event_ids: Array.isArray(parsed.processed_event_ids)
        ? parsed.processed_event_ids.filter(item => typeof item === "string" && item.trim()).map(item => item.trim())
        : [],
      total_runs: typeof parsed.total_runs === "number" && Number.isFinite(parsed.total_runs)
        ? Math.max(0, Math.floor(parsed.total_runs))
        : 0,
      updated_at: typeof parsed.updated_at === "string" && parsed.updated_at.trim() ? parsed.updated_at : nowIso(),
    };
  } catch {
    return {
      version: "1",
      processed_event_ids: [],
      total_runs: 0,
      updated_at: nowIso(),
    };
  }
}

function writeReflectState(filePath: string, state: ReflectState): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const deduped = [...new Set(state.processed_event_ids.filter(Boolean))];
  const normalized: ReflectState = {
    version: "1",
    processed_event_ids: deduped.slice(-MAX_PROCESSED_EVENT_IDS),
    total_runs: Math.max(0, Math.floor(state.total_runs || 0)),
    updated_at: nowIso(),
  };
  fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2), "utf-8");
}

function appendMetrics(filePath: string, metrics: ReflectRunMetrics): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.appendFileSync(filePath, `${JSON.stringify(metrics)}\n`, "utf-8");
}

function recordEventId(record: Record<string, unknown>): string {
  const candidates = [record.id, record.canonical_id, record.source_event_id];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  const payload = JSON.stringify({
    session_id: typeof record.session_id === "string" ? record.session_id : "",
    event_type: typeof record.event_type === "string" ? record.event_type : "",
    summary: typeof record.summary === "string" ? record.summary : "",
    content: typeof record.content === "string" ? record.content : "",
    outcome: typeof record.outcome === "string" ? record.outcome : "",
    timestamp: typeof record.timestamp === "string" ? record.timestamp : "",
  });
  return `derived:${crypto.createHash("sha1").update(payload).digest("hex")}`;
}

function buildFallbackRule(summary: string, outcome: string): string {
  const trimmedSummary = summary.replace(/\s+/g, " ").trim().slice(0, 180);
  const trimmedOutcome = outcome.replace(/\s+/g, " ").trim().slice(0, 120) || "expected";
  return `For similar tasks, prioritize reproducing "${trimmedSummary}" and verify the final outcome is "${trimmedOutcome}".`;
}

function validateRuleText(raw: string): { ok: boolean; normalized: string; reason?: string } {
  const normalized = normalizeRuleText(raw);
  if (!normalized) {
    return { ok: false, normalized, reason: "quality_empty" };
  }
  if (normalized.length < 24) {
    return { ok: false, normalized, reason: "quality_too_short" };
  }
  if (normalized.length > 420) {
    return { ok: false, normalized, reason: "quality_too_long" };
  }
  if (/^(#|[-*]\s+|\d+\.\s+)/.test(normalized)) {
    return { ok: false, normalized, reason: "quality_markdown_style" };
  }
  if (/(as an ai|i cannot|i can't|sorry)/i.test(normalized)) {
    return { ok: false, normalized, reason: "quality_non_actionable" };
  }
  if (/(api[_-]?key|authorization\s*:\s*bearer|password|secret|token|sk-[a-z0-9]{16,})/i.test(normalized)) {
    return { ok: false, normalized, reason: "quality_sensitive_content" };
  }
  return { ok: true, normalized };
}

function normalizeCandidateKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function looksLikeNoise(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return true;
  if (normalized.length < 20) return true;
  if (normalized.length > 420) return true;
  if (/^\s*(hi|hello|thanks|thank you|ok|okay|got it|好的|谢谢|收到|嗯)\s*[.!?]*\s*$/i.test(normalized)) {
    return true;
  }
  if (/[?？]\s*$/.test(normalized)) {
    return true;
  }
  if (/(can you|could you|please|帮我|能不能|可以吗)/i.test(normalized)) {
    return true;
  }
  return false;
}

function signalScore(text: string): number {
  const normalized = text.toLowerCase();
  let score = 0;
  if (/(must|should|ensure|avoid|prefer|always|never|fallback|verify|sanitize|validate|dedup|idempotent|retry|timeout)/i.test(normalized)) {
    score += 2;
  }
  if (/(fix|resolved|resolved|success|stable|pass|passed|deploy|release|migration|rollback|incident|postmortem)/i.test(normalized)) {
    score += 2;
  }
  if (/(确保|避免|优先|必须|建议|回退|重试|校验|去重|幂等|已修复|成功|发布|稳定)/.test(text)) {
    score += 2;
  }
  if (/^[A-Z][^.]{10,}\.$/.test(text.trim())) {
    score += 1;
  }
  return score;
}

function promotionWeight(record: Record<string, unknown>, content: string): number {
  let score = 1;
  const role = typeof record.role === "string" ? record.role.trim().toLowerCase() : "";
  const outcome = typeof record.outcome === "string" ? record.outcome.trim().toLowerCase() : "";
  const eventType = typeof record.event_type === "string" ? record.event_type.trim().toLowerCase() : "";
  const confidence = typeof record.confidence === "number"
    ? Math.max(0, Math.min(1, record.confidence))
    : undefined;

  if (role === "assistant" || role === "system") score += 1;
  if (["success", "resolved", "done", "completed", "ok"].includes(outcome)) score += 1;
  if (["fix", "decision", "insight", "retrospective", "requirement", "constraint"].includes(eventType)) score += 2;
  if (typeof confidence === "number" && confidence >= 0.7) score += 1;
  if (content.length >= 30 && content.length <= 260) score += 1;
  score += signalScore(content);
  return score;
}

async function requestRuleFromLlm(args: {
  summary: string;
  outcome: string;
  model: string;
  apiKey: string;
  baseUrl: string;
}): Promise<string | null> {
  const endpoint = args.baseUrl.endsWith("/chat/completions")
    ? args.baseUrl
    : `${args.baseUrl}/chat/completions`;
  const prompt = `事件摘要: ${args.summary}\n结果: ${args.outcome}\n请生成一条可复用的工程规则，要求简洁、可执行、单句输出。`;
  const body = {
    model: args.model,
    temperature: 0.2,
    messages: [
      { role: "system", content: "你是工程规则提炼器。输出只包含规则正文，不要编号，不要解释。" },
      { role: "user", content: prompt },
    ],
  };
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await postJsonWithTimeout({
      endpoint,
      apiKey: args.apiKey,
      body,
      timeoutMs: 15000,
    });
    if (!response.ok) {
      lastError = new Error(response.status > 0 ? `llm_http_${response.status}` : (response.error || "llm_network_error"));
      continue;
    }
    try {
      const json = (response.json || {}) as { choices?: Array<{ message?: { content?: string } }> };
      const content = json?.choices?.[0]?.message?.content?.trim() || "";
      if (content) {
        return content.slice(0, 500);
      }
      lastError = new Error("llm_empty");
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) {
    throw lastError;
  }
  return null;
}

export function createReflector(options: ReflectorOptions): {
  reflectMemory(): Promise<{ status: string; message: string; reflected_count: number }>;
  promoteMemory(): Promise<{ status: string; promoted_count: number }>;
} {
  const memoryRoot = options.dbPath ? path.resolve(options.dbPath) : path.join(options.projectRoot, "data", "memory");
  const activeSessionsPath = path.join(memoryRoot, "sessions", "active", "sessions.jsonl");
  const archiveSessionsPath = path.join(memoryRoot, "sessions", "archive", "sessions.jsonl");
  const reflectStatePath = path.join(memoryRoot, ".reflect_state.json");
  const reflectMetricsPath = path.join(memoryRoot, ".reflect_metrics.jsonl");

  async function reflectMemory(): Promise<{ status: string; message: string; reflected_count: number }> {
    const runId = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const startedAt = nowIso();
    const metrics: ReflectRunMetrics = {
      run_id: runId,
      started_at: startedAt,
      finished_at: startedAt,
      scanned: 0,
      attempted: 0,
      reflected: 0,
      skipped_no_summary: 0,
      skipped_processed: 0,
      skipped_quality_gate: 0,
      rule_store_duplicate: 0,
      llm_generated: 0,
      llm_failed: 0,
      fallback_used: 0,
      per_reason: {},
    };
    const state = readReflectState(reflectStatePath);
    const processedSet = new Set(state.processed_event_ids);
    const archiveRecords = readJsonl(archiveSessionsPath).slice(-100);
    metrics.scanned = archiveRecords.length;
    let reflected = 0;
    for (const record of archiveRecords) {
      const summary = textOf(record);
      if (!summary) {
        metrics.skipped_no_summary += 1;
        bumpReason(metrics, "skip_no_summary");
        continue;
      }
      const eventId = recordEventId(record);
      if (processedSet.has(eventId)) {
        metrics.skipped_processed += 1;
        bumpReason(metrics, "skip_processed");
        continue;
      }
      metrics.attempted += 1;
      const outcome = typeof record.outcome === "string" ? record.outcome : "unknown";
      let ruleText = buildFallbackRule(summary, outcome);
      let usedFallback = true;
      const llmModel = options.llm?.model || "";
      const llmApiKey = options.llm?.apiKey || "";
      const llmBaseUrl = normalizeBaseUrl(options.llm?.baseURL || options.llm?.baseUrl);
      if (llmModel && llmApiKey && llmBaseUrl) {
        try {
          const generated = await requestRuleFromLlm({
            summary,
            outcome,
            model: llmModel,
            apiKey: llmApiKey,
            baseUrl: llmBaseUrl,
          });
          if (generated) {
            ruleText = generated;
            usedFallback = false;
            metrics.llm_generated += 1;
          }
        } catch (error) {
          metrics.llm_failed += 1;
          bumpReason(metrics, "llm_failed");
          options.logger.warn(`LLM reflection failed, fallback to template rule: ${error}`);
        }
      }
      if (usedFallback) {
        metrics.fallback_used += 1;
      }
      const quality = validateRuleText(ruleText);
      if (!quality.ok) {
        if (!usedFallback) {
          const fallbackQuality = validateRuleText(buildFallbackRule(summary, outcome));
          if (fallbackQuality.ok) {
            ruleText = fallbackQuality.normalized;
          } else {
            metrics.skipped_quality_gate += 1;
            bumpReason(metrics, fallbackQuality.reason || "skip_quality_gate");
            continue;
          }
        } else {
          metrics.skipped_quality_gate += 1;
          bumpReason(metrics, quality.reason || "skip_quality_gate");
          continue;
        }
      } else {
        ruleText = quality.normalized;
      }
      const added = options.ruleStore.addRule({
        sectionTitle: "Reflected Rule",
        content: ruleText,
      });
      processedSet.add(eventId);
      if (added.added) {
        reflected += 1;
        metrics.reflected += 1;
      } else if (added.reason === "duplicate_rule") {
        metrics.rule_store_duplicate += 1;
        bumpReason(metrics, "duplicate_rule");
      } else if (added.reason) {
        bumpReason(metrics, added.reason);
      }
    }
    state.processed_event_ids = [...processedSet];
    state.total_runs += 1;
    writeReflectState(reflectStatePath, state);
    metrics.finished_at = nowIso();
    appendMetrics(reflectMetricsPath, metrics);
    options.logger.info(
      `TS reflector run=${metrics.run_id} scanned=${metrics.scanned} attempted=${metrics.attempted} reflected=${metrics.reflected} duplicate=${metrics.rule_store_duplicate} quality_skip=${metrics.skipped_quality_gate} llm_generated=${metrics.llm_generated} llm_failed=${metrics.llm_failed} fallback=${metrics.fallback_used}`,
    );
    return {
      status: "ok",
      message: `Reflection completed: reflected=${reflected}, attempted=${metrics.attempted}, skipped_processed=${metrics.skipped_processed}, skipped_quality=${metrics.skipped_quality_gate}`,
      reflected_count: reflected,
    };
  }

  async function promoteMemory(): Promise<{ status: string; promoted_count: number }> {
    const activeRecords = readJsonl(activeSessionsPath).slice(-500);
    const counter = new Map<string, { content: string; count: number; score: number }>();
    let skippedNoise = 0;
    let skippedQuality = 0;
    for (const record of activeRecords) {
      const content = typeof record.content === "string" ? record.content.trim() : "";
      if (!content) {
        continue;
      }
      if (looksLikeNoise(content)) {
        skippedNoise += 1;
        continue;
      }
      const quality = validateRuleText(content);
      if (!quality.ok) {
        skippedQuality += 1;
        continue;
      }
      const normalized = quality.normalized;
      const key = normalizeCandidateKey(normalized);
      const weight = promotionWeight(record, normalized);
      const existing = counter.get(key);
      if (existing) {
        existing.count += 1;
        existing.score += weight;
      } else {
        counter.set(key, { content: normalized, count: 1, score: weight });
      }
    }

    let promoted = 0;
    const minOccurrences = 3;
    const minScore = 8;
    for (const item of counter.values()) {
      if (item.count < minOccurrences) {
        continue;
      }
      if (item.score < minScore) {
        continue;
      }
      const added = options.ruleStore.addRule({
        sectionTitle: "Promoted Rule",
        content: item.content,
      });
      if (added.added) {
        promoted += 1;
      }
    }
    options.logger.info(
      `TS reflector promoted ${promoted} rules from ${activeRecords.length} active records (candidates=${counter.size}, skipped_noise=${skippedNoise}, skipped_quality=${skippedQuality})`,
    );
    return { status: "ok", promoted_count: promoted };
  }

  options.logger.debug(`TS reflector initialized with memory root ${memoryRoot}`);
  return { reflectMemory, promoteMemory };
}
