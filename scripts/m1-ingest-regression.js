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

function createMockLlmServer(responses) {
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
      resolve({
        server,
        port: address.port,
        receivedRequests,
      });
    });
  });
}

async function main() {
  const root = process.cwd();
  const sessionSyncPath = path.join(root, "dist", "src", "sync", "session_sync.js");
  const ontologyPath = path.join(root, "dist", "src", "graph", "ontology.js");
  assert(fs.existsSync(sessionSyncPath), "dist/src/sync/session_sync.js not found. Run npm run build first.");
  assert(fs.existsSync(ontologyPath), "dist/src/graph/ontology.js not found. Run npm run build first.");

  const { createSessionSync } = require(sessionSyncPath);
  const { loadGraphSchema, validateGraphPayload } = require(ontologyPath);
  const schema = loadGraphSchema(root);

  const stageAb = {
    write_plan: {
      candidates: [
        {
          candidate_id: "c1",
          route: "skip",
          normalized_text: "Ava birthday is August 12",
        },
      ],
    },
  };

  const stageC = {
    write_plan: {
      active_payloads: [],
      archive_payloads: [],
      graph_payloads: [
        {
          candidate_id: "c1",
          summary: "Joe records that Ava birthday is August 12.",
          source_text_nav: {
            layer: "active_only",
            session_id: "m1-regression-session",
            source_file: "m1-ingest-regression",
            source_memory_id: "evt_m1_c1",
            source_event_id: "evt_m1_c1",
            fulltext_anchor: "#L1",
          },
          entities: ["Joe", "Ava", "August 12"],
          entity_types: { Joe: "Person", Ava: "Person", "August 12": "Date" },
          relations: [
            {
              source: "Ava",
              target: "August 12",
              type: "birthday_on",
              relation_origin: "canonical",
              evidence_span: "Ava birthday is August 12",
              context_chunk: "Joe wrote in the notebook that Ava birthday is August 12 and asked the system to remember this fact.",
              confidence: 0.95,
            },
          ],
          confidence: 0.9,
        },
      ],
    },
  };

  const stageD = {
    write_plan: {
      merge_hints: [{ candidate_id: "c1", same_event: false }],
      graph_rewrite: [{ candidate_id: "c1", rewrite_required: false }],
    },
  };

  const { server, port, receivedRequests } = await createMockLlmServer([
    JSON.stringify(stageAb),
    JSON.stringify(stageC),
    JSON.stringify(stageD),
  ]);
  const graphCalls = [];
  try {
    const sessionSync = createSessionSync({
      projectRoot: root,
      dbPath: path.join(root, "tmp", "m1-ingest-regression-memory"),
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
      archiveStore: {
        async storeEvents() {
          return { stored: [], skipped: [] };
        },
      },
      writeStore: {
        async writeMemory() {
          return { status: "ok" };
        },
      },
      graphMemoryStore: {
        async append(input) {
          graphCalls.push(input);
          return { success: true };
        },
      },
    });

    const transcript = "Joe wrote in the notebook that Ava birthday is August 12 and asked the system to remember this fact.";
    const routed = await sessionSync.routeTranscript({
      sessionId: "m1-regression-session",
      sourceFile: "m1-ingest-regression",
      transcript,
    });

    assert(routed.ok === true, "routeTranscript should succeed");
    assert(receivedRequests.length >= 3, "staged gate should call LLM at least 3 times (A+B, C, D)");
    assert(receivedRequests.some(body => body.includes("write-gate.ab.v1.1.6")), "stage A+B prompt version missing");
    assert(receivedRequests.some(body => body.includes("write-gate.c.v1.5.1")), "stage C prompt version missing");
    assert(receivedRequests.some(body => body.includes("write-gate.d.v1.1.0")), "stage D prompt version missing");
    assert(graphCalls.length >= 1, "skip branch should still attempt graph append when graph payload exists");
    const promptBodies = receivedRequests.join("\n");
    assert(!/[闂濠婵閸鈧]/.test(promptBodies), "write-gate prompts should not contain mojibake examples");
    assert(promptBodies.includes("请优化 cortex-memory-pro"), "Chinese write-gate regression sample missing");

    const firstGraph = graphCalls[0];
    const graphRelations = Array.isArray(firstGraph.relations) ? firstGraph.relations : [];
    assert(firstGraph.qualityMode === "strict", "sync graph append should default to strict quality mode");
    assert(graphRelations.length >= 1, "graph relations should exist");
    assert(firstGraph.summary && typeof firstGraph.summary === "string", "graph append should include summary");
    assert(firstGraph.source_text_nav && typeof firstGraph.source_text_nav === "object", "graph append should include source_text_nav");
    for (const rel of graphRelations) {
      assert(typeof rel.evidence_span === "string" && rel.evidence_span.trim().length > 0, "relation must include evidence_span");
      assert(typeof rel.context_chunk === "string" && rel.context_chunk.trim().length > 0, "relation must include context_chunk");
      assert(typeof rel.confidence === "number", "relation must include confidence");
    }

    const typedPayloadResult = validateGraphPayload({
      sourceEventId: "m1-typed-payload",
      sourceLayer: "active_only",
      sessionId: "m1-regression-session",
      sourceFile: "m1-ingest-regression",
      source_text_nav: {
        layer: "active_only",
        session_id: "m1-regression-session",
        source_file: "m1-ingest-regression",
        source_memory_id: "evt_m1_typed",
        source_event_id: "evt_m1_typed",
      },
      summary: "Joe records that Joe has_spouse Ava.",
      eventType: "insight",
      entities: ["Joe", "Ava"],
      entity_types: { Joe: "Person", Ava: "Person" },
      relations: [
        {
          source: "Joe",
          target: "Ava",
          type: "has_spouse",
          evidence_span: "Joe and Ava are spouses",
          context_chunk: "Joe and Ava are spouses according to the notebook and the memory pipeline should keep this relation.",
          confidence: 0.9,
        },
      ],
      gateSource: "sync",
      confidence: 0.9,
      sourceText: transcript,
      schema,
      qualityMode: "warn",
    });
    assert(typedPayloadResult.valid === true, "typed payload should stay valid");
    assert(typedPayloadResult.normalized && typedPayloadResult.normalized.entity_types.Joe === "Person", "typed payload should keep Joe type");
    assert(typedPayloadResult.normalized && typedPayloadResult.normalized.entity_types.Ava === "Person", "typed payload should keep Ava type");

    const missingEvidenceResult = validateGraphPayload({
      sourceEventId: "m1-missing-evidence",
      sourceLayer: "active_only",
      sessionId: "m1-regression-session",
      sourceFile: "m1-ingest-regression",
      source_text_nav: {
        layer: "active_only",
        session_id: "m1-regression-session",
        source_file: "m1-ingest-regression",
        source_memory_id: "evt_m1_missing",
        source_event_id: "evt_m1_missing",
      },
      summary: "Joe records that Joe has_spouse Ava.",
      eventType: "insight",
      entities: ["Joe", "Ava"],
      entity_types: { Joe: "Person", Ava: "Person" },
      relations: [
        {
          source: "Joe",
          target: "Ava",
          type: "has_spouse",
        },
      ],
      gateSource: "sync",
      confidence: 0.9,
      sourceText: transcript,
      schema,
      qualityMode: "warn",
    });
    assert(missingEvidenceResult.valid === false, "relation missing evidence/confidence must be rejected");

    const genericEntityResult = validateGraphPayload({
      sourceEventId: "m1-generic-entities",
      sourceLayer: "active_only",
      sessionId: "m1-regression-session",
      sourceFile: "m1-ingest-regression",
      source_text_nav: {
        layer: "active_only",
        session_id: "m1-regression-session",
        source_file: "m1-ingest-regression",
        source_memory_id: "evt_m1_generic",
        source_event_id: "evt_m1_generic",
      },
      summary: "User and system are connected.",
      eventType: "insight",
      entities: ["User", "System"],
      entity_types: { User: "Person", System: "Resource" },
      relations: [
        {
          source: "User",
          target: "System",
          type: "uses_tech",
          evidence_span: "User used the system",
          context_chunk: "User used the system in this generic sentence, which should be rejected by concretization.",
          confidence: 0.7,
        },
      ],
      gateSource: "sync",
      confidence: 0.8,
      sourceText: "User used the system in this generic sentence, which should be rejected by concretization.",
      schema,
      qualityMode: "warn",
    });
    assert(genericEntityResult.valid === false, "generic entities should be rejected");

    const lifecycleStageAb = { write_plan: { candidates: [] } };
    const lifecycleMock = await createMockLlmServer([JSON.stringify(lifecycleStageAb)]);
    const lifecycleArchiveEvents = [];
    const lifecycleGraphCalls = [];
    let lifecycleRouted;
    try {
      const lifecycleSync = createSessionSync({
        projectRoot: root,
        dbPath: path.join(root, "tmp", "m1-lifecycle-fallback-memory"),
        logger: {
          debug: () => {},
          info: () => {},
          warn: () => {},
        },
        llm: {
          model: "mock-llm",
          apiKey: "mock-key",
          baseURL: `http://127.0.0.1:${lifecycleMock.port}`,
        },
        requireLlmForWrite: true,
        archiveStore: {
          async storeEvents(events) {
            lifecycleArchiveEvents.push(...events);
            return {
              stored: events.map((_, index) => ({ id: `archive_lifecycle_${index}` })),
              skipped: [],
            };
          },
        },
        writeStore: {
          async writeMemory() {
            throw new Error("active write should not be used for lifecycle fallback");
          },
        },
        graphMemoryStore: {
          async append(input) {
            lifecycleGraphCalls.push(input);
            return { success: true };
          },
        },
      });
      const filler = Array.from(
        { length: 35 },
        (_, index) => `[assistant] 状态记录 ${index + 1}：普通进展记录。`,
      ).join("\n");
      const lifecycleTranscript = [
        "[用户] 请优化 cortex-memory-pro 的历史记忆导入质量，并修复中文导入的问题。",
        filler,
        "[assistant] 已完成 prompt 乱码修复，并通过 npm run typecheck。",
        "[用户] ok，效果可以，接受。",
      ].join("\n");
      lifecycleRouted = await lifecycleSync.routeTranscript({
        sessionId: "m1-lifecycle-zh-session",
        sourceFile: "m1-lifecycle-zh",
        transcript: lifecycleTranscript,
      });
      assert(lifecycleRouted.ok === true, "Chinese lifecycle fallback should route successfully");
      assert(lifecycleRouted.archiveEvent === 1, "Chinese lifecycle fallback should archive one event");
      assert(lifecycleArchiveEvents.length === 1, "Chinese lifecycle fallback should send one archive event");
      assert(
        lifecycleArchiveEvents[0].cause.includes("优化 cortex-memory-pro"),
        "Chinese lifecycle archive cause should preserve the user task",
      );
      assert(
        lifecycleMock.receivedRequests[0].includes("请优化 cortex-memory-pro"),
        "event snippet should preserve the first Chinese task line",
      );
      assert(lifecycleGraphCalls.length >= 1, "lifecycle fallback should derive graph when a concrete project is mentioned");
      const lifecycleGraph = lifecycleGraphCalls[0];
      assert(
        Array.isArray(lifecycleGraph.entities) && lifecycleGraph.entities.includes("cortex-memory-pro"),
        "lifecycle fallback graph should include the concrete project entity",
      );
    } finally {
      await new Promise((resolve) => lifecycleMock.server.close(resolve));
    }

    const evidenceDir = path.join(root, "docs", "progress-evidence");
    ensureDir(evidenceDir);
    const evidencePath = path.join(evidenceDir, "M1-ingest-regression-2026-04-10.json");
    const evidence = {
      generated_at: new Date().toISOString(),
      checks: {
        skip_branch_graph_attempt: graphCalls.length >= 1,
        staged_gate_three_calls: receivedRequests.length === 3,
        relation_evidence_confidence_required: missingEvidenceResult.valid === false,
        typed_payload_valid: typedPayloadResult.valid === true,
        generic_entity_rejected: genericEntityResult.valid === false,
        prompt_mojibake_removed: !/[闂濠婵閸鈧]/.test(promptBodies),
        chinese_lifecycle_fallback_archive: lifecycleArchiveEvents.length === 1 && lifecycleRouted && lifecycleRouted.archiveEvent === 1,
        chinese_snippet_preserved: lifecycleMock.receivedRequests[0].includes("请优化 cortex-memory-pro"),
        lifecycle_fallback_graph_derived: lifecycleGraphCalls.length >= 1,
        sync_graph_quality_mode_strict: firstGraph.qualityMode === "strict",
      },
      llm_stage_calls: receivedRequests.length,
      graph_append_calls: graphCalls.length,
      lifecycle_graph_append_calls: lifecycleGraphCalls.length,
      sample_relations: graphRelations,
      routed_result: routed,
      lifecycle_routed_result: lifecycleRouted,
      typed_entity_types: typedPayloadResult.normalized ? typedPayloadResult.normalized.entity_types : {},
      missing_evidence_reason: missingEvidenceResult.reason || "",
      generic_entity_reason: genericEntityResult.reason || "",
    };
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf-8");

    console.log(JSON.stringify({
      success: true,
      evidence: evidencePath,
      checks: evidence.checks,
    }, null, 2));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
