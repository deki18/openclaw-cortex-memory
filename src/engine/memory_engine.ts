import type {
  CleanupMemoriesArgs,
  DeleteMemoryArgs,
  EngineMode,
  GetAutoContextArgs,
  GetHotContextArgs,
  QueryGraphArgs,
  SearchMemoryArgs,
  StoreEventArgs,
  ToolContext,
  ToolResult,
  UpdateMemoryArgs,
} from "./types";

export interface MemoryEngine {
  mode: EngineMode;
  searchMemory(args: SearchMemoryArgs, context: ToolContext): Promise<ToolResult>;
  storeEvent(args: StoreEventArgs, context: ToolContext): Promise<ToolResult>;
  queryGraph(args: QueryGraphArgs, context: ToolContext): Promise<ToolResult>;
  getHotContext(args: GetHotContextArgs, context: ToolContext): Promise<ToolResult>;
  getAutoContext(args: GetAutoContextArgs, context: ToolContext): Promise<ToolResult>;
  reflectMemory(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
  syncMemory(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
  promoteMemory(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
  deleteMemory(args: DeleteMemoryArgs, context: ToolContext): Promise<ToolResult>;
  updateMemory(args: UpdateMemoryArgs, context: ToolContext): Promise<ToolResult>;
  cleanupMemories(args: CleanupMemoriesArgs, context: ToolContext): Promise<ToolResult>;
  runDiagnostics(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
  onMessage(payload: unknown, context: ToolContext): Promise<void>;
  onSessionEnd(payload: unknown, context: ToolContext): Promise<void>;
  onTimer(payload: unknown, context: ToolContext): Promise<void>;
}
