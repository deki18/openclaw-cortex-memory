import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";

interface LoggerLike {
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
}

interface VectorStoreRecord {
  id: string;
  session_id: string;
  event_type: string;
  summary: string;
  timestamp: string;
  layer: "active" | "archive";
  source_memory_id: string;
  source_memory_canonical_id?: string;
  source_field?: "summary" | "evidence";
  outcome?: string;
  entities?: string[];
  relations?: Array<{ source: string; target: string; type: string }>;
  embedding: number[];
  quality_score: number;
  char_count: number;
  token_count: number;
  chunk_index?: number;
  chunk_total?: number;
  chunk_start?: number;
  chunk_end?: number;
}

interface VectorStoreOptions {
  memoryRoot: string;
  logger: LoggerLike;
}

export function createVectorStore(options: VectorStoreOptions): {
  upsert(record: VectorStoreRecord): Promise<void>;
  deleteBySourceMemory(args: { layer: "active" | "archive"; sourceMemoryId: string }): Promise<void>;
} {
  const require = createRequire(__filename);
  const vectorRoot = path.join(options.memoryRoot, "vector");
  const lancedbFilePath = path.join(vectorRoot, "lancedb_events.jsonl");
  const lancedbDir = path.join(vectorRoot, "lancedb");

  async function tryUpsertLanceDb(record: VectorStoreRecord): Promise<boolean> {
    try {
      const lancedbModule = require("@lancedb/lancedb") as unknown;
      const connect = (lancedbModule as { connect?: (uri: string) => Promise<unknown> }).connect;
      if (typeof connect !== "function") {
        return false;
      }
      const db = await connect(lancedbDir) as {
        openTable?: (name: string) => Promise<unknown>;
        createTable?: (name: string, rows: unknown[]) => Promise<unknown>;
      };
      if (!db) {
        return false;
      }
      const row = {
        id: record.id,
        session_id: record.session_id,
        event_type: record.event_type,
        summary: record.summary,
        timestamp: record.timestamp,
        layer: record.layer,
        source_memory_id: record.source_memory_id,
        source_memory_canonical_id: record.source_memory_canonical_id || "",
        source_field: record.source_field || "",
        outcome: record.outcome || "",
        entities_json: JSON.stringify(record.entities || []),
        relations_json: JSON.stringify(record.relations || []),
        quality_score: record.quality_score,
        char_count: record.char_count,
        token_count: record.token_count,
        chunk_index: typeof record.chunk_index === "number" ? record.chunk_index : -1,
        chunk_total: typeof record.chunk_total === "number" ? record.chunk_total : 1,
        chunk_start: typeof record.chunk_start === "number" ? record.chunk_start : 0,
        chunk_end: typeof record.chunk_end === "number" ? record.chunk_end : record.char_count,
        vector: record.embedding,
      };
      let table: unknown = null;
      if (typeof db.openTable === "function") {
        try {
          table = await db.openTable("events");
        } catch {
          table = null;
        }
      }
      if (!table && typeof db.createTable === "function") {
        table = await db.createTable("events", [row]);
        options.logger.debug(`LanceDB created table events at ${lancedbDir}`);
        return true;
      }
      const typedTable = table as { add?: (rows: unknown[]) => Promise<void>; delete?: (expr: string) => Promise<void> };
      if (typedTable && typeof typedTable.delete === "function") {
        await typedTable.delete(`id='${record.id.replace(/'/g, "''")}'`);
      }
      if (typedTable && typeof typedTable.add === "function") {
        await typedTable.add([row]);
        return true;
      }
      return false;
    } catch (error) {
      options.logger.warn(`LanceDB upsert failed, fallback to jsonl vector store: ${error}`);
      return false;
    }
  }

  function fallbackUpsertJsonl(record: VectorStoreRecord): void {
    if (!fs.existsSync(vectorRoot)) {
      fs.mkdirSync(vectorRoot, { recursive: true });
    }
    const lines = fs.existsSync(lancedbFilePath)
      ? fs.readFileSync(lancedbFilePath, "utf-8").split(/\r?\n/).filter(Boolean)
      : [];
    const remaining = lines.filter(line => {
      try {
        const parsed = JSON.parse(line) as { id?: string };
        return parsed.id !== record.id;
      } catch {
        return false;
      }
    });
    remaining.push(JSON.stringify(record));
    fs.writeFileSync(lancedbFilePath, `${remaining.join("\n")}\n`, "utf-8");
  }

  async function tryDeleteBySourceMemory(args: { layer: "active" | "archive"; sourceMemoryId: string }): Promise<boolean> {
    try {
      const lancedbModule = require("@lancedb/lancedb") as unknown;
      const connect = (lancedbModule as { connect?: (uri: string) => Promise<unknown> }).connect;
      if (typeof connect !== "function") {
        return false;
      }
      const db = await connect(lancedbDir) as { openTable?: (name: string) => Promise<unknown> };
      if (!db || typeof db.openTable !== "function") {
        return false;
      }
      let table: unknown = null;
      try {
        table = await db.openTable("events");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          /Table\s+'events'\s+was\s+not\s+found/i.test(message) ||
          /events\.lance[\\/]/i.test(message) ||
          /_versions/i.test(message)
        ) {
          options.logger.debug(`LanceDB events table missing at ${lancedbDir}, skip delete as no-op`);
          return true;
        }
        throw error;
      }
      const typedTable = table as { delete?: (expr: string) => Promise<void> };
      if (!typedTable || typeof typedTable.delete !== "function") {
        return false;
      }
      const safeId = args.sourceMemoryId.replace(/'/g, "''");
      await typedTable.delete(`layer='${args.layer}' and source_memory_id='${safeId}'`);
      return true;
    } catch (error) {
      options.logger.warn(`LanceDB deleteBySourceMemory failed, fallback to jsonl cleanup: ${error}`);
      return false;
    }
  }

  function fallbackDeleteBySourceMemory(args: { layer: "active" | "archive"; sourceMemoryId: string }): void {
    if (!fs.existsSync(lancedbFilePath)) {
      return;
    }
    const lines = fs.readFileSync(lancedbFilePath, "utf-8").split(/\r?\n/).filter(Boolean);
    const remaining = lines.filter(line => {
      try {
        const parsed = JSON.parse(line) as { source_memory_id?: string; layer?: string };
        return !(parsed.source_memory_id === args.sourceMemoryId && parsed.layer === args.layer);
      } catch {
        return false;
      }
    });
    fs.writeFileSync(lancedbFilePath, `${remaining.join("\n")}${remaining.length > 0 ? "\n" : ""}`, "utf-8");
  }

  async function upsert(record: VectorStoreRecord): Promise<void> {
    if (!record.embedding || record.embedding.length === 0) {
      return;
    }
    const written = await tryUpsertLanceDb(record);
    if (!written) {
      fallbackUpsertJsonl(record);
    }
  }

  async function deleteBySourceMemory(args: { layer: "active" | "archive"; sourceMemoryId: string }): Promise<void> {
    if (!args.sourceMemoryId) {
      return;
    }
    const deleted = await tryDeleteBySourceMemory(args);
    if (!deleted) {
      fallbackDeleteBySourceMemory(args);
    }
  }

  options.logger.info(`Vector store initialized at ${vectorRoot}`);
  return { upsert, deleteBySourceMemory };
}
