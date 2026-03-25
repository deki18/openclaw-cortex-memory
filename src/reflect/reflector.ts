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
  llm?: {
    provider: string;
    model: string;
    apiKey?: string;
    baseURL?: string;
    baseUrl?: string;
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

function normalizeBaseUrl(value?: string): string {
  if (!value) return "";
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

async function requestRuleFromLlm(args: {
  summary: string;
  outcome: string;
  model: string;
  apiKey: string;
  baseUrl: string;
}): Promise<string | null> {
  const endpoint = args.baseUrl.endsWith("/chat/completions")
    ? args.baseUrl
    : `${args.baseUrl}/chat/completions`;
  const prompt = `事件摘要: ${args.summary}\n结果: ${args.outcome}\n请生成一条可复用的工程规则，要求简洁、可执行、单句输出。`;
  const body = {
    model: args.model,
    temperature: 0.2,
    messages: [
      { role: "system", content: "你是工程规则提炼器。输出只包含规则正文，不要编号，不要解释。" },
      { role: "user", content: prompt },
    ],
  };
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${args.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!response.ok) {
        lastError = new Error(`llm_http_${response.status}`);
        continue;
      }
      const json = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json?.choices?.[0]?.message?.content?.trim() || "";
      if (content) {
        return content.slice(0, 500);
      }
      lastError = new Error("llm_empty");
    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error;
    }
  }
  if (lastError) {
    throw lastError;
  }
  return null;
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
      let ruleText = `From historical event: ${summary}. Outcome: ${outcome}.`;
      const llmModel = options.llm?.model || "";
      const llmApiKey = options.llm?.apiKey || "";
      const llmBaseUrl = normalizeBaseUrl(options.llm?.baseURL || options.llm?.baseUrl);
      if (llmModel && llmApiKey && llmBaseUrl) {
        try {
          const generated = await requestRuleFromLlm({
            summary,
            outcome,
            model: llmModel,
            apiKey: llmApiKey,
            baseUrl: llmBaseUrl,
          });
          if (generated) {
            ruleText = generated;
          }
        } catch (error) {
          options.logger.warn(`LLM reflection failed, fallback to template rule: ${error}`);
        }
      }
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
