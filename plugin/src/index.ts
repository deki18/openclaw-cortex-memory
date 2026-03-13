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
  embedding: EmbeddingConfig;
  llm: LLMConfig;
  reranker: RerankerConfig;
  dbPath?: string;
  autoSync?: boolean;
  autoReflect?: boolean;
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
}

interface OpenClawPluginApi {
  registerTool(tool: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (params: { args: Record<string, unknown>; context: ToolContext }) => Promise<ToolResult>;
  }): void;
  registerHook(hook: {
    event: string;
    handler: (payload: unknown, context: ToolContext) => Promise<void>;
  }): void;
  registerGatewayMethod?(method: string, handler: Function): void;
  registerHttpRoute?(path: string, handler: Function): void;
  registerCli?(registerFn: Function, metadata: Record<string, unknown>): void;
  registerService?(service: { id: string; start: Function; stop: Function }): void;
  getLogger(): {
    info: (message: string, ...args: unknown[]) => void;
    warn: (message: string, ...args: unknown[]) => void;
    error: (message: string, ...args: unknown[]) => void;
  };
}

const defaultConfig: Partial<CortexMemoryConfig> = {
  autoSync: true,
  autoReflect: false,
};

let config: CortexMemoryConfig | null = null;
let logger: ReturnType<OpenClawPluginApi["getLogger"]>;
let pythonProcess: ChildProcess | null = null;

// Find plugin root directory (go up from plugin/dist to project root)
function findProjectRoot(): string {
  let current = __dirname;
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, "api")) && fs.existsSync(path.join(current, "memory_engine"))) {
      return current;
    }
    current = path.dirname(current);
  }
  throw new Error("Cannot find project root directory");
}

// Validate required configuration
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

// Start Python backend service
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

  // Pass optional API keys and endpoints if specified
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

    pythonProcess.stdout?.on("data", (data: Buffer) => {
      const output = data.toString();
      logger.info(`[Python] ${output.trim()}`);
      if (output.includes("Cortex Memory API started") || output.includes("Application startup complete")) {
        started = true;
        resolve();
      }
    });

    pythonProcess.stderr?.on("data", (data: Buffer) => {
      const output = data.toString();
      logger.warn(`[Python] ${output.trim()}`);
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
      if (!started && code !== 0) {
        reject(new Error(`Python service exited with code ${code}`));
      }
    });

    setTimeout(() => {
      if (!started) {
        pythonProcess?.kill();
        reject(new Error("Timeout waiting for Python service to start (300s)"));
      }
    }, 300000);
  });
}

function stopPythonService(): void {
  if (pythonProcess) {
    logger.info("Stopping Cortex Memory Python service...");
    pythonProcess.kill();
    pythonProcess = null;
  }
}

async function waitForService(maxAttempts = 30): Promise<void> {
  const apiUrl = "http://127.0.0.1:8765";
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
  if (lower.includes("econnrefused") || lower.includes("enotfound") || 
      lower.includes("abort") || lower.includes("timed out") || lower.includes("fetch failed")) {
    return `Cortex Memory API not reachable. The Python service may not be running. Details: ${message}`;
  }
  return message;
}

async function apiCall<T>(endpoint: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<T> {
  const url = `http://127.0.0.1:8765${endpoint}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const options: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
    signal: controller.signal,
  };
  if (body) options.body = JSON.stringify(body);

  try {
    const response = await fetch(url, options);
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text || response.statusText}`);
    if (!text) return {} as T;
    try { return JSON.parse(text) as T; } 
    catch { throw new Error("Invalid JSON response"); }
  } catch (error) {
    throw new Error(formatApiError(error));
  } finally {
    clearTimeout(timeout);
  }
}

async function searchMemory(args: { query: string; top_k?: number }, _context: ToolContext): Promise<ToolResult> {
  try {
    const result = await apiCall<{ results: unknown[] }>("/search", "POST", {
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

async function storeEvent(
  args: {
    summary: string;
    entities?: Array<{ id?: string; name?: string; type?: string }>;
    outcome?: string;
    relations?: Array<{ source: string; target: string; type: string }>;
  },
  _context: ToolContext
): Promise<ToolResult> {
  try {
    const result = await apiCall<{ event_id: string }>("/event", "POST", {
      summary: args.summary,
      entities: args.entities,
      outcome: args.outcome || "",
      relations: args.relations,
    });
    return { success: true, data: { eventId: result.event_id } };
  } catch (error) {
    const message = formatApiError(error);
    logger.error(`store_event failed: ${message}`);
    return { success: false, error: message };
  }
}

async function queryGraph(args: { entity: string }, _context: ToolContext): Promise<ToolResult> {
  try {
    const result = await apiCall<{ graph: unknown }>("/graph/query", "POST", { entity: args.entity });
    return { success: true, data: result.graph };
  } catch (error) {
    const message = formatApiError(error);
    logger.error(`query_graph failed: ${message}`);
    return { success: false, error: message };
  }
}

async function getHotContext(args: { limit?: number }, _context: ToolContext): Promise<ToolResult> {
  try {
    const result = await apiCall<{ context: string }>(`/hot-context?limit=${args.limit || 20}`);
    return { success: true, data: result.context };
  } catch (error) {
    const message = formatApiError(error);
    logger.error(`get_hot_context failed: ${message}`);
    return { success: false, error: message };
  }
}

async function reflectMemory(_args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
  try {
    await apiCall("/reflect", "POST");
    return { success: true, data: { message: "Reflection complete" } };
  } catch (error) {
    const message = formatApiError(error);
    logger.error(`reflect_memory failed: ${message}`);
    return { success: false, error: message };
  }
}

async function syncMemory(_args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
  try {
    await apiCall("/sync", "POST");
    return { success: true, data: { message: "Sync complete" } };
  } catch (error) {
    const message = formatApiError(error);
    logger.error(`sync_memory failed: ${message}`);
    return { success: false, error: message };
  }
}

async function promoteMemory(_args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
  try {
    await apiCall("/promote", "POST");
    return { success: true, data: { message: "Promotion complete" } };
  } catch (error) {
    const message = formatApiError(error);
    logger.error(`promote_memory failed: ${message}`);
    return { success: false, error: message };
  }
}

async function deleteMemory(args: { memory_id: string }, _context: ToolContext): Promise<ToolResult> {
  try {
    const result = await apiCall<{ deleted_id: string }>(`/memory/${args.memory_id}`, "DELETE");
    return { success: true, data: { deletedId: result.deleted_id } };
  } catch (error) {
    const message = formatApiError(error);
    logger.error(`delete_memory failed: ${message}`);
    return { success: false, error: message };
  }
}

async function updateMemory(
  args: { memory_id: string; text?: string; type?: string; weight?: number },
  _context: ToolContext
): Promise<ToolResult> {
  try {
    const result = await apiCall<{ memory_id: string }>(`/memory/${args.memory_id}`, "PATCH", {
      text: args.text,
      type: args.type,
      weight: args.weight,
    });
    return { success: true, data: { memoryId: result.memory_id } };
  } catch (error) {
    const message = formatApiError(error);
    logger.error(`update_memory failed: ${message}`);
    return { success: false, error: message };
  }
}

async function cleanupMemories(args: { days_old?: number; memory_type?: string }, _context: ToolContext): Promise<ToolResult> {
  try {
    const result = await apiCall<{ deleted_count: number }>("/cleanup", "POST", {
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
  try {
    const result = await apiCall<{
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

async function onMessageHandler(payload: unknown, context: ToolContext): Promise<void> {
  const data = payload as { content?: string; text?: string; source?: string };
  const text = data.content || data.text;
  if (!text) return;
  try {
    await apiCall("/write", "POST", { text, source: data.source || "message" });
    logger.info(`Stored message for session ${context.sessionId}`);
  } catch (error) {
    logger.warn(`Failed to store message: ${formatApiError(error)}`);
  }
}

async function onSessionEndHandler(payload: unknown, context: ToolContext): Promise<void> {
  if (!config?.autoSync) return;
  try {
    await apiCall("/sync", "POST");
    logger.info(`Synced memory for session ${context.sessionId}`);
  } catch (error) {
    logger.warn(`Failed to sync on session end: ${formatApiError(error)}`);
  }
}

async function onTimerHandler(payload: unknown, _context: ToolContext): Promise<void> {
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

export async function register(api: OpenClawPluginApi, userConfig?: Partial<CortexMemoryConfig>): Promise<void> {
  config = { 
    embedding: userConfig?.embedding || { provider: "openai", model: "" },
    llm: userConfig?.llm || { model: "" },
    reranker: userConfig?.reranker || { model: "" },
    dbPath: userConfig?.dbPath,
    autoSync: userConfig?.autoSync ?? defaultConfig.autoSync,
    autoReflect: userConfig?.autoReflect ?? defaultConfig.autoReflect,
  } as CortexMemoryConfig;
  
  logger = api.getLogger();
  logger.info("Registering Cortex Memory plugin...");
  logger.info(`Embedding: ${config.embedding.model} (${config.embedding.provider})`);
  logger.info(`LLM: ${config.llm.model}`);
  logger.info(`Reranker: ${config.reranker.model}`);

  try {
    await startPythonService();
    await waitForService();
    logger.info("Cortex Memory Python service started successfully");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Failed to start Cortex Memory service:", message);
    throw new Error(`Cortex Memory plugin initialization failed: ${message}`);
  }

  process.on("exit", stopPythonService);
  process.on("SIGINT", () => { stopPythonService(); process.exit(0); });
  process.on("SIGTERM", () => { stopPythonService(); process.exit(0); });

  api.registerTool({
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
    execute: async ({ args, context }) => searchMemory(args as { query: string; top_k?: number }, context),
  });

  api.registerTool({
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
    execute: async ({ args, context }) => storeEvent(args as any, context),
  });

  api.registerTool({
    name: "query_graph",
    description: "Query the memory graph for entity relationships",
    parameters: {
      type: "object",
      properties: { entity: { type: "string", description: "Entity name" } },
      required: ["entity"],
    },
    execute: async ({ args, context }) => queryGraph(args as { entity: string }, context),
  });

  api.registerTool({
    name: "get_hot_context",
    description: "Get current hot context including SOUL.md and recent data",
    parameters: {
      type: "object",
      properties: { limit: { type: "number", description: "Max items", default: 20 } },
    },
    execute: async ({ args, context }) => getHotContext(args as { limit?: number }, context),
  });

  api.registerTool({
    name: "reflect_memory",
    description: "Trigger reflection to convert episodic events into semantic knowledge",
    parameters: { type: "object", properties: {} },
    execute: async ({ args, context }) => reflectMemory(args, context),
  });

  api.registerTool({
    name: "sync_memory",
    description: "Sync session data from OpenClaw to memory system",
    parameters: { type: "object", properties: {} },
    execute: async ({ args, context }) => syncMemory(args, context),
  });

  api.registerTool({
    name: "promote_memory",
    description: "Promote frequently accessed memories to core rules",
    parameters: { type: "object", properties: {} },
    execute: async ({ args, context }) => promoteMemory(args, context),
  });

  api.registerTool({
    name: "delete_memory",
    description: "Delete a specific memory by ID",
    parameters: {
      type: "object",
      properties: { memory_id: { type: "string", description: "Memory ID to delete" } },
      required: ["memory_id"],
    },
    execute: async ({ args, context }) => deleteMemory(args as { memory_id: string }, context),
  });

  api.registerTool({
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
    execute: async ({ args, context }) => updateMemory(args as { memory_id: string; text?: string; type?: string; weight?: number }, context),
  });

  api.registerTool({
    name: "cleanup_memories",
    description: "Clean up old memories beyond specified days",
    parameters: {
      type: "object",
      properties: {
        days_old: { type: "number", description: "Delete memories older than this many days (default: 90)" },
        memory_type: { type: "string", description: "Only clean up memories of this type" },
      },
    },
    execute: async ({ args, context }) => cleanupMemories(args as { days_old?: number; memory_type?: string }, context),
  });

  api.registerTool({
    name: "diagnostics",
    description: "Run system diagnostics to check configuration and connectivity",
    parameters: { type: "object", properties: {} },
    execute: async ({ args, context }) => runDiagnostics(args, context),
  });

  api.registerHook({ event: "message", handler: onMessageHandler });
  api.registerHook({ event: "session_end", handler: onSessionEndHandler });
  api.registerHook({ event: "timer", handler: onTimerHandler });

  logger.info("Cortex Memory plugin registered successfully");
}
