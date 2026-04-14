import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { postJsonWithTimeout } from "../net/http_post";
import {
  buildRelationPromptHint,
  loadGraphSchema,
  type GraphQualityMode,
  type GraphSchemaConfig,
} from "../graph/ontology";
import { validateLlmJsonOutput, validateArchiveEvent, validateGraphRewritePayload } from "../quality/llm_output_validator";
import { getEnvValue, getHomeDir } from "../utils/runtime_env";

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
      cause?: string;
      process?: string;
      result?: string;
      entities?: string[];
      relations?: Array<{ source: string; target: string; type: string; evidence_span?: string; confidence?: number }>;
      entity_types?: Record<string, string>;
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
      source_text_nav?: {
        layer?: string;
        session_id?: string;
        source_file?: string;
        source_memory_id?: string;
        source_event_id?: string;
        fulltext_anchor?: string;
      };
      summary?: string;
      eventType?: string;
      entities?: string[];
      entity_types?: Record<string, string>;
      relations?: Array<{
        source: string;
        target: string;
        type: string;
        relation_origin?: string;
        relation_definition?: string;
        mapping_hint?: string;
        evidence_span?: string;
        context_chunk?: string;
        confidence?: number;
      }>;
      gateSource: "sync" | "session_end" | "manual";
      confidence?: number;
      sourceText?: string;
    }): Promise<{ success: boolean; reason?: string }>;
  };
  writeStore: {
    writeMemory(args: { text: string; role: string; source: string; sessionId: string; summary?: string; sourceText?: string }): Promise<{ status: "ok" | "skipped"; reason?: string }>;
  };
  requireLlmForWrite?: boolean;
  writePolicy?: {
    activeTextMaxChars?: number;
    archiveSourceTextMaxChars?: number;
  };
  syncPolicy?: {
    includeLocalActiveInput?: boolean;
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

function extractTextFromContent(content: unknown): string | undefined {
  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string" && item.trim()) {
      parts.push(item.trim());
      continue;
    }
    const obj = asRecord(item);
    if (!obj) {
      continue;
    }
    const text = firstString([obj.text, obj.content, obj.summary, obj.message, obj.body]);
    if (text) {
      parts.push(text);
    }
  }
  if (parts.length === 0) {
    return undefined;
  }
  return parts.join("\n");
}

function extractTextFromMessageRecord(record: Record<string, unknown>): string | undefined {
  const contentText = extractTextFromContent(record.content);
  return firstString([contentText, record.text, record.summary, record.message, record.body]);
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

function gatherSessionFiles(openclawBasePath: string, memoryRoot: string, includeLocalActiveInput: boolean): string[] {
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
  if (includeLocalActiveInput && fs.existsSync(localActiveFile) && fs.statSync(localActiveFile).isFile()) {
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
  const configPath = getEnvValue("OPENCLAW_CONFIG_PATH");
  if (configPath && fs.existsSync(configPath)) {
    return path.dirname(configPath);
  }
  const stateDir = getEnvValue("OPENCLAW_STATE_DIR");
  if (stateDir && fs.existsSync(stateDir)) {
    return stateDir;
  }
  const basePath = getEnvValue("OPENCLAW_BASE_PATH");
  if (basePath && fs.existsSync(basePath)) {
    return basePath;
  }
  const home = getHomeDir();
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
      const text = extractTextFromMessageRecord(obj);
      if (!text) continue;
      const role = firstString([obj.role, obj.senderRole, obj.fromRole]) || "unknown";
      output.push({ role, text });
    }
    if (output.length > 0) {
      return output;
    }
  }

  const nestedMessage = asRecord(record.message);
  if (nestedMessage) {
    const text = extractTextFromMessageRecord(nestedMessage);
    if (text) {
      return [{ role: firstString([nestedMessage.role, record.role, record.senderRole, record.fromRole]) || "unknown", text }];
    }
  }

  const text = extractTextFromMessageRecord(record);
  if (text) {
    return [{ role: firstString([record.role, record.senderRole, record.fromRole]) || "unknown", text }];
  }
  return [];
}

function getSessionId(record: Record<string, unknown>, fallbackSeed: string): string {
  const sessionObj = asRecord(record.session);
  const type = firstString([record.type])?.toLowerCase();
  const typeScopedId = type === "session" ? firstString([record.id]) : undefined;
  return (
    firstString([
      record.sessionId,
      record.session_id,
      record.conversationId,
      record.conversation_id,
      sessionObj?.id,
      sessionObj?.sessionId,
      typeScopedId,
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

function resolveWriteCharLimit(value: unknown, minLimit: number, fallbackLimit: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(minLimit, Math.floor(value));
  }
  return fallbackLimit;
}

function tailByCharLimit(text: string, maxChars: number): string {
  const source = (text || "").trim();
  if (!source) return "";
  if (!Number.isFinite(maxChars) || maxChars <= 0 || source.length <= maxChars) {
    return source;
  }
  return source.slice(-Math.floor(maxChars)).trim();
}

function normalizeOneLineText(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

const LOW_INFORMATION_LINE = /^(ok|okay|got it|roger|noted|sure|thanks|thank you|received|copy that|understood)\b/i;
const LOW_VALUE_ONLY_LINE = /^(ok|okay|got it|roger|noted|thanks|thank you|received|copy that|understood|sounds good)[\s.!?,]*$/i;
const ACTIVE_VALUE_SIGNAL_PATTERN = /(decision|trade-?off|constraint|requirement|fix|error|exception|blocked|rollback|deploy|progress|milestone|action item|owner|next step|todo|deadline|eta|issue|bug|metric|latency|error rate|cost|url|link|path|file|config|parameter|version|commit|pr|ticket)/i;
const ACTIVE_VALUE_EVIDENCE_PATTERN = /(https?:\/\/|www\.|[`#/:\\]|[A-Za-z]:\\|\/[A-Za-z0-9._\-\/]+|\b\d+(?:\.\d+)?%?\b|#\d{1,8})/;

function denoiseTranscriptForWrite(transcript: string): string {
  const raw = (transcript || "").trim();
  if (!raw) return "";
  const output: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const content = trimmed.replace(/^\[[^\]]+\]\s*/, "").trim();
    if (!content) continue;
    const hasSignal = /(https?:\/\/|www\.|[A-Za-z0-9._-]+\.[A-Za-z]{2,}|[`#/:\\]|@\w+|\b\d{2,}\b)/.test(content);
    if (!hasSignal && LOW_INFORMATION_LINE.test(content)) {
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

function hasValuableActiveContent(text: string): boolean {
  const source = (text || "").trim();
  if (!source) {
    return false;
  }
  const normalized = source
    .replace(/^\[[^\]]+\]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return false;
  }
  const hasSignal = ACTIVE_VALUE_SIGNAL_PATTERN.test(normalized);
  const hasEvidence = ACTIVE_VALUE_EVIDENCE_PATTERN.test(normalized);
  if (LOW_VALUE_ONLY_LINE.test(normalized) && !hasSignal && !hasEvidence) {
    return false;
  }
  if (!hasSignal && !hasEvidence) {
    return false;
  }
  if (normalized.length < 20 && !hasSignal) {
    return false;
  }
  return true;
}

function buildEventSnippet(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => line.length >= 8);
  const actionPattern = /(decision|fix|error|exception|blocked|deploy|progress|action item|owner|resolved|depends|complete)/i;
  const picked = lines.filter(line => actionPattern.test(line));
  const use = picked.length > 0 ? picked : lines.slice(-20);
  return use.slice(-30).join("\n").slice(-8000);
}

const TASK_INSTRUCTION_PATTERNS = [
  /please|can you|need to|task|implement|fix|investigate|optimi[sz]e|deploy|enable|review/i,
  /please|can you|need to|task|implement|fix|investigate|optimi[sz]e|deploy|enable|review/i,
];
const COMPLETION_REPORT_PATTERNS = [
  /done|completed|fixed|implemented|deployed|resolved|report|summary|finished/i,
  /done|completed|fixed|implemented|deployed|resolved|report|summary|finished/i,
];
const USER_ACCEPTANCE_PATTERNS = [
  /approved|accepted|looks good|great|works|thank you|confirmed|ok/i,
  /approved|accepted|looks good|great|works|thank you|confirmed/i,
];
const FAILURE_PATTERNS = [
  /failed|error|exception|blocked|timeout|rollback|incident/i,
  /failed|error|exception|blocked|timeout|rollback|incident/i,
];
const SUCCESS_PATTERNS = [
  /success|completed|fixed|resolved|passed|stable|recovered|works/i,
  /success|completed|fixed|resolved|passed|stable|recovered|works/i,
];
const USER_ROLE_HINT = /^(user|human|customer|client)/i;
const AGENT_ROLE_HINT = /^(assistant|agent|ai|system|openclaw|claude|gpt)/i;

function matchesAnyPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(text));
}

function parseTranscriptLines(transcript: string): Array<{ role: string; text: string }> {
  const lines = transcript
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  return lines.map(line => {
    const matched = line.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (!matched) {
      return { role: "unknown", text: line };
    }
    return {
      role: matched[1].trim().toLowerCase(),
      text: (matched[2] || "").trim(),
    };
  }).filter(item => item.text.length > 0);
}

function summarizeForArchive(text: string, maxChars: number): string {
  void maxChars;
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized;
}

function evaluateTaskLifecycle(transcript: string): {
  hasTaskInstruction: boolean;
  hasCompletionReport: boolean;
  hasUserAcceptance: boolean;
  hasFailure: boolean;
  hasSuccess: boolean;
  failThenSuccess: boolean;
  lifecycleComplete: boolean;
  taskText: string;
  reportText: string;
  acceptanceText: string;
} {
  const parsed = parseTranscriptLines(transcript);
  let taskText = "";
  let reportText = "";
  let acceptanceText = "";
  let firstFailureIndex = -1;
  let firstSuccessIndex = -1;
  let hasTaskInstruction = false;
  let hasCompletionReport = false;
  let hasUserAcceptance = false;
  let hasFailure = false;
  let hasSuccess = false;
  for (let i = 0; i < parsed.length; i += 1) {
    const line = parsed[i];
    const role = line.role;
    const text = line.text;
    const userLike = USER_ROLE_HINT.test(role) || role === "unknown";
    const agentLike = AGENT_ROLE_HINT.test(role) || role === "unknown";
    if (!hasTaskInstruction && userLike && matchesAnyPattern(text, TASK_INSTRUCTION_PATTERNS)) {
      hasTaskInstruction = true;
      taskText = text;
    }
    if (!hasCompletionReport && agentLike && matchesAnyPattern(text, COMPLETION_REPORT_PATTERNS)) {
      hasCompletionReport = true;
      reportText = text;
    }
    if (!hasUserAcceptance && userLike && matchesAnyPattern(text, USER_ACCEPTANCE_PATTERNS)) {
      hasUserAcceptance = true;
      acceptanceText = text;
    }
    if (matchesAnyPattern(text, FAILURE_PATTERNS)) {
      hasFailure = true;
      if (firstFailureIndex < 0) {
        firstFailureIndex = i;
      }
    }
    if (matchesAnyPattern(text, SUCCESS_PATTERNS)) {
      hasSuccess = true;
      if (firstSuccessIndex < 0) {
        firstSuccessIndex = i;
      }
    }
  }
  if (!hasTaskInstruction) {
    const fallback = parsed.find(item => matchesAnyPattern(item.text, TASK_INSTRUCTION_PATTERNS));
    if (fallback) {
      hasTaskInstruction = true;
      taskText = fallback.text;
    }
  }
  if (!hasCompletionReport) {
    const fallback = parsed.find(item => matchesAnyPattern(item.text, COMPLETION_REPORT_PATTERNS));
    if (fallback) {
      hasCompletionReport = true;
      reportText = fallback.text;
    }
  }
  if (!hasUserAcceptance) {
    const fallback = parsed.find(item => matchesAnyPattern(item.text, USER_ACCEPTANCE_PATTERNS));
    if (fallback) {
      hasUserAcceptance = true;
      acceptanceText = fallback.text;
    }
  }
  const failThenSuccess = hasFailure && hasSuccess && firstFailureIndex >= 0 && firstSuccessIndex > firstFailureIndex;
  return {
    hasTaskInstruction,
    hasCompletionReport,
    hasUserAcceptance,
    hasFailure,
    hasSuccess,
    failThenSuccess,
    lifecycleComplete: hasTaskInstruction && hasCompletionReport && hasUserAcceptance,
    taskText,
    reportText,
    acceptanceText,
  };
}

function appendLifecycleArchiveDecision(
  decisions: GateDecisionPayload[],
  transcript: string,
  logger: LoggerLike,
): GateDecisionPayload[] {
  if (decisions.some(item => item.target_layer === "archive_event")) {
    return decisions;
  }
  const lifecycle = evaluateTaskLifecycle(transcript);
  if (!lifecycle.lifecycleComplete) {
    return decisions;
  }
  const fallbackGraph = buildStablePersonalFactGraph(transcript);
  if (!fallbackGraph) {
    return decisions;
  }
  const summary = lifecycle.failThenSuccess
    ? "Task lifecycle closed: user request, failure iteration, final completion, and user acceptance."
    : "Task lifecycle closed: user request, completion report, and user acceptance.";
  const cause = lifecycle.taskText
    ? summarizeForArchive(lifecycle.taskText, 220)
    : "User issued a concrete task request.";
  const process = lifecycle.reportText
    ? summarizeForArchive(lifecycle.reportText, 320)
    : "Agent executed the requested work and provided a completion report.";
  const result = lifecycle.acceptanceText
    ? summarizeForArchive(lifecycle.acceptanceText, 220)
    : "User acknowledged and accepted the delivery.";
  const confidence = lifecycle.failThenSuccess ? 0.88 : 0.76;
  const fallbackDecision: GateDecisionPayload = {
    candidate_id: `lifecycle_${crypto.createHash("sha1").update(summary).digest("hex").slice(0, 12)}`,
    target_layer: "archive_event",
    event: {
      event_type: lifecycle.failThenSuccess ? "retrospective" : "milestone",
      summary,
      cause,
      process,
      result,
      entities: fallbackGraph.entities,
      relations: fallbackGraph.relations,
      entity_types: fallbackGraph.entity_types,
      confidence: typeof fallbackGraph.confidence === "number" ? fallbackGraph.confidence : confidence,
    },
    reason: "lifecycle_archive_fallback",
  };
  logger.info("sync_archive_fallback_applied reason=task_lifecycle_complete");
  return [...decisions, fallbackDecision];
}

type GateTargetLayer = "active_only" | "archive_event" | "skip";

interface GraphRelationPayload {
  source: string;
  target: string;
  type: string;
  relation_origin?: string;
  relation_definition?: string;
  mapping_hint?: string;
  evidence_span?: string;
  context_chunk?: string;
  confidence?: number;
}

interface GraphPayload {
  summary?: string;
  source_text_nav?: {
    layer?: string;
    session_id?: string;
    source_file?: string;
    source_memory_id?: string;
    source_event_id?: string;
    fulltext_anchor?: string;
  };
  entities?: string[];
  entity_types?: Record<string, string>;
  relations?: GraphRelationPayload[];
  confidence?: number;
}

interface ArchiveEventPayload {
  event_type: string;
  summary: string;
  cause: string;
  process: string;
  result: string;
  entities?: string[];
  relations?: GraphRelationPayload[];
  entity_types?: Record<string, string>;
  confidence?: number;
}

interface MergeHintPayload {
  candidate_id?: string;
  same_event?: boolean;
  same_entity_pairs?: Array<[string, string]>;
  suggested_action?: string;
  reason?: string;
}

interface GraphRewritePlanPayload {
  candidate_id?: string;
  rewrite_required: boolean;
  rewrite_reason?: string;
  rewrite_scope?: string[];
  graph_rewrite_payload?: GraphPayload;
}

type GraphRewriteScopeField =
  | "summary"
  | "source_text_nav"
  | "entities"
  | "entity_types"
  | "relations"
  | "confidence";

const GRAPH_REWRITE_SCOPE_FIELDS: GraphRewriteScopeField[] = [
  "summary",
  "source_text_nav",
  "entities",
  "entity_types",
  "relations",
  "confidence",
];
const GRAPH_REWRITE_SCOPE_SET = new Set<string>(GRAPH_REWRITE_SCOPE_FIELDS);

interface GateDecisionPayload {
  candidate_id?: string;
  candidate_text?: string;
  target_layer: GateTargetLayer;
  active_summary?: string;
  active_source_slice?: string;
  event?: ArchiveEventPayload;
  graph?: GraphPayload;
  merge_hint?: MergeHintPayload;
  graph_rewrite?: GraphRewritePlanPayload;
  reason?: string;
}

const WRITE_GATE_PROMPT_VERSION = "write-gate.v1.7.9";
const WRITE_GATE_STAGE_AB_PROMPT_VERSION = "write-gate.ab.v1.1.5";
const WRITE_GATE_STAGE_C_PROMPT_VERSION = "write-gate.c.v1.5.0";
const WRITE_GATE_STAGE_D_PROMPT_VERSION = "write-gate.d.v1.1.0";
const WRITE_GATE_GRAPH_REWRITE_PROMPT_VERSION = "write-gate.graph-rewrite.v1.1.0";
const WRITE_GATE_REGRESSION_SAMPLES = [
  "Example A: \"Discussed three options today, no final decision yet\" => active_only",
  "Example B: \"Decided to use plan B and completed rollout, error rate dropped to 0.2%\" => archive_event",
  "Example C: \"ok received thanks\" => skip",
];

function buildActiveValuePromptHint(schema: GraphSchemaConfig): string {
  const pick = (source: string[], wanted: string[]): string[] => {
    const available = new Set(source.map(item => item.toLowerCase()));
    return wanted.filter(item => available.has(item.toLowerCase()));
  };
  const eventSignals = pick(schema.eventTypes || [], [
    "decision",
    "issue",
    "fix",
    "constraint",
    "requirement",
    "blocker",
    "dependency",
    "action_item",
    "follow_up",
    "milestone",
    "risk",
  ]);
  const entitySignals = pick(schema.entityTypes || [], [
    "Project",
    "Task",
    "Document",
    "ConfigFile",
    "Date",
    "Person",
    "Team",
    "Resource",
  ]);
  const aliasCanonicals = [
    "Person",
    "Resource",
    "Document",
    "ConfigFile",
    "Project",
    "Task",
    "Team",
    "Date",
    "Issue",
    "Fix",
    "Milestone",
  ];
  const aliasHints = aliasCanonicals
    .map(canonical => {
      const aliases = Array.isArray(schema.entityAliases?.[canonical])
        ? schema.entityAliases[canonical].slice(0, 4)
        : [];
      if (aliases.length === 0) {
        return "";
      }
      return `${canonical}(${aliases.join("/")})`;
    })
    .filter(Boolean);
  const eventAliases = pick(Object.keys(schema.eventTypeAliases || {}), [
    "next_step",
    "next_action",
    "deadline",
    "roadblock",
    "bug",
    "error",
    "problem",
    "workaround",
  ]);
  return [
    "Valuable active_only signals must be dictionary-grounded.",
    `Use schema event types such as: ${eventSignals.join(", ")}.`,
    `Use schema entity types such as: ${entitySignals.join(", ")}.`,
    aliasHints.length > 0
      ? `Use schema entity aliases such as: ${aliasHints.join(", ")}.`
      : "",
    eventAliases.length > 0
      ? `Use schema event aliases such as: ${eventAliases.join(", ")}.`
      : "",
  ].join(" ");
}

function buildEntityDictionaryPromptHint(schema: GraphSchemaConfig): string {
  const aliases = Object.fromEntries(
    Object.entries(schema.entityAliases || {}).map(([canonical, values]) => [
      canonical,
      Array.isArray(values) ? values.slice(0, 8) : [],
    ]),
  );
  return `Entity dictionary (authoritative for concrete entities): ${JSON.stringify({
    entity_types: schema.entityTypes || [],
    entity_aliases: aliases,
  })}`;
}

function buildStablePersonalFactGraph(text: string): {
  entities: string[];
  entity_types: Record<string, string>;
  relations: GraphRelationPayload[];
  confidence?: number;
} | null {
  const source = (text || "").trim();
  if (!source) return null;
  const genericTokens = new Set<string>([
    "user", "person", "people", "system", "assistant", "agent",
  ]);
  const normalizeToken = (value: string): string => value.trim().toLowerCase();
  const isConcreteName = (value: string): boolean => {
    const name = value.trim();
    if (!name || name.length < 2) return false;
    if (genericTokens.has(normalizeToken(name))) return false;
    if (/^(wife|husband|spouse|child|kid|children)$/i.test(name)) return false;
    return true;
  };
  const extractConcreteName = (candidate: string): string => {
    const cleaned = (candidate || "").trim().replace(/[.,;:!?]+$/g, "");
    return isConcreteName(cleaned) ? cleaned : "";
  };
  const findSubjectName = (): string => {
    const patterns = [
      /([A-Za-z][A-Za-z0-9._-]{1,40})\s*'s\s*(wife|husband|spouse|child|kid|daughter|son)\b/i,
      /\b([A-Z][a-zA-Z0-9._-]{1,40})\b/,
    ];
    for (const pattern of patterns) {
      const hit = source.match(pattern);
      const candidate = hit ? extractConcreteName(hit[1] || "") : "";
      if (candidate) return candidate;
    }
    return "";
  };
  const subjectName = findSubjectName();
  if (!subjectName) return null;

  const entities = new Set<string>([subjectName]);
  const entity_types: Record<string, string> = { [subjectName]: "Person" };
  const relations: GraphRelationPayload[] = [];
  const relationKeys = new Set<string>();
  const addRelation = (relation: { source: string; target: string; type: string; evidence_span: string; context_chunk?: string; confidence: number }): void => {
    const relationKey = `${relation.source}|${relation.type}|${relation.target}`;
    if (relationKeys.has(relationKey)) return;
    relationKeys.add(relationKey);
    relations.push(relation);
  };

  const spouseNameHit = source.match(/(?:wife|husband|spouse)(?:\s*(?:named|is|:|-)?\s*)?([A-Za-z][A-Za-z0-9._-]{1,40})/i);
  const spouseName = spouseNameHit ? extractConcreteName(spouseNameHit[1] || "") : "";
  if (spouseName) {
    entities.add(spouseName);
    entity_types[spouseName] = "FamilyMember";
    addRelation({
      source: subjectName,
      target: spouseName,
      type: "has_spouse",
      evidence_span: spouseName,
      context_chunk: source.slice(0, 160).trim(),
      confidence: 0.9,
    });
  }

  const childNameHit = source.match(/(?:child|kid|daughter|son)(?:\s*(?:named|is|:|-)?\s*)?([A-Za-z][A-Za-z0-9._-]{1,40})/i);
  const childName = childNameHit ? extractConcreteName(childNameHit[1] || "") : "";
  if (childName) {
    entities.add(childName);
    entity_types[childName] = "FamilyMember";
    addRelation({
      source: subjectName,
      target: childName,
      type: "has_child",
      evidence_span: childName,
      context_chunk: source.slice(0, 160).trim(),
      confidence: 0.88,
    });
  }

  const birthdayMatch = source.match(/birthday[^\n]*?(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2})/i);
  if (birthdayMatch && spouseName) {
    const dateEntity = birthdayMatch[1];
    entities.add(dateEntity);
    entity_types[dateEntity] = "Date";
    addRelation({
      source: spouseName,
      target: dateEntity,
      type: "birthday_on",
      evidence_span: birthdayMatch[1],
      context_chunk: source.slice(0, 160).trim(),
      confidence: 0.92,
    });
  }
  if (birthdayMatch && childName) {
    const dateEntity = birthdayMatch[1];
    entities.add(dateEntity);
    entity_types[dateEntity] = "Date";
    addRelation({
      source: childName,
      target: dateEntity,
      type: "birthday_on",
      evidence_span: birthdayMatch[1],
      context_chunk: source.slice(0, 160).trim(),
      confidence: 0.9,
    });
  }

  const anniversaryMatch = source.match(/anniversary[^\n]*?(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2})/i);
  if (anniversaryMatch) {
    const dateEntity = anniversaryMatch[1];
    entities.add(dateEntity);
    entity_types[dateEntity] = "Date";
    addRelation({
      source: subjectName,
      target: dateEntity,
      type: "anniversary_on",
      evidence_span: anniversaryMatch[1],
      context_chunk: source.slice(0, 160).trim(),
      confidence: 0.9,
    });
  }
  if (relations.length === 0) return null;
  return {
    entities: [...entities],
    entity_types,
    relations,
    confidence: 0.9,
  };
}
function parseArchiveEventPayload(value: unknown): ArchiveEventPayload | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const obj = value as Record<string, unknown>;
  const eventType = typeof obj.event_type === "string" ? obj.event_type.trim() : "";
  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  const cause = typeof obj.cause === "string" ? obj.cause.trim() : "";
  const process = typeof obj.process === "string" ? obj.process.trim() : "";
  const result = typeof obj.result === "string" ? obj.result.trim() : "";
  if (!eventType || !summary || !cause || !process || !result) {
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
          const type = typeof relation.type === "string" ? relation.type.trim() : "";
          const relationOrigin = typeof relation.relation_origin === "string" ? relation.relation_origin.trim() : "";
          const relationDefinition = typeof relation.relation_definition === "string" ? relation.relation_definition.trim() : "";
          const mappingHint = typeof relation.mapping_hint === "string" ? relation.mapping_hint.trim() : "";
          const evidenceSpan = typeof relation.evidence_span === "string" ? relation.evidence_span.trim() : "";
          const confidence = typeof relation.confidence === "number"
            ? Math.max(0, Math.min(1, relation.confidence))
            : undefined;
          if (!source || !target || !type) return null;
          return {
            source,
            target,
            type,
            relation_origin: relationOrigin || undefined,
            relation_definition: relationDefinition || undefined,
            mapping_hint: mappingHint || undefined,
            evidence_span: evidenceSpan || undefined,
            confidence,
          };
        })
        .filter(Boolean) as GraphRelationPayload[]
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
    cause,
    process,
    result,
    entities,
    entity_types,
    relations,
    confidence: typeof obj.confidence === "number" ? Math.max(0, Math.min(1, obj.confidence)) : 0.6,
  };
}

function parseGraphPayload(value: unknown, options?: { allowIncomplete?: boolean }): GraphPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const allowIncomplete = options?.allowIncomplete === true;
  const obj = value as Record<string, unknown>;
  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  const sourceTextNavObj = asRecord(obj.source_text_nav);
  const source_text_nav = sourceTextNavObj
    ? {
      layer: typeof sourceTextNavObj.layer === "string" ? sourceTextNavObj.layer.trim() : undefined,
      session_id: typeof sourceTextNavObj.session_id === "string" ? sourceTextNavObj.session_id.trim() : undefined,
      source_file: typeof sourceTextNavObj.source_file === "string" ? sourceTextNavObj.source_file.trim() : undefined,
      source_memory_id: typeof sourceTextNavObj.source_memory_id === "string" ? sourceTextNavObj.source_memory_id.trim() : undefined,
      source_event_id: typeof sourceTextNavObj.source_event_id === "string" ? sourceTextNavObj.source_event_id.trim() : undefined,
      fulltext_anchor: typeof sourceTextNavObj.fulltext_anchor === "string" ? sourceTextNavObj.fulltext_anchor.trim() : undefined,
    }
    : undefined;
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
          const type = typeof rel.type === "string" && rel.type.trim() ? rel.type.trim() : "";
          if (!source || !target || !type) return null;
          const evidenceSpan = typeof rel.evidence_span === "string" ? rel.evidence_span.trim() : "";
          const confidence = typeof rel.confidence === "number"
            ? Math.max(0, Math.min(1, rel.confidence))
            : undefined;
          const relationOrigin = typeof rel.relation_origin === "string" ? rel.relation_origin.trim() : "";
          const relationDefinition = typeof rel.relation_definition === "string" ? rel.relation_definition.trim() : "";
          const mappingHint = typeof rel.mapping_hint === "string" ? rel.mapping_hint.trim() : "";
          const contextChunk = typeof rel.context_chunk === "string" ? rel.context_chunk.trim() : "";
          if (!evidenceSpan || typeof confidence !== "number") return null;
          return {
            source,
            target,
            type,
            relation_origin: relationOrigin || undefined,
            relation_definition: relationDefinition || undefined,
            mapping_hint: mappingHint || undefined,
            evidence_span: evidenceSpan,
            context_chunk: contextChunk || undefined,
            confidence,
          };
        })
        .filter((item): item is NonNullable<typeof item> => item !== null)
    : [];
  if (!allowIncomplete && (entities.length === 0 || relations.length === 0)) {
    return null;
  }
  const hasAnyField = Boolean(
    summary
    || source_text_nav
    || entities.length > 0
    || relations.length > 0
    || (entity_types && Object.keys(entity_types).length > 0)
    || typeof obj.confidence === "number",
  );
  if (!hasAnyField) {
    return null;
  }
  return {
    summary: summary || undefined,
    source_text_nav,
    entities: entities.length > 0 ? entities : undefined,
    entity_types: entity_types && Object.keys(entity_types).length > 0 ? entity_types : undefined,
    relations: relations.length > 0 ? relations : undefined,
    confidence: typeof obj.confidence === "number" ? Math.max(0, Math.min(1, obj.confidence)) : undefined,
  };
}

function toAppendableGraphPayload(payload: GraphPayload | null | undefined): GraphPayload | undefined {
  if (!payload) return undefined;
  if (!Array.isArray(payload.entities) || payload.entities.length === 0) return undefined;
  if (!Array.isArray(payload.relations) || payload.relations.length === 0) return undefined;
  return {
    ...payload,
    entities: payload.entities,
    relations: payload.relations,
  };
}

function mergeGraphPayload(base: GraphPayload | undefined, patch: GraphPayload | undefined): GraphPayload | undefined {
  if (!base && !patch) return undefined;
  if (!base) return toAppendableGraphPayload(patch);
  if (!patch) return toAppendableGraphPayload(base);
  const merged: GraphPayload = {
    ...base,
    ...patch,
    summary: patch.summary || base.summary,
    source_text_nav: patch.source_text_nav || base.source_text_nav,
    entities: patch.entities && patch.entities.length > 0 ? patch.entities : base.entities,
    entity_types: patch.entity_types && Object.keys(patch.entity_types).length > 0 ? patch.entity_types : base.entity_types,
    relations: patch.relations && patch.relations.length > 0 ? patch.relations : base.relations,
    confidence: typeof patch.confidence === "number" ? patch.confidence : base.confidence,
  };
  return toAppendableGraphPayload(merged);
}

function normalizeRewriteScope(scope: string[] | undefined): GraphRewriteScopeField[] {
  if (!Array.isArray(scope)) return [];
  const output: GraphRewriteScopeField[] = [];
  const seen = new Set<string>();
  for (const item of scope) {
    const key = typeof item === "string" ? item.trim() : "";
    if (!key || !GRAPH_REWRITE_SCOPE_SET.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(key as GraphRewriteScopeField);
  }
  return output;
}

function normalizeSourceTextNavForCompare(value: GraphPayload["source_text_nav"] | undefined): string {
  const nav = value || {};
  return JSON.stringify({
    layer: typeof nav.layer === "string" ? nav.layer.trim() : "",
    session_id: typeof nav.session_id === "string" ? nav.session_id.trim() : "",
    source_file: typeof nav.source_file === "string" ? nav.source_file.trim() : "",
    source_memory_id: typeof nav.source_memory_id === "string" ? nav.source_memory_id.trim() : "",
    source_event_id: typeof nav.source_event_id === "string" ? nav.source_event_id.trim() : "",
    fulltext_anchor: typeof nav.fulltext_anchor === "string" ? nav.fulltext_anchor.trim() : "",
  });
}

function normalizeEntitiesForCompare(value: string[] | undefined): string {
  const entities = Array.isArray(value)
    ? value.map(item => String(item || "").trim()).filter(Boolean)
    : [];
  entities.sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
  return JSON.stringify(entities);
}

function normalizeEntityTypesForCompare(value: Record<string, string> | undefined): string {
  const entries = Object.entries(value || {})
    .map(([entity, type]) => [String(entity || "").trim(), String(type || "").trim()] as const)
    .filter(([entity, type]) => entity.length > 0 && type.length > 0)
    .sort((a, b) => {
      const keyA = `${a[0].toLowerCase()}|${a[1].toLowerCase()}`;
      const keyB = `${b[0].toLowerCase()}|${b[1].toLowerCase()}`;
      return keyA.localeCompare(keyB, "en", { sensitivity: "base" });
    });
  return JSON.stringify(entries);
}

function normalizeRelationsForCompare(value: GraphRelationPayload[] | undefined): string {
  const rows = Array.isArray(value)
    ? value.map(rel => ({
      source: String(rel.source || "").trim(),
      target: String(rel.target || "").trim(),
      type: String(rel.type || "").trim(),
      relation_origin: typeof rel.relation_origin === "string" ? rel.relation_origin.trim() : "",
      relation_definition: typeof rel.relation_definition === "string" ? rel.relation_definition.trim() : "",
      mapping_hint: typeof rel.mapping_hint === "string" ? rel.mapping_hint.trim() : "",
      evidence_span: typeof rel.evidence_span === "string" ? rel.evidence_span.trim() : "",
      context_chunk: typeof rel.context_chunk === "string" ? rel.context_chunk.trim() : "",
      confidence: typeof rel.confidence === "number" ? Number(rel.confidence.toFixed(6)) : null,
    }))
    : [];
  rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), "en", { sensitivity: "base" }));
  return JSON.stringify(rows);
}

function listChangedGraphFields(base: GraphPayload | undefined, next: GraphPayload | undefined): GraphRewriteScopeField[] {
  const changed: GraphRewriteScopeField[] = [];
  if ((base?.summary || "").trim() !== (next?.summary || "").trim()) {
    changed.push("summary");
  }
  if (normalizeSourceTextNavForCompare(base?.source_text_nav) !== normalizeSourceTextNavForCompare(next?.source_text_nav)) {
    changed.push("source_text_nav");
  }
  if (normalizeEntitiesForCompare(base?.entities) !== normalizeEntitiesForCompare(next?.entities)) {
    changed.push("entities");
  }
  if (normalizeEntityTypesForCompare(base?.entity_types) !== normalizeEntityTypesForCompare(next?.entity_types)) {
    changed.push("entity_types");
  }
  if (normalizeRelationsForCompare(base?.relations) !== normalizeRelationsForCompare(next?.relations)) {
    changed.push("relations");
  }
  const baseConfidence = typeof base?.confidence === "number" ? Number(base.confidence.toFixed(6)) : null;
  const nextConfidence = typeof next?.confidence === "number" ? Number(next.confidence.toFixed(6)) : null;
  if (baseConfidence !== nextConfidence) {
    changed.push("confidence");
  }
  return changed;
}

function validateGraphRewriteCompleteness(payload: GraphPayload | undefined, schema?: GraphSchemaConfig): string[] {
  const validation = validateGraphRewritePayload(payload, { schema });
  return validation.valid ? [] : validation.errors;
}

function validateGraphRewriteResult(args: {
  basePayload: GraphPayload | undefined;
  rewrittenPayload: GraphPayload | undefined;
  rewriteScope?: string[];
  schema?: GraphSchemaConfig;
}): { valid: boolean; errors: string[]; changedFields: GraphRewriteScopeField[] } {
  const errors = validateGraphRewriteCompleteness(args.rewrittenPayload, args.schema);
  const changedFields = listChangedGraphFields(args.basePayload, args.rewrittenPayload);
  const scope = normalizeRewriteScope(args.rewriteScope);
  const implicitAllowedFields = new Set<GraphRewriteScopeField>(["summary", "entities"]);
  if (Array.isArray(args.rewriteScope)) {
    const changedScopeControlled = changedFields.filter(field => !implicitAllowedFields.has(field));
    if (scope.length === 0 && changedScopeControlled.length > 0) {
      errors.push(`rewrite_scope_violation:empty_scope_changed:${changedScopeControlled.join(",")}`);
    } else if (scope.length > 0) {
      const scopeSet = new Set(scope);
      const outOfScope = changedFields.filter(field => !implicitAllowedFields.has(field) && !scopeSet.has(field));
      if (outOfScope.length > 0) {
        errors.push(`rewrite_scope_violation:${outOfScope.join(",")}`);
      }
    }
  }
  return {
    valid: errors.length === 0,
    errors,
    changedFields,
  };
}

function canonicalizeMergeEntityName(leftRaw: string, rightRaw: string): string {
  const left = (leftRaw || "").trim();
  const right = (rightRaw || "").trim();
  if (!left) return right;
  if (!right) return left;
  const leftAscii = /^[\x00-\x7F]+$/.test(left);
  const rightAscii = /^[\x00-\x7F]+$/.test(right);
  if (leftAscii && !rightAscii) return right;
  if (!leftAscii && rightAscii) return left;
  return left.length >= right.length ? left : right;
}

function applyMergeHintToGraphPayload(args: {
  graphPayload?: GraphPayload;
  mergeHint?: MergeHintPayload;
}): { graphPayload?: GraphPayload; warnings: string[] } {
  const warnings: string[] = [];
  const graphPayload = toAppendableGraphPayload(args.graphPayload);
  const mergeHint = args.mergeHint;
  if (!mergeHint) {
    return { graphPayload, warnings };
  }
  if (!graphPayload) {
    if (mergeHint.same_event === true) {
      warnings.push("same_event_merge_failed");
    }
    return { graphPayload, warnings };
  }

  let normalizedPayload: GraphPayload = {
    ...graphPayload,
    entities: Array.isArray(graphPayload.entities) ? [...graphPayload.entities] : [],
    entity_types: graphPayload.entity_types ? { ...graphPayload.entity_types } : {},
    relations: Array.isArray(graphPayload.relations) ? graphPayload.relations.map(item => ({ ...item })) : [],
  };

  const pairs = Array.isArray(mergeHint.same_entity_pairs) ? mergeHint.same_entity_pairs : [];
  if (pairs.length > 0) {
    const aliasToCanonical = new Map<string, string>();
    const knownNames = new Set<string>();
    for (const entity of normalizedPayload.entities || []) {
      knownNames.add(entity.trim().toLowerCase());
    }
    for (const relation of normalizedPayload.relations || []) {
      knownNames.add((relation.source || "").trim().toLowerCase());
      knownNames.add((relation.target || "").trim().toLowerCase());
    }

    let unresolvedPairCount = 0;
    for (const pair of pairs) {
      const left = (pair?.[0] || "").trim();
      const right = (pair?.[1] || "").trim();
      if (!left || !right) continue;
      const canonical = canonicalizeMergeEntityName(left, right);
      for (const alias of [left, right]) {
        aliasToCanonical.set(alias.toLowerCase(), canonical);
      }
      const hit = knownNames.has(left.toLowerCase()) || knownNames.has(right.toLowerCase());
      if (!hit) {
        unresolvedPairCount += 1;
      }
    }

    const canonicalize = (value: string): string => {
      const raw = (value || "").trim();
      if (!raw) return raw;
      return aliasToCanonical.get(raw.toLowerCase()) || raw;
    };
    const dedupedEntities: string[] = [];
    const entitySeen = new Set<string>();
    for (const entity of normalizedPayload.entities || []) {
      const next = canonicalize(entity);
      const key = next.toLowerCase();
      if (!next || entitySeen.has(key)) continue;
      entitySeen.add(key);
      dedupedEntities.push(next);
    }
    const mappedEntityTypes: Record<string, string> = {};
    for (const [name, type] of Object.entries(normalizedPayload.entity_types || {})) {
      const canonical = canonicalize(name);
      if (!canonical || !type) continue;
      if (!mappedEntityTypes[canonical]) {
        mappedEntityTypes[canonical] = type;
      }
    }
    normalizedPayload = {
      ...normalizedPayload,
      entities: dedupedEntities,
      entity_types: mappedEntityTypes,
      relations: (normalizedPayload.relations || []).map(relation => ({
        ...relation,
        source: canonicalize(relation.source || ""),
        target: canonicalize(relation.target || ""),
      })),
    };
    if (unresolvedPairCount > 0) {
      warnings.push("same_entity_resolution_failed");
    }
  }

  if (mergeHint.same_event === true) {
    const relationCount = Array.isArray(normalizedPayload.relations) ? normalizedPayload.relations.length : 0;
    if (relationCount === 0) {
      warnings.push("same_event_merge_failed");
    }
  }
  return {
    graphPayload: toAppendableGraphPayload(normalizedPayload),
    warnings,
  };
}

function parseGateTargetLayer(value: unknown): GateTargetLayer | undefined {
  if (typeof value !== "string") return undefined;
  const layer = value.trim();
  if (layer === "active_only" || layer === "archive_event" || layer === "skip") {
    return layer;
  }
  return undefined;
}

function parseMergeHintPayload(value: unknown): MergeHintPayload | undefined {
  const hint = asRecord(value);
  if (!hint) return undefined;
  const candidateId = typeof hint.candidate_id === "string" ? hint.candidate_id.trim() : "";
  const sameEntityPairs = Array.isArray(hint.same_entity_pairs)
    ? hint.same_entity_pairs
      .map(pair => {
        if (!Array.isArray(pair) || pair.length < 2) return null;
        const left = typeof pair[0] === "string" ? pair[0].trim() : "";
        const right = typeof pair[1] === "string" ? pair[1].trim() : "";
        if (!left || !right) return null;
        return [left, right] as [string, string];
      })
      .filter((item): item is [string, string] => item !== null)
    : [];
  return {
    candidate_id: candidateId || undefined,
    same_event: hint.same_event === true,
    same_entity_pairs: sameEntityPairs.length > 0 ? sameEntityPairs : undefined,
    suggested_action: typeof hint.suggested_action === "string" ? hint.suggested_action.trim() : undefined,
    reason: typeof hint.reason === "string" ? hint.reason.trim() : undefined,
  };
}

function parseGraphRewritePlanPayload(value: unknown): GraphRewritePlanPayload | undefined {
  const plan = asRecord(value);
  if (!plan) return undefined;
  const rewriteRequired = plan.rewrite_required === true;
  const candidateId = typeof plan.candidate_id === "string" ? plan.candidate_id.trim() : "";
  const rewriteScopeValue = Array.isArray(plan.rewrite_scope) ? plan.rewrite_scope : null;
  const rewriteScopeProvided = Array.isArray(rewriteScopeValue);
  const rewriteScopeRaw = rewriteScopeProvided
    ? rewriteScopeValue.map((item: unknown) => typeof item === "string" ? item.trim() : "").filter(Boolean)
    : [];
  const rewriteScope = normalizeRewriteScope(rewriteScopeRaw);
  const rewritePayloadRaw = asRecord(plan.graph_rewrite_payload) || asRecord(plan.graph_payload);
  const rewritePayload = parseGraphPayload(rewritePayloadRaw || undefined, { allowIncomplete: true }) || undefined;
  return {
    candidate_id: candidateId || undefined,
    rewrite_required: rewriteRequired,
    rewrite_reason: typeof plan.rewrite_reason === "string" ? plan.rewrite_reason.trim() : undefined,
    rewrite_scope: rewriteScopeProvided ? rewriteScope : undefined,
    graph_rewrite_payload: rewritePayload,
  };
}

function parseWritePlanDecisions(rootObj: Record<string, unknown>, logger?: LoggerLike, schema?: GraphSchemaConfig): GateDecisionPayload[] {
  const writePlan = asRecord(rootObj.write_plan);
  if (!writePlan) {
    return [];
  }
  const trustedCandidateIds = new Set<string>();
  const candidateRouteById = new Map<string, GateTargetLayer>();
  const candidateTextById = new Map<string, string>();
  const candidateReasonById = new Map<string, string>();
  const orderedCandidateIds: string[] = [];

  const candidates = Array.isArray(writePlan.candidates) ? writePlan.candidates : [];
  for (const candidateRaw of candidates) {
    const candidate = asRecord(candidateRaw);
    if (!candidate) continue;
    const candidateId = typeof candidate.candidate_id === "string" ? candidate.candidate_id.trim() : "";
    if (!candidateId) continue;
    trustedCandidateIds.add(candidateId);
    if (!orderedCandidateIds.includes(candidateId)) {
      orderedCandidateIds.push(candidateId);
    }
    const route = parseGateTargetLayer(candidate.route ?? candidate.target_layer);
    if (route) {
      candidateRouteById.set(candidateId, route);
    }
    const candidateText = firstString([candidate.normalized_text, candidate.span, candidate.candidate_text, candidate.text]) || "";
    if (candidateText) {
      candidateTextById.set(candidateId, candidateText);
    }
    const reason = typeof candidate.reason === "string" ? candidate.reason.trim() : "";
    if (reason) {
      candidateReasonById.set(candidateId, reason);
    }
  }

  const activePayloadById = new Map<string, { summary: string; source_slice: string }>();
  const activePayloads = Array.isArray(writePlan.active_payloads) ? writePlan.active_payloads : [];
  for (const payloadRaw of activePayloads) {
    const payload = asRecord(payloadRaw);
    if (!payload) continue;
    const candidateId = typeof payload.candidate_id === "string" ? payload.candidate_id.trim() : "";
    if (!candidateId) continue;
    trustedCandidateIds.add(candidateId);
    const sourceSlice = firstString([payload.source_slice, payload.sourceSlice]) || "";
    if (sourceSlice && !candidateTextById.has(candidateId)) {
      candidateTextById.set(candidateId, sourceSlice);
    }
    const activeSummary = normalizeOneLineText(
      firstString([payload.summary, payload.active_summary, payload.activeSummary]) || "",
    );
    if (activeSummary || sourceSlice) {
      activePayloadById.set(candidateId, {
        summary: activeSummary,
        source_slice: sourceSlice.trim(),
      });
    }
  }

  const archivePayloadById = new Map<string, ArchiveEventPayload>();
  const archivePayloads = Array.isArray(writePlan.archive_payloads) ? writePlan.archive_payloads : [];
  for (const payloadRaw of archivePayloads) {
    const payload = asRecord(payloadRaw);
    if (!payload) continue;
    const candidateId = typeof payload.candidate_id === "string" ? payload.candidate_id.trim() : "";
    if (!candidateId) continue;
    trustedCandidateIds.add(candidateId);
    const eventObj = asRecord(payload.event);
    const sourceSlice = firstString([
      payload.source_slice,
      eventObj?.source_slice,
      payload.source_span,
      eventObj?.source_span,
      payload.normalized_text,
      eventObj?.normalized_text,
      payload.span,
      eventObj?.span,
      payload.candidate_text,
      eventObj?.candidate_text,
    ]) || "";
    if (sourceSlice && !candidateTextById.has(candidateId)) {
      candidateTextById.set(candidateId, sourceSlice);
    }
    const archiveValue = payload.event ?? payload;
    const eventValidation = validateArchiveEvent(archiveValue, { schema });
    if (!eventValidation.valid || !eventValidation.cleaned) {
      if (logger) {
        logger.warn(`quality_event_invalid candidate_id=${candidateId} errors=${eventValidation.errors.join("|")}`);
      }
      continue;
    }
    archivePayloadById.set(candidateId, {
      event_type: eventValidation.cleaned.event_type || "insight",
      summary: eventValidation.cleaned.summary,
      cause: eventValidation.cleaned.cause,
      process: eventValidation.cleaned.process,
      result: eventValidation.cleaned.result,
      entities: eventValidation.cleaned.entities,
      entity_types: eventValidation.cleaned.entity_types,
      relations: eventValidation.cleaned.relations,
      confidence: eventValidation.cleaned.confidence,
    });
  }

  const graphPayloadById = new Map<string, GraphPayload>();
  const graphPayloads = Array.isArray(writePlan.graph_payloads) ? writePlan.graph_payloads : [];
  for (const payloadRaw of graphPayloads) {
    const payload = asRecord(payloadRaw);
    if (!payload) continue;
    const candidateId = typeof payload.candidate_id === "string" ? payload.candidate_id.trim() : "";
    if (!candidateId) continue;
    trustedCandidateIds.add(candidateId);
    const sourceSlice = firstString([payload.source_slice, payload.source_span, payload.normalized_text, payload.span, payload.candidate_text]) || "";
    if (sourceSlice && !candidateTextById.has(candidateId)) {
      candidateTextById.set(candidateId, sourceSlice);
    }
    const graphValue = asRecord(payload.graph_payload) || asRecord(payload.graph) || payload;
    const graphPayload = toAppendableGraphPayload(parseGraphPayload(graphValue));
    if (!graphPayload) continue;
    graphPayloadById.set(candidateId, graphPayload);
  }

  const mergeHintById = new Map<string, MergeHintPayload>();
  const mergeHints = Array.isArray(writePlan.merge_hints) ? writePlan.merge_hints : [];
  for (const hintRaw of mergeHints) {
    const hint = parseMergeHintPayload(hintRaw);
    if (!hint?.candidate_id) continue;
    if (!trustedCandidateIds.has(hint.candidate_id)) {
      logger?.warn(`quality_gate_stage_d_unknown_candidate merge_hint candidate_id=${hint.candidate_id}`);
      continue;
    }
    mergeHintById.set(hint.candidate_id, hint);
  }

  const graphRewriteById = new Map<string, GraphRewritePlanPayload>();
  const graphRewriteItems = Array.isArray(writePlan.graph_rewrite) ? writePlan.graph_rewrite : [];
  for (const itemRaw of graphRewriteItems) {
    const item = parseGraphRewritePlanPayload(itemRaw);
    if (!item?.candidate_id) continue;
    if (!trustedCandidateIds.has(item.candidate_id)) {
      logger?.warn(`quality_gate_stage_d_unknown_candidate graph_rewrite candidate_id=${item.candidate_id}`);
      continue;
    }
    graphRewriteById.set(item.candidate_id, item);
  }

  const orderedIds: string[] = [];
  const seenIds = new Set<string>();
  function pushId(id: string): void {
    if (!id || seenIds.has(id)) return;
    seenIds.add(id);
    orderedIds.push(id);
  }
  for (const id of orderedCandidateIds) pushId(id);
  for (const id of activePayloadById.keys()) pushId(id);
  for (const id of archivePayloadById.keys()) pushId(id);
  for (const id of graphPayloadById.keys()) pushId(id);
  for (const id of mergeHintById.keys()) pushId(id);
  for (const id of graphRewriteById.keys()) pushId(id);

  const decisions: GateDecisionPayload[] = [];
  for (const candidateId of orderedIds) {
    let targetLayer = candidateRouteById.get(candidateId);
    if (!targetLayer) {
      if (archivePayloadById.has(candidateId)) {
        targetLayer = "archive_event";
      } else if (activePayloadById.has(candidateId)) {
        targetLayer = "active_only";
      } else {
        targetLayer = "skip";
      }
    }
    let event = archivePayloadById.get(candidateId);
    if (targetLayer === "archive_event" && !event) {
      if (logger) {
        logger.warn(`quality_gate_decisions_archive_missing candidate_id=${candidateId}`);
      }
      targetLayer = activePayloadById.has(candidateId) ? "active_only" : "skip";
      event = undefined;
    }
    const activePayload = activePayloadById.get(candidateId);
    const activeSummary = activePayload?.summary || "";
    const activeSourceSlice = activePayload?.source_slice || "";
    decisions.push({
      candidate_id: candidateId,
      candidate_text: candidateTextById.get(candidateId),
      target_layer: targetLayer,
      active_summary: activeSummary || undefined,
      active_source_slice: activeSourceSlice || undefined,
      event: targetLayer === "archive_event" ? event : undefined,
      graph: graphPayloadById.get(candidateId),
      merge_hint: mergeHintById.get(candidateId),
      graph_rewrite: graphRewriteById.get(candidateId),
      reason: candidateReasonById.get(candidateId) || (targetLayer === "skip" ? "llm_gate_skip" : ""),
    });
  }
  return decisions;
}

function parseLegacyRoutingDecisions(rootObj: Record<string, unknown>, logger?: LoggerLike, schema?: GraphSchemaConfig): GateDecisionPayload[] {
  const output: GateDecisionPayload[] = [];
  const candidateTextById = new Map<string, string>();
  if (Array.isArray(rootObj.candidate_events)) {
    for (const candidateRaw of rootObj.candidate_events as unknown[]) {
      if (!candidateRaw || typeof candidateRaw !== "object") continue;
      const candidate = candidateRaw as Record<string, unknown>;
      const candidateId = typeof candidate.candidate_id === "string" ? candidate.candidate_id.trim() : "";
      if (!candidateId) continue;
      const candidateText = firstString([candidate.normalized_text, candidate.span, candidate.text]) || "";
      if (candidateText) {
        candidateTextById.set(candidateId, candidateText);
      }
    }
  }
  const pushDecision = (obj: Record<string, unknown>, target: GateTargetLayer): void => {
    const candidateId = typeof obj.candidate_id === "string" ? obj.candidate_id.trim() : "";
    let event: ArchiveEventPayload | null = null;
    if (target === "archive_event") {
      const eventValidation = validateArchiveEvent(obj.event || obj, { schema });
      if (eventValidation.valid && eventValidation.cleaned) {
        event = {
          event_type: eventValidation.cleaned.event_type || "insight",
          summary: eventValidation.cleaned.summary,
          cause: eventValidation.cleaned.cause,
          process: eventValidation.cleaned.process,
          result: eventValidation.cleaned.result,
          entities: eventValidation.cleaned.entities,
          entity_types: eventValidation.cleaned.entity_types,
          relations: eventValidation.cleaned.relations,
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
      candidate_id: candidateId,
      candidate_text: candidateTextById.get(candidateId) || undefined,
      target_layer: target,
      active_summary: normalizeOneLineText(
        typeof obj.summary === "string"
          ? obj.summary
          : (typeof obj.active_summary === "string"
              ? obj.active_summary
              : (typeof obj.active_text === "string" ? obj.active_text : "")),
      ) || undefined,
      active_source_slice: firstString([
        obj.source_slice,
        obj.source_span,
      ]) || undefined,
      event: event || undefined,
      graph: toAppendableGraphPayload(parseGraphPayload(obj.graph)),
      reason: typeof obj.reason === "string" ? obj.reason.trim() : "",
    });
  };
  const routingPlan = asRecord(rootObj.routing_plan);
  if (routingPlan) {
    const buckets: Array<{ key: GateTargetLayer; items: unknown }> = [
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
  return output;
}

function parseLlmGateDecisions(raw: string, logger?: LoggerLike, schema?: GraphSchemaConfig): GateDecisionPayload[] {
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
  if (Array.isArray(root)) {
    if (logger) {
      logger.warn("quality_gate_decisions_invalid format=array_not_supported_require_write_plan");
    }
    return [];
  }
  const rootObj = asRecord(root);
  if (!rootObj) {
    if (logger) {
      logger.warn("quality_gate_decisions_invalid root_not_object");
    }
    return [];
  }
  const output = parseWritePlanDecisions(rootObj, logger, schema);
  const legacyOutput = output.length > 0 ? output : parseLegacyRoutingDecisions(rootObj, logger, schema);
  if (legacyOutput.length === 0 && logger) {
    logger.warn("quality_gate_decisions_empty");
  }
  const deduped: GateDecisionPayload[] = [];
  const seen = new Set<string>();
  for (const item of legacyOutput) {
    const key = `${item.candidate_id || ""}|${item.target_layer}|${item.event?.summary || item.active_summary || item.reason || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function readWritePlanObject(rootObj: Record<string, unknown>): Record<string, unknown> {
  return asRecord(rootObj.write_plan) || rootObj;
}

function readWritePlanArray(rootObj: Record<string, unknown>, key: string): unknown[] {
  const writePlan = readWritePlanObject(rootObj);
  const value = writePlan[key];
  return Array.isArray(value) ? value : [];
}

async function requestWriteGateStage(args: {
  stage: "ab" | "c" | "d";
  llm: { model: string; apiKey: string; baseUrl: string };
  endpoint: string;
  logger: LoggerLike;
  systemPrompt: string;
  userLines: string[];
  maxAttempts?: number;
  timeoutMs?: number;
}): Promise<Record<string, unknown> | null> {
  const body = {
    model: args.llm.model,
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: args.systemPrompt },
      { role: "user", content: args.userLines.join("\n") },
    ],
  };
  let lastError: unknown = null;
  const maxAttempts = typeof args.maxAttempts === "number" && args.maxAttempts > 0 ? args.maxAttempts : 3;
  const timeoutMs = typeof args.timeoutMs === "number" && args.timeoutMs >= 1000 ? args.timeoutMs : 25000;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let response: Awaited<ReturnType<typeof postJsonWithTimeout>>;
    try {
      response = await postJsonWithTimeout({
        endpoint: args.endpoint,
        apiKey: args.llm.apiKey,
        body,
        timeoutMs,
      });
    } catch (error) {
      lastError = error;
      continue;
    }
    if (!response.ok) {
      lastError = new Error(response.status > 0 ? `sync_llm_${args.stage}_http_${response.status}` : (response.error || `sync_llm_${args.stage}_network_error`));
      continue;
    }
    try {
      const json = (response.json || {}) as { choices?: Array<{ message?: { content?: string } }> };
      const content = json?.choices?.[0]?.message?.content || "";
      if (!content.trim()) {
        lastError = new Error(`sync_llm_${args.stage}_empty`);
        continue;
      }
      const validation = validateLlmJsonOutput(content);
      if (!validation.valid) {
        lastError = new Error(`sync_llm_${args.stage}_invalid_json:${validation.errors.join("|")}`);
        continue;
      }
      const rootObj = asRecord(validation.data);
      if (!rootObj) {
        lastError = new Error(`sync_llm_${args.stage}_root_not_object`);
        continue;
      }
      if (validation.warnings.length > 0) {
        args.logger.debug(`sync_llm_${args.stage}_warnings warnings=${validation.warnings.join("|")}`);
      }
      return rootObj;
    } catch (error) {
      lastError = error;
    }
  }
  args.logger.warn(`Sync LLM stage=${args.stage} failed: ${String(lastError || "unknown")}`);
  return null;
}

async function extractGateDecisionsWithLlm(args: {
  llm: { model: string; apiKey: string; baseUrl: string };
  transcript: string;
  logger: LoggerLike;
  schema: GraphSchemaConfig;
  relationPromptHint: string;
}): Promise<GateDecisionPayload[]> {
  const endpoint = args.llm.baseUrl.endsWith("/chat/completions")
    ? args.llm.baseUrl
    : `${args.llm.baseUrl}/chat/completions`;
  const eventSnippet = buildEventSnippet(args.transcript);
  const activeValuePromptHint = buildActiveValuePromptHint(args.schema);
  const entityDictionaryPromptHint = buildEntityDictionaryPromptHint(args.schema);
  const stableGraphFactHint = `Stable graph facts are evidence-backed and dictionary-grounded entities/relations with reusable value. ${activeValuePromptHint}`;

  const stageAbRoot = await requestWriteGateStage({
    stage: "ab",
    llm: args.llm,
    endpoint,
    logger: args.logger,
    systemPrompt: "You are memory write-gate stage A+B router. Output JSON only.",
    userLines: [
      `prompt_version=${WRITE_GATE_STAGE_AB_PROMPT_VERSION}`,
      "Task: execute Stage A+B only (denoise + candidate split + route classification).",
      "Route classes: active_only | archive_event | skip.",
      "Rules:",
      "- Denoise first: remove pure acknowledgements/politeness/chitchat/repeated filler (for example: 婵犻潧鍊婚弲顐⑩枔?闂佽　鍋撻悹鍝勬惈閻?闁荤姴顑冮崹濂告⒓?ok/got it/thanks) when they contain no task facts.",
      `- Keep factual evidence during denoise using dictionary-grounded signals. ${activeValuePromptHint}`,
      `- ${entityDictionaryPromptHint}`,
      "- Concrete entities must be source-grounded names or aliases from the dictionary above; reject generic placeholders (e.g., user/person/system/闂傚倸鍋嗛崳锝夈€?闂佸搫鍊介～澶愩€?闁诲骸婀遍崑妯肩礊?thing).",
      "- Semantic event split rule: one candidate = one principal event with a coherent subject + action/decision + object/outcome in the same phase.",
      "- Split into different candidates when topic/goal/subject changes, or when a new decision/outcome starts.",
      "- Merge sentences into one candidate when they describe the same event progression in one phase.",
      "- One candidate must represent one principal event only.",
      "- archive_event: reusable event with clear subject + action/decision + outcome/phase conclusion.",
      "- active_only: ongoing process context or temporary status without stable conclusion, but MUST contain valuable reusable information.",
      "- Active_only value criteria must follow the same dictionary-grounded signals above.",
      "- If candidate is only acknowledgement/politeness or has no valuable signal, route to skip.",
      "- skip: noise/repetition/chitchat/no clear business value.",
      "- Archive task-lifecycle by default when all three are present: user instruction -> agent completion report -> user acceptance.",
      "- If failure/iteration then eventual success exists, prefer archive_event.",
      "Candidate field definitions:",
      "- span: source text slice for this candidate (verbatim excerpt from transcript snippet, may contain minor noise).",
      "- normalized_text: denoised and normalized version of span for the same candidate; keep meaning unchanged.",
      "- When both are available, normalized_text is the canonical text field for downstream stages.",
      "Output schema:",
      "{\"write_plan\":{\"candidates\":[{\"candidate_id\":\"c1\",\"route\":\"archive_event\",\"span\":\"...\",\"normalized_text\":\"...\",\"reason\":\"...\"}]}}",
      ...WRITE_GATE_REGRESSION_SAMPLES,
      "Output JSON only. Do NOT output active_payloads/archive_payloads/graph_payloads/merge_hints/graph_rewrite.",
      "",
      "[TRANSCRIPT_SNIPPET]",
      eventSnippet,
      "[/TRANSCRIPT_SNIPPET]",
    ],
  });
  if (!stageAbRoot) {
    return [];
  }
  const stageAbCandidates = readWritePlanArray(stageAbRoot, "candidates");
  if (stageAbCandidates.length === 0) {
    args.logger.warn("quality_gate_stage_ab_empty_candidates");
    return [];
  }

  const stageCRoot = await requestWriteGateStage({
    stage: "c",
    llm: args.llm,
    endpoint,
    logger: args.logger,
    systemPrompt: "You are memory write-gate stage C payload builder. Output JSON only.",
    userLines: [
      `prompt_version=${WRITE_GATE_STAGE_C_PROMPT_VERSION}`,
      "Task: execute Stage C1/C2/C3 only.",
      "C1) Build active_payloads[] for active_only candidates.",
      "C2) Build archive_payloads[] for archive_event candidates.",
      "C3) Build graph_payloads[] for candidates with stable graph facts (independent from route).",
      "Keep candidate_id exactly equal to input candidates.",
      "- For archive_event route, C2 archive payload must include complete cause/process/result; if confidence < 0.35, prefer no archive payload for that candidate.",
      "- For every candidate routed to active_only or archive_event, C3 graph_payload is REQUIRED (non-optional).",
      "- For durable personal profile facts (family relation, birthday, anniversary, long-term schedule), C3 graph payload remains REQUIRED as a strict subset of the rule above.",
      "- Preserve key entities/relations/URLs/document paths/exact numbers/timepoints from source text; do NOT over-abstract placeholders.",
      `- ${stableGraphFactHint}`,
      `- ${entityDictionaryPromptHint}`,
      "- Concrete entities in C1/C2/C3 must follow the dictionary above and remain source-grounded; do not output generic placeholders.",
      "- Each C1/C2/C3 item must carry source_slice.",
      "- source_slice must come from the [CANDIDATES] object in this same request: use the denoised source segment text of the same candidate_id (prefer normalized_text, then span).",
      "- In [CANDIDATES], normalized_text means denoised canonical candidate text, and span means original source slice; keep source_slice semantically consistent with these fields.",
      "- source_slice is a trace field for executor write path and retrieval backtracking; keep it source-faithful (do not paraphrase, truncate, or invent text).",
      "C1 field requirements (active_payloads[] item):",
      "- candidate_id: required; must match one input candidate_id exactly.",
      "- source_slice: required; must be the denoised original text from this C1 candidate slice (full candidate text, DO NOT truncate or excerpt).",
      "- summary: required; preserve key information (cause, subject, object, and important entities grounded in the graph schema dictionary/aliases above), include stage result for process updates, and stay within 100 characters.",
      "C2 field requirements (archive_payloads[] item):",
      "- candidate_id: required; must match one input candidate_id exactly.",
      "- source_slice: required; must be the denoised original text from this C2 candidate slice.",
      "- event_type: required; must be dictionary-grounded to schema eventTypes/eventTypeAliases.",
      "- summary: required; must explain cause->process->result end-to-end and stay within 100 characters.",
      "- cause: required; explain why the event happened.",
      "- process: required; explain key execution/decision process.",
      "- result: required; explain final result/state.",
      "- entities: recommended; if present, use concrete entity names from source text.",
      "- entity_types: recommended; if entities are present, provide valid schema type for each entity.",
      "- relations: optional; if provided, each relation should be source-grounded and schema-compatible.",
      "- confidence: recommended numeric score in [0,1].",
      "C3 field requirements (graph_payloads[] item):",
      "- candidate_id: required; must match one input candidate_id exactly.",
      "- source_slice: required; must be the denoised original text from this candidate slice.",
      "- summary: required; must cover every entity listed in entities[] and explain key relations among entities.",
      "- source_text_nav: required trace object for source-location and replay; it links graph facts to the original memory/event for retrieval, citation, and debugging.",
      "- source_text_nav.layer: required; active_only or archive_event, and should be consistent with the candidate route/context.",
      "- source_text_nav.session_id: required; session id where this candidate comes from (copy from current routing context).",
      "- source_text_nav.source_file: required; source file identifier/path where this candidate comes from (copy from current routing context).",
      "- source_text_nav.source_memory_id: required; stable memory record id for this candidate in the source layer (use source_event_id when no separate memory id exists).",
      "- source_text_nav.source_event_id: required; stable event trace id for this candidate used for full-text backtracking.",
      "- entities: required array of concrete entities from source text.",
      "- entity_types: required map; every entity in entities[] must have a valid schema type.",
      "- relations: required array; each relation must be source-grounded and schema-compatible.",
      "- confidence: required number in [0,1].",
      "C3 additional requirements:",
      "- For archive_event candidates, extract richer source-grounded entities/relations from source_slice + cause/process/result when available (archive facts are higher-value).",
      "- Key-entity protection: entities explicitly mentioned in candidate span should not be dropped.",
      "- Normalize alias/cross-language references to one canonical entity when possible.",
      `- ${args.relationPromptHint}`,
      "- Every relation must include: source,target,type,relation_origin,evidence_span,context_chunk,confidence.",
      "- If relation_origin is llm_custom, relation_definition is required.",
      "Output structure (C1/C2/C3 are different item schemas):",
      "- write_plan.active_payloads[] item (C1): {candidate_id,source_slice,summary}",
      "- write_plan.archive_payloads[] item (C2): {candidate_id,source_slice,event_type,summary,cause,process,result,entities,entity_types,relations,confidence}",
      "- write_plan.graph_payloads[] item (C3): {candidate_id,source_slice,summary,source_text_nav,entities,entity_types,relations,confidence}",
      "Top-level output schema:",
      "{\"write_plan\":{\"active_payloads\":[{\"candidate_id\":\"c1\",\"source_slice\":\"...\",\"summary\":\"...\"}],\"archive_payloads\":[{\"candidate_id\":\"c2\",\"source_slice\":\"...\",\"event_type\":\"decision\",\"summary\":\"...\",\"cause\":\"...\",\"process\":\"...\",\"result\":\"...\",\"entities\":[\"A\"],\"entity_types\":{\"A\":\"Project\"},\"relations\":[],\"confidence\":0.82}],\"graph_payloads\":[{\"candidate_id\":\"c1\",\"source_slice\":\"...\",\"summary\":\"...\",\"source_text_nav\":{\"layer\":\"active_only\",\"session_id\":\"s1\",\"source_file\":\"daily_summary:2026-04-03.md\",\"source_memory_id\":\"evt_1\",\"source_event_id\":\"evt_1\"},\"entities\":[\"A\"],\"entity_types\":{\"A\":\"Project\"},\"relations\":[{\"source\":\"A\",\"target\":\"B\",\"type\":\"depends_on\",\"relation_origin\":\"canonical\",\"evidence_span\":\"A 婵炴挻纰嶇换鍡欑矉?B\",\"context_chunk\":\"闂佸憡顭囬崰鎰板几閸愨晝鈻斿┑鐘辫兌閻熸捇鏌?..\",\"confidence\":0.9}],\"confidence\":0.8}]}}",
      "Output JSON only. Do NOT output merge_hints/graph_rewrite.",
      "",
      "[CANDIDATES]",
      JSON.stringify(stageAbCandidates),
      "[/CANDIDATES]",
      "",
      "[TRANSCRIPT_SNIPPET]",
      eventSnippet,
      "[/TRANSCRIPT_SNIPPET]",
    ],
  });

  const stageCActivePayloads = stageCRoot ? readWritePlanArray(stageCRoot, "active_payloads") : [];
  const stageCArchivePayloads = stageCRoot ? readWritePlanArray(stageCRoot, "archive_payloads") : [];
  const stageCGraphPayloads = stageCRoot ? readWritePlanArray(stageCRoot, "graph_payloads") : [];

  const stageDRoot = await requestWriteGateStage({
    stage: "d",
    llm: args.llm,
    endpoint,
    logger: args.logger,
    systemPrompt: "You are memory write-gate stage D merge/rewrite planner. Output JSON only.",
    userLines: [
      `prompt_version=${WRITE_GATE_STAGE_D_PROMPT_VERSION}`,
      "Task: execute Stage D only (merge/conflict/rewrite planning).",
      "Output merge_hints[] and graph_rewrite[] only for executor consumption.",
      "Rules:",
      `- ${entityDictionaryPromptHint}`,
      `- Relation dictionary and mapping rule: ${args.relationPromptHint}`,
      `- Keep valuable factual evidence during merge/rewrite planning. ${activeValuePromptHint}`,
      "- Merge planning (how to merge):",
      "- For each candidate_id from Stage C graph_payloads, decide same_event and same_entity_pairs using source-grounded evidence.",
      "- same_event=true only when graph facts indicate continuation of the same principal event (same core entities + same relation cluster + same phase progression).",
      "- same_entity_pairs lists alias pairs that refer to the same concrete entity: [[alias,canonical_name],...].",
      "- canonical_name should prefer dictionary canonical/alias-backed concrete names; do not use generic placeholders.",
      "- If no alias merge is needed, same_entity_pairs should be empty or omitted.",
      "- Rewrite planning (how to rewrite):",
      "- rewrite_required=true only when post-merge synchronization is required for graph consistency.",
      "- Trigger rewrite when at least one is true: entity alias merge changes canonical names; relation mapping changes; summary no longer covers merged entities/relations; conflict resolution requires fact rewrite.",
      "- rewrite_scope must be a subset of: summary, source_text_nav, entities, entity_types, relations, confidence.",
      "- summary and entities are core fields and may be updated when rewrite_required=true even if not explicitly listed in rewrite_scope.",
      "- graph_rewrite_payload is optional patch payload; include only fields in rewrite_scope.",
      "- If graph_rewrite_payload.relations is provided, every relation must include source,target,type,relation_origin,evidence_span,context_chunk,confidence.",
      "- If rewrite is not needed: set rewrite_required=false, rewrite_scope=[], graph_rewrite_payload=null.",
      "- Coverage and consistency:",
      "- Keep candidate_id exactly equal to input candidate_id; do not invent candidate_id.",
      "- For every Stage C graph_payload candidate, output one merge_hints item and one graph_rewrite item.",
      "- Do not output active_payloads/archive_payloads/graph_payloads in this stage.",
      "Output schema:",
      "{\"write_plan\":{\"merge_hints\":[{\"candidate_id\":\"c1\",\"same_event\":false,\"same_entity_pairs\":[[\"Ava\",\"Ava\"]],\"suggested_action\":\"merge_aliases\",\"reason\":\"Alias pair refers to the same person\"}],\"graph_rewrite\":[{\"candidate_id\":\"c1\",\"rewrite_required\":true,\"rewrite_reason\":\"entity canonicalization changed summary and relations\",\"rewrite_scope\":[\"summary\",\"entities\",\"entity_types\",\"relations\"],\"graph_rewrite_payload\":{\"summary\":\"...\",\"entities\":[\"Ava\",\"Joe\"],\"entity_types\":{\"Ava\":\"Person\",\"Joe\":\"Person\"},\"relations\":[{\"source\":\"Joe\",\"target\":\"Ava\",\"type\":\"has_spouse\",\"relation_origin\":\"canonical\",\"evidence_span\":\"Joe is spouse of Ava\",\"context_chunk\":\"source snippet context\",\"confidence\":0.91}],\"confidence\":0.86}}]}}",
      "Output JSON only.",
      "",
      "[CANDIDATES]",
      JSON.stringify(stageAbCandidates),
      "[/CANDIDATES]",
      "",
      "[STAGE_C_PAYLOADS]",
      JSON.stringify({
        active_payloads: stageCActivePayloads,
        archive_payloads: stageCArchivePayloads,
        graph_payloads: stageCGraphPayloads,
      }),
      "[/STAGE_C_PAYLOADS]",
      "",
      "[TRANSCRIPT_SNIPPET]",
      eventSnippet,
      "[/TRANSCRIPT_SNIPPET]",
    ],
  });

  const stageDMergeHints = stageDRoot ? readWritePlanArray(stageDRoot, "merge_hints") : [];
  const stageDGraphRewrite = stageDRoot ? readWritePlanArray(stageDRoot, "graph_rewrite") : [];

  const mergedPlan = {
    write_plan: {
      candidates: stageAbCandidates,
      active_payloads: stageCActivePayloads,
      archive_payloads: stageCArchivePayloads,
      graph_payloads: stageCGraphPayloads,
      merge_hints: stageDMergeHints,
      graph_rewrite: stageDGraphRewrite,
    },
  };
  const decisions = parseWritePlanDecisions(mergedPlan, args.logger, args.schema);
  if (decisions.length > 0) {
    return decisions;
  }

  args.logger.warn("quality_gate_decisions_empty stage_pipeline");
  return [];
}

async function rewriteGraphPayloadWithLlm(args: {
  llm: { model: string; apiKey: string; baseUrl: string };
  transcript: string;
  candidateText?: string;
  graphPayload: GraphPayload;
  rewritePlan?: GraphRewritePlanPayload;
  mergeHint?: MergeHintPayload;
  schema?: GraphSchemaConfig;
  relationPromptHint: string;
  activeValuePromptHint: string;
  entityDictionaryPromptHint: string;
  logger: LoggerLike;
}): Promise<GraphPayload | undefined> {
  const endpoint = args.llm.baseUrl.endsWith("/chat/completions")
    ? args.llm.baseUrl
    : `${args.llm.baseUrl}/chat/completions`;
  const candidateText = (args.candidateText || "").trim();
  const sourceSnippet = candidateText || buildEventSnippet(args.transcript);
  const body = {
    model: args.llm.model,
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "You are a graph payload rewrite engine. Output JSON only." },
      {
        role: "user",
        content: [
          `prompt_version=${WRITE_GATE_GRAPH_REWRITE_PROMPT_VERSION}`,
          "Task: rewrite graph payload only when synchronization is required after merge/conflict checks.",
          `rewrite_required=${args.rewritePlan?.rewrite_required === true ? "true" : "false"}`,
          `rewrite_reason=${args.rewritePlan?.rewrite_reason || ""}`,
          `rewrite_scope=${(args.rewritePlan?.rewrite_scope || []).join(",")}`,
          `merge_same_event=${args.mergeHint?.same_event === true ? "true" : "false"}`,
          `merge_same_entity_pairs=${JSON.stringify(args.mergeHint?.same_entity_pairs || [])}`,
          "Rewrite policy:",
          "- Return a FULL graph_payload object (not partial): include summary, source_text_nav, entities, entity_types, relations, confidence.",
          "- Apply semantic changes only for fields in rewrite_scope; for fields outside rewrite_scope, copy from CURRENT_GRAPH_PAYLOAD unless hard validation requires normalization.",
          "- Prefer merge-hint canonical entities for alias unification when same_entity_pairs is provided.",
          "- Do not invent new facts outside SOURCE_SNIPPET and CURRENT_GRAPH_PAYLOAD.",
          "- Keep factual evidence and valuable signals. "
            + "Decisions/problems/fixes/constraints/requirements/names/deadlines/metrics/URLs/paths/document ids/config-version details should be preserved when present. "
            + args.activeValuePromptHint,
          "Hard constraints:",
          `- ${args.entityDictionaryPromptHint}`,
          "- Keep entities concrete, dictionary-grounded names/aliases; no generic placeholders.",
          "- Keep relations source-grounded and evidence-backed.",
          "- Do not output related_to.",
          `- ${args.relationPromptHint}`,
          "Field contract (required):",
          "- graph_payload.summary: must cover all entities and key relations.",
          "- If source_text_nav.layer is active_only, summary must preserve key information (cause, subject, object and important entities grounded in the graph schema dictionary/aliases), include stage result for process updates, and stay within 100 characters.",
          "- summary should remain model-authored text; do not apply rule-based hard truncation after generation.",
          "- graph_payload.source_text_nav: required object with layer,session_id,source_file,source_memory_id,source_event_id; fulltext_anchor optional.",
          "- graph_payload.entities: required array of concrete entity names; deduplicated.",
          "- graph_payload.entity_types: required map; every entity in entities should have a type from dictionary.",
          "- graph_payload.relations: required array; each relation source/target should refer to entities in graph_payload.entities.",
          "- Every relation must include source,target,type,relation_origin,evidence_span,context_chunk,confidence.",
          "- relation_origin: canonical or llm_custom.",
          "- If relation_origin is llm_custom, relation_definition is required.",
          "- graph_payload.confidence: required number in [0,1], reflecting final payload certainty.",
          "Consistency checks before output:",
          "- Ensure summary mentions entities and does not contradict relations.",
          "- Ensure context_chunk/evidence_span comes from source text and supports the relation.",
          "- If rewrite_scope is empty, output CURRENT_GRAPH_PAYLOAD unchanged.",
          "Output schema:",
          "{\"graph_payload\":{\"summary\":\"...\",\"source_text_nav\":{\"layer\":\"archive_event\",\"session_id\":\"...\",\"source_file\":\"...\",\"source_memory_id\":\"...\",\"source_event_id\":\"...\"},\"entities\":[\"...\"],\"entity_types\":{\"...\":\"...\"},\"relations\":[{\"source\":\"...\",\"target\":\"...\",\"type\":\"...\",\"relation_origin\":\"canonical\",\"evidence_span\":\"...\",\"context_chunk\":\"...\",\"confidence\":0.9}],\"confidence\":0.8}}",
          "",
          "[CURRENT_GRAPH_PAYLOAD]",
          JSON.stringify(args.graphPayload),
          "[/CURRENT_GRAPH_PAYLOAD]",
          "",
          "[SOURCE_SNIPPET]",
          sourceSnippet,
          "[/SOURCE_SNIPPET]",
        ].join("\n"),
      },
    ],
  };

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response: Awaited<ReturnType<typeof postJsonWithTimeout>>;
    try {
      response = await postJsonWithTimeout({
        endpoint,
        apiKey: args.llm.apiKey,
        body,
        timeoutMs: 25000,
      });
    } catch (error) {
      lastError = error;
      continue;
    }
    if (!response.ok) {
      lastError = new Error(response.status > 0 ? `graph_rewrite_http_${response.status}` : (response.error || "graph_rewrite_network_error"));
      continue;
    }
    try {
      const json = (response.json || {}) as { choices?: Array<{ message?: { content?: string } }> };
      const content = json?.choices?.[0]?.message?.content || "";
      if (!content.trim()) {
        lastError = new Error("graph_rewrite_empty");
        continue;
      }
      const validation = validateLlmJsonOutput(content);
      if (!validation.valid) {
        lastError = new Error(`graph_rewrite_invalid_json:${validation.errors.join("|")}`);
        continue;
      }
      const rootObj = asRecord(validation.data);
      const candidatePayload = rootObj
        ? (asRecord(rootObj.graph_payload) || asRecord(rootObj.graph) || rootObj)
        : null;
      const rewritten = toAppendableGraphPayload(parseGraphPayload(candidatePayload || undefined));
      if (rewritten) {
        const rewriteValidation = validateGraphRewriteResult({
          basePayload: args.graphPayload,
          rewrittenPayload: rewritten,
          rewriteScope: args.rewritePlan?.rewrite_scope,
          schema: args.schema,
        });
        if (!rewriteValidation.valid) {
          lastError = new Error(`graph_rewrite_invalid_payload:${rewriteValidation.errors.join("|")}`);
          continue;
        }
        return rewritten;
      }
      lastError = new Error("graph_rewrite_invalid_payload");
    } catch (error) {
      lastError = error;
    }
  }
  args.logger.warn(`graph_rewrite_failed reason=${String(lastError || "unknown")}`);
  return undefined;
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
  const includeLocalActiveInput = options.syncPolicy?.includeLocalActiveInput === true;
  const graphSchema = loadGraphSchema(options.projectRoot);
  const relationPromptHint = buildRelationPromptHint(graphSchema);
  const activeValuePromptHint = buildActiveValuePromptHint(graphSchema);
  const entityDictionaryPromptHint = buildEntityDictionaryPromptHint(graphSchema);
  options.logger.info(`sync_gate_prompt_version=${WRITE_GATE_PROMPT_VERSION}`);
  options.logger.info(
    `sync_gate_stage_versions=ab:${WRITE_GATE_STAGE_AB_PROMPT_VERSION},c:${WRITE_GATE_STAGE_C_PROMPT_VERSION},d:${WRITE_GATE_STAGE_D_PROMPT_VERSION},rw:${WRITE_GATE_GRAPH_REWRITE_PROMPT_VERSION}`,
  );
  options.logger.info(`sync_include_local_active_input=${includeLocalActiveInput}`);
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
    const activeTextMaxChars = resolveWriteCharLimit(options.writePolicy?.activeTextMaxChars, 500, 200000);
    const archiveSourceTextMaxChars = resolveWriteCharLimit(options.writePolicy?.archiveSourceTextMaxChars, 1000, 500000);
    const normalizedTranscript = denoiseTranscriptForWrite(args.transcript);
    function bumpReason(reason: string): void {
      const key = reason || "unknown";
      skipReasons[key] = (skipReasons[key] || 0) + 1;
    }
    if (!normalizedTranscript.trim()) {
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
      let fallbackWrite: Awaited<ReturnType<typeof options.writeStore.writeMemory>>;
      try {
        fallbackWrite = await options.writeStore.writeMemory({
          text: tailByCharLimit(normalizedTranscript, activeTextMaxChars),
          sourceText: normalizedTranscript,
          role: "system",
          source: `sync_gate_fallback:${args.sourceFile}`,
          sessionId: args.sessionId,
        });
      } catch (error) {
        options.logger.warn(`sync_skip reason=active_only_fallback_exception session=${args.sessionId} error=${String(error)}`);
        bumpReason("active_only_fallback_exception");
        return { imported: 0, skipped: 1, ok: false, llmDecisions: 1, activeOnly: 0, archiveEvent: 0, skipReasons };
      }
      if (fallbackWrite.status === "ok") {
        return { imported: 1, skipped: 0, ok: true, llmDecisions: 1, activeOnly: 1, archiveEvent: 0, skipReasons };
      }
      bumpReason(fallbackWrite.reason || "active_only_fallback_failed");
      return { imported: 0, skipped: 1, ok: false, llmDecisions: 1, activeOnly: 0, archiveEvent: 0, skipReasons };
    }
    const decisions = await extractGateDecisionsWithLlm({
      llm: { model: llmModel, apiKey: llmApiKey, baseUrl: llmBaseUrl },
      transcript: normalizedTranscript,
      logger: options.logger,
      schema: graphSchema,
      relationPromptHint,
    });
    const routedDecisions = appendLifecycleArchiveDecision(decisions, normalizedTranscript, options.logger);
    if (routedDecisions.length === 0) {
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
    let graphRewriteRequested = 0;
    let graphRewriteTriggered = 0;
    let graphRewriteApplied = 0;
    let graphRewriteFailed = 0;
    const archiveInputs: Array<{
      candidate_id?: string;
      graph_payload?: GraphPayload;
      event_type: string;
      summary: string;
      cause?: string;
      process?: string;
      result?: string;
      entities?: string[];
      relations?: GraphRelationPayload[];
      entity_types?: Record<string, string>;
      session_id: string;
      source_file: string;
      source_text?: string;
      confidence?: number;
      source_event_id?: string;
      actor?: string;
    }> = [];
    function resolveGraphSummary(payload: GraphPayload): string {
      return typeof payload.summary === "string" ? payload.summary.trim() : "";
    }
    function buildAppendSourceTextNav(argsForAppend: {
      sourceEventId: string;
      sourceLayer: "archive_event" | "active_only";
      archiveEventId?: string;
      graphPayload?: GraphPayload;
    }): {
      layer: "archive_event" | "active_only";
      session_id: string;
      source_file: string;
      source_memory_id: string;
      source_event_id: string;
      fulltext_anchor?: string;
    } {
      const nav = argsForAppend.graphPayload?.source_text_nav;
      const forceArchiveTrace = argsForAppend.sourceLayer === "archive_event" && !!argsForAppend.archiveEventId;
      const sourceEventId = forceArchiveTrace
        ? (argsForAppend.archiveEventId || argsForAppend.sourceEventId)
        : ((nav?.source_event_id || "").trim() || argsForAppend.sourceEventId);
      const sourceMemoryId = forceArchiveTrace
        ? (argsForAppend.archiveEventId || argsForAppend.sourceEventId)
        : ((nav?.source_memory_id || "").trim() || argsForAppend.archiveEventId || argsForAppend.sourceEventId);
      return {
        layer: forceArchiveTrace
          ? "archive_event"
          : (nav?.layer === "archive_event" || nav?.layer === "active_only"
            ? nav.layer
            : argsForAppend.sourceLayer),
        session_id: (nav?.session_id || "").trim() || args.sessionId,
        source_file: (nav?.source_file || "").trim() || args.sourceFile || "unknown",
        source_memory_id: sourceMemoryId,
        source_event_id: sourceEventId,
        fulltext_anchor: (nav?.fulltext_anchor || "").trim() || undefined,
      };
    }
    async function appendGraphPayload(argsForAppend: {
      sourceEventId: string;
      sourceLayer: "archive_event" | "active_only";
      archiveEventId?: string;
      eventType?: string;
      graphPayload?: GraphPayload;
      sourceText: string;
    }): Promise<void> {
      if (!options.graphMemoryStore) {
        return;
      }
      const appendableGraph = toAppendableGraphPayload(argsForAppend.graphPayload);
      if (!appendableGraph) {
        return;
      }
      const summary = resolveGraphSummary(appendableGraph);
      if (!summary) {
        graphSkipped += 1;
        options.logger.info(
          `graph_skip_reason=missing_summary source_event_id=${argsForAppend.sourceEventId}`,
        );
        return;
      }
      const sourceTextNav = buildAppendSourceTextNav({
        sourceEventId: argsForAppend.sourceEventId,
        sourceLayer: argsForAppend.sourceLayer,
        archiveEventId: argsForAppend.archiveEventId,
        graphPayload: appendableGraph,
      });
      graphAttempted += 1;
      let graphResult: Awaited<ReturnType<NonNullable<typeof options.graphMemoryStore>["append"]>>;
      try {
        graphResult = await options.graphMemoryStore.append({
          sourceEventId: argsForAppend.sourceEventId,
          sourceLayer: argsForAppend.sourceLayer,
          archiveEventId: argsForAppend.archiveEventId,
          sessionId: args.sessionId,
          sourceFile: args.sourceFile,
          source_text_nav: sourceTextNav,
          summary,
          eventType: argsForAppend.eventType || "insight",
          entities: appendableGraph.entities,
          entity_types: appendableGraph.entity_types,
          relations: appendableGraph.relations,
          gateSource: "sync",
          confidence: appendableGraph.confidence,
          sourceText: argsForAppend.sourceText,
        });
      } catch (error) {
        graphSkipped += 1;
        options.logger.warn(
          `graph_append_exception source_event_id=${argsForAppend.sourceEventId} error=${String(error)}`,
        );
        return;
      }
      if (!graphResult.success) {
        graphSkipped += 1;
        options.logger.info(
          `graph_skip_reason=${graphResult.reason} source_event_id=${argsForAppend.sourceEventId}`,
        );
        return;
      }
      graphStored += 1;
    }
    function buildGraphOnlySourceEventId(argsForGraphOnly: {
      candidateId?: string;
      graphPayload?: GraphPayload;
      fallbackText: string;
    }): string {
      if (argsForGraphOnly.candidateId) {
        return `candidate:${args.sessionId}:${argsForGraphOnly.candidateId}`;
      }
      const relationFingerprint = (argsForGraphOnly.graphPayload?.relations || [])
        .map(rel => `${rel.source}|${rel.type}|${rel.target}|${rel.evidence_span || ""}`)
        .sort()
        .join("||");
      return `graph_only:${args.sessionId}:${crypto.createHash("sha1").update(relationFingerprint || argsForGraphOnly.fallbackText).digest("hex").slice(0, 16)}`;
    }

    for (const decision of routedDecisions) {
      llmDecisions += 1;
      const decisionActiveSummary = normalizeOneLineText(decision.active_summary || "");
      const decisionActiveSourceSlice = (decision.active_source_slice || "").trim();
      const fallbackGraphPayload = !decision.graph
        ? buildStablePersonalFactGraph(decisionActiveSummary || decision.candidate_text || normalizedTranscript)
        : null;
      let graphPayload = mergeGraphPayload(
        toAppendableGraphPayload(decision.graph),
        toAppendableGraphPayload(fallbackGraphPayload || undefined),
      );
      if (decisionActiveSummary && graphPayload && !normalizeOneLineText(graphPayload.summary || "")) {
        graphPayload = { ...graphPayload, summary: decisionActiveSummary };
      }
      const mergeReviewed = applyMergeHintToGraphPayload({
        graphPayload,
        mergeHint: decision.merge_hint,
      });
      graphPayload = mergeReviewed.graphPayload;
      for (const warning of mergeReviewed.warnings) {
        bumpReason(warning);
        options.logger.warn(
          `graph_merge_hint_warning reason=${warning} session=${args.sessionId} candidate_id=${decision.candidate_id || "unknown"}`,
        );
      }
      if (decision.graph_rewrite?.rewrite_required) {
        graphRewriteRequested += 1;
        graphRewriteTriggered += 1;
        let rewriteApplied = false;
        const mergedRewritePayload = mergeGraphPayload(graphPayload, decision.graph_rewrite.graph_rewrite_payload);
        if (mergedRewritePayload) {
          const plannerRewriteValidation = validateGraphRewriteResult({
            basePayload: graphPayload,
            rewrittenPayload: mergedRewritePayload,
            rewriteScope: decision.graph_rewrite.rewrite_scope,
            schema: graphSchema,
          });
          if (plannerRewriteValidation.valid) {
            graphPayload = mergedRewritePayload;
            graphRewriteApplied += 1;
            rewriteApplied = true;
          } else {
            bumpReason("graph_rewrite_invalid_payload");
            options.logger.warn(
              `graph_rewrite_invalid source=planner session=${args.sessionId} candidate_id=${decision.candidate_id || "unknown"} errors=${plannerRewriteValidation.errors.join("|")}`,
            );
          }
        }
        if (!rewriteApplied && graphPayload) {
          const rewritten = await rewriteGraphPayloadWithLlm({
            llm: { model: llmModel, apiKey: llmApiKey, baseUrl: llmBaseUrl },
            transcript: normalizedTranscript,
            candidateText: decision.candidate_text || decisionActiveSummary,
            graphPayload,
            rewritePlan: decision.graph_rewrite,
            mergeHint: decision.merge_hint,
            schema: graphSchema,
            relationPromptHint,
            activeValuePromptHint,
            entityDictionaryPromptHint,
            logger: options.logger,
          });
          if (rewritten) {
            graphPayload = rewritten;
            graphRewriteApplied += 1;
            rewriteApplied = true;
          } else {
            graphRewriteFailed += 1;
          }
        }
        if (!rewriteApplied && !graphPayload) {
          graphRewriteFailed += 1;
        }
      }
      if (decision.target_layer === "skip") {
        if (graphPayload) {
          const graphOnlySourceEventId = buildGraphOnlySourceEventId({
            candidateId: decision.candidate_id,
            graphPayload,
            fallbackText: normalizedTranscript,
          });
          await appendGraphPayload({
            sourceEventId: graphOnlySourceEventId,
            sourceLayer: "active_only",
            eventType: "insight",
            sourceText: normalizedTranscript,
            graphPayload,
          });
        }
        skipped += 1;
        bumpReason(decision.reason || "llm_gate_skip");
        continue;
      }
      if (decision.target_layer === "active_only") {
        activeAttempted += 1;
        const activeSummary = decisionActiveSummary
          || normalizeOneLineText(graphPayload?.summary || "")
          || normalizeOneLineText(decision.candidate_text || "");
        const activeText = tailByCharLimit(activeSummary, activeTextMaxChars);
        const activeSourceSlice = decisionActiveSourceSlice;
        if (activeSummary && graphPayload && !normalizeOneLineText(graphPayload.summary || "")) {
          graphPayload = { ...graphPayload, summary: activeSummary };
        }
        if (!activeText) {
          if (graphPayload) {
            const graphOnlySourceEventId = buildGraphOnlySourceEventId({
              candidateId: decision.candidate_id,
              graphPayload,
              fallbackText: normalizedTranscript,
            });
            await appendGraphPayload({
              sourceEventId: graphOnlySourceEventId,
              sourceLayer: "active_only",
              eventType: "insight",
              sourceText: decision.candidate_text || normalizedTranscript,
              graphPayload,
            });
          }
          skipped += 1;
          bumpReason("active_summary_missing");
          continue;
        }
        if (!activeSourceSlice) {
          skipped += 1;
          bumpReason("active_source_slice_missing");
          options.logger.warn(`sync_skip reason=active_source_slice_missing session=${args.sessionId} candidate_id=${decision.candidate_id || "unknown"}`);
          continue;
        }
        if (!hasValuableActiveContent(activeText)) {
          if (graphPayload) {
            const graphOnlySourceEventId = buildGraphOnlySourceEventId({
              candidateId: decision.candidate_id,
              graphPayload,
              fallbackText: activeText,
            });
            await appendGraphPayload({
              sourceEventId: graphOnlySourceEventId,
              sourceLayer: "active_only",
              eventType: "insight",
              sourceText: activeSourceSlice,
              graphPayload,
            });
          }
          skipped += 1;
          bumpReason("active_only_low_value");
          options.logger.info(`sync_skip reason=active_only_low_value session=${args.sessionId} candidate_id=${decision.candidate_id || "unknown"}`);
          continue;
        }
        if (!graphPayload) {
          skipped += 1;
          bumpReason("graph_payload_required_active");
          options.logger.warn(`sync_skip reason=graph_payload_required_active session=${args.sessionId} candidate_id=${decision.candidate_id || "unknown"}`);
          continue;
        }
        let writeResult: Awaited<ReturnType<typeof options.writeStore.writeMemory>>;
        try {
          writeResult = await options.writeStore.writeMemory({
            text: activeText,
            summary: activeSummary || undefined,
            sourceText: activeSourceSlice,
            role: "system",
            source: `sync_gate_active:${args.sourceFile}`,
            sessionId: args.sessionId,
          });
        } catch (error) {
          skipped += 1;
          bumpReason("active_only_write_exception");
          options.logger.warn(
            `sync_skip reason=active_only_write_exception session=${args.sessionId} candidate_id=${decision.candidate_id || "unknown"} error=${String(error)}`,
          );
          continue;
        }
        if (writeResult.status === "ok") {
          imported += 1;
          activeOnly += 1;
          if (graphPayload) {
            const relationFingerprint = (graphPayload.relations || [])
              .map(rel => `${rel.source}|${rel.type}|${rel.target}|${rel.evidence_span || ""}`)
              .sort()
              .join("||");
            const activeSourceEventId = `active:${args.sessionId}:${crypto.createHash("sha1").update(relationFingerprint || activeText).digest("hex").slice(0, 16)}`;
            await appendGraphPayload({
              sourceEventId: activeSourceEventId,
              sourceLayer: "active_only",
              eventType: "insight",
              sourceText: activeSourceSlice,
              graphPayload,
            });
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
        const archiveFallbackGraph = toAppendableGraphPayload({
          summary: decision.event.summary,
          entities: decision.event.entities,
          entity_types: decision.event.entity_types,
          relations: decision.event.relations,
          confidence: decision.event.confidence,
        });
        graphPayload = mergeGraphPayload(graphPayload, archiveFallbackGraph) || graphPayload || archiveFallbackGraph;
        if (!graphPayload) {
          skipped += 1;
          bumpReason("graph_payload_required_archive");
          options.logger.warn(`sync_skip reason=graph_payload_required_archive session=${args.sessionId} candidate_id=${decision.candidate_id || "unknown"}`);
          continue;
        }
        const archiveSourceSlice = tailByCharLimit(
          denoiseTranscriptForWrite(decision.candidate_text || normalizedTranscript),
          archiveSourceTextMaxChars,
        );
        archiveInputs.push({
          candidate_id: decision.candidate_id,
          graph_payload: graphPayload,
          event_type: decision.event.event_type,
          summary: decision.event.summary,
          cause: decision.event.cause,
          process: decision.event.process,
          result: decision.event.result,
          entities: decision.event.entities,
          relations: decision.event.relations,
          entity_types: decision.event.entity_types,
          confidence: decision.event.confidence,
          session_id: args.sessionId,
          source_file: args.sourceFile,
          source_text: archiveSourceSlice || tailByCharLimit(normalizedTranscript, archiveSourceTextMaxChars),
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
        let archiveResult: Awaited<ReturnType<typeof options.archiveStore.storeEvents>>;
        try {
          archiveResult = await options.archiveStore.storeEvents([inputRecord]);
        } catch (error) {
          archivedSkipped += 1;
          skipped += 1;
          bumpReason("archive_store_exception");
          options.logger.warn(
            `sync_skip reason=archive_store_exception session=${args.sessionId} candidate_id=${inputRecord.candidate_id || "unknown"} error=${String(error)}`,
          );
          continue;
        }
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
        const archiveGraphPayload = inputRecord.graph_payload
          || toAppendableGraphPayload({
            entities: inputRecord.entities,
            entity_types: inputRecord.entity_types,
            relations: inputRecord.relations,
            confidence: inputRecord.confidence,
          });
        await appendGraphPayload({
          // Graph trace points to persisted archive record id for stable lookup.
          sourceEventId: archiveRecord.id,
          sourceLayer: "archive_event",
          archiveEventId: archiveRecord.id,
          eventType: inputRecord.event_type,
          sourceText: inputRecord.source_text || normalizedTranscript,
          graphPayload: archiveGraphPayload,
        });
      }
      options.logger.info(
        `sync_archive_result session=${args.sessionId} archived_success=${archivedSuccess} skipped=${archivedSkipped}`,
      );
    }
    options.logger.info(
      `sync_gate_result session=${args.sessionId} llm_decisions=${llmDecisions} active_only=${activeOnly} archive_event=${archiveEvent} skipped=${skipped}`,
    );
    options.logger.info(
      `sync_gate_metrics session=${args.sessionId} active_attempted=${activeAttempted} archive_attempted=${archiveAttempted} graph_attempted=${graphAttempted} graph_stored=${graphStored} graph_skipped=${graphSkipped} graph_rewrite_requested=${graphRewriteRequested} graph_rewrite_triggered=${graphRewriteTriggered} graph_rewrite_applied=${graphRewriteApplied} graph_rewrite_failed=${graphRewriteFailed} skip_reason_kinds=${Object.keys(skipReasons).length}`,
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
    const files = gatherSessionFiles(openclawBasePath, memoryRoot, includeLocalActiveInput);
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
      const fileSessionSeed = path.basename(filePath, path.extname(filePath));
      let fileSessionId: string | undefined;
      for (let i = startIndex; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const record = JSON.parse(line) as Record<string, unknown>;
          if (!fileSessionId) {
            const inferred = getSessionId(record, fileSessionSeed);
            if (inferred && inferred !== `sync:${fileSessionSeed}`) {
              fileSessionId = inferred;
            }
          }
          const messages = extractMessages(record);
          if (messages.length === 0) {
            skipped += 1;
            continue;
          }
          const fallbackSession = fileSessionId || fileSessionSeed;
          const sessionId = getSessionId(record, fallbackSession);
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
