/// <reference types="node" />
import * as path from "path";
import * as fs from "fs";
import type { MemoryEngine } from "./src/engine/memory_engine";
import { createTsEngine } from "./src/engine/ts_engine";
import { createReadStore } from "./src/store/read_store";
import { createWriteStore } from "./src/store/write_store";
import { createArchiveStore } from "./src/store/archive_store";
import { createVectorStore } from "./src/store/vector_store";
import { createGraphMemoryStore } from "./src/store/graph_memory_store";
import { createSessionSync } from "./src/sync/session_sync";
import { createSessionEnd } from "./src/session/session_end";
import { createRuleStore } from "./src/rules/rule_store";
import { createReflector } from "./src/reflect/reflector";
import { createThreeStageDeduplicator } from "./src/dedup/three_stage_deduplicator";
import { getEnvValue, getHomeDir, getProcessEnvCopy } from "./src/utils/runtime_env";

interface EmbeddingConfig {
  provider: string;
  model: string;
  apiKey?: string;
  baseURL?: string;
  baseUrl?: string;
  dimensions?: number;
  timeoutMs?: number;
  maxRetries?: number;
}

interface LLMConfig {
  provider: string;
  model: string;
  apiKey?: string;
  baseURL?: string;
  baseUrl?: string;
}

interface RerankerConfig {
  provider?: string;
  model: string;
  apiKey?: string;
  baseURL?: string;
  baseUrl?: string;
}

interface CortexMemoryConfig {
  enabled?: boolean;
  fallbackToBuiltin?: boolean;
  embedding: EmbeddingConfig;
  llm: LLMConfig;
  reranker: RerankerConfig;
  dbPath?: string;
  autoSync?: boolean;
  llmRequiredForWrite?: boolean;
  autoReflect?: boolean;
  autoReflectIntervalMinutes?: number;
  graphQualityMode?: "off" | "warn" | "strict";
  wikiProjection?: {
    enabled?: boolean;
    mode?: "off" | "incremental" | "rebuild";
    maxBatch?: number;
  };
  readFusion?: {
    enabled?: boolean;
    maxCandidates?: number;
    authoritative?: boolean;
    channelWeights?: {
      rules?: number;
      archive?: number;
      vector?: number;
      graph?: number;
    };
    channelTopK?: {
      rules?: number;
      archive?: number;
      vector?: number;
      graph?: number;
    };
    minLexicalHits?: number;
    minSemanticHits?: number;
    lengthNorm?: {
      enabled?: boolean;
      pivotChars?: number;
      strength?: number;
      minFactor?: number;
    };
  };
  vectorChunking?: {
    chunkSize?: number;
    chunkOverlap?: number;
    evidenceMaxChunks?: number;
  };
  writePolicy?: {
    archiveMinConfidence?: number;
    archiveMinQualityScore?: number;
    activeMinQualityScore?: number;
    activeDedupTailLines?: number;
    activeTextMaxChars?: number;
    archiveSourceTextMaxChars?: number;
  };
  syncPolicy?: {
    includeLocalActiveInput?: boolean;
  };
  memoryDecay?: {
    enabled?: boolean;
    minFloor?: number;
    defaultHalfLifeDays?: number;
    halfLifeByEventType?: Record<string, number>;
    antiDecay?: {
      enabled?: boolean;
      maxBoost?: number;
      hitWeight?: number;
      recentWindowDays?: number;
    };
  };
  readTuning?: {
    scoring?: {
      lexicalWeight?: number;
      bm25Scale?: number;
      semanticWeight?: number;
      recencyWeight?: number;
      qualityWeight?: number;
      typeMatchWeight?: number;
      graphMatchWeight?: number;
    };
    rrf?: {
      k?: number;
      weight?: number;
    };
    recency?: {
      buckets?: Array<{
        maxAgeHours: number;
        score: number;
        bonus: number;
      }>;
    };
    autoContext?: {
      queryMaxChars?: number;
      lightweightSearch?: boolean;
    };
  };
}

interface ToolContext {
  agentId: string;
  sessionId?: string;
  workspaceId: string;
}

interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  errorCode?: string;
}

interface Logger {
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
}

interface OpenClawPluginApi {
  logger?: Logger;
  config?: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  registerTool(tool: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute?: (...params: unknown[]) => Promise<unknown>;
    handler?: (...params: unknown[]) => Promise<unknown>;
  }, options?: { optional?: boolean }): void;
  unregisterTool?(name: string): void;
  registerHook(hook: {
    event: string;
    handler: (payload: unknown, context: ToolContext) => Promise<void>;
  }): void;
  on(event: string, handler: (payload: unknown, context: ToolContext) => Promise<void> | void, options?: { priority?: number }): void;
  off?(event: string, handler: (payload: unknown, context: ToolContext) => Promise<void> | void): void;
  unregisterHook?(event: string): void;
  getLogger?(): Logger;
  getBuiltinMemory?(): { search: (query: string, topK?: number) => Promise<unknown[]>; store: (text: string, metadata?: Record<string, unknown>) => Promise<string>; delete: (id: string) => Promise<boolean> } | null;
}

interface UserFriendlyError {
  code: string;
  message: string;
  suggestion: string;
}

const ERROR_CODES: Record<string, UserFriendlyError> = {
  NOT_FOUND: {
    code: "E003",
    message: "Memory not found",
    suggestion: "The requested memory may have been deleted or never existed."
  },
  INVALID_INPUT: {
    code: "E004",
    message: "Invalid input provided",
    suggestion: "Please check your input parameters and try again."
  },
  PLUGIN_DISABLED: {
    code: "E006",
    message: "Cortex Memory plugin is disabled",
    suggestion: "Enable the plugin using 'openclaw plugins enable openclaw-cortex-memory' or check openclaw.json"
  }
};

const SENSITIVE_KEYS = ["API_KEY", "SECRET", "TOKEN", "PASSWORD", "APIKEY"];
const PLUGIN_ID = "openclaw-cortex-memory";
const TOOL_NAME_CORTEX_DIAGNOSTICS = "cortex_diagnostics";
const TOOL_NAME_DIAGNOSTICS_LEGACY = "diagnostics";

type PluginEntryLike = {
  id?: string;
  name?: string;
  register: typeof register;
  unregister?: typeof unregister;
  enable?: typeof enable;
  disable?: typeof disable;
  getStatus?: typeof getStatus;
};

const definePluginEntryCompat = (() => {
  try {
    const sdk = require("openclaw/plugin-sdk/plugin-entry");
    if (sdk && typeof sdk.definePluginEntry === "function") {
      return sdk.definePluginEntry as <T extends PluginEntryLike>(entry: T) => T;
    }
  } catch {
    // Fallback keeps compatibility with hosts that only support legacy exports.
  }
  return <T extends PluginEntryLike>(entry: T): T => entry;
})();

const MIN_OPENCLAW_GATEWAY_VERSION = "2026.4.5";
const MAX_OPENCLAW_GATEWAY_VERSION = "2027.0.0";

const defaultConfig: Partial<CortexMemoryConfig> = {
  autoSync: true,
  llmRequiredForWrite: true,
  autoReflect: false,
  autoReflectIntervalMinutes: 30,
  graphQualityMode: "warn",
  wikiProjection: {
    enabled: true,
    mode: "incremental",
    maxBatch: 100,
  },
  readFusion: {
    enabled: true,
    maxCandidates: 10,
    authoritative: true,
    channelWeights: {
      rules: 1,
      archive: 1.15,
      vector: 1.2,
      graph: 1,
    },
    channelTopK: {
      rules: 8,
      archive: 20,
      vector: 20,
      graph: 12,
    },
    minLexicalHits: 1,
    minSemanticHits: 1,
    lengthNorm: {
      enabled: true,
      pivotChars: 1200,
      strength: 0.75,
      minFactor: 0.45,
    },
  },
  vectorChunking: {
    chunkSize: 600,
    chunkOverlap: 100,
    evidenceMaxChunks: 2,
  },
  writePolicy: {
    archiveMinConfidence: 0.35,
    archiveMinQualityScore: 0.4,
    activeMinQualityScore: 0.45,
    activeDedupTailLines: 200,
    activeTextMaxChars: 200000,
    archiveSourceTextMaxChars: 500000,
  },
  syncPolicy: {
    includeLocalActiveInput: false,
  },
  memoryDecay: {
    enabled: true,
    minFloor: 0.15,
    defaultHalfLifeDays: 90,
    antiDecay: {
      enabled: true,
      maxBoost: 1.6,
      hitWeight: 0.08,
      recentWindowDays: 30,
    },
    halfLifeByEventType: {
      issue: 30,
      fix: 30,
      action_item: 30,
      blocker: 30,
      plan: 60,
      milestone: 60,
      follow_up: 60,
      decision: 120,
      insight: 120,
      retrospective: 120,
      preference: 240,
      constraint: 240,
      requirement: 240,
      dependency: 240,
      assumption: 240,
    },
  },
  readTuning: {
    scoring: {
      lexicalWeight: 0.2,
      bm25Scale: 2,
      semanticWeight: 0.3,
      recencyWeight: 0.1,
      qualityWeight: 0.15,
      typeMatchWeight: 0.15,
      graphMatchWeight: 0.1,
    },
    rrf: {
      k: 60,
      weight: 1.5,
    },
    recency: {
      buckets: [
        { maxAgeHours: 12, score: 1, bonus: 0.6 },
        { maxAgeHours: 24, score: 0.8, bonus: 0.6 },
        { maxAgeHours: 72, score: 0.6, bonus: 0.3 },
        { maxAgeHours: 168, score: 0.4, bonus: 0.3 },
        { maxAgeHours: 720, score: 0.2, bonus: 0 },
        { maxAgeHours: Number.POSITIVE_INFINITY, score: 0.05, bonus: 0 },
      ],
    },
    autoContext: {
      queryMaxChars: 80,
      lightweightSearch: true,
    },
  },
  enabled: true,
};

interface CachedSearchResult {
  sessionId: string;
  query: string;
  results: unknown[];
  timestamp: number;
}

let autoSearchCacheBySession = new Map<string, CachedSearchResult>();
const AUTO_SEARCH_CACHE_TTL = 60000;
const MAX_AUTO_SEARCH_CACHE_SESSIONS = 200;
const HOOK_GUARD_TIMEOUT_MS = 2000;
const SYNC_DEBOUNCE_WINDOW_MS = 120000;

let config: CortexMemoryConfig | null = null;
let logger: Logger;
let isShuttingDown = false;
let isInitializing = false;
let isRegistered = false;
let isEnabled = false;
let api: OpenClawPluginApi | null = null;
let registeredTools: string[] = [];
let registeredHooks: string[] = [];
let registeredFallbackTools: string[] = [];
const registeredHookHandlers = new Map<string, (payload: unknown, context: ToolContext) => Promise<void>>();
let configWatchInterval: ReturnType<typeof setInterval> | null = null;
let autoReflectInterval: ReturnType<typeof setInterval> | null = null;
let lastAutoReflectArchiveMarker = "";
let lastAutoReflectRunAt = 0;
let configPath: string | null = null;
let processHandlersRegistered = false;
let memoryEngine: MemoryEngine | null = null;
let builtinMemory: { search: (query: string, topK?: number) => Promise<unknown[]>; store: (text: string, metadata?: Record<string, unknown>) => Promise<string>; delete: (id: string) => Promise<boolean> } | null = null;

type RegisteredToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  optional?: boolean;
  execute: (params: { args?: Record<string, unknown>; context: ToolContext }) => Promise<ToolResult>;
};

type AgentToolResultPayload = {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
};

const TOOL_TRACE_PAYLOAD_MAX_CHARS = 1500;

function inferOpenClawBasePathForWorkspace(): string | null {
  const explicitConfigPath = getEnvValue("OPENCLAW_CONFIG_PATH").trim();
  if (explicitConfigPath) {
    return path.dirname(path.resolve(explicitConfigPath));
  }
  const stateDir = getEnvValue("OPENCLAW_STATE_DIR").trim();
  if (stateDir) {
    return path.resolve(stateDir);
  }
  const basePath = getEnvValue("OPENCLAW_BASE_PATH").trim();
  if (basePath) {
    return path.resolve(basePath);
  }
  const discoveredConfigPath = findOpenClawConfig();
  if (discoveredConfigPath) {
    return path.dirname(path.resolve(discoveredConfigPath));
  }
  return null;
}

function resolveDefaultMemoryRoot(projectRoot: string): string {
  const openClawBasePath = inferOpenClawBasePathForWorkspace();
  if (openClawBasePath) {
    return path.join(openClawBasePath, "workspace", "memory", PLUGIN_ID);
  }
  return path.join(projectRoot, "data", "memory");
}

function resolveConfiguredMemoryRoot(configuredDbPath?: string): string {
  if (typeof configuredDbPath === "string" && configuredDbPath.trim()) {
    return path.resolve(configuredDbPath.trim());
  }
  return resolveDefaultMemoryRoot(findProjectRoot());
}

function getMemoryRoot(): string {
  return resolveConfiguredMemoryRoot(config?.dbPath);
}

function getArchiveMarker(): string {
  try {
    const archivePath = path.join(getMemoryRoot(), "sessions", "archive", "sessions.jsonl");
    if (!fs.existsSync(archivePath)) {
      return "missing";
    }
    const stats = fs.statSync(archivePath);
    return `${stats.size}:${stats.mtimeMs}`;
  } catch {
    return "error";
  }
}

function getSessionCachedAutoSearch(sessionId: string): { query: string; results: unknown[]; ageSeconds: number } | null {
  clearStaleAutoSearchCache();
  const cache = autoSearchCacheBySession.get(sessionId);
  if (!cache) {
    return null;
  }
  return {
    query: cache.query,
    results: cache.results,
    ageSeconds: Math.floor((Date.now() - cache.timestamp) / 1000),
  };
}

function isInternalSession(sessionId?: string): boolean {
  if (!sessionId) return false;
  return sessionId.startsWith("slug-generator-") || sessionId.startsWith("fallback:");
}

async function runWithTimeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T | null> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeoutPromise = new Promise<null>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(null), timeoutMs);
    });
    const result = await Promise.race([task, timeoutPromise]);
    if (result === null) {
      logger.warn(`${label} timed out after ${timeoutMs}ms; skipped to protect gateway responsiveness`);
    }
    return result as T | null;
  } catch (error) {
    logger.warn(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function resolveEngine(): MemoryEngine {
  if (!config) {
    throw new Error("Configuration not loaded");
  }
  if (memoryEngine) {
    return memoryEngine;
  }
  const projectRoot = findProjectRoot();
  const memoryRoot = getMemoryRoot();
  const readStore = createReadStore({
    projectRoot,
    dbPath: config.dbPath,
    logger,
    embedding: config.embedding,
    reranker: config.reranker,
    llm: config.llm,
    fusion: config.readFusion,
    memoryDecay: config.memoryDecay,
    readTuning: config.readTuning,
  });
  const vectorStore = createVectorStore({
    memoryRoot,
    logger,
  });
  const writeStore = createWriteStore({
    projectRoot,
    dbPath: config.dbPath,
    logger,
    embedding: config.embedding,
    vectorChunking: config.vectorChunking,
    writePolicy: config.writePolicy,
    vectorStore,
  });
  const deduplicator = createThreeStageDeduplicator({
    memoryRoot,
    logger,
  });
  const archiveStore = createArchiveStore({
    projectRoot,
    memoryRoot,
    logger,
    embedding: config.embedding,
    vectorChunking: config.vectorChunking,
    writePolicy: config.writePolicy,
    deduplicator,
    vectorStore,
  });
  const graphMemoryStore = createGraphMemoryStore({
    projectRoot,
    memoryRoot,
    logger,
    qualityMode: config.graphQualityMode || "warn",
    wikiProjection: config.wikiProjection,
  });
  const sessionSync = createSessionSync({
    projectRoot,
    dbPath: config.dbPath,
    logger,
    llm: config.llm,
    graphQualityMode: config.graphQualityMode || "warn",
    requireLlmForWrite: config.llmRequiredForWrite ?? true,
    writePolicy: config.writePolicy,
    syncPolicy: config.syncPolicy,
    archiveStore,
    graphMemoryStore,
    writeStore,
  });
  let syncInFlight: Promise<{ imported: number; skipped: number; filesProcessed: number }> | null = null;
  let lastSyncFinishedAt = 0;
  const dedupedSyncMemory = async (): Promise<{ imported: number; skipped: number; filesProcessed: number }> => {
    const now = Date.now();
    if (syncInFlight) {
      logger.info("sync_memory dedup: join in-flight run");
      return syncInFlight;
    }
    if ((now - lastSyncFinishedAt) < SYNC_DEBOUNCE_WINDOW_MS) {
      const waitMs = SYNC_DEBOUNCE_WINDOW_MS - (now - lastSyncFinishedAt);
      logger.info(`sync_memory dedup: skip due to debounce window (${waitMs}ms remaining)`);
      return { imported: 0, skipped: 0, filesProcessed: 0 };
    }
    syncInFlight = sessionSync.syncMemory();
    try {
      const result = await syncInFlight;
      lastSyncFinishedAt = Date.now();
      return result;
    } finally {
      syncInFlight = null;
    }
  };
  const sessionEnd = createSessionEnd({
    projectRoot,
    dbPath: config.dbPath,
    logger,
    syncMemory: dedupedSyncMemory,
    syncDailySummaries: sessionSync.syncDailySummaries,
    routeTranscript: sessionSync.routeTranscript,
  });
  const ruleStore = createRuleStore({
    projectRoot,
    dbPath: config.dbPath,
    logger,
  });
  const reflector = createReflector({
    projectRoot,
    dbPath: config.dbPath,
    logger,
    ruleStore,
    llm: config.llm,
  });
  const sessionSyncBridge = {
    ...sessionSync,
    syncMemory: dedupedSyncMemory,
  };
  memoryEngine = createTsEngine({
    readStore,
    writeStore,
    vectorStore,
    archiveStore,
    graphMemoryStore,
    sessionSync: sessionSyncBridge,
    sessionEnd,
    reflector,
    memoryRoot,
    projectRoot,
    embedding: config.embedding,
    llm: config.llm,
    reranker: config.reranker,
    vectorChunking: config.vectorChunking,
    getCachedAutoSearch: getSessionCachedAutoSearch,
    resolveSessionId: (context, payload) => resolveSessionId(context, payload),
    normalizeIncomingMessage,
    setSessionAutoSearchCache,
    defaultAutoSync: config.autoSync ?? true,
    autoReflect: config.autoReflect ?? false,
    logger,
  });
  return memoryEngine;
}

function normalizeToolNameList(input: unknown): string[] {
  if (!input) return [];
  if (Array.isArray(input)) {
    const names = input
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (item && typeof item === "object") {
          const name = firstString([(item as Record<string, unknown>).name]);
          return name || "";
        }
        return "";
      })
      .filter(Boolean);
    return [...new Set(names)].sort();
  }
  if (typeof input === "object") {
    return Object.keys(input as Record<string, unknown>).sort();
  }
  return [];
}

async function getApiVisibleToolNames(): Promise<string[]> {
  if (!api) return [];
  const apiObj = api as any;
  const readers: Array<() => unknown> = [];
  if (typeof apiObj.listTools === "function") {
    readers.push(() => apiObj.listTools());
  }
  if (typeof apiObj.getTools === "function") {
    readers.push(() => apiObj.getTools());
  }
  if (typeof apiObj.tools === "object" && apiObj.tools !== null) {
    readers.push(() => apiObj.tools);
  }
  if (typeof apiObj.registeredTools === "object" && apiObj.registeredTools !== null) {
    readers.push(() => apiObj.registeredTools);
  }
  for (const read of readers) {
    try {
      const value = await Promise.resolve(read());
      const names = normalizeToolNameList(value);
      if (names.length > 0) {
        return names;
      }
    } catch (error) {
      logger.debug(`Failed to read visible tools from API: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return [];
}

async function withToolVisibilityDiagnostics(result: ToolResult, context?: ToolContext): Promise<ToolResult> {
  if (!result.success || !result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
    return result;
  }
  const visible = await getApiVisibleToolNames();
  const registered = [...registeredTools].sort();
  const missingFromVisibility = registered.filter((name) => !visible.includes(name));
  const data = result.data as Record<string, unknown>;
  return {
    ...result,
    data: {
      ...data,
      tool_visibility: {
        lane_context: {
          agent_id: context?.agentId || "unknown-agent",
          session_id: context?.sessionId || null,
          workspace_id: context?.workspaceId || "default",
        },
        registered_tools: registered,
        api_visible_tools: visible,
        missing_from_visible: missingFromVisibility,
      },
    },
  };
}

function clearStaleAutoSearchCache(now: number = Date.now()): void {
  for (const [sessionId, cache] of autoSearchCacheBySession.entries()) {
    if ((now - cache.timestamp) >= AUTO_SEARCH_CACHE_TTL) {
      autoSearchCacheBySession.delete(sessionId);
    }
  }
}

function setSessionAutoSearchCache(sessionId: string, query: string, results: unknown[]): void {
  const now = Date.now();
  clearStaleAutoSearchCache(now);
  autoSearchCacheBySession.set(sessionId, {
    sessionId,
    query,
    results,
    timestamp: now,
  });
  if (autoSearchCacheBySession.size > MAX_AUTO_SEARCH_CACHE_SESSIONS) {
    const oldest = [...autoSearchCacheBySession.values()].sort((a, b) => a.timestamp - b.timestamp)[0];
    if (oldest) {
      autoSearchCacheBySession.delete(oldest.sessionId);
    }
  }
}

function createConsoleLogger(): Logger {
  return {
    debug: (message: string, ...args: unknown[]) => console.debug(`[CortexMemory] ${message}`, ...args),
    info: (message: string, ...args: unknown[]) => console.log(`[CortexMemory] ${message}`, ...args),
    warn: (message: string, ...args: unknown[]) => console.warn(`[CortexMemory] ${message}`, ...args),
    error: (message: string, ...args: unknown[]) => console.error(`[CortexMemory] ${message}`, ...args),
  };
}

function toTextContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncateForLog(value: string, maxChars: number = TOOL_TRACE_PAYLOAD_MAX_CHARS): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...<truncated>`;
}

function formatUnknownForLog(value: unknown): string {
  if (typeof value === "string") {
    return truncateForLog(value);
  }
  try {
    return truncateForLog(JSON.stringify(value));
  } catch {
    return truncateForLog(String(value));
  }
}

function createToolTraceId(toolName: string): string {
  return `${toolName}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function toAgentToolResult(result: ToolResult, traceId?: string): AgentToolResultPayload {
  if (!result.success) {
    const errorText = result.error || "Tool execution failed";
    return {
      content: [{ type: "text", text: errorText }],
      details: {
        status: "error",
        error: errorText,
        ...(traceId ? { traceId } : {}),
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      },
    };
  }
  const payloadText = toTextContent(result.data ?? { ok: true });
  const detailsData =
    result.data && typeof result.data === "object" && !Array.isArray(result.data)
      ? (result.data as Record<string, unknown>)
      : { value: result.data ?? null };
  return {
    content: [{ type: "text", text: payloadText }],
    details: {
      status: "ok",
      ...(traceId ? { traceId } : {}),
      ...detailsData,
    },
  };
}

function sanitizeForLogging(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.some(k => key.toUpperCase().includes(k))) {
      result[key] = "***REDACTED***";
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      result[key] = sanitizeForLogging(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function findProjectRoot(): string {
  let dir = __dirname;
  while (dir !== path.dirname(dir)) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

function resolveSessionId(context: ToolContext, payload?: unknown): string {
  const contextObj = (context || {}) as unknown as Record<string, unknown>;
  const payloadObj = (payload || {}) as Record<string, unknown>;
  const candidates = [
    contextObj.sessionId,
    contextObj.session_id,
    payloadObj.sessionId,
    payloadObj.session_id,
    payloadObj.id,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) {
      return c.trim();
    }
  }
  return `fallback:${Date.now().toString(36)}`;
}

function normalizeIncomingMessage(payload: unknown): { text: string; role: string; source: string } | null {
  const p = payload as Record<string, unknown>;
  const text = typeof p.text === "string" ? p.text : (typeof p.content === "string" ? p.content : "");
  if (!text) return null;
  const role = typeof p.role === "string" ? p.role : "unknown";
  const source = typeof p.source === "string" ? p.source : "unknown";
  return { text, role, source };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }
  return null;
}

function firstString(values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) {
      return v.trim();
    }
  }
  return undefined;
}

function validateConfig(cfg: CortexMemoryConfig): string[] {
  const errors: string[] = [];
  if (!cfg.embedding?.provider) {
    errors.push("embedding.provider is required.");
  }
  if (!cfg.embedding?.model) {
    errors.push("embedding.model is required.");
  }
  if (!cfg.llm?.provider) {
    errors.push("llm.provider is required.");
  }
  if (!cfg.llm?.model) {
    errors.push("llm.model is required.");
  }
  if (cfg.autoReflectIntervalMinutes !== undefined) {
    if (!Number.isFinite(cfg.autoReflectIntervalMinutes) || cfg.autoReflectIntervalMinutes < 5) {
      errors.push("autoReflectIntervalMinutes must be >= 5.");
    }
  }
  if (cfg.graphQualityMode !== undefined) {
    if (!["off", "warn", "strict"].includes(cfg.graphQualityMode)) {
      errors.push("graphQualityMode must be one of: off, warn, strict.");
    }
  }
  if (cfg.wikiProjection?.mode !== undefined) {
    if (!["off", "incremental", "rebuild"].includes(cfg.wikiProjection.mode)) {
      errors.push("wikiProjection.mode must be one of: off, incremental, rebuild.");
    }
  }
  if (cfg.wikiProjection?.maxBatch !== undefined) {
    if (!Number.isFinite(cfg.wikiProjection.maxBatch) || cfg.wikiProjection.maxBatch < 1) {
      errors.push("wikiProjection.maxBatch must be >= 1.");
    }
  }
  if (cfg.readFusion?.channelWeights) {
    const weights = cfg.readFusion.channelWeights;
    for (const [key, value] of Object.entries(weights)) {
      if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) {
        errors.push(`readFusion.channelWeights.${key} must be >= 0.`);
      }
    }
  }
  if (cfg.readFusion?.channelTopK) {
    const topK = cfg.readFusion.channelTopK;
    for (const [key, value] of Object.entries(topK)) {
      if (typeof value === "number" && (!Number.isFinite(value) || value < 1)) {
        errors.push(`readFusion.channelTopK.${key} must be >= 1.`);
      }
    }
  }
  if (cfg.vectorChunking?.chunkSize !== undefined) {
    if (!Number.isFinite(cfg.vectorChunking.chunkSize) || cfg.vectorChunking.chunkSize < 100) {
      errors.push("vectorChunking.chunkSize must be >= 100.");
    }
  }
  if (cfg.vectorChunking?.chunkOverlap !== undefined) {
    if (!Number.isFinite(cfg.vectorChunking.chunkOverlap) || cfg.vectorChunking.chunkOverlap < 0) {
      errors.push("vectorChunking.chunkOverlap must be >= 0.");
    }
  }
  if (cfg.vectorChunking?.evidenceMaxChunks !== undefined) {
    if (!Number.isFinite(cfg.vectorChunking.evidenceMaxChunks) || cfg.vectorChunking.evidenceMaxChunks < 0) {
      errors.push("vectorChunking.evidenceMaxChunks must be >= 0.");
    }
  }
  if (cfg.writePolicy) {
    const wp = cfg.writePolicy;
    const bounded01 = ["archiveMinConfidence", "archiveMinQualityScore", "activeMinQualityScore"] as const;
    for (const key of bounded01) {
      const value = wp[key];
      if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) {
        errors.push(`writePolicy.${key} must be between 0 and 1.`);
      }
    }
    if (wp.activeDedupTailLines !== undefined && (!Number.isFinite(wp.activeDedupTailLines) || wp.activeDedupTailLines < 20)) {
      errors.push("writePolicy.activeDedupTailLines must be >= 20.");
    }
    if (wp.activeTextMaxChars !== undefined && (!Number.isFinite(wp.activeTextMaxChars) || wp.activeTextMaxChars < 500)) {
      errors.push("writePolicy.activeTextMaxChars must be >= 500.");
    }
    if (wp.archiveSourceTextMaxChars !== undefined && (!Number.isFinite(wp.archiveSourceTextMaxChars) || wp.archiveSourceTextMaxChars < 1000)) {
      errors.push("writePolicy.archiveSourceTextMaxChars must be >= 1000.");
    }
  }
  if (cfg.syncPolicy && cfg.syncPolicy.includeLocalActiveInput !== undefined) {
    if (typeof cfg.syncPolicy.includeLocalActiveInput !== "boolean") {
      errors.push("syncPolicy.includeLocalActiveInput must be boolean.");
    }
  }
  if (cfg.memoryDecay) {
    if (typeof cfg.memoryDecay.minFloor === "number" && (!Number.isFinite(cfg.memoryDecay.minFloor) || cfg.memoryDecay.minFloor < 0 || cfg.memoryDecay.minFloor > 1)) {
      errors.push("memoryDecay.minFloor must be between 0 and 1.");
    }
    if (typeof cfg.memoryDecay.defaultHalfLifeDays === "number" && (!Number.isFinite(cfg.memoryDecay.defaultHalfLifeDays) || cfg.memoryDecay.defaultHalfLifeDays <= 0)) {
      errors.push("memoryDecay.defaultHalfLifeDays must be > 0.");
    }
    if (cfg.memoryDecay.antiDecay) {
      const anti = cfg.memoryDecay.antiDecay;
      if (typeof anti.maxBoost === "number" && (!Number.isFinite(anti.maxBoost) || anti.maxBoost < 1)) {
        errors.push("memoryDecay.antiDecay.maxBoost must be >= 1.");
      }
      if (typeof anti.hitWeight === "number" && (!Number.isFinite(anti.hitWeight) || anti.hitWeight < 0)) {
        errors.push("memoryDecay.antiDecay.hitWeight must be >= 0.");
      }
      if (typeof anti.recentWindowDays === "number" && (!Number.isFinite(anti.recentWindowDays) || anti.recentWindowDays <= 0)) {
        errors.push("memoryDecay.antiDecay.recentWindowDays must be > 0.");
      }
    }
  }
  if (cfg.readTuning) {
    const numericReadTuningFields: Array<[string, number | undefined, number]> = [
      ["readTuning.scoring.lexicalWeight", cfg.readTuning.scoring?.lexicalWeight, 0],
      ["readTuning.scoring.bm25Scale", cfg.readTuning.scoring?.bm25Scale, 0],
      ["readTuning.scoring.semanticWeight", cfg.readTuning.scoring?.semanticWeight, 0],
      ["readTuning.scoring.recencyWeight", cfg.readTuning.scoring?.recencyWeight, 0],
      ["readTuning.scoring.qualityWeight", cfg.readTuning.scoring?.qualityWeight, 0],
      ["readTuning.scoring.typeMatchWeight", cfg.readTuning.scoring?.typeMatchWeight, 0],
      ["readTuning.scoring.graphMatchWeight", cfg.readTuning.scoring?.graphMatchWeight, 0],
      ["readTuning.rrf.k", cfg.readTuning.rrf?.k, 1],
      ["readTuning.rrf.weight", cfg.readTuning.rrf?.weight, 0],
      ["readTuning.autoContext.queryMaxChars", cfg.readTuning.autoContext?.queryMaxChars, 20],
    ];
    for (const [name, value, min] of numericReadTuningFields) {
      if (typeof value === "number" && (!Number.isFinite(value) || value < min)) {
        errors.push(`${name} must be >= ${min}.`);
      }
    }
    if (Array.isArray(cfg.readTuning.recency?.buckets)) {
      const buckets = cfg.readTuning.recency.buckets;
      for (let i = 0; i < buckets.length; i += 1) {
        const bucket = buckets[i];
        const maxAgeHours = bucket.maxAgeHours;
        const finiteOrInfinity = Number.isFinite(maxAgeHours) || maxAgeHours === Number.POSITIVE_INFINITY;
        if (!finiteOrInfinity || maxAgeHours <= 0) {
          errors.push(`readTuning.recency.buckets[${i}].maxAgeHours must be > 0.`);
        }
        if (!Number.isFinite(bucket.score) || bucket.score < 0) {
          errors.push(`readTuning.recency.buckets[${i}].score must be >= 0.`);
        }
        if (!Number.isFinite(bucket.bonus) || bucket.bonus < 0) {
          errors.push(`readTuning.recency.buckets[${i}].bonus must be >= 0.`);
        }
      }
    }
  }
  return errors;
}

function checkOpenClawVersion(): Promise<void> {
  return new Promise((resolve) => {
    try {
      const apiObj = api as any;
      const candidates: Array<{ source: string; value: string }> = [
        { source: "api.openclawVersion", value: apiObj?.openclawVersion },
        { source: "api.gatewayVersion", value: apiObj?.gatewayVersion },
        { source: "api.coreVersion", value: apiObj?.coreVersion },
        { source: "api.openclaw.version", value: apiObj?.openclaw?.version },
      ].filter((item): item is { source: string; value: string } =>
        typeof item.value === "string" && item.value.trim().length > 0,
      );
      const selected = candidates.find((item) => {
        const value = item.value;
        const major = Number(value.replace(/[^0-9.]/g, "").split(".")[0] || "0");
        // OpenClaw release versions are calendar-like (e.g. 2026.x.x),
        // while plugin/package versions like 0.x should be ignored.
        return Number.isFinite(major) && major >= 2000;
      });
      const version = selected?.value || "";
      if (!version) {
        logger.debug("Could not determine OpenClaw gateway/core version from API fields; skip compatibility check");
        resolve();
        return;
      }
      const parseVersion = (v: string): number[] => {
        const parts = v.replace(/[^0-9.]/g, "").split(".").map(Number);
        return parts.length >= 3 ? parts : [...parts, ...Array(3 - parts.length).fill(0)];
      };
      const current = parseVersion(version);
      const min = parseVersion(MIN_OPENCLAW_GATEWAY_VERSION);
      const max = parseVersion(MAX_OPENCLAW_GATEWAY_VERSION);
      const currentNum = current[0] * 10000 + current[1] * 100 + current[2];
      const minNum = min[0] * 10000 + min[1] * 100 + min[2];
      const maxNum = max[0] * 10000 + max[1] * 100 + max[2];
      if (currentNum < minNum) {
        logger.warn(
          `OpenClaw gateway/core version ${version} (from ${selected?.source || "unknown"}) is below minimum ${MIN_OPENCLAW_GATEWAY_VERSION}. Some features may not work.`,
        );
      } else if (currentNum >= maxNum) {
        logger.warn(
          `OpenClaw gateway/core version ${version} (from ${selected?.source || "unknown"}) may not be fully compatible. Maximum tested version is ${MAX_OPENCLAW_GATEWAY_VERSION}.`,
        );
      }
    } catch (e) {
      logger.warn(`Version check failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    resolve();
  });
}

function findOpenClawConfig(): string | null {
  const explicitPath = getEnvValue("OPENCLAW_CONFIG_PATH");
  if (explicitPath && fs.existsSync(explicitPath)) {
    return explicitPath;
  }
  const stateDir = getEnvValue("OPENCLAW_STATE_DIR");
  if (stateDir) {
    const stateConfig = path.join(stateDir, "openclaw.json");
    if (fs.existsSync(stateConfig)) {
      return stateConfig;
    }
  }
  const basePath = getEnvValue("OPENCLAW_BASE_PATH");
  if (basePath) {
    const baseConfig = path.join(basePath, "openclaw.json");
    if (fs.existsSync(baseConfig)) {
      return baseConfig;
    }
  }
  const home = getHomeDir();
  const candidates = [
    path.join(home, ".openclaw", "openclaw.json"),
    path.join(home, ".openclaw", "config.json"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }
  return null;
}

function loadPluginEnabledState(): boolean {
  try {
    if (!configPath) return true;
    const raw = fs.readFileSync(configPath, "utf-8");
    const cfg = JSON.parse(raw);
    const entry = cfg?.plugins?.entries?.[PLUGIN_ID];
    if (entry && typeof entry.enabled === "boolean") {
      return entry.enabled;
    }
    const allow = cfg?.plugins?.allow;
    if (Array.isArray(allow)) {
      return allow.includes(PLUGIN_ID);
    }
    return true;
  } catch {
    return true;
  }
}

function startConfigWatcher(): void {
  if (configWatchInterval) {
    clearInterval(configWatchInterval);
  }
  configWatchInterval = setInterval(() => {
    try {
      if (!configPath || !fs.existsSync(configPath)) return;
      const currentEnabled = loadPluginEnabledState();
      if (currentEnabled !== isEnabled) {
        logger.info(`Plugin enabled state changed from ${isEnabled} to ${currentEnabled}`);
        if (currentEnabled) {
          enable().catch(e => logger.error(`Failed to enable: ${e}`));
        } else {
          disable().catch(e => logger.error(`Failed to disable: ${e}`));
        }
      }
    } catch (e) {
      logger.debug(`Config watch error: ${e}`);
    }
  }, 5000);
}

function stopConfigWatcher(): void {
  if (configWatchInterval) {
    clearInterval(configWatchInterval);
    configWatchInterval = null;
  }
}

function startAutoReflectScheduler(): void {
  if (!config?.autoReflect) {
    return;
  }
  const intervalMinutes = Math.max(5, config.autoReflectIntervalMinutes ?? 30);
  if (autoReflectInterval) {
    clearInterval(autoReflectInterval);
  }
  lastAutoReflectArchiveMarker = getArchiveMarker();
  lastAutoReflectRunAt = Date.now();
  autoReflectInterval = setInterval(async () => {
    if (!isEnabled) return;
    const currentMarker = getArchiveMarker();
    if (currentMarker !== lastAutoReflectArchiveMarker) {
      lastAutoReflectArchiveMarker = currentMarker;
      try {
        const result = await resolveEngine().reflectMemory({}, { agentId: "scheduler", workspaceId: "default" });
        if (result.success) {
          logger.info("Auto-reflect completed successfully");
        } else {
          logger.warn(`Auto-reflect failed: ${result.error}`);
        }
      } catch (e) {
        logger.error(`Auto-reflect error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }, intervalMinutes * 60 * 1000);
  logger.info(`Auto-reflect scheduler started (interval: ${intervalMinutes} minutes)`);
}

function stopAutoReflectScheduler(): void {
  if (autoReflectInterval) {
    clearInterval(autoReflectInterval);
    autoReflectInterval = null;
  }
}

function logLifecycle(event: string, data?: Record<string, unknown>): void {
  logger.info(`[Lifecycle] ${event}${data ? `: ${JSON.stringify(sanitizeForLogging(data))}` : ""}`);
}

async function onMessageHandler(payload: unknown, context: ToolContext): Promise<void> {
  const sessionId = resolveSessionId(context, payload);
  if (isInternalSession(sessionId)) {
    return;
  }
  await runWithTimeout(resolveEngine().onMessage(payload, context), HOOK_GUARD_TIMEOUT_MS, "onMessage hook");
}

async function onSessionEndHandler(payload: unknown, context: ToolContext): Promise<void> {
  const sessionId = resolveSessionId(context, payload);
  if (isInternalSession(sessionId)) {
    return;
  }
  await runWithTimeout(resolveEngine().onSessionEnd(payload, context), HOOK_GUARD_TIMEOUT_MS, "onSessionEnd hook");
}

async function onTimerHandler(payload: unknown, context: ToolContext): Promise<void> {
  await resolveEngine().onTimer(payload, context);
}

function registerTools(): void {
  if (!api) return;
  const apiObj = api as any;
  logger.info(
    `registerTools API capability: registerTool=${typeof apiObj.registerTool === "function"}, registerTools=${typeof apiObj.registerTools === "function"}, tools.register=${typeof apiObj.tools?.register === "function"}`,
  );

  const tools: RegisteredToolDefinition[] = [
    {
      name: "search_memory",
      description: "Search long-term memory for relevant information",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          top_k: { type: "integer", description: "Number of results to return" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      execute: async (params: { args?: Record<string, unknown>; context: ToolContext }) => {
        logger.info(`search_memory execute called with params: ${JSON.stringify(params)}`);
        logger.info(`params.args: ${JSON.stringify(params.args)}`);
        const args = params.args || params;
        logger.info(`args after extraction: ${JSON.stringify(args)}`);
        return resolveEngine().searchMemory(args as { query: string; top_k?: number }, params.context);
      },
    },
    {
      name: "store_event",
      description: "Store a new event in memory",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Event summary" },
          cause: { type: "string", description: "What triggered the event (task/request/problem statement)" },
          process: { type: "string", description: "How the task was handled (steps/attempts/iterations)" },
          result: { type: "string", description: "Final result and acceptance outcome" },
          entities: { 
            type: "array", 
            description: "Involved entities",
            items: {
              oneOf: [
                { type: "string" },
                {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    name: { type: "string" },
                    type: { type: "string" },
                  },
                  additionalProperties: false,
                },
              ],
            },
          },
          entity_types: {
            type: "object",
            description: "Entity type map, key is entity name and value is type",
            additionalProperties: { type: "string" },
          },
          outcome: { type: "string", description: "Event outcome" },
          relations: { 
            type: "array", 
            description: "Entity relationships",
            items: {
              oneOf: [
                { type: "string" },
                {
                  type: "object",
                  properties: {
                    source: { type: "string" },
                    target: { type: "string" },
                    type: { type: "string" },
                    evidence_span: { type: "string" },
                    confidence: { type: "number" },
                  },
                  required: ["source", "target"],
                  additionalProperties: false,
                },
              ],
            }
          },
        },
        required: ["summary"],
        additionalProperties: false,
      },
      execute: async (params: { args?: Record<string, unknown>; context: ToolContext }) => {
        const args = params.args || params;
        return resolveEngine().storeEvent(args as {
          summary: string;
          cause?: string;
          process?: string;
          result?: string;
          entities?: Array<{ id?: string; name?: string; type?: string }>;
          entity_types?: Record<string, string>;
          outcome?: string;
          relations?: Array<{ source: string; target: string; type: string }>;
        }, params.context);
      },
    },
    {
      name: "query_graph",
      description: "Query memory graph for entity relationships",
      parameters: {
        type: "object",
        properties: {
          entity: { type: "string", description: "Entity name" },
          rel: { type: "string", description: "Optional relation type filter" },
          dir: {
            type: "string",
            description: "Relation direction filter",
            enum: ["incoming", "outgoing", "both"],
          },
          path_to: { type: "string", description: "Find path from entity to this target entity" },
          max_depth: { type: "integer", description: "Path query max depth (2~4)" },
        },
        required: ["entity"],
        additionalProperties: false,
      },
      execute: async (params: { args?: Record<string, unknown>; context: ToolContext }) => {
        const args = params.args || params;
        return resolveEngine().queryGraph(args as {
          entity: string;
          rel?: string;
          dir?: "incoming" | "outgoing" | "both";
          path_to?: string;
          max_depth?: number;
        }, params.context);
      },
    },
    {
      name: "export_graph_view",
      description: "Export status-aware graph view and optionally write wiki graph snapshots",
      parameters: {
        type: "object",
        properties: {
          write_snapshot: {
            type: "boolean",
            description: "When true (default), write wiki/graph/view.json, timeline.jsonl and Mermaid network snapshots",
          },
        },
        required: [],
        additionalProperties: false,
      },
      execute: async (params: { args?: Record<string, unknown>; context: ToolContext }) => {
        const args = params.args || params;
        return resolveEngine().exportGraphView(args as {
          write_snapshot?: boolean;
        }, params.context);
      },
    },
    {
      name: "lint_memory_wiki",
      description: "Run wiki memory lint checks and return structured repair guidance",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      execute: async (params: { args?: Record<string, unknown>; context: ToolContext }) => {
        const args = params.args || params;
        return resolveEngine().lintMemoryWiki(args as Record<string, unknown>, params.context);
      },
    },
    {
      name: "list_graph_conflicts",
      description: "List pending/handled graph memory conflicts that require user confirmation",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["pending", "accepted", "rejected", "all"],
            description: "Filter conflict status",
          },
          limit: { type: "integer", description: "Maximum returned conflicts" },
        },
        required: [],
        additionalProperties: false,
      },
      execute: async (params: { args?: Record<string, unknown>; context: ToolContext }) => {
        const args = params.args || params;
        return resolveEngine().listGraphConflicts(args as {
          status?: "pending" | "accepted" | "rejected" | "all";
          limit?: number;
        }, params.context);
      },
    },
    {
      name: "resolve_graph_conflict",
      description: "Resolve a graph conflict by accepting or rejecting the new candidate fact",
      parameters: {
        type: "object",
        properties: {
          conflict_id: { type: "string", description: "Conflict ID from list_graph_conflicts" },
          action: { type: "string", enum: ["accept", "reject"], description: "Resolution action" },
          note: { type: "string", description: "Optional note for audit trail" },
        },
        required: ["conflict_id", "action"],
        additionalProperties: false,
      },
      execute: async (params: { args?: Record<string, unknown>; context: ToolContext }) => {
        const args = params.args || params;
        return resolveEngine().resolveGraphConflict(args as {
          conflict_id: string;
          action: "accept" | "reject";
          note?: string;
        }, params.context);
      },
    },
    {
      name: "get_hot_context",
      description: "Get hot memory context for current session",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "Maximum number of hot context items" }
        },
        required: [],
        additionalProperties: false,
      },
      execute: async (params: { args?: Record<string, unknown>; context: ToolContext }) => {
        const args = params.args || params;
        return resolveEngine().getHotContext(args as { limit?: number }, params.context);
      },
    },
    {
      name: "get_auto_context",
      description: "Get relevant memories based on recent messages",
      parameters: {
        type: "object",
        properties: { 
          include_hot: { type: "boolean", description: "Include hot context" }
        },
        required: [],
        additionalProperties: false,
      },
      execute: async (params: { args?: Record<string, unknown>; context: ToolContext }) => {
        const args = params.args || params;
        return resolveEngine().getAutoContext(args as { include_hot?: boolean }, params.context);
      },
    },
    {
      name: "reflect_memory",
      description: "Convert events into semantic knowledge",
      parameters: { 
        type: "object", 
        properties: {},
        required: [],
        additionalProperties: false,
      },
      execute: async (params: { args?: Record<string, unknown>; context: ToolContext }) => {
        const args = params.args || params;
        return resolveEngine().reflectMemory(args, params.context);
      },
    },
    {
      name: "sync_memory",
      description: "Import historical session data into memory",
      parameters: { 
        type: "object", 
        properties: {},
        required: [],
        additionalProperties: false,
      },
      execute: async (params: { args?: Record<string, unknown>; context: ToolContext }) => {
        const args = params.args || params;
        return resolveEngine().syncMemory(args, params.context);
      },
    },
    {
      name: "backfill_embeddings",
      description: "Backfill missing embeddings for active/archive records",
      parameters: {
        type: "object",
        properties: {
          layer: { type: "string", enum: ["active", "archive", "all"], description: "Target layer to backfill" },
          batch_size: { type: "integer", description: "Batch size per processing window" },
          max_retries: { type: "integer", description: "Max retry count for failed records" },
          retry_failed_only: { type: "boolean", description: "Only retry failed records" },
          rebuild_mode: { type: "string", enum: ["incremental", "vector_only", "full"], description: "Rebuild mode" },
        },
        required: [],
        additionalProperties: false,
      },
      execute: async (params: { args?: Record<string, unknown>; context: ToolContext }) => {
        const args = params.args || params;
        return resolveEngine().backfillEmbeddings(args as {
          layer?: "active" | "archive" | "all";
          batch_size?: number;
          max_retries?: number;
          retry_failed_only?: boolean;
          rebuild_mode?: "incremental" | "vector_only" | "full";
        }, params.context);
      },
    },
    {
      name: "delete_memory",
      description: "Delete a memory by ID",
      parameters: {
        type: "object",
        properties: { 
          memory_id: { type: "string", description: "Memory ID" } 
        },
        required: ["memory_id"],
        additionalProperties: false,
      },
      execute: async (params: { args?: Record<string, unknown>; context: ToolContext }) => {
        const args = params.args || params;
        return resolveEngine().deleteMemory(args as { memory_id: string }, params.context);
      },
    },
    {
      name: TOOL_NAME_CORTEX_DIAGNOSTICS,
      description: "Check memory system status",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      execute: async (params: { args?: Record<string, unknown>; context: ToolContext }) => {
        const args = params.args || params;
        const result = await resolveEngine().runDiagnostics(args, params.context);
        return withToolVisibilityDiagnostics(result, params.context);
      },
    },
    {
      name: TOOL_NAME_DIAGNOSTICS_LEGACY,
      description: "Legacy alias for cortex_diagnostics",
      optional: true,
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      execute: async (params: { args?: Record<string, unknown>; context: ToolContext }) => {
        const args = params.args || params;
        const result = await resolveEngine().runDiagnostics(args, params.context);
        return withToolVisibilityDiagnostics(result, params.context);
      },
    },
  ];

  let successCount = 0;
  for (const tool of tools) {
    try {
      registerToolCompat(tool);
      registeredTools.push(tool.name);
      successCount += 1;
    } catch (error) {
      logger.error(`Failed to register tool ${tool.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  logger.info(`registerTools completed: ${successCount}/${tools.length} tools registered`);
}

function sanitizeToolParametersSchemaValue(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return {};
  }
  const source = schema as Record<string, unknown>;
  const target: Record<string, unknown> = {};
  if (typeof source.type === "string") {
    target.type = source.type;
  }
  if (typeof source.description === "string" && source.description.trim()) {
    target.description = source.description;
  }
  if (Array.isArray(source.enum)) {
    const values = source.enum.filter(item =>
      typeof item === "string" || typeof item === "number" || typeof item === "boolean" || item === null,
    );
    if (values.length > 0) {
      target.enum = values;
    }
  }
  if (source.properties && typeof source.properties === "object" && !Array.isArray(source.properties)) {
    const sanitizedProperties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source.properties as Record<string, unknown>)) {
      sanitizedProperties[key] = sanitizeToolParametersSchemaValue(value);
    }
    target.properties = sanitizedProperties;
  }
  if (Array.isArray(source.required)) {
    const required = source.required.filter(item => typeof item === "string");
    if (required.length > 0) {
      target.required = required;
    }
  }
  if (source.items && typeof source.items === "object" && !Array.isArray(source.items)) {
    target.items = sanitizeToolParametersSchemaValue(source.items);
  }
  if (typeof source.additionalProperties === "boolean") {
    target.additionalProperties = source.additionalProperties;
  } else if (source.additionalProperties && typeof source.additionalProperties === "object") {
    target.additionalProperties = true;
  }
  return target;
}

function sanitizeToolParametersSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeToolParametersSchemaValue(schema);
  if (sanitized.type !== "object") {
    sanitized.type = "object";
  }
  if (!sanitized.properties || typeof sanitized.properties !== "object" || Array.isArray(sanitized.properties)) {
    sanitized.properties = {};
  }
  if (!Array.isArray(sanitized.required)) {
    sanitized.required = [];
  }
  if (typeof sanitized.additionalProperties !== "boolean") {
    sanitized.additionalProperties = false;
  }
  return sanitized;
}

function registerToolCompat(tool: RegisteredToolDefinition): void {
  if (!api) return;
  const normalizeContext = (value: unknown): ToolContext => {
    const contextObj = asRecord(value) || {};
    return {
      agentId: firstString([contextObj.agentId, contextObj.agent_id]) || "unknown-agent",
      workspaceId: firstString([contextObj.workspaceId, contextObj.workspace_id]) || "default",
      sessionId: firstString([contextObj.sessionId, contextObj.session_id]) || undefined,
    };
  };
  const normalizeInvocation = (...params: unknown[]): { args: Record<string, unknown>; context: ToolContext } => {
    logger.info(`normalizeInvocation called with params: ${JSON.stringify(params)}`);
    
    if (params.length === 1) {
      const first = params[0];
      const firstObj = asRecord(first);
      if (firstObj && ("context" in firstObj || "args" in firstObj)) {
        const explicitArgs = asRecord(firstObj.args);
        if (explicitArgs) {
          logger.info(`normalizeInvocation: single param with explicit args: ${JSON.stringify(explicitArgs)}`);
          return {
            args: explicitArgs,
            context: normalizeContext(firstObj.context),
          };
        }
        const directArgs = { ...firstObj };
        delete directArgs.context;
        delete directArgs.args;
        logger.info(`normalizeInvocation: single param with direct args: ${JSON.stringify(directArgs)}`);
        return {
          args: directArgs,
          context: normalizeContext(firstObj.context),
        };
      }
      if (firstObj) {
        logger.info(`normalizeInvocation: single param as args: ${JSON.stringify(firstObj)}`);
        return {
          args: firstObj,
          context: normalizeContext(undefined),
        };
      }
    }
    
    const first = params[0];
    const second = params[1];
    const third = params[2];
    
    const firstObj = asRecord(first);
    const secondObj = asRecord(second);
    
    if (typeof first === "string" && secondObj) {
      logger.info(`normalizeInvocation: first is string (tool call ID), second is args: ${JSON.stringify(secondObj)}`);
      return {
        args: secondObj,
        context: normalizeContext(third),
      };
    }
    
    if (firstObj && ("context" in firstObj || "args" in firstObj)) {
      const explicitArgs = asRecord(firstObj.args);
      if (explicitArgs) {
        logger.info(`normalizeInvocation: first has explicit args: ${JSON.stringify(explicitArgs)}`);
        return {
          args: explicitArgs,
          context: normalizeContext(firstObj.context),
        };
      }
      const directArgs = { ...firstObj };
      delete directArgs.context;
      delete directArgs.args;
      logger.info(`normalizeInvocation: first has direct args: ${JSON.stringify(directArgs)}`);
      return {
        args: directArgs,
        context: normalizeContext(firstObj.context),
      };
    }
    
    if (firstObj && Object.keys(firstObj).length > 0) {
      logger.info(`normalizeInvocation: first is args, second is context: ${JSON.stringify(firstObj)}`);
      return {
        args: firstObj,
        context: normalizeContext(second),
      };
    }
    
    logger.info(`normalizeInvocation: fallback to firstObj as args: ${JSON.stringify(firstObj)}`);
    return {
      args: firstObj || {},
      context: normalizeContext(second),
    };
  };
  const invoke = async (...params: unknown[]) => {
    const traceId = createToolTraceId(tool.name);
    const startedAt = Date.now();
    logger.info(`[ToolTrace] start traceId=${traceId} tool=${tool.name} paramCount=${params.length}`);
    const normalized = normalizeInvocation(...params);
    logger.debug(
      `[ToolTrace] normalized traceId=${traceId} tool=${tool.name} args=${formatUnknownForLog(sanitizeForLogging(normalized.args))} context=${formatUnknownForLog(sanitizeForLogging(normalized.context as unknown as Record<string, unknown>))}`,
    );
    try {
      const result = await tool.execute({
        args: normalized.args,
        context: normalized.context,
      });
      const durationMs = Date.now() - startedAt;
      logger.info(`[ToolTrace] success traceId=${traceId} tool=${tool.name} durationMs=${durationMs} resultSuccess=${result.success}`);
      if (!result.success) {
        logger.error(
          `[ToolTrace] tool_failure traceId=${traceId} tool=${tool.name} error=${truncateForLog(result.error || "unknown_error")} errorCode=${result.errorCode || "none"} args=${formatUnknownForLog(sanitizeForLogging(normalized.args))}`,
        );
      }
      return toAgentToolResult(result, traceId);
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = toErrorMessage(error);
      logger.error(
        `[ToolTrace] exception traceId=${traceId} tool=${tool.name} durationMs=${durationMs} message=${truncateForLog(message)} args=${formatUnknownForLog(sanitizeForLogging(normalized.args))} context=${formatUnknownForLog(sanitizeForLogging(normalized.context as unknown as Record<string, unknown>))}`,
      );
      if (error instanceof Error && error.stack) {
        logger.error(`[ToolTrace] stack traceId=${traceId} tool=${tool.name} ${truncateForLog(error.stack, 4000)}`);
      }
      return toAgentToolResult(
        {
          success: false,
          error: `Tool execution failed [traceId=${traceId}]: ${message}`,
          errorCode: "TOOL_EXECUTION_EXCEPTION",
        },
        traceId,
      );
    }
  };
  const payload = {
    name: tool.name,
    description: tool.description,
    parameters: sanitizeToolParametersSchema(tool.parameters),
    ...(tool.optional ? { optional: true } : {}),
    execute: invoke,
    handler: invoke,
  };
  const apiObj = api as any;
  if (typeof apiObj.registerTool === "function") {
    if (tool.optional) {
      apiObj.registerTool(payload, { optional: true });
    } else {
      apiObj.registerTool(payload);
    }
    return;
  }
  if (typeof apiObj.registerTools === "function") {
    apiObj.registerTools([payload]);
    return;
  }
  if (typeof apiObj.tools?.register === "function") {
    apiObj.tools.register(payload);
    return;
  }
  throw new Error("No supported tool registration API found");
}

function unregisterTools(): void {
  if (!api || !api.unregisterTool) return;
  
  for (const name of registeredTools) {
    try {
      api.unregisterTool(name);
    } catch (e) {
      logger.warn(`Failed to unregister tool ${name}: ${e}`);
    }
  }
  registeredTools = [];
}

function registerFallbackTools(): void {
  if (!api || !builtinMemory) return;
  
  for (const name of ["search_memory", "store_event", "cortex_memory_status"]) {
    try {
      if (api.unregisterTool) {
        api.unregisterTool(name);
        logger.info(`Unregistered existing tool ${name} before registering fallback`);
      }
    } catch (e) {
      // ignore
    }
  }
  
  registerToolCompat({
    name: "search_memory",
    description: "Search memory (using builtin system - Cortex Memory disabled)",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        top_k: { type: "integer", description: "Number of results" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (params: { args?: Record<string, unknown>; context: ToolContext }) => {
      const args = (params.args || params) as Record<string, unknown>;
      const query = (args.query as string) || "";
      const topK = (args.top_k as number) || 5;
      try {
        const results = await builtinMemory!.search(query, topK);
        return { success: true, data: results };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, error: `Builtin memory error: ${message}` };
      }
    },
  });
  registeredFallbackTools.push("search_memory");
  
  registerToolCompat({
    name: "store_event",
    description: "Store event (using builtin system - Cortex Memory disabled)",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Event summary" },
      },
      required: ["summary"],
      additionalProperties: false,
    },
    execute: async (params: { args?: Record<string, unknown>; context: ToolContext }) => {
      const args = (params.args || params) as Record<string, unknown>;
      const summary = (args.summary as string) || "";
      try {
        const id = await builtinMemory!.store(summary);
        return { success: true, data: { id } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, error: `Builtin memory error: ${message}` };
      }
    },
  });
  registeredFallbackTools.push("store_event");
  
  registerToolCompat({
    name: "cortex_memory_status",
    description: "Get the current status of the Cortex Memory plugin",
    parameters: { 
      type: "object", 
      properties: {},
      required: [],
      additionalProperties: false,
    },
    execute: async (_params: { args?: Record<string, unknown>; context: ToolContext }) => {
      return {
        success: true,
        data: {
          enabled: isEnabled,
          fallback_enabled: config?.fallbackToBuiltin ?? true,
          builtin_memory_available: builtinMemory !== null,
        }
      };
    },
  });
  registeredFallbackTools.push("cortex_memory_status");
  
  logger.info(`Registered ${registeredFallbackTools.length} fallback tools`);
}

function unregisterFallbackTools(): void {
  if (!api || !api.unregisterTool) return;
  for (const name of registeredFallbackTools) {
    try {
      api.unregisterTool(name);
    } catch (e) {
      logger.warn(`Failed to unregister fallback tool ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  registeredFallbackTools = [];
}

function registerHooks(): void {
  if (!api) return;
  
  const hooks = [
    { event: "message_received", handler: onMessageHandler },
    { event: "session_end", handler: onSessionEndHandler },
  ];
  
  for (const hook of hooks) {
    try {
      if (typeof (api as any).on === 'function') {
        (api as any).on(hook.event, hook.handler);
        registeredHooks.push(hook.event);
        registeredHookHandlers.set(hook.event, hook.handler);
      } else if (typeof (api as any).registerHook === "function") {
        (api as any).registerHook({ event: hook.event, handler: hook.handler });
        registeredHooks.push(hook.event);
        registeredHookHandlers.set(hook.event, hook.handler);
      } else {
        logger.warn(`No supported hook registration API found, skipping ${hook.event}`);
      }
    } catch (e) {
      logger.error(`Failed to register hook ${hook.event}: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
  }
}

function unregisterHooks(): void {
  if (!api) return;
  
  for (const event of registeredHooks) {
    try {
      const handler = registeredHookHandlers.get(event);
      if ((api as any).off && handler) {
        (api as any).off(event, handler);
      } else if ((api as any).unregisterHook) {
        (api as any).unregisterHook(event);
      }
    } catch (e) {
      // ignore
    }
  }
  registeredHooks = [];
  registeredHookHandlers.clear();
}

function setupProcessHandlers(): void {
  if (processHandlersRegistered) {
    return;
  }
  processHandlersRegistered = true;
  const gracefulShutdown = (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`Received ${signal}, shutting down...`);
    stopConfigWatcher();
    process.exit(0);
  };

  process.on("exit", () => {
    stopConfigWatcher();
  });
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    logger.error("Uncaught exception:", err.message);
    stopConfigWatcher();
    process.exit(1);
  });
}

export async function enable(): Promise<void> {
  if (isEnabled) {
    logger.info("Cortex Memory plugin is already enabled");
    return;
  }
  
  logger.info("Enabling Cortex Memory plugin...");
  logLifecycle("enable_start");
  
  try {
    unregisterFallbackTools();
    isEnabled = true;
    registerTools();
    registerHooks();
    startAutoReflectScheduler();
    logger.info("Cortex Memory plugin enabled successfully");
    logLifecycle("enable_success", { registeredTools: registeredTools.length, registeredHooks: registeredHooks.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to enable Cortex Memory plugin: ${message}`);
    logLifecycle("enable_failed", { error: message });
    throw error;
  }
}

export async function disable(): Promise<void> {
  if (!isEnabled) {
    logger.info("Cortex Memory plugin is already disabled");
    return;
  }
  
  logger.info("Disabling Cortex Memory plugin...");
  logLifecycle("disable_start");
  
  unregisterHooks();
  unregisterTools();
  stopAutoReflectScheduler();
  isEnabled = false;
  memoryEngine = null;
  
  if (config?.fallbackToBuiltin && builtinMemory) {
    logger.info("Falling back to OpenClaw builtin memory system");
    registerFallbackTools();
    logLifecycle("fallback_enabled", { fallbackTools: registeredFallbackTools.length });
  }
  
  logger.info("Cortex Memory plugin disabled successfully");
  logLifecycle("disable_success", { fallbackEnabled: registeredFallbackTools.length > 0 });
}

export function getStatus(): { enabled: boolean } {
  return {
    enabled: isEnabled
  };
}

export async function unregister(): Promise<void> {
  logger.info("Unregistering Cortex Memory plugin...");
  logLifecycle("unregister_start");
  
  stopConfigWatcher();
  stopAutoReflectScheduler();
  
  unregisterHooks();
  unregisterTools();
  unregisterFallbackTools();
  
  isEnabled = false;
  isInitializing = false;
  isRegistered = false;
  api = null;
  config = null;
  autoSearchCacheBySession.clear();
  memoryEngine = null;
  builtinMemory = null;
  registeredTools = [];
  registeredHooks = [];
  registeredFallbackTools = [];
  registeredHookHandlers.clear();
  configPath = null;
  
  logger.info("Cortex Memory plugin unregistered successfully");
  logLifecycle("unregister_success");
}

export function register(pluginApi: OpenClawPluginApi, userConfig?: Partial<CortexMemoryConfig>): void {
  if (isInitializing || isRegistered) {
    return;
  }
  isInitializing = true;
  
  api = pluginApi;
  
  logger = api.logger || api.getLogger?.() || createConsoleLogger();
  
  const apiPluginConfig = (api as any).pluginConfig || {};
  const openclawConfig = (api as any).config || {};
  const pluginEntry = openclawConfig?.plugins?.entries?.[PLUGIN_ID];
  const pluginConfig = Object.keys(apiPluginConfig).length > 0 ? apiPluginConfig : (pluginEntry?.config || {});
  
  const effectiveConfig = userConfig || pluginConfig || {};
  const resolvedDbPath = resolveConfiguredMemoryRoot(typeof effectiveConfig.dbPath === "string" ? effectiveConfig.dbPath : undefined);
  const embeddingConfigRaw = (effectiveConfig.embedding || { provider: "openai-compatible", model: "" }) as EmbeddingConfig;
  const llmConfigRaw = (effectiveConfig.llm || { provider: "openai", model: "" }) as LLMConfig;
  const rerankerConfigRaw = (effectiveConfig.reranker || { provider: "", model: "" }) as RerankerConfig;
  const embeddingConfig: EmbeddingConfig = {
    ...embeddingConfigRaw,
    baseURL: embeddingConfigRaw.baseURL ?? embeddingConfigRaw.baseUrl,
  };
  const llmConfig: LLMConfig = {
    ...llmConfigRaw,
    baseURL: llmConfigRaw.baseURL ?? llmConfigRaw.baseUrl,
  };
  const rerankerConfig: RerankerConfig = {
    ...rerankerConfigRaw,
    baseURL: rerankerConfigRaw.baseURL ?? rerankerConfigRaw.baseUrl,
  };
  
  config = { 
    embedding: embeddingConfig,
    llm: llmConfig,
    reranker: rerankerConfig,
    dbPath: resolvedDbPath,
    autoSync: effectiveConfig.autoSync ?? defaultConfig.autoSync,
    autoReflect: effectiveConfig.autoReflect ?? defaultConfig.autoReflect,
    autoReflectIntervalMinutes: effectiveConfig.autoReflectIntervalMinutes ?? defaultConfig.autoReflectIntervalMinutes,
    graphQualityMode: effectiveConfig.graphQualityMode ?? defaultConfig.graphQualityMode,
    wikiProjection: {
      enabled: effectiveConfig.wikiProjection?.enabled ?? defaultConfig.wikiProjection?.enabled,
      mode: effectiveConfig.wikiProjection?.mode ?? defaultConfig.wikiProjection?.mode,
      maxBatch: effectiveConfig.wikiProjection?.maxBatch ?? defaultConfig.wikiProjection?.maxBatch,
    },
    readFusion: {
      enabled: effectiveConfig.readFusion?.enabled ?? defaultConfig.readFusion?.enabled,
      maxCandidates: effectiveConfig.readFusion?.maxCandidates ?? defaultConfig.readFusion?.maxCandidates,
      authoritative: effectiveConfig.readFusion?.authoritative ?? defaultConfig.readFusion?.authoritative,
      channelWeights: effectiveConfig.readFusion?.channelWeights ?? defaultConfig.readFusion?.channelWeights,
      channelTopK: effectiveConfig.readFusion?.channelTopK ?? defaultConfig.readFusion?.channelTopK,
      minLexicalHits: effectiveConfig.readFusion?.minLexicalHits ?? defaultConfig.readFusion?.minLexicalHits,
      minSemanticHits: effectiveConfig.readFusion?.minSemanticHits ?? defaultConfig.readFusion?.minSemanticHits,
      lengthNorm: {
        enabled: effectiveConfig.readFusion?.lengthNorm?.enabled ?? defaultConfig.readFusion?.lengthNorm?.enabled,
        pivotChars: effectiveConfig.readFusion?.lengthNorm?.pivotChars ?? defaultConfig.readFusion?.lengthNorm?.pivotChars,
        strength: effectiveConfig.readFusion?.lengthNorm?.strength ?? defaultConfig.readFusion?.lengthNorm?.strength,
        minFactor: effectiveConfig.readFusion?.lengthNorm?.minFactor ?? defaultConfig.readFusion?.lengthNorm?.minFactor,
      },
    },
    vectorChunking: {
      chunkSize: effectiveConfig.vectorChunking?.chunkSize ?? defaultConfig.vectorChunking?.chunkSize,
      chunkOverlap: effectiveConfig.vectorChunking?.chunkOverlap ?? defaultConfig.vectorChunking?.chunkOverlap,
      evidenceMaxChunks: effectiveConfig.vectorChunking?.evidenceMaxChunks ?? defaultConfig.vectorChunking?.evidenceMaxChunks,
    },
    writePolicy: {
      archiveMinConfidence: effectiveConfig.writePolicy?.archiveMinConfidence ?? defaultConfig.writePolicy?.archiveMinConfidence,
      archiveMinQualityScore: effectiveConfig.writePolicy?.archiveMinQualityScore ?? defaultConfig.writePolicy?.archiveMinQualityScore,
      activeMinQualityScore: effectiveConfig.writePolicy?.activeMinQualityScore ?? defaultConfig.writePolicy?.activeMinQualityScore,
      activeDedupTailLines: effectiveConfig.writePolicy?.activeDedupTailLines ?? defaultConfig.writePolicy?.activeDedupTailLines,
      activeTextMaxChars: effectiveConfig.writePolicy?.activeTextMaxChars ?? defaultConfig.writePolicy?.activeTextMaxChars,
      archiveSourceTextMaxChars: effectiveConfig.writePolicy?.archiveSourceTextMaxChars ?? defaultConfig.writePolicy?.archiveSourceTextMaxChars,
    },
    syncPolicy: {
      includeLocalActiveInput: effectiveConfig.syncPolicy?.includeLocalActiveInput ?? defaultConfig.syncPolicy?.includeLocalActiveInput,
    },
    memoryDecay: {
      enabled: effectiveConfig.memoryDecay?.enabled ?? defaultConfig.memoryDecay?.enabled,
      minFloor: effectiveConfig.memoryDecay?.minFloor ?? defaultConfig.memoryDecay?.minFloor,
      defaultHalfLifeDays: effectiveConfig.memoryDecay?.defaultHalfLifeDays ?? defaultConfig.memoryDecay?.defaultHalfLifeDays,
      halfLifeByEventType: effectiveConfig.memoryDecay?.halfLifeByEventType ?? defaultConfig.memoryDecay?.halfLifeByEventType,
      antiDecay: {
        enabled: effectiveConfig.memoryDecay?.antiDecay?.enabled ?? defaultConfig.memoryDecay?.antiDecay?.enabled,
        maxBoost: effectiveConfig.memoryDecay?.antiDecay?.maxBoost ?? defaultConfig.memoryDecay?.antiDecay?.maxBoost,
        hitWeight: effectiveConfig.memoryDecay?.antiDecay?.hitWeight ?? defaultConfig.memoryDecay?.antiDecay?.hitWeight,
        recentWindowDays: effectiveConfig.memoryDecay?.antiDecay?.recentWindowDays ?? defaultConfig.memoryDecay?.antiDecay?.recentWindowDays,
      },
    },
    readTuning: {
      scoring: {
        lexicalWeight: effectiveConfig.readTuning?.scoring?.lexicalWeight ?? defaultConfig.readTuning?.scoring?.lexicalWeight,
        bm25Scale: effectiveConfig.readTuning?.scoring?.bm25Scale ?? defaultConfig.readTuning?.scoring?.bm25Scale,
        semanticWeight: effectiveConfig.readTuning?.scoring?.semanticWeight ?? defaultConfig.readTuning?.scoring?.semanticWeight,
        recencyWeight: effectiveConfig.readTuning?.scoring?.recencyWeight ?? defaultConfig.readTuning?.scoring?.recencyWeight,
        qualityWeight: effectiveConfig.readTuning?.scoring?.qualityWeight ?? defaultConfig.readTuning?.scoring?.qualityWeight,
        typeMatchWeight: effectiveConfig.readTuning?.scoring?.typeMatchWeight ?? defaultConfig.readTuning?.scoring?.typeMatchWeight,
        graphMatchWeight: effectiveConfig.readTuning?.scoring?.graphMatchWeight ?? defaultConfig.readTuning?.scoring?.graphMatchWeight,
      },
      rrf: {
        k: effectiveConfig.readTuning?.rrf?.k ?? defaultConfig.readTuning?.rrf?.k,
        weight: effectiveConfig.readTuning?.rrf?.weight ?? defaultConfig.readTuning?.rrf?.weight,
      },
      recency: {
        buckets: effectiveConfig.readTuning?.recency?.buckets ?? defaultConfig.readTuning?.recency?.buckets,
      },
      autoContext: {
        queryMaxChars: effectiveConfig.readTuning?.autoContext?.queryMaxChars ?? defaultConfig.readTuning?.autoContext?.queryMaxChars,
        lightweightSearch: effectiveConfig.readTuning?.autoContext?.lightweightSearch ?? defaultConfig.readTuning?.autoContext?.lightweightSearch,
      },
    },
    enabled: effectiveConfig.enabled ?? defaultConfig.enabled,
    fallbackToBuiltin: effectiveConfig.fallbackToBuiltin ?? true,
  } as CortexMemoryConfig;
  memoryEngine = null;

  if (api.getBuiltinMemory) {
    try {
      builtinMemory = api.getBuiltinMemory();
      logger.info("OpenClaw builtin memory system available for fallback");
    } catch (e) {
      logger.warn(`Failed to get builtin memory: ${e instanceof Error ? e.message : String(e)}`);
      builtinMemory = null;
    }
  }

  const safeConfig = sanitizeForLogging({
    embedding: { provider: config.embedding.provider, model: config.embedding.model },
    llm: { provider: config.llm.provider, model: config.llm.model },
    reranker: { model: config.reranker.model },
    enabled: config.enabled,
    fallbackToBuiltin: config.fallbackToBuiltin,
  });
  logger.info(`Runtime config snapshot: ${JSON.stringify(safeConfig)}`);

  const configErrors = validateConfig(config);
  if (configErrors.length > 0) {
    logger.warn(`Cortex Memory config validation warnings: ${configErrors.join(" | ")}`);
  }

  checkOpenClawVersion().catch(e => logger.warn(`Version check failed: ${e}`));
  
  configPath = findOpenClawConfig();
  if (configPath) {
    logger.info(`Found OpenClaw config at: ${configPath}`);
  }

  setupProcessHandlers();
  startConfigWatcher();

  const initialEnabled = loadPluginEnabledState();
  isEnabled = config.enabled !== false && initialEnabled;

  isInitializing = false;
  isRegistered = true;
  logger.info("Cortex Memory plugin registered successfully");
  logLifecycle("register_success", {
    enabled: isEnabled,
  });

  if (isEnabled) {
    registerTools();
    registerHooks();
    startAutoReflectScheduler();
  }
}

const pluginEntry = definePluginEntryCompat({
  id: PLUGIN_ID,
  name: "Cortex Memory",
  register,
  unregister,
  enable,
  disable,
  getStatus,
});

export default pluginEntry;
