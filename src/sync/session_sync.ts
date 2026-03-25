import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { WriteMemoryResult } from "../store/write_store";

interface LoggerLike {
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
}

interface SyncState {
  files: Record<string, { size: number; lineCount: number }>;
}

interface SessionSyncOptions {
  projectRoot: string;
  dbPath?: string;
  logger: LoggerLike;
  writeStore: {
    writeMemory(args: { text: string; role: string; source: string; sessionId: string }): Promise<WriteMemoryResult>;
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

function readState(filePath: string): SyncState {
  try {
    if (!fs.existsSync(filePath)) {
      return { files: {} };
    }
    const content = fs.readFileSync(filePath, "utf-8").trim();
    if (!content) {
      return { files: {} };
    }
    const parsed = JSON.parse(content) as SyncState;
    if (!parsed.files || typeof parsed.files !== "object") {
      return { files: {} };
    }
    return parsed;
  } catch {
    return { files: {} };
  }
}

function writeState(filePath: string, state: SyncState): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
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

export function createSessionSync(options: SessionSyncOptions): { syncMemory(): Promise<{ imported: number; skipped: number; filesProcessed: number }> } {
  const memoryRoot = options.dbPath ? path.resolve(options.dbPath) : path.join(options.projectRoot, "data", "memory");
  const statePath = path.join(memoryRoot, ".sync_state.json");
  const openclawBasePath = inferOpenclawBasePath(options.projectRoot);

  async function syncMemory(): Promise<{ imported: number; skipped: number; filesProcessed: number }> {
    const files = gatherSessionFiles(openclawBasePath, memoryRoot);
    const state = readState(statePath);
    let imported = 0;
    let skipped = 0;
    let filesProcessed = 0;

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
            const result = await options.writeStore.writeMemory({
              text: msg.text,
              role: msg.role,
              source: "sync",
              sessionId,
            });
            if (result.status === "ok") {
              imported += 1;
            } else {
              skipped += 1;
            }
          }
        } catch (error) {
          options.logger.debug(`Skipping invalid sync line in ${filePath}: ${error}`);
          skipped += 1;
        }
      }

      filesProcessed += 1;
      state.files[filePath] = { size: stat.size, lineCount: lines.length };
    }

    writeState(statePath, state);
    options.logger.info(`TS sync completed: imported=${imported}, skipped=${skipped}, files=${filesProcessed}`);
    return { imported, skipped, filesProcessed };
  }

  return { syncMemory };
}
