#!/usr/bin/env node
/* eslint-disable no-console */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { createReadStore } = require('../dist/src/store/read_store.js');

function logger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function appendArchive(dbPath, rows) {
  const archivePath = path.join(dbPath, 'sessions', 'archive', 'sessions.jsonl');
  ensureDir(path.dirname(archivePath));
  fs.writeFileSync(archivePath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf-8');
}

function createEmbeddingServer() {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/embeddings') {
      res.statusCode = 404;
      res.end();
      return;
    }
    req.on('data', () => {});
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
  ensureDir(path.dirname(vectorPath));
  const now = new Date().toISOString();
  const rows = [];
  for (let index = 0; index < 25; index += 1) {
    rows.push({
      id: `vec-near-${index}`,
      summary: `near semantic candidate ${index}`,
      timestamp: now,
      layer: 'archive',
      source_memory_id: `near-${index}`,
      source_memory_canonical_id: `near-${index}`,
      event_type: 'insight',
      quality_score: 0.9,
      embedding: [1, 0],
    });
  }
  rows.push({
    id: 'vec-far-exact',
    summary: 'rare-vector-preselect-token',
    timestamp: now,
    layer: 'archive',
    source_memory_id: 'far-exact',
    source_memory_canonical_id: 'far-exact',
    event_type: 'insight',
    quality_score: 0.9,
    embedding: [-1, 0],
  });
  fs.writeFileSync(vectorPath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf-8');
}

async function assertVectorFallbackPreselect(baseURL) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-memory-vector-preselect-'));
  const dbPath = path.join(root, 'data', 'memory');
  writeVectorFallback(dbPath);
  const readStore = createReadStore({
    projectRoot: root,
    dbPath,
    logger: logger(),
    embedding: {
      provider: 'api',
      model: 'embedding-mock',
      apiKey: 'test-key',
      baseURL,
    },
    fusion: {
      minLexicalHits: 0,
      minSemanticHits: 1,
    },
  });
  const result = await readStore.searchMemory({
    query: 'rare-vector-preselect-token',
    topK: 1,
    fusionMode: 'off',
    trackHits: false,
  });
  assert.strictEqual(result.debug.vector_source, 'jsonl_index');
  assert.notStrictEqual(result.results[0]?.id, 'vec-far-exact');
  assert(result.results[0]?.id.startsWith('vec-near-'));
}

async function assertBm25FrequencyAndChannels() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-memory-bm25-frequency-'));
  const dbPath = path.join(root, 'data', 'memory');
  appendArchive(dbPath, [
    {
      id: 'evt-low-tf',
      summary: 'alpha',
      timestamp: new Date().toISOString(),
      quality_score: 0.8,
    },
    {
      id: 'evt-high-tf',
      summary: 'alpha alpha alpha alpha alpha',
      timestamp: new Date().toISOString(),
      quality_score: 0.8,
    },
  ]);
  const readStore = createReadStore({ projectRoot: root, dbPath, logger: logger() });
  const result = await readStore.searchMemory({
    query: 'alpha',
    topK: 1,
    mode: 'lightweight',
    fusionMode: 'off',
    trackHits: false,
  });
  assert.strictEqual(result.results[0]?.id, 'evt-high-tf');
  assert(Array.isArray(result.channel_results?.keyword));
  assert(result.channel_results.keyword.some(row => row.source === 'sessions_archive'));
  assert(Array.isArray(result.keyword_results));
}

async function assertWeakSummaryTriggersFulltextFallback() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-memory-fulltext-threshold-'));
  const dbPath = path.join(root, 'data', 'memory');
  appendArchive(dbPath, [
    {
      id: 'evt-source-only',
      summary: '项目',
      source_text: '项目特殊检索词 only appears in source text',
      timestamp: new Date().toISOString(),
      quality_score: 0.8,
    },
  ]);
  const readStore = createReadStore({ projectRoot: root, dbPath, logger: logger() });
  const result = await readStore.searchMemory({
    query: '项目特殊检索词',
    topK: 1,
    fusionMode: 'off',
    trackHits: false,
  });
  assert.strictEqual(result.debug.fulltext_fallback_used, true);
  assert(result.results[0]?.reason_tags.includes('fulltext_fallback_used'));
}

async function main() {
  const server = createEmbeddingServer();
  const baseURL = await listen(server);
  try {
    await assertVectorFallbackPreselect(baseURL);
    await assertBm25FrequencyAndChannels();
    await assertWeakSummaryTriggersFulltextFallback();
    console.log('read-search-regression-pass');
  } finally {
    await new Promise(resolve => server.close(() => resolve()));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
