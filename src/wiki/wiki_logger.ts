import * as fs from "fs";
import * as path from "path";

interface WikiLogEntry {
  memoryRoot: string;
  type: "graph_append" | "conflict_pending" | "conflict_accepted" | "conflict_rejected";
  source_event_id?: string;
  conflict_id?: string;
  message: string;
}

function logPath(memoryRoot: string): string {
  return path.join(memoryRoot, "wiki", "log.md");
}

function ensureParent(filePath: string): void {
  const dirPath = path.dirname(filePath);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function ensureLogHeader(filePath: string): void {
  if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
    return;
  }
  const header = [
    "# Memory Wiki Log",
    "",
    "Auto-generated maintenance log for graph->wiki projection events.",
    "",
  ].join("\n");
  fs.writeFileSync(filePath, `${header}\n`, "utf-8");
}

export function appendWikiLog(entry: WikiLogEntry): void {
  const filePath = logPath(entry.memoryRoot);
  ensureParent(filePath);
  ensureLogHeader(filePath);
  const now = new Date().toISOString();
  const parts = [
    `- [${now}]`,
    entry.type,
    entry.message,
  ];
  if (entry.source_event_id) {
    parts.push(`source_event_id=${entry.source_event_id}`);
  }
  if (entry.conflict_id) {
    parts.push(`conflict_id=${entry.conflict_id}`);
  }
  fs.appendFileSync(filePath, `${parts.join(" | ")}\n`, "utf-8");
}

