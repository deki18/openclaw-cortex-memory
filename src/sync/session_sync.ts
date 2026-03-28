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
  markdowns?: Record<string, { digest: string; importedAt: string }>;
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
      return { files: {}, markdowns: {} };
    }
    const content = fs.readFileSync(filePath, "utf-8").trim();
    if (!content) {
      return { files: {}, markdowns: {} };
    }
    const parsed = JSON.parse(content) as SyncState;
    if (!parsed.files || typeof parsed.files !== "object") {
      return { files: {}, markdowns: {} };
    }
    if (!parsed.markdowns || typeof parsed.markdowns !== "object") {
      parsed.markdowns = {};
    }
    return parsed;
  } catch {
    return { files: {}, markdowns: {} };
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

export function createSessionSync(options: SessionSyncOptions): {
  syncMemory(): Promise<{ imported: number; skipped: number; filesProcessed: number; summaryImported: number; summarySkipped: number }>;
  syncDailySummaries(): Promise<{ imported: number; skipped: number; filesProcessed: number }>;
} {
  const memoryRoot = options.dbPath ? path.resolve(options.dbPath) : path.join(options.projectRoot, "data", "memory");
  const statePath = path.join(memoryRoot, ".sync_state.json");
  const openclawBasePath = inferOpenclawBasePath(options.projectRoot);

  async function syncDailySummaries(): Promise<{ imported: number; skipped: number; filesProcessed: number }> {
    const files = gatherDailySummaryFiles(openclawBasePath);
    const state = readState(statePath);
    if (!state.markdowns || typeof state.markdowns !== "object") {
      state.markdowns = {};
    }
    let imported = 0;
    let skipped = 0;
    let filesProcessed = 0;
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
      for (const chunk of chunks) {
        const result = await options.writeStore.writeMemory({
          text: chunk,
          role: "system",
          source: "daily_summary_sync",
          sessionId: summarySessionId,
        });
        if (result.status === "ok") {
          imported += 1;
        } else {
          skipped += 1;
        }
      }
      state.markdowns[filePath] = { digest, importedAt: new Date().toISOString() };
      filesProcessed += 1;
    }
    writeState(statePath, state);
    options.logger.info(`TS daily summary sync completed: imported=${imported}, skipped=${skipped}, files=${filesProcessed}`);
    return { imported, skipped, filesProcessed };
  }

  async function syncMemory(): Promise<{ imported: number; skipped: number; filesProcessed: number; summaryImported: number; summarySkipped: number }> {
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
    const summary = await syncDailySummaries();
    options.logger.info(
      `TS sync completed: imported=${imported}, skipped=${skipped}, files=${filesProcessed}, summaryImported=${summary.imported}, summarySkipped=${summary.skipped}`,
    );
    return {
      imported,
      skipped,
      filesProcessed,
      summaryImported: summary.imported,
      summarySkipped: summary.skipped,
    };
  }

  return { syncMemory, syncDailySummaries };
}
