"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.register = register;
/// <reference types="node" />
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const defaultConfig = {
    autoSync: true,
    autoReflect: false,
};
let config = null;
let logger;
let pythonProcess = null;
// Find plugin root directory (go up from plugin/dist to project root)
function findProjectRoot() {
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
function validateConfig(cfg) {
    const errors = [];
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
async function startPythonService() {
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
    const env = {
        ...process.env,
        CORTEX_MEMORY_EMBEDDING_PROVIDER: config.embedding.provider,
        CORTEX_MEMORY_EMBEDDING_MODEL: config.embedding.model,
        CORTEX_MEMORY_LLM_PROVIDER: config.llm.provider,
        CORTEX_MEMORY_LLM_MODEL: config.llm.model,
        CORTEX_MEMORY_RERANKER_PROVIDER: config.reranker.provider || "",
        CORTEX_MEMORY_RERANKER_MODEL: config.reranker.model,
        CORTEX_MEMORY_DB_PATH: config.dbPath || path.join(process.env.USERPROFILE || process.env.HOME || "", ".openclaw", "agents", "main", "lancedb_store"),
    };
    // Pass optional API keys and endpoints if specified
    if (config.embedding.apiKey) {
        env.CORTEX_MEMORY_EMBEDDING_API_KEY = config.embedding.apiKey;
    }
    if (config.embedding.baseURL) {
        env.CORTEX_MEMORY_EMBEDDING_BASE_URL = config.embedding.baseURL;
    }
    if (config.reranker.apiKey) {
        env.CORTEX_MEMORY_RERANKER_API_KEY = config.reranker.apiKey;
    }
    if (config.reranker.endpoint) {
        env.CORTEX_MEMORY_RERANKER_ENDPOINT = config.reranker.endpoint;
    }
    return new Promise((resolve, reject) => {
        pythonProcess = (0, child_process_1.spawn)(pythonCmd, ["-m", "api.server"], {
            cwd: projectRoot,
            detached: false,
            windowsHide: true,
            env,
        });
        let started = false;
        pythonProcess.stdout?.on("data", (data) => {
            const output = data.toString();
            logger.info(`[Python] ${output.trim()}`);
            if (output.includes("Cortex Memory API started") || output.includes("Application startup complete")) {
                started = true;
                resolve();
            }
        });
        pythonProcess.stderr?.on("data", (data) => {
            const output = data.toString();
            logger.warn(`[Python] ${output.trim()}`);
            if (output.includes("Cortex Memory API started") && !started) {
                started = true;
                resolve();
            }
        });
        pythonProcess.on("error", (error) => {
            logger.error("Failed to start Python service:", error.message);
            reject(error);
        });
        pythonProcess.on("exit", (code) => {
            if (!started && code !== 0) {
                reject(new Error(`Python service exited with code ${code}`));
            }
        });
        setTimeout(() => {
            if (!started) {
                pythonProcess?.kill();
                reject(new Error("Timeout waiting for Python service to start"));
            }
        }, 30000);
    });
}
function stopPythonService() {
    if (pythonProcess) {
        logger.info("Stopping Cortex Memory Python service...");
        pythonProcess.kill();
        pythonProcess = null;
    }
}
async function waitForService(maxAttempts = 30) {
    const apiUrl = "http://127.0.0.1:8765";
    for (let i = 0; i < maxAttempts; i++) {
        try {
            const response = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(1000) });
            if (response.ok)
                return;
        }
        catch { }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error("Service failed to become ready");
}
function formatApiError(error) {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();
    if (lower.includes("econnrefused") || lower.includes("enotfound") ||
        lower.includes("abort") || lower.includes("timed out") || lower.includes("fetch failed")) {
        return `Cortex Memory API not reachable. The Python service may not be running. Details: ${message}`;
    }
    return message;
}
async function apiCall(endpoint, method = "GET", body) {
    const url = `http://127.0.0.1:8765${endpoint}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const options = {
        method,
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
    };
    if (body)
        options.body = JSON.stringify(body);
    try {
        const response = await fetch(url, options);
        const text = await response.text();
        if (!response.ok)
            throw new Error(`HTTP ${response.status}: ${text || response.statusText}`);
        if (!text)
            return {};
        try {
            return JSON.parse(text);
        }
        catch {
            throw new Error("Invalid JSON response");
        }
    }
    catch (error) {
        throw new Error(formatApiError(error));
    }
    finally {
        clearTimeout(timeout);
    }
}
async function searchMemory(args, _context) {
    try {
        const result = await apiCall("/search", "POST", {
            query: args.query,
            top_k: args.top_k || 3,
        });
        return { success: true, data: result.results };
    }
    catch (error) {
        const message = formatApiError(error);
        logger.error(`search_memory failed: ${message}`);
        return { success: false, error: message };
    }
}
async function storeEvent(args, _context) {
    try {
        const result = await apiCall("/event", "POST", {
            summary: args.summary,
            entities: args.entities,
            outcome: args.outcome || "",
            relations: args.relations,
        });
        return { success: true, data: { eventId: result.event_id } };
    }
    catch (error) {
        const message = formatApiError(error);
        logger.error(`store_event failed: ${message}`);
        return { success: false, error: message };
    }
}
async function queryGraph(args, _context) {
    try {
        const result = await apiCall("/graph/query", "POST", { entity: args.entity });
        return { success: true, data: result.graph };
    }
    catch (error) {
        const message = formatApiError(error);
        logger.error(`query_graph failed: ${message}`);
        return { success: false, error: message };
    }
}
async function getHotContext(args, _context) {
    try {
        const result = await apiCall(`/hot-context?limit=${args.limit || 20}`);
        return { success: true, data: result.context };
    }
    catch (error) {
        const message = formatApiError(error);
        logger.error(`get_hot_context failed: ${message}`);
        return { success: false, error: message };
    }
}
async function reflectMemory(_args, _context) {
    try {
        await apiCall("/reflect", "POST");
        return { success: true, data: { message: "Reflection complete" } };
    }
    catch (error) {
        const message = formatApiError(error);
        logger.error(`reflect_memory failed: ${message}`);
        return { success: false, error: message };
    }
}
async function syncMemory(_args, _context) {
    try {
        await apiCall("/sync", "POST");
        return { success: true, data: { message: "Sync complete" } };
    }
    catch (error) {
        const message = formatApiError(error);
        logger.error(`sync_memory failed: ${message}`);
        return { success: false, error: message };
    }
}
async function promoteMemory(_args, _context) {
    try {
        await apiCall("/promote", "POST");
        return { success: true, data: { message: "Promotion complete" } };
    }
    catch (error) {
        const message = formatApiError(error);
        logger.error(`promote_memory failed: ${message}`);
        return { success: false, error: message };
    }
}
async function onMessageHandler(payload, context) {
    const data = payload;
    const text = data.content || data.text;
    if (!text)
        return;
    try {
        await apiCall("/write", "POST", { text, source: data.source || "message" });
        logger.info(`Stored message for session ${context.sessionId}`);
    }
    catch (error) {
        logger.warn(`Failed to store message: ${formatApiError(error)}`);
    }
}
async function onSessionEndHandler(payload, context) {
    if (!config?.autoSync)
        return;
    try {
        await apiCall("/sync", "POST");
        logger.info(`Synced memory for session ${context.sessionId}`);
    }
    catch (error) {
        logger.warn(`Failed to sync on session end: ${formatApiError(error)}`);
    }
}
async function onTimerHandler(payload, _context) {
    const data = payload;
    const action = data.action;
    try {
        if (action === "sync") {
            await apiCall("/sync", "POST");
            logger.info("Scheduled sync complete");
        }
        else if (action === "reflect" || (config?.autoReflect && !action)) {
            await apiCall("/reflect", "POST");
            logger.info("Scheduled reflection complete");
        }
        else if (action === "promote") {
            await apiCall("/promote", "POST");
            logger.info("Scheduled promotion complete");
        }
    }
    catch (error) {
        logger.warn(`Timer action failed: ${formatApiError(error)}`);
    }
}
async function register(api, userConfig) {
    config = {
        embedding: userConfig?.embedding || { provider: "openai", model: "" },
        llm: userConfig?.llm || { model: "" },
        reranker: userConfig?.reranker || { model: "" },
        dbPath: userConfig?.dbPath,
        autoSync: userConfig?.autoSync ?? defaultConfig.autoSync,
        autoReflect: userConfig?.autoReflect ?? defaultConfig.autoReflect,
    };
    logger = api.getLogger();
    logger.info("Registering Cortex Memory plugin...");
    logger.info(`Embedding: ${config.embedding.model} (${config.embedding.provider})`);
    logger.info(`LLM: ${config.llm.model}`);
    logger.info(`Reranker: ${config.reranker.model}`);
    try {
        await startPythonService();
        await waitForService();
        logger.info("Cortex Memory Python service started successfully");
    }
    catch (error) {
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
        execute: async ({ args, context }) => searchMemory(args, context),
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
        execute: async ({ args, context }) => storeEvent(args, context),
    });
    api.registerTool({
        name: "query_graph",
        description: "Query the memory graph for entity relationships",
        parameters: {
            type: "object",
            properties: { entity: { type: "string", description: "Entity name" } },
            required: ["entity"],
        },
        execute: async ({ args, context }) => queryGraph(args, context),
    });
    api.registerTool({
        name: "get_hot_context",
        description: "Get current hot context including SOUL.md and recent data",
        parameters: {
            type: "object",
            properties: { limit: { type: "number", description: "Max items", default: 20 } },
        },
        execute: async ({ args, context }) => getHotContext(args, context),
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
    api.registerHook({ event: "message", handler: onMessageHandler });
    api.registerHook({ event: "session_end", handler: onSessionEndHandler });
    api.registerHook({ event: "timer", handler: onTimerHandler });
    logger.info("Cortex Memory plugin registered successfully");
}
//# sourceMappingURL=index.js.map