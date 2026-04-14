const fs = require('fs');
const path = require('path');

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function readJson(filePath, fallbackValue) {
  try {
    if (!fs.existsSync(filePath)) return fallbackValue;
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    if (!content) return fallbackValue;
    return JSON.parse(content);
  } catch {
    return fallbackValue;
  }
}

function normalizeType(value) {
  return String(value || 'related_to').trim().toLowerCase();
}

function queryGraph(records, args) {
  const entity = String(args.entity || '').trim();
  const relFilter = args.rel ? normalizeType(args.rel) : '';
  const dir = ['incoming', 'outgoing', 'both'].includes(args.dir) ? args.dir : 'both';
  const pathTo = args.path_to ? String(args.path_to).trim() : '';
  const maxDepth = Math.max(2, Math.min(4, Number(args.max_depth || 3)));
  const edges = [];
  const adjacency = new Map();
  const pathAdjacency = new Map();
  const edgeSet = new Set();
  function pushEdge(source, target, type) {
    const key = `${source}|${type}|${target}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    edges.push({ source, target, type });
    if (!adjacency.has(source)) adjacency.set(source, []);
    if (!adjacency.has(target)) adjacency.set(target, []);
    adjacency.get(source).push({ next: target, edge: { source, target, type } });
    adjacency.get(target).push({ next: source, edge: { source, target, type } });
  }
  function pushPathEdge(source, target, type) {
    if (!pathAdjacency.has(source)) pathAdjacency.set(source, []);
    if (!pathAdjacency.has(target)) pathAdjacency.set(target, []);
    if (dir === 'incoming') {
      pathAdjacency.get(target).push({ next: source, edge: { source, target, type } });
    } else if (dir === 'outgoing') {
      pathAdjacency.get(source).push({ next: target, edge: { source, target, type } });
    } else {
      pathAdjacency.get(source).push({ next: target, edge: { source, target, type } });
      pathAdjacency.get(target).push({ next: source, edge: { source, target, type } });
    }
  }
  for (const record of records) {
    const entities = Array.isArray(record.entities) ? record.entities : [];
    const named = entities.map(v => String(v || '').trim()).filter(Boolean);
    const relations = Array.isArray(record.relations) ? record.relations : [];
    let explicit = false;
    for (const relRaw of relations) {
      if (!relRaw || typeof relRaw !== 'object') continue;
      const source = String(relRaw.source || '').trim();
      const target = String(relRaw.target || '').trim();
      const type = normalizeType(relRaw.type);
      if (!source || !target) continue;
      if (relFilter && relFilter !== type) continue;
      pushPathEdge(source, target, type);
      const outgoing = source === entity;
      const incoming = target === entity;
      const dirMatched = dir === 'both' ? (outgoing || incoming) : (dir === 'outgoing' ? outgoing : incoming);
      if (!dirMatched) continue;
      explicit = true;
      pushEdge(source, target, type);
    }
    if (!explicit && named.includes(entity) && (!relFilter || relFilter === 'co_occurrence')) {
      for (const name of named) {
        if (name !== entity) pushEdge(entity, name, 'co_occurrence');
      }
    }
  }
  let pathEdges = [];
  if (pathTo) {
    const queue = [{ node: entity, depth: 0, path: [] }];
    const visited = new Set();
    while (queue.length > 0) {
      const current = queue.shift();
      if (current.node === pathTo) {
        pathEdges = current.path;
        break;
      }
      if (current.depth >= maxDepth) continue;
      const key = `${current.node}:${current.depth}`;
      if (visited.has(key)) continue;
      visited.add(key);
      for (const next of pathAdjacency.get(current.node) || []) {
        queue.push({ node: next.next, depth: current.depth + 1, path: [...current.path, next.edge] });
      }
    }
  }
  return { edges, path: pathEdges };
}

function evaluateConflict(records) {
  const byCanonical = new Map();
  for (const item of records) {
    const canonicalId = String(item.canonical_id || '').trim();
    const outcome = String(item.outcome || '').trim();
    if (!canonicalId || !outcome) continue;
    if (!byCanonical.has(canonicalId)) byCanonical.set(canonicalId, new Set());
    byCanonical.get(canonicalId).add(outcome);
  }
  let conflicts = 0;
  for (const outcomes of byCanonical.values()) {
    if (outcomes.size > 1) conflicts += 1;
  }
  return { canonical_conflicts: conflicts, canonical_total: byCanonical.size };
}

function main() {
  const root = path.resolve(__dirname, '..');
  const archivePath = path.join(root, 'data', 'memory', 'sessions', 'archive', 'sessions.jsonl');
  const casePath = path.join(root, 'eval', 'graph_eval_cases.json');
  const fixturePath = path.join(root, 'eval', 'graph_eval_fixtures.jsonl');
  const thresholdPath = path.join(root, 'eval', 'graph_eval_thresholds.json');
  const records = [...readJsonl(archivePath), ...readJsonl(fixturePath)];
  const cases = readJson(casePath, []);
  const thresholds = readJson(thresholdPath, {
    relation_hit_rate_min: 0.8,
    path_correct_rate_min: 0.8,
    conflict_detection_ratio_min: 0.1,
  });
  let relationPass = 0;
  let relationTotal = 0;
  let pathPass = 0;
  let pathTotal = 0;
  for (const item of cases) {
    const result = queryGraph(records, item);
    if (Array.isArray(item.expected_relation_types)) {
      relationTotal += 1;
      const types = new Set(result.edges.map(edge => edge.type));
      const expected = item.expected_relation_types.map(v => normalizeType(v));
      const hasAny = expected.some(type => types.has(type));
      const edgeCountOk = typeof item.min_edges === 'number' ? result.edges.length >= item.min_edges : true;
      if (hasAny && edgeCountOk) relationPass += 1;
    }
    if (item.expected_path) {
      pathTotal += 1;
      if (Array.isArray(result.path) && result.path.length > 0) pathPass += 1;
    }
  }
  const conflict = evaluateConflict(records);
  const summary = {
    relation_hit_rate: relationTotal === 0 ? 1 : Number((relationPass / relationTotal).toFixed(4)),
    path_correct_rate: pathTotal === 0 ? 1 : Number((pathPass / pathTotal).toFixed(4)),
    conflict_detection_ratio: conflict.canonical_total === 0 ? 0 : Number((conflict.canonical_conflicts / conflict.canonical_total).toFixed(4)),
    conflict_threshold_skipped: conflict.canonical_total === 0,
    relation_cases: relationTotal,
    path_cases: pathTotal,
    canonical_total: conflict.canonical_total,
    canonical_conflicts: conflict.canonical_conflicts,
  };
  console.log(JSON.stringify(summary, null, 2));
  const failures = [];
  if (summary.relation_hit_rate < Number(thresholds.relation_hit_rate_min || 0)) {
    failures.push(`relation_hit_rate ${summary.relation_hit_rate} < ${thresholds.relation_hit_rate_min}`);
  }
  if (summary.path_correct_rate < Number(thresholds.path_correct_rate_min || 0)) {
    failures.push(`path_correct_rate ${summary.path_correct_rate} < ${thresholds.path_correct_rate_min}`);
  }
  if (!summary.conflict_threshold_skipped && summary.conflict_detection_ratio < Number(thresholds.conflict_detection_ratio_min || 0)) {
    failures.push(`conflict_detection_ratio ${summary.conflict_detection_ratio} < ${thresholds.conflict_detection_ratio_min}`);
  }
  if (failures.length > 0) {
    console.error('\nGraph eval threshold check failed:');
    for (const item of failures) {
      console.error(`- ${item}`);
    }
    process.exit(1);
  }
}

main();
