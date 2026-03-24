import * as fs from "fs";
import * as path from "path";

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
}

interface SessionRecord {
  id?: string;
  session_id?: string;
  role?: string;
  content?: string;
  timestamp?: string;
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
  onSessionEnd(args: { sessionId: string; syncRecords: boolean }): Promise<{ events_generated: number; sync_result?: { imported: number; skipped: number; filesProcessed: number } }>;
} {
  const memoryRoot = options.dbPath ? path.resolve(options.dbPath) : path.join(options.projectRoot, "data", "memory");
  const activeSessionsPath = path.join(memoryRoot, "sessions", "active", "sessions.jsonl");
  const archiveSessionsPath = path.join(memoryRoot, "sessions", "archive", "sessions.jsonl");
  const statePath = path.join(memoryRoot, ".session_end_state.json");

  async function onSessionEnd(args: {
    sessionId: string;
    syncRecords: boolean;
  }): Promise<{ events_generated: number; sync_result?: { imported: number; skipped: number; filesProcessed: number } }> {
    const sessionId = args.sessionId;
    if (!sessionId) {
      return { events_generated: 0 };
    }

    const records = loadActiveSessionRecords(activeSessionsPath, sessionId);
    if (records.length === 0) {
      const syncResult = args.syncRecords ? await options.syncMemory() : undefined;
      return { events_generated: 0, sync_result: syncResult };
    }

    const state = readState(statePath);
    const { summary, entities, outcome, signature } = summarize(records);
    const recoveryDetection = detectFailureToSuccess(records);
    const previous = state.sessions[sessionId];
    let generated = 0;

    if (!previous || previous.signature !== signature) {
      const event = {
        id: `evt_${Date.now().toString(36)}`,
        timestamp: new Date().toISOString(),
        summary,
        entities,
        outcome,
        source_file: `session_end:${sessionId}`,
        session_id: sessionId,
      };
      const archiveDir = path.dirname(archiveSessionsPath);
      if (!fs.existsSync(archiveDir)) {
        fs.mkdirSync(archiveDir, { recursive: true });
      }
      fs.appendFileSync(archiveSessionsPath, `${JSON.stringify(event)}\n`, "utf-8");
      state.sessions[sessionId] = { signature, endedAt: new Date().toISOString() };
      writeState(statePath, state);
      generated = 1;
      options.logger.info(`TS session_end generated event for session ${sessionId}`);
    } else {
      options.logger.debug(`TS session_end skipped duplicate event for session ${sessionId}`);
    }

    if (recoveryDetection.triggered) {
      const previousRecovery = state.recovery[sessionId];
      if (!previousRecovery || previousRecovery.signature !== recoveryDetection.signature) {
        const recoveryEvent = {
          id: `evt_${Date.now().toString(36)}_recovery`,
          timestamp: new Date().toISOString(),
          summary: `Recovered from failure to success in session ${sessionId}`,
          entities: ["failure_recovery", "session_learning"],
          outcome: "success_after_failure",
          details: {
            failure: recoveryDetection.failureSample,
            success: recoveryDetection.successSample,
          },
          source_file: `session_end:recovery:${sessionId}`,
          session_id: sessionId,
        };
        const archiveDir = path.dirname(archiveSessionsPath);
        if (!fs.existsSync(archiveDir)) {
          fs.mkdirSync(archiveDir, { recursive: true });
        }
        fs.appendFileSync(archiveSessionsPath, `${JSON.stringify(recoveryEvent)}\n`, "utf-8");
        state.recovery[sessionId] = {
          signature: recoveryDetection.signature,
          detectedAt: new Date().toISOString(),
        };
        writeState(statePath, state);
        generated += 1;
        options.logger.info(`TS session_end generated recovery event for session ${sessionId}`);
      } else {
        options.logger.debug(`TS session_end skipped duplicate recovery event for session ${sessionId}`);
      }
    }

    const syncResult = args.syncRecords ? await options.syncMemory() : undefined;
    return { events_generated: generated, sync_result: syncResult };
  }

  return { onSessionEnd };
}
