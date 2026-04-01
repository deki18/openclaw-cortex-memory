/// <reference types="node" />
import * as path from "path";
import * as fs from "fs";
import type { MemoryEngine } from "./src/engine/memory_engine";
import { createTsEngine } from "./src/engine/ts_engine";
import { createReadStore } from "./src/store/read_store";
import { createWriteStore } from "./src/store/write_store";
import { createArchiveStore } from "./src/store/archive_store";
import { createVectorStore } from "./src/store/vector_store";
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
  registerTool(tool: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute?: (params: { args?: Record<string, unknown>; context: ToolContext }) => Promise<ToolResult>;
    handler?: (...params: unknown[]) => Promise<ToolResult>;
  }): void;
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
    suggestion: "Enable the plugin using 'openclaw plugins enable cortex-memory' or check openclaw.json"
  }
};

const SENSITIVE_KEYS = ["API_KEY", "SECRET", "TOKEN", "PASSWORD", "APIKEY"];
const PLUGIN_ID = "openclaw-cortex-memory";

const MIN_OPENCLAW_VERSION = "2026.3.8";
const MAX_OPENCLAW_VERSION = "2027.0.0";

const defaultConfig: Partial<CortexMemoryConfig> = {
  autoSync: true,
  llmRequiredForWrite: true,
  autoReflect: false,
  autoReflectIntervalMinutes: 30,
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
  execute: (params: { args?: Record<string, unknown>; context: ToolContext }) => Promise<ToolResult>;
};

function getMemoryRoot(): string {
  const projectRoot = findProjectRoot();
  return config?.dbPath ? path.resolve(config.dbPath) : path.join(projectRoot, "data", "memory");
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
    deduplicator,
    vectorStore,
  });
  const sessionSync = createSessionSync({
    projectRoot,
    dbPath: config.dbPath,
    logger,
    llm: config.llm,
    requireLlmForWrite: config.llmRequiredForWrite ?? true,
    archiveStore,
    writeStore,
  });
  const sessionEnd = createSessionEnd({
    projectRoot,
    dbPath: config.dbPath,
    logger,
    syncMemory: sessionSync.syncMemory,
    syncDailySummaries: sessionSync.syncDailySummaries,
    archiveStore,
    llm: config.llm,
    requireLlmForWrite: config.llmRequiredForWrite ?? true,
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
  memoryEngine = createTsEngine({
    readStore,
    writeStore,
    vectorStore,
    archiveStore,
    sessionSync,
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
  return errors;
}

function checkOpenClawVersion(): Promise<void> {
  return new Promise((resolve) => {
    try {
      const version = (api as any).openclawVersion || (api as any).version;
      if (!version) {
        logger.warn("Could not determine OpenClaw version");
        resolve();
        return;
      }
      const parseVersion = (v: string): number[] => {
        const parts = v.replace(/[^0-9.]/g, "").split(".").map(Number);
        return parts.length >= 3 ? parts : [...parts, ...Array(3 - parts.length).fill(0)];
      };
      const current = parseVersion(version);
      const min = parseVersion(MIN_OPENCLAW_VERSION);
      const max = parseVersion(MAX_OPENCLAW_VERSION);
      const currentNum = current[0] * 10000 + current[1] * 100 + current[2];
      const minNum = min[0] * 10000 + min[1] * 100 + min[2];
      const maxNum = max[0] * 10000 + max[1] * 100 + max[2];
      if (currentNum < minNum) {
        logger.warn(`OpenClaw version ${version} is below minimum ${MIN_OPENCLAW_VERSION}. Some features may not work.`);
      } else if (currentNum >= maxNum) {
        logger.warn(`OpenClaw version ${version} may not be fully compatible. Maximum tested version is ${MAX_OPENCLAW_VERSION}.`);
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
          entities: { 
            type: "array", 
            description: "Involved entities",
            items: { type: "string" }
          },
          outcome: { type: "string", description: "Event outcome" },
          relations: { 
            type: "array", 
            description: "Entity relationships",
            items: { type: "string" }
          },
        },
        required: ["summary"],
        additionalProperties: false,
      },
      execute: async (params: { args?: Record<string, unknown>; context: ToolContext }) => {
        const args = params.args || params;
        return resolveEngine().storeEvent(args as { summary: string; entities?: Array<{ id?: string; name?: string; type?: string }>; outcome?: string; relations?: Array<{ source: string; target: string; type: string }> }, params.context);
      },
    },
    {
      name: "query_graph",
      description: "Query memory graph for entity relationships",
      parameters: {
        type: "object",
        properties: { 
          entity: { type: "string", description: "Entity name" } 
        },
        required: ["entity"],
        additionalProperties: false,
      },
      execute: async (params: { args?: Record<string, unknown>; context: ToolContext }) => {
        const args = params.args || params;
        return resolveEngine().queryGraph(args as { entity: string }, params.context);
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
      name: "diagnostics",
      description: "Check memory system status",
      parameters: { 
        type: "object", 
        properties: {},
        required: [],
        additionalProperties: false,
      },
      execute: async (params: { args?: Record<string, unknown>; context: ToolContext }) => {
        const args = params.args || params;
        return resolveEngine().runDiagnostics(args, params.context);
      },
    },
  ];
  
  for (const tool of tools) {
    registerToolCompat(tool);
    registeredTools.push(tool.name);
  }
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
    logger.info(`invoke called for tool ${tool.name} with params: ${JSON.stringify(params)}`);
    const normalized = normalizeInvocation(...params);
    logger.info(`invoke: normalized args=${JSON.stringify(normalized.args)}, context=${JSON.stringify(normalized.context)}`);
    return tool.execute({
      args: normalized.args,
      context: normalized.context,
    });
  };
  api.registerTool({
    name: tool.name,
    description: tool.description,
    parameters: sanitizeToolParametersSchema(tool.parameters),
    execute: invoke,
    handler: invoke,
  });
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
  
  logger = api.getLogger?.() || createConsoleLogger();
  
  const apiPluginConfig = (api as any).pluginConfig || {};
  const openclawConfig = (api as any).config || {};
  const pluginEntry = openclawConfig?.plugins?.entries?.[PLUGIN_ID];
  const pluginConfig = Object.keys(apiPluginConfig).length > 0 ? apiPluginConfig : (pluginEntry?.config || {});
  
  const effectiveConfig = userConfig || pluginConfig || {};
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
    dbPath: effectiveConfig.dbPath,
    autoSync: effectiveConfig.autoSync ?? defaultConfig.autoSync,
    autoReflect: effectiveConfig.autoReflect ?? defaultConfig.autoReflect,
    autoReflectIntervalMinutes: effectiveConfig.autoReflectIntervalMinutes ?? defaultConfig.autoReflectIntervalMinutes,
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
  logger.info(`Cortex Memory engine mode: ${resolveEngine().mode}`);
  logLifecycle("register_success", {
    enabled: isEnabled,
  });

  if (isEnabled) {
    registerTools();
    registerHooks();
    startAutoReflectScheduler();
  }
}
