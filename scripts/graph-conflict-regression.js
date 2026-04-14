#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function parsePendingConflictId(reason) {
  if (typeof reason !== "string") return "";
  const hit = reason.match(/^graph_conflict_pending:(.+)$/);
  return hit ? hit[1] : "";
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

async function main() {
  const root = process.cwd();
  const storePath = path.join(root, "dist", "src", "store", "graph_memory_store.js");
  const pluginPath = path.join(root, "dist", "index.js");
  assert(fs.existsSync(storePath), "dist/src/store/graph_memory_store.js not found. Run npm run build first.");
  assert(fs.existsSync(pluginPath), "dist/index.js not found. Run npm run build first.");

  const { createGraphMemoryStore } = require(storePath);
  const plugin = require(pluginPath);
  const tmpRoot = path.join(root, "tmp", `m2-conflict-regression-memory-${Date.now().toString(36)}`);
  ensureDir(tmpRoot);

  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  const graphStore = createGraphMemoryStore({
    projectRoot: root,
    memoryRoot: tmpRoot,
    logger,
    qualityMode: "warn",
  });

  const baseInput = {
    sourceLayer: "active_only",
    sessionId: "m2-conflict-regression",
    sourceFile: "scripts/graph-conflict-regression.js",
    eventType: "personal_fact",
    gateSource: "manual",
    confidence: 0.95,
  };

  const first = await graphStore.append({
    ...baseInput,
    sourceEventId: "evt_m2_1",
    entities: ["User", "Wife", "08-12"],
    entity_types: { User: "Person", Wife: "FamilyMember", "08-12": "Date" },
    relations: [
      {
        source: "Wife",
        target: "08-12",
        type: "birthday_on",
        evidence_span: "8月12日",
        confidence: 0.93,
      },
    ],
    sourceText: "我妻子生日是8月12日",
  });
  assert(first.success === true, "first relation append should succeed");

  const second = await graphStore.append({
    ...baseInput,
    sourceEventId: "evt_m2_2",
    entities: ["User", "Wife", "08-13"],
    entity_types: { User: "Person", Wife: "FamilyMember", "08-13": "Date" },
    relations: [
      {
        source: "Wife",
        target: "08-13",
        type: "birthday_on",
        evidence_span: "8月13日",
        confidence: 0.94,
      },
    ],
    sourceText: "我妻子生日是8月13日",
  });
  const conflictId1 = parsePendingConflictId(second.reason);
  assert(second.success === false && !!conflictId1, "second relation should create pending conflict");

  const pendingList = graphStore.listConflicts({ status: "pending", limit: 20 });
  assert(pendingList.some(item => item.conflict_id === conflictId1), "pending list should include conflict");

  const acceptResult = await graphStore.resolveConflict({ conflictId: conflictId1, action: "accept", note: "accept newer birthday" });
  assert(acceptResult.success === true, "accept should succeed");

  const effectiveAfterAccept = graphStore.loadAll();
  const activeTargetsAfterAccept = effectiveAfterAccept
    .flatMap(record => Array.isArray(record.relations) ? record.relations : [])
    .filter(rel => rel.source === "Wife" && rel.type === "birthday_on")
    .map(rel => rel.target);
  assert(activeTargetsAfterAccept.includes("08-13"), "accepted target should become active");
  assert(!activeTargetsAfterAccept.includes("08-12"), "superseded target should disappear from effective graph");

  const third = await graphStore.append({
    ...baseInput,
    sourceEventId: "evt_m2_3",
    entities: ["User", "Wife", "08-14"],
    entity_types: { User: "Person", Wife: "FamilyMember", "08-14": "Date" },
    relations: [
      {
        source: "Wife",
        target: "08-14",
        type: "birthday_on",
        evidence_span: "8月14日",
        confidence: 0.9,
      },
    ],
    sourceText: "我妻子生日是8月14日",
  });
  const conflictId2 = parsePendingConflictId(third.reason);
  assert(third.success === false && !!conflictId2, "third relation should create second pending conflict");

  const rejectResult = await graphStore.resolveConflict({ conflictId: conflictId2, action: "reject", note: "reject candidate" });
  assert(rejectResult.success === true, "reject should succeed");

  const effectiveAfterReject = graphStore.loadAll();
  const activeTargetsAfterReject = effectiveAfterReject
    .flatMap(record => Array.isArray(record.relations) ? record.relations : [])
    .filter(rel => rel.source === "Wife" && rel.type === "birthday_on")
    .map(rel => rel.target);
  assert(activeTargetsAfterReject.includes("08-13"), "reject should preserve previous active relation");
  assert(!activeTargetsAfterReject.includes("08-14"), "rejected target should not appear in effective graph");

  const supersededPath = path.join(tmpRoot, "graph", "superseded_relations.jsonl");
  assert(fs.existsSync(supersededPath), "superseded_relations ledger should be created");
  const supersededText = fs.readFileSync(supersededPath, "utf-8");
  assert(supersededText.includes("wife|birthday_on|08-12"), "superseded ledger should contain replaced relation");

  const tools = new Map();
  const mockApi = {
    logger,
    config: {},
    pluginConfig: {},
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    unregisterTool(name) {
      tools.delete(name);
    },
    on() {},
    off() {},
    getLogger() {
      return logger;
    },
    getBuiltinMemory() {
      return null;
    },
  };
  plugin.register(mockApi, {
    enabled: true,
    fallbackToBuiltin: false,
    dbPath: tmpRoot,
    graphQualityMode: "warn",
    wikiProjection: {
      enabled: false,
      mode: "off",
      maxBatch: 100,
    },
    embedding: { provider: "openai-compatible", model: "text-embedding-3-small", apiKey: "", baseURL: "" },
    llm: { provider: "openai", model: "gpt-4o-mini", apiKey: "", baseURL: "" },
    reranker: { provider: "", model: "", apiKey: "", baseURL: "" },
  });
  assert(tools.has("list_graph_conflicts"), "list_graph_conflicts tool should be registered");
  assert(tools.has("resolve_graph_conflict"), "resolve_graph_conflict tool should be registered");
  if (typeof plugin.unregister === "function") {
    await plugin.unregister();
  }

  const evidenceDir = path.join(root, "docs", "progress-evidence");
  ensureDir(evidenceDir);
  const evidencePath = path.join(evidenceDir, "M2-conflict-regression-2026-04-09.json");
  const evidence = {
    generated_at: new Date().toISOString(),
    checks: {
      conflict_pending_created: true,
      conflict_accept_updates_effective_view: true,
      conflict_reject_preserves_effective_view: true,
      superseded_ledger_written: true,
      conflict_tools_registered: true,
    },
    conflicts: {
      first_conflict_id: conflictId1,
      second_conflict_id: conflictId2,
      pending_count: graphStore.getConflictStats().pending,
      accepted_count: graphStore.getConflictStats().accepted,
      rejected_count: graphStore.getConflictStats().rejected,
    },
    active_targets_after_accept: activeTargetsAfterAccept,
    active_targets_after_reject: activeTargetsAfterReject,
    superseded_path: supersededPath,
  };
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf-8");

  console.log(JSON.stringify({
    success: true,
    evidence: evidencePath,
    checks: evidence.checks,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
