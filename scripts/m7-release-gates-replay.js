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

function detailsOf(payload) {
  return payload && typeof payload === "object" ? payload.details : null;
}

async function callTool(tools, name, args = {}) {
  const tool = tools.get(name);
  assert(tool && typeof tool.execute === "function", `${name} tool should be registered`);
  const result = await tool.execute({
    args,
    context: { agentId: "m7-gates", sessionId: "m7-gates", workspaceId: "local" },
  });
  const details = detailsOf(result);
  if (!details || details.status === "error" || details.error) {
    throw new Error(`${name} execution failed: ${JSON.stringify(result)}`);
  }
  return details;
}

function round2(value) {
  return Number((Number(value) || 0).toFixed(2));
}

function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

function parsePendingConflictId(reason) {
  if (typeof reason !== "string") return "";
  const hit = reason.match(/^graph_conflict_pending:(.+)$/);
  return hit ? hit[1] : "";
}

function readLastJsonlRecord(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {}
  }
  return null;
}

function readProjectionUpdatedAt(memoryRoot) {
  const projectionIndexPath = path.join(memoryRoot, "wiki", ".projection_index.json");
  if (!fs.existsSync(projectionIndexPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(projectionIndexPath, "utf-8"));
    if (parsed && typeof parsed.updated_at === "string" && parsed.updated_at.trim()) {
      const ts = Date.parse(parsed.updated_at);
      return Number.isFinite(ts) ? ts : null;
    }
  } catch {}
  return null;
}

function readGraphToWikiLagSeconds(memoryRoot) {
  const graphPath = path.join(memoryRoot, "graph", "memory.jsonl");
  const lastGraph = readLastJsonlRecord(graphPath);
  const graphTs = lastGraph && typeof lastGraph.timestamp === "string" ? Date.parse(lastGraph.timestamp) : NaN;
  const projectionTs = readProjectionUpdatedAt(memoryRoot);
  if (!Number.isFinite(graphTs) || !Number.isFinite(projectionTs)) {
    return null;
  }
  const lagMs = Math.max(0, projectionTs - graphTs);
  return lagMs / 1000;
}

function hitExpectedRelation(searchDetails, expectedRelationKey) {
  const rows = searchDetails && Array.isArray(searchDetails.value) ? searchDetails.value : [];
  for (const row of rows) {
    const evidenceIds = Array.isArray(row.evidence_ids) ? row.evidence_ids : [];
    if (evidenceIds.includes(`graph:relation:${expectedRelationKey}`)) {
      return true;
    }
    const text = typeof row.text === "string" ? row.text : "";
    if (text.toLowerCase().includes(expectedRelationKey.toLowerCase())) {
      return true;
    }
  }
  return false;
}

async function main() {
  const root = process.cwd();
  const pluginPath = path.join(root, "dist", "index.js");
  const graphStorePath = path.join(root, "dist", "src", "store", "graph_memory_store.js");
  assert(fs.existsSync(pluginPath), "dist/index.js not found. Run npm run build first.");
  assert(fs.existsSync(graphStorePath), "dist/src/store/graph_memory_store.js not found. Run npm run build first.");

  const plugin = require(pluginPath);
  const { createGraphMemoryStore } = require(graphStorePath);

  const tmpRoot = path.join(root, "tmp", `m7-gates-memory-${Date.now().toString(36)}`);
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
      maxBatch: 200,
    },
  });

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
      maxBatch: 200,
    },
    embedding: { provider: "openai-compatible", model: "text-embedding-3-small", apiKey: "", baseURL: "" },
    llm: { provider: "openai", model: "gpt-4o-mini", apiKey: "", baseURL: "" },
    reranker: { provider: "", model: "", apiKey: "", baseURL: "" },
  });

  assert(tools.has("search_memory"), "search_memory tool should be registered");

  const lagSamples = [];
  const writeFailures = [];
  const primaryPerson = "joe_qa";
  const sourceFile = "scripts/m7-release-gates-replay.js";
  const sourceTextNav = (id) => ({
    layer: "active_only",
    session_id: "m7-gates",
    source_file: sourceFile,
    source_memory_id: id,
    source_event_id: id,
  });

  const writeAttempts = 120;
  let writeSuccess = 0;
  for (let i = 1; i <= writeAttempts; i += 1) {
    const result = await graphStore.append({
      sourceEventId: `evt_gate_write_${i}`,
      sourceLayer: "active_only",
      sessionId: "m7-gates",
      sourceFile,
      eventType: "insight",
      source_text_nav: sourceTextNav(`evt_gate_write_${i}`),
      summary: `${primaryPerson} owns project_${i}; entities include ${primaryPerson} and project_${i}.`,
      entities: [primaryPerson, `project_${i}`],
      entity_types: { [primaryPerson]: "Person", [`project_${i}`]: "Project" },
      relations: [
        {
          source: `project_${i}`,
          target: primaryPerson,
          type: "owned_by",
          evidence_span: `project_${i} is owned by ${primaryPerson}`,
          context_chunk: `The release replay fixture states that project_${i} is owned by ${primaryPerson} and should be persisted as an active relation for gate metrics.`,
          confidence: 0.91,
        },
      ],
      gateSource: "manual",
      confidence: 0.95,
      sourceText: `The release replay fixture states that project_${i} is owned by ${primaryPerson} and should be persisted as an active relation for gate metrics.`,
    });
    if (result.success) {
      writeSuccess += 1;
      const lag = readGraphToWikiLagSeconds(tmpRoot);
      if (typeof lag === "number" && Number.isFinite(lag)) {
        lagSamples.push(lag);
      }
    } else {
      writeFailures.push({ i, reason: result.reason || "unknown" });
    }
  }

  const conflictAttempts = 20;
  let conflictClosureSuccess = 0;
  const conflictFailures = [];
  for (let i = 1; i <= conflictAttempts; i += 1) {
    const person = `wife_${i}`;
    const seed = await graphStore.append({
      sourceEventId: `evt_gate_conflict_seed_${i}`,
      sourceLayer: "active_only",
      sessionId: "m7-gates",
      sourceFile,
      eventType: "personal_fact",
      source_text_nav: sourceTextNav(`evt_gate_conflict_seed_${i}`),
      summary: `${primaryPerson} records ${person} birthday_on 08-12; entities include ${primaryPerson}, ${person}, and 08-12.`,
      entities: [primaryPerson, person, "08-12"],
      entity_types: { [primaryPerson]: "Person", [person]: "FamilyMember", "08-12": "Date" },
      relations: [{
        source: person,
        target: "08-12",
        type: "birthday_on",
        evidence_span: `${person} birthday is 08-12`,
        context_chunk: `${primaryPerson} profile note says ${person} birthday is 08-12 and this is the seed fact for conflict replay validation.`,
        confidence: 0.93,
      }],
      gateSource: "manual",
      confidence: 0.95,
      sourceText: `${primaryPerson} profile note says ${person} birthday is 08-12 and this is the seed fact for conflict replay validation.`,
    });
    if (!seed.success) {
      conflictFailures.push({ i, stage: "seed", reason: seed.reason || "unknown" });
      continue;
    }
    const pending = await graphStore.append({
      sourceEventId: `evt_gate_conflict_pending_${i}`,
      sourceLayer: "active_only",
      sessionId: "m7-gates",
      sourceFile,
      eventType: "personal_fact",
      source_text_nav: sourceTextNav(`evt_gate_conflict_pending_${i}`),
      summary: `${primaryPerson} proposes ${person} birthday_on 08-13; entities include ${primaryPerson}, ${person}, and 08-13.`,
      entities: [primaryPerson, person, "08-13"],
      entity_types: { [primaryPerson]: "Person", [person]: "FamilyMember", "08-13": "Date" },
      relations: [{
        source: person,
        target: "08-13",
        type: "birthday_on",
        evidence_span: `${person} birthday is 08-13`,
        context_chunk: `${primaryPerson} replay note updates ${person} birthday to 08-13, creating a pending conflict candidate for closure-rate checks.`,
        confidence: 0.94,
      }],
      gateSource: "manual",
      confidence: 0.95,
      sourceText: `${primaryPerson} replay note updates ${person} birthday to 08-13, creating a pending conflict candidate for closure-rate checks.`,
    });
    const conflictId = parsePendingConflictId(pending.reason);
    if (!conflictId) {
      conflictFailures.push({ i, stage: "pending", reason: pending.reason || "missing_conflict_id" });
      continue;
    }
    const action = i % 2 === 0 ? "reject" : "accept";
    const resolved = await graphStore.resolveConflict({ conflictId, action, note: `gate_replay_${action}` });
    if (resolved.success) {
      conflictClosureSuccess += 1;
      if (action === "accept") {
        const lag = readGraphToWikiLagSeconds(tmpRoot);
        if (typeof lag === "number" && Number.isFinite(lag)) {
          lagSamples.push(lag);
        }
      }
    } else {
      conflictFailures.push({ i, stage: "resolve", reason: resolved.reason || "unknown" });
    }
  }

  const personalFactCases = [
    { query: "wife_qa birthday", relationKey: "wife_qa|birthday_on|1990-08-12" },
    { query: "child_qa birthday", relationKey: "child_qa|birthday_on|2018-05-01" },
    { query: "where joe_qa lives", relationKey: "joe_qa|lives_in|shanghai" },
  ];

  let baselineHits = 0;
  for (const item of personalFactCases) {
    const search = await callTool(tools, "search_memory", { query: item.query, top_k: 8 });
    if (hitExpectedRelation(search, item.relationKey)) {
      baselineHits += 1;
    }
  }

  const personalWrites = [
    {
      sourceEventId: "evt_pf_1",
      summary: `${primaryPerson} has_spouse wife_qa and wife_qa birthday_on 1990-08-12.`,
      entities: [primaryPerson, "wife_qa", "1990-08-12"],
      entity_types: { [primaryPerson]: "Person", wife_qa: "FamilyMember", "1990-08-12": "Date" },
      relations: [
        {
          source: primaryPerson,
          target: "wife_qa",
          type: "has_spouse",
          evidence_span: `${primaryPerson} spouse is wife_qa`,
          context_chunk: `${primaryPerson} profile confirms spouse is wife_qa and this relation should be recalled in release gate replay.`,
          confidence: 0.93,
        },
        {
          source: "wife_qa",
          target: "1990-08-12",
          type: "birthday_on",
          evidence_span: "wife_qa birthday is 1990-08-12",
          context_chunk: `${primaryPerson} profile note states wife_qa birthday is 1990-08-12 as a stable personal fact for retrieval.`,
          confidence: 0.95,
        },
      ],
      sourceText: `${primaryPerson} profile confirms spouse wife_qa and wife_qa birthday is 1990-08-12 for stable personal memory recall.`,
    },
    {
      sourceEventId: "evt_pf_2",
      summary: `${primaryPerson} has_child child_qa and child_qa birthday_on 2018-05-01.`,
      entities: [primaryPerson, "child_qa", "2018-05-01"],
      entity_types: { [primaryPerson]: "Person", child_qa: "FamilyMember", "2018-05-01": "Date" },
      relations: [
        {
          source: primaryPerson,
          target: "child_qa",
          type: "has_child",
          evidence_span: `${primaryPerson} child is child_qa`,
          context_chunk: `${primaryPerson} profile confirms child_qa is the child and this fact is used in release replay hit-rate checks.`,
          confidence: 0.92,
        },
        {
          source: "child_qa",
          target: "2018-05-01",
          type: "birthday_on",
          evidence_span: "child_qa birthday is 2018-05-01",
          context_chunk: `${primaryPerson} profile note states child_qa birthday is 2018-05-01 and this should be searchable via graph evidence.`,
          confidence: 0.94,
        },
      ],
      sourceText: `${primaryPerson} profile confirms child_qa and child_qa birthday is 2018-05-01 for stable personal memory recall.`,
    },
    {
      sourceEventId: "evt_pf_3",
      summary: `${primaryPerson} lives_in shanghai; entities include ${primaryPerson} and shanghai.`,
      entities: [primaryPerson, "shanghai"],
      entity_types: { [primaryPerson]: "Person", shanghai: "Location" },
      relations: [
        {
          source: primaryPerson,
          target: "shanghai",
          type: "lives_in",
          evidence_span: `${primaryPerson} lives in shanghai`,
          context_chunk: `${primaryPerson} profile note states current residence is shanghai and this location fact is part of release replay coverage.`,
          confidence: 0.9,
        },
      ],
      sourceText: `${primaryPerson} profile note states current residence is shanghai and this location fact is part of release replay coverage.`,
    },
  ];

  for (const item of personalWrites) {
    const result = await graphStore.append({
      sourceEventId: item.sourceEventId,
      sourceLayer: "active_only",
      sessionId: "m7-gates",
      sourceFile,
      eventType: "personal_fact",
      source_text_nav: sourceTextNav(item.sourceEventId),
      summary: item.summary,
      entities: item.entities,
      entity_types: item.entity_types,
      relations: item.relations,
      gateSource: "manual",
      confidence: 0.95,
      sourceText: item.sourceText,
    });
    assert(result.success, `personal_fact write failed: ${result.reason || "unknown"}`);
    const lag = readGraphToWikiLagSeconds(tmpRoot);
    if (typeof lag === "number" && Number.isFinite(lag)) {
      lagSamples.push(lag);
    }
  }

  let currentHits = 0;
  for (const item of personalFactCases) {
    const search = await callTool(tools, "search_memory", { query: item.query, top_k: 8 });
    if (hitExpectedRelation(search, item.relationKey)) {
      currentHits += 1;
    }
  }

  if (typeof plugin.unregister === "function") {
    await plugin.unregister();
  }

  const writeSuccessRate = round2((writeSuccess / Math.max(1, writeAttempts)) * 100);
  const projectionLagP95 = round2(percentile(lagSamples, 95));
  const conflictClosureSuccessRate = round2((conflictClosureSuccess / Math.max(1, conflictAttempts)) * 100);
  const baselineHitRate = baselineHits / Math.max(1, personalFactCases.length);
  const currentHitRate = currentHits / Math.max(1, personalFactCases.length);
  const personalFactLift = round2((currentHitRate - baselineHitRate) * 100);

  const gates = {
    gate_write_success_rate: {
      target: 99,
      current: writeSuccessRate,
      passed: writeSuccessRate >= 99,
      unit: "percent",
    },
    gate_projection_p95: {
      target: 5,
      current: projectionLagP95,
      passed: projectionLagP95 <= 5,
      unit: "seconds",
    },
    gate_conflict_closure_rate: {
      target: 95,
      current: conflictClosureSuccessRate,
      passed: conflictClosureSuccessRate >= 95,
      unit: "percent",
    },
    gate_personal_fact_hit_lift: {
      target: 20,
      current: personalFactLift,
      passed: personalFactLift >= 20,
      unit: "percent",
    },
  };

  const evidenceDir = path.join(root, "docs", "progress-evidence");
  ensureDir(evidenceDir);
  const evidencePath = path.join(evidenceDir, "M7-release-gates-replay-2026-04-09.json");
  const payload = {
    generated_at: new Date().toISOString(),
    mode: "release_gates_replay",
    memory_root: tmpRoot,
    metrics: {
      write_success_rate: {
        attempts: writeAttempts,
        success: writeSuccess,
        failed: writeAttempts - writeSuccess,
        failure_samples: writeFailures.slice(0, 10),
        value: writeSuccessRate,
      },
      wiki_projection_lag_p95: {
        sample_count: lagSamples.length,
        value_seconds: projectionLagP95,
      },
      conflict_closure_success_rate: {
        attempts: conflictAttempts,
        success: conflictClosureSuccess,
        failed: conflictAttempts - conflictClosureSuccess,
        failure_samples: conflictFailures.slice(0, 10),
        value: conflictClosureSuccessRate,
      },
      personal_fact_hit_rate_lift_vs_baseline: {
        baseline_cases: personalFactCases.length,
        baseline_hits: baselineHits,
        baseline_rate: round2(baselineHitRate * 100),
        current_hits: currentHits,
        current_rate: round2(currentHitRate * 100),
        lift: personalFactLift,
      },
    },
    gates,
    all_passed: Object.values(gates).every(item => item.passed),
  };
  fs.writeFileSync(evidencePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");

  console.log(JSON.stringify({
    success: true,
    evidence: evidencePath,
    all_passed: payload.all_passed,
    gates,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
