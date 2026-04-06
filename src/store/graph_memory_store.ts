import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import {
  GraphQualityMode,
  GraphRelation,
  GraphMemoryRecord,
  loadGraphSchema,
  validateGraphPayload,
} from "../graph/ontology";
import { validateGraphJsonlLine } from "../quality/llm_output_validator";

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
}

interface GraphPayloadInput {
  sourceEventId: string;
  sourceLayer: "archive_event" | "active_only";
  archiveEventId?: string;
  sessionId: string;
  sourceFile?: string;
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
  op: "insert_graph";
  id: string;
  source_event_id: string;
  source_layer: "archive_event" | "active_only";
  archive_event_id?: string;
  timestamp: string;
  session_id: string;
  gate_source: "sync" | "session_end" | "manual";
  entity_count: number;
  relation_count: number;
}

function ensureDirForFile(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function generateGraphId(): string {
  return `gph_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

export function createGraphMemoryStore(options: GraphMemoryStoreOptions): {
  append(input: GraphPayloadInput): Promise<AppendResult>;
  loadAll(): GraphMemoryRecord[];
  loadByArchiveEventId(archiveEventId: string): GraphMemoryRecord[];
  loadByEntity(entityName: string): GraphMemoryRecord[];
  getStats(): { totalRecords: number; totalEntities: number; totalRelations: number };
} {
  const graphMemoryPath = path.join(options.memoryRoot, "graph", "memory.jsonl");
  const mutationLogPath = path.join(options.memoryRoot, "graph", "mutation_log.jsonl");
  const graphSchema = loadGraphSchema(options.projectRoot);

  options.logger.info(`Graph memory store initialized at ${graphMemoryPath}`);

  async function append(input: GraphPayloadInput): Promise<AppendResult> {
    const validation = validateGraphPayload({
      sourceEventId: input.sourceEventId,
      sourceLayer: input.sourceLayer,
      archiveEventId: input.archiveEventId,
      sessionId: input.sessionId,
      sourceFile: input.sourceFile,
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

    const line = JSON.stringify(record);
    const qualityCheck = validateGraphJsonlLine(line);
    if (!qualityCheck.valid) {
      const reason = `graph_record_quality_invalid:${qualityCheck.errors.join("|")}`;
      options.logger.warn(
        `graph_skip_reason=${reason} source_event_id=${input.sourceEventId}`,
      );
      return { success: false, reason };
    }
    if (qualityCheck.warnings.length > 0) {
      options.logger.warn(
        `graph_quality_warning source_event_id=${input.sourceEventId} warnings=${qualityCheck.warnings.join("|")}`,
      );
    }
    const mutationEntry: MutationLogEntry = {
      op: "insert_graph",
      id: record.id,
      source_event_id: record.source_event_id,
      source_layer: record.source_layer,
      archive_event_id: record.archive_event_id,
      timestamp: record.timestamp,
      session_id: record.session_id,
      gate_source: record.gate_source,
      entity_count: record.entities.length,
      relation_count: record.relations.length,
    };
    const mutationLine = JSON.stringify(mutationEntry);

    ensureDirForFile(graphMemoryPath);
    ensureDirForFile(mutationLogPath);

    fs.appendFileSync(graphMemoryPath, `${line}\n`, "utf-8");
    fs.appendFileSync(mutationLogPath, `${mutationLine}\n`, "utf-8");

    options.logger.info(
      `graph_write id=${record.id} source_event_id=${record.source_event_id} source_layer=${record.source_layer} entities=${record.entities.length} relations=${record.relations.length} gate_source=${record.gate_source}`,
    );

    return { success: true, record };
  }

  function loadAll(): GraphMemoryRecord[] {
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

  function loadByArchiveEventId(archiveEventId: string): GraphMemoryRecord[] {
    return loadAll().filter(record => record.archive_event_id === archiveEventId || record.source_event_id === archiveEventId);
  }

  function loadByEntity(entityName: string): GraphMemoryRecord[] {
    const normalized = entityName.trim().toLowerCase();
    return loadAll().filter(record =>
      record.entities.some(entity => entity.trim().toLowerCase() === normalized),
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

  return {
    append,
    loadAll,
    loadByArchiveEventId,
    loadByEntity,
    getStats,
  };
}

export type { GraphMemoryRecord, GraphPayloadInput, AppendResult };
