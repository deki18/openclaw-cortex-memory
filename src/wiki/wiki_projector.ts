import * as fs from "fs";
import * as path from "path";
import type { GraphViewData } from "../store/graph_memory_store";
import type { WikiRebuildEvent } from "./wiki_queue";
import type { RelationOrigin, SourceTextNav } from "../graph/ontology";

interface WriteGraphViewProjectionArgs {
  memoryRoot: string;
  view: GraphViewData;
}

interface WriteGraphViewProjectionResult {
  view_path: string;
  timeline_path: string;
  snapshot_id: string;
  mermaid_path: string;
  network_markdown_path: string;
}

interface ProjectWikiKnowledgeArgs {
  memoryRoot: string;
  graphView: GraphViewData;
  queueEvents: WikiRebuildEvent[];
}

interface ProjectWikiKnowledgeResult {
  updated_at: string;
  entities_count: number;
  topics_count: number;
  timelines_count: number;
  files: {
    index: string;
    projection_index: string;
    entities_dir: string;
    topics_dir: string;
    timelines_dir: string;
  };
}

type RelationStatus = "active" | "pending_conflict" | "superseded" | "rejected";

interface GraphMemoryRecordLike {
  summary?: string;
  source_text_nav?: SourceTextNav;
  source_event_id?: string;
  timestamp?: string;
  source_layer?: "archive_event" | "active_only";
  source_file?: string;
  entity_types?: Record<string, string>;
  relations?: Array<{
    source?: string;
    target?: string;
    type?: string;
    relation_origin?: RelationOrigin;
    relation_definition?: string;
    evidence_span?: string;
    context_chunk?: string;
    confidence?: number;
  }>;
}

interface GraphConflictLike {
  conflict_id?: string;
  source_event_id?: string;
  source_layer?: "archive_event" | "active_only";
  source_file?: string;
  updated_at?: string;
  created_at?: string;
  candidate?: {
    summary?: string;
    source_text_nav?: SourceTextNav;
    entity_types?: Record<string, string>;
    relations?: Array<{
      source?: string;
      target?: string;
      type?: string;
      relation_origin?: RelationOrigin;
      relation_definition?: string;
      evidence_span?: string;
      context_chunk?: string;
      confidence?: number;
    }>;
  };
}

interface SupersededLike {
  relation_key?: string;
  superseded_at?: string;
  conflict_id?: string;
}

interface RelationDetail {
  source_event_id?: string;
  source_layer?: "archive_event" | "active_only";
  source_file?: string;
  timestamp?: string;
  summary?: string;
  source_text_nav?: SourceTextNav;
  source_type?: string;
  target_type?: string;
  relation_origin?: RelationOrigin;
  relation_definition?: string;
  evidence_span?: string;
  context_chunk?: string;
  confidence?: number;
  conflict_id?: string;
}

interface ProjectedRelation {
  source: string;
  target: string;
  type: string;
  status: RelationStatus;
  relation_key: string;
  source_event_id?: string;
  conflict_id?: string;
  timestamp: string;
  summary?: string;
  source_text_nav?: SourceTextNav;
  relation_origin?: RelationOrigin;
  relation_definition?: string;
  evidence_span?: string;
  context_chunk?: string;
  confidence?: number;
  source_type?: string;
  target_type?: string;
}

interface TimelineGroup {
  source: string;
  source_key: string;
  relation_type: string;
  relation_cluster: string;
  target_class: string;
  targets: Set<string>;
  relations: ProjectedRelation[];
  timeline_id: string;
}
type WikiPageKind = "entity" | "topic" | "timeline";

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function slugify(value: string): string {
  const normalized = (value || "").trim().toLowerCase();
  if (!normalized) return "unknown";
  return normalized.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

function sortByString<T>(items: T[], getter: (item: T) => string): T[] {
  return [...items].sort((a, b) => getter(a).localeCompare(getter(b)));
}

function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/).filter(Boolean);
  const output: T[] = [];
  for (const line of lines) {
    try {
      output.push(JSON.parse(line) as T);
    } catch {
      // ignore malformed lines
    }
  }
  return output;
}

function normalizeKey(value: string | undefined): string {
  return String(value || "").trim().toLowerCase();
}

function toIso(raw: string | undefined, fallback: string): string {
  const ms = Date.parse(raw || "");
  return Number.isFinite(ms) ? new Date(ms).toISOString() : fallback;
}

function relationKey(source: string | undefined, type: string | undefined, target: string | undefined): string {
  return `${normalizeKey(source)}|${normalizeKey(type)}|${normalizeKey(target)}`;
}

function relationEventKey(relKey: string, sourceEventId: string): string {
  return `${normalizeKey(relKey)}|${normalizeKey(sourceEventId)}`;
}

function conflictRelationKey(conflictId: string, relKey: string): string {
  return `${normalizeKey(conflictId)}|${normalizeKey(relKey)}`;
}

function entityTypeLookup(types?: Record<string, string>): Map<string, string> {
  const output = new Map<string, string>();
  for (const [name, type] of Object.entries(types || {})) {
    const key = normalizeKey(name);
    const value = String(type || "").trim();
    if (key && value) {
      output.set(key, value);
    }
  }
  return output;
}

function sanitizeInline(value: string | undefined, fallback = "n/a"): string {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  return text || fallback;
}

function escapeMermaidText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildMermaidNetwork(view: GraphViewData): string {
  const lines: string[] = ["graph LR"];
  const nodeIdByName = new Map<string, string>();
  let nodeIndex = 0;
  for (const node of view.nodes || []) {
    const name = String(node.id || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (!nodeIdByName.has(key)) {
      nodeIdByName.set(key, `n${nodeIndex}`);
      nodeIndex += 1;
    }
  }
  const linkStyles: string[] = [];
  let edgeIndex = 0;
  for (const edge of view.edges || []) {
    const sourceName = String(edge.source || "").trim();
    const targetName = String(edge.target || "").trim();
    if (!sourceName || !targetName) continue;
    const sourceKey = sourceName.toLowerCase();
    const targetKey = targetName.toLowerCase();
    if (!nodeIdByName.has(sourceKey)) {
      nodeIdByName.set(sourceKey, `n${nodeIndex}`);
      nodeIndex += 1;
    }
    if (!nodeIdByName.has(targetKey)) {
      nodeIdByName.set(targetKey, `n${nodeIndex}`);
      nodeIndex += 1;
    }
    const sourceNode = nodeIdByName.get(sourceKey) as string;
    const targetNode = nodeIdByName.get(targetKey) as string;
    const label = escapeMermaidText(`${edge.type} [${edge.status}]`);
    lines.push(`  ${sourceNode}["${escapeMermaidText(sourceName)}"] -->|"${label}"| ${targetNode}["${escapeMermaidText(targetName)}"]`);
    if (edge.status === "active") {
      linkStyles.push(`  linkStyle ${edgeIndex} stroke:#2a9d8f,stroke-width:2px;`);
    } else if (edge.status === "pending_conflict") {
      linkStyles.push(`  linkStyle ${edgeIndex} stroke:#f4a261,stroke-width:2px,stroke-dasharray: 5 4;`);
    } else if (edge.status === "superseded") {
      linkStyles.push(`  linkStyle ${edgeIndex} stroke:#8d99ae,stroke-width:2px,stroke-dasharray: 2 4;`);
    } else {
      linkStyles.push(`  linkStyle ${edgeIndex} stroke:#e63946,stroke-width:2px,stroke-dasharray: 5 4;`);
    }
    edgeIndex += 1;
  }
  if (edgeIndex === 0) {
    lines.push("  empty_graph[\"No graph edges\"]");
  }
  lines.push(...linkStyles);
  return `${lines.join("\n")}\n`;
}

export function writeGraphViewProjection(args: WriteGraphViewProjectionArgs): WriteGraphViewProjectionResult {
  const graphDir = path.join(args.memoryRoot, "wiki", "graph");
  const viewPath = path.join(graphDir, "view.json");
  const timelinePath = path.join(graphDir, "timeline.jsonl");
  const mermaidPath = path.join(graphDir, "network.mmd");
  const networkMarkdownPath = path.join(graphDir, "network.md");
  const nowIso = new Date().toISOString();
  const snapshotId = `gview_${Date.now().toString(36)}`;
  ensureDir(graphDir);

  const viewPayload = {
    ...args.view,
    generated_at: nowIso,
    snapshot_id: snapshotId,
  };
  fs.writeFileSync(viewPath, `${JSON.stringify(viewPayload, null, 2)}\n`, "utf-8");

  const timelineEntry = {
    snapshot_id: snapshotId,
    generated_at: nowIso,
    graph_updated_at: args.view.updated_at,
    nodes: args.view.nodes.length,
    edges: args.view.edges.length,
    status_counts: args.view.status_counts,
  };
  fs.appendFileSync(timelinePath, `${JSON.stringify(timelineEntry)}\n`, "utf-8");

  const mermaid = buildMermaidNetwork(args.view);
  fs.writeFileSync(mermaidPath, mermaid, "utf-8");
  const markdownBody = [
    "# Graph Network",
    "",
    `Generated at: ${nowIso}`,
    `Snapshot ID: ${snapshotId}`,
    "",
    "```mermaid",
    mermaid.trimEnd(),
    "```",
    "",
  ].join("\n");
  fs.writeFileSync(networkMarkdownPath, markdownBody, "utf-8");

  return {
    view_path: viewPath,
    timeline_path: timelinePath,
    snapshot_id: snapshotId,
    mermaid_path: mermaidPath,
    network_markdown_path: networkMarkdownPath,
  };
}
function relationCluster(typeRaw: string): string {
  const type = normalizeKey(typeRaw);
  if (type === "resolves" || type === "solved_with") return "resolution";
  if (type === "plans_to" || type === "planned_for" || type === "scheduled_for") return "planning";
  return type;
}

function normalizeForSimilarity(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").replace(/\s+/g, " ").trim();
}

function overlapRatio(left: string, right: string): number {
  const a = new Set(normalizeForSimilarity(left).split(" ").filter(token => token.length >= 2));
  const b = new Set(normalizeForSimilarity(right).split(" ").filter(token => token.length >= 2));
  if (a.size === 0 || b.size === 0) return 0;
  let hit = 0;
  for (const token of a) {
    if (b.has(token)) hit += 1;
  }
  return hit / Math.max(1, Math.min(a.size, b.size));
}

function diceSimilarity(leftRaw: string, rightRaw: string): number {
  const left = normalizeForSimilarity(leftRaw).replace(/\s+/g, "");
  const right = normalizeForSimilarity(rightRaw).replace(/\s+/g, "");
  if (!left || !right) return 0;
  if (left === right) return 1;
  const grams = (value: string): string[] => {
    if (value.length < 2) return [value];
    const out: string[] = [];
    for (let i = 0; i < value.length - 1; i += 1) {
      out.push(value.slice(i, i + 2));
    }
    return out;
  };
  const lg = grams(left);
  const rg = grams(right);
  const bag = new Map<string, number>();
  for (const gram of rg) {
    bag.set(gram, (bag.get(gram) || 0) + 1);
  }
  let matches = 0;
  for (const gram of lg) {
    const remain = bag.get(gram) || 0;
    if (remain > 0) {
      matches += 1;
      bag.set(gram, remain - 1);
    }
  }
  return (2 * matches) / (lg.length + rg.length);
}

function withinDays(leftIso: string, rightIso: string, days: number): boolean {
  const left = Date.parse(leftIso);
  const right = Date.parse(rightIso);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return Math.abs(left - right) <= days * 24 * 60 * 60 * 1000;
}

function buildProjectedRelations(args: {
  memoryRoot: string;
  graphView: GraphViewData;
}): ProjectedRelation[] {
  const nowIso = new Date().toISOString();
  const records = readJsonl<GraphMemoryRecordLike>(path.join(args.memoryRoot, "graph", "memory.jsonl"));
  const conflicts = readJsonl<GraphConflictLike>(path.join(args.memoryRoot, "graph", "conflict_queue.jsonl"));
  const superseded = readJsonl<SupersededLike>(path.join(args.memoryRoot, "graph", "superseded_relations.jsonl"));

  const byEvent = new Map<string, RelationDetail>();
  const byRelation = new Map<string, RelationDetail>();
  const byConflict = new Map<string, RelationDetail>();
  const conflictUpdatedAt = new Map<string, string>();
  const supersededByRelation = new Map<string, string>();
  const supersededByComposite = new Map<string, string>();

  const upsert = (target: Map<string, RelationDetail>, key: string, next: RelationDetail): void => {
    const prev = target.get(key);
    if (!prev) {
      target.set(key, next);
      return;
    }
    const prevMs = Date.parse(prev.timestamp || "");
    const nextMs = Date.parse(next.timestamp || "");
    if (!Number.isFinite(prevMs) || (Number.isFinite(nextMs) && nextMs >= prevMs)) {
      target.set(key, next);
    }
  };

  for (const record of records) {
    const sourceEventId = String(record.source_event_id || "").trim();
    const timestamp = toIso(record.timestamp, nowIso);
    const typeMap = entityTypeLookup(record.entity_types);
    for (const rel of record.relations || []) {
      const source = String(rel.source || "").trim();
      const target = String(rel.target || "").trim();
      const type = String(rel.type || "").trim().toLowerCase();
      if (!source || !target || !type) continue;
      const key = relationKey(source, type, target);
      const detail: RelationDetail = {
        source_event_id: sourceEventId || undefined,
        source_layer: record.source_layer,
        source_file: record.source_file,
        timestamp,
        summary: typeof record.summary === "string" ? record.summary.trim() : undefined,
        source_text_nav: record.source_text_nav,
        source_type: typeMap.get(normalizeKey(source)),
        target_type: typeMap.get(normalizeKey(target)),
        relation_origin: rel.relation_origin,
        relation_definition: typeof rel.relation_definition === "string" ? rel.relation_definition.trim() : undefined,
        evidence_span: typeof rel.evidence_span === "string" ? rel.evidence_span.trim() : undefined,
        context_chunk: typeof rel.context_chunk === "string" ? rel.context_chunk.trim() : undefined,
        confidence: typeof rel.confidence === "number" ? rel.confidence : undefined,
      };
      if (sourceEventId) {
        upsert(byEvent, relationEventKey(key, sourceEventId), detail);
      }
      upsert(byRelation, key, detail);
    }
  }

  for (const conflict of conflicts) {
    const conflictId = String(conflict.conflict_id || "").trim();
    if (!conflictId) continue;
    const updatedAt = toIso(conflict.updated_at || conflict.created_at, nowIso);
    conflictUpdatedAt.set(conflictId, updatedAt);
    const candidate = conflict.candidate || {};
    const typeMap = entityTypeLookup(candidate.entity_types);
    for (const rel of candidate.relations || []) {
      const source = String(rel.source || "").trim();
      const target = String(rel.target || "").trim();
      const type = String(rel.type || "").trim().toLowerCase();
      if (!source || !target || !type) continue;
      const key = relationKey(source, type, target);
      byConflict.set(conflictRelationKey(conflictId, key), {
        source_event_id: typeof conflict.source_event_id === "string" ? conflict.source_event_id.trim() || undefined : undefined,
        source_layer: conflict.source_layer,
        source_file: conflict.source_file,
        timestamp: updatedAt,
        summary: typeof candidate.summary === "string" ? candidate.summary.trim() : undefined,
        source_text_nav: candidate.source_text_nav,
        source_type: typeMap.get(normalizeKey(source)),
        target_type: typeMap.get(normalizeKey(target)),
        relation_origin: rel.relation_origin,
        relation_definition: typeof rel.relation_definition === "string" ? rel.relation_definition.trim() : undefined,
        evidence_span: typeof rel.evidence_span === "string" ? rel.evidence_span.trim() : undefined,
        context_chunk: typeof rel.context_chunk === "string" ? rel.context_chunk.trim() : undefined,
        confidence: typeof rel.confidence === "number" ? rel.confidence : undefined,
        conflict_id: conflictId,
      });
    }
  }

  for (const entry of superseded) {
    const key = normalizeKey(entry.relation_key);
    if (!key) continue;
    const at = toIso(entry.superseded_at, nowIso);
    const conflictId = normalizeKey(entry.conflict_id);
    supersededByRelation.set(key, at);
    if (conflictId) {
      supersededByComposite.set(conflictRelationKey(conflictId, key), at);
    }
  }

  const output: ProjectedRelation[] = [];
  for (const edge of args.graphView.edges) {
    const source = String(edge.source || "").trim();
    const target = String(edge.target || "").trim();
    const type = String(edge.type || "").trim().toLowerCase();
    if (!source || !target || !type) continue;
    const key = normalizeKey(edge.relation_key) || relationKey(source, type, target);
    const sourceEventId = typeof edge.source_event_id === "string" ? edge.source_event_id.trim() : "";
    const conflictId = typeof edge.conflict_id === "string" ? edge.conflict_id.trim() : "";
    const status = edge.status as RelationStatus;

    let detail: RelationDetail | undefined;
    if ((status === "pending_conflict" || status === "rejected") && conflictId) {
      detail = byConflict.get(conflictRelationKey(conflictId, key));
    }
    if (!detail && sourceEventId) {
      detail = byEvent.get(relationEventKey(key, sourceEventId));
    }
    if (!detail) {
      detail = byRelation.get(key);
    }

    let timestamp = detail?.timestamp || nowIso;
    if (status === "superseded") {
      timestamp = supersededByComposite.get(conflictRelationKey(conflictId, key)) || supersededByRelation.get(key) || timestamp;
    } else if ((status === "pending_conflict" || status === "rejected") && conflictId) {
      timestamp = conflictUpdatedAt.get(conflictId) || timestamp;
    }

    output.push({
      source,
      target,
      type,
      status,
      relation_key: key,
      source_event_id: sourceEventId || detail?.source_event_id,
      conflict_id: conflictId || detail?.conflict_id,
      timestamp: toIso(timestamp, nowIso),
      summary: detail?.summary || `${source} ${type} ${target}`,
      source_text_nav: detail?.source_text_nav,
      relation_origin: detail?.relation_origin,
      relation_definition: detail?.relation_definition,
      evidence_span: detail?.evidence_span || (typeof edge.evidence_span === "string" ? edge.evidence_span : undefined),
      context_chunk: detail?.context_chunk || (typeof edge.evidence_span === "string" ? edge.evidence_span : undefined),
      confidence: typeof edge.confidence === "number" ? edge.confidence : detail?.confidence,
      source_type: detail?.source_type,
      target_type: detail?.target_type,
    });
  }

  return output.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

function hardMatch(group: TimelineGroup, relation: ProjectedRelation): boolean {
  if (group.source_key !== normalizeKey(relation.source)) return false;
  if (group.relation_cluster !== relationCluster(relation.type)) return false;
  const targetKey = normalizeKey(relation.target);
  const targetClass = normalizeKey(relation.target_type || "");
  return group.targets.has(targetKey) || (!!group.target_class && !!targetClass && group.target_class === targetClass);
}

function softScore(group: TimelineGroup, relation: ProjectedRelation): number {
  const latest = group.relations[group.relations.length - 1];
  if (!latest) return 0;
  let score = 0;
  if (withinDays(latest.timestamp, relation.timestamp, 30)) score += 1;
  if (overlapRatio(`${latest.evidence_span || ""} ${latest.context_chunk || ""}`, `${relation.evidence_span || ""} ${relation.context_chunk || ""}`) >= 0.2) score += 1;
  if (diceSimilarity(`${latest.summary || ""} ${latest.context_chunk || ""}`, `${relation.summary || ""} ${relation.context_chunk || ""}`) >= 0.82) score += 1;
  return score;
}

function buildTimelineGroups(relations: ProjectedRelation[]): TimelineGroup[] {
  const groups: TimelineGroup[] = [];
  const sorted = [...relations].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  for (const relation of sorted) {
    let best: TimelineGroup | null = null;
    let bestScore = -1;
    for (const group of groups) {
      if (!hardMatch(group, relation)) continue;
      const score = softScore(group, relation);
      if (score >= 2 && score > bestScore) {
        best = group;
        bestScore = score;
      }
    }
    if (!best) {
      groups.push({
        source: relation.source,
        source_key: normalizeKey(relation.source),
        relation_type: relation.type,
        relation_cluster: relationCluster(relation.type),
        target_class: normalizeKey(relation.target_type || ""),
        targets: new Set<string>([normalizeKey(relation.target)]),
        relations: [relation],
        timeline_id: "",
      });
      continue;
    }
    best.relations.push(relation);
    best.targets.add(normalizeKey(relation.target));
  }

  const used = new Set<string>();
  for (const group of groups) {
    const targetScope = group.targets.size > 1 ? (group.target_class || "multi_target") : (group.relations[0]?.target || "target");
    const base = slugify(`${group.source}.${targetScope}.${group.relation_type}`);
    let id = base;
    let idx = 2;
    while (used.has(id)) {
      id = `${base}_${idx}`;
      idx += 1;
    }
    used.add(id);
    group.timeline_id = id;
  }

  return groups.sort((a, b) => a.timeline_id.localeCompare(b.timeline_id));
}
function escapeMarkdownLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]").replace(/\|/g, "\\|");
}

function entityLinkPath(entity: string, page: WikiPageKind): string {
  const fileName = `${slugify(entity)}.md`;
  if (page === "entity") return `./${fileName}`;
  return `../entities/${fileName}`;
}

function topicLinkPath(topic: string, page: WikiPageKind): string {
  const fileName = `${slugify(topic)}.md`;
  if (page === "topic") return `./${fileName}`;
  return `../topics/${fileName}`;
}

function timelineLinkPath(fileName: string, page: WikiPageKind): string {
  if (page === "timeline") return `./${fileName}`;
  return `../timelines/${fileName}`;
}

function markdownLink(label: string, target: string): string {
  return `[${escapeMarkdownLabel(label)}](${target})`;
}

function renderRelationLine(args: {
  relation: ProjectedRelation;
  page: WikiPageKind;
  currentEntity?: string;
  currentTopic?: string;
}): string {
  const relation = args.relation;
  const attrs: string[] = [
    `evidence=${sanitizeInline(relation.evidence_span)}`,
    `confidence=${typeof relation.confidence === "number" ? relation.confidence : "n/a"}`,
    `source_event_id=${sanitizeInline(relation.source_event_id)}`,
  ];
  if (relation.conflict_id) attrs.push(`conflict_id=${sanitizeInline(relation.conflict_id)}`);
  if (relation.relation_origin) attrs.push(`relation_origin=${relation.relation_origin}`);
  if (relation.relation_origin === "llm_custom" && relation.relation_definition) {
    attrs.push(`relation_definition=${sanitizeInline(relation.relation_definition).replace(/,/g, ";")}`);
  }
  const sourceLabel = sanitizeInline(relation.source, relation.source);
  const targetLabel = sanitizeInline(relation.target, relation.target);
  const source = normalizeKey(sourceLabel) === normalizeKey(args.currentEntity || "")
    ? sourceLabel
    : markdownLink(sourceLabel, entityLinkPath(sourceLabel, args.page));
  const target = normalizeKey(targetLabel) === normalizeKey(args.currentEntity || "")
    ? targetLabel
    : markdownLink(targetLabel, entityLinkPath(targetLabel, args.page));
  const typeLabel = sanitizeInline(relation.type, relation.type);
  const typeLink = normalizeKey(typeLabel) === normalizeKey(args.currentTopic || "")
    ? typeLabel
    : markdownLink(typeLabel, topicLinkPath(typeLabel, args.page));
  return `- ${source} --${typeLink}/${relation.status}--> ${target} (${attrs.join(", ")})`;
}

function timelineLines(relations: ProjectedRelation[]): string[] {
  if (relations.length === 0) return ["- (none)"];
  const out: string[] = [];
  for (const relation of [...relations].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))) {
    const evidenceIds = [
      `graph:relation:${relation.relation_key}`,
      relation.source_event_id ? `graph:event:${relation.source_event_id}` : "",
      relation.conflict_id ? `graph:conflict:${relation.conflict_id}` : "",
    ].filter(Boolean).join(", ");
    out.push(`- ${relation.timestamp} | ${relation.status}`);
    out.push(`  evidence_ids: ${evidenceIds || "n/a"}`);
    out.push(`  context_chunk: ${sanitizeInline(relation.context_chunk || relation.evidence_span)}`);
  }
  return out;
}

function latestStatus(relations: ProjectedRelation[]): RelationStatus {
  if (relations.length === 0) return "active";
  return [...relations].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)).slice(-1)[0].status;
}

function sourceRefs(relations: ProjectedRelation[]): string[] {
  const dedupe = new Set<string>();
  const out: string[] = [];
  for (const relation of relations) {
    const nav = relation.source_text_nav;
    const line = nav
      ? `- source_event_id=${sanitizeInline(relation.source_event_id)} | layer=${sanitizeInline(nav.layer)} | source_file=${sanitizeInline(nav.source_file)} | source_memory_id=${sanitizeInline(nav.source_memory_id)}${nav.fulltext_anchor ? ` | fulltext_anchor=${sanitizeInline(nav.fulltext_anchor)}` : ""}`
      : `- source_event_id=${sanitizeInline(relation.source_event_id)} | fulltext_nav_missing=true`;
    if (!dedupe.has(line)) {
      dedupe.add(line);
      out.push(line);
    }
  }
  return out.length > 0 ? out : ["- (none)"];
}

function section(title: string, lines: string[]): string[] {
  return [`## ${title}`, "", ...(lines.length > 0 ? lines : ["- (none)"]), ""];
}

function relatedEntitiesSectionLines(args: {
  relations: ProjectedRelation[];
  page: WikiPageKind;
  currentEntity?: string;
}): string[] {
  const current = normalizeKey(args.currentEntity || "");
  const set = new Set<string>();
  for (const relation of args.relations) {
    for (const entity of [relation.source, relation.target]) {
      const display = String(entity || "").trim();
      const key = normalizeKey(display);
      if (!display || !key || key === current) continue;
      set.add(display);
    }
  }
  const values = [...set].sort((a, b) => a.localeCompare(b));
  return values.length > 0
    ? values.map(value => `- ${markdownLink(value, entityLinkPath(value, args.page))}`)
    : ["- (none)"];
}

function relatedTopicsSectionLines(args: {
  relations: ProjectedRelation[];
  page: WikiPageKind;
  currentTopic?: string;
}): string[] {
  const current = normalizeKey(args.currentTopic || "");
  const set = new Set<string>();
  for (const relation of args.relations) {
    const topic = String(relation.type || "").trim();
    const key = normalizeKey(topic);
    if (!topic || !key || key === current) continue;
    set.add(topic);
  }
  const values = [...set].sort((a, b) => a.localeCompare(b));
  return values.length > 0
    ? values.map(value => `- ${markdownLink(value, topicLinkPath(value, args.page))}`)
    : ["- (none)"];
}

function relatedTimelineSectionLines(args: {
  relations: ProjectedRelation[];
  page: WikiPageKind;
  relationTimelineMap: Map<string, { id: string; file: string }>;
  currentTimelineFile?: string;
}): string[] {
  const set = new Map<string, { id: string; file: string }>();
  for (const relation of args.relations) {
    const key = relationIdentity(relation);
    const hit = args.relationTimelineMap.get(key);
    if (!hit) continue;
    if (args.currentTimelineFile && hit.file === args.currentTimelineFile) continue;
    set.set(hit.file, hit);
  }
  const values = [...set.values()].sort((a, b) => a.id.localeCompare(b.id));
  return values.length > 0
    ? values.map(value => `- ${markdownLink(value.id, timelineLinkPath(value.file, args.page))}`)
    : ["- (none)"];
}

function relationIdentity(relation: ProjectedRelation): string {
  return `${relation.relation_key}|${relation.source_event_id || ""}|${relation.timestamp}|${relation.status}`;
}

export function projectWikiKnowledge(args: ProjectWikiKnowledgeArgs): ProjectWikiKnowledgeResult {
  const wikiRoot = path.join(args.memoryRoot, "wiki");
  const entitiesDir = path.join(wikiRoot, "entities");
  const topicsDir = path.join(wikiRoot, "topics");
  const timelinesDir = path.join(wikiRoot, "timelines");
  const indexPath = path.join(wikiRoot, "index.md");
  const projectionIndexPath = path.join(wikiRoot, ".projection_index.json");
  ensureDir(wikiRoot);
  ensureDir(entitiesDir);
  ensureDir(topicsDir);
  ensureDir(timelinesDir);

  const relations = buildProjectedRelations({
    memoryRoot: args.memoryRoot,
    graphView: args.graphView,
  });

  const byEntity = new Map<string, { display: string; relations: ProjectedRelation[] }>();
  const byTopic = new Map<string, ProjectedRelation[]>();
  for (const relation of relations) {
    for (const entity of [relation.source, relation.target]) {
      const display = entity.trim();
      const key = display.toLowerCase();
      if (!key) continue;
      if (!byEntity.has(key)) {
        byEntity.set(key, { display, relations: [] });
      }
      byEntity.get(key)?.relations.push(relation);
    }
    if (!byTopic.has(relation.type)) {
      byTopic.set(relation.type, []);
    }
    byTopic.get(relation.type)?.push(relation);
  }

  const timelineGroups = buildTimelineGroups(relations);
  const timelineMeta = timelineGroups.map(group => {
    const targetScope = group.targets.size > 1 ? (group.target_class || "multi_target") : (group.relations[0]?.target || "target");
    const timelineId = `${group.source}.${targetScope}.${group.relation_type}`;
    const fileName = `${group.timeline_id}.md`;
    const latest = latestStatus(group.relations);
    return {
      group,
      targetScope,
      timelineId,
      fileName,
      latest,
    };
  });
  const relationTimelineMap = new Map<string, { id: string; file: string }>();
  for (const item of timelineMeta) {
    for (const relation of item.group.relations) {
      relationTimelineMap.set(relationIdentity(relation), { id: item.timelineId, file: item.fileName });
    }
  }

  const entityEntries: Array<{ name: string; file: string }> = [];
  const topicEntries: Array<{ type: string; file: string }> = [];
  const timelineEntries: Array<{ id: string; file: string; relation_type: string; source: string; target_scope: string; latest_status: RelationStatus }> = [];

  for (const [, value] of sortByString([...byEntity.entries()], item => item[0])) {
    const entity = value.display;
    const fileName = `${slugify(entity)}.md`;
    const filePath = path.join(entitiesDir, fileName);
    entityEntries.push({ name: entity, file: fileName });
    const active = value.relations
      .filter(item => item.status === "active")
      .map(item => renderRelationLine({ relation: item, page: "entity", currentEntity: entity }));
    const pending = value.relations
      .filter(item => item.status === "pending_conflict")
      .map(item => renderRelationLine({ relation: item, page: "entity", currentEntity: entity }));
    const history = value.relations
      .filter(item => item.status === "superseded" || item.status === "rejected")
      .map(item => renderRelationLine({ relation: item, page: "entity", currentEntity: entity }));
    const body = [
      `# Entity: ${entity}`,
      "",
      "## Summary",
      "",
      `${entity} has ${value.relations.length} related facts in graph projection.`,
      "",
      ...section("Current Facts", active),
      ...section("Disputed Facts", pending),
      ...section("History", history),
      ...section("Related Entities", relatedEntitiesSectionLines({
        relations: value.relations,
        page: "entity",
        currentEntity: entity,
      })),
      ...section("Related Topics", relatedTopicsSectionLines({
        relations: value.relations,
        page: "entity",
      })),
      ...section("Related Timelines", relatedTimelineSectionLines({
        relations: value.relations,
        page: "entity",
        relationTimelineMap,
      })),
      ...section("Source References", sourceRefs(value.relations)),
      "## Updated At",
      "",
      `- ${args.graphView.updated_at}`,
      "",
    ];
    fs.writeFileSync(filePath, `${body.join("\n")}\n`, "utf-8");
  }

  for (const [topic, topicRelations] of sortByString([...byTopic.entries()], item => item[0])) {
    const fileName = `${slugify(topic)}.md`;
    const filePath = path.join(topicsDir, fileName);
    topicEntries.push({ type: topic, file: fileName });
    const body = [
      `# Topic: ${topic}`,
      "",
      "## Summary",
      "",
      `${topic} has ${topicRelations.length} relations. Latest status is ${latestStatus(topicRelations)}.`,
      "",
      ...section("Timeline", timelineLines(topicRelations)),
      "## Latest Status",
      "",
      `- ${latestStatus(topicRelations)}`,
      "",
      ...section("Relations", topicRelations.map(item => renderRelationLine({
        relation: item,
        page: "topic",
        currentTopic: topic,
      }))),
      ...section("Related Entities", relatedEntitiesSectionLines({
        relations: topicRelations,
        page: "topic",
      })),
      ...section("Related Timelines", relatedTimelineSectionLines({
        relations: topicRelations,
        page: "topic",
        relationTimelineMap,
      })),
      ...section("Source References", sourceRefs(topicRelations)),
      "## Updated At",
      "",
      `- ${args.graphView.updated_at}`,
      "",
    ];
    fs.writeFileSync(filePath, `${body.join("\n")}\n`, "utf-8");
  }

  for (const item of timelineMeta) {
    const group = item.group;
    const timelineId = item.timelineId;
    const fileName = item.fileName;
    const targetScope = item.targetScope;
    const filePath = path.join(timelinesDir, fileName);
    const latest = item.latest;
    timelineEntries.push({
      id: timelineId,
      file: fileName,
      relation_type: group.relation_type,
      source: group.source,
      target_scope: targetScope,
      latest_status: latest,
    });
    const body = [
      `# Timeline: ${timelineId}`,
      "",
      "## Summary",
      "",
      `${group.source} ${group.relation_type} timeline has ${group.relations.length} entries. Latest status is ${latest}.`,
      "",
      ...section("Timeline", timelineLines(group.relations)),
      "## Latest Status",
      "",
      `- ${latest}`,
      "",
      ...section("Relations", group.relations.map(rel => renderRelationLine({
        relation: rel,
        page: "timeline",
      }))),
      ...section("Related Entities", relatedEntitiesSectionLines({
        relations: group.relations,
        page: "timeline",
      })),
      ...section("Related Topics", relatedTopicsSectionLines({
        relations: group.relations,
        page: "timeline",
      })),
      ...section("Related Timelines", relatedTimelineSectionLines({
        relations: group.relations,
        page: "timeline",
        relationTimelineMap,
        currentTimelineFile: fileName,
      })),
      ...section("Source References", sourceRefs(group.relations)),
      "## Updated At",
      "",
      `- ${args.graphView.updated_at}`,
      "",
    ];
    fs.writeFileSync(filePath, `${body.join("\n")}\n`, "utf-8");
  }

  const indexBody = [
    "# Memory Wiki Index",
    "",
    `Generated at: ${new Date().toISOString()}`,
    "",
    "## Entities",
    "",
    ...(entityEntries.length > 0 ? entityEntries.map(item => `- [${item.name}](entities/${item.file})`) : ["- (none)"]),
    "",
    "## Topics",
    "",
    ...(topicEntries.length > 0 ? topicEntries.map(item => `- [${item.type}](topics/${item.file})`) : ["- (none)"]),
    "",
    "## Timelines",
    "",
    ...(timelineEntries.length > 0 ? timelineEntries.map(item => `- [${item.id}](timelines/${item.file})`) : ["- (none)"]),
    "",
  ];
  fs.writeFileSync(indexPath, `${indexBody.join("\n")}\n`, "utf-8");

  const projectionIndex = {
    updated_at: new Date().toISOString(),
    graph_updated_at: args.graphView.updated_at,
    entities: entityEntries.map(item => ({ name: item.name, path: `entities/${item.file}` })),
    topics: topicEntries.map(item => ({ type: item.type, path: `topics/${item.file}` })),
    timelines: timelineEntries.map(item => ({
      id: item.id,
      relation_type: item.relation_type,
      source: item.source,
      target_scope: item.target_scope,
      latest_status: item.latest_status,
      path: `timelines/${item.file}`,
    })),
    queue_events: args.queueEvents.map(item => ({ id: item.id, type: item.type, at: item.at })),
  };
  fs.writeFileSync(projectionIndexPath, `${JSON.stringify(projectionIndex, null, 2)}\n`, "utf-8");

  return {
    updated_at: projectionIndex.updated_at,
    entities_count: entityEntries.length,
    topics_count: topicEntries.length,
    timelines_count: timelineEntries.length,
    files: {
      index: indexPath,
      projection_index: projectionIndexPath,
      entities_dir: entitiesDir,
      topics_dir: topicsDir,
      timelines_dir: timelinesDir,
    },
  };
}

export type { WriteGraphViewProjectionResult, ProjectWikiKnowledgeResult };
