import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import {
  GraphQualityMode,
  GraphRelation,
  GraphMemoryRecord,
  SourceTextNav,
  getEntityMatchKeys,
  loadGraphSchema,
  validateGraphPayload,
} from "../graph/ontology";
import { validateGraphJsonlLine } from "../quality/llm_output_validator";
import { appendWikiRebuildEvent } from "../wiki/wiki_queue";
import { appendWikiLog } from "../wiki/wiki_logger";
import { maintainWikiProjection } from "../wiki/wiki_maintainer";

interface LoggerLike {
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
}

interface GraphMemoryStoreOptions {
  projectRoot: string;
  memoryRoot: string;
  logger: LoggerLike;
  qualityMode?: GraphQualityMode;
  wikiProjection?: {
    enabled?: boolean;
    mode?: "off" | "incremental" | "rebuild";
    maxBatch?: number;
  };
}

interface GraphPayloadInput {
  sourceEventId: string;
  sourceLayer: "archive_event" | "active_only";
  archiveEventId?: string;
  sessionId: string;
  sourceFile?: string;
  source_text_nav?: Partial<SourceTextNav>;
  summary?: string;
  eventType?: string;
  entities?: string[];
  entity_types?: Record<string, string>;
  relations?: GraphRelation[];
  gateSource: "sync" | "session_end" | "manual";
  confidence?: number;
  sourceText?: string;
}

interface AppendResult {
  success: boolean;
  reason?: string;
  record?: GraphMemoryRecord;
}

interface MutationLogEntry {
  op: "insert_graph" | "insert_graph_conflict_resolved" | "supersede_relation";
  id: string;
  source_event_id: string;
  source_layer: "archive_event" | "active_only";
  archive_event_id?: string;
  timestamp: string;
  session_id: string;
  gate_source: "sync" | "session_end" | "manual";
  entity_count: number;
  relation_count: number;
  relation_key?: string;
  conflict_id?: string;
  note?: string;
}

interface GraphConflictRecord {
  conflict_id: string;
  status: "pending" | "accepted" | "rejected";
  created_at: string;
  updated_at: string;
  source_event_id: string;
  source_layer: "archive_event" | "active_only";
  session_id: string;
  source_file?: string;
  conflict_reason: string;
  conflict_types: string[];
  existing_relation_keys: string[];
  existing_relations: Array<{ key: string; relation: GraphRelation }>;
  candidate: {
    summary?: string;
    source_text_nav?: SourceTextNav;
    entities: string[];
    entity_types: Record<string, string>;
    relations: GraphRelation[];
    event_type?: string;
    gate_source: "sync" | "session_end" | "manual";
    confidence?: number;
    source_text?: string;
  };
  fingerprint: string;
  resolution?: {
    action: "accept" | "reject";
    note?: string;
    resolved_at: string;
    applied_record_id?: string;
  };
}

interface GraphConflictSummary {
  conflict_id: string;
  status: "pending" | "accepted" | "rejected";
  created_at: string;
  updated_at: string;
  source_event_id: string;
  session_id: string;
  conflict_reason: string;
  conflict_types: string[];
  existing_relation_keys: string[];
  candidate_relations: Array<{ source: string; type: string; target: string }>;
  resolution?: {
    action: "accept" | "reject";
    note?: string;
    resolved_at: string;
    applied_record_id?: string;
  };
}

type GraphViewStatus = "active" | "pending_conflict" | "superseded" | "rejected";

interface GraphViewNode {
  id: string;
  type: "entity";
}

interface GraphViewEdge {
  source: string;
  target: string;
  type: string;
  status: GraphViewStatus;
  relation_key: string;
  source_event_id?: string;
  evidence_span?: string;
  confidence?: number;
  conflict_id?: string;
}

interface GraphViewData {
  nodes: GraphViewNode[];
  edges: GraphViewEdge[];
  status_counts: Record<GraphViewStatus, number>;
  updated_at: string;
}

interface SupersededRelationEntry {
  relation_key: string;
  superseded_at: string;
  conflict_id?: string;
  note?: string;
}

const SINGLE_VALUE_RELATION_TYPES = new Set<string>([
  "birthday_on",
  "anniversary_on",
  "has_spouse",
  "lives_in",
]);

function ensureDirForFile(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function generateGraphId(): string {
  return `gph_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function generateConflictId(): string {
  return `gcf_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function relationKey(relation: GraphRelation): string {
  const source = (relation.source || "").trim().toLowerCase();
  const type = (relation.type || "related_to").trim().toLowerCase();
  const target = (relation.target || "").trim().toLowerCase();
  return `${source}|${type}|${target}`;
}

function relationBucketKey(relation: GraphRelation): string {
  const source = (relation.source || "").trim().toLowerCase();
  const type = (relation.type || "related_to").trim().toLowerCase();
  return `${source}|${type}`;
}

function normalizeSummary(value: string | undefined): string {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function buildStructureSignature(record: Pick<GraphMemoryRecord, "entities" | "relations">): string {
  const entities = (record.entities || [])
    .map(item => String(item || "").trim().toLowerCase())
    .filter(Boolean)
    .sort();
  const relations = (record.relations || [])
    .map(item => {
      const source = String(item.source || "").trim().toLowerCase();
      const type = String(item.type || "").trim().toLowerCase();
      const target = String(item.target || "").trim().toLowerCase();
      const evidence = String(item.evidence_span || "").trim().toLowerCase();
      const context = String(item.context_chunk || "").trim().toLowerCase();
      return `${source}|${type}|${target}|${evidence}|${context}`;
    })
    .filter(Boolean)
    .sort();
  return `${entities.join("||")}#${relations.join("||")}`;
}

function buildFallbackSummary(entities: string[], relations: GraphRelation[]): string {
  const entityText = (entities || []).map(item => String(item || "").trim()).filter(Boolean).join(", ");
  const relationText = (relations || [])
    .slice(0, 3)
    .map(item => `${item.source} ${item.type} ${item.target}`)
    .join("; ");
  return `Graph memory update covering entities [${entityText || "n/a"}] with relations [${relationText || "n/a"}].`;
}

function toConflictSummary(record: GraphConflictRecord): GraphConflictSummary {
  return {
    conflict_id: record.conflict_id,
    status: record.status,
    created_at: record.created_at,
    updated_at: record.updated_at,
    source_event_id: record.source_event_id,
    session_id: record.session_id,
    conflict_reason: record.conflict_reason,
    conflict_types: record.conflict_types,
    existing_relation_keys: record.existing_relation_keys,
    candidate_relations: (record.candidate.relations || []).map(rel => ({
      source: rel.source,
      type: rel.type,
      target: rel.target,
    })),
    resolution: record.resolution,
  };
}

export function createGraphMemoryStore(options: GraphMemoryStoreOptions): {
  append(input: GraphPayloadInput): Promise<AppendResult>;
  loadAll(): GraphMemoryRecord[];
  loadByArchiveEventId(archiveEventId: string): GraphMemoryRecord[];
  loadByEntity(entityName: string): GraphMemoryRecord[];
  getStats(): { totalRecords: number; totalEntities: number; totalRelations: number };
  exportGraphView(): GraphViewData;
  listConflicts(args?: { status?: "pending" | "accepted" | "rejected" | "all"; limit?: number }): GraphConflictSummary[];
  resolveConflict(args: { conflictId: string; action: "accept" | "reject"; note?: string }): Promise<{ success: boolean; reason?: string; appliedRecordId?: string }>;
  getConflictStats(): { pending: number; accepted: number; rejected: number };
} {
  const graphMemoryPath = path.join(options.memoryRoot, "graph", "memory.jsonl");
  const mutationLogPath = path.join(options.memoryRoot, "graph", "mutation_log.jsonl");
  const graphMemoryMarkdownPath = path.join(options.memoryRoot, "graph", "memory.md");
  const mutationLogMarkdownPath = path.join(options.memoryRoot, "graph", "mutation_log.md");
  const conflictQueuePath = path.join(options.memoryRoot, "graph", "conflict_queue.jsonl");
  const supersededRelationPath = path.join(options.memoryRoot, "graph", "superseded_relations.jsonl");
  const graphSchema = loadGraphSchema(options.projectRoot);
  const wikiProjectionEnabled = options.wikiProjection?.enabled === true && options.wikiProjection?.mode !== "off";
  const wikiProjectionMaxBatch = typeof options.wikiProjection?.maxBatch === "number" && Number.isFinite(options.wikiProjection.maxBatch)
    ? Math.max(1, Math.min(1000, Math.floor(options.wikiProjection.maxBatch)))
    : 100;

  function sanitizeMarkdownInline(value: unknown): string {
    return String(value ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
  }

  function loadMutationLogEntries(): MutationLogEntry[] {
    if (!fs.existsSync(mutationLogPath)) {
      return [];
    }
    const lines = fs.readFileSync(mutationLogPath, "utf-8").split(/\r?\n/).filter(Boolean);
    const output: MutationLogEntry[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as MutationLogEntry;
        if (parsed && typeof parsed.id === "string" && parsed.id.trim()) {
          output.push(parsed);
        }
      } catch {
        options.logger.warn(`graph_mutation_parse_error line=${line.slice(0, 120)}`);
      }
    }
    return output;
  }

  function renderGraphMemoryMarkdown(records: GraphMemoryRecord[]): string {
    const lines: string[] = [
      "# Graph Memory",
      "",
      "> Human-readable mirror of graph/memory.jsonl",
      "",
      `Generated at: ${new Date().toISOString()}`,
      `Total records: ${records.length}`,
      "",
    ];
    if (records.length === 0) {
      lines.push("## Records", "", "- (none)", "");
      return `${lines.join("\n")}\n`;
    }
    lines.push("## Records", "");
    for (const record of records) {
      lines.push(`### ${sanitizeMarkdownInline(record.id)}`);
      lines.push(`- timestamp: ${sanitizeMarkdownInline(record.timestamp)}`);
      lines.push(`- source_event_id: ${sanitizeMarkdownInline(record.source_event_id)}`);
      lines.push(`- source_layer: ${sanitizeMarkdownInline(record.source_layer)}`);
      lines.push(`- session_id: ${sanitizeMarkdownInline(record.session_id)}`);
      if (record.source_file) {
        lines.push(`- source_file: ${sanitizeMarkdownInline(record.source_file)}`);
      }
      lines.push(`- entities: ${(record.entities || []).map(item => sanitizeMarkdownInline(item)).join(", ") || "(none)"}`);
      lines.push(`- summary: ${sanitizeMarkdownInline(record.summary) || "(none)"}`);
      lines.push("- relations:");
      if (!Array.isArray(record.relations) || record.relations.length === 0) {
        lines.push("  - (none)");
      } else {
        for (const relation of record.relations) {
          lines.push(
            `  - ${sanitizeMarkdownInline(relation.source)} --${sanitizeMarkdownInline(relation.type)}--> ${sanitizeMarkdownInline(relation.target)} | confidence=${typeof relation.confidence === "number" ? relation.confidence : "n/a"} | evidence=${sanitizeMarkdownInline(relation.evidence_span) || "n/a"}`,
          );
        }
      }
      lines.push("");
    }
    return `${lines.join("\n")}\n`;
  }

  function renderMutationLogMarkdown(entries: MutationLogEntry[]): string {
    const lines: string[] = [
      "# Graph Mutation Log",
      "",
      "> Human-readable mirror of graph/mutation_log.jsonl",
      "",
      `Generated at: ${new Date().toISOString()}`,
      `Total entries: ${entries.length}`,
      "",
      "## Entries",
      "",
    ];
    if (entries.length === 0) {
      lines.push("- (none)", "");
      return `${lines.join("\n")}\n`;
    }
    for (const entry of entries) {
      lines.push(`### ${sanitizeMarkdownInline(entry.id)}`);
      lines.push(`- op: ${sanitizeMarkdownInline(entry.op)}`);
      lines.push(`- timestamp: ${sanitizeMarkdownInline(entry.timestamp)}`);
      lines.push(`- source_event_id: ${sanitizeMarkdownInline(entry.source_event_id)}`);
      lines.push(`- source_layer: ${sanitizeMarkdownInline(entry.source_layer)}`);
      lines.push(`- session_id: ${sanitizeMarkdownInline(entry.session_id)}`);
      lines.push(`- gate_source: ${sanitizeMarkdownInline(entry.gate_source)}`);
      lines.push(`- entity_count: ${Number.isFinite(entry.entity_count) ? entry.entity_count : 0}`);
      lines.push(`- relation_count: ${Number.isFinite(entry.relation_count) ? entry.relation_count : 0}`);
      if (entry.relation_key) {
        lines.push(`- relation_key: ${sanitizeMarkdownInline(entry.relation_key)}`);
      }
      if (entry.conflict_id) {
        lines.push(`- conflict_id: ${sanitizeMarkdownInline(entry.conflict_id)}`);
      }
      if (entry.note) {
        lines.push(`- note: ${sanitizeMarkdownInline(entry.note)}`);
      }
      lines.push("");
    }
    return `${lines.join("\n")}\n`;
  }

  function refreshMarkdownArtifacts(reason: string): void {
    try {
      const records = loadAllRaw().sort((a, b) => Date.parse(b.timestamp || "") - Date.parse(a.timestamp || ""));
      const mutations = loadMutationLogEntries().sort((a, b) => Date.parse(b.timestamp || "") - Date.parse(a.timestamp || ""));
      ensureDirForFile(graphMemoryMarkdownPath);
      ensureDirForFile(mutationLogMarkdownPath);
      fs.writeFileSync(graphMemoryMarkdownPath, renderGraphMemoryMarkdown(records), "utf-8");
      fs.writeFileSync(mutationLogMarkdownPath, renderMutationLogMarkdown(mutations), "utf-8");
    } catch (error) {
      options.logger.warn(`graph_markdown_refresh_failed reason=${reason} error=${String(error)}`);
    }
  }

  function triggerWikiMaintenance(input: {
    type: "graph_append" | "conflict_pending" | "conflict_accepted" | "conflict_rejected";
    message: string;
    sourceEventId?: string;
    conflictId?: string;
    entities?: string[];
    relationTypes?: string[];
  }): void {
    if (!wikiProjectionEnabled) {
      return;
    }
    try {
      appendWikiRebuildEvent({
        memoryRoot: options.memoryRoot,
        type: input.type,
        source_event_id: input.sourceEventId,
        conflict_id: input.conflictId,
        entities: input.entities,
        relation_types: input.relationTypes,
      });
      appendWikiLog({
        memoryRoot: options.memoryRoot,
        type: input.type,
        source_event_id: input.sourceEventId,
        conflict_id: input.conflictId,
        message: input.message,
      });
      const graphView = exportGraphView();
      maintainWikiProjection({
        memoryRoot: options.memoryRoot,
        graphView,
        maxBatch: wikiProjectionMaxBatch,
        logger: options.logger,
      });
    } catch (error) {
      options.logger.warn(`wiki_projection_maintenance_failed reason=${String(error)}`);
    }
  }

  function rebuildWikiProjectionFromCurrentGraph(): void {
    if (!wikiProjectionEnabled) {
      return;
    }
    const wikiRoot = path.join(options.memoryRoot, "wiki");
    const wikiIndexPath = path.join(wikiRoot, "index.md");
    const wikiProjectionIndexPath = path.join(wikiRoot, ".projection_index.json");
    if (fs.existsSync(wikiIndexPath) && fs.existsSync(wikiProjectionIndexPath)) {
      return;
    }
    try {
      const graphView = exportGraphView();
      if ((graphView.edges || []).length === 0) {
        return;
      }
      maintainWikiProjection({
        memoryRoot: options.memoryRoot,
        graphView,
        maxBatch: wikiProjectionMaxBatch,
        logger: options.logger,
        force: true,
      });
    } catch (error) {
      options.logger.warn(`wiki_projection_bootstrap_failed reason=${String(error)}`);
    }
  }

  function loadSupersededRelationEntries(): SupersededRelationEntry[] {
    if (!fs.existsSync(supersededRelationPath)) {
      return [];
    }
    const lines = fs.readFileSync(supersededRelationPath, "utf-8").split(/\r?\n/).filter(Boolean);
    const entries: SupersededRelationEntry[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as SupersededRelationEntry;
        const relationKeyRaw = typeof parsed.relation_key === "string" ? parsed.relation_key.trim().toLowerCase() : "";
        if (!relationKeyRaw) {
          continue;
        }
        entries.push({
          relation_key: relationKeyRaw,
          superseded_at: typeof parsed.superseded_at === "string" ? parsed.superseded_at : "",
          conflict_id: typeof parsed.conflict_id === "string" ? parsed.conflict_id : undefined,
          note: typeof parsed.note === "string" ? parsed.note : undefined,
        });
      } catch {
        options.logger.warn(`graph_superseded_parse_error line=${line.slice(0, 120)}`);
      }
    }
    return entries;
  }

  function loadSupersededRelationKeys(): Set<string> {
    const keys = new Set<string>();
    for (const entry of loadSupersededRelationEntries()) {
      if (entry.relation_key) {
        keys.add(entry.relation_key);
      }
    }
    return keys;
  }

  function appendSupersededRelationEntries(entries: SupersededRelationEntry[]): void {
    if (entries.length === 0) {
      return;
    }
    ensureDirForFile(supersededRelationPath);
    const lines = entries.map(item => JSON.stringify(item));
    fs.appendFileSync(supersededRelationPath, `${lines.join("\n")}\n`, "utf-8");
  }

  function filterRecordBySuperseded(record: GraphMemoryRecord, supersededKeys: Set<string>): GraphMemoryRecord | null {
    const relations = Array.isArray(record.relations)
      ? record.relations.filter(rel => !supersededKeys.has(relationKey(rel)))
      : [];
    if (relations.length === 0) {
      return null;
    }
    return {
      ...record,
      relations,
    };
  }

  function loadAllRaw(): GraphMemoryRecord[] {
    if (!fs.existsSync(graphMemoryPath)) {
      return [];
    }
    const content = fs.readFileSync(graphMemoryPath, "utf-8");
    const lines = content.split(/\r?\n/).filter(Boolean);
    const records: GraphMemoryRecord[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as GraphMemoryRecord;
        if (parsed && parsed.id && (parsed.source_event_id || parsed.archive_event_id)) {
          if (!parsed.source_event_id && parsed.archive_event_id) {
            parsed.source_event_id = parsed.archive_event_id;
            parsed.source_layer = "archive_event";
          }
          records.push(parsed);
        }
      } catch {
        options.logger.warn(`graph_memory_parse_error line=${line.slice(0, 100)}`);
      }
    }
    return records;
  }

  function loadAllEffective(): GraphMemoryRecord[] {
    const supersededKeys = loadSupersededRelationKeys();
    const raw = loadAllRaw();
    const output: GraphMemoryRecord[] = [];
    for (const record of raw) {
      const filtered = filterRecordBySuperseded(record, supersededKeys);
      if (filtered) {
        output.push(filtered);
      }
    }
    return output;
  }

  function shouldRejectStaleSummary(record: GraphMemoryRecord): boolean {
    const sameSourceRecords = loadAllEffective()
      .filter(item => item.source_event_id === record.source_event_id)
      .sort((a, b) => Date.parse(b.timestamp || "") - Date.parse(a.timestamp || ""));
    if (sameSourceRecords.length === 0) {
      return false;
    }
    const latest = sameSourceRecords[0];
    const previousSummary = normalizeSummary(latest.summary);
    const nextSummary = normalizeSummary(record.summary);
    if (!previousSummary || !nextSummary || previousSummary !== nextSummary) {
      return false;
    }
    const previousSignature = buildStructureSignature(latest);
    const nextSignature = buildStructureSignature(record);
    return previousSignature !== nextSignature;
  }

  function loadConflictQueue(): GraphConflictRecord[] {
    if (!fs.existsSync(conflictQueuePath)) {
      return [];
    }
    const lines = fs.readFileSync(conflictQueuePath, "utf-8").split(/\r?\n/).filter(Boolean);
    const records: GraphConflictRecord[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as GraphConflictRecord;
        if (parsed && typeof parsed.conflict_id === "string" && parsed.conflict_id.trim()) {
          records.push(parsed);
        }
      } catch {
        options.logger.warn(`graph_conflict_parse_error line=${line.slice(0, 120)}`);
      }
    }
    return records;
  }

  function saveConflictQueue(records: GraphConflictRecord[]): void {
    ensureDirForFile(conflictQueuePath);
    const lines = records.map(item => JSON.stringify(item));
    fs.writeFileSync(conflictQueuePath, `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`, "utf-8");
  }

  function appendGraphRecord(args: {
    record: GraphMemoryRecord;
    conflictId?: string;
    note?: string;
  }): void {
    const line = JSON.stringify(args.record);
    const qualityCheck = validateGraphJsonlLine(line);
    if (!qualityCheck.valid) {
      throw new Error(`graph_record_quality_invalid:${qualityCheck.errors.join("|")}`);
    }
    if (qualityCheck.warnings.length > 0) {
      options.logger.warn(
        `graph_quality_warning source_event_id=${args.record.source_event_id} warnings=${qualityCheck.warnings.join("|")}`,
      );
    }
    const mutationEntry: MutationLogEntry = {
      op: args.conflictId ? "insert_graph_conflict_resolved" : "insert_graph",
      id: args.record.id,
      source_event_id: args.record.source_event_id,
      source_layer: args.record.source_layer,
      archive_event_id: args.record.archive_event_id,
      timestamp: args.record.timestamp,
      session_id: args.record.session_id,
      gate_source: args.record.gate_source,
      entity_count: args.record.entities.length,
      relation_count: args.record.relations.length,
      conflict_id: args.conflictId,
      note: args.note,
    };
    ensureDirForFile(graphMemoryPath);
    ensureDirForFile(mutationLogPath);
    fs.appendFileSync(graphMemoryPath, `${line}\n`, "utf-8");
    fs.appendFileSync(mutationLogPath, `${JSON.stringify(mutationEntry)}\n`, "utf-8");
    refreshMarkdownArtifacts("append_graph_record");
  }

  function appendSupersedeMutationLogs(entries: SupersededRelationEntry[], conflictId?: string, sourceEventId?: string): void {
    if (entries.length === 0) {
      return;
    }
    ensureDirForFile(mutationLogPath);
    const nowIso = new Date().toISOString();
    const lines = entries.map(item => JSON.stringify({
      op: "supersede_relation",
      id: `sup_${crypto.createHash("sha1").update(`${item.relation_key}|${item.superseded_at}`).digest("hex").slice(0, 12)}`,
      source_event_id: sourceEventId || "conflict_resolution",
      source_layer: "active_only",
      timestamp: nowIso,
      session_id: "system",
      gate_source: "manual",
      entity_count: 0,
      relation_count: 0,
      relation_key: item.relation_key,
      conflict_id: conflictId,
      note: item.note,
    }));
    fs.appendFileSync(mutationLogPath, `${lines.join("\n")}\n`, "utf-8");
    refreshMarkdownArtifacts("append_supersede_mutation_logs");
  }

  function detectConflicts(candidate: GraphMemoryRecord): {
    hasConflict: boolean;
    reason: string;
    conflictTypes: string[];
    existingRelations: Array<{ key: string; relation: GraphRelation }>;
    existingRelationKeys: string[];
  } {
    const existing = loadAllEffective();
    const candidateSingleValued = (candidate.relations || []).filter(rel => SINGLE_VALUE_RELATION_TYPES.has((rel.type || "").trim().toLowerCase()));
    if (candidateSingleValued.length === 0) {
      return {
        hasConflict: false,
        reason: "",
        conflictTypes: [],
        existingRelations: [],
        existingRelationKeys: [],
      };
    }
    const existingByBucket = new Map<string, Array<{ key: string; relation: GraphRelation }>>();
    for (const record of existing) {
      for (const rel of record.relations || []) {
        const type = (rel.type || "").trim().toLowerCase();
        if (!SINGLE_VALUE_RELATION_TYPES.has(type)) {
          continue;
        }
        const key = relationKey(rel);
        const bucket = relationBucketKey(rel);
        if (!existingByBucket.has(bucket)) {
          existingByBucket.set(bucket, []);
        }
        existingByBucket.get(bucket)?.push({ key, relation: rel });
      }
    }
    const conflictTypes = new Set<string>();
    const existingRelations: Array<{ key: string; relation: GraphRelation }> = [];
    const existingRelationKeySet = new Set<string>();
    for (const rel of candidateSingleValued) {
      const candidateKey = relationKey(rel);
      const bucket = relationBucketKey(rel);
      const sameBucket = existingByBucket.get(bucket) || [];
      for (const existingItem of sameBucket) {
        if (existingItem.key === candidateKey) {
          continue;
        }
        existingRelationKeySet.add(existingItem.key);
        existingRelations.push(existingItem);
        conflictTypes.add((rel.type || "").trim().toLowerCase());
      }
    }
    const existingRelationKeys = [...existingRelationKeySet].sort();
    if (existingRelationKeys.length === 0) {
      return {
        hasConflict: false,
        reason: "",
        conflictTypes: [],
        existingRelations: [],
        existingRelationKeys: [],
      };
    }
    return {
      hasConflict: true,
      reason: `single_value_relation_conflict:${[...conflictTypes].sort().join(",")}`,
      conflictTypes: [...conflictTypes].sort(),
      existingRelations,
      existingRelationKeys,
    };
  }

  function buildConflictFingerprint(input: {
    sourceEventId: string;
    conflictTypes: string[];
    existingRelationKeys: string[];
    candidateRelations: GraphRelation[];
  }): string {
    const payload = JSON.stringify({
      source_event_id: input.sourceEventId,
      conflict_types: [...input.conflictTypes].sort(),
      existing_relation_keys: [...input.existingRelationKeys].sort(),
      candidate_relation_keys: input.candidateRelations.map(relationKey).sort(),
    });
    return crypto.createHash("sha1").update(payload).digest("hex");
  }

  options.logger.info(`Graph memory store initialized at ${graphMemoryPath}`);
  refreshMarkdownArtifacts("startup_init");
  rebuildWikiProjectionFromCurrentGraph();

  async function append(input: GraphPayloadInput): Promise<AppendResult> {
    const validation = validateGraphPayload({
      sourceEventId: input.sourceEventId,
      sourceLayer: input.sourceLayer,
      archiveEventId: input.archiveEventId,
      sessionId: input.sessionId,
      sourceFile: input.sourceFile,
      source_text_nav: input.source_text_nav,
      summary: input.summary,
      eventType: input.eventType,
      entities: input.entities,
      entity_types: input.entity_types,
      relations: input.relations,
      gateSource: input.gateSource,
      confidence: input.confidence,
      schema: graphSchema,
      sourceText: input.sourceText,
      qualityMode: options.qualityMode || "warn",
    });

    if (!validation.valid) {
      options.logger.info(`graph_skip_reason=${validation.reason} source_event_id=${input.sourceEventId}`);
      return { success: false, reason: validation.reason };
    }
    if (Array.isArray(validation.warnings) && validation.warnings.length > 0) {
      options.logger.warn(
        `graph_quality_warning source_event_id=${input.sourceEventId} warnings=${validation.warnings.join("|")}`,
      );
    }

    const record = validation.normalized!;
    record.id = generateGraphId();
    record.timestamp = new Date().toISOString();

    if (shouldRejectStaleSummary(record)) {
      options.logger.info(`graph_skip_reason=stale_summary_after_update source_event_id=${record.source_event_id}`);
      return { success: false, reason: "stale_summary_after_update" };
    }

    const conflictDetection = detectConflicts(record);
    if (conflictDetection.hasConflict) {
      const queue = loadConflictQueue();
      const fingerprint = buildConflictFingerprint({
        sourceEventId: record.source_event_id,
        conflictTypes: conflictDetection.conflictTypes,
        existingRelationKeys: conflictDetection.existingRelationKeys,
        candidateRelations: record.relations,
      });
      const existingPending = queue.find(item => item.status === "pending" && item.fingerprint === fingerprint);
      if (existingPending) {
        options.logger.info(`graph_conflict_pending_reuse conflict_id=${existingPending.conflict_id} source_event_id=${record.source_event_id}`);
        return { success: false, reason: `graph_conflict_pending:${existingPending.conflict_id}` };
      }
      const now = new Date().toISOString();
      const conflictRecord: GraphConflictRecord = {
        conflict_id: generateConflictId(),
        status: "pending",
        created_at: now,
        updated_at: now,
        source_event_id: record.source_event_id,
        source_layer: record.source_layer,
        session_id: record.session_id,
        source_file: record.source_file,
        conflict_reason: conflictDetection.reason,
        conflict_types: conflictDetection.conflictTypes,
        existing_relation_keys: conflictDetection.existingRelationKeys,
        existing_relations: conflictDetection.existingRelations,
        candidate: {
          summary: record.summary,
          source_text_nav: record.source_text_nav,
          entities: record.entities,
          entity_types: record.entity_types,
          relations: record.relations,
          event_type: record.event_type,
          gate_source: record.gate_source,
          confidence: record.confidence,
          source_text: input.sourceText,
        },
        fingerprint,
      };
      queue.push(conflictRecord);
      saveConflictQueue(queue);
      options.logger.info(`graph_conflict_pending id=${conflictRecord.conflict_id} source_event_id=${record.source_event_id} types=${conflictRecord.conflict_types.join(",")}`);
      triggerWikiMaintenance({
        type: "conflict_pending",
        message: "Conflict pending and awaiting confirmation",
        sourceEventId: record.source_event_id,
        conflictId: conflictRecord.conflict_id,
        entities: record.entities,
        relationTypes: (record.relations || []).map(item => item.type),
      });
      return { success: false, reason: `graph_conflict_pending:${conflictRecord.conflict_id}` };
    }

    try {
      appendGraphRecord({ record });
      options.logger.info(
        `graph_write id=${record.id} source_event_id=${record.source_event_id} source_layer=${record.source_layer} entities=${record.entities.length} relations=${record.relations.length} gate_source=${record.gate_source}`,
      );
      triggerWikiMaintenance({
        type: "graph_append",
        message: "Graph relation appended",
        sourceEventId: record.source_event_id,
        entities: record.entities,
        relationTypes: (record.relations || []).map(item => item.type),
      });
      return { success: true, record };
    } catch (error) {
      const reason = String(error);
      options.logger.warn(`graph_skip_reason=${reason} source_event_id=${input.sourceEventId}`);
      return { success: false, reason };
    }
  }

  function loadAll(): GraphMemoryRecord[] {
    return loadAllEffective();
  }

  function loadByArchiveEventId(archiveEventId: string): GraphMemoryRecord[] {
    return loadAll().filter(record => record.archive_event_id === archiveEventId || record.source_event_id === archiveEventId);
  }

  function loadByEntity(entityName: string): GraphMemoryRecord[] {
    const normalized = entityName.trim();
    const queryKeySet = new Set(getEntityMatchKeys(normalized, graphSchema));
    if (queryKeySet.size === 0) {
      return [];
    }
    return loadAll().filter(record =>
      record.entities.some(entity => {
        const entityKeys = getEntityMatchKeys(entity, graphSchema);
        return entityKeys.some(key => queryKeySet.has(key));
      }),
    );
  }

  function getStats(): { totalRecords: number; totalEntities: number; totalRelations: number } {
    const all = loadAll();
    const entitySet = new Set<string>();
    let totalRelations = 0;
    for (const record of all) {
      for (const entity of record.entities) {
        entitySet.add(entity.trim().toLowerCase());
      }
      totalRelations += record.relations.length;
    }
    return {
      totalRecords: all.length,
      totalEntities: entitySet.size,
      totalRelations,
    };
  }

  function parseRelationKey(key: string): { source: string; type: string; target: string } {
    const parts = key.split("|");
    return {
      source: parts[0] || "",
      type: parts[1] || "related_to",
      target: parts.slice(2).join("|") || "",
    };
  }

  function exportGraphView(): GraphViewData {
    const rawRecords = loadAllRaw();
    const activeRecords = loadAllEffective();
    const conflictQueue = loadConflictQueue();
    const supersededEntries = loadSupersededRelationEntries();
    const nodes = new Map<string, GraphViewNode>();
    const edges: GraphViewEdge[] = [];
    const dedupe = new Set<string>();
    let latestTimestampMs = 0;

    function updateLatest(iso?: string): void {
      const ms = Date.parse(iso || "");
      if (Number.isFinite(ms) && ms > latestTimestampMs) {
        latestTimestampMs = ms;
      }
    }

    function addNode(id: string): void {
      const trimmed = id.trim();
      if (!trimmed) {
        return;
      }
      const key = trimmed.toLowerCase();
      if (!nodes.has(key)) {
        nodes.set(key, { id: trimmed, type: "entity" });
      }
    }

    function addEdge(input: {
      source: string;
      target: string;
      type: string;
      status: GraphViewStatus;
      source_event_id?: string;
      evidence_span?: string;
      confidence?: number;
      conflict_id?: string;
    }): void {
      const source = input.source.trim();
      const target = input.target.trim();
      const type = (input.type || "related_to").trim().toLowerCase();
      if (!source || !target || !type) {
        return;
      }
      const relation_key = `${source.toLowerCase()}|${type}|${target.toLowerCase()}`;
      const dedupeKey = `${relation_key}|${input.status}|${(input.conflict_id || "").trim().toLowerCase()}`;
      if (dedupe.has(dedupeKey)) {
        return;
      }
      dedupe.add(dedupeKey);
      addNode(source);
      addNode(target);
      edges.push({
        source,
        target,
        type,
        status: input.status,
        relation_key,
        source_event_id: input.source_event_id,
        evidence_span: input.evidence_span,
        confidence: input.confidence,
        conflict_id: input.conflict_id,
      });
    }

    const relationMetaByKey = new Map<string, { source_event_id: string; evidence_span?: string; confidence?: number; timestamp?: string }>();
    for (const record of rawRecords) {
      updateLatest(record.timestamp);
      for (const rel of record.relations || []) {
        const key = relationKey(rel);
        const prev = relationMetaByKey.get(key);
        if (!prev || Date.parse(record.timestamp || "") >= Date.parse(prev.timestamp || "")) {
          relationMetaByKey.set(key, {
            source_event_id: record.source_event_id,
            evidence_span: rel.evidence_span,
            confidence: rel.confidence,
            timestamp: record.timestamp,
          });
        }
      }
    }

    for (const record of activeRecords) {
      updateLatest(record.timestamp);
      for (const rel of record.relations || []) {
        addEdge({
          source: rel.source,
          target: rel.target,
          type: rel.type,
          status: "active",
          source_event_id: record.source_event_id,
          evidence_span: rel.evidence_span,
          confidence: rel.confidence,
        });
      }
    }

    for (const entry of supersededEntries) {
      updateLatest(entry.superseded_at);
      const parsed = parseRelationKey(entry.relation_key);
      const meta = relationMetaByKey.get(entry.relation_key);
      addEdge({
        source: parsed.source,
        target: parsed.target,
        type: parsed.type,
        status: "superseded",
        source_event_id: meta?.source_event_id,
        evidence_span: meta?.evidence_span,
        confidence: meta?.confidence,
        conflict_id: entry.conflict_id,
      });
    }

    for (const item of conflictQueue) {
      updateLatest(item.updated_at);
      if (item.status !== "pending" && item.status !== "rejected") {
        continue;
      }
      const status: GraphViewStatus = item.status === "pending" ? "pending_conflict" : "rejected";
      for (const rel of item.candidate.relations || []) {
        addEdge({
          source: rel.source,
          target: rel.target,
          type: rel.type,
          status,
          source_event_id: item.source_event_id,
          evidence_span: rel.evidence_span,
          confidence: rel.confidence,
          conflict_id: item.conflict_id,
        });
      }
    }

    const status_counts: Record<GraphViewStatus, number> = {
      active: 0,
      pending_conflict: 0,
      superseded: 0,
      rejected: 0,
    };
    for (const edge of edges) {
      status_counts[edge.status] += 1;
    }

    edges.sort((a, b) => {
      const left = `${a.status}|${a.source.toLowerCase()}|${a.type}|${a.target.toLowerCase()}|${a.conflict_id || ""}`;
      const right = `${b.status}|${b.source.toLowerCase()}|${b.type}|${b.target.toLowerCase()}|${b.conflict_id || ""}`;
      return left.localeCompare(right);
    });

    const nodeList = [...nodes.values()].sort((a, b) => a.id.toLowerCase().localeCompare(b.id.toLowerCase()));
    return {
      nodes: nodeList,
      edges,
      status_counts,
      updated_at: latestTimestampMs > 0 ? new Date(latestTimestampMs).toISOString() : new Date().toISOString(),
    };
  }

  function listConflicts(args?: { status?: "pending" | "accepted" | "rejected" | "all"; limit?: number }): GraphConflictSummary[] {
    const status = args?.status || "pending";
    const limit = typeof args?.limit === "number" && Number.isFinite(args.limit) && args.limit > 0
      ? Math.min(500, Math.floor(args.limit))
      : 50;
    const queue = loadConflictQueue();
    const filtered = queue
      .filter(item => status === "all" ? true : item.status === status)
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
    return filtered.slice(0, limit).map(toConflictSummary);
  }

  function getConflictStats(): { pending: number; accepted: number; rejected: number } {
    const queue = loadConflictQueue();
    let pending = 0;
    let accepted = 0;
    let rejected = 0;
    for (const item of queue) {
      if (item.status === "pending") pending += 1;
      if (item.status === "accepted") accepted += 1;
      if (item.status === "rejected") rejected += 1;
    }
    return { pending, accepted, rejected };
  }

  async function resolveConflict(args: { conflictId: string; action: "accept" | "reject"; note?: string }): Promise<{ success: boolean; reason?: string; appliedRecordId?: string }> {
    const conflictId = (args.conflictId || "").trim();
    if (!conflictId) {
      return { success: false, reason: "conflict_id_empty" };
    }
    const queue = loadConflictQueue();
    const index = queue.findIndex(item => item.conflict_id === conflictId);
    if (index < 0) {
      return { success: false, reason: "conflict_not_found" };
    }
    const current = queue[index];
    if (current.status !== "pending") {
      return { success: false, reason: `conflict_already_${current.status}` };
    }

    const now = new Date().toISOString();
    if (args.action === "reject") {
      current.status = "rejected";
      current.updated_at = now;
      current.resolution = {
        action: "reject",
        note: args.note,
        resolved_at: now,
      };
      queue[index] = current;
      saveConflictQueue(queue);
      options.logger.info(`graph_conflict_rejected id=${conflictId}`);
      triggerWikiMaintenance({
        type: "conflict_rejected",
        message: "Conflict rejected; canonical graph unchanged",
        sourceEventId: current.source_event_id,
        conflictId,
        entities: current.candidate.entities,
        relationTypes: (current.candidate.relations || []).map(item => item.type),
      });
      return { success: true };
    }

    const supersedeEntries: SupersededRelationEntry[] = current.existing_relation_keys.map(key => ({
      relation_key: key,
      superseded_at: now,
      conflict_id: conflictId,
      note: args.note || "conflict_accept_replace",
    }));
    appendSupersededRelationEntries(supersedeEntries);
    appendSupersedeMutationLogs(supersedeEntries, conflictId, current.source_event_id);

    const record: GraphMemoryRecord = {
      id: generateGraphId(),
      summary: (current.candidate.summary || "").trim() || buildFallbackSummary(current.candidate.entities, current.candidate.relations),
      source_text_nav: current.candidate.source_text_nav || {
        layer: current.source_layer,
        session_id: current.session_id,
        source_file: current.source_file || "unknown",
        source_memory_id: current.source_event_id,
        source_event_id: current.source_event_id,
      },
      source_event_id: current.source_event_id,
      source_layer: current.source_layer,
      archive_event_id: current.source_layer === "archive_event" ? current.source_event_id : undefined,
      session_id: current.session_id,
      source_file: current.source_file,
      timestamp: now,
      entities: current.candidate.entities,
      entity_types: current.candidate.entity_types,
      relations: current.candidate.relations,
      gate_source: current.candidate.gate_source,
      event_type: current.candidate.event_type,
      schema_version: "1.0.0",
      confidence: current.candidate.confidence,
    };
    if (shouldRejectStaleSummary(record)) {
      return { success: false, reason: "stale_summary_after_update" };
    }
    try {
      appendGraphRecord({
        record,
        conflictId,
        note: args.note,
      });
    } catch (error) {
      return { success: false, reason: String(error) };
    }

    current.status = "accepted";
    current.updated_at = now;
    current.resolution = {
      action: "accept",
      note: args.note,
      resolved_at: now,
      applied_record_id: record.id,
    };
    queue[index] = current;
    saveConflictQueue(queue);

    options.logger.info(`graph_conflict_accepted id=${conflictId} record_id=${record.id}`);
    triggerWikiMaintenance({
      type: "conflict_accepted",
      message: "Conflict accepted; canonical graph updated",
      sourceEventId: current.source_event_id,
      conflictId,
      entities: current.candidate.entities,
      relationTypes: (current.candidate.relations || []).map(item => item.type),
    });
    return { success: true, appliedRecordId: record.id };
  }

  return {
    append,
    loadAll,
    loadByArchiveEventId,
    loadByEntity,
    getStats,
    exportGraphView,
    listConflicts,
    resolveConflict,
    getConflictStats,
  };
}

export type { GraphMemoryRecord, GraphPayloadInput, AppendResult, GraphConflictSummary, GraphViewData, GraphViewEdge, GraphViewNode, GraphViewStatus };
