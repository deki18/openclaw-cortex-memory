import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { GraphQualityMode } from "../graph/ontology";
import { validateLlmJsonOutput, validateArchiveEvent } from "../quality/llm_output_validator";

interface LoggerLike {
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
}

interface SyncState {
  version: string;
  files: Record<string, { size: number; lineCount: number }>;
  markdowns?: Record<string, { digest: string; importedAt: string }>;
  lastVectorBackfill?: {
    runAt: string;
    success: number;
    failed: number;
    skipped: number;
  };
}

interface SessionSyncOptions {
  projectRoot: string;
  dbPath?: string;
  logger: LoggerLike;
  llm?: {
    model?: string;
    apiKey?: string;
    baseURL?: string;
    baseUrl?: string;
  };
  graphQualityMode?: GraphQualityMode;
  archiveStore: {
    storeEvents(events: Array<{
      event_type: string;
      summary: string;
      entities?: string[];
      relations?: Array<{ source: string; target: string; type: string; evidence_span?: string; confidence?: number }>;
      entity_types?: Record<string, string>;
      outcome?: string;
      session_id: string;
      source_file: string;
      source_text?: string;
      confidence?: number;
      source_event_id?: string;
      actor?: string;
    }>): Promise<{ stored: Array<{ id: string }>; skipped: Array<{ summary: string; reason: string }> }>;
  };
  graphMemoryStore?: {
    append(input: {
      sourceEventId: string;
      sourceLayer: "archive_event" | "active_only";
      archiveEventId?: string;
      sessionId: string;
      sourceFile?: string;
      eventType?: string;
      entities?: string[];
      entity_types?: Record<string, string>;
      relations?: Array<{ source: string; target: string; type: string; evidence_span?: string; confidence?: number }>;
      gateSource: "sync" | "session_end" | "manual";
      confidence?: number;
      sourceText?: string;
    }): Promise<{ success: boolean; reason?: string }>;
  };
  writeStore: {
    writeMemory(args: { text: string; role: string; source: string; sessionId: string }): Promise<{ status: "ok" | "skipped"; reason?: string }>;
  };
  requireLlmForWrite?: boolean;
  writePolicy?: {
    activeTextMaxChars?: number;
    archiveSourceTextMaxChars?: number;
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }
  return null;
}

function firstString(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

const SYNC_STATE_VERSION = "2";

function createDefaultState(): SyncState {
  return { version: SYNC_STATE_VERSION, files: {}, markdowns: {} };
}

function readState(filePath: string): SyncState {
  try {
    if (!fs.existsSync(filePath)) {
      return createDefaultState();
    }
    const content = fs.readFileSync(filePath, "utf-8").trim();
    if (!content) {
      return createDefaultState();
    }
    const parsed = JSON.parse(content) as SyncState;
    if (!parsed.files || typeof parsed.files !== "object") {
      return createDefaultState();
    }
    if (!parsed.markdowns || typeof parsed.markdowns !== "object") {
      parsed.markdowns = {};
    }
    parsed.version = typeof parsed.version === "string" && parsed.version.trim()
      ? parsed.version
      : SYNC_STATE_VERSION;
    return parsed;
  } catch {
    return createDefaultState();
  }
}

function writeState(filePath: string, state: SyncState): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  state.version = SYNC_STATE_VERSION;
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
}

function gatherSessionFiles(openclawBasePath: string, memoryRoot: string): string[] {
  const results = new Set<string>();
  const openclawSessionsDir = path.join(openclawBasePath, "agents", "main", "sessions");
  const localActiveFile = path.join(memoryRoot, "sessions", "active", "sessions.jsonl");

  if (fs.existsSync(openclawSessionsDir) && fs.statSync(openclawSessionsDir).isDirectory()) {
    for (const entry of fs.readdirSync(openclawSessionsDir)) {
      if (entry.endsWith(".jsonl")) {
        results.add(path.join(openclawSessionsDir, entry));
      }
    }
  }
  if (fs.existsSync(localActiveFile) && fs.statSync(localActiveFile).isFile()) {
    results.add(localActiveFile);
  }
  return [...results];
}

function gatherDailySummaryFiles(openclawBasePath: string): string[] {
  const summaryDir = path.join(openclawBasePath, "workspace", "memory");
  if (!fs.existsSync(summaryDir) || !fs.statSync(summaryDir).isDirectory()) {
    return [];
  }
  const files: string[] = [];
  for (const entry of fs.readdirSync(summaryDir)) {
    if (!entry.toLowerCase().endsWith(".md")) {
      continue;
    }
    const filePath = path.join(summaryDir, entry);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      files.push(filePath);
    }
  }
  return files;
}

function inferOpenclawBasePath(projectRoot: string): string {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (configPath && fs.existsSync(configPath)) {
    return path.dirname(configPath);
  }
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (stateDir && fs.existsSync(stateDir)) {
    return stateDir;
  }
  const basePath = process.env.OPENCLAW_BASE_PATH;
  if (basePath && fs.existsSync(basePath)) {
    return basePath;
  }
  const home = process.env.USERPROFILE || process.env.HOME || "";
  if (home) {
    const defaultPath = path.join(home, ".openclaw");
    if (fs.existsSync(defaultPath)) {
      return defaultPath;
    }
  }
  return projectRoot;
}

function extractMessages(record: Record<string, unknown>): Array<{ role: string; text: string }> {
  if (Array.isArray(record.messages)) {
    const output: Array<{ role: string; text: string }> = [];
    for (const item of record.messages) {
      if (typeof item === "string" && item.trim()) {
        output.push({ role: "unknown", text: item.trim() });
        continue;
      }
      const obj = asRecord(item);
      if (!obj) continue;
      const text = firstString([obj.content, obj.summary, obj.text, obj.message, obj.body]);
      if (!text) continue;
      const role = firstString([obj.role, obj.senderRole, obj.fromRole]) || "unknown";
      output.push({ role, text });
    }
    if (output.length > 0) {
      return output;
    }
  }

  const text = firstString([record.content, record.summary, record.text, record.message]);
  if (text) {
    return [{ role: firstString([record.role, record.senderRole, record.fromRole]) || "unknown", text }];
  }
  return [];
}

function getSessionId(record: Record<string, unknown>, fallbackSeed: string): string {
  return (
    firstString([
      record.sessionId,
      record.session_id,
      record.conversationId,
      record.conversation_id,
      record.id,
    ]) || `sync:${fallbackSeed}`
  );
}

function parseDailySummary(content: string): string[] {
  const normalized = content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !line.startsWith("```"));
  const chunks: string[] = [];
  let current: string[] = [];
  for (const line of normalized) {
    const isHeader = line.startsWith("#");
    const isBullet = /^[-*]\s+/.test(line);
    if (isHeader && current.length > 0) {
      chunks.push(current.join("\n"));
      current = [];
    }
    current.push(line);
    if (isBullet && current.length >= 6) {
      chunks.push(current.join("\n"));
      current = [];
    }
  }
  if (current.length > 0) {
    chunks.push(current.join("\n"));
  }
  return chunks.map(chunk => chunk.trim()).filter(chunk => chunk.length >= 10);
}

function normalizeBaseUrl(value?: string): string {
  if (!value) return "";
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function buildEventSnippet(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => line.length >= 8);
  const actionPattern = /(决定|完成|修复|阻塞|失败|成功|上线|部署|实现|依赖|owner|blocked|resolved|fixed|depends|decide|complete)/i;
  const picked = lines.filter(line => actionPattern.test(line));
  const use = picked.length > 0 ? picked : lines.slice(-20);
  return use.slice(-30).join("\n").slice(-8000);
}

interface ArchiveEventPayload {
  event_type: string;
  summary: string;
  entities?: string[];
  relations?: Array<{ source: string; target: string; type: string; evidence_span?: string; confidence?: number }>;
  entity_types?: Record<string, string>;
  outcome?: string;
  confidence?: number;
}

interface GateDecisionPayload {
  candidate_id?: string;
  target_layer: "active_only" | "archive_event" | "skip";
  active_text?: string;
  event?: ArchiveEventPayload;
  graph?: {
    entities?: string[];
    entity_types?: Record<string, string>;
    relations?: Array<{ source: string; target: string; type: string; evidence_span?: string; confidence?: number }>;
    confidence?: number;
  };
  reason?: string;
}

const WRITE_GATE_PROMPT_VERSION = "write-gate.v1.3.0";
const WRITE_GATE_REGRESSION_SAMPLES = [
  "鏍蜂緥A: 鈥滀粖澶╄璁轰簡涓夌鏂规锛屽皻鏈喅绛栤€?=> active_only",
  "鏍蜂緥B: 鈥滃喅瀹氶噰鐢˙鏂规骞跺畬鎴愪笂绾匡紝閿欒鐜囦笅闄嶅埌0.2%鈥?=> archive_event",
  "鏍蜂緥C: 鈥滃ソ鐨勬敹鍒拌阿璋⑩€?=> skip",
];

function parseArchiveEventPayload(value: unknown): ArchiveEventPayload | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const obj = value as Record<string, unknown>;
  const eventType = typeof obj.event_type === "string" ? obj.event_type.trim() : "";
  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  if (!eventType || !summary) {
    return null;
  }
  const entities = Array.isArray(obj.entities)
    ? obj.entities.map(v => (typeof v === "string" ? v.trim() : "")).filter(Boolean)
    : [];
  const relations = Array.isArray(obj.relations)
    ? obj.relations
        .map(valueItem => {
          if (!valueItem || typeof valueItem !== "object") return null;
          const relation = valueItem as Record<string, unknown>;
          const source = typeof relation.source === "string" ? relation.source.trim() : "";
          const target = typeof relation.target === "string" ? relation.target.trim() : "";
          const type = typeof relation.type === "string" ? relation.type.trim() : "related_to";
          const evidenceSpan = typeof relation.evidence_span === "string" ? relation.evidence_span.trim() : "";
          const confidence = typeof relation.confidence === "number"
            ? Math.max(0, Math.min(1, relation.confidence))
            : undefined;
          if (!source || !target) return null;
          return { source, target, type, evidence_span: evidenceSpan || undefined, confidence };
        })
        .filter(Boolean) as Array<{ source: string; target: string; type: string; evidence_span?: string; confidence?: number }>
      : [];
  const entity_types = typeof obj.entity_types === "object" && obj.entity_types !== null && !Array.isArray(obj.entity_types)
    ? Object.fromEntries(
        Object.entries(obj.entity_types as Record<string, unknown>)
          .filter(([key, value]) => typeof key === "string" && key.trim().length > 0 && typeof value === "string" && value.trim().length > 0)
          .map(([key, value]) => [key.trim(), (value as string).trim()]),
      )
    : undefined;
  return {
    event_type: eventType,
    summary,
    entities,
    entity_types,
    relations,
    outcome: typeof obj.outcome === "string" ? obj.outcome.trim() : "",
    confidence: typeof obj.confidence === "number" ? Math.max(0, Math.min(1, obj.confidence)) : 0.6,
  };
}

function parseGraphPayload(value: unknown): {
  entities?: string[];
  entity_types?: Record<string, string>;
  relations?: Array<{ source: string; target: string; type: string; evidence_span?: string; confidence?: number }>;
  confidence?: number;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  const entities = Array.isArray(obj.entities)
    ? obj.entities.map(v => (typeof v === "string" ? v.trim() : "")).filter(Boolean)
    : [];
  const entity_types = typeof obj.entity_types === "object" && obj.entity_types !== null && !Array.isArray(obj.entity_types)
    ? Object.fromEntries(
        Object.entries(obj.entity_types as Record<string, unknown>)
          .filter(([key, val]) => typeof key === "string" && key.trim() && typeof val === "string" && val.trim())
          .map(([key, val]) => [key.trim(), (val as string).trim()]),
      )
    : undefined;
  const relations = Array.isArray(obj.relations)
    ? obj.relations
        .map(item => {
          if (!item || typeof item !== "object") return null;
          const rel = item as Record<string, unknown>;
          const source = typeof rel.source === "string" ? rel.source.trim() : "";
          const target = typeof rel.target === "string" ? rel.target.trim() : "";
          const type = typeof rel.type === "string" && rel.type.trim() ? rel.type.trim() : "related_to";
          if (!source || !target) return null;
          const evidenceSpan = typeof rel.evidence_span === "string" ? rel.evidence_span.trim() : "";
          const confidence = typeof rel.confidence === "number"
            ? Math.max(0, Math.min(1, rel.confidence))
            : undefined;
          return {
            source,
            target,
            type,
            ...(evidenceSpan ? { evidence_span: evidenceSpan } : {}),
            ...(typeof confidence === "number" ? { confidence } : {}),
          };
        })
        .filter((item): item is { source: string; target: string; type: string; evidence_span?: string; confidence?: number } => item !== null)
    : [];
  if (entities.length === 0 || relations.length === 0) {
    return null;
  }
  return {
    entities,
    entity_types,
    relations,
    confidence: typeof obj.confidence === "number" ? Math.max(0, Math.min(1, obj.confidence)) : undefined,
  };
}

function parseLlmGateDecisions(raw: string, logger?: LoggerLike): GateDecisionPayload[] {
  const validation = validateLlmJsonOutput(raw);
  if (!validation.valid) {
    if (logger) {
      logger.warn(`quality_gate_decisions_invalid errors=${validation.errors.join("|")}`);
    }
    return [];
  }
  if (validation.warnings.length > 0 && logger) {
    logger.debug(`quality_gate_decisions_warnings warnings=${validation.warnings.join("|")}`);
  }
  const root = validation.data;
  const parsed = Array.isArray(root) ? root : (root as Record<string, unknown>);
  const output: GateDecisionPayload[] = [];
  const pushDecision = (obj: Record<string, unknown>, target: "active_only" | "archive_event" | "skip"): void => {
    let event: ArchiveEventPayload | null = null;
    if (target === "archive_event") {
      const eventValidation = validateArchiveEvent(obj.event || obj);
      if (eventValidation.valid && eventValidation.cleaned) {
        event = {
          event_type: eventValidation.cleaned.event_type || "insight",
          summary: eventValidation.cleaned.summary,
          entities: eventValidation.cleaned.entities,
          entity_types: eventValidation.cleaned.entity_types,
          relations: eventValidation.cleaned.relations,
          outcome: eventValidation.cleaned.outcome || "",
          confidence: eventValidation.cleaned.confidence,
        };
      } else {
        if (logger) {
          logger.warn(`quality_event_invalid errors=${eventValidation.errors.join("|")}`);
        }
        return;
      }
    }
    output.push({
      candidate_id: typeof obj.candidate_id === "string" ? obj.candidate_id.trim() : "",
      target_layer: target,
      active_text: typeof obj.active_text === "string" ? obj.active_text.trim() : "",
      event: event || undefined,
      graph: parseGraphPayload(obj.graph) || undefined,
      reason: typeof obj.reason === "string" ? obj.reason.trim() : "",
    });
  };

  if (Array.isArray(parsed)) {
    if (logger) {
      logger.warn("quality_gate_decisions_invalid format=array_not_supported_require_routing_plan");
    }
  } else if (parsed && typeof parsed === "object") {
    const rootObj = parsed as Record<string, unknown>;
    const routingPlan = (typeof rootObj.routing_plan === "object" && rootObj.routing_plan !== null)
      ? rootObj.routing_plan as Record<string, unknown>
      : null;
    if (routingPlan) {
      const buckets: Array<{ key: "archive_event" | "active_only" | "skip"; items: unknown }> = [
        { key: "archive_event", items: routingPlan.archive_event },
        { key: "active_only", items: routingPlan.active_only },
        { key: "skip", items: routingPlan.skip },
      ];
      for (const bucket of buckets) {
        if (!Array.isArray(bucket.items)) continue;
        for (const item of bucket.items) {
          if (!item || typeof item !== "object") continue;
          pushDecision(item as Record<string, unknown>, bucket.key);
        }
      }
    } else if (logger) {
      logger.warn("quality_gate_decisions_invalid missing_routing_plan");
    }
  }
  if (output.length === 0 && logger) {
    logger.warn("quality_gate_decisions_empty");
  }
  const deduped: GateDecisionPayload[] = [];
  const seen = new Set<string>();
  for (const item of output) {
    const key = `${item.target_layer}|${item.event?.summary || item.active_text || item.reason || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

async function extractGateDecisionsWithLlm(args: {
  llm: { model: string; apiKey: string; baseUrl: string };
  transcript: string;
  logger: LoggerLike;
}): Promise<GateDecisionPayload[]> {
  const endpoint = args.llm.baseUrl.endsWith("/chat/completions")
    ? args.llm.baseUrl
    : `${args.llm.baseUrl}/chat/completions`;
  const body = {
    model: args.llm.model,
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "You are a memory write-gate router. Output JSON only." },
      {
        role: "user",
        content: [
          `prompt_version=${WRITE_GATE_PROMPT_VERSION}`,
          "Execute in 3 stages:",
          "Stage1) Split transcript into candidate_events[]. One candidate should contain one principal event only.",
          "Stage2) Route each candidate_event into target_layer: active_only | archive_event | skip.",
          "Stage3) Output routing plan only. Do NOT claim data has been written.",
          "Classification:",
          "A) active_only: process context, ongoing discussion, temporary status, no stable conclusion.",
          "B) archive_event: reusable event with clear subject + action/decision + outcome/phase conclusion.",
          "C) skip: noise/repetition/chitchat/no clear business value.",
          "Constraints:",
          "- For archive_event: if confidence < 0.35, prefer skip.",
          "- Relations must be grounded in source text. Do not fabricate.",
          "- For active_only: active_text is required.",
          "- Optional graph for active_only: graph={entities[],entity_types,relations[],confidence}.",
          "- For relations: each relation should include source,target,type,evidence_span,confidence.",
          "- If evidence_span or confidence is missing, do not output that relation.",
          "Output JSON schema:",
          "{\"candidate_events\":[{\"candidate_id\":\"c1\",\"span\":\"...\",\"normalized_text\":\"...\"}],\"routing_plan\":{\"archive_event\":[{\"candidate_id\":\"c1\",\"event\":{\"event_type\":\"decision\",\"summary\":\"...\",\"entities\":[\"A\"],\"entity_types\":{\"A\":\"Project\"},\"relations\":[],\"outcome\":\"...\",\"confidence\":0.82}}],\"active_only\":[],\"skip\":[]}}",
          "routing_plan.archive_event[] item: {candidate_id,event}",
          "routing_plan.active_only[] item: {candidate_id,active_text,graph}",
          "routing_plan.skip[] item: {candidate_id,reason}",
          ...WRITE_GATE_REGRESSION_SAMPLES,
          "Output JSON only.",
          "",
          buildEventSnippet(args.transcript),
        ].join("\n"),
      },
    ],
  };
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);
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
        lastError = new Error(`sync_llm_http_${response.status}`);
        continue;
      }
      const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = json?.choices?.[0]?.message?.content || "";
      if (!content.trim()) {
        lastError = new Error("sync_llm_empty");
        continue;
      }
      return parseLlmGateDecisions(content, args.logger);
    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error;
    }
  }
  args.logger.warn(`Sync LLM extraction failed: ${String(lastError || "unknown")}`);
  return [];
}

export function createSessionSync(options: SessionSyncOptions): {
  syncMemory(): Promise<{
    imported: number;
    skipped: number;
    filesProcessed: number;
    summaryImported: number;
    summarySkipped: number;
    llmDecisions: number;
    activeOnly: number;
    archiveEvent: number;
    skipReasons: Record<string, number>;
  }>;
  syncDailySummaries(): Promise<{ imported: number; skipped: number; filesProcessed: number; llmDecisions: number; activeOnly: number; archiveEvent: number; skipReasons: Record<string, number> }>;
  routeTranscript(args: { sessionId: string; sourceFile: string; transcript: string }): Promise<{
    imported: number;
    skipped: number;
    ok: boolean;
    llmDecisions: number;
    activeOnly: number;
    archiveEvent: number;
    skipReasons: Record<string, number>;
  }>;
} {
  const memoryRoot = options.dbPath ? path.resolve(options.dbPath) : path.join(options.projectRoot, "data", "memory");
  const statePath = path.join(memoryRoot, ".sync_state.json");
  const openclawBasePath = inferOpenclawBasePath(options.projectRoot);
  const llmModel = options.llm?.model || "";
  const llmApiKey = options.llm?.apiKey || "";
  const llmBaseUrl = normalizeBaseUrl(options.llm?.baseURL || options.llm?.baseUrl);
  const requireLlmForWrite = options.requireLlmForWrite !== false;
  options.logger.info(`sync_gate_prompt_version=${WRITE_GATE_PROMPT_VERSION}`);
  if (!fs.existsSync(statePath)) {
    options.logger.warn("sync_state_missing: deleting state file triggers full re-import");
  }

  async function storeFromTranscript(args: { sessionId: string; sourceFile: string; transcript: string }): Promise<{
    imported: number;
    skipped: number;
    ok: boolean;
    llmDecisions: number;
    activeOnly: number;
    archiveEvent: number;
    skipReasons: Record<string, number>;
  }> {
    const skipReasons: Record<string, number> = {};
    const activeTextMaxChars = typeof options.writePolicy?.activeTextMaxChars === "number"
      ? Math.max(500, Math.min(20000, Math.floor(options.writePolicy.activeTextMaxChars)))
      : 4000;
    const archiveSourceTextMaxChars = typeof options.writePolicy?.archiveSourceTextMaxChars === "number"
      ? Math.max(1000, Math.min(30000, Math.floor(options.writePolicy.archiveSourceTextMaxChars)))
      : 8000;
    function bumpReason(reason: string): void {
      const key = reason || "unknown";
      skipReasons[key] = (skipReasons[key] || 0) + 1;
    }
    if (!args.transcript.trim()) {
      options.logger.info(`sync_skip reason=no_active_records session=${args.sessionId}`);
      bumpReason("no_active_records");
      return { imported: 0, skipped: 1, ok: true, llmDecisions: 0, activeOnly: 0, archiveEvent: 0, skipReasons };
    }
    if (!llmModel || !llmApiKey || !llmBaseUrl) {
      if (requireLlmForWrite) {
        options.logger.warn(`sync_skip reason=llm_not_configured session=${args.sessionId}`);
        bumpReason("llm_not_configured");
        return { imported: 0, skipped: 1, ok: false, llmDecisions: 0, activeOnly: 0, archiveEvent: 0, skipReasons };
      }
      options.logger.warn(`Sync gate degraded to active_only for ${args.sessionId}: llm_not_configured`);
      const fallbackWrite = await options.writeStore.writeMemory({
        text: args.transcript.slice(-activeTextMaxChars),
        role: "system",
        source: `sync_gate_fallback:${args.sourceFile}`,
        sessionId: args.sessionId,
      });
      if (fallbackWrite.status === "ok") {
        return { imported: 1, skipped: 0, ok: true, llmDecisions: 1, activeOnly: 1, archiveEvent: 0, skipReasons };
      }
      bumpReason(fallbackWrite.reason || "active_only_fallback_failed");
      return { imported: 0, skipped: 1, ok: false, llmDecisions: 1, activeOnly: 0, archiveEvent: 0, skipReasons };
    }
    const decisions = await extractGateDecisionsWithLlm({
      llm: { model: llmModel, apiKey: llmApiKey, baseUrl: llmBaseUrl },
      transcript: args.transcript,
      logger: options.logger,
    });
    if (decisions.length === 0) {
      options.logger.info(`sync_skip reason=llm_extract_empty session=${args.sessionId}`);
      bumpReason("llm_extract_empty");
      return { imported: 0, skipped: 1, ok: true, llmDecisions: 0, activeOnly: 0, archiveEvent: 0, skipReasons };
    }
    let llmDecisions = 0;
    let imported = 0;
    let skipped = 0;
    let activeOnly = 0;
    let archiveEvent = 0;
    let activeAttempted = 0;
    let archiveAttempted = 0;
    let graphAttempted = 0;
    let graphStored = 0;
    let graphSkipped = 0;
    const archiveInputs: Array<{
      event_type: string;
      summary: string;
      entities?: string[];
      relations?: Array<{ source: string; target: string; type: string; evidence_span?: string; confidence?: number }>;
      entity_types?: Record<string, string>;
      outcome?: string;
      session_id: string;
      source_file: string;
      source_text?: string;
      confidence?: number;
      source_event_id?: string;
      actor?: string;
    }> = [];
    for (const decision of decisions) {
      llmDecisions += 1;
      if (decision.target_layer === "skip") {
        skipped += 1;
        bumpReason(decision.reason || "llm_gate_skip");
        continue;
      }
      if (decision.target_layer === "active_only") {
        activeAttempted += 1;
        const activeText = (decision.active_text || args.transcript).trim().slice(-activeTextMaxChars);
        if (!activeText) {
          skipped += 1;
          bumpReason("active_only_empty");
          continue;
        }
        const writeResult = await options.writeStore.writeMemory({
          text: activeText,
          role: "system",
          source: `sync_gate_active:${args.sourceFile}`,
          sessionId: args.sessionId,
        });
        if (writeResult.status === "ok") {
          imported += 1;
          activeOnly += 1;
          if (options.graphMemoryStore && decision.graph) {
            graphAttempted += 1;
            const relationFingerprint = (decision.graph.relations || [])
              .map(rel => `${rel.source}|${rel.type}|${rel.target}|${rel.evidence_span || ""}`)
              .sort()
              .join("||");
            const activeSourceEventId = `active:${args.sessionId}:${crypto.createHash("sha1").update(relationFingerprint || activeText).digest("hex").slice(0, 16)}`;
            const graphResult = await options.graphMemoryStore.append({
              sourceEventId: activeSourceEventId,
              sourceLayer: "active_only",
              sessionId: args.sessionId,
              sourceFile: args.sourceFile,
              eventType: "insight",
              entities: decision.graph.entities,
              entity_types: decision.graph.entity_types,
              relations: decision.graph.relations,
              gateSource: "sync",
              confidence: decision.graph.confidence,
              sourceText: activeText,
            });
            if (!graphResult.success) {
              graphSkipped += 1;
              options.logger.info(
                `graph_skip_reason=${graphResult.reason} source_event_id=${activeSourceEventId}`,
              );
            } else {
              graphStored += 1;
            }
          }
        } else {
          skipped += 1;
          bumpReason(writeResult.reason || "active_only_write_skipped");
        }
        continue;
      }
      if (decision.target_layer === "archive_event") {
        archiveAttempted += 1;
        if (!decision.event) {
          skipped += 1;
          bumpReason("archive_event_missing_payload");
          continue;
        }
        archiveInputs.push({
          event_type: decision.event.event_type,
          summary: decision.event.summary,
          entities: decision.event.entities,
          relations: decision.event.relations,
          entity_types: decision.event.entity_types,
          outcome: decision.event.outcome,
          confidence: decision.event.confidence,
          session_id: args.sessionId,
          source_file: args.sourceFile,
          source_text: args.transcript.slice(-archiveSourceTextMaxChars),
          source_event_id: decision.candidate_id
            ? `candidate:${args.sessionId}:${decision.candidate_id}`
            : `candidate:${args.sessionId}:${crypto.createHash("sha1").update(decision.event.summary).digest("hex").slice(0, 16)}`,
          actor: "sync_llm_gate",
        });
      }
    }
    if (archiveInputs.length > 0) {
      let archivedSuccess = 0;
      let archivedSkipped = 0;
      for (const inputRecord of archiveInputs) {
        const archiveResult = await options.archiveStore.storeEvents([inputRecord]);
        imported += archiveResult.stored.length;
        skipped += archiveResult.skipped.length;
        archiveEvent += archiveResult.stored.length;
        archivedSuccess += archiveResult.stored.length;
        archivedSkipped += archiveResult.skipped.length;
        for (const skip of archiveResult.skipped) {
          bumpReason(skip.reason || "archive_store_skipped");
        }
        const archiveRecord = archiveResult.stored[0];
        if (!archiveRecord) {
          continue;
        }
        if (!options.graphMemoryStore) {
          continue;
        }
        graphAttempted += 1;
        const graphResult = await options.graphMemoryStore.append({
          // Graph trace points to persisted archive record id for stable lookup.
          sourceEventId: archiveRecord.id,
          sourceLayer: "archive_event",
          archiveEventId: archiveRecord.id,
          sessionId: args.sessionId,
          sourceFile: args.sourceFile,
          eventType: inputRecord.event_type,
          entities: inputRecord.entities,
          entity_types: inputRecord.entity_types,
          relations: inputRecord.relations,
          gateSource: "sync",
          confidence: inputRecord.confidence,
          sourceText: args.transcript,
        });
        if (!graphResult.success) {
          graphSkipped += 1;
          options.logger.info(
            `graph_skip_reason=${graphResult.reason} source_event_id=${archiveRecord.id}`,
          );
        } else {
          graphStored += 1;
        }
      }
      options.logger.info(
        `sync_archive_result session=${args.sessionId} archived_success=${archivedSuccess} skipped=${archivedSkipped}`,
      );
    }
    options.logger.info(
      `sync_gate_result session=${args.sessionId} llm_decisions=${llmDecisions} active_only=${activeOnly} archive_event=${archiveEvent} skipped=${skipped}`,
    );
    options.logger.info(
      `sync_gate_metrics session=${args.sessionId} active_attempted=${activeAttempted} archive_attempted=${archiveAttempted} graph_attempted=${graphAttempted} graph_stored=${graphStored} graph_skipped=${graphSkipped} skip_reason_kinds=${Object.keys(skipReasons).length}`,
    );
    return {
      imported,
      skipped,
      ok: true,
      llmDecisions,
      activeOnly,
      archiveEvent,
      skipReasons,
    };
  }

  async function syncDailySummaries(): Promise<{ imported: number; skipped: number; filesProcessed: number; llmDecisions: number; activeOnly: number; archiveEvent: number; skipReasons: Record<string, number> }> {
    const files = gatherDailySummaryFiles(openclawBasePath);
    const state = readState(statePath);
    if (!state.markdowns || typeof state.markdowns !== "object") {
      state.markdowns = {};
    }
    let imported = 0;
    let skipped = 0;
    let filesProcessed = 0;
    let llmDecisions = 0;
    let activeOnly = 0;
    let archiveEvent = 0;
    const skipReasons: Record<string, number> = {};
    for (const filePath of files) {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        continue;
      }
      const content = fs.readFileSync(filePath, "utf-8");
      const digest = crypto.createHash("sha1").update(content).digest("hex");
      const prev = state.markdowns[filePath];
      if (prev && prev.digest === digest) {
        skipped += 1;
        continue;
      }
      const chunks = parseDailySummary(content);
      if (chunks.length === 0) {
        state.markdowns[filePath] = { digest, importedAt: new Date().toISOString() };
        skipped += 1;
        continue;
      }
      const summarySessionId = `daily_summary:${path.basename(filePath)}`;
      const transcript = chunks.join("\n");
      const result = await storeFromTranscript({
        sessionId: summarySessionId,
        sourceFile: `daily_summary_sync:${path.basename(filePath)}`,
        transcript,
      });
      imported += result.imported;
      skipped += result.skipped;
      llmDecisions += result.llmDecisions;
      activeOnly += result.activeOnly;
      archiveEvent += result.archiveEvent;
      for (const [key, count] of Object.entries(result.skipReasons)) {
        skipReasons[key] = (skipReasons[key] || 0) + count;
      }
      if (!result.ok) {
        continue;
      }
      state.markdowns[filePath] = { digest, importedAt: new Date().toISOString() };
      filesProcessed += 1;
    }
    writeState(statePath, state);
    options.logger.info(`TS daily summary sync completed: imported=${imported}, skipped=${skipped}, files=${filesProcessed}`);
    return { imported, skipped, filesProcessed, llmDecisions, activeOnly, archiveEvent, skipReasons };
  }

  async function syncMemory(): Promise<{
    imported: number;
    skipped: number;
    filesProcessed: number;
    summaryImported: number;
    summarySkipped: number;
    llmDecisions: number;
    activeOnly: number;
    archiveEvent: number;
    skipReasons: Record<string, number>;
  }> {
    const files = gatherSessionFiles(openclawBasePath, memoryRoot);
    if (files.length === 0) {
      options.logger.info("sync_skip reason=no_active_records");
    }
    const state = readState(statePath);
    let imported = 0;
    let skipped = 0;
    let filesProcessed = 0;
    let llmDecisions = 0;
    let activeOnly = 0;
    let archiveEvent = 0;
    const skipReasons: Record<string, number> = {};

    for (const filePath of files) {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        continue;
      }
      const stat = fs.statSync(filePath);
      const prev = state.files[filePath];
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split(/\r?\n/).filter(Boolean);

      let startIndex = 0;
      if (prev && stat.size >= prev.size && lines.length >= prev.lineCount) {
        startIndex = prev.lineCount;
      }
      if (startIndex >= lines.length) {
        state.files[filePath] = { size: stat.size, lineCount: lines.length };
        continue;
      }

      const bySession = new Map<string, string[]>();
      let fileHasFailure = false;
      for (let i = startIndex; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const hash = crypto.createHash("sha1").update(line).digest("hex").slice(0, 12);
        try {
          const record = JSON.parse(line) as Record<string, unknown>;
          const messages = extractMessages(record);
          if (messages.length === 0) {
            skipped += 1;
            continue;
          }
          const sessionId = getSessionId(record, `${path.basename(filePath)}:${hash}`);
          for (const msg of messages) {
            if (!bySession.has(sessionId)) {
              bySession.set(sessionId, []);
            }
            bySession.get(sessionId)?.push(`[${msg.role}] ${msg.text}`);
          }
        } catch (error) {
          options.logger.debug(`Skipping invalid sync line in ${filePath}: ${error}`);
          skipped += 1;
        }
      }

      for (const [sessionId, messages] of bySession.entries()) {
        const transcript = messages.join("\n");
        const result = await storeFromTranscript({
          sessionId,
          sourceFile: `sync:${path.basename(filePath)}`,
          transcript,
        });
        imported += result.imported;
        skipped += result.skipped;
        llmDecisions += result.llmDecisions;
        activeOnly += result.activeOnly;
        archiveEvent += result.archiveEvent;
        for (const [key, count] of Object.entries(result.skipReasons)) {
          skipReasons[key] = (skipReasons[key] || 0) + count;
        }
        if (!result.ok) {
          fileHasFailure = true;
        }
      }

      filesProcessed += 1;
      if (!fileHasFailure) {
        state.files[filePath] = { size: stat.size, lineCount: lines.length };
      }
    }

    writeState(statePath, state);
    const summary = await syncDailySummaries();
    llmDecisions += summary.llmDecisions;
    activeOnly += summary.activeOnly;
    archiveEvent += summary.archiveEvent;
    for (const [key, count] of Object.entries(summary.skipReasons)) {
      skipReasons[key] = (skipReasons[key] || 0) + count;
    }
    options.logger.info(
      `TS sync completed: imported=${imported}, skipped=${skipped}, files=${filesProcessed}, summaryImported=${summary.imported}, summarySkipped=${summary.skipped}, llmDecisions=${llmDecisions}, activeOnly=${activeOnly}, archiveEvent=${archiveEvent}`,
    );
    return {
      imported,
      skipped,
      filesProcessed,
      summaryImported: summary.imported,
      summarySkipped: summary.skipped,
      llmDecisions,
      activeOnly,
      archiveEvent,
      skipReasons,
    };
  }

  async function routeTranscript(args: {
    sessionId: string;
    sourceFile: string;
    transcript: string;
  }): Promise<{
    imported: number;
    skipped: number;
    ok: boolean;
    llmDecisions: number;
    activeOnly: number;
    archiveEvent: number;
    skipReasons: Record<string, number>;
  }> {
    return storeFromTranscript(args);
  }

  return { syncMemory, syncDailySummaries, routeTranscript };
}

