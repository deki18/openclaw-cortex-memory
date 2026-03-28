import * as fs from "fs";
import * as path from "path";
import { loadGraphSchema, normalizeRelationType } from "../graph/ontology";
import type { MemoryEngine } from "./memory_engine";
import type { ReadStore } from "../store/read_store";
import type { WriteMemoryResult } from "../store/write_store";
import type {
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

interface TsEngineDeps {
  readStore: ReadStore;
  writeStore: {
    writeMemory(args: { text: string; role: string; source: string; sessionId: string }): Promise<WriteMemoryResult>;
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

  async function storeEvent(args: StoreEventArgs, _context: ToolContext): Promise<ToolResult> {
    try {
      if (!args.summary?.trim()) {
        return { success: false, error: "Invalid input provided. Missing 'summary' parameter." };
      }
      const entities = Array.isArray(args.entities)
        ? args.entities.map(item => {
            if (item && typeof item === "object") {
              const value = (item.name || item.id || "") as string;
              return typeof value === "string" ? value.trim() : "";
            }
            return "";
          }).filter(Boolean)
        : [];
      const relations = Array.isArray(args.relations)
        ? args.relations
            .map(item => {
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
      const result = await deps.archiveStore.storeEvents([
        {
          event_type: "manual_event",
          summary: args.summary.trim(),
          entities,
          relations,
          outcome: args.outcome ?? "",
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

  async function runDiagnostics(_args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const { activePath, archivePath } = memoryFiles();
    const checks = [
      { name: "Engine mode", passed: true, message: "TS engine active" },
      { name: "Active sessions store", passed: fs.existsSync(activePath), message: activePath },
      { name: "Archive sessions store", passed: fs.existsSync(archivePath), message: archivePath },
      { name: "Core rules store", passed: fs.existsSync(path.join(deps.memoryRoot, "CORTEX_RULES.md")), message: "CORTEX_RULES.md checked" },
    ];
    return {
      success: true,
      data: {
        status: "ok",
        checks,
        recommendations: [],
      },
    };
  }

  async function searchMemory(args: SearchMemoryArgs, context: ToolContext): Promise<ToolResult> {
    if (!args || !args.query) {
      return {
        success: false,
        error: "Invalid input provided. Missing 'query' parameter.",
      };
    }
    const result = await deps.readStore.searchMemory({
      query: args.query,
      topK: typeof args.top_k === "number" && args.top_k > 0 ? Math.floor(args.top_k) : 3,
    });
    return { success: true, data: result.results };
  }

  async function getHotContext(args: GetHotContextArgs, _context: ToolContext): Promise<ToolResult> {
    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 20;
    const result = await deps.readStore.getHotContext({ limit });
    return { success: true, data: result.context };
  }

  async function getAutoContext(args: GetAutoContextArgs, context: ToolContext): Promise<ToolResult> {
    const sessionId = deps.resolveSessionId(context);
    const cached = deps.getCachedAutoSearch(sessionId);
    const result = await deps.readStore.getAutoContext({
      includeHot: args.include_hot !== false,
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
    runDiagnostics,
    onMessage,
    onSessionEnd,
    onTimer,
  };
}
