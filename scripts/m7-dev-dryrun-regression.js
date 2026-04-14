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

function detailsOf(payload) {
  return payload && typeof payload === "object" ? payload.details : null;
}

async function callTool(tools, name, args = {}) {
  const tool = tools.get(name);
  assert(tool && typeof tool.execute === "function", `${name} tool should be registered`);
  const result = await tool.execute({
    args,
    context: { agentId: "m7-dev", sessionId: "m7-dev", workspaceId: "local" },
  });
  const details = detailsOf(result);
  if (!details || details.status === "error" || details.error) {
    throw new Error(`${name} execution failed: ${JSON.stringify(result)}`);
  }
  return details;
}

async function main() {
  const root = process.cwd();
  const pluginPath = path.join(root, "dist", "index.js");
  const graphStorePath = path.join(root, "dist", "src", "store", "graph_memory_store.js");
  assert(fs.existsSync(pluginPath), "dist/index.js not found. Run npm run build first.");
  assert(fs.existsSync(graphStorePath), "dist/src/store/graph_memory_store.js not found. Run npm run build first.");
  const plugin = require(pluginPath);
  const { createGraphMemoryStore } = require(graphStorePath);

  const tmpRoot = path.join(root, "tmp", `m7-dev-memory-${Date.now().toString(36)}`);
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

  await graphStore.append({
    sourceEventId: "evt_m7_1",
    sourceLayer: "active_only",
    sessionId: "m7-dev",
    sourceFile: "scripts/m7-dev-dryrun-regression.js",
    eventType: "personal_fact",
    entities: ["me", "wife", "08-12"],
    entity_types: { me: "Person", wife: "FamilyMember", "08-12": "Date" },
    relations: [{ source: "wife", target: "08-12", type: "birthday_on", evidence_span: "8月12日", confidence: 0.92 }],
    gateSource: "manual",
    confidence: 0.95,
    sourceText: "我妻子生日是8月12日",
  });
  const pending = await graphStore.append({
    sourceEventId: "evt_m7_2",
    sourceLayer: "active_only",
    sessionId: "m7-dev",
    sourceFile: "scripts/m7-dev-dryrun-regression.js",
    eventType: "personal_fact",
    entities: ["me", "wife", "08-13"],
    entity_types: { me: "Person", wife: "FamilyMember", "08-13": "Date" },
    relations: [{ source: "wife", target: "08-13", type: "birthday_on", evidence_span: "8月13日", confidence: 0.93 }],
    gateSource: "manual",
    confidence: 0.95,
    sourceText: "我妻子生日是8月13日",
  });
  const conflictId = parsePendingConflictId(pending.reason);
  assert(conflictId, "should create at least one pending conflict in dev dry-run");

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

  assert(tools.has("list_graph_conflicts"), `registered tools missing list_graph_conflicts: ${JSON.stringify([...tools.keys()])}`);

  const sync = await callTool(tools, "sync_memory", {});
  const diagnostics = await callTool(tools, "cortex_diagnostics", {});
  const graphView = await callTool(tools, "export_graph_view", { write_snapshot: true });
  const conflicts = await callTool(tools, "list_graph_conflicts", { status: "pending", limit: 20 });
  const lint = await callTool(tools, "lint_memory_wiki", {});

  assert(Array.isArray(graphView.edges) && graphView.edges.length > 0, "graph view should include edges");
  assert(Array.isArray(conflicts.items) && conflicts.items.length > 0, "pending conflicts should be visible");
  assert(Array.isArray(lint.categories) && lint.categories.length >= 6, "lint should report categories");
  const diagnosticsChecks = Array.isArray(diagnostics.checks) ? diagnostics.checks : [];
  const failedDiagnosticsChecks = diagnosticsChecks
    .filter(item => !item || item.passed !== true)
    .map(item => ({
      name: item && typeof item.name === "string" ? item.name : "unknown_check",
      passed: false,
      message: item && typeof item.message === "string" ? item.message : "",
    }));
  const checks = {
    sync_memory_ok: sync && sync.status === "ok",
    diagnostics_ok: failedDiagnosticsChecks.length === 0,
    export_graph_view_ok: Array.isArray(graphView.edges) && graphView.edges.length > 0,
    list_graph_conflicts_ok: Array.isArray(conflicts.items) && conflicts.items.length > 0,
    lint_memory_wiki_ok: Array.isArray(lint.categories) && lint.categories.length >= 6,
  };

  if (typeof plugin.unregister === "function") {
    await plugin.unregister();
  }

  const evidenceDir = path.join(root, "docs", "progress-evidence");
  ensureDir(evidenceDir);
  const evidencePath = path.join(evidenceDir, "M7-dev-dryrun-2026-04-09.json");
  const evidence = {
    generated_at: new Date().toISOString(),
    mode: "development_dry_run_no_backup",
    checks,
    sync_memory: sync,
    diagnostics_summary: diagnosticsChecks,
    diagnostics_failed_checks: failedDiagnosticsChecks,
    graph_view: {
      nodes: Array.isArray(graphView.nodes) ? graphView.nodes.length : 0,
      edges: Array.isArray(graphView.edges) ? graphView.edges.length : 0,
      status_counts: graphView.status_counts || {},
    },
    conflicts: {
      count: conflicts.count || 0,
      sample: Array.isArray(conflicts.items) ? conflicts.items[0] || null : null,
    },
    lint_summary: lint.summary || {},
  };
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf-8");

  console.log(JSON.stringify({
    success: true,
    evidence: evidencePath,
    mode: evidence.mode,
    checks: evidence.checks,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
