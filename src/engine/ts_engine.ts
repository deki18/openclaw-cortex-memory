import * as fs from "fs";
import * as path from "path";
import { loadGraphSchema, normalizeRelationType } from "../graph/ontology";
import type { MemoryEngine } from "./memory_engine";
import type { ReadStore } from "../store/read_store";
import type { WriteMemoryResult } from "../store/write_store";
import type {
  BackfillEmbeddingsArgs,
  CleanupMemoriesArgs,
  DeleteMemoryArgs,
  GetAutoContextArgs,
  GetHotContextArgs,
  QueryGraphArgs,
  SearchMemoryArgs,
  StoreEventArgs,
  ToolContext,
  ToolResult,
  UpdateMemoryArgs,
} from "./types";

const PROMPT_VERSIONS = {
  write_gate: "write-gate.v1.1.0",
  session_end_write: "session-end-write.v1.1.0",
  read_fusion: "read-fusion.v1.1.0",
};

interface TsEngineDeps {
  readStore: ReadStore;
  writeStore: {
    writeMemory(args: { text: string; role: string; source: string; sessionId: string }): Promise<WriteMemoryResult>;
  };
  vectorStore: {
    upsert(record: {
      id: string;
      session_id: string;
      event_type: string;
      summary: string;
      timestamp: string;
      layer: "active" | "archive";
      source_memory_id: string;
      source_memory_canonical_id?: string;
      outcome?: string;
      entities?: string[];
      relations?: Array<{ source: string; target: string; type: string }>;
      embedding: number[];
      quality_score: number;
      char_count: number;
      token_count: number;
      chunk_index?: number;
      chunk_total?: number;
      chunk_start?: number;
      chunk_end?: number;
    }): Promise<void>;
    deleteBySourceMemory(args: { layer: "active" | "archive"; sourceMemoryId: string }): Promise<void>;
  };
  archiveStore: {
    storeEvents(events: Array<{
      event_type: string;
      summary: string;
      entities?: string[];
      relations?: Array<{ source: string; target: string; type: string }>;
      entity_types?: Record<string, string>;
      outcome?: string;
      session_id: string;
      source_file: string;
      confidence?: number;
      source_event_id?: string;
      actor?: string;
      canonical_id?: string;
    }>): Promise<{ stored: Array<{ id: string }>; skipped: Array<{ summary: string; reason: string }> }>;
  };
  sessionSync: {
    syncMemory(): Promise<{ imported: number; skipped: number; filesProcessed: number }>;
  };
  sessionEnd: {
    onSessionEnd(args: { sessionId: string; syncRecords: boolean; messages?: Array<{ id?: string; session_id?: string; role?: string; content?: string; timestamp?: string }> }): Promise<{
      events_generated: number;
      sync_result?: { imported: number; skipped: number; filesProcessed: number };
    }>;
  };
  reflector: {
    reflectMemory(): Promise<{ status: string; message: string; reflected_count: number }>;
    promoteMemory(): Promise<{ status: string; promoted_count: number }>;
  };
  memoryRoot: string;
  projectRoot: string;
  embedding?: {
    provider: string;
    model: string;
    apiKey?: string;
    baseURL?: string;
    baseUrl?: string;
    dimensions?: number;
    timeoutMs?: number;
    maxRetries?: number;
  };
  llm?: {
    provider?: string;
    model: string;
    apiKey?: string;
    baseURL?: string;
    baseUrl?: string;
  };
  reranker?: {
    provider?: string;
    model: string;
    apiKey?: string;
    baseURL?: string;
    baseUrl?: string;
  };
  vectorChunking?: {
    chunkSize?: number;
    chunkOverlap?: number;
  };
  getCachedAutoSearch: (sessionId: string) => { query: string; results: unknown[]; ageSeconds: number } | null;
  resolveSessionId: (context: ToolContext, payload?: unknown) => string;
  normalizeIncomingMessage: (payload: unknown) => { text: string; role: string; source: string } | null;
  setSessionAutoSearchCache: (sessionId: string, query: string, results: unknown[]) => void;
  defaultAutoSync: boolean;
  autoReflect: boolean;
  logger: {
    debug: (message: string, ...args: unknown[]) => void;
    info: (message: string, ...args: unknown[]) => void;
    warn: (message: string, ...args: unknown[]) => void;
  };
}

export function createTsEngine(deps: TsEngineDeps): MemoryEngine {
  const graphSchema = loadGraphSchema(deps.projectRoot);
  const sessionMessageBuffer = new Map<string, Array<{ id?: string; session_id?: string; role?: string; content?: string; timestamp?: string }>>();
  const maxMessagesPerSession = 500;
  const maxBufferedSessions = 500;

  function pushSessionMessage(sessionId: string, message: { role: string; text: string }): void {
    const current = sessionMessageBuffer.get(sessionId) || [];
    current.push({
      id: `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      session_id: sessionId,
      role: message.role,
      content: message.text,
      timestamp: new Date().toISOString(),
    });
    if (current.length > maxMessagesPerSession) {
      sessionMessageBuffer.set(sessionId, current.slice(current.length - maxMessagesPerSession));
    } else {
      sessionMessageBuffer.set(sessionId, current);
    }
    if (sessionMessageBuffer.size > maxBufferedSessions) {
      const first = sessionMessageBuffer.keys().next().value as string | undefined;
      if (first) {
        sessionMessageBuffer.delete(first);
      }
    }
  }

  function asRecord(value: unknown): Record<string, unknown> | null {
    if (typeof value === "object" && value !== null) {
      return value as Record<string, unknown>;
    }
    return null;
  }

  function readJsonl(filePath: string): Array<Record<string, unknown>> {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/).filter(Boolean);
    const records: Array<Record<string, unknown>> = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line) as Record<string, unknown>);
      } catch {}
    }
    return records;
  }

  function writeJsonl(filePath: string, records: Array<Record<string, unknown>>): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const content = records.map(r => JSON.stringify(r)).join("\n");
    fs.writeFileSync(filePath, content ? `${content}\n` : "", "utf-8");
  }

  function memoryFiles(): { activePath: string; archivePath: string } {
    return {
      activePath: path.join(deps.memoryRoot, "sessions", "active", "sessions.jsonl"),
      archivePath: path.join(deps.memoryRoot, "sessions", "archive", "sessions.jsonl"),
    };
  }

  function parseJsonFile(filePath: string): Record<string, unknown> | null {
    try {
      if (!fs.existsSync(filePath)) {
        return null;
      }
      const raw = fs.readFileSync(filePath, "utf-8").trim();
      if (!raw) {
        return null;
      }
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  function embeddingStats(records: Array<Record<string, unknown>>): {
    total: number;
    ok: number;
    failed: number;
    pending: number;
    coverage: number;
  } {
    let ok = 0;
    let failed = 0;
    let pending = 0;
    for (const record of records) {
      const explicit = typeof record.embedding_status === "string" ? record.embedding_status.trim() : "";
      const hasEmbedding = Array.isArray(record.embedding) && record.embedding.length > 0;
      if (explicit === "ok" || hasEmbedding) {
        ok += 1;
      } else if (explicit === "failed") {
        failed += 1;
      } else {
        pending += 1;
      }
    }
    const total = records.length;
    const coverage = total > 0 ? Number((ok / total).toFixed(4)) : 0;
    return { total, ok, failed, pending, coverage };
  }

  function normalizeBaseUrl(value?: string): string {
    if (!value) return "";
    return value.endsWith("/") ? value.slice(0, -1) : value;
  }

  function estimateTokenCount(text: string): number {
    const parts = text
      .split(/[\s,.;:!?，。；：！？、()（）[\]{}"'`~]+/)
      .map(part => part.trim())
      .filter(Boolean);
    return parts.length;
  }

  function buildVectorSourceText(record: Record<string, unknown>, layer: "active" | "archive"): string {
    if (layer === "active") {
      const content = typeof record.content === "string" && record.content.trim()
        ? record.content.trim()
        : (typeof record.text === "string" ? record.text.trim() : "");
      return content;
    }
    const summary = typeof record.summary === "string" ? record.summary.trim() : "";
    const eventType = typeof record.event_type === "string" ? record.event_type.trim() : "insight";
    const outcome = typeof record.outcome === "string" ? record.outcome.trim() : "";
    const sourceFile = typeof record.source_file === "string" ? record.source_file.trim() : "";
    const actor = typeof record.actor === "string" ? record.actor.trim() : "";
    const entities = Array.isArray(record.entities)
      ? record.entities.filter(v => typeof v === "string").map(v => String(v).trim()).filter(Boolean)
      : [];
    const relations = Array.isArray(record.relations)
      ? record.relations
          .map(v => {
            if (!v || typeof v !== "object") return "";
            const relation = v as Record<string, unknown>;
            const source = typeof relation.source === "string" ? relation.source.trim() : "";
            const target = typeof relation.target === "string" ? relation.target.trim() : "";
            const type = typeof relation.type === "string" ? relation.type.trim() : "related_to";
            if (!source || !target) return "";
            return `${source} -[${type}]-> ${target}`;
          })
          .filter(Boolean)
      : [];
    const lines = [
      `event_type: ${eventType}`,
      `summary: ${summary}`,
      `outcome: ${outcome}`,
      `entities: ${entities.join(", ")}`,
      `source_file: ${sourceFile}`,
      `actor: ${actor}`,
      relations.length > 0 ? `relations: ${relations.join(" ; ")}` : "",
    ].filter(Boolean);
    return lines.join("\n").trim();
  }

  function splitTextChunks(text: string, chunkSize: number, chunkOverlap: number): Array<{
    index: number;
    start: number;
    end: number;
    text: string;
  }> {
    const normalizedSize = Number.isFinite(chunkSize) && chunkSize >= 200 ? Math.floor(chunkSize) : 600;
    const normalizedOverlap = Number.isFinite(chunkOverlap) && chunkOverlap >= 0
      ? Math.floor(chunkOverlap)
      : 100;
    const overlap = Math.min(normalizedOverlap, Math.max(0, normalizedSize - 50));
    const output: Array<{ index: number; start: number; end: number; text: string }> = [];
    let cursor = 0;
    let index = 0;
    const punctuationSet = new Set(["。", "！", "？", ".", "!", "?", "\n", "；", ";"]);
    while (cursor < text.length) {
      const rawEnd = Math.min(text.length, cursor + normalizedSize);
      let end = rawEnd;
      if (rawEnd < text.length) {
        const backwardStart = Math.max(cursor + Math.floor(normalizedSize * 0.45), cursor + 1);
        let found = -1;
        for (let i = rawEnd - 1; i >= backwardStart; i -= 1) {
          if (punctuationSet.has(text[i])) {
            found = i + 1;
            break;
          }
        }
        if (found < 0) {
          const forwardEnd = Math.min(text.length, rawEnd + Math.floor(normalizedSize * 0.2));
          for (let i = rawEnd; i < forwardEnd; i += 1) {
            if (punctuationSet.has(text[i])) {
              found = i + 1;
              break;
            }
          }
        }
        if (found > cursor) {
          end = found;
        }
      }
      if (end <= cursor) {
        end = Math.min(text.length, cursor + normalizedSize);
      }
      const chunkText = text.slice(cursor, end).trim();
      if (chunkText) {
        output.push({ index, start: cursor, end, text: chunkText });
        index += 1;
      }
      if (end >= text.length) {
        break;
      }
      const nextCursor = Math.max(cursor + 1, end - overlap);
      cursor = nextCursor <= cursor ? end : nextCursor;
    }
    return output;
  }

  function upsertJsonFile(filePath: string, patch: Record<string, unknown>): void {
    const current = parseJsonFile(filePath) || {};
    const next = { ...current, ...patch };
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(next, null, 2), "utf-8");
  }

  async function probeModelConnection(args: {
    kind: "embedding" | "llm" | "reranker";
    model: string;
    apiKey: string;
    baseUrl: string;
    timeoutMs?: number;
  }): Promise<{ configured: boolean; connected: boolean; model: string; base_url: string; error: string }> {
    const defaultTimeoutMs = args.kind === "llm" ? 30000 : 15000;
    const timeoutMs = typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs) && args.timeoutMs >= 1000
      ? Math.floor(args.timeoutMs)
      : defaultTimeoutMs;
    if (!args.model || !args.apiKey || !args.baseUrl) {
      return {
        configured: false,
        connected: false,
        model: args.model || "",
        base_url: args.baseUrl || "",
        error: "not_configured",
      };
    }
    let endpoint = args.baseUrl;
    let payload: Record<string, unknown> = {};
    if (args.kind === "embedding") {
      endpoint = args.baseUrl.endsWith("/embeddings") ? args.baseUrl : `${args.baseUrl}/embeddings`;
      payload = {
        model: args.model,
        input: "diagnostics connectivity probe",
      };
    } else if (args.kind === "llm") {
      endpoint = args.baseUrl.endsWith("/chat/completions") ? args.baseUrl : `${args.baseUrl}/chat/completions`;
      payload = {
        model: args.model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 4,
        temperature: 0,
        stream: false,
      };
    } else {
      endpoint = args.baseUrl.endsWith("/rerank") ? args.baseUrl : `${args.baseUrl}/rerank`;
      payload = {
        model: args.model,
        query: "diagnostics",
        documents: ["diagnostics connectivity probe"],
        top_n: 1,
      };
    }
    let lastError = "unknown_error";
    const maxAttempts = args.kind === "llm" ? 3 : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: `Bearer ${args.apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (response.ok) {
          return {
            configured: true,
            connected: true,
            model: args.model,
            base_url: args.baseUrl,
            error: "",
          };
        }
        let details = "";
        try {
          const text = (await response.text()).trim();
          if (text) {
            details = text.slice(0, 180);
          }
        } catch {
          details = "";
        }
        lastError = details ? `http_${response.status}:${details}` : `http_${response.status}`;
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error);
        if ((error as { name?: string } | null)?.name === "AbortError" || /aborted/i.test(raw)) {
          lastError = `timeout_${timeoutMs}ms`;
        } else {
          lastError = raw;
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }
    return {
      configured: true,
      connected: false,
      model: args.model,
      base_url: args.baseUrl,
      error: lastError,
    };
  }

  async function requestEmbedding(args: {
    text: string;
    model: string;
    apiKey: string;
    baseUrl: string;
    dimensions?: number;
    timeoutMs?: number;
    maxRetries?: number;
  }): Promise<number[] | null> {
    const endpoint = args.baseUrl.endsWith("/embeddings") ? args.baseUrl : `${args.baseUrl}/embeddings`;
    const body: Record<string, unknown> = {
      input: args.text,
      model: args.model,
    };
    if (typeof args.dimensions === "number" && Number.isFinite(args.dimensions) && args.dimensions > 0) {
      body.dimensions = args.dimensions;
    }
    const timeoutMs = typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs) && args.timeoutMs >= 1000
      ? Math.floor(args.timeoutMs)
      : 20000;
    const maxRetries = typeof args.maxRetries === "number" && Number.isFinite(args.maxRetries) && args.maxRetries >= 1
      ? Math.min(8, Math.floor(args.maxRetries))
      : 4;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
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
          lastError = new Error(`embedding_http_${response.status}`);
          continue;
        }
        const json = await response.json() as { data?: Array<{ embedding?: number[] }> };
        const embedding = json?.data?.[0]?.embedding;
        if (Array.isArray(embedding) && embedding.length > 0) {
          return embedding.filter(item => Number.isFinite(item));
        }
        lastError = new Error("embedding_empty");
      } catch (error) {
        clearTimeout(timeoutId);
        lastError = error;
      }
      if (attempt < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, 300 * Math.pow(2, attempt)));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError || "embedding_failed"));
  }

  async function storeEvent(args: StoreEventArgs, _context: ToolContext): Promise<ToolResult> {
    try {
      const rawArgs = args as unknown as Record<string, unknown>;
      const summaryCandidate = typeof rawArgs?.summary === "string"
        ? rawArgs.summary
        : typeof (rawArgs?.input as Record<string, unknown> | undefined)?.summary === "string"
          ? String((rawArgs.input as Record<string, unknown>).summary)
          : typeof (rawArgs?.event as Record<string, unknown> | undefined)?.summary === "string"
            ? String((rawArgs.event as Record<string, unknown>).summary)
            : "";
      const normalizedSummary = summaryCandidate.trim();
      if (!normalizedSummary) {
        return { success: false, error: "Invalid input provided. Missing 'summary' parameter." };
      }
      const entityInput = Array.isArray(rawArgs.entities)
        ? rawArgs.entities
        : Array.isArray((rawArgs.input as Record<string, unknown> | undefined)?.entities)
          ? ((rawArgs.input as Record<string, unknown>).entities as unknown[])
          : Array.isArray((rawArgs.event as Record<string, unknown> | undefined)?.entities)
            ? ((rawArgs.event as Record<string, unknown>).entities as unknown[])
            : [];
      const entities = Array.isArray(entityInput)
        ? entityInput.map(item => {
            if (typeof item === "string") {
              return item.trim();
            }
            if (item && typeof item === "object") {
              const value = ((item as { name?: string; id?: string }).name || (item as { name?: string; id?: string }).id || "") as string;
              return typeof value === "string" ? value.trim() : "";
            }
            return "";
          }).filter(Boolean)
        : [];
      const relationInput = Array.isArray(rawArgs.relations)
        ? rawArgs.relations
        : Array.isArray((rawArgs.input as Record<string, unknown> | undefined)?.relations)
          ? ((rawArgs.input as Record<string, unknown>).relations as unknown[])
          : Array.isArray((rawArgs.event as Record<string, unknown> | undefined)?.relations)
            ? ((rawArgs.event as Record<string, unknown>).relations as unknown[])
            : [];
      const relations = Array.isArray(relationInput)
        ? relationInput
            .map(item => {
              if (typeof item === "string") {
                const [sourceRaw, typeRaw, targetRaw] = item.split("|");
                const source = (sourceRaw || "").trim();
                const target = (targetRaw || "").trim();
                const type = normalizeRelationType((typeRaw || "related_to").trim(), graphSchema);
                if (!source || !target) return null;
                return { source, target, type };
              }
              if (!item || typeof item !== "object") return null;
              const relation = item as { source?: string; target?: string; type?: string };
              if (!relation.source || !relation.target) return null;
              return {
                source: relation.source.trim(),
                target: relation.target.trim(),
                type: normalizeRelationType(relation.type || "related_to", graphSchema),
              };
            })
            .filter((item): item is { source: string; target: string; type: string } => Boolean(item))
        : [];
      const outcomeValue = typeof rawArgs.outcome === "string"
        ? rawArgs.outcome
        : typeof (rawArgs.input as Record<string, unknown> | undefined)?.outcome === "string"
          ? String((rawArgs.input as Record<string, unknown>).outcome)
          : typeof (rawArgs.event as Record<string, unknown> | undefined)?.outcome === "string"
            ? String((rawArgs.event as Record<string, unknown>).outcome)
            : "";
      const result = await deps.archiveStore.storeEvents([
        {
          event_type: "manual_event",
          summary: normalizedSummary,
          entities,
          relations,
          outcome: outcomeValue,
          session_id: "manual",
          source_file: "ts_store_event",
          confidence: 1,
          source_event_id: "",
          actor: "manual_tool",
        },
      ]);
      if (result.stored.length === 0) {
        return { success: false, error: result.skipped[0]?.reason || "store_event_skipped" };
      }
      return { success: true, data: { event_id: result.stored[0].id } };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  async function queryGraph(args: QueryGraphArgs, _context: ToolContext): Promise<ToolResult> {
    const entity = args.entity?.trim();
    if (!entity) {
      return { success: false, error: "Invalid input provided. Missing 'entity' parameter." };
    }
    const relFilter = typeof args.rel === "string" && args.rel.trim()
      ? normalizeRelationType(args.rel, graphSchema)
      : "";
    const direction = args.dir === "incoming" || args.dir === "outgoing" || args.dir === "both"
      ? args.dir
      : "both";
    const pathTo = typeof args.path_to === "string" && args.path_to.trim() ? args.path_to.trim() : "";
    const maxDepth = Math.max(2, Math.min(4, typeof args.max_depth === "number" ? Math.floor(args.max_depth) : 3));
    const { archivePath } = memoryFiles();
    const records = readJsonl(archivePath);
    const nodes = new Map<string, { id: string; type: string }>();
    const edges: Array<{ source: string; target: string; type: string }> = [];
    const adjacency = new Map<string, Array<{ next: string; edge: { source: string; target: string; type: string } }>>();
    const pathAdjacency = new Map<string, Array<{ next: string; edge: { source: string; target: string; type: string } }>>();
    const relationTypeDistribution = new Map<string, number>();
    const edgeKeySet = new Set<string>();

    function pushEdge(source: string, target: string, type: string): void {
      const key = `${source}|${type}|${target}`;
      if (edgeKeySet.has(key)) {
        return;
      }
      edgeKeySet.add(key);
      edges.push({ source, target, type });
      relationTypeDistribution.set(type, (relationTypeDistribution.get(type) || 0) + 1);
      if (!adjacency.has(source)) {
        adjacency.set(source, []);
      }
      adjacency.get(source)?.push({ next: target, edge: { source, target, type } });
      if (!adjacency.has(target)) {
        adjacency.set(target, []);
      }
      adjacency.get(target)?.push({ next: source, edge: { source, target, type } });
    }

    function pushPathEdge(source: string, target: string, type: string): void {
      if (!pathAdjacency.has(source)) {
        pathAdjacency.set(source, []);
      }
      if (!pathAdjacency.has(target)) {
        pathAdjacency.set(target, []);
      }
      if (direction === "incoming") {
        pathAdjacency.get(target)?.push({ next: source, edge: { source, target, type } });
      } else if (direction === "outgoing") {
        pathAdjacency.get(source)?.push({ next: target, edge: { source, target, type } });
      } else {
        pathAdjacency.get(source)?.push({ next: target, edge: { source, target, type } });
        pathAdjacency.get(target)?.push({ next: source, edge: { source, target, type } });
      }
    }

    for (const record of records) {
      const entities = Array.isArray(record.entities) ? record.entities : [];
      const named = entities.map(e => (typeof e === "string" ? e.trim() : "")).filter(Boolean);
      const relations = Array.isArray(record.relations) ? record.relations : [];
      let explicitMatched = false;
      for (const relationRaw of relations) {
        if (typeof relationRaw !== "object" || relationRaw === null) {
          continue;
        }
        const relation = relationRaw as { source?: string; target?: string; type?: string };
        const source = typeof relation.source === "string" ? relation.source.trim() : "";
        const target = typeof relation.target === "string" ? relation.target.trim() : "";
        const type = normalizeRelationType(
          typeof relation.type === "string" && relation.type.trim() ? relation.type.trim() : "related_to",
          graphSchema,
        );
        if (!source || !target) {
          continue;
        }
        if (relFilter && type !== relFilter) {
          continue;
        }
        pushPathEdge(source, target, type);
        const outgoingMatch = source === entity;
        const incomingMatch = target === entity;
        const directionMatched =
          direction === "both" ? (outgoingMatch || incomingMatch)
            : direction === "outgoing" ? outgoingMatch
              : incomingMatch;
        if (!directionMatched) {
          continue;
        }
        explicitMatched = true;
        if (!nodes.has(source)) nodes.set(source, { id: source, type: "entity" });
        if (!nodes.has(target)) nodes.set(target, { id: target, type: "entity" });
        pushEdge(source, target, type);
      }
      if (explicitMatched) {
        continue;
      }
      if (!named.includes(entity)) {
        continue;
      }
      for (const name of named) {
        if (!nodes.has(name)) {
          nodes.set(name, { id: name, type: "entity" });
        }
      }
      for (const name of named) {
        if (name !== entity) {
          if (!relFilter || relFilter === "co_occurrence") {
            pushEdge(entity, name, "co_occurrence");
          }
        }
      }
    }

    let path: Array<{ source: string; target: string; type: string }> = [];
    if (pathTo) {
      const visited = new Set<string>();
      const queue: Array<{ node: string; depth: number; pathEdges: Array<{ source: string; target: string; type: string }> }> = [
        { node: entity, depth: 0, pathEdges: [] },
      ];
      while (queue.length > 0) {
        const current = queue.shift();
        if (!current) break;
        if (current.node === pathTo) {
          path = current.pathEdges;
          break;
        }
        if (current.depth >= maxDepth) {
          continue;
        }
        const visitKey = `${current.node}:${current.depth}`;
        if (visited.has(visitKey)) {
          continue;
        }
        visited.add(visitKey);
        for (const next of pathAdjacency.get(current.node) || []) {
          queue.push({
            node: next.next,
            depth: current.depth + 1,
            pathEdges: [...current.pathEdges, next.edge],
          });
        }
      }
    }

    return {
      success: true,
      data: {
        entity,
        rel: relFilter || "",
        dir: direction,
        nodes: [...nodes.values()],
        edges,
        path_to: pathTo || "",
        max_depth: maxDepth,
        path,
        relation_type_distribution: [...relationTypeDistribution.entries()].map(([type, count]) => ({ type, count })),
      },
    };
  }

  async function deleteMemory(args: DeleteMemoryArgs, _context: ToolContext): Promise<ToolResult> {
    const targetId = args.memory_id?.trim();
    if (!targetId) {
      return { success: false, error: "Invalid input provided. Missing 'memory_id' parameter." };
    }
    const { activePath, archivePath } = memoryFiles();
    let removed = 0;
    for (const filePath of [activePath, archivePath]) {
      const records = readJsonl(filePath);
      const filtered = records.filter(r => {
        const id = typeof r.id === "string" ? r.id : "";
        const keep = id !== targetId;
        if (!keep) {
          removed += 1;
        }
        return keep;
      });
      if (filtered.length !== records.length) {
        writeJsonl(filePath, filtered);
      }
    }
    return { success: removed > 0, data: { removed } };
  }

  async function updateMemory(args: UpdateMemoryArgs, _context: ToolContext): Promise<ToolResult> {
    const targetId = args.memory_id?.trim();
    if (!targetId) {
      return { success: false, error: "Invalid input provided. Missing 'memory_id' parameter." };
    }
    const { activePath, archivePath } = memoryFiles();
    let updated = 0;
    for (const filePath of [activePath, archivePath]) {
      const records = readJsonl(filePath);
      let changed = false;
      for (const record of records) {
        const id = typeof record.id === "string" ? record.id : "";
        if (id !== targetId) {
          continue;
        }
        if (typeof args.text === "string") {
          if (typeof record.content === "string") {
            record.content = args.text;
          } else {
            record.summary = args.text;
          }
        }
        if (typeof args.type === "string") {
          record.type = args.type;
        }
        if (typeof args.weight === "number") {
          record.weight = args.weight;
        }
        record.updated_at = new Date().toISOString();
        updated += 1;
        changed = true;
      }
      if (changed) {
        writeJsonl(filePath, records);
      }
    }
    return { success: updated > 0, data: { updated } };
  }

  async function cleanupMemories(args: CleanupMemoriesArgs, _context: ToolContext): Promise<ToolResult> {
    const daysOld = typeof args.days_old === "number" && args.days_old > 0 ? Math.floor(args.days_old) : 90;
    const cutoff = Date.now() - daysOld * 24 * 60 * 60 * 1000;
    const { activePath, archivePath } = memoryFiles();
    let deletedCount = 0;
    for (const filePath of [activePath, archivePath]) {
      const records = readJsonl(filePath);
      const filtered = records.filter(record => {
        const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
        if (!Number.isFinite(timestamp)) {
          return true;
        }
        const keep = timestamp >= cutoff;
        if (!keep) {
          deletedCount += 1;
        }
        return keep;
      });
      if (filtered.length !== records.length) {
        writeJsonl(filePath, filtered);
      }
    }
    return { success: true, data: { deletedCount } };
  }

  async function backfillEmbeddings(args: BackfillEmbeddingsArgs, _context: ToolContext): Promise<ToolResult> {
    const layer = args.layer === "active" || args.layer === "archive" || args.layer === "all" ? args.layer : "all";
    const rebuildMode = args.rebuild_mode === "vector_only" || args.rebuild_mode === "full"
      ? args.rebuild_mode
      : "incremental";
    const batchSize = typeof args.batch_size === "number" && Number.isFinite(args.batch_size) && args.batch_size > 0
      ? Math.min(500, Math.floor(args.batch_size))
      : 100;
    const maxRetries = typeof args.max_retries === "number" && Number.isFinite(args.max_retries) && args.max_retries >= 1
      ? Math.min(10, Math.floor(args.max_retries))
      : 3;
    const retryFailedOnly = args.retry_failed_only === true;
    const forceRebuild = rebuildMode === "vector_only" || rebuildMode === "full";
    const model = deps.embedding?.model || "";
    const apiKey = deps.embedding?.apiKey || "";
    const baseUrl = normalizeBaseUrl(deps.embedding?.baseURL || deps.embedding?.baseUrl);
    if (!model || !apiKey || !baseUrl) {
      return { success: false, error: "Embedding config missing for backfill tool." };
    }

    const statePath = path.join(deps.memoryRoot, ".vector_backfill_state.json");
    const syncStatePath = path.join(deps.memoryRoot, ".sync_state.json");
    const previousState = parseJsonFile(statePath) || {};
    const failureCountState = (typeof previousState.failureCounts === "object" && previousState.failureCounts !== null)
      ? previousState.failureCounts as Record<string, unknown>
      : {};
    let fullSyncResult: { imported: number; skipped: number; filesProcessed: number } | null = null;
    if (rebuildMode === "full") {
      try {
        fullSyncResult = await deps.sessionSync.syncMemory();
      } catch (error) {
        deps.logger.warn(`backfill_full_rebuild_sync_failed error=${error}`);
      }
    }

    const { activePath, archivePath } = memoryFiles();
    const targetFiles: Array<{ layer: "active" | "archive"; filePath: string }> = [];
    if (layer === "all" || layer === "active") {
      targetFiles.push({ layer: "active", filePath: activePath });
    }
    if (layer === "all" || layer === "archive") {
      targetFiles.push({ layer: "archive", filePath: archivePath });
    }

    const queue: Array<{ layer: "active" | "archive"; filePath: string; index: number }> = [];
    const recordsByFile = new Map<string, Array<Record<string, unknown>>>();
    for (const target of targetFiles) {
      const records = readJsonl(target.filePath);
      recordsByFile.set(target.filePath, records);
      for (let i = 0; i < records.length; i += 1) {
        const record = records[i];
        const id = typeof record.id === "string" ? record.id : "";
        if (!id) {
          continue;
        }
        const status = typeof record.embedding_status === "string" ? record.embedding_status.trim() : "";
        const hasEmbedding = Array.isArray(record.embedding) && record.embedding.length > 0;
        if (forceRebuild) {
          queue.push({ layer: target.layer, filePath: target.filePath, index: i });
          continue;
        }
        if (retryFailedOnly) {
          if (status !== "failed") {
            continue;
          }
        } else if (status === "ok" || hasEmbedding) {
          continue;
        }
        const failCountRaw = failureCountState[id];
        const failCount = typeof failCountRaw === "number" ? failCountRaw : 0;
        if (failCount >= maxRetries && status === "failed") {
          continue;
        }
        queue.push({ layer: target.layer, filePath: target.filePath, index: i });
      }
    }

    const totalCandidates = queue.length;
    let success = 0;
    let failed = 0;
    let skipped = 0;
    let processed = 0;
    const failureCounts: Record<string, number> = {};
    for (const [key, value] of Object.entries(failureCountState)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        failureCounts[key] = value;
      }
    }

    for (let start = 0; start < queue.length; start += batchSize) {
      const batch = queue.slice(start, start + batchSize);
      for (const item of batch) {
        processed += 1;
        const records = recordsByFile.get(item.filePath) || [];
        const record = records[item.index];
        if (!record) {
          skipped += 1;
          continue;
        }
        const id = typeof record.id === "string" ? record.id : "";
        if (!id) {
          skipped += 1;
          continue;
        }
        const text = buildVectorSourceText(record, item.layer);
        if (!text) {
          record.embedding_status = "failed";
          failed += 1;
          failureCounts[id] = (failureCounts[id] || 0) + 1;
          continue;
        }
        const chunkSize = deps.vectorChunking?.chunkSize ?? 600;
        const chunkOverlap = deps.vectorChunking?.chunkOverlap ?? 100;
        const chunks = splitTextChunks(text, chunkSize, chunkOverlap);
        if (chunks.length === 0) {
          record.embedding_status = "failed";
          failed += 1;
          failureCounts[id] = (failureCounts[id] || 0) + 1;
          continue;
        }
        try {
          if (forceRebuild) {
            record.embedding_status = "pending";
          }
          await deps.vectorStore.deleteBySourceMemory({ layer: item.layer, sourceMemoryId: id });
          let chunkOk = 0;
          for (const chunk of chunks) {
            const embedding = await requestEmbedding({
              text: chunk.text,
              model,
              apiKey,
              baseUrl,
              dimensions: deps.embedding?.dimensions,
              timeoutMs: deps.embedding?.timeoutMs,
              maxRetries: deps.embedding?.maxRetries,
            });
            if (!embedding || embedding.length === 0) {
              continue;
            }
            if (!record.embedding) {
              record.embedding = embedding;
            }
            await deps.vectorStore.upsert({
              id: `${id}_c${chunk.index}`,
              session_id: typeof record.session_id === "string" ? record.session_id : "unknown",
              event_type: typeof record.event_type === "string" ? record.event_type : (item.layer === "active" ? "message" : "insight"),
              summary: chunk.text,
              timestamp: typeof record.timestamp === "string" ? record.timestamp : new Date().toISOString(),
              layer: item.layer,
              source_memory_id: id,
              source_memory_canonical_id: typeof record.canonical_id === "string" ? record.canonical_id : id,
              outcome: typeof record.outcome === "string" ? record.outcome : "",
              entities: Array.isArray(record.entities) ? record.entities.filter(v => typeof v === "string") as string[] : [],
              relations: Array.isArray(record.relations)
                ? record.relations
                    .map(v => {
                      if (!v || typeof v !== "object") return null;
                      const relation = v as Record<string, unknown>;
                      const source = typeof relation.source === "string" ? relation.source : "";
                      const target = typeof relation.target === "string" ? relation.target : "";
                      const type = typeof relation.type === "string" ? relation.type : "related_to";
                      if (!source || !target) return null;
                      return { source, target, type };
                    })
                    .filter((v): v is { source: string; target: string; type: string } => Boolean(v))
                : [],
              embedding,
              quality_score: typeof record.quality_score === "number" ? record.quality_score : 0.5,
              char_count: chunk.text.length,
              token_count: estimateTokenCount(chunk.text),
              chunk_index: chunk.index,
              chunk_total: chunks.length,
              chunk_start: chunk.start,
              chunk_end: chunk.end,
            });
            chunkOk += 1;
          }
          record.vector_chunks_total = chunks.length;
          record.vector_chunks_ok = chunkOk;
          record.embedding_status = chunkOk === chunks.length ? "ok" : "failed";
          if (!record.layer) {
            record.layer = item.layer;
          }
          if (typeof record.char_count !== "number") {
            record.char_count = text.length;
          }
          if (typeof record.token_count !== "number") {
            record.token_count = estimateTokenCount(text);
          }
          if (chunkOk === chunks.length) {
            success += 1;
            failureCounts[id] = 0;
          } else {
            failed += 1;
            failureCounts[id] = (failureCounts[id] || 0) + 1;
          }
        } catch (error) {
          record.embedding_status = "failed";
          failed += 1;
          failureCounts[id] = (failureCounts[id] || 0) + 1;
          deps.logger.warn(`backfill_embedding_failed id=${id} layer=${item.layer} error=${error}`);
        }
      }
      deps.logger.info(`backfill_progress processed=${processed}/${totalCandidates} success=${success} failed=${failed} skipped=${skipped}`);
    }

    for (const target of targetFiles) {
      const records = recordsByFile.get(target.filePath);
      if (records) {
        writeJsonl(target.filePath, records);
      }
    }

    const summary = {
      runAt: new Date().toISOString(),
      layer,
      rebuild_mode: rebuildMode,
      candidates: totalCandidates,
      success,
      failed,
      skipped,
      batch_size: batchSize,
      max_retries: maxRetries,
      retry_failed_only: retryFailedOnly,
      full_sync_result: fullSyncResult,
    };
    upsertJsonFile(statePath, {
      version: "1",
      lastRun: summary,
      failureCounts,
    });
    upsertJsonFile(syncStatePath, {
      version: "2",
      lastVectorBackfill: {
        runAt: summary.runAt,
        success,
        failed,
        skipped,
      },
    });

    return { success: true, data: summary };
  }

  async function runDiagnostics(_args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const { activePath, archivePath } = memoryFiles();
    const activeRecords = readJsonl(activePath);
    const archiveRecords = readJsonl(archivePath);
    const activeVector = embeddingStats(activeRecords);
    const archiveVector = embeddingStats(archiveRecords);
    const vectorJsonlPath = path.join(deps.memoryRoot, "vector", "lancedb_events.jsonl");
    const vectorJsonlRecords = readJsonl(vectorJsonlPath);
    const activeVectorRecords = vectorJsonlRecords.filter(record => (record.layer === "active"));
    const archiveVectorRecords = vectorJsonlRecords.filter(record => (record.layer === "archive"));
    const lancedbDir = path.join(deps.memoryRoot, "vector", "lancedb");
    const lancedbExists = fs.existsSync(lancedbDir);
    let lancedbRecordCount = 0;
    if (lancedbExists) {
      try {
        const lancedbFiles = fs.readdirSync(lancedbDir).filter(f => f.endsWith(".lance") || f.endsWith(".manifest"));
        lancedbRecordCount = lancedbFiles.length > 0 ? -1 : 0;
      } catch {
        lancedbRecordCount = 0;
      }
    }
    const totalVectorRecords = vectorJsonlRecords.length > 0 ? vectorJsonlRecords.length : (lancedbRecordCount === -1 ? -1 : 0);
    const vectorStorageType = lancedbExists && lancedbRecordCount === -1 ? "lancedb" : (vectorJsonlRecords.length > 0 ? "jsonl" : "none");
    const syncState = parseJsonFile(path.join(deps.memoryRoot, ".sync_state.json"));
    const backfillState = parseJsonFile(path.join(deps.memoryRoot, ".vector_backfill_state.json"));
    const failureCounts = backfillState && typeof backfillState.failureCounts === "object" && backfillState.failureCounts !== null
      ? backfillState.failureCounts as Record<string, unknown>
      : {};
    const pendingRetry = Object.values(failureCounts).filter(value => typeof value === "number" && Number.isFinite(value) && value > 0).length;
    const lastVectorBackfill = syncState && typeof syncState.lastVectorBackfill === "object" && syncState.lastVectorBackfill !== null
      ? syncState.lastVectorBackfill
      : null;
    const embeddingConnectivity = await probeModelConnection({
      kind: "embedding",
      model: deps.embedding?.model || "",
      apiKey: deps.embedding?.apiKey || "",
      baseUrl: normalizeBaseUrl(deps.embedding?.baseURL || deps.embedding?.baseUrl),
      timeoutMs: deps.embedding?.timeoutMs,
    });
    const llmConnectivity = await probeModelConnection({
      kind: "llm",
      model: deps.llm?.model || "",
      apiKey: deps.llm?.apiKey || "",
      baseUrl: normalizeBaseUrl(deps.llm?.baseURL || deps.llm?.baseUrl),
      timeoutMs: 8000,
    });
    const rerankerConnectivity = await probeModelConnection({
      kind: "reranker",
      model: deps.reranker?.model || "",
      apiKey: deps.reranker?.apiKey || "",
      baseUrl: normalizeBaseUrl(deps.reranker?.baseURL || deps.reranker?.baseUrl),
      timeoutMs: 8000,
    });
    const checks = [
      { name: "Engine mode", passed: true, message: "TS engine active" },
      { name: "Active sessions store", passed: fs.existsSync(activePath), message: activePath },
      { name: "Archive sessions store", passed: fs.existsSync(archivePath), message: archivePath },
      { name: "Core rules store", passed: fs.existsSync(path.join(deps.memoryRoot, "CORTEX_RULES.md")), message: "CORTEX_RULES.md checked" },
      { name: "Embedding model connectivity", passed: embeddingConnectivity.connected, message: embeddingConnectivity.error || "ok" },
      { name: "LLM model connectivity", passed: llmConnectivity.connected, message: llmConnectivity.error || "ok" },
      { name: "Reranker model connectivity", passed: rerankerConnectivity.connected, message: rerankerConnectivity.error || "ok" },
    ];
    return {
      success: true,
      data: {
        status: "ok",
        prompt_versions: PROMPT_VERSIONS,
        checks,
        layers: {
          active: {
            records: activeRecords.length,
            path: activePath,
          },
          archive: {
            records: archiveRecords.length,
            path: archivePath,
          },
          vector: {
            storage_type: vectorStorageType,
            lancedb_exists: lancedbExists,
            active_coverage: activeVector.coverage,
            archive_coverage: archiveVector.coverage,
            active_unembedded: activeVector.pending + activeVector.failed,
            archive_unembedded: archiveVector.pending + archiveVector.failed,
            chunking: {
              chunk_size: deps.vectorChunking?.chunkSize ?? 600,
              chunk_overlap: deps.vectorChunking?.chunkOverlap ?? 100,
            },
            vector_jsonl_records: vectorJsonlRecords.length,
            vector_jsonl_by_layer: {
              active: activeVectorRecords.length,
              archive: archiveVectorRecords.length,
            },
            total_vector_records: totalVectorRecords,
            last_backfill_summary: lastVectorBackfill,
            backfill_state: {
              pending_retry_records: pendingRetry,
              has_state_file: fs.existsSync(path.join(deps.memoryRoot, ".vector_backfill_state.json")),
            },
          },
          graph_rules: {
            graph_mutation_log_exists: fs.existsSync(path.join(deps.memoryRoot, "graph", "mutation_log.jsonl")),
            rules_exists: fs.existsSync(path.join(deps.memoryRoot, "CORTEX_RULES.md")),
          },
        },
        model_connectivity: {
          embedding: embeddingConnectivity,
          llm: llmConnectivity,
          reranker: rerankerConnectivity,
        },
        recommendations: [],
      },
    };
  }

  async function searchMemory(args: SearchMemoryArgs, context: ToolContext): Promise<ToolResult> {
    const argsRecord = asRecord(args) || {};
    const argsInput = asRecord(argsRecord.input);
    const queryCandidate = [
      typeof args.query === "string" ? args.query : "",
      typeof argsRecord.query === "string" ? String(argsRecord.query) : "",
      typeof argsRecord.q === "string" ? String(argsRecord.q) : "",
      typeof argsRecord.keyword === "string" ? String(argsRecord.keyword) : "",
      typeof argsInput?.query === "string" ? String(argsInput.query) : "",
      typeof argsInput?.q === "string" ? String(argsInput.q) : "",
    ].find(item => item.trim());
    const query = queryCandidate ? queryCandidate.trim() : "";
    if (!query) {
      return {
        success: false,
        error: "Invalid input provided. Missing 'query' parameter.",
      };
    }
    const topKRaw = [
      typeof args.top_k === "number" ? args.top_k : undefined,
      typeof argsRecord.top_k === "number" ? Number(argsRecord.top_k) : undefined,
      typeof argsRecord.topK === "number" ? Number(argsRecord.topK) : undefined,
      typeof argsInput?.top_k === "number" ? Number(argsInput.top_k) : undefined,
      typeof argsInput?.topK === "number" ? Number(argsInput.topK) : undefined,
    ].find(value => typeof value === "number" && Number.isFinite(value));
    const result = await deps.readStore.searchMemory({
      query,
      topK: typeof topKRaw === "number" && topKRaw > 0 ? Math.floor(topKRaw) : 3,
    });
    return { success: true, data: result.results };
  }

  async function getHotContext(args: GetHotContextArgs, _context: ToolContext): Promise<ToolResult> {
    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 20;
    const result = await deps.readStore.getHotContext({ limit });
    return { success: true, data: result.context };
  }

  async function getAutoContext(args: GetAutoContextArgs, context: ToolContext): Promise<ToolResult> {
    const argsRecord = asRecord(args) || {};
    const argsInput = asRecord(argsRecord.input);
    const includeHotRaw = [
      typeof args.include_hot === "boolean" ? args.include_hot : undefined,
      typeof argsRecord.include_hot === "boolean" ? Boolean(argsRecord.include_hot) : undefined,
      typeof argsRecord.includeHot === "boolean" ? Boolean(argsRecord.includeHot) : undefined,
      typeof argsInput?.include_hot === "boolean" ? Boolean(argsInput.include_hot) : undefined,
      typeof argsInput?.includeHot === "boolean" ? Boolean(argsInput.includeHot) : undefined,
    ].find(value => typeof value === "boolean");
    const sessionId = deps.resolveSessionId((context || {}) as ToolContext);
    const cached = deps.getCachedAutoSearch(sessionId);
    const result = await deps.readStore.getAutoContext({
      includeHot: includeHotRaw !== false,
      sessionId,
      cachedAutoSearch: cached ?? undefined,
    });
    if (!result.auto_search && !result.hot_context) {
      return {
        success: true,
        data: {
          message: "No session-scoped auto-search results cached and hot context unavailable",
          suggestion: "Send a user message in this session or call get_hot_context.",
        },
      };
    }
    return { success: true, data: result };
  }

  async function syncMemory(_args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    try {
      const result = await deps.sessionSync.syncMemory();
      return { success: true, data: result };
    } catch (error) {
      deps.logger.warn(`TS sync_memory failed: ${error}`);
      return { success: false, error: String(error) };
    }
  }

  async function reflectMemory(_args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    try {
      const result = await deps.reflector.reflectMemory();
      return { success: true, data: result };
    } catch (error) {
      deps.logger.warn(`TS reflect_memory failed: ${error}`);
      return { success: false, error: String(error) };
    }
  }

  async function promoteMemory(_args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    try {
      const result = await deps.reflector.promoteMemory();
      return { success: true, data: result };
    } catch (error) {
      deps.logger.warn(`TS promote_memory failed: ${error}`);
      return { success: false, error: String(error) };
    }
  }

  async function onSessionEnd(payload: unknown, context: ToolContext): Promise<void> {
    const payloadObj = asRecord(payload);
    const sessionId = deps.resolveSessionId(context, payload);
    const syncRecordsRaw = payloadObj?.sync_records;
    const syncRecords = typeof syncRecordsRaw === "boolean" ? syncRecordsRaw : deps.defaultAutoSync;
    const bufferedMessages = sessionMessageBuffer.get(sessionId) || [];
    try {
      const result = await deps.sessionEnd.onSessionEnd({
        sessionId,
        syncRecords,
        messages: bufferedMessages,
      });
      deps.logger.info(`TS session_end completed for ${sessionId}, events=${result.events_generated}`);
      sessionMessageBuffer.delete(sessionId);
    } catch (error) {
      deps.logger.warn(`TS session_end failed for ${sessionId}: ${error}`);
    }
  }

  async function onMessage(payload: unknown, context: ToolContext): Promise<void> {
    const normalized = deps.normalizeIncomingMessage(payload);
    if (!normalized) {
      return;
    }
    const { text, role, source } = normalized;
    const sessionId = deps.resolveSessionId(context, payload);
    pushSessionMessage(sessionId, { role, text });
    deps.logger.debug(`TS buffered ${role} message for session ${sessionId} source=${source}`);

    if (role === "user" && text.length > 5) {
      try {
        const searchResult = await deps.readStore.searchMemory({ query: text, topK: 3 });
        if (searchResult.results.length > 0) {
          deps.setSessionAutoSearchCache(sessionId, text, searchResult.results);
          deps.logger.info(`TS auto-search cached ${searchResult.results.length} results for context`);
        }
      } catch (error) {
        deps.logger.debug(`TS auto-search skipped: ${error}`);
      }
    }
  }

  async function onTimer(payload: unknown, context: ToolContext): Promise<void> {
    const payloadObj = asRecord(payload);
    const action = typeof payloadObj?.action === "string" ? payloadObj.action : undefined;
    if (action === "sync") {
      await syncMemory({}, context);
      return;
    }
    if (action === "reflect" || (!action && deps.autoReflect)) {
      await reflectMemory({}, context);
      return;
    }
    if (action === "promote") {
      await promoteMemory({}, context);
    }
  }

  return {
    mode: "ts",
    searchMemory,
    getHotContext,
    getAutoContext,
    storeEvent,
    queryGraph,
    reflectMemory,
    syncMemory,
    promoteMemory,
    deleteMemory,
    updateMemory,
    cleanupMemories,
    backfillEmbeddings,
    runDiagnostics,
    onMessage,
    onSessionEnd,
    onTimer,
  };
}
