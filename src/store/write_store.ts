import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

interface LoggerLike {
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
}

export interface WriteMemoryArgs {
  text: string;
  role: string;
  source: string;
  sessionId: string;
}

export interface WriteMemoryResult {
  status: "ok" | "skipped";
  memory_id?: string;
  reason?: string;
  error_code?: string;
  quality?: {
    level: "low" | "medium" | "high";
    score: number;
  };
}

interface WriteStoreOptions {
  projectRoot: string;
  dbPath?: string;
  logger: LoggerLike;
}

interface PersistedRecord {
  id: string;
  timestamp: string;
  session_id: string;
  role: string;
  source: string;
  content: string;
  quality_level: "low" | "medium" | "high";
  quality_score: number;
  text_hash: string;
}

function normalizeText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function scoreQuality(text: string): { score: number; level: "low" | "medium" | "high" } {
  const length = text.length;
  const uniqueChars = new Set(text.toLowerCase()).size;
  let score = 0;
  if (length >= 20) score += 0.35;
  if (length >= 60) score += 0.2;
  if (length >= 120) score += 0.2;
  if (uniqueChars >= 10) score += 0.15;
  if (/\d/.test(text)) score += 0.05;
  if (/[a-zA-Z\u4e00-\u9fa5]/.test(text)) score += 0.05;
  const normalizedScore = Math.max(0, Math.min(1, Number(score.toFixed(2))));
  if (normalizedScore >= 0.75) {
    return { score: normalizedScore, level: "high" };
  }
  if (normalizedScore >= 0.45) {
    return { score: normalizedScore, level: "medium" };
  }
  return { score: normalizedScore, level: "low" };
}

function ensureDirForFile(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function safeReadTailLines(filePath: string, maxLines: number): string[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (lines.length <= maxLines) {
    return lines;
  }
  return lines.slice(lines.length - maxLines);
}

function computeHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function createWriteStore(options: WriteStoreOptions): { writeMemory(args: WriteMemoryArgs): Promise<WriteMemoryResult> } {
  const memoryRoot = options.dbPath ? path.resolve(options.dbPath) : path.join(options.projectRoot, "data", "memory");
  const activeSessionsPath = path.join(memoryRoot, "sessions", "active", "sessions.jsonl");

  async function writeMemory(args: WriteMemoryArgs): Promise<WriteMemoryResult> {
    const cleaned = normalizeText(args.text || "");
    if (!cleaned) {
      return { status: "skipped", reason: "empty_text", error_code: "E204" };
    }

    const quality = scoreQuality(cleaned);
    if (quality.level === "low") {
      return { status: "skipped", reason: "low_quality", error_code: "E204", quality };
    }

    const textHash = computeHash(cleaned);
    try {
      const tailLines = safeReadTailLines(activeSessionsPath, 200);
      for (const line of tailLines) {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (
            parsed.session_id === args.sessionId &&
            parsed.role === args.role &&
            parsed.text_hash === textHash
          ) {
            return { status: "skipped", reason: "duplicate", error_code: "E203", quality };
          }
        } catch {}
      }
    } catch (error) {
      options.logger.warn(`Failed to evaluate write dedup, continue write: ${error}`);
    }

    const id = `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const record: PersistedRecord = {
      id,
      timestamp: new Date().toISOString(),
      session_id: args.sessionId,
      role: args.role || "user",
      source: args.source || "message",
      content: cleaned,
      quality_level: quality.level,
      quality_score: quality.score,
      text_hash: textHash,
    };

    ensureDirForFile(activeSessionsPath);
    fs.appendFileSync(activeSessionsPath, `${JSON.stringify(record)}\n`, "utf-8");
    options.logger.info(`TS write stored message for session ${args.sessionId}`);
    return { status: "ok", memory_id: id, quality };
  }

  options.logger.debug(`TS write store initialized at ${memoryRoot}`);
  return { writeMemory };
}
