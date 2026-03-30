export type EngineMode = "ts";

export interface ToolContext {
  agentId: string;
  sessionId?: string;
  workspaceId: string;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  errorCode?: string;
}

export interface SearchMemoryArgs {
  query: string;
  top_k?: number;
}

export interface StoreEventArgs {
  summary: string;
  entities?: Array<{ id?: string; name?: string; type?: string }>;
  outcome?: string;
  relations?: Array<{ source: string; target: string; type: string }>;
}

export interface QueryGraphArgs {
  entity: string;
  rel?: string;
  dir?: "incoming" | "outgoing" | "both";
  path_to?: string;
  max_depth?: number;
}

export interface GetHotContextArgs {
  limit?: number;
}

export interface GetAutoContextArgs {
  include_hot?: boolean;
}

export interface DeleteMemoryArgs {
  memory_id: string;
}

export interface UpdateMemoryArgs {
  memory_id: string;
  text?: string;
  type?: string;
  weight?: number;
}

export interface CleanupMemoriesArgs {
  days_old?: number;
  memory_type?: string;
}

export interface BackfillEmbeddingsArgs {
  layer?: "active" | "archive" | "all";
  batch_size?: number;
  max_retries?: number;
  retry_failed_only?: boolean;
  rebuild_mode?: "incremental" | "vector_only" | "full";
}
