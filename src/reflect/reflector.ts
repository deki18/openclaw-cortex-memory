import * as fs from "fs";
import * as path from "path";

interface LoggerLike {
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
}

interface ReflectorOptions {
  projectRoot: string;
  dbPath?: string;
  logger: LoggerLike;
  ruleStore: {
    addRule(args: { sectionTitle: string; content: string }): { added: boolean; reason?: string };
  };
}

function readJsonl(filePath: string): Record<string, unknown>[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/).filter(Boolean);
  const results: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      results.push(parsed);
    } catch {}
  }
  return results;
}

function textOf(record: Record<string, unknown>): string {
  const candidates = [record.summary, record.content, record.text, record.message, record.outcome];
  for (const item of candidates) {
    if (typeof item === "string" && item.trim()) {
      return item.trim();
    }
  }
  return "";
}

export function createReflector(options: ReflectorOptions): {
  reflectMemory(): Promise<{ status: string; message: string; reflected_count: number }>;
  promoteMemory(): Promise<{ status: string; promoted_count: number }>;
} {
  const memoryRoot = options.dbPath ? path.resolve(options.dbPath) : path.join(options.projectRoot, "data", "memory");
  const activeSessionsPath = path.join(memoryRoot, "sessions", "active", "sessions.jsonl");
  const archiveSessionsPath = path.join(memoryRoot, "sessions", "archive", "sessions.jsonl");

  async function reflectMemory(): Promise<{ status: string; message: string; reflected_count: number }> {
    const archiveRecords = readJsonl(archiveSessionsPath).slice(-100);
    let reflected = 0;
    for (const record of archiveRecords) {
      const summary = textOf(record);
      if (!summary) {
        continue;
      }
      const outcome = typeof record.outcome === "string" ? record.outcome : "unknown";
      const ruleText = `From historical event: ${summary}. Outcome: ${outcome}.`;
      const added = options.ruleStore.addRule({
        sectionTitle: "Reflected Rule",
        content: ruleText,
      });
      if (added.added) {
        reflected += 1;
      }
    }
    options.logger.info(`TS reflector generated ${reflected} reflected rules`);
    return { status: "ok", message: "Reflection completed", reflected_count: reflected };
  }

  async function promoteMemory(): Promise<{ status: string; promoted_count: number }> {
    const activeRecords = readJsonl(activeSessionsPath).slice(-500);
    const counter = new Map<string, { content: string; count: number }>();
    for (const record of activeRecords) {
      const content = typeof record.content === "string" ? record.content.trim() : "";
      if (!content) {
        continue;
      }
      const existing = counter.get(content);
      if (existing) {
        existing.count += 1;
      } else {
        counter.set(content, { content, count: 1 });
      }
    }

    let promoted = 0;
    const threshold = 3;
    for (const item of counter.values()) {
      if (item.count < threshold) {
        continue;
      }
      const added = options.ruleStore.addRule({
        sectionTitle: "Promoted Rule",
        content: item.content,
      });
      if (added.added) {
        promoted += 1;
      }
    }
    options.logger.info(`TS reflector promoted ${promoted} rules`);
    return { status: "ok", promoted_count: promoted };
  }

  options.logger.debug(`TS reflector initialized with memory root ${memoryRoot}`);
  return { reflectMemory, promoteMemory };
}
