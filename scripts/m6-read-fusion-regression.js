#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function parsePendingConflictId(reason) {
  if (typeof reason !== "string") return "";
  const hit = reason.match(/^graph_conflict_pending:(.+)$/);
  return hit ? hit[1] : "";
}

function readToolDetails(payload) {
  return payload && typeof payload === "object" ? payload.details : null;
}

async function main() {
  const root = process.cwd();
  const pluginPath = path.join(root, "dist", "index.js");
  const graphStorePath = path.join(root, "dist", "src", "store", "graph_memory_store.js");
  assert(fs.existsSync(pluginPath), "dist/index.js not found. Run npm run build first.");
  assert(fs.existsSync(graphStorePath), "dist/src/store/graph_memory_store.js not found. Run npm run build first.");
  const plugin = require(pluginPath);
  const { createGraphMemoryStore } = require(graphStorePath);

  const tmpRoot = path.join(root, "tmp", `m6-read-fusion-memory-${Date.now().toString(36)}`);
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
    wikiProjection: {
      enabled: true,
      mode: "incremental",
      maxBatch: 100,
    },
  });

  const appendBase = {
    sourceLayer: "active_only",
    sessionId: "m6-regression",
    sourceFile: "scripts/m6-read-fusion-regression.js",
    eventType: "personal_fact",
    gateSource: "manual",
    confidence: 0.95,
  };
  const navFor = (id) => ({
    layer: "active_only",
    session_id: "m6-regression",
    source_file: "scripts/m6-read-fusion-regression.js",
    source_memory_id: id,
    source_event_id: id,
  });

  const baseWrite = await graphStore.append({
    ...appendBase,
    sourceEventId: "evt_m6_1",
    source_text_nav: navFor("evt_m6_1"),
    summary: "Joe records Mia birthday_on 1990-08-12; entities include Joe, Mia, and 1990-08-12.",
    entities: ["Joe", "Mia", "1990-08-12"],
    entity_types: { Joe: "Person", Mia: "FamilyMember", "1990-08-12": "Date" },
    relations: [
      {
        source: "Mia",
        target: "1990-08-12",
        type: "birthday_on",
        evidence_span: "Mia birthday is 1990-08-12",
        context_chunk: "Joe wrote that Mia birthday is 1990-08-12 and asked the memory system to preserve this personal fact for recall.",
        confidence: 0.94,
      },
    ],
    sourceText: "Joe wrote that Mia birthday is 1990-08-12 and asked the memory system to preserve this personal fact for recall.",
  });
  assert(baseWrite.success === true, "base graph append failed");

  const conflictWrite = await graphStore.append({
    ...appendBase,
    sourceEventId: "evt_m6_2",
    source_text_nav: navFor("evt_m6_2"),
    summary: "Joe updates Mia birthday_on 1990-08-13; entities include Joe, Mia, and 1990-08-13.",
    entities: ["Joe", "Mia", "1990-08-13"],
    entity_types: { Joe: "Person", Mia: "FamilyMember", "1990-08-13": "Date" },
    relations: [
      {
        source: "Mia",
        target: "1990-08-13",
        type: "birthday_on",
        evidence_span: "Mia birthday is 1990-08-13",
        context_chunk: "Joe submitted a revised statement that Mia birthday should be 1990-08-13, creating a pending conflict candidate.",
        confidence: 0.95,
      },
    ],
    sourceText: "Joe submitted a revised statement that Mia birthday should be 1990-08-13, creating a pending conflict candidate.",
  });
  const pendingConflictId = parsePendingConflictId(conflictWrite.reason);
  assert(conflictWrite.success === false && !!pendingConflictId, "pending conflict should be created");

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
      enabled: true,
      mode: "incremental",
      maxBatch: 100,
    },
    embedding: { provider: "openai-compatible", model: "text-embedding-3-small", apiKey: "", baseURL: "" },
    llm: { provider: "openai", model: "gpt-4o-mini", apiKey: "", baseURL: "" },
    reranker: { provider: "", model: "", apiKey: "", baseURL: "" },
  });

  const queryGraphTool = tools.get("query_graph");
  const searchTool = tools.get("search_memory");
  assert(queryGraphTool && typeof queryGraphTool.execute === "function", "query_graph tool should be registered");
  assert(searchTool && typeof searchTool.execute === "function", "search_memory tool should be registered");

  const queryResult = await queryGraphTool.execute({
    args: { entity: "Mia", dir: "both" },
    context: { agentId: "m6-regression", sessionId: "m6-regression", workspaceId: "local" },
  });
  const queryDetails = readToolDetails(queryResult);
  assert(queryDetails && queryDetails.status === "ok", "query_graph execution failed");
  assert(Array.isArray(queryDetails.wiki_refs) && queryDetails.wiki_refs.length > 0, "query_graph should return wiki_refs");
  assert(Array.isArray(queryDetails.evidence_ids) && queryDetails.evidence_ids.length > 0, "query_graph should return evidence_ids");
  assert(queryDetails.evidence_ids.some(item => typeof item === "string" && item.startsWith("graph:relation:")), "query_graph evidence_ids should include graph relation evidence");
  assert(queryDetails.evidence_ids.some(item => typeof item === "string" && item.startsWith("wiki:")), "query_graph evidence_ids should include wiki anchor evidence");
  assert(queryDetails.conflict_hint && typeof queryDetails.conflict_hint === "object", "query_graph should return conflict_hint when conflicts exist");
  assert(Number(queryDetails.conflict_hint.pending_count || 0) >= 1, "conflict_hint.pending_count should be >= 1");

  const queryEdges = Array.isArray(queryDetails.edges) ? queryDetails.edges : [];
  assert(queryEdges.length >= 1, "query_graph should return at least one edge");
  assert(queryEdges.every(edge => typeof edge.fact_status === "string"), "every query_graph edge should carry fact_status");

  const searchResult = await searchTool.execute({
    args: { query: "Mia birthday 1990-08", top_k: 8 },
    context: { agentId: "m6-regression", sessionId: "m6-regression", workspaceId: "local" },
  });
  const searchDetails = readToolDetails(searchResult);
  assert(searchDetails && searchDetails.status === "ok", "search_memory execution failed");
  const searchItems = Array.isArray(searchDetails.value) ? searchDetails.value : [];
  assert(searchItems.length > 0, "search_memory should return results");
  const graphItems = searchItems.filter(item => item && typeof item === "object" && String(item.source || "").startsWith("sessions_graph"));
  assert(graphItems.length > 0, "search_memory should include graph channel results");
  assert(graphItems.some(item => Array.isArray(item.evidence_ids) && item.evidence_ids.some(e => typeof e === "string" && e.startsWith("wiki:"))), "search_memory graph results should include wiki evidence ids");
  assert(graphItems.some(item => typeof item.fact_status === "string"), "search_memory graph results should expose fact_status");

  if (typeof plugin.unregister === "function") {
    await plugin.unregister();
  }

  const evidenceDir = path.join(root, "docs", "progress-evidence");
  ensureDir(evidenceDir);
  const evidencePath = path.join(evidenceDir, "M6-read-fusion-regression-2026-04-09.json");
  const evidence = {
    generated_at: new Date().toISOString(),
    checks: {
      read_store_wiki_ingestion: true,
      query_graph_wiki_refs_present: true,
      query_graph_conflict_hint_present: true,
      query_graph_evidence_ids_include_graph_and_wiki: true,
      search_memory_graph_results_with_fact_status_and_evidence_ids: true,
    },
    query_graph: {
      wiki_refs: queryDetails.wiki_refs,
      evidence_ids_count: queryDetails.evidence_ids.length,
      conflict_hint: queryDetails.conflict_hint,
      status_counts: queryDetails.status_counts || {},
    },
    search_memory: {
      total_results: searchItems.length,
      graph_results: graphItems.length,
      sample_graph_result: graphItems[0] || null,
    },
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
