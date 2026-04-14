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
export type RelationOrigin = "canonical" | "llm_custom";

export interface GraphRelation {
  source: string;
  target: string;
  type: string;
  relation_origin?: RelationOrigin;
  relation_definition?: string;
  mapping_hint?: string;
  evidence_span?: string;
  context_chunk?: string;
  confidence?: number;
}

export interface SourceTextNav {
  layer: "archive_event" | "active_only";
  session_id: string;
  source_file: string;
  source_memory_id: string;
  source_event_id: string;
  fulltext_anchor?: string;
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
    "ConfigFile",
    "Preference",
    "Case",
    "Pattern",
    "Date",
  ],
  entityAliases: {
    "OpenClaw": ["openclaw", "插件", "该项目", "本项目"],
    "FamilyMember": ["家人", "家庭成员", "亲人"],
    "Friend": ["朋友", "好友"],
    "Team": ["团队", "小组", "组", "班组"],
    "Location": ["地点", "位置", "住址", "地址"],
    "Event": ["活动", "事情", "事项"],
    "Schedule": ["日程", "安排", "计划表"],
    "Habit": ["习惯", "作息"],
    "HealthItem": ["健康", "体检", "药物", "锻炼"],
    "FinanceItem": ["账单", "支出", "收入", "预算"],
    "Plan": ["计划", "方案", "路线图"],
    "Preference": ["偏好", "习惯选择"],
    "Document": ["文档", "说明文档", "手册", "wiki", "README", "PRD", "方案文档"],
    "Resource": ["资源", "物品", "物件", "设备", "工具", "素材", "资产"],
    "ConfigFile": ["配置文件", "config", "配置"],
    "Decision": ["决策", "决定", "拍板"],
    "Action": ["动作", "操作", "执行"],
    "Risk": ["风险", "隐患"],
    "Blocker": ["阻塞", "卡点", "障碍"],
    "Assumption": ["假设", "前提"],
    "Concept": ["概念", "术语"],
    "Case": ["案例", "case"],
    "Pattern": ["模式", "pattern"],
    "Date": ["日期", "时间", "时间点"],
    "Person": ["我", "自己", "本人", "同事", "客户", "用户", "姓名", "名字", "人名", "成员", "联系人"],
    "Project": ["项目", "工程", "项目线"],
    "Task": ["任务", "待办", "todo", "工单", "事项"],
    "Milestone": ["里程碑", "节点"],
    "Issue": ["问题", "故障", "报错"],
    "Fix": ["修复", "解决方案"],
  },
  relationTypes: [
    "depends_on",
    "blocks",
    "unblocks",
    "causes",
    "impacts",
    "resolves",
    "encountered_bug",
    "solved_with",
    "uses_tech",
    "integrates_with",
    "migrates_to",
    "replaced_by",
    "has_subtask",
    "belongs_to",
    "owned_by",
    "implements",
    "requires",
    "plans_to",
    "planned_for",
    "scheduled_for",
    "references",
    "documents",
    "defined_in",
    "configured_in",
    "supports",
    "conflicts_with",
    "duplicates",
    "supersedes",
    "assigned_to",
    "reviewed_by",
    "approved_by",
    "rejected_by",
    "reported_by",
    "lives_in",
    "cares_for",
    "pays_for",
    "prefers",
    "has_spouse",
    "has_child",
    "birthday_on",
    "anniversary_on",
  ],
  relationTypeAliases: {
    dependency: "depends_on",
    blocked_by: "blocks",
    unblock: "unblocks",
    impact: "impacts",
    plan_to: "plans_to",
    plan_for: "planned_for",
    schedule_for: "scheduled_for",
    located_in: "lives_in",
    care_for: "cares_for",
    pay_for: "pays_for",
    support: "supports",
    conflict_with: "conflicts_with",
    use_tech: "uses_tech",
    tech_stack: "uses_tech",
    integrate_with: "integrates_with",
    migrate_to: "migrates_to",
    replace_by: "replaced_by",
    replace_with: "replaced_by",
    bug: "encountered_bug",
    bug_on: "encountered_bug",
    fix_with: "solved_with",
    solve_with: "solved_with",
    solved_by: "solved_with",
    subtask_of: "has_subtask",
    child_task: "has_subtask",
    documented_by: "documents",
    defined_by: "defined_in",
    config_in: "configured_in",
    duplicate_of: "duplicates",
    superseded_by: "supersedes",
    assign_to: "assigned_to",
    review_by: "reviewed_by",
    approve_by: "approved_by",
    reject_by: "rejected_by",
    report_by: "reported_by",
    "依赖于": "depends_on",
    "依赖": "depends_on",
    "取决于": "depends_on",
    "阻塞": "blocks",
    "卡住": "blocks",
    "解除阻塞": "unblocks",
    "导致": "causes",
    "引起": "causes",
    "影响": "impacts",
    "解决": "resolves",
    "修复": "resolves",
    "遇到报错": "encountered_bug",
    "通过": "solved_with",
    "使用技术": "uses_tech",
    "集成": "integrates_with",
    "迁移到": "migrates_to",
    "被替代": "replaced_by",
    "子任务": "has_subtask",
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
    "计划于": "planned_for",
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
    "记录": "documents",
    "定义于": "defined_in",
    "配置于": "configured_in",
    "重复": "duplicates",
    "取代": "supersedes",
    "分配给": "assigned_to",
    "评审": "reviewed_by",
    "批准": "approved_by",
    "拒绝": "rejected_by",
    "报告": "reported_by",
    belongs: "belongs_to",
    owner_of: "owned_by",
    refer_to: "references",
    preference_for: "prefers",
    implement: "implements",
    need: "requires",
    technology: "uses_tech",
    encountered_issue: "encountered_bug",
    spouse: "has_spouse",
    wife_of: "has_spouse",
    husband_of: "has_spouse",
    child_of: "has_child",
    parent_of: "has_child",
    birthday: "birthday_on",
    born_on: "birthday_on",
    anniversary: "anniversary_on",
    married_on: "anniversary_on",
  },
  relationRules: [
    { type: "depends_on", fromTypes: ["Task", "Plan", "Milestone"], toTypes: ["Task", "Plan", "Milestone"], allowSelfLoop: false },
    { type: "blocks", fromTypes: ["Issue", "Task", "Risk"], toTypes: ["Task", "Plan"], allowSelfLoop: false },
    { type: "causes", fromTypes: ["Issue", "Risk", "Assumption"], toTypes: ["Issue", "Risk"], allowSelfLoop: false },
    { type: "resolves", fromTypes: ["Fix", "Decision", "Action"], toTypes: ["Issue", "Blocker"], allowSelfLoop: false },
    { type: "belongs_to", fromTypes: ["Task", "Issue", "Fix", "Decision"], toTypes: ["Project", "Plan", "Milestone"], allowSelfLoop: false },
    { type: "owned_by", fromTypes: ["Task", "Plan", "Project", "Issue"], toTypes: ["Person", "Team"], allowSelfLoop: false },
    { type: "uses_tech", fromTypes: ["Project", "Task", "Fix", "Action"], toTypes: ["Resource", "Document", "Concept", "Project"], allowSelfLoop: false },
    { type: "encountered_bug", fromTypes: ["Project", "Task", "Action"], toTypes: ["Issue", "Blocker"], allowSelfLoop: false },
    { type: "solved_with", fromTypes: ["Issue", "Blocker"], toTypes: ["Fix", "Action", "Decision", "Resource"], allowSelfLoop: false },
    { type: "has_subtask", fromTypes: ["Project", "Plan", "Milestone", "Task"], toTypes: ["Task"], allowSelfLoop: false },
    { type: "planned_for", fromTypes: ["Task", "Plan", "Milestone"], toTypes: ["Date", "Schedule", "Milestone"], allowSelfLoop: false },
  ],
  highValueRelationTypes: [
    "depends_on",
    "blocks",
    "unblocks",
    "causes",
    "impacts",
    "resolves",
    "encountered_bug",
    "solved_with",
    "uses_tech",
    "integrates_with",
    "migrates_to",
    "replaced_by",
    "has_subtask",
    "belongs_to",
    "owned_by",
    "implements",
    "requires",
    "planned_for",
    "scheduled_for",
  ],
  relatedToMaxRatio: 0,
  relatedToMaxAbsolute: 0,
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

function normalizeAliasKey(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[`"'“”‘’]/g, "")
    .replace(/[【】[\]{}()<>]/g, " ")
    .replace(/[_\-\/\\|]+/g, " ")
    .replace(/[,:;!?]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildEntityLookupKeys(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }
  const normalized = normalizeAliasKey(trimmed);
  const compact = normalized.replace(/\s+/g, "");
  const keys = new Set<string>();
  keys.add(trimmed.toLowerCase());
  if (normalized) {
    keys.add(normalized);
  }
  if (compact) {
    keys.add(compact);
  }
  return [...keys];
}

function chooseCanonicalAlias(leftRaw: string, rightRaw: string): string {
  const left = leftRaw.trim();
  const right = rightRaw.trim();
  if (!left) return right;
  if (!right) return left;
  const leftAscii = /[A-Za-z]/.test(left);
  const rightAscii = /[A-Za-z]/.test(right);
  if (leftAscii && !rightAscii) return left;
  if (!leftAscii && rightAscii) return right;
  return left.length >= right.length ? left : right;
}

function buildRuntimeAliasLookup(sourceText?: string): Map<string, string> {
  const lookup = new Map<string, string>();
  const text = (sourceText || "").trim();
  if (!text) {
    return lookup;
  }
  const pairPattern = /([^()\n（）]{1,80})\s*[（(]\s*([^()\n（）]{1,80})\s*[)）]/g;
  let matched: RegExpExecArray | null = pairPattern.exec(text);
  while (matched) {
    const left = (matched[1] || "").trim();
    const right = (matched[2] || "").trim();
    if (left && right && left !== right) {
      const canonical = chooseCanonicalAlias(left, right);
      const alias = canonical === left ? right : left;
      for (const key of buildEntityLookupKeys(alias)) {
        lookup.set(key, canonical);
      }
      for (const key of buildEntityLookupKeys(canonical)) {
        lookup.set(key, canonical);
      }
    }
    matched = pairPattern.exec(text);
  }
  return lookup;
}

function buildAliasLookup(schema: GraphSchemaConfig): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const [canonical, aliases] of Object.entries(schema.entityAliases || {})) {
    const normalizedCanonical = canonical.trim();
    if (!normalizedCanonical) continue;
    for (const key of buildEntityLookupKeys(normalizedCanonical)) {
      lookup.set(key, normalizedCanonical);
    }
    for (const alias of aliases || []) {
      for (const key of buildEntityLookupKeys(alias)) {
        lookup.set(key, normalizedCanonical);
      }
    }
  }
  return lookup;
}

export function normalizeEntityName(raw: string, schema: GraphSchemaConfig, runtimeAliasLookup?: Map<string, string>): string {
  const value = raw.trim();
  if (!value) return "";
  const lookup = buildAliasLookup(schema);
  for (const key of buildEntityLookupKeys(value)) {
    const runtimeMapped = runtimeAliasLookup?.get(key);
    if (runtimeMapped) {
      return runtimeMapped;
    }
    const schemaMapped = lookup.get(key);
    if (schemaMapped) {
      return schemaMapped;
    }
  }
  return value;
}

export function getEntityMatchKeys(raw: string, schema: GraphSchemaConfig): string[] {
  const value = raw.trim();
  if (!value) {
    return [];
  }
  const canonical = normalizeEntityName(value, schema);
  const keys = new Set<string>();
  for (const key of buildEntityLookupKeys(value)) {
    keys.add(key);
  }
  for (const key of buildEntityLookupKeys(canonical)) {
    keys.add(key);
  }
  for (const alias of schema.entityAliases[canonical] || []) {
    for (const key of buildEntityLookupKeys(alias)) {
      keys.add(key);
    }
  }
  return [...keys];
}

function tokenizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function entityMentionedInText(entity: string, sourceText: string, schema: GraphSchemaConfig): boolean {
  const text = tokenizeForMatch(sourceText || "");
  if (!text) return false;
  const canonical = normalizeEntityName(entity, schema);
  const target = tokenizeForMatch(canonical || entity);
  if (target && text.includes(target)) {
    return true;
  }
  const aliases = schema.entityAliases[canonical] || [];
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
  if (!value) {
    return "";
  }
  const relationTypes = new Set(schema.relationTypes.map(item => item.toLowerCase()));
  const aliases = toLowerMap(schema.relationTypeAliases);
  if (relationTypes.has(value)) {
    return value;
  }
  const mapped = aliases[value];
  if (mapped) {
    return mapped;
  }
  const snakeCase = value.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (/^[a-z][a-z0-9_]*$/.test(snakeCase)) {
    return snakeCase;
  }
  return "";
}

export function isCanonicalRelationType(type: string, schema: GraphSchemaConfig): boolean {
  const value = type.trim().toLowerCase();
  if (!value) {
    return false;
  }
  const relationTypes = new Set(schema.relationTypes.map(item => item.toLowerCase()));
  return relationTypes.has(value);
}

export function getDefaultGraphSchema(): GraphSchemaConfig {
  return DEFAULT_SCHEMA;
}

export function buildRelationPromptHint(schema: GraphSchemaConfig): string {
  return [
    `Allowed canonical relation types: ${schema.relationTypes.join(", ")}.`,
    "Never use related_to.",
    "If no canonical relation fits, create a snake_case custom relation, set relation_origin=llm_custom, and include relation_definition.",
  ].join(" ");
}

const GENERIC_ENTITY_BLOCKLIST = new Set<string>([
  "用户",
  "我",
  "我们",
  "你",
  "你们",
  "他",
  "她",
  "他们",
  "问题",
  "方案",
  "实体",
  "系统",
  "task",
  "issue",
  "solution",
  "system",
  "person",
  "user",
  "thing",
]);

function isGenericEntityName(raw: string): boolean {
  const value = normalizeAliasKey(String(raw || ""));
  return value ? GENERIC_ENTITY_BLOCKLIST.has(value) : false;
}

function collectEntitiesFromRelations(
  relations: GraphRelation[],
  schema: GraphSchemaConfig,
  runtimeAliasLookup: Map<string, string>,
): string[] {
  const output = new Set<string>();
  for (const relation of relations) {
    const source = normalizeEntityName(relation.source || "", schema, runtimeAliasLookup);
    const target = normalizeEntityName(relation.target || "", schema, runtimeAliasLookup);
    if (source) output.add(source);
    if (target) output.add(target);
  }
  return [...output];
}

function extractResourceReferences(sourceText?: string): string[] {
  const text = (sourceText || "").trim();
  if (!text) {
    return [];
  }
  const output = new Set<string>();
  const urlMatches = text.match(/https?:\/\/[^\s)>"'`]+|www\.[^\s)>"'`]+/gi) || [];
  const normalizedUrls = urlMatches.map(item => item.trim()).filter(Boolean);
  for (const item of urlMatches) {
    output.add(item.trim());
  }
  const pathMatches = text.match(/[A-Za-z]:\\[^\s"']+|(?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,12}/g) || [];
  for (const item of pathMatches) {
    const value = item.trim();
    const compact = value.replace(/^\.\/+/, "").replace(/^\/+/, "");
    const coveredByUrl = normalizedUrls.some(url => url.includes(value) || (compact && url.includes(compact)));
    if (coveredByUrl) {
      continue;
    }
    if (value.length >= 4) {
      output.add(value);
    }
  }
  return [...output].slice(0, 12);
}

function inferEntityTypeFromName(entity: string, schema: GraphSchemaConfig): string {
  const valid = new Set(schema.entityTypes);
  const value = entity.trim();
  if (!value) {
    return schema.defaultEntityType;
  }
  if (valid.has("Date") && /(?:\d{4}-\d{2}-\d{2}|\d{1,2}月\d{1,2}日|\d{1,2}[/-]\d{1,2})/.test(value)) {
    return "Date";
  }
  if (valid.has("Resource") && /^(https?:\/\/|www\.)/i.test(value)) {
    return "Resource";
  }
  if (
    valid.has("Document")
    && (/([/\\].+\.[A-Za-z0-9]{1,12})$/.test(value) || /\.(md|txt|pdf|docx?|pptx?|xlsx?|json|yaml|yml|xml|html?)$/i.test(value))
  ) {
    return "Document";
  }
  if (valid.has("Team") && /(team|org|organization|团队|组织|公司)/i.test(value)) {
    return "Team";
  }
  if (valid.has("Project") && /(project|repo|仓库|项目|工程)/i.test(value)) {
    return "Project";
  }
  return schema.defaultEntityType;
}

function inferEvidenceSpanFromSource(
  sourceText: string,
  candidates: string[],
): string | undefined {
  const text = (sourceText || "").trim();
  if (!text) {
    return undefined;
  }
  const normalizedText = tokenizeForMatch(text);
  const uniqueCandidates = [...new Set(candidates.map(item => item.trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  for (const candidate of uniqueCandidates) {
    const normalized = tokenizeForMatch(candidate);
    if (normalized && normalizedText.includes(normalized)) {
      return candidate;
    }
  }
  return undefined;
}

function inferContextChunkFromSource(sourceText: string, anchors: string[]): string | undefined {
  const text = (sourceText || "").trim().replace(/\s+/g, " ");
  if (!text) return undefined;
  const normalizedAnchors = anchors.map(item => String(item || "").trim()).filter(Boolean);
  let hitIndex = -1;
  let hitAnchor = "";
  for (const anchor of normalizedAnchors) {
    const idx = text.indexOf(anchor);
    if (idx >= 0) {
      hitIndex = idx;
      hitAnchor = anchor;
      break;
    }
  }
  if (hitIndex < 0) {
    const fallback = text.slice(0, Math.min(text.length, 100)).trim();
    return fallback || undefined;
  }
  const targetLength = 80;
  const minLength = 50;
  const maxLength = 120;
  let start = Math.max(0, hitIndex - Math.floor((targetLength - hitAnchor.length) / 2));
  let end = Math.min(text.length, start + targetLength);
  if ((end - start) < minLength) {
    end = Math.min(text.length, start + minLength);
  }
  if ((end - start) > maxLength) {
    end = start + maxLength;
  }
  if (end >= text.length && (end - start) < minLength) {
    start = Math.max(0, end - minLength);
  }
  const chunk = text.slice(start, end).trim();
  return chunk || undefined;
}

function summaryMentionsEntity(
  summary: string,
  entity: string,
  schema: GraphSchemaConfig,
  runtimeAliasLookup: Map<string, string>,
): boolean {
  const normalizedSummary = tokenizeForMatch(summary || "");
  if (!normalizedSummary) {
    return false;
  }
  const canonical = normalizeEntityName(entity, schema, runtimeAliasLookup);
  const candidates = new Set<string>([
    entity,
    canonical,
    ...(schema.entityAliases[canonical] || []),
  ]);
  for (const candidateRaw of candidates) {
    const candidate = tokenizeForMatch(candidateRaw || "");
    if (candidate && normalizedSummary.includes(candidate)) {
      return true;
    }
  }
  return false;
}

function missingEntitiesInSummary(args: {
  summary: string;
  entities: string[];
  schema: GraphSchemaConfig;
  runtimeAliasLookup: Map<string, string>;
}): string[] {
  const missing: string[] = [];
  for (const entity of args.entities) {
    if (!summaryMentionsEntity(args.summary, entity, args.schema, args.runtimeAliasLookup)) {
      missing.push(entity);
    }
  }
  return missing;
}

function normalizeSourceTextNav(args: {
  sourceTextNav?: Partial<SourceTextNav>;
  sourceLayer: "archive_event" | "active_only";
  sourceEventId: string;
  archiveEventId?: string;
  sessionId: string;
  sourceFile?: string;
}): SourceTextNav | null {
  const nav = args.sourceTextNav || {};
  const layerRaw = typeof nav.layer === "string" ? nav.layer.trim() : "";
  const layer = layerRaw === "archive_event" || layerRaw === "active_only"
    ? layerRaw
    : args.sourceLayer;
  const sourceEventId = (typeof nav.source_event_id === "string" ? nav.source_event_id : "").trim()
    || args.sourceEventId.trim()
    || (typeof args.archiveEventId === "string" ? args.archiveEventId.trim() : "");
  const sourceMemoryId = (typeof nav.source_memory_id === "string" ? nav.source_memory_id : "").trim()
    || sourceEventId;
  const sessionId = (typeof nav.session_id === "string" ? nav.session_id : "").trim()
    || args.sessionId.trim();
  const sourceFile = (typeof nav.source_file === "string" ? nav.source_file : "").trim()
    || (typeof args.sourceFile === "string" ? args.sourceFile.trim() : "");
  const fulltextAnchor = typeof nav.fulltext_anchor === "string" ? nav.fulltext_anchor.trim() : "";
  if (!layer || !sessionId || !sourceFile || !sourceEventId || !sourceMemoryId) {
    return null;
  }
  return {
    layer,
    session_id: sessionId,
    source_file: sourceFile,
    source_memory_id: sourceMemoryId,
    source_event_id: sourceEventId,
    fulltext_anchor: fulltextAnchor || undefined,
  };
}

function shouldRetryWithFallbackRelations(rejectedReasons: Set<string>): boolean {
  const hardStopReasons = new Set<string>([
    "missing_relation_confidence",
    "missing_evidence_span",
    "low_relation_confidence",
    "empty_edge",
  ]);
  for (const reason of rejectedReasons) {
    if (hardStopReasons.has(reason)) {
      return false;
    }
  }
  return true;
}

function buildFallbackRelations(args: {
  entities: string[];
  entityTypes: Record<string, string>;
  relations: GraphRelation[];
  sourceText?: string;
  schema: GraphSchemaConfig;
  runtimeAliasLookup: Map<string, string>;
}): GraphRelation[] {
  const output: GraphRelation[] = [];
  const dedupe = new Set<string>();
  const entitySet = new Set(args.entities);
  const sourceText = (args.sourceText || "").trim();
  const fallbackConfidence = Math.max(args.schema.minRelationConfidence + 0.05, 0.55);

  const pushRelation = (relation: GraphRelation): void => {
    const source = normalizeEntityName(relation.source || "", args.schema, args.runtimeAliasLookup);
    const target = normalizeEntityName(relation.target || "", args.schema, args.runtimeAliasLookup);
    const type = normalizeRelationType(relation.type || "", args.schema);
    const isCanonical = isCanonicalRelationType(type, args.schema);
    const relationOrigin: RelationOrigin = relation.relation_origin || (isCanonical ? "canonical" : "llm_custom");
    const relationDefinitionRaw = typeof relation.relation_definition === "string" ? relation.relation_definition.trim() : "";
    const relationDefinition = relationOrigin === "llm_custom"
      ? (relationDefinitionRaw || `LLM custom relation inferred from type '${type}'.`)
      : relationDefinitionRaw;
    const evidenceSpan = typeof relation.evidence_span === "string" ? relation.evidence_span.trim() : "";
    const contextChunkRaw = typeof relation.context_chunk === "string" ? relation.context_chunk.trim() : "";
    const contextChunk = contextChunkRaw || inferContextChunkFromSource(sourceText, [evidenceSpan, source, target].filter(Boolean));
    const confidence = typeof relation.confidence === "number"
      ? Math.max(0, Math.min(1, relation.confidence))
      : fallbackConfidence;
    if (!source || !target || source === target) return;
    if (!entitySet.has(source) || !entitySet.has(target)) return;
    if (!type || type === "related_to") return;
    if (relationOrigin === "llm_custom" && !relationDefinition) return;
    if (!evidenceSpan) return;
    const key = `${source}|${type}|${target}`;
    if (dedupe.has(key)) return;
    dedupe.add(key);
    output.push({
      source,
      target,
      type,
      relation_origin: relationOrigin,
      relation_definition: relationDefinition || undefined,
      mapping_hint: typeof relation.mapping_hint === "string" ? relation.mapping_hint.trim() || undefined : undefined,
      evidence_span: evidenceSpan,
      context_chunk: contextChunk,
      confidence,
    });
  };

  for (const relation of args.relations) {
    const sourceRaw = (relation.source || "").trim();
    const targetRaw = (relation.target || "").trim();
    const evidence =
      (typeof relation.evidence_span === "string" && relation.evidence_span.trim())
      || inferEvidenceSpanFromSource(sourceText, [sourceRaw, targetRaw])
      || "";
    pushRelation({
      source: sourceRaw,
      target: targetRaw,
      type: relation.type || "",
      relation_origin: relation.relation_origin,
      relation_definition: relation.relation_definition,
      mapping_hint: relation.mapping_hint,
      evidence_span: evidence,
      context_chunk: inferContextChunkFromSource(sourceText, [evidence, sourceRaw, targetRaw].filter(Boolean)),
      confidence: typeof relation.confidence === "number" ? relation.confidence : fallbackConfidence,
    });
  }

  if (output.length === 0) {
    const resources = args.entities.filter(entity => {
      const type = (args.entityTypes[entity] || "").trim();
      return type === "Resource" || type === "Document";
    });
    const anchors = args.entities.filter(entity => !resources.includes(entity) && (args.entityTypes[entity] || "").trim() !== "Date");
    const anchor = anchors[0];
    if (anchor) {
      for (const resource of resources.slice(0, 3)) {
        const evidence = inferEvidenceSpanFromSource(sourceText, [resource, anchor]) || "";
        pushRelation({
          source: anchor,
          target: resource,
          type: "references",
          evidence_span: evidence,
          context_chunk: inferContextChunkFromSource(sourceText, [evidence, anchor, resource].filter(Boolean)),
          confidence: fallbackConfidence,
        });
      }
    }
  }

  if (output.length === 0) {
    const nonDateEntities = args.entities.filter(entity => (args.entityTypes[entity] || "").trim() !== "Date");
    if (nonDateEntities.length >= 2) {
      const source = nonDateEntities[0];
      for (const target of nonDateEntities.slice(1)) {
        const evidence = inferEvidenceSpanFromSource(sourceText, [source, target]) || "";
        pushRelation({
          source,
          target,
          type: "co_occurs_with",
          relation_origin: "llm_custom",
          relation_definition: "Source and target are explicitly co-mentioned within the same source chunk.",
          mapping_hint: "references",
          evidence_span: evidence,
          context_chunk: inferContextChunkFromSource(sourceText, [evidence, source, target].filter(Boolean)),
          confidence: fallbackConfidence,
        });
        if (output.length > 0) {
          break;
        }
      }
    }
  }

  return output;
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
  runtimeAliasLookup?: Map<string, string>;
}): {
  accepted: GraphRelation[];
  rejected: Array<{ reason: string; relation: GraphRelation }>;
  warnings: Array<{ reason: string; relation: GraphRelation }>;
} {
  const mode: GraphQualityMode = args.qualityMode || "warn";
  const accepted: GraphRelation[] = [];
  const rejected: Array<{ reason: string; relation: GraphRelation }> = [];
  const warnings: Array<{ reason: string; relation: GraphRelation }> = [];
  const runtimeAliasLookup = args.runtimeAliasLookup || new Map<string, string>();
  const normalizedSourceText = (args.sourceText || "").trim().replace(/\s+/g, " ");
  const entitySet = new Set(
    args.entities
      .map(item => normalizeEntityName(item, args.schema, runtimeAliasLookup))
      .filter(Boolean),
  );
  const rules = toKeyedRules(args.schema.relationRules);
  const typeMap: Record<string, string> = {};
  for (const [name, type] of Object.entries(args.entityTypes || {})) {
    if (typeof name === "string" && typeof type === "string" && name.trim() && type.trim()) {
      const normalizedName = normalizeEntityName(name, args.schema, runtimeAliasLookup);
      if (normalizedName) {
        typeMap[normalizedName] = type.trim();
      }
    }
  }
  for (const relation of args.relations) {
    const source = normalizeEntityName(relation.source || "", args.schema, runtimeAliasLookup);
    const target = normalizeEntityName(relation.target || "", args.schema, runtimeAliasLookup);
    const type = normalizeRelationType(relation.type, args.schema);
    const typeIsCanonical = isCanonicalRelationType(type, args.schema);
    const relationOriginRaw = typeof relation.relation_origin === "string" ? relation.relation_origin.trim() : "";
    const relationOriginProvided: RelationOrigin | "" = relationOriginRaw === "canonical" || relationOriginRaw === "llm_custom"
      ? relationOriginRaw
      : "";
    // Keep relation_origin aligned with normalized type to avoid blocking valid custom relations.
    const relationOrigin: RelationOrigin = typeIsCanonical ? "canonical" : "llm_custom";
    const relationDefinition = typeof relation.relation_definition === "string" ? relation.relation_definition.trim() : "";
    const mappingHint = typeof relation.mapping_hint === "string" ? relation.mapping_hint.trim() : "";
    const confidence = typeof relation.confidence === "number"
      ? Math.max(0, Math.min(1, relation.confidence))
      : undefined;
    const evidenceSpan = typeof relation.evidence_span === "string" ? relation.evidence_span.trim() : "";
    const contextChunkRaw = typeof relation.context_chunk === "string" ? relation.context_chunk.trim() : "";
    const contextChunk = contextChunkRaw || inferContextChunkFromSource(normalizedSourceText, [evidenceSpan, source, target].filter(Boolean));
    const normalized: GraphRelation = {
      source,
      target,
      type,
      relation_origin: relationOrigin,
      relation_definition: relationDefinition || undefined,
      mapping_hint: mappingHint || undefined,
      confidence,
      evidence_span: evidenceSpan || undefined,
      context_chunk: contextChunk || undefined,
    };
    if (!source || !target) {
      rejected.push({ reason: "empty_edge", relation: normalized });
      continue;
    }
    if (!type) {
      rejected.push({ reason: "invalid_relation_type", relation: normalized });
      continue;
    }
    if (type === "related_to") {
      rejected.push({ reason: "related_to_detected", relation: normalized });
      continue;
    }
    if (relationOriginProvided && relationOriginProvided !== relationOrigin) {
      warnings.push({ reason: "relation_origin_autocorrected", relation: normalized });
    }
    if (!entitySet.has(source) || !entitySet.has(target)) {
      rejected.push({ reason: "edge_entity_missing", relation: normalized });
      continue;
    }
    const rule = typeIsCanonical ? rules.get(type) : undefined;
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
    if (typeof confidence !== "number") {
      rejected.push({ reason: "missing_relation_confidence", relation: normalized });
      continue;
    }
    if (args.schema.evidenceSpanRequired && !evidenceSpan) {
      rejected.push({ reason: "missing_evidence_span", relation: normalized });
      continue;
    }
    if (mode !== "off" && args.schema.evidenceSpanRequired && args.sourceText) {
      if (evidenceSpan && !tokenizeForMatch(args.sourceText).includes(tokenizeForMatch(evidenceSpan))) {
        if (mode === "strict") {
          rejected.push({ reason: "evidence_span_not_in_source", relation: normalized });
          continue;
        }
        warnings.push({ reason: "evidence_span_not_in_source", relation: normalized });
      }
    }
    if (mode !== "off") {
      if (!contextChunk) {
        warnings.push({ reason: "missing_context_chunk", relation: normalized });
      } else {
        const length = contextChunk.length;
        if (length < 50 || length > 120) {
          warnings.push({ reason: "context_chunk_length_out_of_range", relation: normalized });
        }
        if (normalizedSourceText && !normalizedSourceText.includes(contextChunk)) {
          warnings.push({ reason: "context_chunk_not_in_source", relation: normalized });
        }
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
  summary: string;
  source_text_nav: SourceTextNav;
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
  source_text_nav?: Partial<SourceTextNav>;
  summary?: string;
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
  const summary = typeof args.summary === "string" ? args.summary.trim() : "";
  if (!summary) {
    return { valid: false, reason: "missing_summary" };
  }
  const sourceTextNav = normalizeSourceTextNav({
    sourceTextNav: args.source_text_nav,
    sourceLayer: args.sourceLayer,
    sourceEventId,
    archiveEventId: args.archiveEventId,
    sessionId: args.sessionId,
    sourceFile: args.sourceFile,
  });
  if (!sourceTextNav) {
    return { valid: false, reason: "fulltext_navigation_missing" };
  }
  const baseWarnings: string[] = [];
  const runtimeAliasLookup = buildRuntimeAliasLookup(args.sourceText);
  const normalizedInputEntities = Array.isArray(args.entities)
    ? args.entities
      .map(item => normalizeEntityName(typeof item === "string" ? item : "", args.schema, runtimeAliasLookup))
      .filter(Boolean)
    : [];
  const relationEndpoints = collectEntitiesFromRelations(
    Array.isArray(args.relations) ? args.relations : [],
    args.schema,
    runtimeAliasLookup,
  );
  const resourceEntities = extractResourceReferences(args.sourceText)
    .map(item => normalizeEntityName(item, args.schema, runtimeAliasLookup))
    .filter(Boolean);
  const dedupedEntities = [...new Set([...normalizedInputEntities, ...relationEndpoints, ...resourceEntities])];
  const entities = dedupedEntities.filter(entity => !isGenericEntityName(entity));
  if (entities.length !== dedupedEntities.length) {
    baseWarnings.push("generic_entity_rejected");
  }

  if (entities.length === 0) {
    return { valid: false, reason: "entities_empty" };
  }
  const summaryMissingEntities = missingEntitiesInSummary({ summary, entities, schema: args.schema, runtimeAliasLookup });
  if (summaryMissingEntities.length > 0) {
    const summaryCoverageMode: GraphQualityMode = args.qualityMode || "warn";
    const missingAllEntities = summaryMissingEntities.length >= entities.length;
    if (summaryCoverageMode === "strict" || missingAllEntities) {
      return { valid: false, reason: "summary_missing_entities" };
    }
    baseWarnings.push(`summary_missing_entities_partial:${summaryMissingEntities.length}/${entities.length}`);
  }

  const entityTypes = args.entity_types || {};
  const validEntityTypes = new Set(args.schema.entityTypes);
  const normalizedEntityTypes: Record<string, string> = {};
  for (const [nameRaw, typeRaw] of Object.entries(entityTypes)) {
    if (typeof typeRaw !== "string") continue;
    const normalizedName = normalizeEntityName(nameRaw.trim(), args.schema, runtimeAliasLookup);
    if (!normalizedName) continue;
    normalizedEntityTypes[normalizedName] = typeRaw.trim();
  }

  for (const entity of entities) {
    const providedType = normalizedEntityTypes[entity];
    if (providedType && validEntityTypes.has(providedType)) {
      normalizedEntityTypes[entity] = providedType;
    } else {
      normalizedEntityTypes[entity] = inferEntityTypeFromName(entity, args.schema);
    }
  }

  const relationValidation = validateRelations({
    relations: Array.isArray(args.relations) ? args.relations : [],
    entities,
    entityTypes: normalizedEntityTypes,
    schema: args.schema,
    sourceText: args.sourceText,
    qualityMode: args.qualityMode,
    runtimeAliasLookup,
  });

  let acceptedRelations = relationValidation.accepted;
  const warnings = [...baseWarnings, ...relationValidation.warnings.map(item => item.reason)];
  if (acceptedRelations.length === 0) {
    const rejectedReasons = new Set(relationValidation.rejected.map(item => item.reason));
    if (!shouldRetryWithFallbackRelations(rejectedReasons)) {
      return { valid: false, reason: "relations_empty_or_invalid" };
    }
    const fallbackRelations = buildFallbackRelations({
      entities,
      entityTypes: normalizedEntityTypes,
      relations: Array.isArray(args.relations) ? args.relations : [],
      sourceText: args.sourceText,
      schema: args.schema,
      runtimeAliasLookup,
    });
    if (fallbackRelations.length > 0) {
      const fallbackValidation = validateRelations({
        relations: fallbackRelations,
        entities,
        entityTypes: normalizedEntityTypes,
        schema: args.schema,
        sourceText: args.sourceText,
        qualityMode: args.qualityMode,
        runtimeAliasLookup,
      });
      if (fallbackValidation.accepted.length > 0) {
        acceptedRelations = fallbackValidation.accepted;
        warnings.push("fallback_relations_applied");
        warnings.push(...fallbackValidation.warnings.map(item => item.reason));
      }
    }
  }

  if (acceptedRelations.length === 0) {
    return { valid: false, reason: "relations_empty_or_invalid" };
  }

  const id = `gph_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;

  return {
    valid: true,
    warnings: [...new Set(warnings)],
    normalized: {
      id,
      summary,
      source_text_nav: sourceTextNav,
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
      relations: acceptedRelations,
      gate_source: args.gateSource,
      event_type: typeof args.eventType === "string" && args.eventType.trim()
        ? normalizeEventType(args.eventType, args.schema)
        : undefined,
      schema_version: "1.0.0",
      confidence: args.confidence,
    },
  };
}
