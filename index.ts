/// <reference types="node" />
import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";

interface EmbeddingConfig {
  provider: string;
  model: string;
  apiKey?: string;
  baseURL?: string;
  dimensions?: number;
}

interface LLMConfig {
  provider: string;
  model: string;
  apiKey?: string;
  baseURL?: string;
}

interface RerankerConfig {
  provider?: string;
  model: string;
  apiKey?: string;
  endpoint?: string;
}

interface CortexMemoryConfig {
  enabled?: boolean;
  embedding: EmbeddingConfig;
  llm: LLMConfig;
  reranker: RerankerConfig;
  dbPath?: string;
  autoSync?: boolean;
  autoReflect?: boolean;
  fallbackToBuiltin?: boolean;
  apiUrl?: string;
}

interface ToolContext {
  agentId: string;
  sessionId: string;
  workspaceId: string;
}

interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  errorCode?: string;
}

interface BuiltinMemory {
  search: (query: string, limit?: number) => Promise<unknown[]>;
  store: (content: string, metadata?: Record<string, unknown>) => Promise<string>;
  delete: (id: string) => Promise<boolean>;
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
    execute: (params: { args: Record<string, unknown>; context: ToolContext }) => Promise<ToolResult>;
  }): void;
  unregisterTool?(name: string): void;
  registerHook(hook: {
    event: string;
    handler: (payload: unknown, context: ToolContext) => Promise<void>;
  }): void;
  unregisterHook?(event: string): void;
  getLogger?(): Logger;
  getBuiltinMemory?(): BuiltinMemory;
}

interface UserFriendlyError {
  code: string;
  message: string;
  suggestion: string;
}

const ERROR_CODES: Record<string, UserFriendlyError> = {
  CONNECTION_REFUSED: {
    code: "E001",
    message: "Cannot connect to the memory service",
    suggestion: "The Python backend may not be running. Try restarting the OpenClaw gateway."
  },
  TIMEOUT: {
    code: "E002",
    message: "The memory service is not responding",
    suggestion: "The service may be overloaded. Wait a moment and try again."
  },
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
  SERVICE_ERROR: {
    code: "E005",
    message: "The memory service encountered an error",
    suggestion: "Check the service logs for details or try restarting the gateway."
  },
  PLUGIN_DISABLED: {
    code: "E006",
    message: "Cortex Memory plugin is disabled",
    suggestion: "Enable the plugin using 'openclaw plugins enable cortex-memory' or check openclaw.json"
  }
};

const SENSITIVE_KEYS = ["API_KEY", "SECRET", "TOKEN", "PASSWORD", "APIKEY"];

const MIN_OPENCLAW_VERSION = "2026.3.8";
const MAX_OPENCLAW_VERSION = "2027.0.0";

const defaultConfig: Partial<CortexMemoryConfig> = {
  autoSync: true,
  autoReflect: false,
  enabled: true,
  fallbackToBuiltin: true,
};

interface CachedSearchResult {
  query: string;
  results: unknown[];
  timestamp: number;
}

let autoSearchCache: CachedSearchResult | null = null;
const AUTO_SEARCH_CACHE_TTL = 60000;

let config: CortexMemoryConfig | null = null;
let logger: Logger;
let pythonProcess: ChildProcess | null = null;
let isShuttingDown = false;
let isEnabled = true;
let api: OpenClawPluginApi | null = null;
let builtinMemory: BuiltinMemory | null = null;
let registeredTools: string[] = [];
let registeredHooks: string[] = [];
let configWatchInterval: ReturnType<typeof setInterval> | null = null;
let configPath: string | null = null;

function createConsoleLogger(): Logger {
  return {
    debug: (message: string, ...args: unknown[]) => console.debug(`[CortexMemory] ${message}`, ...args),
    info: (message: string, ...args: unknown[]) => console.log(`[CortexMemory] ${message}`, ...args),
    warn: (message: string, ...args: unknown[]) => console.warn(`[CortexMemory] ${message}`, ...args),
    error: (message: string, ...args: unknown[]) => console.error(`[CortexMemory] ${message}`, ...args),
  };
}

function sanitizeForLogging(obj: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const isSensitive = SENSITIVE_KEYS.some(k => key.toUpperCase().includes(k));
    if (isSensitive) {
      sanitized[key] = "***REDACTED***";
    } else if (typeof value === "object" && value !== null) {
      sanitized[key] = sanitizeForLogging(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const valA = partsA[i] || 0;
    const valB = partsB[i] || 0;
    if (valA < valB) return -1;
    if (valA > valB) return 1;
  }
  return 0;
}

async function checkOpenClawVersion(): Promise<void> {
  try {
    const version = process.env.OPENCLAW_VERSION;
    if (version) {
      if (compareVersions(version, MIN_OPENCLAW_VERSION) < 0) {
        throw new Error(`Incompatible OpenClaw version: ${version}. Minimum required: ${MIN_OPENCLAW_VERSION}`);
      }
      if (compareVersions(version, MAX_OPENCLAW_VERSION) >= 0) {
        throw new Error(`Incompatible OpenClaw version: ${version}. Maximum supported: <${MAX_OPENCLAW_VERSION}`);
      }
      logger.info(`OpenClaw version check passed: ${version}`);
    } else {
      logger.warn("Could not determine OpenClaw version, proceeding with caution");
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.warn(`Version check warning: ${message}`);
  }
}

function findProjectRoot(): string {
  if (api && (api as any).rootDir) {
    return (api as any).rootDir;
  }
  let current = process.cwd();
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, "api")) && fs.existsSync(path.join(current, "memory_engine"))) {
      return current;
    }
    current = path.dirname(current);
  }
  throw new Error("Cannot find project root directory");
}

function findOpenClawConfig(): string | null {
  const possiblePaths = [
    path.join(process.cwd(), "openclaw.json"),
    path.join(process.env.USERPROFILE || process.env.HOME || "", ".openclaw", "openclaw.json"),
    path.join(process.env.OPENCLAW_BASE_PATH || "", "openclaw.json"),
  ];
  
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

function loadPluginEnabledState(): boolean {
  if (!configPath || !fs.existsSync(configPath)) {
    return true;
  }
  
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const openclawConfig = JSON.parse(content);
    const pluginConfig = openclawConfig?.plugins?.["cortex-memory"];
    return pluginConfig?.enabled !== false;
  } catch (e) {
    logger.warn(`Failed to load config state: ${e}`);
    return true;
  }
}

function startConfigWatcher(): void {
  if (configWatchInterval) {
    clearInterval(configWatchInterval);
  }
  
  let lastEnabledState = isEnabled;
  
  configWatchInterval = setInterval(() => {
    const newState = loadPluginEnabledState();
    if (newState !== lastEnabledState) {
      lastEnabledState = newState;
      if (newState && !isEnabled) {
        logger.info("Detected config change: enabling Cortex Memory plugin");
        enable();
      } else if (!newState && isEnabled) {
        logger.info("Detected config change: disabling Cortex Memory plugin");
        disable();
      }
    }
  }, 5000);
}

function stopConfigWatcher(): void {
  if (configWatchInterval) {
    clearInterval(configWatchInterval);
    configWatchInterval = null;
  }
}

function validateConfig(cfg: CortexMemoryConfig): string[] {
  const errors: string[] = [];
  
  if (!cfg.embedding?.provider || !cfg.embedding?.model) {
    errors.push("embedding.provider and embedding.model are required. Please configure them in openclaw.json");
  }
  if (!cfg.llm?.provider || !cfg.llm?.model) {
    errors.push("llm.provider and llm.model are required. Please configure them in openclaw.json");
  }
  if (!cfg.reranker?.model) {
    errors.push("reranker.model is required. Please configure it in openclaw.json");
  }
  
  return errors;
}

async function startPythonService(): Promise<void> {
  if (!config) {
    throw new Error("Configuration not loaded");
  }

  const projectRoot = findProjectRoot();
  const venvDir = path.join(projectRoot, "venv");
  
  const pythonCmd = process.platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");

  if (!fs.existsSync(pythonCmd)) {
    throw new Error("Python environment not found. Please run 'npm install' first.");
  }

  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new Error(`Configuration errors:\n${errors.join("\n")}`);
  }

  logger.info("Starting Cortex Memory Python service...");

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    CORTEX_MEMORY_EMBEDDING_PROVIDER: config.embedding.provider,
    CORTEX_MEMORY_EMBEDDING_MODEL: config.embedding.model,
    CORTEX_MEMORY_LLM_PROVIDER: config.llm.provider,
    CORTEX_MEMORY_LLM_MODEL: config.llm.model,
    CORTEX_MEMORY_RERANKER_PROVIDER: config.reranker.provider || "",
    CORTEX_MEMORY_RERANKER_MODEL: config.reranker.model,
    CORTEX_MEMORY_DB_PATH: config.dbPath || path.join(
      process.env.USERPROFILE || process.env.HOME || "", 
      ".openclaw", "agents", "main", "lancedb_store"
    ),
  };

  if (config.embedding.apiKey) {
    env.CORTEX_MEMORY_EMBEDDING_API_KEY = config.embedding.apiKey;
  }
  if (config.embedding.baseURL) {
    env.CORTEX_MEMORY_EMBEDDING_BASE_URL = config.embedding.baseURL;
  }
  if (config.embedding.dimensions) {
    env.CORTEX_MEMORY_EMBEDDING_DIMENSIONS = String(config.embedding.dimensions);
  }
  if (config.llm.apiKey) {
    env.CORTEX_MEMORY_LLM_API_KEY = config.llm.apiKey;
  }
  if (config.llm.baseURL) {
    env.CORTEX_MEMORY_LLM_BASE_URL = config.llm.baseURL;
  }
  if (config.reranker.apiKey) {
    env.CORTEX_MEMORY_RERANKER_API_KEY = config.reranker.apiKey;
  }
  if (config.reranker.endpoint) {
    env.CORTEX_MEMORY_RERANKER_ENDPOINT = config.reranker.endpoint;
  }

  return new Promise((resolve, reject) => {
    pythonProcess = spawn(pythonCmd, ["-m", "api.server"], {
      cwd: projectRoot,
      detached: false,
      windowsHide: true,
      env,
    });

    let started = false;
    let stderrBuffer = "";

    pythonProcess.stdout?.on("data", (data: Buffer) => {
      const output = data.toString();
      if (!output.toLowerCase().includes("key") && !output.toLowerCase().includes("token")) {
        logger.info(`[Python] ${output.trim()}`);
      }
      if (output.includes("Cortex Memory API started") || output.includes("Application startup complete")) {
        started = true;
        resolve();
      }
    });

    pythonProcess.stderr?.on("data", (data: Buffer) => {
      const output = data.toString();
      stderrBuffer += output;
      if (!output.toLowerCase().includes("key") && !output.toLowerCase().includes("token")) {
        logger.warn(`[Python] ${output.trim()}`);
      }
      if (output.includes("Cortex Memory API started") && !started) {
        started = true;
        resolve();
      }
    });

    pythonProcess.on("error", (error: Error) => {
      logger.error("Failed to start Python service:", error.message);
      reject(error);
    });

    pythonProcess.on("exit", (code: number | null) => {
      if (!started && code !== 0 && !isShuttingDown) {
        reject(new Error(`Python service exited with code ${code}. Stderr: ${stderrBuffer.slice(-500)}`));
      }
    });

    setTimeout(() => {
      if (!started) {
        const tail = stderrBuffer ? `\nLast stderr: ${stderrBuffer.slice(-500)}` : "";
        killPythonProcess();
        reject(new Error(`Timeout waiting for Python service to start (300s)${tail}`));
      }
    }, 300000);
  });
}

function killPythonProcess(): void {
  if (!pythonProcess) return;
  
  try {
    if (process.platform === "win32" && pythonProcess.pid) {
      spawn("taskkill", ["/pid", String(pythonProcess.pid), "/f", "/t"]);
    } else {
      pythonProcess.kill("SIGTERM");
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.warn(`Failed to kill Python process: ${message}`);
  } finally {
    pythonProcess = null;
  }
}

function stopPythonService(): void {
  if (pythonProcess) {
    logger.info("Stopping Cortex Memory Python service...");
    killPythonProcess();
  }
}

function getBaseUrl(): string {
  return config?.apiUrl ?? "http://127.0.0.1:8765";
}

async function waitForService(maxAttempts = 30): Promise<void> {
  const apiUrl = getBaseUrl();
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error("Service failed to become ready");
}

function formatApiError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  
  if (lower.includes("econnrefused") || lower.includes("enotfound") || lower.includes("fetch failed")) {
    const err = ERROR_CODES.CONNECTION_REFUSED;
    return `${err.message} (${err.code}). ${err.suggestion}`;
  }
  if (lower.includes("abort") || lower.includes("timed out")) {
    const err = ERROR_CODES.TIMEOUT;
    return `${err.message} (${err.code}). ${err.suggestion}`;
  }
  if (lower.includes("404") || lower.includes("not found")) {
    const err = ERROR_CODES.NOT_FOUND;
    return `${err.message} (${err.code}). ${err.suggestion}`;
  }
  if (lower.includes("400") || lower.includes("invalid")) {
    const err = ERROR_CODES.INVALID_INPUT;
    return `${err.message} (${err.code}). ${err.suggestion}`;
  }
  
  const err = ERROR_CODES.SERVICE_ERROR;
  return `${err.message} (${err.code}). Details: ${message}`;
}

interface PendingRequest<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

const pendingRequests: Map<string, PendingRequest<unknown>> = new Map();
const requestDebounceMs = 100;

function getRequestKey(endpoint: string, method: string, body?: unknown): string {
  const bodyHash = body ? JSON.stringify(body).slice(0, 100) : "";
  return `${method}:${endpoint}:${bodyHash}`;
}

async function apiCallWithRetry<T>(
  endpoint: string,
  method: "GET" | "POST" | "DELETE" | "PATCH" = "GET",
  body?: unknown,
  options?: {
    maxRetries?: number;
    baseDelay?: number;
    timeout?: number;
    skipDebounce?: boolean;
  }
): Promise<T> {
  const { maxRetries = 3, baseDelay = 1000, timeout = 30000, skipDebounce = false } = options || {};
  
  if (!skipDebounce) {
    const requestKey = getRequestKey(endpoint, method, body);
    const pending = pendingRequests.get(requestKey);
    if (pending) {
      logger.debug(`Reusing pending request for ${endpoint}`);
      return pending.promise as Promise<T>;
    }
    
    let resolveRef: (value: unknown) => void;
    let rejectRef: (error: Error) => void;
    const promise = new Promise<T>((resolve, reject) => {
      resolveRef = resolve as (value: unknown) => void;
      rejectRef = reject;
    });
    
    pendingRequests.set(requestKey, {
      promise,
      resolve: resolveRef!,
      reject: rejectRef!
    });
    
    try {
      const result = await apiCallInternal<T>(endpoint, method, body, maxRetries, baseDelay, timeout);
      resolveRef!(result);
      return result;
    } catch (error) {
      rejectRef!(error as Error);
      throw error;
    } finally {
      setTimeout(() => pendingRequests.delete(requestKey), requestDebounceMs);
    }
  }
  
  return apiCallInternal<T>(endpoint, method, body, maxRetries, baseDelay, timeout);
}

async function apiCallInternal<T>(
  endpoint: string,
  method: "GET" | "POST" | "DELETE" | "PATCH",
  body: unknown,
  maxRetries: number,
  baseDelay: number,
  timeout: number
): Promise<T> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await apiCall<T>(endpoint, method, body, timeout);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const isRetryable = lastError.message.includes("E001") || 
                          lastError.message.includes("E002") ||
                          lastError.message.includes("timeout") ||
                          lastError.message.includes("ECONNREFUSED") ||
                          lastError.message.includes("ENOTFOUND");
      
      if (attempt < maxRetries - 1 && isRetryable) {
        const delay = baseDelay * Math.pow(2, attempt);
        logger.warn(`API call failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}ms: ${lastError.message.split(".")[0]}`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError;
}

async function apiCall<T>(
  endpoint: string,
  method: "GET" | "POST" | "DELETE" | "PATCH" = "GET",
  body?: unknown,
  timeout: number = 30000
): Promise<T> {
  const url = `${getBaseUrl()}${endpoint}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  const options: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
    signal: controller.signal,
  };
  if (body) options.body = JSON.stringify(body);

  try {
    const response = await fetch(url, options);
    const text = await response.text();
    if (!response.ok) {
      try {
        const errorData = JSON.parse(text);
        throw new Error(errorData.error || errorData.detail || `HTTP ${response.status}`);
      } catch {
        throw new Error(`HTTP ${response.status}: ${text || response.statusText}`);
      }
    }
    if (!text) return {} as T;
    try { return JSON.parse(text) as T; } 
    catch { throw new Error("Invalid JSON response"); }
  } catch (error) {
    throw new Error(formatApiError(error));
  } finally {
    clearTimeout(timeoutId);
  }
}

async function searchMemoryWithFallback(args: { query: string; top_k?: number }, context: ToolContext): Promise<ToolResult> {
  if (!isEnabled) {
    if (config?.fallbackToBuiltin && builtinMemory) {
      logger.info("Using builtin memory (plugin disabled)");
      try {
        const results = await builtinMemory.search(args.query, args.top_k || 3);
        return { success: true, data: results };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, error: `Builtin memory error: ${message}` };
      }
    }
    return { success: false, error: ERROR_CODES.PLUGIN_DISABLED.message, errorCode: ERROR_CODES.PLUGIN_DISABLED.code };
  }
  
  try {
    const result = await apiCallWithRetry<{ results: unknown[] }>("/search", "POST", {
      query: args.query,
      top_k: args.top_k || 3,
    });
    return { success: true, data: result.results };
  } catch (error) {
    const message = formatApiError(error);
    logger.error(`search_memory failed: ${message}`);
    return { success: false, error: message };
  }
}

async function storeEventWithFallback(
  args: {
    summary: string;
    entities?: Array<{ id?: string; name?: string; type?: string }>;
    outcome?: string;
    relations?: Array<{ source: string; target: string; type: string }>;
  },
  context: ToolContext
): Promise<ToolResult> {
  if (!isEnabled) {
    if (config?.fallbackToBuiltin && builtinMemory) {
      logger.info("Using builtin memory (plugin disabled)");
      try {
        const id = await builtinMemory.store(args.summary, { 
          entities: args.entities, 
          outcome: args.outcome,
          relations: args.relations 
        });
        return { success: true, data: { event_id: id } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, error: `Builtin memory error: ${message}` };
      }
    }
    return { success: false, error: ERROR_CODES.PLUGIN_DISABLED.message, errorCode: ERROR_CODES.PLUGIN_DISABLED.code };
  }
  
  try {
    const result = await apiCallWithRetry<{ event_id: string }>("/event", "POST", {
      summary: args.summary,
      entities: args.entities,
      outcome: args.outcome,
      relations: args.relations,
    });
    return { success: true, data: result };
  } catch (error) {
    const message = formatApiError(error);
    logger.error(`store_event failed: ${message}`);
    return { success: false, error: message };
  }
}

async function queryGraph(args: { entity: string }, _context: ToolContext): Promise<ToolResult> {
  if (!isEnabled) {
    return { success: false, error: ERROR_CODES.PLUGIN_DISABLED.message, errorCode: ERROR_CODES.PLUGIN_DISABLED.code };
  }
  
  try {
    const result = await apiCallWithRetry<{ graph: unknown }>("/graph/query", "POST", { entity: args.entity });
    return { success: true, data: result.graph };
  } catch (error) {
    const message = formatApiError(error);
    logger.error(`query_graph failed: ${message}`);
    return { success: false, error: message };
  }
}

async function getHotContext(args: { limit?: number }, _context: ToolContext): Promise<ToolResult> {
  if (!isEnabled) {
    return { success: false, error: ERROR_CODES.PLUGIN_DISABLED.message, errorCode: ERROR_CODES.PLUGIN_DISABLED.code };
  }
  
  try {
    const result = await apiCallWithRetry<{ context: unknown[] }>("/hot-context", "GET");
    return { success: true, data: result.context };
  } catch (error) {
    const message = formatApiError(error);
    logger.error(`get_hot_context failed: ${message}`);
    return { success: false, error: message };
  }
}

async function getAutoContext(args: { include_hot?: boolean }, _context: ToolContext): Promise<ToolResult> {
  if (!isEnabled) {
    return { success: false, error: ERROR_CODES.PLUGIN_DISABLED.message, errorCode: ERROR_CODES.PLUGIN_DISABLED.code };
  }
  
  const now = Date.now();
  const result: {
    auto_search?: {
      query: string;
      results: unknown[];
      age_seconds: number;
    };
    hot_context?: unknown[];
  } = {};
  
  if (autoSearchCache && (now - autoSearchCache.timestamp) < AUTO_SEARCH_CACHE_TTL) {
    result.auto_search = {
      query: autoSearchCache.query,
      results: autoSearchCache.results,
      age_seconds: Math.floor((now - autoSearchCache.timestamp) / 1000),
    };
  }
  
  if (args.include_hot !== false) {
    try {
      const hotResult = await apiCallWithRetry<{ context: unknown[] }>("/hot-context", "GET");
      result.hot_context = hotResult.context;
    } catch (error) {
      logger.debug(`Failed to get hot context: ${formatApiError(error)}`);
    }
  }
  
  if (!result.auto_search && !result.hot_context) {
    return { 
      success: true, 
      data: { 
        message: "No auto-search results cached and hot context unavailable",
        suggestion: "User messages will trigger auto-search. Try get_hot_context separately."
      } 
    };
  }
  
  return { success: true, data: result };
}

async function reflectMemory(_args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
  if (!isEnabled) {
    return { success: false, error: ERROR_CODES.PLUGIN_DISABLED.message, errorCode: ERROR_CODES.PLUGIN_DISABLED.code };
  }
  
  try {
    await apiCallWithRetry("/reflect", "POST");
    return { success: true };
  } catch (error) {
    const message = formatApiError(error);
    logger.error(`reflect_memory failed: ${message}`);
    return { success: false, error: message };
  }
}

async function syncMemory(_args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
  if (!isEnabled) {
    return { success: false, error: ERROR_CODES.PLUGIN_DISABLED.message, errorCode: ERROR_CODES.PLUGIN_DISABLED.code };
  }
  
  try {
    await apiCallWithRetry("/sync", "POST");
    return { success: true };
  } catch (error) {
    const message = formatApiError(error);
    logger.error(`sync_memory failed: ${message}`);
    return { success: false, error: message };
  }
}

async function promoteMemory(_args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
  if (!isEnabled) {
    return { success: false, error: ERROR_CODES.PLUGIN_DISABLED.message, errorCode: ERROR_CODES.PLUGIN_DISABLED.code };
  }
  
  try {
    await apiCallWithRetry("/promote", "POST");
    return { success: true };
  } catch (error) {
    const message = formatApiError(error);
    logger.error(`promote_memory failed: ${message}`);
    return { success: false, error: message };
  }
}

async function deleteMemory(args: { memory_id: string }, _context: ToolContext): Promise<ToolResult> {
  if (!isEnabled) {
    if (config?.fallbackToBuiltin && builtinMemory) {
      try {
        const success = await builtinMemory.delete(args.memory_id);
        return { success };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, error: `Builtin memory error: ${message}` };
      }
    }
    return { success: false, error: ERROR_CODES.PLUGIN_DISABLED.message, errorCode: ERROR_CODES.PLUGIN_DISABLED.code };
  }
  
  try {
    await apiCallWithRetry(`/memory/${args.memory_id}`, "DELETE");
    return { success: true };
  } catch (error) {
    const message = formatApiError(error);
    logger.error(`delete_memory failed: ${message}`);
    return { success: false, error: message };
  }
}

async function updateMemory(args: { memory_id: string; text?: string; type?: string; weight?: number }, _context: ToolContext): Promise<ToolResult> {
  if (!isEnabled) {
    return { success: false, error: ERROR_CODES.PLUGIN_DISABLED.message, errorCode: ERROR_CODES.PLUGIN_DISABLED.code };
  }
  
  try {
    await apiCallWithRetry(`/memory/${args.memory_id}`, "PATCH", {
      text: args.text,
      type: args.type,
      weight: args.weight,
    });
    return { success: true };
  } catch (error) {
    const message = formatApiError(error);
    logger.error(`update_memory failed: ${message}`);
    return { success: false, error: message };
  }
}

async function cleanupMemories(args: { days_old?: number; memory_type?: string }, _context: ToolContext): Promise<ToolResult> {
  if (!isEnabled) {
    return { success: false, error: ERROR_CODES.PLUGIN_DISABLED.message, errorCode: ERROR_CODES.PLUGIN_DISABLED.code };
  }
  
  try {
    const result = await apiCallWithRetry<{ deleted_count: number }>("/cleanup", "POST", {
      days_old: args.days_old || 90,
      memory_type: args.memory_type,
    });
    return { success: true, data: { deletedCount: result.deleted_count } };
  } catch (error) {
    const message = formatApiError(error);
    logger.error(`cleanup_memories failed: ${message}`);
    return { success: false, error: message };
  }
}

async function runDiagnostics(_args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
  if (!isEnabled) {
    return { 
      success: true, 
      data: { 
        status: "disabled", 
        message: "Cortex Memory plugin is disabled",
        suggestion: "Enable the plugin using 'openclaw plugins enable cortex-memory'"
      } 
    };
  }
  
  try {
    const result = await apiCallWithRetry<{
      status: string;
      checks: Array<{ name: string; passed: boolean; message: string }>;
      recommendations: string[];
    }>("/doctor", "GET");
    return { success: true, data: result };
  } catch (error) {
    const message = formatApiError(error);
    logger.error(`diagnostics failed: ${message}`);
    return { success: false, error: message };
  }
}

async function getPluginStatus(_args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
  return {
    success: true,
    data: {
      enabled: isEnabled,
      service_running: pythonProcess !== null,
      fallback_enabled: config?.fallbackToBuiltin ?? true,
      builtin_memory_available: builtinMemory !== null
    }
  };
}

async function onMessageHandler(payload: unknown, context: ToolContext): Promise<void> {
  if (!isEnabled) return;
  
  const data = payload as { 
    content?: string; 
    text?: string; 
    source?: string;
    role?: string;
  };
  const text = data.content || data.text;
  if (!text) return;
  
  const role = data.role || "user";
  
  try {
    await apiCall("/write", "POST", { 
      text, 
      source: data.source || "message",
      role
    });
    logger.info(`Stored ${role} message for session ${context.sessionId}`);
  } catch (error) {
    logger.warn(`Failed to store message: ${formatApiError(error)}`);
  }
  
  if (role === "user" && text.length > 5) {
    try {
      const searchResult = await apiCall<{ results: unknown[] }>("/search", "POST", {
        query: text,
        top_k: 3,
      });
      
      if (searchResult.results && searchResult.results.length > 0) {
        autoSearchCache = {
          query: text,
          results: searchResult.results,
          timestamp: Date.now(),
        };
        logger.info(`Auto-search cached ${searchResult.results.length} results for context`);
      }
    } catch (error) {
      logger.debug(`Auto-search skipped: ${formatApiError(error)}`);
    }
  }
}

async function onSessionEndHandler(payload: unknown, context: ToolContext): Promise<void> {
  if (!isEnabled) return;
  
  try {
    const endResult = await apiCall<{ events_generated: number }>(
      "/session-end", 
      "POST"
    );
    logger.info(`Session ${context.sessionId} ended, generated ${endResult.events_generated} events`);
  } catch (error) {
    logger.warn(`Failed to end session: ${formatApiError(error)}`);
  }
}

async function onTimerHandler(payload: unknown, _context: ToolContext): Promise<void> {
  if (!isEnabled) return;
  
  const data = payload as { action?: string };
  const action = data.action;
  try {
    if (action === "sync") {
      await apiCall("/sync", "POST");
      logger.info("Scheduled sync complete");
    } else if (action === "reflect" || (config?.autoReflect && !action)) {
      await apiCall("/reflect", "POST");
      logger.info("Scheduled reflection complete");
    } else if (action === "promote") {
      await apiCall("/promote", "POST");
      logger.info("Scheduled promotion complete");
    }
  } catch (error) {
    logger.warn(`Timer action failed: ${formatApiError(error)}`);
  }
}

function registerTools(): void {
  if (!api) return;
  
  const tools = [
    {
      name: "search_memory",
      description: "Search the long-term semantic memory for relevant information",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          top_k: { type: "number", description: "Number of results", default: 3 },
        },
        required: ["query"],
      },
      execute: async ({ args, context }: { args: Record<string, unknown>; context: ToolContext }) => 
        searchMemoryWithFallback(args as { query: string; top_k?: number }, context),
    },
    {
      name: "store_event",
      description: "Store a new episodic event in the memory system",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Event summary" },
          entities: { type: "array", description: "Involved entities" },
          outcome: { type: "string", description: "Event outcome" },
          relations: { type: "array", description: "Entity relationships" },
        },
        required: ["summary"],
      },
      execute: async ({ args, context }: { args: Record<string, unknown>; context: ToolContext }) => 
        storeEventWithFallback(args as Parameters<typeof storeEventWithFallback>[0], context),
    },
    {
      name: "query_graph",
      description: "Query the memory graph for entity relationships",
      parameters: {
        type: "object",
        properties: { entity: { type: "string", description: "Entity name" } },
        required: ["entity"],
      },
      execute: async ({ args, context }: { args: Record<string, unknown>; context: ToolContext }) => 
        queryGraph(args as { entity: string }, context),
    },
    {
      name: "get_hot_context",
      description: "Get current hot context including CORTEX_RULES.md and recent data",
      parameters: {
        type: "object",
        properties: { limit: { type: "number", description: "Max items", default: 20 } },
      },
      execute: async ({ args, context }: { args: Record<string, unknown>; context: ToolContext }) => 
        getHotContext(args as { limit?: number }, context),
    },
    {
      name: "get_auto_context",
      description: "Get automatically retrieved relevant memories based on recent user messages, plus hot context. Use this for proactive memory retrieval without explicit search.",
      parameters: {
        type: "object",
        properties: { 
          include_hot: { type: "boolean", description: "Include hot context (default: true)", default: true }
        },
      },
      execute: async ({ args, context }: { args: Record<string, unknown>; context: ToolContext }) => 
        getAutoContext(args as { include_hot?: boolean }, context),
    },
    {
      name: "reflect_memory",
      description: "Trigger reflection to convert episodic events into semantic knowledge",
      parameters: { type: "object", properties: {} },
      execute: async ({ args, context }: { args: Record<string, unknown>; context: ToolContext }) => 
        reflectMemory(args, context),
    },
    {
      name: "sync_memory",
      description: "Import historical session data from OpenClaw workspace into memory system. Use this to import past conversations. Incremental processing - won't reprocess already imported data.",
      parameters: { type: "object", properties: {} },
      execute: async ({ args, context }: { args: Record<string, unknown>; context: ToolContext }) => 
        syncMemory(args, context),
    },
    {
      name: "promote_memory",
      description: "Promote frequently accessed memories to core rules",
      parameters: { type: "object", properties: {} },
      execute: async ({ args, context }: { args: Record<string, unknown>; context: ToolContext }) => 
        promoteMemory(args, context),
    },
    {
      name: "delete_memory",
      description: "Delete a specific memory by ID",
      parameters: {
        type: "object",
        properties: { memory_id: { type: "string", description: "Memory ID to delete" } },
        required: ["memory_id"],
      },
      execute: async ({ args, context }: { args: Record<string, unknown>; context: ToolContext }) => 
        deleteMemory(args as { memory_id: string }, context),
    },
    {
      name: "update_memory",
      description: "Update a specific memory's content, type, or weight",
      parameters: {
        type: "object",
        properties: {
          memory_id: { type: "string", description: "Memory ID to update" },
          text: { type: "string", description: "New text content" },
          type: { type: "string", description: "New memory type" },
          weight: { type: "number", description: "New weight value" },
        },
        required: ["memory_id"],
      },
      execute: async ({ args, context }: { args: Record<string, unknown>; context: ToolContext }) => 
        updateMemory(args as { memory_id: string; text?: string; type?: string; weight?: number }, context),
    },
    {
      name: "cleanup_memories",
      description: "Clean up old memories beyond specified days",
      parameters: {
        type: "object",
        properties: {
          days_old: { type: "number", description: "Delete memories older than this many days (default: 90)" },
          memory_type: { type: "string", description: "Only clean up memories of this type" },
        },
      },
      execute: async ({ args, context }: { args: Record<string, unknown>; context: ToolContext }) => 
        cleanupMemories(args as { days_old?: number; memory_type?: string }, context),
    },
    {
      name: "diagnostics",
      description: "Run system diagnostics to check configuration and connectivity",
      parameters: { type: "object", properties: {} },
      execute: async ({ args, context }: { args: Record<string, unknown>; context: ToolContext }) => 
        runDiagnostics(args, context),
    },
    {
      name: "cortex_memory_status",
      description: "Get the current status of the Cortex Memory plugin",
      parameters: { type: "object", properties: {} },
      execute: async ({ args, context }: { args: Record<string, unknown>; context: ToolContext }) => 
        getPluginStatus(args, context),
    },
  ];
  
  for (const tool of tools) {
    api.registerTool(tool);
    registeredTools.push(tool.name);
  }
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

function registerHooks(): void {
  if (!api) return;
  
  const hooks = [
    { event: "message", handler: onMessageHandler },
    { event: "sessionEnd", handler: onSessionEndHandler },
    { event: "timer", handler: onTimerHandler },
  ];
  
  for (const hook of hooks) {
    api.registerHook(hook);
    registeredHooks.push(hook.event);
  }
}

function unregisterHooks(): void {
  if (!api || !api.unregisterHook) return;
  
  for (const event of registeredHooks) {
    try {
      api.unregisterHook(event);
    } catch (e) {
      logger.warn(`Failed to unregister hook ${event}: ${e}`);
    }
  }
  registeredHooks = [];
}

function setupProcessHandlers(): void {
  const gracefulShutdown = (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`Received ${signal}, shutting down...`);
    stopConfigWatcher();
    stopPythonService();
    process.exit(0);
  };

  process.on("exit", () => {
    stopPythonService();
    stopConfigWatcher();
  });
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    logger.error("Uncaught exception:", err.message);
    stopPythonService();
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
  
  try {
    await startPythonService();
    await waitForService();
    isEnabled = true;
    registerTools();
    registerHooks();
    logger.info("Cortex Memory plugin enabled successfully");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to enable Cortex Memory plugin: ${message}`);
    throw error;
  }
}

export async function disable(): Promise<void> {
  if (!isEnabled) {
    logger.info("Cortex Memory plugin is already disabled");
    return;
  }
  
  logger.info("Disabling Cortex Memory plugin...");
  
  unregisterHooks();
  unregisterTools();
  stopPythonService();
  isEnabled = false;
  
  if (config?.fallbackToBuiltin && builtinMemory) {
    logger.info("Falling back to OpenClaw builtin memory system");
    registerFallbackTools();
  }
  
  logger.info("Cortex Memory plugin disabled successfully");
}

function registerFallbackTools(): void {
  if (!api || !builtinMemory) return;
  
  api.registerTool({
    name: "search_memory",
    description: "Search memory (using builtin system - Cortex Memory disabled)",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        top_k: { type: "number", description: "Number of results", default: 3 },
      },
      required: ["query"],
    },
    execute: async ({ args, context }: { args: Record<string, unknown>; context: ToolContext }) => 
      searchMemoryWithFallback(args as { query: string; top_k?: number }, context),
  });
  
  api.registerTool({
    name: "store_event",
    description: "Store event (using builtin system - Cortex Memory disabled)",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Event summary" },
      },
      required: ["summary"],
    },
    execute: async ({ args, context }: { args: Record<string, unknown>; context: ToolContext }) => 
      storeEventWithFallback(args as { summary: string }, context),
  });
  
  api.registerTool({
    name: "cortex_memory_status",
    description: "Get the current status of the Cortex Memory plugin",
    parameters: { type: "object", properties: {} },
    execute: async ({ args, context }: { args: Record<string, unknown>; context: ToolContext }) => 
      getPluginStatus(args, context),
  });
}

export function getStatus(): { enabled: boolean; serviceRunning: boolean } {
  return {
    enabled: isEnabled,
    serviceRunning: pythonProcess !== null
  };
}

export async function unregister(): Promise<void> {
  logger.info("Unregistering Cortex Memory plugin...");
  
  stopConfigWatcher();
  
  unregisterHooks();
  unregisterTools();
  
  stopPythonService();
  
  isEnabled = false;
  api = null;
  config = null;
  builtinMemory = null;
  registeredTools = [];
  registeredHooks = [];
  configPath = null;
  
  logger.info("Cortex Memory plugin unregistered successfully");
}

export async function register(pluginApi: OpenClawPluginApi, userConfig?: Partial<CortexMemoryConfig>): Promise<void> {
  api = pluginApi;
  
  logger = api.getLogger?.() || createConsoleLogger();
  logger.info("Registering Cortex Memory plugin...");
  
  const openclawConfig = (api as any).config || {};
  const pluginEntry = openclawConfig?.plugins?.entries?.["@openclaw/cortex-memory"];
  const pluginConfig = pluginEntry?.config || {};
  
  logger.info(`Plugin config from openclaw.json: ${JSON.stringify(sanitizeForLogging(pluginConfig))}`);
  
  const effectiveConfig = userConfig || pluginConfig || {};
  
  config = { 
    embedding: effectiveConfig.embedding || { provider: "openai-compatible", model: "" },
    llm: effectiveConfig.llm || { provider: "openai", model: "" },
    reranker: effectiveConfig.reranker || { provider: "", model: "" },
    dbPath: effectiveConfig.dbPath,
    autoSync: effectiveConfig.autoSync ?? defaultConfig.autoSync,
    autoReflect: effectiveConfig.autoReflect ?? defaultConfig.autoReflect,
    enabled: effectiveConfig.enabled ?? defaultConfig.enabled,
    fallbackToBuiltin: effectiveConfig.fallbackToBuiltin ?? defaultConfig.fallbackToBuiltin,
    apiUrl: effectiveConfig.apiUrl ?? "http://127.0.0.1:8765",
  } as CortexMemoryConfig;
  
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
  logger.info(`Configuration: ${JSON.stringify(safeConfig)}`);

  await checkOpenClawVersion();
  
  configPath = findOpenClawConfig();
  if (configPath) {
    logger.info(`Found OpenClaw config at: ${configPath}`);
  }

  setupProcessHandlers();
  startConfigWatcher();

  const initialEnabled = loadPluginEnabledState();
  isEnabled = config.enabled !== false && initialEnabled;

  if (isEnabled) {
    try {
      await startPythonService();
      await waitForService();
      logger.info("Cortex Memory Python service started successfully");
      try {
        registerTools();
        logger.info("Tools registered successfully");
      } catch (toolError) {
        const message = toolError instanceof Error ? toolError.message : String(toolError);
        logger.error(`Failed to register tools: ${message}`);
        throw toolError;
      }
      try {
        registerHooks();
        logger.info("Hooks registered successfully");
      } catch (hookError) {
        const message = hookError instanceof Error ? hookError.message : String(hookError);
        logger.error(`Failed to register hooks: ${message}`);
        throw hookError;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to start Cortex Memory service: ${message}`);
      
      if (config.fallbackToBuiltin && builtinMemory) {
        logger.info("Falling back to builtin memory system");
        isEnabled = false;
        registerFallbackTools();
      } else {
        throw new Error(`Cortex Memory plugin initialization failed: ${message}`);
      }
    }
  } else {
    logger.info("Cortex Memory plugin is disabled in configuration");
    if (config.fallbackToBuiltin && builtinMemory) {
      logger.info("Using builtin memory system");
      registerFallbackTools();
    }
  }

  logger.info("Cortex Memory plugin registration complete");
}
