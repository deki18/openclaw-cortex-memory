import * as fs from "fs";
import * as path from "path";

interface LoggerLike {
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
}

interface SessionEndState {
  version: string;
  sessions: Record<string, { signature: string; endedAt: string }>;
  recovery: Record<string, { signature: string; detectedAt: string }>;
}

interface SessionRecord {
  id?: string;
  session_id?: string;
  role?: string;
  content?: string;
  timestamp?: string;
}

interface SessionEndOptions {
  projectRoot: string;
  dbPath?: string;
  logger: LoggerLike;
  syncMemory: () => Promise<{ imported: number; skipped: number; filesProcessed: number }>;
  syncDailySummaries?: () => Promise<{ imported: number; skipped: number; filesProcessed: number }>;
  routeTranscript?: (args: { sessionId: string; sourceFile: string; transcript: string }) => Promise<{
    imported: number;
    skipped: number;
    ok: boolean;
    llmDecisions: number;
    activeOnly: number;
    archiveEvent: number;
    skipReasons: Record<string, number>;
  }>;
}

function readState(filePath: string): SessionEndState {
  try {
    if (!fs.existsSync(filePath)) {
      return { version: "2", sessions: {}, recovery: {} };
    }
    const content = fs.readFileSync(filePath, "utf-8").trim();
    if (!content) {
      return { version: "2", sessions: {}, recovery: {} };
    }
    const parsed = JSON.parse(content) as SessionEndState;
    if (!parsed.sessions || typeof parsed.sessions !== "object") {
      return { version: "2", sessions: {}, recovery: {} };
    }
    if (!parsed.recovery || typeof parsed.recovery !== "object") {
      parsed.recovery = {};
    }
    parsed.version = typeof parsed.version === "string" && parsed.version.trim() ? parsed.version : "2";
    return parsed;
  } catch {
    return { version: "2", sessions: {}, recovery: {} };
  }
}

function writeState(filePath: string, state: SessionEndState): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  state.version = "2";
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
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

function summarize(records: SessionRecord[]): { signature: string } {
  const signature = records.map(r => `${r.id || ""}:${r.timestamp || ""}:${r.content || ""}`).join("||");
  return { signature };
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
  const activeSessionsPath = path.join(memoryRoot, "sessions", "active", "sessions.jsonl");
  const statePath = path.join(memoryRoot, ".session_end_state.json");

  options.logger.info(`session_end_route_mode=${typeof options.routeTranscript === "function" ? "shared_sync_gate" : "legacy_extract"}`);
  if (!fs.existsSync(statePath)) {
    options.logger.warn("session_end_state_missing: first run will rebuild session-end dedup state");
  }

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
      options.logger.info(`session_end_skip reason=no_active_records session=${sessionId}`);
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
      let transcript = normalizedRecords
        .map(item => `[${item.role}] ${item.content}`)
        .join("\n")
        .trim();

      if (recoveryDetection.triggered) {
        const recoveryLine = `Recovered from failure to success in session ${sessionId}: ${recoveryDetection.failureSample} -> ${recoveryDetection.successSample}`;
        transcript = `${transcript}\n[system] ${recoveryLine}`.trim();
      }

      if (options.routeTranscript) {
        const routed = await options.routeTranscript({
          sessionId,
          sourceFile: `session_end:${sessionId}`,
          transcript,
        });
        generated = routed.archiveEvent;
        for (const [reason, count] of Object.entries(routed.skipReasons || {})) {
          for (let i = 0; i < count; i += 1) {
            skippedReasons.push(reason);
          }
        }
      } else {
        skippedReasons.push("route_transcript_not_configured");
      }

      state.sessions[sessionId] = { signature, endedAt: new Date().toISOString() };
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
