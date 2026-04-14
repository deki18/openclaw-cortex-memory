const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    gold: "",
    pred: "",
    thresholds: "",
    report: "",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--gold" && argv[i + 1]) {
      args.gold = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--pred" && argv[i + 1]) {
      args.pred = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--thresholds" && argv[i + 1]) {
      args.thresholds = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--report" && argv[i + 1]) {
      args.report = argv[i + 1];
      i += 1;
      continue;
    }
  }
  return args;
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizeType(value) {
  return normalizeText(value || "");
}

function hasSourceTextNav(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const nav = value;
  const layer = String(nav.layer || "").trim();
  const sessionId = String(nav.session_id || "").trim();
  const sourceFile = String(nav.source_file || "").trim();
  const sourceMemoryId = String(nav.source_memory_id || "").trim();
  const sourceEventId = String(nav.source_event_id || "").trim();
  if (layer !== "archive_event" && layer !== "active_only") {
    return false;
  }
  return Boolean(sessionId && sourceFile && sourceMemoryId && sourceEventId);
}

const GENERIC_ENTITY_SET = new Set([
  "user",
  "person",
  "entity",
  "solution",
  "issue",
  "problem",
  "system",
  "thing",
  "someone",
  "something",
  "unknown",
  "n/a",
  "na",
  "none",
  "null",
  "placeholder",
  "actor",
  "我",
  "你",
  "他",
  "她",
  "他们",
  "用户",
  "实体",
  "问题",
  "方案",
  "系统",
  "某人",
  "某事",
]);

function isGenericEntity(value) {
  return GENERIC_ENTITY_SET.has(normalizeText(value));
}

function listEntities(value) {
  if (!Array.isArray(value)) return [];
  const dedup = new Set();
  const out = [];
  for (const item of value) {
    const normalized = normalizeText(item);
    if (!normalized || dedup.has(normalized)) continue;
    dedup.add(normalized);
    out.push(normalized);
  }
  return out;
}

function allEntitiesMentioned(summary, entities) {
  const normalizedSummary = normalizeText(summary);
  if (!normalizedSummary) return false;
  return entities.every(entity => normalizedSummary.includes(entity));
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8");
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        const cleaned = index === 0 ? line.replace(/^\uFEFF/, "") : line;
        return JSON.parse(cleaned);
      } catch (error) {
        throw new Error(`Invalid JSONL at ${filePath}:${index + 1} -> ${error}`);
      }
    });
}

function readJson(filePath, fallbackValue) {
  if (!fs.existsSync(filePath)) return fallbackValue;
  try {
    const content = fs.readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "").trim();
    if (!content) return fallbackValue;
    return JSON.parse(content);
  } catch {
    return fallbackValue;
  }
}

function toEntitySet(entities) {
  return new Set(
    (Array.isArray(entities) ? entities : [])
      .map(item => normalizeText(item))
      .filter(Boolean),
  );
}

function toRelationSet(relations) {
  const output = new Set();
  const list = Array.isArray(relations) ? relations : [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const source = normalizeText(item.source);
    const target = normalizeText(item.target);
    const type = normalizeType(item.type);
    if (!source || !target || !type) continue;
    output.add(`${source}|${type}|${target}`);
  }
  return output;
}

function safeEntityTypeMap(input) {
  const output = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return output;
  }
  for (const [key, value] of Object.entries(input)) {
    const k = normalizeText(key);
    const v = String(value || "").trim();
    if (!k || !v) continue;
    output[k] = v;
  }
  return output;
}

function f1(tp, fp, fn) {
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const score = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    precision: Number(precision.toFixed(4)),
    recall: Number(recall.toFixed(4)),
    f1: Number(score.toFixed(4)),
  };
}

function ratio(numerator, denominator) {
  if (denominator === 0) return 1;
  return Number((numerator / denominator).toFixed(4));
}

function thresholdNumber(thresholds, key, fallback) {
  const raw = thresholds[key];
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return value;
}

function main() {
  const root = path.resolve(__dirname, "..");
  const cli = parseArgs(process.argv);
  const goldPath = path.resolve(root, cli.gold || "eval/graph_quality_gold.jsonl");
  const predPath = path.resolve(root, cli.pred || "eval/graph_quality_predictions.sample.jsonl");
  const thresholdPath = path.resolve(root, cli.thresholds || "eval/graph_quality_thresholds.json");
  const thresholds = readJson(thresholdPath, {
    entity_f1_min: 0.85,
    relation_f1_min: 0.8,
    entity_type_accuracy_min: 0.85,
    evidence_span_coverage_min: 0.9,
    evidence_text_hit_min: 0.85,
    source_text_nav_coverage_min: 1,
    generic_entity_ratio_max: 0.05,
    important_entity_coverage_min: 0.85,
    context_chunk_coverage_min: 0.95,
    context_chunk_hit_min: 0.9,
    summary_coverage_min: 1,
    summary_entity_coverage_min: 1,
    llm_custom_definition_completeness_min: 1,
    llm_gate_output_valid_rate_min: 0.99,
    graph_rewrite_trigger_precision_min: 0.9,
    graph_rewrite_trigger_recall_min: 0.85,
    related_to_allowed_max: 0,
  });

  const gold = readJsonl(goldPath);
  const pred = readJsonl(predPath);
  const predByCase = new Map();
  for (const item of pred) {
    const caseId = String(item.case_id || "").trim();
    if (!caseId) continue;
    predByCase.set(caseId, item);
  }

  let entityTp = 0;
  let entityFp = 0;
  let entityFn = 0;
  let relationTp = 0;
  let relationFp = 0;
  let relationFn = 0;
  let entityTypeTotal = 0;
  let entityTypeCorrect = 0;
  let evidenceTotal = 0;
  let evidenceWithSpan = 0;
  let evidenceTextHit = 0;
  let sourceTextNavValid = 0;
  let predictionTotal = 0;
  let genericEntityCount = 0;
  let predictedEntityCount = 0;
  let importantEntityTotal = 0;
  let importantEntityHit = 0;
  let contextChunkTotal = 0;
  let contextChunkWithValue = 0;
  let contextChunkTextHit = 0;
  let summaryTotal = 0;
  let summaryWithValue = 0;
  let summaryEntityCovered = 0;
  let llmCustomTotal = 0;
  let llmCustomWithDefinition = 0;
  let gateValidTotal = 0;
  let gateValidPass = 0;
  let rewriteTp = 0;
  let rewriteFp = 0;
  let rewriteFn = 0;
  let rewriteEvaluated = 0;
  let relatedToDetected = 0;
  const missingCases = [];
  const diagnostics = [];

  for (const item of gold) {
    const caseId = String(item.case_id || "").trim();
    if (!caseId) {
      continue;
    }
    const sourceText = String(item.source_text || "");
    const predItem = predByCase.get(caseId);
    const rewriteExpected = typeof item.rewrite_should_trigger === "boolean"
      ? item.rewrite_should_trigger
      : undefined;

    if (!predItem) {
      missingCases.push(caseId);
      const gEntitiesOnly = toEntitySet(item.entities);
      const gRelationsOnly = toRelationSet(item.relations);
      entityFn += gEntitiesOnly.size;
      relationFn += gRelationsOnly.size;
      gateValidTotal += 1;
      if (rewriteExpected !== undefined) {
        rewriteEvaluated += 1;
        if (rewriteExpected) rewriteFn += 1;
      }
      const importantSetMissing = toEntitySet(
        Array.isArray(item.important_entities) && item.important_entities.length > 0
          ? item.important_entities
          : item.entities,
      );
      importantEntityTotal += importantSetMissing.size;
      continue;
    }

    predictionTotal += 1;
    gateValidTotal += 1;
    const gateValid = predItem.gate_output_valid !== false && predItem.write_plan_valid !== false;
    if (gateValid) gateValidPass += 1;

    if (rewriteExpected !== undefined) {
      const rewritePredicted = predItem.rewrite_required === true;
      rewriteEvaluated += 1;
      if (rewritePredicted && rewriteExpected) rewriteTp += 1;
      if (rewritePredicted && !rewriteExpected) rewriteFp += 1;
      if (!rewritePredicted && rewriteExpected) rewriteFn += 1;
    }

    const goldEntities = toEntitySet(item.entities);
    const predEntities = toEntitySet(predItem.entities);
    const predEntityList = listEntities(predItem.entities);
    for (const entity of predEntities) {
      if (goldEntities.has(entity)) entityTp += 1;
      else entityFp += 1;
    }
    for (const entity of goldEntities) {
      if (!predEntities.has(entity)) entityFn += 1;
    }

    predictedEntityCount += predEntityList.length;
    genericEntityCount += predEntityList.filter(isGenericEntity).length;

    const importantSet = toEntitySet(
      Array.isArray(item.important_entities) && item.important_entities.length > 0
        ? item.important_entities
        : item.entities,
    );
    importantEntityTotal += importantSet.size;
    for (const entity of importantSet) {
      if (predEntities.has(entity)) importantEntityHit += 1;
    }

    const goldRelations = toRelationSet(item.relations);
    const predRelations = toRelationSet(predItem.relations);
    for (const rel of predRelations) {
      if (goldRelations.has(rel)) relationTp += 1;
      else relationFp += 1;
    }
    for (const rel of goldRelations) {
      if (!predRelations.has(rel)) relationFn += 1;
    }

    const goldTypes = safeEntityTypeMap(item.entity_types);
    const predTypes = safeEntityTypeMap(predItem.entity_types);
    for (const entity of Object.keys(goldTypes)) {
      entityTypeTotal += 1;
      if (predTypes[entity] === goldTypes[entity]) {
        entityTypeCorrect += 1;
      }
    }

    summaryTotal += 1;
    const summary = String(predItem.summary || "").trim();
    if (summary) {
      summaryWithValue += 1;
      if (allEntitiesMentioned(summary, predEntityList)) {
        summaryEntityCovered += 1;
      }
    }

    if (hasSourceTextNav(predItem.source_text_nav)) {
      sourceTextNavValid += 1;
    }

    const predRelationList = Array.isArray(predItem.relations) ? predItem.relations : [];
    for (const rel of predRelationList) {
      if (!rel || typeof rel !== "object") continue;
      evidenceTotal += 1;
      contextChunkTotal += 1;
      const relationType = normalizeType(rel.type || "");
      if (relationType === "related_to") {
        relatedToDetected += 1;
      }
      const relationOrigin = normalizeType(rel.relation_origin || "");
      if (relationOrigin === "llm_custom") {
        llmCustomTotal += 1;
        if (String(rel.relation_definition || "").trim()) {
          llmCustomWithDefinition += 1;
        }
      }
      const evidence = String(rel.evidence_span || "").trim();
      if (!evidence) continue;
      evidenceWithSpan += 1;
      if (sourceText && sourceText.toLowerCase().includes(evidence.toLowerCase())) {
        evidenceTextHit += 1;
      }
      const contextChunk = String(rel.context_chunk || "").trim();
      if (contextChunk) {
        contextChunkWithValue += 1;
        if (sourceText && sourceText.includes(contextChunk)) {
          contextChunkTextHit += 1;
        }
      }
    }

    diagnostics.push({
      case_id: caseId,
      gate_valid: gateValid,
      rewrite_expected: rewriteExpected,
      rewrite_predicted: predItem.rewrite_required === true,
      source_text_nav_valid: hasSourceTextNav(predItem.source_text_nav),
      predicted_entities: predEntityList.length,
      generic_entities: predEntityList.filter(isGenericEntity).length,
      summary_present: summary.length > 0,
    });
  }

  const entityMetrics = f1(entityTp, entityFp, entityFn);
  const relationMetrics = f1(relationTp, relationFp, relationFn);
  const entityTypeAccuracy = ratio(entityTypeCorrect, entityTypeTotal);
  const evidenceSpanCoverage = ratio(evidenceWithSpan, evidenceTotal);
  const evidenceTextHitRate = ratio(evidenceTextHit, evidenceWithSpan);
  const sourceTextNavCoverage = ratio(sourceTextNavValid, predictionTotal);
  const genericEntityRatio = ratio(genericEntityCount, predictedEntityCount);
  const importantEntityCoverage = ratio(importantEntityHit, importantEntityTotal);
  const contextChunkCoverage = ratio(contextChunkWithValue, contextChunkTotal);
  const contextChunkHitRate = ratio(contextChunkTextHit, contextChunkWithValue);
  const summaryCoverage = ratio(summaryWithValue, summaryTotal);
  const summaryEntityCoverage = ratio(summaryEntityCovered, summaryTotal);
  const llmCustomDefinitionCompleteness = ratio(llmCustomWithDefinition, llmCustomTotal);
  const gateOutputValidRate = ratio(gateValidPass, gateValidTotal);
  const rewriteMetrics = f1(rewriteTp, rewriteFp, rewriteFn);

  const summary = {
    files: {
      gold: goldPath,
      pred: predPath,
      thresholds: thresholdPath,
    },
    cases_total: gold.length,
    cases_missing_prediction: missingCases.length,
    missing_case_ids: missingCases,
    entity: {
      tp: entityTp,
      fp: entityFp,
      fn: entityFn,
      ...entityMetrics,
    },
    relation: {
      tp: relationTp,
      fp: relationFp,
      fn: relationFn,
      ...relationMetrics,
    },
    entity_type_accuracy: entityTypeAccuracy,
    evidence_span_coverage: evidenceSpanCoverage,
    evidence_text_hit_rate: evidenceTextHitRate,
    source_text_nav_coverage: sourceTextNavCoverage,
    generic_entity_ratio: genericEntityRatio,
    important_entity_coverage: importantEntityCoverage,
    context_chunk_coverage: contextChunkCoverage,
    context_chunk_hit_rate: contextChunkHitRate,
    summary_coverage: summaryCoverage,
    summary_entity_coverage_accuracy: summaryEntityCoverage,
    llm_custom_definition_completeness: llmCustomDefinitionCompleteness,
    llm_gate_output_valid_rate: gateOutputValidRate,
    graph_rewrite_trigger: {
      evaluated_cases: rewriteEvaluated,
      tp: rewriteTp,
      fp: rewriteFp,
      fn: rewriteFn,
      precision: rewriteMetrics.precision,
      recall: rewriteMetrics.recall,
      f1: rewriteMetrics.f1,
    },
    related_to_detected: relatedToDetected,
    diagnostics,
  };

  if (cli.report) {
    const reportPath = path.resolve(root, cli.report);
    const reportDir = path.dirname(reportPath);
    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }
    fs.writeFileSync(reportPath, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");
  }

  console.log(JSON.stringify(summary, null, 2));

  const failures = [];
  const entityF1Min = thresholdNumber(thresholds, "entity_f1_min", 0);
  const relationF1Min = thresholdNumber(thresholds, "relation_f1_min", 0);
  const entityTypeAccuracyMin = thresholdNumber(thresholds, "entity_type_accuracy_min", 0);
  const evidenceCoverageMin = thresholdNumber(thresholds, "evidence_span_coverage_min", 0);
  const evidenceHitMin = thresholdNumber(thresholds, "evidence_text_hit_min", 0);
  const sourceTextNavCoverageMin = thresholdNumber(thresholds, "source_text_nav_coverage_min", 0);
  const genericEntityRatioMax = thresholdNumber(thresholds, "generic_entity_ratio_max", 1);
  const importantEntityCoverageMin = thresholdNumber(thresholds, "important_entity_coverage_min", 0);
  const contextChunkCoverageMin = thresholdNumber(thresholds, "context_chunk_coverage_min", 0);
  const contextChunkHitMin = thresholdNumber(thresholds, "context_chunk_hit_min", 0);
  const summaryCoverageMin = thresholdNumber(thresholds, "summary_coverage_min", 0);
  const summaryEntityCoverageMin = thresholdNumber(thresholds, "summary_entity_coverage_min", 0);
  const llmCustomDefinitionMin = thresholdNumber(thresholds, "llm_custom_definition_completeness_min", 0);
  const gateOutputValidRateMin = thresholdNumber(thresholds, "llm_gate_output_valid_rate_min", 0);
  const rewritePrecisionMin = thresholdNumber(thresholds, "graph_rewrite_trigger_precision_min", 0);
  const rewriteRecallMin = thresholdNumber(thresholds, "graph_rewrite_trigger_recall_min", 0);
  const relatedToAllowedMax = thresholdNumber(thresholds, "related_to_allowed_max", 0);

  if (entityMetrics.f1 < entityF1Min) {
    failures.push(`entity_f1 ${entityMetrics.f1} < ${entityF1Min}`);
  }
  if (relationMetrics.f1 < relationF1Min) {
    failures.push(`relation_f1 ${relationMetrics.f1} < ${relationF1Min}`);
  }
  if (entityTypeAccuracy < entityTypeAccuracyMin) {
    failures.push(`entity_type_accuracy ${entityTypeAccuracy} < ${entityTypeAccuracyMin}`);
  }
  if (evidenceSpanCoverage < evidenceCoverageMin) {
    failures.push(`evidence_span_coverage ${evidenceSpanCoverage} < ${evidenceCoverageMin}`);
  }
  if (evidenceTextHitRate < evidenceHitMin) {
    failures.push(`evidence_text_hit_rate ${evidenceTextHitRate} < ${evidenceHitMin}`);
  }
  if (sourceTextNavCoverage < sourceTextNavCoverageMin) {
    failures.push(`source_text_nav_coverage ${sourceTextNavCoverage} < ${sourceTextNavCoverageMin}`);
  }
  if (genericEntityRatio > genericEntityRatioMax) {
    failures.push(`generic_entity_ratio ${genericEntityRatio} > ${genericEntityRatioMax}`);
  }
  if (importantEntityCoverage < importantEntityCoverageMin) {
    failures.push(`important_entity_coverage ${importantEntityCoverage} < ${importantEntityCoverageMin}`);
  }
  if (contextChunkCoverage < contextChunkCoverageMin) {
    failures.push(`context_chunk_coverage ${contextChunkCoverage} < ${contextChunkCoverageMin}`);
  }
  if (contextChunkHitRate < contextChunkHitMin) {
    failures.push(`context_chunk_hit_rate ${contextChunkHitRate} < ${contextChunkHitMin}`);
  }
  if (summaryCoverage < summaryCoverageMin) {
    failures.push(`summary_coverage ${summaryCoverage} < ${summaryCoverageMin}`);
  }
  if (summaryEntityCoverage < summaryEntityCoverageMin) {
    failures.push(`summary_entity_coverage_accuracy ${summaryEntityCoverage} < ${summaryEntityCoverageMin}`);
  }
  if (llmCustomDefinitionCompleteness < llmCustomDefinitionMin) {
    failures.push(`llm_custom_definition_completeness ${llmCustomDefinitionCompleteness} < ${llmCustomDefinitionMin}`);
  }
  if (gateOutputValidRate < gateOutputValidRateMin) {
    failures.push(`llm_gate_output_valid_rate ${gateOutputValidRate} < ${gateOutputValidRateMin}`);
  }
  if (rewriteMetrics.precision < rewritePrecisionMin) {
    failures.push(`graph_rewrite_trigger_precision ${rewriteMetrics.precision} < ${rewritePrecisionMin}`);
  }
  if (rewriteMetrics.recall < rewriteRecallMin) {
    failures.push(`graph_rewrite_trigger_recall ${rewriteMetrics.recall} < ${rewriteRecallMin}`);
  }
  if (relatedToDetected > relatedToAllowedMax) {
    failures.push(`related_to_detected ${relatedToDetected} > ${relatedToAllowedMax}`);
  }

  if (failures.length > 0) {
    console.error("\nGraph quality threshold check failed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }
}

main();
