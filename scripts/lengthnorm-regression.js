const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { createReadStore } = require('../dist/src/store/read_store.js');

function logger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function createEmbeddingServer() {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/embeddings') {
      res.statusCode = 404;
      res.end();
      return;
    }
    let body = '';
    req.on('data', chunk => {
      body += String(chunk);
    });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ embedding: [1, 0] }] }));
    });
  });
  return server;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('invalid_server_address');
  }
  return `http://127.0.0.1:${address.port}/v1`;
}

function writeVectorFallback(dbPath) {
  const vectorPath = path.join(dbPath, 'vector', 'lancedb_events.jsonl');
  fs.mkdirSync(path.dirname(vectorPath), { recursive: true });
  const now = new Date().toISOString();
  const longText = 'L'.repeat(3200);
  const shortText = 'S'.repeat(220);
  const rows = [
    {
      id: 'vec-long',
      summary: longText,
      timestamp: now,
      layer: 'archive',
      source_memory_id: 'evt-long',
      source_memory_canonical_id: 'canon-long',
      event_type: 'insight',
      quality_score: 0.6,
      char_count: longText.length,
      token_count: 1,
      embedding: [1, 0],
    },
    {
      id: 'vec-short',
      summary: shortText,
      timestamp: now,
      layer: 'archive',
      source_memory_id: 'evt-short',
      source_memory_canonical_id: 'canon-short',
      event_type: 'insight',
      quality_score: 0.6,
      char_count: shortText.length,
      token_count: 1,
      embedding: [0.97, 0.243],
    },
  ];
  fs.writeFileSync(vectorPath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf-8');
}

async function runSearch(dbPath, baseURL, lengthNormEnabled) {
  const readStore = createReadStore({
    projectRoot: path.dirname(path.dirname(dbPath)),
    dbPath,
    logger: logger(),
    embedding: {
      provider: 'api',
      model: 'embedding-mock',
      apiKey: 'test-key',
      baseURL,
    },
    fusion: {
      lengthNorm: {
        enabled: lengthNormEnabled,
        pivotChars: 600,
        strength: 0.75,
        minFactor: 0.45,
      },
      minLexicalHits: 0,
      minSemanticHits: 1,
    },
  });
  const result = await readStore.searchMemory({ query: 'nonlexical-query', topK: 1 });
  assert(Array.isArray(result.results) && result.results.length > 0);
  return result.results[0];
}

async function main() {
  const server = createEmbeddingServer();
  const baseURL = await listen(server);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-memory-lengthnorm-regression-'));
  const dbPath = path.join(root, 'data', 'memory');
  writeVectorFallback(dbPath);
  try {
    const withoutNorm = await runSearch(dbPath, baseURL, false);
    const withNorm = await runSearch(dbPath, baseURL, true);
    assert.strictEqual(withoutNorm.id, 'vec-long');
    assert.strictEqual(withNorm.id, 'vec-short');
    console.log('lengthnorm-regression-pass');
  } finally {
    await new Promise(resolve => server.close(() => resolve()));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
