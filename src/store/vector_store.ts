import * as fs from "fs";
import * as path from "path";

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
  outcome?: string;
  entities?: string[];
  relations?: Array<{ source: string; target: string; type: string }>;
  embedding: number[];
  quality_score: number;
}

interface VectorStoreOptions {
  memoryRoot: string;
  logger: LoggerLike;
}

export function createVectorStore(options: VectorStoreOptions): {
  upsert(record: VectorStoreRecord): Promise<void>;
} {
  const vectorRoot = path.join(options.memoryRoot, "vector");
  const lancedbFilePath = path.join(vectorRoot, "lancedb_events.jsonl");
  const lancedbDir = path.join(vectorRoot, "lancedb");

  async function tryUpsertLanceDb(record: VectorStoreRecord): Promise<boolean> {
    try {
      const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
      const lancedbModule = await dynamicImport("@lancedb/lancedb");
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
        outcome: record.outcome || "",
        entities_json: JSON.stringify(record.entities || []),
        relations_json: JSON.stringify(record.relations || []),
        quality_score: record.quality_score,
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

  async function upsert(record: VectorStoreRecord): Promise<void> {
    if (!record.embedding || record.embedding.length === 0) {
      return;
    }
    const written = await tryUpsertLanceDb(record);
    if (!written) {
      fallbackUpsertJsonl(record);
    }
  }

  options.logger.info(`Vector store initialized at ${vectorRoot}`);
  return { upsert };
}
