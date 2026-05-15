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

async function main() {
  const root = process.cwd();
  const writeStorePath = path.join(root, "dist", "src", "store", "write_store.js");
  const archiveStorePath = path.join(root, "dist", "src", "store", "archive_store.js");
  const dedupPath = path.join(root, "dist", "src", "dedup", "three_stage_deduplicator.js");
  assert(fs.existsSync(writeStorePath), "dist/src/store/write_store.js not found. Run npm run build first.");
  assert(fs.existsSync(archiveStorePath), "dist/src/store/archive_store.js not found. Run npm run build first.");
  assert(fs.existsSync(dedupPath), "dist/src/dedup/three_stage_deduplicator.js not found. Run npm run build first.");

  const { createWriteStore } = require(writeStorePath);
  const { createArchiveStore } = require(archiveStorePath);
  const { createThreeStageDeduplicator } = require(dedupPath);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-memory-m2-quality-dedup-"));
  const dbPath = path.join(tmpRoot, "memory");
  try {
    const writeStore = createWriteStore({
      projectRoot: root,
      dbPath,
      logger: logger(),
      writePolicy: {
        activeMinQualityScore: 0.45,
        activeDedupTailLines: 500,
      },
    });

    const lowValue = await writeStore.writeMemory({
      text: "收到，谢谢。",
      role: "assistant",
      source: "m2-quality-dedup",
      sessionId: "active-low-value",
    });
    assert(lowValue.status === "skipped", "low-value acknowledgement should be skipped");
    assert(lowValue.reason === "low_quality", "low-value acknowledgement should fail quality gate");

    const activeText = "Decision: keep cortex-memory-pro import quality gate, track source_slice coverage, and verify with npm run test:m2-quality-dedup.";
    const firstActive = await writeStore.writeMemory({
      text: activeText,
      summary: "Keep cortex-memory-pro import quality gate and verify with npm run test:m2-quality-dedup",
      sourceText: [
        "[user] 需要提高 cortex-memory-pro 历史记忆导入质量。",
        "[assistant] Decision: keep import quality gate, track source_slice coverage, and verify with npm run test:m2-quality-dedup.",
      ].join("\n"),
      role: "assistant",
      source: "m2-quality-dedup",
      sessionId: "active-session-a",
    });
    assert(firstActive.status === "ok", "valuable active memory should be stored");
    assert(firstActive.quality && firstActive.quality.score >= 0.45, "valuable active memory should meet semantic quality threshold");

    const duplicateActive = await writeStore.writeMemory({
      text: "Keep cortex-memory-pro import quality gate and verify with npm run test:m2-quality-dedup.",
      summary: "Keep cortex-memory-pro import quality gate and verify with npm run test:m2-quality-dedup",
      sourceText: [
        "[user] 这是另一段历史会话，尾部证据不同。",
        "[assistant] Keep cortex-memory-pro import quality gate and verify with npm run test:m2-quality-dedup.",
      ].join("\n"),
      role: "assistant",
      source: "m2-quality-dedup",
      sessionId: "active-session-b",
    });
    assert(duplicateActive.status === "skipped", "cross-session semantic duplicate should be skipped");
    assert(
      ["duplicate_semantic", "duplicate_simhash", "duplicate_minhash"].includes(duplicateActive.reason),
      `unexpected active duplicate reason: ${duplicateActive.reason}`,
    );

    const activePath = path.join(dbPath, "sessions", "active", "sessions.jsonl");
    const activeLines = fs.readFileSync(activePath, "utf-8").trim().split(/\r?\n/);
    const activeRecord = JSON.parse(activeLines[0]);
    assert(typeof activeRecord.semantic_hash === "string" && activeRecord.semantic_hash.length > 0, "active record should persist semantic_hash");
    assert(typeof activeRecord.semantic_simhash === "string" && activeRecord.semantic_simhash.length > 0, "active record should persist semantic_simhash");

    const archiveRoot = path.join(tmpRoot, "archive-memory");
    const archiveStore = createArchiveStore({
      projectRoot: root,
      memoryRoot: archiveRoot,
      logger: logger(),
      deduplicator: createThreeStageDeduplicator({
        memoryRoot: archiveRoot,
        logger: logger(),
      }),
      vectorStore: {
        async upsert() {},
        async deleteBySourceMemory() {},
      },
      writePolicy: {
        archiveMinConfidence: 0.35,
        archiveMinQualityScore: 0.4,
      },
    });

    const baseArchiveEvent = {
      event_type: "fix",
      summary: "优化 cortex-memory-pro 历史记忆导入质量并完成验证",
      cause: "用户要求提高历史记忆导入质量并改善 wiki 生成来源。",
      process: "修复导入质量门、active 语义评分和归档 dedup，并执行验证。",
      result: "npm run test:m2-quality-dedup 通过，用户接受第二阶段结果。",
      session_id: "archive-session-a",
      source_file: "sync:m2-a.jsonl",
      confidence: 0.92,
      actor: "sync_llm_gate",
    };
    const firstArchive = await archiveStore.storeEvents([
      {
        ...baseArchiveEvent,
        source_text: "第一段历史会话包含不同的长尾上下文 A。".repeat(60),
      },
    ]);
    assert(firstArchive.stored.length === 1, "first archive event should be stored");

    const duplicateArchive = await archiveStore.storeEvents([
      {
        ...baseArchiveEvent,
        session_id: "archive-session-b",
        source_file: "sync:m2-b.jsonl",
        source_text: "第二段历史会话包含完全不同的长尾上下文 B。".repeat(60),
      },
    ]);
    assert(duplicateArchive.stored.length === 0, "archive duplicate with different source_text should not be stored");
    assert(duplicateArchive.skipped.length === 1, "archive duplicate should report one skipped item");
    assert(
      /^duplicate_/.test(duplicateArchive.skipped[0].reason),
      `unexpected archive duplicate reason: ${duplicateArchive.skipped[0].reason}`,
    );

    console.log(JSON.stringify({
      success: true,
      checks: {
        active_low_value_skipped: lowValue.status === "skipped" && lowValue.reason === "low_quality",
        active_semantic_quality_passed: firstActive.status === "ok",
        active_cross_session_duplicate: duplicateActive.status === "skipped",
        active_semantic_hash_persisted: typeof activeRecord.semantic_hash === "string",
        archive_source_text_decoupled_duplicate: duplicateArchive.skipped.length === 1,
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
