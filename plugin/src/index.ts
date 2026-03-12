interface CortexMemoryConfig {
  apiUrl: string;
  autoSync: boolean;
  autoReflect: boolean;
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
  getLogger(): {
    info: (message: string, ...args: unknown[]) => void;
    warn: (message: string, ...args: unknown[]) => void;
    error: (message: string, ...args: unknown[]) => void;
  };
}

declare const process: { env?: Record<string, string | undefined> };

const defaultConfig: CortexMemoryConfig = {
  apiUrl:
    (typeof process !== "undefined" && process.env?.CORTEX_MEMORY_API_URL) ||
    "http://127.0.0.1:8765",
  autoSync: true,
  autoReflect: false,
};

let config: CortexMemoryConfig = { ...defaultConfig };
let logger: ReturnType<OpenClawPluginApi["getLogger"]>;

function formatApiError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("abort") ||
    lower.includes("timed out")
  ) {
    return `Cortex Memory API not reachable or timed out. Ensure it is running at ${config.apiUrl}. Details: ${message}`;
  }
  return message;
}

async function apiCall<T>(
  endpoint: string,
  method: "GET" | "POST" = "GET",
  body?: unknown
): Promise<T> {
  const url = `${config.apiUrl}${endpoint}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const options: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
    signal: controller.signal,
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(url, options);
    const text = await response.text();
    if (!response.ok) {
      const detail = text || response.statusText;
      throw new Error(`HTTP ${response.status}: ${detail}`);
    }
    if (!text) {
      return {} as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error("Invalid JSON response from Cortex Memory API");
    }
  } catch (error) {
    throw new Error(formatApiError(error));
  } finally {
    clearTimeout(timeout);
  }
}

async function searchMemory(
  args: { query: string; top_k?: number },
  _context: ToolContext
): Promise<ToolResult> {
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

async function queryGraph(
  args: { entity: string },
  _context: ToolContext
): Promise<ToolResult> {
  try {
    const result = await apiCall<{ graph: unknown }>("/graph/query", "POST", {
      entity: args.entity,
    });
    return { success: true, data: result.graph };
  } catch (error) {
    const message = formatApiError(error);
    logger.error(`query_graph failed: ${message}`);
    return { success: false, error: message };
  }
}

async function getHotContext(
  args: { limit?: number },
  _context: ToolContext
): Promise<ToolResult> {
  try {
    const limit = args.limit || 20;
    const result = await apiCall<{ context: string }>(
      `/hot-context?limit=${limit}`
    );
    return { success: true, data: result.context };
  } catch (error) {
    const message = formatApiError(error);
    logger.error(`get_hot_context failed: ${message}`);
    return { success: false, error: message };
  }
}

async function reflectMemory(
  _args: Record<string, unknown>,
  _context: ToolContext
): Promise<ToolResult> {
  try {
    await apiCall("/reflect", "POST");
    return { success: true, data: { message: "Reflection complete" } };
  } catch (error) {
    const message = formatApiError(error);
    logger.error(`reflect_memory failed: ${message}`);
    return { success: false, error: message };
  }
}

async function syncMemory(
  _args: Record<string, unknown>,
  _context: ToolContext
): Promise<ToolResult> {
  try {
    await apiCall("/sync", "POST");
    return { success: true, data: { message: "Sync complete" } };
  } catch (error) {
    const message = formatApiError(error);
    logger.error(`sync_memory failed: ${message}`);
    return { success: false, error: message };
  }
}

async function promoteMemory(
  _args: Record<string, unknown>,
  _context: ToolContext
): Promise<ToolResult> {
  try {
    await apiCall("/promote", "POST");
    return { success: true, data: { message: "Promotion complete" } };
  } catch (error) {
    const message = formatApiError(error);
    logger.error(`promote_memory failed: ${message}`);
    return { success: false, error: message };
  }
}

async function onMessageHandler(
  payload: { content?: string; text?: string; source?: string },
  context: ToolContext
): Promise<void> {
  const text = payload.content || payload.text;
  if (!text) return;

  try {
    await apiCall("/write", "POST", {
      text,
      source: payload.source || "message",
    });
    logger.info(`Stored message for session ${context.sessionId}`);
  } catch (error) {
    const message = formatApiError(error);
    logger.warn(`Failed to store message: ${message}`);
  }
}

async function onSessionEndHandler(
  payload: { path?: string },
  context: ToolContext
): Promise<void> {
  if (!config.autoSync) return;

  try {
    await apiCall("/sync", "POST");
    logger.info(`Synced memory for session ${context.sessionId}`);
  } catch (error) {
    const message = formatApiError(error);
    logger.warn(`Failed to sync on session end: ${message}`);
  }
}

async function onTimerHandler(
  payload: { action?: string },
  _context: ToolContext
): Promise<void> {
  const action = payload.action;

  try {
    if (action === "sync") {
      await apiCall("/sync", "POST");
      logger.info("Scheduled sync complete");
    } else if (action === "reflect" || (config.autoReflect && !action)) {
      await apiCall("/reflect", "POST");
      logger.info("Scheduled reflection complete");
    } else if (action === "promote") {
      await apiCall("/promote", "POST");
      logger.info("Scheduled promotion complete");
    }
  } catch (error) {
    const message = formatApiError(error);
    logger.warn(`Timer action failed: ${message}`);
  }
}

export function register(api: OpenClawPluginApi, userConfig?: Partial<CortexMemoryConfig>): void {
  config = { ...defaultConfig, ...userConfig };
  logger = api.getLogger();

  logger.info("Registering Cortex Memory plugin...");

  api.registerTool({
    name: "search_memory",
    description: "Search the long-term semantic memory for relevant information about past interactions, projects, preferences, or technical context",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query to find relevant memories",
        },
        top_k: {
          type: "number",
          description: "Number of results to return (default: 3)",
          default: 3,
        },
      },
      required: ["query"],
    },
    execute: async ({ args, context }) => {
      return searchMemory(args as { query: string; top_k?: number }, context);
    },
  });

  api.registerTool({
    name: "store_event",
    description: "Store a new episodic event or significant milestone in the memory system",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "A brief summary of the event",
        },
        entities: {
          type: "array",
          description: "List of entities involved in the event",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              type: { type: "string" },
            },
          },
        },
        outcome: {
          type: "string",
          description: "The outcome or result of the event",
        },
        relations: {
          type: "array",
          description: "Relationships between entities",
          items: {
            type: "object",
            properties: {
              source: { type: "string" },
              target: { type: "string" },
              type: { type: "string" },
            },
          },
        },
      },
      required: ["summary"],
    },
    execute: async ({ args, context }) => {
      return storeEvent(
        args as {
          summary: string;
          entities?: Array<{ id?: string; name?: string; type?: string }>;
          outcome?: string;
          relations?: Array<{ source: string; target: string; type: string }>;
        },
        context
      );
    },
  });

  api.registerTool({
    name: "query_graph",
    description: "Query the memory graph for relationships involving a specific entity (person, project, technology, etc.)",
    parameters: {
      type: "object",
      properties: {
        entity: {
          type: "string",
          description: "The entity name to query relationships for",
        },
      },
      required: ["entity"],
    },
    execute: async ({ args, context }) => {
      return queryGraph(args as { entity: string }, context);
    },
  });

  api.registerTool({
    name: "get_hot_context",
    description: "Get the current hot context including SOUL.md and recent session data",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of recent items to include (default: 20)",
          default: 20,
        },
      },
    },
    execute: async ({ args, context }) => {
      return getHotContext(args as { limit?: number }, context);
    },
  });

  api.registerTool({
    name: "reflect_memory",
    description: "Trigger the reflection engine to process recent events into long-term semantic knowledge",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async ({ context }) => {
      return reflectMemory({}, context);
    },
  });

  api.registerTool({
    name: "sync_memory",
    description: "Synchronize memory by processing new session data",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async ({ context }) => {
      return syncMemory({}, context);
    },
  });

  api.registerTool({
    name: "promote_memory",
    description: "Promote frequently accessed memories to core rules",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async ({ context }) => {
      return promoteMemory({}, context);
    },
  });

  api.registerHook({
    event: "onMessage",
    handler: async (payload, context) => {
      await onMessageHandler(payload as { content?: string; text?: string; source?: string }, context);
    },
  });

  api.registerHook({
    event: "onSessionEnd",
    handler: async (payload, context) => {
      await onSessionEndHandler(payload as { path?: string }, context);
    },
  });

  api.registerHook({
    event: "onTimer",
    handler: async (payload, context) => {
      await onTimerHandler(payload as { action?: string }, context);
    },
  });

  logger.info("Cortex Memory plugin registered successfully");
}

export default { register };
