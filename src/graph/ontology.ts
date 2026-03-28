import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

export interface RelationRule {
  type: string;
  fromTypes: string[];
  toTypes: string[];
  allowSelfLoop: boolean;
}

export interface GraphSchemaConfig {
  eventTypes: string[];
  eventTypeAliases: Record<string, string>;
  relationTypes: string[];
  relationTypeAliases: Record<string, string>;
  relationRules: RelationRule[];
  defaultEntityType: string;
}

const DEFAULT_SCHEMA: GraphSchemaConfig = {
  eventTypes: [
    "decision",
    "issue",
    "fix",
    "preference",
    "plan",
    "risk",
    "insight",
    "action_item",
    "conversation_summary",
    "constraint",
    "requirement",
    "milestone",
    "blocker",
    "dependency",
    "assumption",
    "retrospective",
    "follow_up",
  ],
  eventTypeAliases: {
    problem: "issue",
    error: "issue",
    bug: "issue",
    solution: "fix",
    workaround: "fix",
    todo: "action_item",
    next_step: "action_item",
    limitation: "constraint",
    guardrail: "constraint",
    spec: "requirement",
    acceptance_criteria: "requirement",
    deadline: "milestone",
    target: "milestone",
    roadblock: "blocker",
    stuck: "blocker",
    depends_on: "dependency",
    upstream: "dependency",
    hypothesis: "assumption",
    lesson: "retrospective",
    postmortem: "retrospective",
    followup: "follow_up",
    next_action: "follow_up",
  },
  relationTypes: [
    "depends_on",
    "blocks",
    "related_to",
    "causes",
    "resolves",
    "belongs_to",
    "owned_by",
    "references",
    "prefers",
    "implements",
    "requires",
  ],
  relationTypeAliases: {
    dependency: "depends_on",
    blocked_by: "blocks",
    linked_to: "related_to",
    belongs: "belongs_to",
    owner_of: "owned_by",
    refer_to: "references",
    preference_for: "prefers",
    implement: "implements",
    need: "requires",
  },
  relationRules: [
    { type: "depends_on", fromTypes: ["Task", "Plan", "Milestone"], toTypes: ["Task", "Plan", "Milestone"], allowSelfLoop: false },
    { type: "blocks", fromTypes: ["Issue", "Task", "Risk"], toTypes: ["Task", "Plan"], allowSelfLoop: false },
    { type: "causes", fromTypes: ["Issue", "Risk", "Assumption"], toTypes: ["Issue", "Risk"], allowSelfLoop: false },
    { type: "resolves", fromTypes: ["Fix", "Decision", "Action"], toTypes: ["Issue", "Blocker"], allowSelfLoop: false },
    { type: "belongs_to", fromTypes: ["Task", "Issue", "Fix", "Decision"], toTypes: ["Project", "Plan", "Milestone"], allowSelfLoop: false },
    { type: "owned_by", fromTypes: ["Task", "Plan", "Project", "Issue"], toTypes: ["Person", "Team"], allowSelfLoop: false },
  ],
  defaultEntityType: "Concept",
};

function toLowerMap(input: Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    output[key.trim().toLowerCase()] = value.trim();
  }
  return output;
}

function toKeyedRules(input: RelationRule[]): Map<string, RelationRule> {
  const map = new Map<string, RelationRule>();
  for (const item of input) {
    map.set(item.type.trim().toLowerCase(), item);
  }
  return map;
}

function schemaFilePath(projectRoot: string): string {
  return path.join(projectRoot, "schema", "graph.schema.yaml");
}

export function loadGraphSchema(projectRoot: string): GraphSchemaConfig {
  const filePath = schemaFilePath(projectRoot);
  if (!fs.existsSync(filePath)) {
    return DEFAULT_SCHEMA;
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8").trim();
    if (!raw) {
      return DEFAULT_SCHEMA;
    }
    const parsed = JSON.parse(raw) as Partial<GraphSchemaConfig>;
    return {
      eventTypes: Array.isArray(parsed.eventTypes) && parsed.eventTypes.length > 0 ? parsed.eventTypes : DEFAULT_SCHEMA.eventTypes,
      eventTypeAliases: parsed.eventTypeAliases && typeof parsed.eventTypeAliases === "object" ? parsed.eventTypeAliases : DEFAULT_SCHEMA.eventTypeAliases,
      relationTypes: Array.isArray(parsed.relationTypes) && parsed.relationTypes.length > 0 ? parsed.relationTypes : DEFAULT_SCHEMA.relationTypes,
      relationTypeAliases: parsed.relationTypeAliases && typeof parsed.relationTypeAliases === "object" ? parsed.relationTypeAliases : DEFAULT_SCHEMA.relationTypeAliases,
      relationRules: Array.isArray(parsed.relationRules) && parsed.relationRules.length > 0 ? parsed.relationRules : DEFAULT_SCHEMA.relationRules,
      defaultEntityType: typeof parsed.defaultEntityType === "string" && parsed.defaultEntityType.trim()
        ? parsed.defaultEntityType.trim()
        : DEFAULT_SCHEMA.defaultEntityType,
    };
  } catch {
    return DEFAULT_SCHEMA;
  }
}

export function normalizeEventType(raw: string, schema: GraphSchemaConfig): string {
  const value = raw.trim().toLowerCase();
  const aliases = toLowerMap(schema.eventTypeAliases);
  const eventTypes = new Set(schema.eventTypes.map(item => item.toLowerCase()));
  if (eventTypes.has(value)) {
    return value;
  }
  const mapped = aliases[value];
  if (mapped) {
    return mapped;
  }
  return "insight";
}

export function normalizeRelationType(raw: string, schema: GraphSchemaConfig): string {
  const value = raw.trim().toLowerCase();
  const relationTypes = new Set(schema.relationTypes.map(item => item.toLowerCase()));
  const aliases = toLowerMap(schema.relationTypeAliases);
  if (relationTypes.has(value)) {
    return value;
  }
  const mapped = aliases[value];
  if (mapped) {
    return mapped;
  }
  return "related_to";
}

export function buildCanonicalId(args: {
  eventType: string;
  summary: string;
  entities?: string[];
  relations?: Array<{ source: string; target: string; type: string }>;
  outcome?: string;
}): string {
  const entities = (args.entities || []).map(item => item.trim().toLowerCase()).filter(Boolean).sort();
  const relations = (args.relations || [])
    .map(item => `${item.source.trim().toLowerCase()}|${item.type.trim().toLowerCase()}|${item.target.trim().toLowerCase()}`)
    .sort();
  const payload = JSON.stringify({
    eventType: args.eventType.trim().toLowerCase(),
    summary: args.summary.trim().toLowerCase(),
    entities,
    relations,
    outcome: (args.outcome || "").trim().toLowerCase(),
  });
  return `can_${crypto.createHash("sha1").update(payload).digest("hex").slice(0, 20)}`;
}

export function validateRelations(args: {
  relations: Array<{ source: string; target: string; type: string }>;
  entities: string[];
  entityTypes?: Record<string, string>;
  schema: GraphSchemaConfig;
}): {
  accepted: Array<{ source: string; target: string; type: string }>;
  rejected: Array<{ reason: string; relation: { source: string; target: string; type: string } }>;
} {
  const accepted: Array<{ source: string; target: string; type: string }> = [];
  const rejected: Array<{ reason: string; relation: { source: string; target: string; type: string } }> = [];
  const entitySet = new Set(args.entities.map(item => item.trim()).filter(Boolean));
  const rules = toKeyedRules(args.schema.relationRules);
  const typeMap: Record<string, string> = {};
  for (const [name, type] of Object.entries(args.entityTypes || {})) {
    if (typeof name === "string" && typeof type === "string" && name.trim() && type.trim()) {
      typeMap[name.trim()] = type.trim();
    }
  }
  for (const relation of args.relations) {
    const source = relation.source.trim();
    const target = relation.target.trim();
    const type = normalizeRelationType(relation.type, args.schema);
    const normalized = { source, target, type };
    if (!source || !target) {
      rejected.push({ reason: "empty_edge", relation: normalized });
      continue;
    }
    if (!entitySet.has(source) || !entitySet.has(target)) {
      rejected.push({ reason: "edge_entity_missing", relation: normalized });
      continue;
    }
    const rule = rules.get(type);
    if (source === target && !(rule?.allowSelfLoop ?? false)) {
      rejected.push({ reason: "self_loop_blocked", relation: normalized });
      continue;
    }
    if (rule) {
      const fromType = (typeMap[source] || args.schema.defaultEntityType).toLowerCase();
      const toType = (typeMap[target] || args.schema.defaultEntityType).toLowerCase();
      const allowedFrom = new Set(rule.fromTypes.map(item => item.toLowerCase()));
      const allowedTo = new Set(rule.toTypes.map(item => item.toLowerCase()));
      if (allowedFrom.size > 0 && !allowedFrom.has(fromType)) {
        rejected.push({ reason: "from_type_invalid", relation: normalized });
        continue;
      }
      if (allowedTo.size > 0 && !allowedTo.has(toType)) {
        rejected.push({ reason: "to_type_invalid", relation: normalized });
        continue;
      }
    }
    accepted.push(normalized);
  }
  return { accepted, rejected };
}
