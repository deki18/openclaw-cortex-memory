#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("fs");
const os = require("os");
const path = require("path");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function logger() {
  return {
    debug() {},
    info() {},
    warn() {},
  };
}

function parsePendingConflictId(reason) {
  if (typeof reason !== "string") return "";
  const hit = reason.match(/^graph_conflict_pending:(.+)$/);
  return hit ? hit[1] : "";
}

function makeGraphInput(overrides) {
  return {
    sourceLayer: "archive_event",
    sessionId: "m3-graph-quality-conflicts",
    sourceFile: "scripts/m3-graph-quality-conflicts-regression.js",
    eventType: "decision",
    gateSource: "sync",
    confidence: 0.9,
    ...overrides,
  };
}

async function main() {
  const root = process.cwd();
  const storePath = path.join(root, "dist", "src", "store", "graph_memory_store.js");
  assert(fs.existsSync(storePath), "dist/src/store/graph_memory_store.js not found. Run npm run build first.");
  const { createGraphMemoryStore } = require(storePath);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-memory-m3-graph-conflicts-"));

  function createStore(name, qualityMode = "warn") {
    const memoryRoot = path.join(tmpRoot, name);
    fs.mkdirSync(memoryRoot, { recursive: true });
    return createGraphMemoryStore({
      projectRoot: root,
      memoryRoot,
      logger: logger(),
      qualityMode,
      wikiProjection: { enabled: false, mode: "off" },
    });
  }

  try {
    const qualityStore = createStore("quality");
    const strictRejected = await qualityStore.append(makeGraphInput({
      sourceEventId: "m3-strict-reject",
      summary: "Project Alpha configured_in config-b.json.",
      entities: ["Project Alpha", "config-b.json"],
      entity_types: { "Project Alpha": "Project", "config-b.json": "ConfigFile" },
      relations: [
        {
          source: "Project Alpha",
          target: "config-b.json",
          type: "configured_in",
          relation_origin: "canonical",
          evidence_span: "Project Alpha configured_in config-b.json",
          context_chunk: "Project Alpha is configured in config-a.json for runtime import checks.",
          confidence: 0.92,
        },
      ],
      sourceText: "Project Alpha is configured in config-a.json for runtime import checks.",
      qualityMode: "strict",
    }));
    assert(strictRejected.success === false, "strict quality mode should reject ungrounded graph facts");

    const warnAccepted = await qualityStore.append(makeGraphInput({
      sourceEventId: "m3-warn-accept",
      summary: "Project Beta configured_in beta-config.json.",
      entities: ["Project Beta", "beta-config.json"],
      entity_types: { "Project Beta": "Project", "beta-config.json": "ConfigFile" },
      relations: [
        {
          source: "Project Beta",
          target: "beta-config.json",
          type: "configured_in",
          relation_origin: "canonical",
          evidence_span: "Project Beta configured_in beta-config.json",
          context_chunk: "Project Beta is configured in beta-config.local.json for runtime import checks.",
          confidence: 0.92,
        },
      ],
      sourceText: "Project Beta is configured in beta-config.local.json for runtime import checks.",
      qualityMode: "warn",
    }));
    assert(warnAccepted.success === true, "warn quality mode should keep compatible warning-only graph facts");

    const configStore = createStore("configured-in");
    const configA = await configStore.append(makeGraphInput({
      sourceEventId: "m3-config-a",
      summary: "OpenClaw Cortex configured_in cortex.config.json.",
      entities: ["OpenClaw Cortex", "cortex.config.json"],
      entity_types: { "OpenClaw Cortex": "Project", "cortex.config.json": "ConfigFile" },
      relations: [
        {
          source: "OpenClaw Cortex",
          target: "cortex.config.json",
          type: "configured_in",
          relation_origin: "canonical",
          evidence_span: "OpenClaw Cortex configured_in cortex.config.json",
          context_chunk: "OpenClaw Cortex configured_in cortex.config.json for production memory import quality.",
          confidence: 0.94,
        },
      ],
      sourceText: "OpenClaw Cortex configured_in cortex.config.json for production memory import quality.",
    }));
    assert(configA.success === true, "first configured_in relation should be stored");
    const configB = await configStore.append(makeGraphInput({
      sourceEventId: "m3-config-b",
      summary: "OpenClaw Cortex configured_in cortex-next.config.json.",
      entities: ["OpenClaw Cortex", "cortex-next.config.json"],
      entity_types: { "OpenClaw Cortex": "Project", "cortex-next.config.json": "ConfigFile" },
      relations: [
        {
          source: "OpenClaw Cortex",
          target: "cortex-next.config.json",
          type: "configured_in",
          relation_origin: "canonical",
          evidence_span: "OpenClaw Cortex configured_in cortex-next.config.json",
          context_chunk: "OpenClaw Cortex configured_in cortex-next.config.json for production memory import quality.",
          confidence: 0.95,
        },
      ],
      sourceText: "OpenClaw Cortex configured_in cortex-next.config.json for production memory import quality.",
    }));
    assert(parsePendingConflictId(configB.reason), "configured_in target change should become pending conflict");

    const prefersStore = createStore("prefers");
    const prefersCursor = await prefersStore.append(makeGraphInput({
      sourceEventId: "m3-prefers-cursor",
      summary: "Joe prefers Cursor.",
      entities: ["Joe", "Cursor"],
      entity_types: { Joe: "Person", Cursor: "Resource" },
      relations: [
        {
          source: "Joe",
          target: "Cursor",
          type: "prefers",
          relation_origin: "canonical",
          evidence_span: "Joe prefers Cursor",
          context_chunk: "Joe prefers Cursor for coding workflow memory and repository navigation.",
          confidence: 0.91,
        },
      ],
      sourceText: "Joe prefers Cursor for coding workflow memory and repository navigation.",
    }));
    assert(prefersCursor.success === true, "first prefers relation should be stored");
    const prefersVsCode = await prefersStore.append(makeGraphInput({
      sourceEventId: "m3-prefers-vscode",
      summary: "Joe prefers VSCode.",
      entities: ["Joe", "VSCode"],
      entity_types: { Joe: "Person", VSCode: "Resource" },
      relations: [
        {
          source: "Joe",
          target: "VSCode",
          type: "prefers",
          relation_origin: "canonical",
          evidence_span: "Joe prefers VSCode",
          context_chunk: "Joe prefers VSCode for coding workflow memory and repository navigation.",
          confidence: 0.91,
        },
      ],
      sourceText: "Joe prefers VSCode for coding workflow memory and repository navigation.",
    }));
    assert(parsePendingConflictId(prefersVsCode.reason), "same target-type preference change should become pending conflict");

    const opposingStore = createStore("opposing");
    const blocks = await opposingStore.append(makeGraphInput({
      sourceEventId: "m3-blocks",
      summary: "Import Gate blocks Wiki Release.",
      entities: ["Import Gate", "Wiki Release"],
      entity_types: { "Import Gate": "Task", "Wiki Release": "Task" },
      relations: [
        {
          source: "Import Gate",
          target: "Wiki Release",
          type: "blocks",
          relation_origin: "canonical",
          evidence_span: "Import Gate blocks Wiki Release",
          context_chunk: "Import Gate blocks Wiki Release until strict graph quality checks pass.",
          confidence: 0.9,
        },
      ],
      sourceText: "Import Gate blocks Wiki Release until strict graph quality checks pass.",
    }));
    assert(blocks.success === true, "first blocks relation should be stored");
    const supports = await opposingStore.append(makeGraphInput({
      sourceEventId: "m3-supports",
      summary: "Import Gate supports Wiki Release.",
      entities: ["Import Gate", "Wiki Release"],
      entity_types: { "Import Gate": "Task", "Wiki Release": "Task" },
      relations: [
        {
          source: "Import Gate",
          target: "Wiki Release",
          type: "supports",
          relation_origin: "canonical",
          evidence_span: "Import Gate supports Wiki Release",
          context_chunk: "Import Gate supports Wiki Release after strict graph quality checks pass.",
          confidence: 0.9,
        },
      ],
      sourceText: "Import Gate supports Wiki Release after strict graph quality checks pass.",
    }));
    assert(parsePendingConflictId(supports.reason), "opposing blocks/supports relation should become pending conflict");

    console.log(JSON.stringify({
      success: true,
      checks: {
        strict_import_quality_rejects_ungrounded_graph: strictRejected.success === false,
        warn_quality_still_accepts_warning_only_graph: warnAccepted.success === true,
        configured_in_conflict_detected: Boolean(parsePendingConflictId(configB.reason)),
        preference_conflict_detected: Boolean(parsePendingConflictId(prefersVsCode.reason)),
        opposing_relation_conflict_detected: Boolean(parsePendingConflictId(supports.reason)),
      },
    }, null, 2));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
