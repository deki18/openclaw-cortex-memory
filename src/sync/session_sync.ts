import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

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
  archiveStore: {
    storeEvents(events: Array<{
      event_type: string;
      summary: string;
      entities?: string[];
      relations?: Array<{ source: string; target: string; type: string }>;
      outcome?: string;
      session_id: string;
      source_file: string;
      confidence?: number;
      source_event_id?: string;
      actor?: string;
    }>): Promise<{ stored: Array<{ id: string }>; skipped: Array<{ summary: string; reason: string }> }>;
  };
  writeStore: {
    writeMemory(args: { text: string; role: string; source: string; sessionId: string }): Promise<{ status: "ok" | "skipped"; reason?: string }>;
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

interface ArchiveEventPayload {
  event_type: string;
  summary: string;
  entities?: string[];
  relations?: Array<{ source: string; target: string; type: string }>;
  outcome?: string;
  confidence?: number;
}

interface GateDecisionPayload {
  target_layer: "active_only" | "archive_event" | "skip";
  active_text?: string;
  event?: ArchiveEventPayload;
  reason?: string;
}

const WRITE_GATE_PROMPT_VERSION = "write-gate.v1.1.0";
const WRITE_GATE_REGRESSION_SAMPLES = [
  "样例A: “今天讨论了三种方案，尚未决策” => active_only",
  "样例B: “决定采用B方案并完成上线，错误率下降到0.2%” => archive_event",
  "样例C: “好的收到谢谢” => skip",
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
          if (!source || !target) return null;
          return { source, target, type };
        })
        .filter((valueItem): valueItem is { source: string; target: string; type: string } => Boolean(valueItem))
    : [];
  return {
    event_type: eventType,
    summary,
    entities,
    relations,
    outcome: typeof obj.outcome === "string" ? obj.outcome.trim() : "",
    confidence: typeof obj.confidence === "number" ? Math.max(0, Math.min(1, obj.confidence)) : 0.6,
  };
}

function parseLlmGateDecisions(raw: string): GateDecisionPayload[] {
  const trimmed = raw.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence?.[1]?.trim() || trimmed;
  const parsed = JSON.parse(candidate) as unknown;
  const asRecordObj = (typeof parsed === "object" && parsed !== null) ? parsed as Record<string, unknown> : null;
  const wrapped = Array.isArray(parsed)
    ? parsed
    : Array.isArray(asRecordObj?.decisions)
      ? asRecordObj?.decisions
      : [];
  if (Array.isArray(wrapped) && wrapped.length > 0) {
    const output: GateDecisionPayload[] = [];
    for (const item of wrapped) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const target = typeof obj.target_layer === "string" ? obj.target_layer.trim() : "";
      if (target !== "active_only" && target !== "archive_event" && target !== "skip") {
        continue;
      }
      const event = target === "archive_event"
        ? parseArchiveEventPayload(obj.event || obj)
        : null;
      output.push({
        target_layer: target,
        active_text: typeof obj.active_text === "string" ? obj.active_text.trim() : "",
        event: event || undefined,
        reason: typeof obj.reason === "string" ? obj.reason.trim() : "",
      });
    }
    if (output.length > 0) {
      return output;
    }
  }
  const legacyEvents = Array.isArray(asRecordObj?.events) ? asRecordObj?.events : [];
  const legacyOutput: GateDecisionPayload[] = [];
  for (const item of legacyEvents) {
    const parsedEvent = parseArchiveEventPayload(item);
    if (!parsedEvent) {
      continue;
    }
    legacyOutput.push({
      target_layer: "archive_event",
      event: parsedEvent,
      reason: "legacy_events",
    });
  }
  return legacyOutput;
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
      { role: "system", content: "你是出色的记忆提取器。仅输出 JSON。" },
      {
        role: "user",
        content: [
          `prompt_version=${WRITE_GATE_PROMPT_VERSION}`,
          "请对以下导入内容做分流判定，target_layer 只能是 active_only、archive_event、skip。",
          "分类标准：",
          "A) active_only：内容是过程信息/上下文片段/未形成稳定结论；或仅记录进行中状态、临时讨论、零散想法。",
          "B) archive_event：内容形成完整可复用事件，需同时满足：有明确对象、有动作/决策、有结果或阶段性结论；summary 需可脱离原上下文理解。",
          "C) skip：内容是噪声、重复、空泛寒暄、无业务价值描述，或无法提取清晰事件主体。",
          "archive_event 额外约束：confidence < 0.35 时优先判为 skip；若关系不明确可省略 relations 但不得伪造。",
          "active_only 额外约束：active_text 必须保留关键信息，不得只返回“同上/略”。",
          "输出格式必须是 {\"decisions\":[...]}。",
          "active_only: 必须给 active_text。",
          "archive_event: 必须给 event={event_type,summary,entities[],relations[],outcome,confidence}。",
          "skip: 必须给 reason。",
          "禁止输出任何解释性自然语言。",
          ...WRITE_GATE_REGRESSION_SAMPLES,
          "只输出 JSON。",
          "",
          args.transcript.slice(-12000),
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
      return parseLlmGateDecisions(content);
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
} {
  const memoryRoot = options.dbPath ? path.resolve(options.dbPath) : path.join(options.projectRoot, "data", "memory");
  const statePath = path.join(memoryRoot, ".sync_state.json");
  const openclawBasePath = inferOpenclawBasePath(options.projectRoot);
  const llmModel = options.llm?.model || "";
  const llmApiKey = options.llm?.apiKey || "";
  const llmBaseUrl = normalizeBaseUrl(options.llm?.baseURL || options.llm?.baseUrl);
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
      options.logger.warn(`Sync gate degraded to active_only for ${args.sessionId}: llm_not_configured`);
      const fallbackWrite = await options.writeStore.writeMemory({
        text: args.transcript.slice(-4000),
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
    const archiveInputs: Array<{
      event_type: string;
      summary: string;
      entities?: string[];
      relations?: Array<{ source: string; target: string; type: string }>;
      outcome?: string;
      session_id: string;
      source_file: string;
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
        const activeText = (decision.active_text || args.transcript).trim().slice(-4000);
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
        } else {
          skipped += 1;
          bumpReason(writeResult.reason || "active_only_write_skipped");
        }
        continue;
      }
      if (decision.target_layer === "archive_event") {
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
          outcome: decision.event.outcome,
          confidence: decision.event.confidence,
          session_id: args.sessionId,
          source_file: args.sourceFile,
          source_event_id: "",
          actor: "sync_llm_gate",
        });
      }
    }
    if (archiveInputs.length > 0) {
      const archiveResult = await options.archiveStore.storeEvents(archiveInputs);
      imported += archiveResult.stored.length;
      skipped += archiveResult.skipped.length;
      archiveEvent += archiveResult.stored.length;
      for (const skip of archiveResult.skipped) {
        bumpReason(skip.reason || "archive_store_skipped");
      }
      options.logger.info(
        `sync_archive_result session=${args.sessionId} archived_success=${archiveResult.stored.length} skipped=${archiveResult.skipped.length}`,
      );
    }
    options.logger.info(
      `sync_gate_result session=${args.sessionId} llm_decisions=${llmDecisions} active_only=${activeOnly} archive_event=${archiveEvent} skipped=${skipped}`,
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

  return { syncMemory, syncDailySummaries };
}
