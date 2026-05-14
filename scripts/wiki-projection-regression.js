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

function readText(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function appendArchiveEvent(memoryRoot, event) {
  const archivePath = path.join(memoryRoot, "sessions", "archive", "sessions.jsonl");
  ensureDir(path.dirname(archivePath));
  fs.appendFileSync(archivePath, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    layer: "archive",
    event_type: "milestone",
    source_file: "scripts/wiki-projection-regression.js",
    session_id: "m4-regression",
    gate_source: "manual",
    embedding_status: "pending",
    quality_score: 0.9,
    quality_level: "high",
    char_count: 120,
    token_count: 30,
    ...event,
  })}\n`, "utf-8");
}

async function main() {
  const root = process.cwd();
  const storePath = path.join(root, "dist", "src", "store", "graph_memory_store.js");
  assert(fs.existsSync(storePath), "dist/src/store/graph_memory_store.js not found. Run npm run build first.");
  const { createGraphMemoryStore } = require(storePath);

  const tmpRoot = path.join(root, "tmp", `m4-wiki-projection-memory-${Date.now().toString(36)}`);
  ensureDir(tmpRoot);

  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
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

  const archiveEvents = [
    {
      id: "evt_m4_1",
      summary: "Wife birthday recorded as 08-12.",
      cause: "User asked the agent to remember Wife birthday.",
      process: "Agent extracted the birthday_on relation from the source note.",
      result: "Wife birthday_on 08-12 was recorded.",
      source_text: "User note: Wife birthday_on 08-12.",
      confidence: 0.93,
    },
    {
      id: "evt_m4_2",
      summary: "Wife birthday corrected to 08-13.",
      cause: "User corrected the previously stored birthday.",
      process: "Graph conflict was accepted to replace the older value.",
      result: "Wife birthday_on 08-13 is the active value.",
      source_text: "User correction: Wife birthday_on 08-13.",
      confidence: 0.94,
    },
    {
      id: "evt_m4_3",
      summary: "Wife birthday candidate 08-14 was rejected.",
      cause: "A later candidate contradicted the accepted birthday.",
      process: "Graph conflict was rejected by review.",
      result: "Wife birthday_on 08-14 remains rejected history.",
      source_text: "Rejected candidate: Wife birthday_on 08-14.",
      confidence: 0.9,
    },
  ];
  for (const event of archiveEvents) {
    appendArchiveEvent(tmpRoot, event);
  }

  const baseInput = {
    sourceLayer: "archive_event",
    sessionId: "m4-regression",
    sourceFile: "scripts/wiki-projection-regression.js",
    eventType: "personal_fact",
    gateSource: "manual",
    confidence: 0.95,
  };

  const first = await store.append({
    ...baseInput,
    sourceEventId: "evt_m4_1",
    archiveEventId: "evt_m4_1",
    summary: "Wife birthday_on 08-12.",
    entities: ["User", "Wife", "08-12"],
    entity_types: { User: "Person", Wife: "FamilyMember", "08-12": "Date" },
    relations: [
      {
        source: "Wife",
        target: "08-12",
        type: "birthday_on",
        evidence_span: "Wife birthday_on 08-12",
        confidence: 0.93,
      },
    ],
    sourceText: "User note: Wife birthday_on 08-12.",
  });
  assert(first.success === true, "first append should succeed");

  const second = await store.append({
    ...baseInput,
    sourceEventId: "evt_m4_2",
    archiveEventId: "evt_m4_2",
    summary: "Wife birthday_on 08-13.",
    entities: ["User", "Wife", "08-13"],
    entity_types: { User: "Person", Wife: "FamilyMember", "08-13": "Date" },
    relations: [
      {
        source: "Wife",
        target: "08-13",
        type: "birthday_on",
        evidence_span: "Wife birthday_on 08-13",
        confidence: 0.94,
      },
    ],
    sourceText: "User correction: Wife birthday_on 08-13.",
  });
  const conflict1 = parsePendingConflictId(second.reason);
  assert(second.success === false && !!conflict1, "second append should produce pending conflict");

  const accept = await store.resolveConflict({ conflictId: conflict1, action: "accept", note: "accept newer birthday" });
  assert(accept.success === true, "conflict accept should succeed");

  const third = await store.append({
    ...baseInput,
    sourceEventId: "evt_m4_3",
    archiveEventId: "evt_m4_3",
    summary: "Wife birthday_on 08-14.",
    entities: ["User", "Wife", "08-14"],
    entity_types: { User: "Person", Wife: "FamilyMember", "08-14": "Date" },
    relations: [
      {
        source: "Wife",
        target: "08-14",
        type: "birthday_on",
        evidence_span: "Wife birthday_on 08-14",
        confidence: 0.9,
      },
    ],
    sourceText: "Rejected candidate: Wife birthday_on 08-14.",
  });
  const conflict2 = parsePendingConflictId(third.reason);
  assert(third.success === false && !!conflict2, "third append should produce second pending conflict");

  const reject = await store.resolveConflict({ conflictId: conflict2, action: "reject", note: "reject candidate" });
  assert(reject.success === true, "conflict reject should succeed");

  const wikiRoot = path.join(tmpRoot, "wiki");
  const logPath = path.join(wikiRoot, "log.md");
  const indexPath = path.join(wikiRoot, "index.md");
  const projectionIndexPath = path.join(wikiRoot, ".projection_index.json");
  const wifePath = path.join(wikiRoot, "entities", "wife.md");
  const topicPath = path.join(wikiRoot, "topics", "birthday_on.md");
  const timelinesDir = path.join(wikiRoot, "timelines");
  const viewPath = path.join(wikiRoot, "graph", "view.json");
  const timelinePath = path.join(wikiRoot, "graph", "timeline.jsonl");
  const queuePath = path.join(wikiRoot, ".rebuild_queue.jsonl");

  assert(fs.existsSync(logPath), "wiki log should exist");
  assert(fs.existsSync(indexPath), "wiki index should exist");
  assert(fs.existsSync(projectionIndexPath), "projection index should exist");
  assert(fs.existsSync(wifePath), "entity page should exist");
  assert(fs.existsSync(topicPath), "topic page should exist");
  assert(fs.existsSync(timelinesDir), "timelines directory should exist");
  assert(fs.existsSync(viewPath), "graph view snapshot should exist");
  assert(fs.existsSync(timelinePath), "graph timeline should exist");
  assert(fs.existsSync(queuePath), "rebuild queue should exist");

  const logText = readText(logPath);
  const indexText = readText(indexPath);
  const wifeText = readText(wifePath);
  const topicText = readText(topicPath);
  const queueText = readText(queuePath);
  const projectionIndex = JSON.parse(readText(projectionIndexPath) || "{}");
  const timelineFiles = fs.readdirSync(timelinesDir).filter(file => file.endsWith(".md"));
  const firstTimelinePath = timelineFiles.length > 0 ? path.join(timelinesDir, timelineFiles[0]) : "";
  const firstTimelineText = firstTimelinePath ? readText(firstTimelinePath) : "";

  assert(logText.includes("graph_append"), "log should contain graph_append");
  assert(logText.includes("conflict_pending"), "log should contain conflict_pending");
  assert(logText.includes("conflict_accepted"), "log should contain conflict_accepted");
  assert(logText.includes("conflict_rejected"), "log should contain conflict_rejected");

  assert(indexText.includes("## Quality Snapshot"), "index should include quality snapshot");
  assert(wifeText.includes("## Current Conclusion"), "entity page should contain current conclusion section");
  assert(wifeText.includes("## Recent Changes"), "entity page should contain recent changes section");
  assert(wifeText.includes("## High Confidence Facts"), "entity page should contain high confidence facts section");
  assert(wifeText.includes("## Current Facts"), "entity page should contain current facts section");
  assert(wifeText.includes("## Open Conflicts"), "entity page should contain open conflicts section");
  assert(wifeText.includes("## Disputed Facts"), "entity page should contain disputed facts section");
  assert(wifeText.includes("## History"), "entity page should contain history section");
  assert(wifeText.includes("## Evidence Excerpts"), "entity page should contain evidence excerpts section");
  assert(wifeText.includes("08-13"), "accepted value should appear in entity page");
  assert(wifeText.includes("08-12"), "superseded value should appear in entity history");
  assert(wifeText.includes("08-14"), "rejected value should appear in entity history");
  assert(wifeText.includes("Graph conflict was accepted"), "archive process should appear in entity evidence");
  assert(topicText.includes("## Summary"), "topic page should include summary section");
  assert(topicText.includes("## Current Conclusion"), "topic page should include current conclusion section");
  assert(topicText.includes("## Status Groups"), "topic page should include status groups section");
  assert(topicText.includes("## Timeline"), "topic page should include timeline section");
  assert(topicText.includes("## Latest Status"), "topic page should include latest status section");
  assert(topicText.includes("## Evidence Excerpts"), "topic page should include evidence excerpts section");
  assert(timelineFiles.length > 0, "timeline pages should be generated");
  assert(firstTimelineText.includes("## Summary"), "timeline page should include summary section");
  assert(firstTimelineText.includes("## Current Conclusion"), "timeline page should include current conclusion section");
  assert(firstTimelineText.includes("## Event Flow"), "timeline page should include event flow section");
  assert(firstTimelineText.includes("## Timeline"), "timeline page should include timeline section");
  assert(firstTimelineText.includes("## Latest Status"), "timeline page should include latest status section");
  assert(firstTimelineText.includes("## Evidence Excerpts"), "timeline page should include evidence excerpts section");
  assert(firstTimelineText.includes("cause: User"), "timeline page should include archive cause");
  assert(firstTimelineText.includes("process: "), "timeline page should include archive process");
  assert(firstTimelineText.includes("result: "), "timeline page should include archive result");
  assert(Array.isArray(projectionIndex.timelines) && projectionIndex.timelines.length > 0, "projection index should include timelines");
  assert(projectionIndex.quality_summary && projectionIndex.quality_summary.relations >= 3, "projection index should include quality summary");
  assert(queueText.trim().length === 0, "rebuild queue should be drained after maintenance");

  const evidenceDir = path.join(root, "docs", "progress-evidence");
  ensureDir(evidenceDir);
  const evidencePath = path.join(evidenceDir, "M4-projection-regression-2026-05-14.json");
  const evidence = {
    generated_at: new Date().toISOString(),
    checks: {
      log_updates_after_graph_events: true,
      entity_topic_index_files_generated: true,
      conflict_accept_reject_auto_reflected: true,
      rebuild_queue_drained: true,
      graph_snapshot_generated: true,
      timeline_markdown_generated: true,
      rich_wiki_sections_generated: true,
      archive_flow_projected_to_wiki: true,
    },
    files: {
      log: logPath,
      index: indexPath,
      projection_index: projectionIndexPath,
      entity_wife: wifePath,
      topic_birthday_on: topicPath,
      first_timeline: firstTimelinePath,
      graph_view: viewPath,
      graph_timeline: timelinePath,
      queue: queuePath,
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
