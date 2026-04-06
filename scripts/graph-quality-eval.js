const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    gold: "",
    pred: "",
    thresholds: "",
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
  return normalizeText(value || "related_to");
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8");
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at ${filePath}:${index + 1} -> ${error}`);
      }
    });
}

function readJson(filePath, fallbackValue) {
  if (!fs.existsSync(filePath)) return fallbackValue;
  try {
    const content = fs.readFileSync(filePath, "utf-8").trim();
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
  const missingCases = [];

  for (const item of gold) {
    const caseId = String(item.case_id || "").trim();
    if (!caseId) {
      continue;
    }
    const sourceText = String(item.source_text || "");
    const predItem = predByCase.get(caseId);
    if (!predItem) {
      missingCases.push(caseId);
      const gEntitiesOnly = toEntitySet(item.entities);
      const gRelationsOnly = toRelationSet(item.relations);
      entityFn += gEntitiesOnly.size;
      relationFn += gRelationsOnly.size;
      continue;
    }

    const goldEntities = toEntitySet(item.entities);
    const predEntities = toEntitySet(predItem.entities);
    for (const entity of predEntities) {
      if (goldEntities.has(entity)) entityTp += 1;
      else entityFp += 1;
    }
    for (const entity of goldEntities) {
      if (!predEntities.has(entity)) entityFn += 1;
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

    const predRelationList = Array.isArray(predItem.relations) ? predItem.relations : [];
    for (const rel of predRelationList) {
      if (!rel || typeof rel !== "object") continue;
      evidenceTotal += 1;
      const evidence = String(rel.evidence_span || "").trim();
      if (!evidence) continue;
      evidenceWithSpan += 1;
      if (sourceText && sourceText.toLowerCase().includes(evidence.toLowerCase())) {
        evidenceTextHit += 1;
      }
    }
  }

  const entityMetrics = f1(entityTp, entityFp, entityFn);
  const relationMetrics = f1(relationTp, relationFp, relationFn);
  const entityTypeAccuracy = entityTypeTotal === 0 ? 1 : Number((entityTypeCorrect / entityTypeTotal).toFixed(4));
  const evidenceSpanCoverage = evidenceTotal === 0 ? 1 : Number((evidenceWithSpan / evidenceTotal).toFixed(4));
  const evidenceTextHitRate = evidenceWithSpan === 0 ? 1 : Number((evidenceTextHit / evidenceWithSpan).toFixed(4));

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
  };

  console.log(JSON.stringify(summary, null, 2));

  const failures = [];
  if (entityMetrics.f1 < Number(thresholds.entity_f1_min || 0)) {
    failures.push(`entity_f1 ${entityMetrics.f1} < ${thresholds.entity_f1_min}`);
  }
  if (relationMetrics.f1 < Number(thresholds.relation_f1_min || 0)) {
    failures.push(`relation_f1 ${relationMetrics.f1} < ${thresholds.relation_f1_min}`);
  }
  if (entityTypeAccuracy < Number(thresholds.entity_type_accuracy_min || 0)) {
    failures.push(`entity_type_accuracy ${entityTypeAccuracy} < ${thresholds.entity_type_accuracy_min}`);
  }
  if (evidenceSpanCoverage < Number(thresholds.evidence_span_coverage_min || 0)) {
    failures.push(`evidence_span_coverage ${evidenceSpanCoverage} < ${thresholds.evidence_span_coverage_min}`);
  }
  if (evidenceTextHitRate < Number(thresholds.evidence_text_hit_min || 0)) {
    failures.push(`evidence_text_hit_rate ${evidenceTextHitRate} < ${thresholds.evidence_text_hit_min}`);
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
