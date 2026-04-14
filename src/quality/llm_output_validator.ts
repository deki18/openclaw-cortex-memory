import {
  getDefaultGraphSchema,
  isCanonicalRelationType,
  normalizeRelationType,
  type GraphSchemaConfig,
  type RelationOrigin,
} from "../graph/ontology";

export interface ValidationResult {
  valid: boolean;
  data: unknown;
  errors: string[];
  warnings: string[];
}

interface EventRecord {
  event_type?: unknown;
  summary?: unknown;
  cause?: unknown;
  process?: unknown;
  result?: unknown;
  entities?: unknown;
  entity_types?: unknown;
  relations?: unknown;
  confidence?: unknown;
  [key: string]: unknown;
}

export interface CleanedEventRecord {
  event_type: string;
  summary: string;
  cause: string;
  process: string;
  result: string;
  entities: string[];
  entity_types?: Record<string, string>;
  relations: Array<{
    source: string;
    target: string;
    type: string;
    relation_origin?: RelationOrigin;
    relation_definition?: string;
    mapping_hint?: string;
    evidence_span?: string;
    context_chunk?: string;
    confidence?: number;
  }>;
  confidence: number;
}

interface GateDecision {
  target_layer?: unknown;
  active_text?: unknown;
  event?: unknown;
  reason?: unknown;
}

const ANOMALY_PATTERNS = [
  /\d+\.\d+,\s*"[^"]+"/,
  /"[^"]+"\s+\d+\.\d+/,
  /,\s*\d+\.\d+,/,
  /"\w+\.\w+\.\w+"/,
  /\d+\.\w+\.\d+/,
  /out\s+\d+\.\d+/,
  /source\s+\d+/,
  /layer\s+\d+/,
];

const REQUIRED_EVENT_FIELDS = ["event_type", "summary"];
const VALID_TARGET_LAYERS = ["active_only", "archive_event", "skip"];

function detectDuplicateKeys(jsonString: string): string[] {
  const duplicates: string[] = [];
  const keyPattern = /"([^"\\]*(?:\\.[^"\\]*)*)"\s*:/g;
  const keyCounts = new Map<string, number>();
  let match;
  while ((match = keyPattern.exec(jsonString)) !== null) {
    const key = match[1];
    keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
  }
  for (const [key, count] of keyCounts) {
    if (count > 1) {
      duplicates.push(key);
    }
  }
  return duplicates;
}

function detectAnomalyPatterns(jsonString: string): string[] {
  const anomalies: string[] = [];
  for (const pattern of ANOMALY_PATTERNS) {
    const matches = jsonString.match(pattern);
    if (matches) {
      anomalies.push(`Pattern detected: ${matches[0].slice(0, 50)}`);
    }
  }
  return anomalies;
}

function looksLikeMarkdownFrontMatter(raw: string): boolean {
  const text = String(raw || "").trim();
  if (!text.startsWith("---")) {
    return false;
  }
  const lines = text.split(/\r?\n/);
  if (lines.length < 3) {
    return false;
  }
  let fenceCount = 0;
  for (const line of lines) {
    if (line.trim() === "---") {
      fenceCount += 1;
      if (fenceCount >= 2) {
        return true;
      }
    }
  }
  return false;
}

function isValidJsonStructure(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object") {
    return false;
  }
  const str = JSON.stringify(parsed);
  if (str.length < 2) {
    return false;
  }
  return true;
}

function validateEventRecord(event: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!event || typeof event !== "object") {
    errors.push("event is not an object");
    return { valid: false, errors };
  }
  const record = event as EventRecord;
  for (const field of REQUIRED_EVENT_FIELDS) {
    if (record[field] === undefined) {
      errors.push(`missing required field: ${field}`);
    }
  }
  if (record.event_type !== undefined && typeof record.event_type !== "string") {
    errors.push("event_type must be a string");
  }
  if (record.summary !== undefined && typeof record.summary !== "string") {
    errors.push("summary must be a string");
  }
  if (record.cause !== undefined && typeof record.cause !== "string") {
    errors.push("cause must be a string");
  }
  if (record.process !== undefined && typeof record.process !== "string") {
    errors.push("process must be a string");
  }
  if (record.result !== undefined && typeof record.result !== "string") {
    errors.push("result must be a string");
  }
  if (record.entities !== undefined && !Array.isArray(record.entities)) {
    errors.push("entities must be an array");
  }
  if (record.entity_types !== undefined) {
    if (typeof record.entity_types !== "object" || record.entity_types === null || Array.isArray(record.entity_types)) {
      errors.push("entity_types must be an object");
    }
  }
  if (record.relations !== undefined && !Array.isArray(record.relations)) {
    errors.push("relations must be an array");
  }
  if (record.confidence !== undefined) {
    if (typeof record.confidence !== "number" || record.confidence < 0 || record.confidence > 1) {
      errors.push("confidence must be a number between 0 and 1");
    }
  }
  return { valid: errors.length === 0, errors };
}

function validateGateDecision(decision: unknown, schema: GraphSchemaConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!decision || typeof decision !== "object") {
    errors.push("decision is not an object");
    return { valid: false, errors };
  }
  const record = decision as GateDecision;
  if (record.target_layer === undefined) {
    errors.push("missing target_layer");
  } else if (typeof record.target_layer !== "string") {
    errors.push("target_layer must be a string");
  } else if (!VALID_TARGET_LAYERS.includes(record.target_layer)) {
    errors.push(`invalid target_layer: ${record.target_layer}`);
  }
  if (record.target_layer === "archive_event") {
    const eventValidation = validateArchiveEvent(record.event, { schema });
    if (!eventValidation.valid) {
      errors.push(...eventValidation.errors.map(e => `event.${e}`));
    }
  }
  if (record.target_layer === "active_only") {
    if (record.active_text !== undefined && typeof record.active_text !== "string") {
      errors.push("active_text must be a string");
    }
  }
  if (record.target_layer === "skip") {
    if (record.reason !== undefined && typeof record.reason !== "string") {
      errors.push("reason must be a string");
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateLlmJsonOutput(rawString: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!rawString || typeof rawString !== "string") {
    errors.push("input is not a string");
    return { valid: false, data: null, errors, warnings };
  }
  const trimmed = rawString.trim();
  if (!trimmed) {
    errors.push("input is empty");
    return { valid: false, data: null, errors, warnings };
  }
  const duplicateKeys = detectDuplicateKeys(trimmed);
  if (duplicateKeys.length > 0) {
    warnings.push(`possible duplicate keys detected (global scan): ${duplicateKeys.slice(0, 5).join(", ")}`);
  }
  const anomalies = detectAnomalyPatterns(trimmed);
  if (anomalies.length > 0) {
    warnings.push(...anomalies);
  }
  let parsed: unknown;
  try {
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenceMatch?.[1]?.trim() || trimmed;
    parsed = JSON.parse(candidate);
  } catch (parseError) {
    if (looksLikeMarkdownFrontMatter(trimmed)) {
      errors.push("markdown_frontmatter_invalid");
    }
    errors.push(`JSON parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
    return { valid: false, data: null, errors, warnings };
  }
  if (!isValidJsonStructure(parsed)) {
    errors.push("parsed JSON has invalid structure");
    return { valid: false, data: null, errors, warnings };
  }
  return { valid: true, data: parsed, errors, warnings };
}

export function validateGateDecisionsOutput(rawString: string, options?: { schema?: GraphSchemaConfig }): ValidationResult {
  const baseResult = validateLlmJsonOutput(rawString);
  if (!baseResult.valid) {
    return baseResult;
  }
  const schema = options?.schema || getDefaultGraphSchema();
  const errors: string[] = [...baseResult.errors];
  const warnings: string[] = [...baseResult.warnings];
  const parsed = baseResult.data as Record<string, unknown>;
  let decisions: unknown[];
  if (Array.isArray(parsed)) {
    decisions = parsed;
  } else if (Array.isArray(parsed.decisions)) {
    decisions = parsed.decisions;
  } else {
    errors.push("output must be an array or contain a 'decisions' array");
    return { valid: false, data: null, errors, warnings };
  }
  const validatedDecisions: unknown[] = [];
  for (let i = 0; i < decisions.length; i++) {
    const decisionValidation = validateGateDecision(decisions[i], schema);
    if (!decisionValidation.valid) {
      warnings.push(`decision[${i}]: ${decisionValidation.errors.join("; ")}`);
    } else {
      validatedDecisions.push(decisions[i]);
    }
  }
  if (validatedDecisions.length === 0 && decisions.length > 0) {
    errors.push("no valid decisions found in output");
    return { valid: false, data: null, errors, warnings };
  }
  return {
    valid: true,
    data: validatedDecisions,
    errors,
    warnings,
  };
}

function cleanRelationRecord(
  raw: unknown,
  schema: GraphSchemaConfig,
): { relation?: CleanedEventRecord["relations"][number]; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") {
    return { errors: ["relation_not_object"] };
  }
  const rel = raw as Record<string, unknown>;
  const source = typeof rel.source === "string" ? rel.source.trim() : "";
  const target = typeof rel.target === "string" ? rel.target.trim() : "";
  const typeRaw = typeof rel.type === "string" ? rel.type.trim() : "";
  if (!source || !target) {
    errors.push("invalid_relation_fields");
    return { errors };
  }
  if (!typeRaw) {
    errors.push("missing_relation_type");
    return { errors };
  }
  const type = normalizeRelationType(typeRaw, schema);
  if (!type) {
    errors.push("invalid_relation_type");
    return { errors };
  }
  if (type === "related_to") {
    errors.push("related_to_detected");
    return { errors };
  }
  const isCanonical = isCanonicalRelationType(type, schema);
  // Keep relation_origin aligned with normalized relation type.
  const relationOrigin: RelationOrigin = isCanonical ? "canonical" : "llm_custom";
  const relationDefinitionRaw = typeof rel.relation_definition === "string" ? rel.relation_definition.trim() : "";
  const relationDefinition = relationOrigin === "llm_custom"
    ? (relationDefinitionRaw || `LLM custom relation inferred from type '${type}'.`)
    : relationDefinitionRaw;
  const mappingHint = typeof rel.mapping_hint === "string" ? rel.mapping_hint.trim() : "";
  const evidenceSpan = typeof rel.evidence_span === "string" ? rel.evidence_span.trim() : "";
  const contextChunk = typeof rel.context_chunk === "string" ? rel.context_chunk.trim() : "";
  const confidence = typeof rel.confidence === "number"
    ? Math.max(0, Math.min(1, rel.confidence))
    : undefined;
  return {
    relation: {
      source,
      target,
      type,
      relation_origin: relationOrigin,
      relation_definition: relationDefinition || undefined,
      mapping_hint: mappingHint || undefined,
      evidence_span: evidenceSpan || undefined,
      context_chunk: contextChunk || undefined,
      confidence,
    },
    errors,
  };
}

export function validateArchiveEvent(
  event: unknown,
  options?: { schema?: GraphSchemaConfig },
): { valid: boolean; errors: string[]; cleaned?: CleanedEventRecord } {
  const schema = options?.schema || getDefaultGraphSchema();
  const validation = validateEventRecord(event);
  if (!validation.valid) {
    return validation;
  }
  const record = event as EventRecord;
  const cleaned: CleanedEventRecord = {
    event_type: typeof record.event_type === "string" ? record.event_type.trim() : "insight",
    summary: typeof record.summary === "string" ? record.summary.trim() : "",
    cause: typeof record.cause === "string" ? record.cause.trim() : "",
    process: typeof record.process === "string" ? record.process.trim() : "",
    result: typeof record.result === "string" ? record.result.trim() : "",
    entities: Array.isArray(record.entities)
      ? record.entities.filter((e): e is string => typeof e === "string" && e.trim().length > 0).map(e => e.trim())
      : [],
    entity_types: typeof record.entity_types === "object" && record.entity_types !== null && !Array.isArray(record.entity_types)
      ? Object.fromEntries(
          Object.entries(record.entity_types as Record<string, unknown>)
            .filter(([key, value]) => typeof key === "string" && key.trim().length > 0 && typeof value === "string" && value.trim().length > 0)
            .map(([key, value]) => [key.trim(), (value as string).trim()]),
        )
      : undefined,
    relations: [],
    confidence: typeof record.confidence === "number"
      ? Math.max(0, Math.min(1, record.confidence))
      : 0.6,
  };
  if (!cleaned.summary) {
    return { valid: false, errors: ["summary is empty after cleaning"] };
  }
  if (!cleaned.cause) {
    return { valid: false, errors: ["cause is required for archive_event"] };
  }
  if (!cleaned.process) {
    return { valid: false, errors: ["process is required for archive_event"] };
  }
  if (!cleaned.result) {
    return { valid: false, errors: ["result is required for archive_event"] };
  }
  if (Array.isArray(record.relations)) {
    const relationErrors: string[] = [];
    const relations: CleanedEventRecord["relations"] = [];
    for (const relationRaw of record.relations) {
      const cleanedRelation = cleanRelationRecord(relationRaw, schema);
      if (cleanedRelation.relation) {
        relations.push(cleanedRelation.relation);
      }
      if (cleanedRelation.errors.length > 0) {
        relationErrors.push(...cleanedRelation.errors);
      }
    }
    cleaned.relations = relations;
    if (relationErrors.length > 0) {
      return { valid: false, errors: [...new Set(relationErrors)] };
    }
  }
  return { valid: true, errors: [], cleaned };
}

export function validateJsonlLine(line: string): { valid: boolean; record?: Record<string, unknown>; errors: string[] } {
  const errors: string[] = [];
  if (!line || !line.trim()) {
    return { valid: true, errors: [] };
  }
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    errors.push("invalid JSON");
    return { valid: false, errors };
  }
  if (!record || typeof record !== "object") {
    errors.push("record is not an object");
    return { valid: false, errors };
  }
  if (typeof record.id !== "string" || !record.id.trim()) {
    errors.push("missing or invalid id field");
  }
  if (typeof record.timestamp !== "string" || !record.timestamp.trim()) {
    errors.push("missing or invalid timestamp field");
  }
  if (typeof record.layer !== "string" || (record.layer !== "active" && record.layer !== "archive")) {
    errors.push("missing or invalid layer field");
  }
  return { valid: errors.length === 0, record, errors };
}

const GARBLED_CHAR_PATTERN = /[�锛銆鈥鈩鈹鍚鍙锟馃鉁]/g;

function textGarbledScore(input: string): { score: number; suspiciousCount: number } {
  const text = String(input || "").trim();
  if (!text) {
    return { score: 0, suspiciousCount: 0 };
  }
  const suspiciousMatches = text.match(GARBLED_CHAR_PATTERN) || [];
  const suspiciousCount = suspiciousMatches.length;
  const score = suspiciousCount / Math.max(1, text.length);
  return { score, suspiciousCount };
}

function hasLikelyGarbledText(input: string): boolean {
  const { score, suspiciousCount } = textGarbledScore(input);
  if (suspiciousCount === 0) return false;
  if (input.includes("�")) return true;
  return suspiciousCount >= 2 && score >= 0.05;
}

function hasValidSourceTextNav(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const nav = value as Record<string, unknown>;
  const layer = typeof nav.layer === "string" ? nav.layer.trim() : "";
  const sessionId = typeof nav.session_id === "string" ? nav.session_id.trim() : "";
  const sourceFile = typeof nav.source_file === "string" ? nav.source_file.trim() : "";
  const sourceMemoryId = typeof nav.source_memory_id === "string" ? nav.source_memory_id.trim() : "";
  const sourceEventId = typeof nav.source_event_id === "string" ? nav.source_event_id.trim() : "";
  const layerValid = layer === "archive_event" || layer === "active_only";
  return Boolean(layerValid && sessionId && sourceFile && sourceMemoryId && sourceEventId);
}

function summaryMentionsEntity(summary: string, entity: string): boolean {
  const normalizedSummary = String(summary || "").toLowerCase();
  const normalizedEntity = String(entity || "").toLowerCase();
  if (!normalizedSummary || !normalizedEntity) {
    return false;
  }
  return normalizedSummary.includes(normalizedEntity);
}

export function validateGraphRewritePayload(
  payload: unknown,
  options?: { schema?: GraphSchemaConfig },
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { valid: false, errors: ["graph_payload_not_object"] };
  }
  const record = payload as Record<string, unknown>;
  const summary = typeof record.summary === "string" ? record.summary.trim() : "";
  if (!summary) {
    errors.push("missing_summary");
  }
  if (!hasValidSourceTextNav(record.source_text_nav)) {
    errors.push("fulltext_navigation_missing");
  }
  const entities = Array.isArray(record.entities)
    ? record.entities.map(item => (typeof item === "string" ? item.trim() : "")).filter(Boolean)
    : [];
  if (entities.length === 0) {
    errors.push("missing_or_invalid_entities");
  }
  const entityNameSet = new Set(entities.map(item => item.toLowerCase()));
  const entityTypes = record.entity_types;
  if (!entityTypes || typeof entityTypes !== "object" || Array.isArray(entityTypes)) {
    errors.push("missing_or_invalid_entity_types");
  } else {
    const typeLookup = new Map<string, string>();
    for (const [entity, type] of Object.entries(entityTypes as Record<string, unknown>)) {
      const key = String(entity || "").trim().toLowerCase();
      const val = typeof type === "string" ? type.trim() : "";
      if (!key || !val) continue;
      typeLookup.set(key, val);
    }
    for (const entity of entities) {
      if (!typeLookup.has(entity.toLowerCase())) {
        errors.push(`entity_type_missing:${entity}`);
      }
    }
  }
  const schema = options?.schema || getDefaultGraphSchema();
  const relations = Array.isArray(record.relations) ? record.relations : [];
  if (relations.length === 0) {
    errors.push("missing_or_invalid_relations");
  } else {
    for (const relationRaw of relations) {
      if (!relationRaw || typeof relationRaw !== "object" || Array.isArray(relationRaw)) {
        errors.push("relation_not_object");
        continue;
      }
      const cleanedRelation = cleanRelationRecord(relationRaw, schema);
      if (!cleanedRelation.relation) {
        errors.push(...cleanedRelation.errors);
        continue;
      }
      const relation = cleanedRelation.relation;
      const source = relation.source;
      const target = relation.target;
      const evidenceSpan = typeof relation.evidence_span === "string" ? relation.evidence_span.trim() : "";
      const contextChunk = typeof relation.context_chunk === "string" ? relation.context_chunk.trim() : "";
      const confidence = relation.confidence;
      if (!evidenceSpan) {
        errors.push("missing_relation_evidence_span");
      }
      if (!contextChunk) {
        errors.push("missing_context_chunk");
      }
      if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        errors.push("missing_or_invalid_relation_confidence");
      }
      if (!entityNameSet.has(source.toLowerCase())) {
        errors.push(`relation_source_not_in_entities:${source}`);
      }
      if (!entityNameSet.has(target.toLowerCase())) {
        errors.push(`relation_target_not_in_entities:${target}`);
      }
    }
  }
  const confidence = typeof record.confidence === "number" ? record.confidence : NaN;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    errors.push("missing_or_invalid_confidence");
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

export function validateGraphJsonlLine(line: string): { valid: boolean; record?: Record<string, unknown>; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!line || !line.trim()) {
    return { valid: false, errors: ["empty_line"], warnings };
  }
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { valid: false, errors: ["invalid_json"], warnings };
  }
  if (!record || typeof record !== "object") {
    return { valid: false, errors: ["record_not_object"], warnings };
  }
  if (typeof record.id !== "string" || !record.id.trim()) {
    errors.push("missing_or_invalid_id");
  }
  if (typeof record.timestamp !== "string" || !record.timestamp.trim()) {
    errors.push("missing_or_invalid_timestamp");
  }
  const sourceEventId = typeof record.source_event_id === "string" ? record.source_event_id.trim() : "";
  const archiveEventId = typeof record.archive_event_id === "string" ? record.archive_event_id.trim() : "";
  if (!sourceEventId && !archiveEventId) {
    errors.push("missing_or_invalid_source_event_id");
  }
  const sourceLayer = typeof record.source_layer === "string" ? record.source_layer : "";
  const sourceLayerInvalid = sourceLayer !== "archive_event" && sourceLayer !== "active_only";
  if (sourceEventId && sourceLayerInvalid) {
    if (!archiveEventId) {
      errors.push("missing_or_invalid_source_layer");
    }
  }
  if (typeof record.session_id !== "string" || !record.session_id.trim()) {
    errors.push("missing_or_invalid_session_id");
  }
  const summary = typeof record.summary === "string" ? record.summary.trim() : "";
  if (!summary) {
    errors.push("missing_summary");
  }
  if (!hasValidSourceTextNav(record.source_text_nav)) {
    errors.push("fulltext_navigation_missing");
  }
  const entities = Array.isArray(record.entities) ? record.entities : [];
  if (!Array.isArray(record.entities) || entities.length === 0) {
    errors.push("missing_or_invalid_entities");
  }
  if (summary && Array.isArray(record.entities) && entities.length > 0) {
    const missingSummaryEntities = entities
      .map(item => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean)
      .filter(entity => !summaryMentionsEntity(summary, entity));
    if (missingSummaryEntities.length > 0) {
      errors.push("summary_missing_entities");
    }
  }
  const entityTypes = record.entity_types;
  if (!entityTypes || typeof entityTypes !== "object" || Array.isArray(entityTypes)) {
    errors.push("missing_or_invalid_entity_types");
  }
  const relations = Array.isArray(record.relations) ? record.relations : [];
  const schema = getDefaultGraphSchema();
  if (!Array.isArray(record.relations) || relations.length === 0) {
    errors.push("missing_or_invalid_relations");
  }
  for (const entity of entities) {
    if (typeof entity !== "string" || !entity.trim()) {
      errors.push("invalid_entity_item");
      continue;
    }
    if (hasLikelyGarbledText(entity)) {
      errors.push(`garbled_entity:${entity.slice(0, 24)}`);
    }
  }
  for (const relationRaw of relations) {
    const cleanedRelation = cleanRelationRecord(relationRaw, schema);
    if (!cleanedRelation.relation) {
      errors.push(...cleanedRelation.errors);
      continue;
    }
    const relation = cleanedRelation.relation;
    const source = relation.source;
    const target = relation.target;
    const type = relation.type;
    const evidenceSpan = typeof relation.evidence_span === "string" ? relation.evidence_span.trim() : "";
    const confidence = relation.confidence;
    if (!evidenceSpan) {
      errors.push("missing_relation_evidence_span");
    }
    const contextChunk = typeof relation.context_chunk === "string" ? relation.context_chunk.trim() : "";
    if (!contextChunk) {
      errors.push("missing_context_chunk");
    } else {
      const length = contextChunk.length;
      if (length < 50 || length > 120) {
        warnings.push("context_chunk_length_out_of_range");
      }
    }
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      errors.push("missing_or_invalid_relation_confidence");
    }
    if (hasLikelyGarbledText(source) || hasLikelyGarbledText(target) || hasLikelyGarbledText(type)) {
      errors.push(`garbled_relation:${source.slice(0, 16)}|${type.slice(0, 16)}|${target.slice(0, 16)}`);
    }
    if (evidenceSpan) {
      if (hasLikelyGarbledText(evidenceSpan)) {
        warnings.push("garbled_evidence_span");
      }
    }
  }
  return {
    valid: errors.length === 0,
    record,
    errors,
    warnings,
  };
}

export function createQualityLogger(baseLogger: {
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
}) {
  return {
    logValidationResult(context: string, result: ValidationResult): void {
      if (result.errors.length > 0) {
        baseLogger.warn(`quality_validation_failed context=${context} errors=${result.errors.join("|")}`);
      }
      if (result.warnings.length > 0) {
        baseLogger.debug(`quality_validation_warnings context=${context} warnings=${result.warnings.join("|")}`);
      }
    },
    logInvalidRecord(source: string, line: number, errors: string[]): void {
      baseLogger.warn(`quality_invalid_record source=${source} line=${line} errors=${errors.join("|")}`);
    },
  };
}
