import * as fs from "fs";
import * as path from "path";

interface LoggerLike {
  debug: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
}

export interface ReadStoreSearchArgs {
  query: string;
  topK: number;
}

export interface ReadStoreHotArgs {
  limit: number;
}

export interface ReadStoreAutoArgs {
  includeHot: boolean;
  sessionId: string;
  cachedAutoSearch?: {
    query: string;
    results: unknown[];
    ageSeconds: number;
  };
}

interface ReadDocument {
  id: string;
  text: string;
  source: string;
  timestamp?: number;
}

interface ReadStoreOptions {
  projectRoot: string;
  dbPath?: string;
  logger: LoggerLike;
}

export interface ReadStore {
  searchMemory(args: ReadStoreSearchArgs): Promise<{ results: unknown[] }>;
  getHotContext(args: ReadStoreHotArgs): Promise<{ context: unknown[] }>;
  getAutoContext(args: ReadStoreAutoArgs): Promise<{
    auto_search?: { query: string; results: unknown[]; age_seconds: number };
    hot_context?: unknown[];
  }>;
}

function safeReadFile(filePath: string): string {
  try {
    if (!fs.existsSync(filePath)) {
      return "";
    }
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function scoreText(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (!q || !t) {
    return 0;
  }
  let score = 0;
  if (t.includes(q)) {
    score += 5;
  }
  const tokens = q.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    if (t.includes(token)) {
      score += 1;
    }
  }
  return score;
}

function normalizeRecordText(record: Record<string, unknown>): string {
  const direct = [record.content, record.summary, record.text, record.message]
    .find(v => typeof v === "string" && v.trim()) as string | undefined;
  if (direct) {
    return direct.trim();
  }
  if (Array.isArray(record.messages)) {
    const merged = record.messages
      .map(item => {
        if (typeof item === "string") return item;
        if (typeof item === "object" && item !== null) {
          const obj = item as Record<string, unknown>;
          const role = typeof obj.role === "string" ? obj.role : "unknown";
          const content = [obj.content, obj.text, obj.body].find(v => typeof v === "string" && v.trim()) as string | undefined;
          if (content) {
            return `${role}: ${content}`;
          }
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
    if (merged) {
      return merged;
    }
  }
  return JSON.stringify(record);
}

function parseJsonlFile(filePath: string, sourceLabel: string, logger: LoggerLike): ReadDocument[] {
  const content = safeReadFile(filePath);
  if (!content) {
    return [];
  }
  const docs: ReadDocument[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const text = normalizeRecordText(parsed);
      if (!text.trim()) {
        continue;
      }
      const id = typeof parsed.id === "string" ? parsed.id : `${sourceLabel}:${docs.length + 1}`;
      const timestampValue = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : NaN;
      docs.push({
        id,
        text,
        source: sourceLabel,
        timestamp: Number.isFinite(timestampValue) ? timestampValue : undefined,
      });
    } catch (error) {
      logger.debug(`Skipping invalid JSONL line in ${filePath}: ${error}`);
    }
  }
  return docs;
}

function parseMarkdownFile(filePath: string, sourceLabel: string): ReadDocument[] {
  const content = safeReadFile(filePath);
  if (!content.trim()) {
    return [];
  }
  const lines = content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#"));
  if (lines.length === 0) {
    return [];
  }
  return [
    {
      id: sourceLabel,
      text: lines.join("\n"),
      source: sourceLabel,
    },
  ];
}

function withRecencyBoost(score: number, timestamp?: number): number {
  if (!timestamp) {
    return score;
  }
  const ageHours = (Date.now() - timestamp) / (1000 * 60 * 60);
  if (ageHours < 24) {
    return score + 0.6;
  }
  if (ageHours < 168) {
    return score + 0.3;
  }
  return score;
}

export function createReadStore(options: ReadStoreOptions): ReadStore {
  const memoryRoot = options.dbPath ? path.resolve(options.dbPath) : path.join(options.projectRoot, "data", "memory");

  function loadAllDocuments(): ReadDocument[] {
    const cortexRulesPath = path.join(memoryRoot, "CORTEX_RULES.md");
    const memoryMdPath = path.join(memoryRoot, "MEMORY.md");
    const activeSessionsPath = path.join(memoryRoot, "sessions", "active", "sessions.jsonl");
    const archiveSessionsPath = path.join(memoryRoot, "sessions", "archive", "sessions.jsonl");

    return [
      ...parseMarkdownFile(cortexRulesPath, "CORTEX_RULES.md"),
      ...parseMarkdownFile(memoryMdPath, "MEMORY.md"),
      ...parseJsonlFile(activeSessionsPath, "sessions_active", options.logger),
      ...parseJsonlFile(archiveSessionsPath, "sessions_archive", options.logger),
    ];
  }

  async function searchMemory(args: ReadStoreSearchArgs): Promise<{ results: unknown[] }> {
    const query = args.query?.trim();
    if (!query) {
      return { results: [] };
    }
    const docs = loadAllDocuments();
    const ranked = docs
      .map(doc => {
        const base = scoreText(query, doc.text);
        const total = withRecencyBoost(base, doc.timestamp);
        return { doc, score: total };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, args.topK))
      .map(item => ({
        id: item.doc.id,
        text: item.doc.text,
        source: item.doc.source,
        score: Number(item.score.toFixed(4)),
      }));
    return { results: ranked };
  }

  async function getHotContext(args: ReadStoreHotArgs): Promise<{ context: unknown[] }> {
    const limit = Math.max(1, args.limit);
    const docs = loadAllDocuments();
    const coreRules = docs.find(doc => doc.source === "CORTEX_RULES.md");
    const sessionDocs = docs
      .filter(doc => doc.source.startsWith("sessions_"))
      .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
      .slice(0, limit);
    const result: Array<{ id: string; text: string; source: string }> = [];
    if (coreRules) {
      result.push({ id: coreRules.id, text: coreRules.text, source: coreRules.source });
    }
    for (const doc of sessionDocs) {
      result.push({ id: doc.id, text: doc.text, source: doc.source });
    }
    return { context: result.slice(0, limit) };
  }

  async function getAutoContext(args: ReadStoreAutoArgs): Promise<{
    auto_search?: { query: string; results: unknown[]; age_seconds: number };
    hot_context?: unknown[];
  }> {
    const result: {
      auto_search?: { query: string; results: unknown[]; age_seconds: number };
      hot_context?: unknown[];
    } = {};
    if (args.cachedAutoSearch) {
      result.auto_search = {
        query: args.cachedAutoSearch.query,
        results: args.cachedAutoSearch.results,
        age_seconds: args.cachedAutoSearch.ageSeconds,
      };
    }
    if (args.includeHot) {
      const hot = await getHotContext({ limit: 20 });
      result.hot_context = hot.context;
    }
    return result;
  }

  options.logger.debug(`TS read store initialized at ${memoryRoot}`);

  return {
    searchMemory,
    getHotContext,
    getAutoContext,
  };
}
