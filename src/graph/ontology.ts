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
  entityTypes: string[];
  entityAliases: Record<string, string[]>;
  relationTypes: string[];
  relationTypeAliases: Record<string, string>;
  relationRules: RelationRule[];
  highValueRelationTypes: string[];
  relatedToMaxRatio: number;
  relatedToMaxAbsolute: number;
  minRelationConfidence: number;
  evidenceSpanRequired: boolean;
  endpointMentionRequired: boolean;
  defaultEntityType: string;
}

export type GraphQualityMode = "off" | "warn" | "strict";

export interface GraphRelation {
  source: string;
  target: string;
  type: string;
  evidence_span?: string;
  confidence?: number;
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
  entityTypes: [
    "Person",
    "FamilyMember",
    "Friend",
    "Team",
    "Project",
    "Task",
    "Plan",
    "Milestone",
    "Location",
    "Event",
    "Schedule",
    "Habit",
    "HealthItem",
    "FinanceItem",
    "Issue",
    "Fix",
    "Decision",
    "Action",
    "Risk",
    "Blocker",
    "Assumption",
    "Concept",
    "Resource",
    "Document",
  ],
  entityAliases: {
    "OpenClaw": ["openclaw", "插件", "该项目", "本项目"],
    "FamilyMember": ["家人", "家庭成员", "亲人"],
    "Friend": ["朋友", "好友"],
    "Location": ["地点", "位置", "住址", "地址"],
    "Event": ["活动", "事情", "事项"],
    "Schedule": ["日程", "安排", "计划表"],
    "Habit": ["习惯", "作息"],
    "HealthItem": ["健康", "体检", "药物", "锻炼"],
    "FinanceItem": ["账单", "支出", "收入", "预算"],
    "Person": ["我", "自己", "本人", "同事", "客户", "用户"],
    "Project": ["项目", "工程"],
    "Task": ["任务", "待办", "todo"],
    "Milestone": ["里程碑", "节点"],
    "Issue": ["问题", "故障", "报错"],
    "Fix": ["修复", "解决方案"],
  },
  relationTypes: [
    "depends_on",
    "blocks",
    "related_to",
    "causes",
    "resolves",
    "plans_to",
    "scheduled_for",
    "lives_in",
    "cares_for",
    "pays_for",
    "supports",
    "conflicts_with",
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
    plan_to: "plans_to",
    schedule_for: "scheduled_for",
    located_in: "lives_in",
    care_for: "cares_for",
    pay_for: "pays_for",
    support: "supports",
    conflict_with: "conflicts_with",
    "依赖于": "depends_on",
    "依赖": "depends_on",
    "取决于": "depends_on",
    "阻塞": "blocks",
    "卡住": "blocks",
    "导致": "causes",
    "引起": "causes",
    "解决": "resolves",
    "修复": "resolves",
    "属于": "belongs_to",
    "归属": "belongs_to",
    "负责": "owned_by",
    "由": "owned_by",
    "参考": "references",
    "引用": "references",
    "偏好": "prefers",
    "更喜欢": "prefers",
    "实现": "implements",
    "需要": "requires",
    "计划做": "plans_to",
    "打算": "plans_to",
    "安排在": "scheduled_for",
    "约在": "scheduled_for",
    "住在": "lives_in",
    "居住在": "lives_in",
    "照顾": "cares_for",
    "看护": "cares_for",
    "支付": "pays_for",
    "付款": "pays_for",
    "支持": "supports",
    "冲突": "conflicts_with",
    "矛盾": "conflicts_with",
    "相关": "related_to",
    "有关": "related_to",
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
  highValueRelationTypes: ["depends_on", "blocks", "resolves", "owned_by"],
  relatedToMaxRatio: 0.35,
  relatedToMaxAbsolute: 2,
  minRelationConfidence: 0.35,
  evidenceSpanRequired: true,
  endpointMentionRequired: true,
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

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, value));
}

function sanitizeEntityAliases(input: unknown): Record<string, string[]> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return DEFAULT_SCHEMA.entityAliases;
  }
  const output: Record<string, string[]> = {};
  for (const [canonical, aliasesRaw] of Object.entries(input as Record<string, unknown>)) {
    const canonicalName = canonical.trim();
    if (!canonicalName) continue;
    const aliases = Array.isArray(aliasesRaw)
      ? aliasesRaw.map(item => (typeof item === "string" ? item.trim() : "")).filter(Boolean)
      : [];
    output[canonicalName] = aliases;
  }
  return Object.keys(output).length > 0 ? output : DEFAULT_SCHEMA.entityAliases;
}

function buildAliasLookup(schema: GraphSchemaConfig): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const [canonical, aliases] of Object.entries(schema.entityAliases || {})) {
    const normalizedCanonical = canonical.trim();
    if (!normalizedCanonical) continue;
    lookup.set(normalizedCanonical.toLowerCase(), normalizedCanonical);
    for (const alias of aliases || []) {
      const normalizedAlias = alias.trim().toLowerCase();
      if (!normalizedAlias) continue;
      lookup.set(normalizedAlias, normalizedCanonical);
    }
  }
  return lookup;
}

export function normalizeEntityName(raw: string, schema: GraphSchemaConfig): string {
  const value = raw.trim();
  if (!value) return "";
  const lookup = buildAliasLookup(schema);
  return lookup.get(value.toLowerCase()) || value;
}

function tokenizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function entityMentionedInText(entity: string, sourceText: string, schema: GraphSchemaConfig): boolean {
  const text = tokenizeForMatch(sourceText || "");
  if (!text) return false;
  const target = tokenizeForMatch(entity);
  if (target && text.includes(target)) {
    return true;
  }
  const aliases = schema.entityAliases[entity] || [];
  for (const alias of aliases) {
    const normalized = tokenizeForMatch(alias);
    if (normalized && text.includes(normalized)) {
      return true;
    }
  }
  return false;
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
      entityTypes: Array.isArray(parsed.entityTypes) && parsed.entityTypes.length > 0 ? parsed.entityTypes : DEFAULT_SCHEMA.entityTypes,
      entityAliases: sanitizeEntityAliases(parsed.entityAliases),
      relationTypes: Array.isArray(parsed.relationTypes) && parsed.relationTypes.length > 0 ? parsed.relationTypes : DEFAULT_SCHEMA.relationTypes,
      relationTypeAliases: parsed.relationTypeAliases && typeof parsed.relationTypeAliases === "object" ? parsed.relationTypeAliases : DEFAULT_SCHEMA.relationTypeAliases,
      relationRules: Array.isArray(parsed.relationRules) && parsed.relationRules.length > 0 ? parsed.relationRules : DEFAULT_SCHEMA.relationRules,
      highValueRelationTypes: Array.isArray(parsed.highValueRelationTypes) && parsed.highValueRelationTypes.length > 0
        ? parsed.highValueRelationTypes.map(item => String(item).trim()).filter(Boolean)
        : DEFAULT_SCHEMA.highValueRelationTypes,
      relatedToMaxRatio: clampNumber(parsed.relatedToMaxRatio, 0, 1, DEFAULT_SCHEMA.relatedToMaxRatio),
      relatedToMaxAbsolute: Math.max(0, Math.floor(clampNumber(parsed.relatedToMaxAbsolute, 0, 20, DEFAULT_SCHEMA.relatedToMaxAbsolute))),
      minRelationConfidence: clampNumber(parsed.minRelationConfidence, 0, 1, DEFAULT_SCHEMA.minRelationConfidence),
      evidenceSpanRequired: typeof parsed.evidenceSpanRequired === "boolean" ? parsed.evidenceSpanRequired : DEFAULT_SCHEMA.evidenceSpanRequired,
      endpointMentionRequired: typeof parsed.endpointMentionRequired === "boolean" ? parsed.endpointMentionRequired : DEFAULT_SCHEMA.endpointMentionRequired,
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
  relations: GraphRelation[];
  entities: string[];
  entityTypes?: Record<string, string>;
  schema: GraphSchemaConfig;
  sourceText?: string;
  qualityMode?: GraphQualityMode;
}): {
  accepted: GraphRelation[];
  rejected: Array<{ reason: string; relation: GraphRelation }>;
  warnings: Array<{ reason: string; relation: GraphRelation }>;
} {
  const mode: GraphQualityMode = args.qualityMode || "warn";
  const accepted: GraphRelation[] = [];
  const rejected: Array<{ reason: string; relation: GraphRelation }> = [];
  const warnings: Array<{ reason: string; relation: GraphRelation }> = [];
  const entitySet = new Set(args.entities.map(item => item.trim()).filter(Boolean));
  const rules = toKeyedRules(args.schema.relationRules);
  const typeMap: Record<string, string> = {};
  for (const [name, type] of Object.entries(args.entityTypes || {})) {
    if (typeof name === "string" && typeof type === "string" && name.trim() && type.trim()) {
      typeMap[name.trim()] = type.trim();
    }
  }
  for (const relation of args.relations) {
    const source = normalizeEntityName(relation.source || "", args.schema);
    const target = normalizeEntityName(relation.target || "", args.schema);
    const type = normalizeRelationType(relation.type, args.schema);
    const confidence = typeof relation.confidence === "number"
      ? Math.max(0, Math.min(1, relation.confidence))
      : undefined;
    const evidenceSpan = typeof relation.evidence_span === "string" ? relation.evidence_span.trim() : "";
    const normalized: GraphRelation = { source, target, type, confidence, evidence_span: evidenceSpan || undefined };
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
    if (typeof confidence === "number" && confidence < args.schema.minRelationConfidence) {
      rejected.push({ reason: "low_relation_confidence", relation: normalized });
      continue;
    }
    if (mode !== "off" && args.schema.evidenceSpanRequired && args.sourceText) {
      if (!evidenceSpan) {
        if (mode === "strict") {
          rejected.push({ reason: "missing_evidence_span", relation: normalized });
          continue;
        }
        warnings.push({ reason: "missing_evidence_span", relation: normalized });
      } else if (!tokenizeForMatch(args.sourceText).includes(tokenizeForMatch(evidenceSpan))) {
        if (mode === "strict") {
          rejected.push({ reason: "evidence_span_not_in_source", relation: normalized });
          continue;
        }
        warnings.push({ reason: "evidence_span_not_in_source", relation: normalized });
      }
    }
    if (mode !== "off" && args.schema.endpointMentionRequired && args.sourceText) {
      const sourceHit = entityMentionedInText(source, args.sourceText, args.schema);
      const targetHit = entityMentionedInText(target, args.sourceText, args.schema);
      if (!sourceHit || !targetHit) {
        if (mode === "strict") {
          rejected.push({ reason: "endpoint_not_in_source_text", relation: normalized });
          continue;
        }
        warnings.push({ reason: "endpoint_not_in_source_text", relation: normalized });
      }
    }
    accepted.push(normalized);
  }
  if (accepted.length > 0) {
    const highValueSet = new Set((args.schema.highValueRelationTypes || []).map(item => item.toLowerCase()));
    const relatedTo = accepted.filter(item => item.type === "related_to");
    const highValueCount = accepted.filter(item => highValueSet.has(item.type)).length;
    const maxByRatio = Math.max(1, Math.ceil(Math.max(1, highValueCount) * args.schema.relatedToMaxRatio));
    const maxAllowed = Math.max(0, Math.min(args.schema.relatedToMaxAbsolute, maxByRatio));
    if (relatedTo.length > maxAllowed) {
      const sorted = [...relatedTo].sort((a, b) => (b.confidence || 0.5) - (a.confidence || 0.5));
      const keepSet = new Set(sorted.slice(0, maxAllowed).map(item => `${item.source}|${item.type}|${item.target}`));
      const filtered = accepted.filter(item => item.type !== "related_to" || keepSet.has(`${item.source}|${item.type}|${item.target}`));
      if (filtered.length !== accepted.length) {
        for (const item of accepted) {
          if (item.type === "related_to" && !keepSet.has(`${item.source}|${item.type}|${item.target}`)) {
            rejected.push({ reason: "related_to_throttled", relation: item });
          }
        }
      }
      accepted.length = 0;
      accepted.push(...filtered);
    }
  }
  return { accepted, rejected, warnings };
}

export function normalizeEntityType(raw: string, schema: GraphSchemaConfig): string {
  const value = raw.trim();
  const entityTypes = new Set(schema.entityTypes.map(item => item));
  if (entityTypes.has(value)) {
    return value;
  }
  return schema.defaultEntityType;
}

export interface GraphMemoryRecord {
  id: string;
  source_event_id: string;
  source_layer: "archive_event" | "active_only";
  archive_event_id?: string;
  session_id: string;
  source_file?: string;
  timestamp: string;
  entities: string[];
  entity_types: Record<string, string>;
  relations: GraphRelation[];
  gate_source: "sync" | "session_end" | "manual";
  event_type?: string;
  schema_version?: string;
  confidence?: number;
}

export interface ValidateGraphPayloadResult {
  valid: boolean;
  reason?: string;
  normalized?: GraphMemoryRecord;
  warnings?: string[];
}

export function validateGraphPayload(args: {
  sourceEventId: string;
  sourceLayer: "archive_event" | "active_only";
  archiveEventId?: string;
  sessionId: string;
  sourceFile?: string;
  eventType?: string;
  entities?: string[];
  entity_types?: Record<string, string>;
  relations?: GraphRelation[];
  gateSource: "sync" | "session_end" | "manual";
  confidence?: number;
  schema: GraphSchemaConfig;
  sourceText?: string;
  qualityMode?: GraphQualityMode;
}): ValidateGraphPayloadResult {
  const sourceEventId = (args.sourceEventId || "").trim();
  if (!sourceEventId) {
    return { valid: false, reason: "source_event_id_empty" };
  }
  const entities = Array.isArray(args.entities)
    ? [...new Set(args.entities.map(item => normalizeEntityName(typeof item === "string" ? item : "", args.schema)).filter(Boolean))]
    : [];
  
  if (entities.length === 0) {
    return { valid: false, reason: "entities_empty" };
  }
  
  const entityTypes = args.entity_types || {};
  const validEntityTypes = new Set(args.schema.entityTypes);
  const normalizedEntityTypes: Record<string, string> = {};
  const aliasLookup = buildAliasLookup(args.schema);
  for (const [nameRaw, typeRaw] of Object.entries(entityTypes)) {
    if (typeof typeRaw !== "string") continue;
    const normalizedName = aliasLookup.get(nameRaw.trim().toLowerCase()) || nameRaw.trim();
    if (!normalizedName) continue;
    normalizedEntityTypes[normalizedName] = typeRaw.trim();
  }
  
  for (const entity of entities) {
    const providedType = normalizedEntityTypes[entity];
    if (providedType && validEntityTypes.has(providedType)) {
      normalizedEntityTypes[entity] = providedType;
    } else {
      return { valid: false, reason: `entity_type_missing_or_invalid:${entity}` };
    }
  }
  
  const relationValidation = validateRelations({
    relations: Array.isArray(args.relations) ? args.relations : [],
    entities,
    entityTypes: normalizedEntityTypes,
    schema: args.schema,
    sourceText: args.sourceText,
    qualityMode: args.qualityMode,
  });
  
  if (relationValidation.accepted.length === 0) {
    return { valid: false, reason: "relations_empty_or_invalid" };
  }
  
  const id = `gph_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
  
  return {
    valid: true,
    warnings: relationValidation.warnings.map(item => item.reason),
    normalized: {
      id,
      source_event_id: args.sourceEventId.trim(),
      source_layer: args.sourceLayer,
      archive_event_id: typeof args.archiveEventId === "string" && args.archiveEventId.trim()
        ? args.archiveEventId.trim()
        : undefined,
      session_id: args.sessionId,
      source_file: typeof args.sourceFile === "string" && args.sourceFile.trim()
        ? args.sourceFile.trim()
        : undefined,
      timestamp: new Date().toISOString(),
      entities,
      entity_types: normalizedEntityTypes,
      relations: relationValidation.accepted,
      gate_source: args.gateSource,
      event_type: typeof args.eventType === "string" && args.eventType.trim()
        ? normalizeEventType(args.eventType, args.schema)
        : undefined,
      schema_version: "1.0.0",
      confidence: args.confidence,
    },
  };
}
