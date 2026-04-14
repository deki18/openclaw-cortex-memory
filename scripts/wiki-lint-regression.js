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

async function main() {
  const root = process.cwd();
  const storePath = path.join(root, "dist", "src", "store", "graph_memory_store.js");
  const pluginPath = path.join(root, "dist", "index.js");
  assert(fs.existsSync(storePath), "dist/src/store/graph_memory_store.js not found. Run npm run build first.");
  assert(fs.existsSync(pluginPath), "dist/index.js not found. Run npm run build first.");
  const { createGraphMemoryStore } = require(storePath);
  const plugin = require(pluginPath);

  const tmpRoot = path.join(root, "tmp", `m5-wiki-lint-memory-${Date.now().toString(36)}`);
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
    wikiProjection: {
      enabled: true,
      mode: "incremental",
      maxBatch: 100,
    },
  });

  await store.append({
    sourceEventId: "evt_m5_1",
    sourceLayer: "active_only",
    sessionId: "m5-regression",
    sourceFile: "scripts/wiki-lint-regression.js",
    eventType: "personal_fact",
    summary: "User records Wife birthday_on 08-12.",
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
    gateSource: "manual",
    confidence: 0.95,
    sourceText: "我妻子生日是8月12日",
  });

  const pending = await store.append({
    sourceEventId: "evt_m5_2",
    sourceLayer: "active_only",
    sessionId: "m5-regression",
    sourceFile: "scripts/wiki-lint-regression.js",
    eventType: "personal_fact",
    summary: "User records Wife birthday_on 08-13.",
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
    gateSource: "manual",
    confidence: 0.95,
    sourceText: "我妻子生日是8月13日",
  });
  const pendingConflictId = parsePendingConflictId(pending.reason);
  assert(pendingConflictId, "should create pending conflict");

  const wikiRoot = path.join(tmpRoot, "wiki");
  const entitiesDir = path.join(wikiRoot, "entities");
  ensureDir(entitiesDir);

  const orphanPath = path.join(entitiesDir, "orphan_entity.md");
  fs.writeFileSync(orphanPath, "# orphan page\n", "utf-8");

  const stalePath = path.join(entitiesDir, "08_12.md");
  fs.writeFileSync(
    stalePath,
    [
      "# Entity: 08-12",
      "",
      "## Current Facts",
      "",
      "- Wife --birthday_on/superseded--> 08-12 (stale)",
      "",
    ].join("\n"),
    "utf-8",
  );

  const graphMemoryPath = path.join(tmpRoot, "graph", "memory.jsonl");
  const rawGapRecord = {
    id: "gph_m5_gap",
    source_event_id: "evt_m5_gap",
    source_layer: "active_only",
    session_id: "m5-regression",
    source_file: "manual-gap",
    timestamp: new Date().toISOString(),
    entities: ["User", "GapEntity"],
    entity_types: { User: "Person", GapEntity: "Concept" },
    relations: [{ source: "User", target: "GapEntity", type: "related_to" }],
    gate_source: "manual",
    event_type: "insight",
    schema_version: "1.0.0",
    confidence: 0.9,
  };
  fs.appendFileSync(graphMemoryPath, `${JSON.stringify(rawGapRecord)}\n`, "utf-8");
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(graphMemoryPath, future, future);

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

  const lintTool = tools.get("lint_memory_wiki");
  assert(lintTool && typeof lintTool.execute === "function", "lint_memory_wiki tool should be registered");
  const lintResult = await lintTool.execute({
    args: {},
    context: { agentId: "m5-regression", sessionId: "m5-regression", workspaceId: "local" },
  });
  const details = lintResult && typeof lintResult === "object" ? lintResult.details : null;
  assert(details && details.status === "ok", "lint_memory_wiki execution failed");

  const categories = Array.isArray(details.categories) ? details.categories : [];
  const issues = Array.isArray(details.issues) ? details.issues : [];
  assert(categories.length >= 6, "lint report should include all categories");
  const issueCategories = new Set(issues.map(item => item.category));
  const requiredIssueCategories = ["pending_conflicts", "projection_lag", "orphan_pages", "stale_claims", "missing_pages", "evidence_gaps"];
  for (const category of requiredIssueCategories) {
    assert(issueCategories.has(category), `lint issues should cover category=${category}`);
  }
  assert(issues.every(item => typeof item.next_action === "string" && item.next_action.trim().length > 0), "every lint issue should include next_action");

  if (typeof plugin.unregister === "function") {
    await plugin.unregister();
  }

  const evidenceDir = path.join(root, "docs", "progress-evidence");
  ensureDir(evidenceDir);
  const evidencePath = path.join(evidenceDir, "M5-lint-regression-2026-04-10.json");
  const evidence = {
    generated_at: new Date().toISOString(),
    checks: {
      lint_categories_covered: categories.length,
      all_required_categories_reported: true,
      next_action_present_for_all_issues: true,
    },
    summary: details.summary,
    categories,
    issue_count: issues.length,
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

