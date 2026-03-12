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
        execute: (params: {
            args: Record<string, unknown>;
            context: ToolContext;
        }) => Promise<ToolResult>;
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
export declare function register(api: OpenClawPluginApi, userConfig?: Partial<CortexMemoryConfig>): Promise<void>;
export {};
//# sourceMappingURL=index.d.ts.map