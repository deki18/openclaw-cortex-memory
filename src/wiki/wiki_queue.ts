import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

type WikiRebuildEventType = "graph_append" | "conflict_pending" | "conflict_accepted" | "conflict_rejected";

interface WikiRebuildEvent {
  id: string;
  type: WikiRebuildEventType;
  at: string;
  source_event_id?: string;
  conflict_id?: string;
  entities: string[];
  relation_types: string[];
}

interface AppendWikiRebuildEventArgs {
  memoryRoot: string;
  type: WikiRebuildEventType;
  source_event_id?: string;
  conflict_id?: string;
  entities?: string[];
  relation_types?: string[];
}

function queuePath(memoryRoot: string): string {
  return path.join(memoryRoot, "wiki", ".rebuild_queue.jsonl");
}

function ensureParent(filePath: string): void {
  const dirPath = path.dirname(filePath);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function normalizeTextArray(values?: string[]): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(item => (typeof item === "string" ? item.trim() : "")).filter(Boolean))];
}

function createEventId(input: {
  type: string;
  source_event_id?: string;
  conflict_id?: string;
  entities: string[];
  relation_types: string[];
  at: string;
}): string {
  const payload = JSON.stringify({
    type: input.type,
    source_event_id: input.source_event_id || "",
    conflict_id: input.conflict_id || "",
    entities: input.entities,
    relation_types: input.relation_types,
    at: input.at,
  });
  return `wq_${crypto.createHash("sha1").update(payload).digest("hex").slice(0, 16)}`;
}

export function appendWikiRebuildEvent(args: AppendWikiRebuildEventArgs): WikiRebuildEvent {
  const filePath = queuePath(args.memoryRoot);
  const at = new Date().toISOString();
  const entities = normalizeTextArray(args.entities);
  const relation_types = normalizeTextArray(args.relation_types).map(item => item.toLowerCase());
  const entry: WikiRebuildEvent = {
    id: createEventId({
      type: args.type,
      source_event_id: args.source_event_id,
      conflict_id: args.conflict_id,
      entities,
      relation_types,
      at,
    }),
    type: args.type,
    at,
    source_event_id: typeof args.source_event_id === "string" && args.source_event_id.trim() ? args.source_event_id.trim() : undefined,
    conflict_id: typeof args.conflict_id === "string" && args.conflict_id.trim() ? args.conflict_id.trim() : undefined,
    entities,
    relation_types,
  };
  ensureParent(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf-8");
  return entry;
}

export function loadWikiRebuildQueue(memoryRoot: string): WikiRebuildEvent[] {
  const filePath = queuePath(memoryRoot);
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/).filter(Boolean);
  const output: WikiRebuildEvent[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as WikiRebuildEvent;
      if (!parsed || typeof parsed.id !== "string" || !parsed.id.trim()) {
        continue;
      }
      output.push({
        id: parsed.id.trim(),
        type: parsed.type,
        at: typeof parsed.at === "string" ? parsed.at : new Date().toISOString(),
        source_event_id: typeof parsed.source_event_id === "string" ? parsed.source_event_id : undefined,
        conflict_id: typeof parsed.conflict_id === "string" ? parsed.conflict_id : undefined,
        entities: normalizeTextArray(parsed.entities),
        relation_types: normalizeTextArray(parsed.relation_types).map(item => item.toLowerCase()),
      });
    } catch {
      // Ignore malformed line and continue.
    }
  }
  return output;
}

export function drainWikiRebuildQueue(args: {
  memoryRoot: string;
  maxBatch?: number;
}): { drained: WikiRebuildEvent[]; remaining: number } {
  const maxBatch = typeof args.maxBatch === "number" && Number.isFinite(args.maxBatch) && args.maxBatch > 0
    ? Math.min(1000, Math.floor(args.maxBatch))
    : 100;
  const filePath = queuePath(args.memoryRoot);
  const all = loadWikiRebuildQueue(args.memoryRoot);
  if (all.length === 0) {
    return { drained: [], remaining: 0 };
  }
  const drained = all.slice(0, maxBatch);
  const rest = all.slice(drained.length);
  ensureParent(filePath);
  const body = rest.map(item => JSON.stringify(item)).join("\n");
  fs.writeFileSync(filePath, body ? `${body}\n` : "", "utf-8");
  return { drained, remaining: rest.length };
}

export type { WikiRebuildEvent, WikiRebuildEventType };
