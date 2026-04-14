#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const http = require("http");

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

function createQueuedMockLlmServer(responses) {
  return new Promise((resolve, reject) => {
    const queue = Array.isArray(responses) ? [...responses] : [];
    const receivedRequests = [];
    const server = http.createServer((req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      const chunks = [];
      req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        receivedRequests.push(body);
        const responseContent = queue.length > 0 ? queue.shift() : "{}";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: responseContent }, finish_reason: "stop" }],
        }));
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: address.port, receivedRequests });
    });
  });
}

function buildWritePlanObject() {
  return {
    write_plan: {
      candidates: [
        {
          candidate_id: "c1",
          route: "active_only",
          normalized_text: "Active candidate for OpenClaw progress note",
        },
        {
          candidate_id: "c2",
          route: "archive_event",
          normalized_text: "Archive candidate for reusable fix experience",
        },
      ],
      active_payloads: [
        {
          candidate_id: "c1",
          source_slice: "OpenClaw progress note: team reviewed retry strategy and kept release guardrails.",
          summary: "OpenClaw progress note kept retry strategy and release guardrails.",
        },
      ],
      archive_payloads: [
        {
          candidate_id: "c2",
          event_type: "retrospective",
          summary: "OpenClaw sync incident was resolved with adaptive retry strategy.",
          cause: "Rate-limit spikes caused sync failures.",
          process: "Team reviewed traces, tuned retry windows, and validated recovery.",
          result: "Sync stabilized and retry strategy became the recommended pattern.",
          entities: ["OpenClaw sync", "rate-limit spikes", "adaptive retry strategy"],
          entity_types: {
            "OpenClaw sync": "Task",
            "rate-limit spikes": "Issue",
            "adaptive retry strategy": "Fix",
          },
          relations: [
            {
              source: "rate-limit spikes",
              target: "OpenClaw sync",
              type: "blocks",
              relation_origin: "canonical",
              evidence_span: "rate-limit spikes caused sync failures",
              context_chunk: "OpenClaw sync incident analysis showed rate-limit spikes caused sync failures before adaptive retry tuning was applied.",
              confidence: 0.92,
            },
          ],
          confidence: 0.9,
        },
      ],
      graph_payloads: [
        {
          candidate_id: "c1",
          summary: "OpenClaw progress note links retry strategy review with release guardrails.",
          source_text_nav: {
            layer: "active_only",
            session_id: "m5-cross-store-session",
            source_file: "m5-cross-store",
            source_memory_id: "active_c1",
            source_event_id: "active_c1",
          },
          entities: ["OpenClaw progress note", "retry strategy review", "release guardrails"],
          entity_types: {
            "OpenClaw progress note": "Document",
            "retry strategy review": "Task",
            "release guardrails": "Task",
          },
          relations: [
            {
              source: "retry strategy review",
              target: "release guardrails",
              type: "supports",
              relation_origin: "canonical",
              evidence_span: "reviewed retry strategy and kept release guardrails",
              context_chunk: "OpenClaw progress note confirms the team reviewed retry strategy and kept release guardrails during execution.",
              confidence: 0.9,
            },
          ],
          confidence: 0.88,
        },
        {
          candidate_id: "c2",
          summary: "OpenClaw sync incident was resolved by adaptive retry strategy.",
          source_text_nav: {
            layer: "archive_event",
            session_id: "m5-cross-store-session",
            source_file: "m5-cross-store",
            source_memory_id: "archive_c2",
            source_event_id: "archive_c2",
          },
          entities: ["OpenClaw sync", "rate-limit spikes", "adaptive retry strategy"],
          entity_types: {
            "OpenClaw sync": "Task",
            "rate-limit spikes": "Issue",
            "adaptive retry strategy": "Fix",
          },
          relations: [
            {
              source: "adaptive retry strategy",
              target: "OpenClaw sync",
              type: "resolves",
              relation_origin: "canonical",
              evidence_span: "resolved with adaptive retry strategy",
              context_chunk: "OpenClaw sync incident was resolved with adaptive retry strategy after the team reviewed traces and tuned retry windows.",
              confidence: 0.93,
            },
          ],
          confidence: 0.9,
        },
      ],
      merge_hints: [
        { candidate_id: "c1", same_event: false },
        { candidate_id: "c2", same_event: false },
      ],
      graph_rewrite: [
        { candidate_id: "c1", rewrite_required: false },
        { candidate_id: "c2", rewrite_required: false },
      ],
    },
  };
}

function buildStagedGateResponses() {
  const full = buildWritePlanObject().write_plan;
  return [
    JSON.stringify({
      write_plan: {
        candidates: full.candidates,
      },
    }),
    JSON.stringify({
      write_plan: {
        active_payloads: full.active_payloads,
        archive_payloads: full.archive_payloads,
        graph_payloads: full.graph_payloads,
      },
    }),
    JSON.stringify({
      write_plan: {
        merge_hints: full.merge_hints,
        graph_rewrite: full.graph_rewrite,
      },
    }),
  ];
}

function buildLowValueActiveOnlyResponses() {
  return [
    JSON.stringify({
      write_plan: {
        candidates: [
          {
            candidate_id: "c_low",
            route: "active_only",
            normalized_text: "ok received thanks",
          },
        ],
      },
    }),
    JSON.stringify({
      write_plan: {
        active_payloads: [
          {
            candidate_id: "c_low",
            source_slice: "ok received thanks",
            summary: "ok received thanks",
          },
        ],
        archive_payloads: [],
        graph_payloads: [],
      },
    }),
    JSON.stringify({
      write_plan: {
        merge_hints: [{ candidate_id: "c_low", same_event: false }],
        graph_rewrite: [{ candidate_id: "c_low", rewrite_required: false }],
      },
    }),
  ];
}

async function runCrossStoreIsolationCheck(root, sessionSyncPath) {
  const { createSessionSync } = require(sessionSyncPath);
  const { server, port, receivedRequests } = await createQueuedMockLlmServer(buildStagedGateResponses());
  const writeCalls = [];
  const archiveCalls = [];
  const graphCalls = [];

  try {
    const sessionSync = createSessionSync({
      projectRoot: root,
      dbPath: path.join(root, "tmp", `m5-cross-store-session-${Date.now().toString(36)}`),
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
      },
      llm: {
        model: "mock-llm",
        apiKey: "mock-key",
        baseURL: `http://127.0.0.1:${port}`,
      },
      requireLlmForWrite: true,
      writeStore: {
        async writeMemory(args) {
          writeCalls.push(args);
          return { status: "ok" };
        },
      },
      archiveStore: {
        async storeEvents(events) {
          archiveCalls.push(events);
          return {
            stored: events.map((event, index) => ({ id: `archive_${index + 1}` })),
            skipped: [],
          };
        },
      },
      graphMemoryStore: {
        async append(input) {
          graphCalls.push(input);
          return { success: false, reason: "simulated_graph_failure" };
        },
      },
    });

    const routed = await sessionSync.routeTranscript({
      sessionId: "m5-cross-store-session",
      sourceFile: "m5-cross-store",
      transcript: "OpenClaw incident note: retry strategy stabilized sync and guardrails were retained.",
    });

    assert(routed.ok === true, "routeTranscript should stay successful when graph write fails");
    assert(routed.activeOnly === 1, "active_only candidate should still be stored");
    assert(routed.archiveEvent === 1, "archive_event candidate should still be stored");
    assert(routed.imported >= 2, "imported count should include active and archive writes");
    assert(writeCalls.length === 1, "writeStore should be called once");
    assert(archiveCalls.length === 1, "archiveStore should be called once");
    assert(graphCalls.length >= 2, "graph append should be attempted for both candidates");
    assert(receivedRequests.length >= 3, "staged gate should call LLM at least 3 times (A+B, C, D)");
    assert(receivedRequests.some(body => body.includes("write-gate.ab.v1.1.5")), "stage A+B prompt version missing");
    assert(receivedRequests.some(body => body.includes("write-gate.c.v1.5.0")), "stage C prompt version missing");
    assert(receivedRequests.some(body => body.includes("write-gate.d.v1.1.0")), "stage D prompt version missing");

    return {
      routed,
      llm_stage_calls: receivedRequests.length,
      write_calls: writeCalls.length,
      archive_calls: archiveCalls.length,
      graph_calls: graphCalls.length,
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runActiveLowValueGuardCheck(root, sessionSyncPath) {
  const { createSessionSync } = require(sessionSyncPath);
  const { server, port, receivedRequests } = await createQueuedMockLlmServer(buildLowValueActiveOnlyResponses());
  const writeCalls = [];
  try {
    const sessionSync = createSessionSync({
      projectRoot: root,
      dbPath: path.join(root, "tmp", `m5-low-value-guard-${Date.now().toString(36)}`),
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
      },
      llm: {
        model: "mock-llm",
        apiKey: "mock-key",
        baseURL: `http://127.0.0.1:${port}`,
      },
      requireLlmForWrite: true,
      writeStore: {
        async writeMemory(args) {
          writeCalls.push(args);
          return { status: "ok" };
        },
      },
      archiveStore: {
        async storeEvents() {
          return { stored: [], skipped: [] };
        },
      },
      graphMemoryStore: {
        async append() {
          return { success: true };
        },
      },
    });

    const routed = await sessionSync.routeTranscript({
      sessionId: "m5-low-value-session",
      sourceFile: "m5-cross-store-low-value",
      transcript: "ok received thanks",
    });

    assert(receivedRequests.length === 3, "low-value active check should still use staged gate");
    assert(writeCalls.length === 0, "low-value active_only text must not be written into active store");
    assert((routed.skipReasons && routed.skipReasons.active_only_low_value) >= 1, "active_only_low_value reason should be recorded");

    return {
      routed,
      llm_stage_calls: receivedRequests.length,
      write_calls: writeCalls.length,
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runWikiFailureNoRollbackCheck(root, graphStorePath, wikiMaintainerPath) {
  const graphStoreModule = require(graphStorePath);
  const wikiMaintainerModule = require(wikiMaintainerPath);
  const originalMaintain = wikiMaintainerModule.maintainWikiProjection;

  assert(typeof originalMaintain === "function", "maintainWikiProjection must be a function");

  wikiMaintainerModule.maintainWikiProjection = function patchedMaintainWikiProjection() {
    throw new Error("simulated_wiki_projection_failure");
  };

  const tmpRoot = path.join(root, "tmp", `m5-wiki-failure-${Date.now().toString(36)}`);
  ensureDir(tmpRoot);

  try {
    const store = graphStoreModule.createGraphMemoryStore({
      projectRoot: root,
      memoryRoot: tmpRoot,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
      },
      qualityMode: "warn",
      wikiProjection: {
        enabled: true,
        mode: "incremental",
        maxBatch: 100,
      },
    });

    const appendResult = await store.append({
      sourceEventId: "evt_m5_wiki_failure_1",
      sourceLayer: "active_only",
      sessionId: "m5-cross-store-session",
      sourceFile: "m5-cross-store-regression",
      source_text_nav: {
        layer: "active_only",
        session_id: "m5-cross-store-session",
        source_file: "m5-cross-store-regression",
        source_memory_id: "evt_m5_wiki_failure_1",
        source_event_id: "evt_m5_wiki_failure_1",
      },
      summary: "OpenClaw retry strategy resolves sync instability while wiki projection is unavailable.",
      eventType: "insight",
      entities: ["OpenClaw retry strategy", "sync instability"],
      entity_types: {
        "OpenClaw retry strategy": "Fix",
        "sync instability": "Issue",
      },
      relations: [
        {
          source: "OpenClaw retry strategy",
          target: "sync instability",
          type: "resolves",
          relation_origin: "canonical",
          evidence_span: "retry strategy resolves sync instability",
          context_chunk: "OpenClaw incident report confirms retry strategy resolves sync instability in the latest production rollout.",
          confidence: 0.91,
        },
      ],
      gateSource: "manual",
      confidence: 0.9,
      sourceText: "OpenClaw incident report confirms retry strategy resolves sync instability in the latest production rollout.",
    });

    assert(appendResult.success === true, "graph append should remain successful when wiki projection fails");

    const graphMemoryPath = path.join(tmpRoot, "graph", "memory.jsonl");
    assert(fs.existsSync(graphMemoryPath), "graph memory file should still be written");
    const graphLines = fs.readFileSync(graphMemoryPath, "utf-8").split(/\r?\n/).filter(Boolean);
    assert(graphLines.length >= 1, "graph memory should contain at least one record");

    return {
      append_success: appendResult.success,
      graph_records: graphLines.length,
      graph_memory_path: graphMemoryPath,
    };
  } finally {
    wikiMaintainerModule.maintainWikiProjection = originalMaintain;
  }
}

async function main() {
  const root = process.cwd();
  const sessionSyncPath = path.join(root, "dist", "src", "sync", "session_sync.js");
  const graphStorePath = path.join(root, "dist", "src", "store", "graph_memory_store.js");
  const wikiMaintainerPath = path.join(root, "dist", "src", "wiki", "wiki_maintainer.js");

  assert(fs.existsSync(sessionSyncPath), "dist/src/sync/session_sync.js not found. Run npm run build first.");
  assert(fs.existsSync(graphStorePath), "dist/src/store/graph_memory_store.js not found. Run npm run build first.");
  assert(fs.existsSync(wikiMaintainerPath), "dist/src/wiki/wiki_maintainer.js not found. Run npm run build first.");

  const crossStoreResult = await runCrossStoreIsolationCheck(root, sessionSyncPath);
  const activeLowValueGuard = await runActiveLowValueGuardCheck(root, sessionSyncPath);
  const wikiNoRollbackResult = await runWikiFailureNoRollbackCheck(root, graphStorePath, wikiMaintainerPath);

  const evidenceDir = path.join(root, "docs", "progress-evidence");
  ensureDir(evidenceDir);
  const evidencePath = path.join(evidenceDir, "M5-cross-store-regression-2026-04-10.json");
  const evidence = {
    generated_at: new Date().toISOString(),
    checks: {
      graph_failure_not_block_active_archive: true,
      wiki_failure_not_rollback_graph: true,
      staged_gate_three_calls: crossStoreResult.llm_stage_calls === 3,
      active_only_requires_value: activeLowValueGuard.write_calls === 0,
    },
    cross_store_isolation: crossStoreResult,
    active_low_value_guard: activeLowValueGuard,
    wiki_projection_failure: wikiNoRollbackResult,
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
