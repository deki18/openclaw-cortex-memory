import * as fs from "fs";
import * as path from "path";

interface LoggerLike {
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
}

interface SessionEndState {
  sessions: Record<string, { signature: string; endedAt: string }>;
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
      return { sessions: {} };
    }
    const content = fs.readFileSync(filePath, "utf-8").trim();
    if (!content) {
      return { sessions: {} };
    }
    const parsed = JSON.parse(content) as SessionEndState;
    if (!parsed.sessions || typeof parsed.sessions !== "object") {
      return { sessions: {} };
    }
    return parsed;
  } catch {
    return { sessions: {} };
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

    const syncResult = args.syncRecords ? await options.syncMemory() : undefined;
    return { events_generated: generated, sync_result: syncResult };
  }

  return { onSessionEnd };
}
