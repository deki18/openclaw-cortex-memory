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
  const distIndexPath = path.join(root, "dist", "index.js");
  const graphStorePath = path.join(root, "dist", "src", "store", "graph_memory_store.js");
  assert(fs.existsSync(distIndexPath), "dist/index.js not found. Run npm run build first.");
  assert(fs.existsSync(graphStorePath), "dist/src/store/graph_memory_store.js not found. Run npm run build first.");

  const { createGraphMemoryStore } = require(graphStorePath);
  const plugin = require(distIndexPath);

  const tmpRoot = path.join(root, "tmp", `m3-graph-view-memory-${Date.now().toString(36)}`);
  ensureDir(tmpRoot);

  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  const store = createGraphMemoryStore({
    projectRoot: root,
    memoryRoot: tmpRoot,
    logger,
    qualityMode: "warn",
  });

  const basePayload = {
    sourceLayer: "active_only",
    sessionId: "m3-regression",
    sourceFile: "scripts/graph-view-regression.js",
    eventType: "personal_fact",
    gateSource: "manual",
    confidence: 0.95,
  };
  const navFor = (id) => ({
    layer: "active_only",
    session_id: "m3-regression",
    source_file: "scripts/graph-view-regression.js",
    source_memory_id: id,
    source_event_id: id,
  });

  const r1 = await store.append({
    ...basePayload,
    sourceEventId: "evt_1",
    source_text_nav: navFor("evt_1"),
    summary: "Joe records that Mia birthday_on 1990-08-12; entities include Joe, Mia, and 1990-08-12.",
    entities: ["Joe", "Mia", "1990-08-12"],
    entity_types: { Joe: "Person", Mia: "FamilyMember", "1990-08-12": "Date" },
    relations: [
      {
        source: "Mia",
        type: "birthday_on",
        target: "1990-08-12",
        evidence_span: "Mia birthday is 1990-08-12",
        context_chunk: "Joe wrote in the profile note that Mia birthday is 1990-08-12 and asked the memory graph to keep this fact.",
        confidence: 0.95,
      },
    ],
    sourceText: "Joe wrote in the profile note that Mia birthday is 1990-08-12 and asked the memory graph to keep this fact.",
  });
  assert(r1.success === true, "seed active relation append failed");

  const r2 = await store.append({
    ...basePayload,
    sourceEventId: "evt_2",
    source_text_nav: navFor("evt_2"),
    summary: "Joe updates Mia birthday_on 1990-08-13; entities include Joe, Mia, and 1990-08-13.",
    entities: ["Joe", "Mia", "1990-08-13"],
    entity_types: { Joe: "Person", Mia: "FamilyMember", "1990-08-13": "Date" },
    relations: [
      {
        source: "Mia",
        type: "birthday_on",
        target: "1990-08-13",
        evidence_span: "Mia birthday is 1990-08-13",
        context_chunk: "Joe corrected the profile note and said Mia birthday should be 1990-08-13 after checking the official document.",
        confidence: 0.96,
      },
    ],
    sourceText: "Joe corrected the profile note and said Mia birthday should be 1990-08-13 after checking the official document.",
  });
  const conflict1 = parsePendingConflictId(r2.reason);
  assert(r2.success === false && !!conflict1, "expected first conflict pending");
  const accept1 = await store.resolveConflict({ conflictId: conflict1, action: "accept", note: "accept newer birthday" });
  assert(accept1.success === true, "accept conflict failed");

  const r3 = await store.append({
    ...basePayload,
    sourceEventId: "evt_3",
    source_text_nav: navFor("evt_3"),
    summary: "Joe proposes Mia birthday_on 1990-08-14; entities include Joe, Mia, and 1990-08-14.",
    entities: ["Joe", "Mia", "1990-08-14"],
    entity_types: { Joe: "Person", Mia: "FamilyMember", "1990-08-14": "Date" },
    relations: [
      {
        source: "Mia",
        type: "birthday_on",
        target: "1990-08-14",
        evidence_span: "Mia birthday is 1990-08-14",
        context_chunk: "Joe submitted another correction saying Mia birthday is 1990-08-14, which conflicts with the accepted relation.",
        confidence: 0.9,
      },
    ],
    sourceText: "Joe submitted another correction saying Mia birthday is 1990-08-14, which conflicts with the accepted relation.",
  });
  const conflict2 = parsePendingConflictId(r3.reason);
  assert(r3.success === false && !!conflict2, "expected second conflict pending");
  const reject2 = await store.resolveConflict({ conflictId: conflict2, action: "reject", note: "reject candidate" });
  assert(reject2.success === true, "reject conflict failed");

  const r4 = await store.append({
    ...basePayload,
    sourceEventId: "evt_4",
    source_text_nav: navFor("evt_4"),
    summary: "Joe proposes Mia birthday_on 1990-08-15; entities include Joe, Mia, and 1990-08-15.",
    entities: ["Joe", "Mia", "1990-08-15"],
    entity_types: { Joe: "Person", Mia: "FamilyMember", "1990-08-15": "Date" },
    relations: [
      {
        source: "Mia",
        type: "birthday_on",
        target: "1990-08-15",
        evidence_span: "Mia birthday is 1990-08-15",
        context_chunk: "Joe opened a new candidate claim that Mia birthday is 1990-08-15, so this relation should remain pending conflict.",
        confidence: 0.88,
      },
    ],
    sourceText: "Joe opened a new candidate claim that Mia birthday is 1990-08-15, so this relation should remain pending conflict.",
  });
  const conflict3 = parsePendingConflictId(r4.reason);
  assert(r4.success === false && !!conflict3, "expected third conflict pending");

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
    autoSync: true,
    autoReflect: false,
    graphQualityMode: "warn",
    wikiProjection: {
      enabled: false,
      mode: "off",
      maxBatch: 100,
    },
    dbPath: tmpRoot,
    embedding: { provider: "openai-compatible", model: "text-embedding-3-small", apiKey: "", baseURL: "" },
    llm: { provider: "openai", model: "gpt-4o-mini", apiKey: "", baseURL: "" },
    reranker: { provider: "", model: "", apiKey: "", baseURL: "" },
  });

  const exportTool = tools.get("export_graph_view");
  assert(exportTool && typeof exportTool.execute === "function", "export_graph_view tool not registered");

  const toolResult = await exportTool.execute({
    args: { write_snapshot: true },
    context: { agentId: "m3-regression", sessionId: "m3-regression", workspaceId: "local" },
  });

  const details = toolResult && typeof toolResult === "object" ? toolResult.details : null;
  assert(details && details.status === "ok", "export_graph_view execution failed");

  const statusCounts = details.status_counts || {};
  assert(statusCounts.active >= 1, "missing active edge");
  assert(statusCounts.pending_conflict >= 1, "missing pending_conflict edge");
  assert(statusCounts.superseded >= 1, "missing superseded edge");
  assert(statusCounts.rejected >= 1, "missing rejected edge");
  assert(Array.isArray(details.nodes), "nodes missing");
  assert(Array.isArray(details.edges), "edges missing");
  assert(typeof details.updated_at === "string" && details.updated_at.length > 0, "updated_at missing");

  const edges = details.edges;
  for (const edge of edges) {
    assert(typeof edge.source_event_id === "string" && edge.source_event_id.length > 0, "source_event_id missing on edge");
    assert(typeof edge.evidence_span === "string" && edge.evidence_span.length > 0, "evidence_span missing on edge");
    assert(typeof edge.confidence === "number", "confidence missing on edge");
    if (edge.status === "pending_conflict" || edge.status === "rejected") {
      assert(typeof edge.conflict_id === "string" && edge.conflict_id.length > 0, "conflict_id missing on conflict edge");
    }
  }

  const projection = details.projection || {};
  const viewPath = projection.view_path;
  const timelinePath = projection.timeline_path;
  assert(typeof viewPath === "string" && fs.existsSync(viewPath), "view.json snapshot not created");
  assert(typeof timelinePath === "string" && fs.existsSync(timelinePath), "timeline.jsonl snapshot not created");

  if (typeof plugin.unregister === "function") {
    await plugin.unregister();
  }

  const evidenceDir = path.join(root, "docs", "progress-evidence");
  ensureDir(evidenceDir);
  const evidencePath = path.join(evidenceDir, "M3-graph-view-2026-04-09.json");
  const evidence = {
    generated_at: new Date().toISOString(),
    memory_root: tmpRoot,
    status_counts: statusCounts,
    nodes: details.nodes.length,
    edges: details.edges.length,
    projection,
    checks: {
      tool_available: true,
      status_filterable: ["active", "pending_conflict", "superseded", "rejected"].every((k) => Number(statusCounts[k] || 0) >= 1),
      edge_provenance_fields_present: true,
      snapshot_files_created: true,
    },
  };
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf-8");

  console.log(JSON.stringify({
    success: true,
    evidence: evidencePath,
    view_path: viewPath,
    timeline_path: timelinePath,
    status_counts: statusCounts,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
