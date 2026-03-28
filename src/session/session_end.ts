import * as fs from "fs";
import * as path from "path";
import {
  loadGraphSchema,
  normalizeEventType,
  validateRelations,
} from "../graph/ontology";

interface LoggerLike {
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
}

interface SessionEndState {
  sessions: Record<string, { signature: string; endedAt: string }>;
  recovery: Record<string, { signature: string; detectedAt: string }>;
}

interface SessionEndOptions {
  projectRoot: string;
  dbPath?: string;
  logger: LoggerLike;
  syncMemory: () => Promise<{ imported: number; skipped: number; filesProcessed: number }>;
  syncDailySummaries?: () => Promise<{ imported: number; skipped: number; filesProcessed: number }>;
  archiveStore: {
    storeEvents(events: Array<{
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
    }>): Promise<{ stored: Array<{ id: string }>; skipped: Array<{ summary: string; reason: string }> }>;
  };
  llm?: {
    provider: string;
    model: string;
    apiKey?: string;
    baseURL?: string;
    baseUrl?: string;
  };
}

interface SessionRecord {
  id?: string;
  session_id?: string;
  role?: string;
  content?: string;
  timestamp?: string;
}

interface StructuredEvent {
  event_type: string;
  summary: string;
  entities?: string[];
  relations?: Array<{ source: string; target: string; type: string }>;
  entity_types?: Record<string, string>;
  outcome?: string;
  confidence?: number;
  source_event_id?: string;
  actor?: string;
}

function readState(filePath: string): SessionEndState {
  try {
    if (!fs.existsSync(filePath)) {
      return { sessions: {}, recovery: {} };
    }
    const content = fs.readFileSync(filePath, "utf-8").trim();
    if (!content) {
      return { sessions: {}, recovery: {} };
    }
    const parsed = JSON.parse(content) as SessionEndState;
    if (!parsed.sessions || typeof parsed.sessions !== "object") {
      return { sessions: {}, recovery: {} };
    }
    if (!parsed.recovery || typeof parsed.recovery !== "object") {
      parsed.recovery = {};
    }
    return parsed;
  } catch {
    return { sessions: {}, recovery: {} };
  }
}

function writeState(filePath: string, state: SessionEndState): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
}

function normalizeBaseUrl(value?: string): string {
  if (!value) return "";
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function loadActiveSessionRecords(activePath: string, sessionId: string): SessionRecord[] {
  if (!fs.existsSync(activePath)) {
    return [];
  }
  const lines = fs.readFileSync(activePath, "utf-8").split(/\r?\n/).filter(Boolean);
  const records: SessionRecord[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as SessionRecord;
      if (parsed.session_id === sessionId) {
        records.push(parsed);
      }
    } catch {}
  }
  return records;
}

function summarize(records: SessionRecord[]): { summary: string; entities: string[]; outcome: string; signature: string } {
  const messageCount = records.length;
  const userCount = records.filter(r => r.role === "user").length;
  const assistantCount = records.filter(r => r.role === "assistant").length;
  const lastMessages = records.slice(Math.max(0, records.length - 3)).map(r => r.content || "").filter(Boolean);
  const summary = `Session ended with ${messageCount} messages. User: ${userCount}, assistant: ${assistantCount}. Recent: ${lastMessages.join(" | ")}`.slice(0, 500);
  const entities = ["session_end", "message_summary"];
  const outcome = "success";
  const signature = records.map(r => `${r.id || ""}:${r.timestamp || ""}:${r.content || ""}`).join("||");
  return { summary, entities, outcome, signature };
}

function preprocess(records: SessionRecord[]): Array<{ role: string; content: string; timestamp: string }> {
  return records
    .map(record => ({
      role: typeof record.role === "string" && record.role.trim() ? record.role.trim() : "unknown",
      content: typeof record.content === "string" ? record.content.trim() : "",
      timestamp: typeof record.timestamp === "string" && record.timestamp.trim() ? record.timestamp : new Date().toISOString(),
    }))
    .filter(item => item.content.length > 0);
}

function fallbackEvents(records: SessionRecord[]): StructuredEvent[] {
  const base = summarize(records);
  return [
    {
      event_type: "conversation_summary",
      summary: base.summary,
      entities: base.entities,
      outcome: base.outcome,
      confidence: 0.6,
    },
  ];
}

function parseLlmJsonArray(raw: string, graphSchema: ReturnType<typeof loadGraphSchema>): StructuredEvent[] {
  const trimmed = raw.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence?.[1]?.trim() || trimmed;
  const parsed = JSON.parse(candidate) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }
  const events: StructuredEvent[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const obj = item as Record<string, unknown>;
    const eventType = typeof obj.event_type === "string" ? normalizeEventType(obj.event_type, graphSchema) : "";
    const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
    if (!eventType || !summary) {
      continue;
    }
    const entities = Array.isArray(obj.entities)
      ? obj.entities.map(value => (typeof value === "string" ? value.trim() : "")).filter(Boolean)
      : [];
    const relations = Array.isArray(obj.relations)
      ? obj.relations
          .map(value => {
            if (typeof value !== "object" || value === null) return null;
            const relation = value as Record<string, unknown>;
            const source = typeof relation.source === "string" ? relation.source.trim() : "";
            const target = typeof relation.target === "string" ? relation.target.trim() : "";
            const type = typeof relation.type === "string" ? relation.type.trim() : "related_to";
            if (!source || !target) return null;
            return { source, target, type };
          })
          .filter((value): value is { source: string; target: string; type: string } => Boolean(value))
      : [];
    events.push({
      event_type: eventType,
      summary,
      entities,
      relations,
      entity_types: typeof obj.entity_types === "object" && obj.entity_types !== null
        ? Object.fromEntries(Object.entries(obj.entity_types as Record<string, unknown>).filter(([, value]) => typeof value === "string").map(([key, value]) => [key, String(value)]))
        : undefined,
      outcome: typeof obj.outcome === "string" ? obj.outcome.trim() : "",
      confidence: typeof obj.confidence === "number"
        ? Math.max(0, Math.min(1, obj.confidence))
        : undefined,
    });
  }
  return events;
}

async function extractEventsWithLlm(args: {
  llm: {
    model: string;
    apiKey: string;
    baseUrl: string;
  };
  records: Array<{ role: string; content: string; timestamp: string }>;
  graphSchema: ReturnType<typeof loadGraphSchema>;
}): Promise<StructuredEvent[]> {
  const endpoint = args.llm.baseUrl.endsWith("/chat/completions")
    ? args.llm.baseUrl
    : `${args.llm.baseUrl}/chat/completions`;
  const transcript = args.records
    .map(item => `${item.timestamp} [${item.role}] ${item.content}`)
    .join("\n")
    .slice(-12000);
  const schemaPrompt = [
    "请从下面会话中提取多个可长期记忆事件，按 JSON 数组输出。",
    "每个元素字段：event_type, summary, entities[], relations[], entity_types, outcome, confidence。",
    "entity_types 是对象，键为实体名，值为类型（如 Task/Issue/Fix/Plan/Milestone/Project/Person/Team/Concept）。",
    `event_type 只能取：${args.graphSchema.eventTypes.join(", ")}。`,
    "summary 要单句、可复用、非流水账；relations 为 {source,target,type}。",
    "只输出 JSON，不要解释。",
  ].join("\n");
  const body = {
    model: args.llm.model,
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "你是会话记忆抽取器。输出必须是 JSON。结构需稳定可解析。" },
      { role: "user", content: `${schemaPrompt}\n\n会话记录:\n${transcript}\n\n输出格式: {\"events\": [...]}` },
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
        lastError = new Error(`llm_extract_http_${response.status}`);
        continue;
      }
      const json = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json?.choices?.[0]?.message?.content || "";
      if (!content.trim()) {
        lastError = new Error("llm_extract_empty");
        continue;
      }
      const wrapped = JSON.parse(content) as { events?: unknown[] };
      const events = Array.isArray(wrapped.events)
        ? parseLlmJsonArray(JSON.stringify(wrapped.events), args.graphSchema)
        : parseLlmJsonArray(content, args.graphSchema);
      if (events.length > 0) {
        return events;
      }
      lastError = new Error("llm_extract_parse_failed");
    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || "llm_extract_failed"));
}

function detectFailureToSuccess(records: SessionRecord[]): {
  triggered: boolean;
  failureSample: string;
  successSample: string;
  signature: string;
} {
  const failurePattern = /(失败|报错|错误|异常|超时|未通过|timeout|error|failed|failure)/i;
  const successPattern = /(修复|解决|成功|完成|恢复|通过|ok|fixed|resolved|success)/i;

  let seenFailure = false;
  let failureSample = "";
  let successSample = "";
  let failureIndex = -1;
  let successIndex = -1;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const content = typeof record.content === "string" ? record.content.trim() : "";
    if (!content) {
      continue;
    }
    if (!seenFailure && failurePattern.test(content)) {
      seenFailure = true;
      failureSample = content.slice(0, 160);
      failureIndex = index;
      continue;
    }
    if (seenFailure && successPattern.test(content)) {
      successSample = content.slice(0, 160);
      successIndex = index;
      break;
    }
  }

  if (!seenFailure || successIndex < 0) {
    return { triggered: false, failureSample: "", successSample: "", signature: "" };
  }

  const signature = `${failureIndex}:${successIndex}:${failureSample}:${successSample}`;
  return { triggered: true, failureSample, successSample, signature };
}

export function createSessionEnd(options: SessionEndOptions): {
  onSessionEnd(args: { sessionId: string; syncRecords: boolean; messages?: SessionRecord[] }): Promise<{ events_generated: number; sync_result?: { imported: number; skipped: number; filesProcessed: number }; daily_summary_sync_result?: { imported: number; skipped: number; filesProcessed: number }; stored_ids?: string[]; skipped_reasons?: string[] }>;
} {
  const memoryRoot = options.dbPath ? path.resolve(options.dbPath) : path.join(options.projectRoot, "data", "memory");
  const graphSchema = loadGraphSchema(options.projectRoot);
  const activeSessionsPath = path.join(memoryRoot, "sessions", "active", "sessions.jsonl");
  const statePath = path.join(memoryRoot, ".session_end_state.json");

  async function onSessionEnd(args: {
    sessionId: string;
    syncRecords: boolean;
    messages?: SessionRecord[];
  }): Promise<{ events_generated: number; sync_result?: { imported: number; skipped: number; filesProcessed: number }; daily_summary_sync_result?: { imported: number; skipped: number; filesProcessed: number }; stored_ids?: string[]; skipped_reasons?: string[] }> {
    const sessionId = args.sessionId;
    if (!sessionId) {
      return { events_generated: 0 };
    }

    const records = Array.isArray(args.messages) && args.messages.length > 0
      ? args.messages
      : loadActiveSessionRecords(activeSessionsPath, sessionId);
    if (records.length === 0) {
      const syncResult = args.syncRecords ? await options.syncMemory() : undefined;
      const dailySummarySyncResult = options.syncDailySummaries ? await options.syncDailySummaries() : undefined;
      return { events_generated: 0, sync_result: syncResult, daily_summary_sync_result: dailySummarySyncResult };
    }

    const state = readState(statePath);
    const { signature } = summarize(records);
    const recoveryDetection = detectFailureToSuccess(records);
    const previous = state.sessions[sessionId];
    let generated = 0;
    const storedIds: string[] = [];
    const skippedReasons: string[] = [];

    if (!previous || previous.signature !== signature) {
      const normalizedRecords = preprocess(records);
      let extracted: StructuredEvent[] = [];
      const llmModel = options.llm?.model || "";
      const llmApiKey = options.llm?.apiKey || "";
      const llmBaseUrl = normalizeBaseUrl(options.llm?.baseURL || options.llm?.baseUrl);
      if (llmModel && llmApiKey && llmBaseUrl) {
        try {
          extracted = await extractEventsWithLlm({
            llm: { model: llmModel, apiKey: llmApiKey, baseUrl: llmBaseUrl },
            records: normalizedRecords,
            graphSchema,
          });
        } catch (error) {
          options.logger.warn(`Session-end LLM extraction failed, fallback to heuristic events: ${error}`);
          extracted = fallbackEvents(records);
        }
      } else {
        extracted = fallbackEvents(records);
      }
      if (recoveryDetection.triggered) {
        extracted.push({
          event_type: "fix",
          summary: `Recovered from failure to success in session ${sessionId}`,
          entities: ["failure_recovery", "session_learning"],
          relations: [],
          outcome: "success_after_failure",
          confidence: 0.8,
        });
      }
      extracted = extracted
        .map(item => {
          const entities = Array.isArray(item.entities)
            ? [...new Set(item.entities.map(name => name.trim()).filter(Boolean))]
            : [];
          const relationValidation = validateRelations({
            relations: Array.isArray(item.relations) ? item.relations : [],
            entities,
            entityTypes: item.entity_types,
            schema: graphSchema,
          });
          return {
            ...item,
            event_type: normalizeEventType(item.event_type, graphSchema),
            entities,
            relations: relationValidation.accepted,
          };
        })
        .filter(item => item.summary.trim().length > 0);
      const result = await options.archiveStore.storeEvents(
        extracted.map(item => ({
          event_type: item.event_type,
          summary: item.summary,
          entities: item.entities,
          relations: item.relations,
          entity_types: item.entity_types,
          outcome: item.outcome,
          confidence: item.confidence,
          session_id: sessionId,
          source_file: `session_end:${sessionId}`,
          source_event_id: item.source_event_id || "",
          actor: item.actor || "session_end_llm",
        })),
      );
      for (const record of result.stored) {
        storedIds.push(record.id);
      }
      for (const skip of result.skipped) {
        skippedReasons.push(skip.reason);
      }
      state.sessions[sessionId] = { signature, endedAt: new Date().toISOString() };
      generated = result.stored.length;
      options.logger.info(`TS session_end generated ${generated} events for session ${sessionId}`);
    } else {
      options.logger.debug(`TS session_end skipped duplicate event for session ${sessionId}`);
    }
    if (recoveryDetection.triggered) {
      state.recovery[sessionId] = {
        signature: recoveryDetection.signature,
        detectedAt: new Date().toISOString(),
      };
    }
    writeState(statePath, state);

    const syncResult = args.syncRecords ? await options.syncMemory() : undefined;
    const dailySummarySyncResult = options.syncDailySummaries ? await options.syncDailySummaries() : undefined;
    return {
      events_generated: generated,
      sync_result: syncResult,
      daily_summary_sync_result: dailySummarySyncResult,
      stored_ids: storedIds,
      skipped_reasons: skippedReasons,
    };
  }

  return { onSessionEnd };
}
