const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { createWriteStore } = require('../dist/src/store/write_store.js');
const { createReadStore } = require('../dist/src/store/read_store.js');
const { createRuleStore } = require('../dist/src/rules/rule_store.js');
const { createReflector } = require('../dist/src/reflect/reflector.js');

function logger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function createMockServer() {
  const requests = {
    embedding: 0,
    rerank: 0,
    llm: 0,
  };
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 404;
      res.end();
      return;
    }
    let body = '';
    req.on('data', chunk => {
      body += String(chunk);
    });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};
      if (req.url === '/v1/embeddings') {
        requests.embedding += 1;
        const input = typeof json.input === 'string' ? json.input : JSON.stringify(json.input || '');
        const length = Math.max(1, input.length);
        const vector = [length / 100, (length % 13) / 13, 0.5];
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ embedding: vector }] }));
        return;
      }
      if (req.url === '/v1/rerank') {
        requests.rerank += 1;
        const docs = Array.isArray(json.documents) ? json.documents : [];
        const query = String(json.query || '');
        const scored = docs.map((doc, index) => {
          const text = String(doc || '');
          const includes = text.includes(query) ? 1 : 0;
          return { index, relevance_score: includes + (docs.length - index) / 100 };
        }).sort((a, b) => b.relevance_score - a.relevance_score);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ results: scored }));
        return;
      }
      if (req.url === '/v1/chat/completions') {
        requests.llm += 1;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          choices: [
            {
              message: {
                content: '优先沉淀可复用修复策略，并把失败到成功的关键步骤固化为规则。',
              },
            },
          ],
        }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  return { server, requests };
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

async function main() {
  const { server, requests } = createMockServer();
  const baseURL = await listen(server);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-memory-model-regression-'));
  const dbPath = path.join(root, 'data', 'memory');

  try {
    const writeStore = createWriteStore({
      projectRoot: root,
      dbPath,
      logger: logger(),
      embedding: {
        provider: 'api',
        model: 'embedding-mock',
        apiKey: 'test-key',
        baseURL,
      },
    });

    const writeA = await writeStore.writeMemory({
      text: '构建失败后通过统一校验脚本完成版本一致性修复，最终回归全部通过并沉淀发布门禁。',
      role: 'assistant',
      source: 'message',
      sessionId: 'session-a',
    });
    const writeB = await writeStore.writeMemory({
      text: '会话结束时自动沉淀规则并保留回退链路，保证主 Agent 在异常场景下仍可稳定响应。',
      role: 'assistant',
      source: 'message',
      sessionId: 'session-a',
    });
    assert.strictEqual(writeA.status, 'ok');
    assert.strictEqual(writeB.status, 'ok');

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
      reranker: {
        provider: 'api',
        model: 'reranker-mock',
        apiKey: 'test-key',
        baseURL,
      },
    });

    const search = await readStore.searchMemory({
      query: '版本一致性',
      topK: 2,
    });
    assert(Array.isArray(search.results));
    assert(search.results.length > 0);

    const archivePath = path.join(dbPath, 'sessions', 'archive', 'sessions.jsonl');
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    fs.appendFileSync(archivePath, `${JSON.stringify({
      id: 'evt-1',
      summary: '任务经历失败后修复成功并完成回归',
      outcome: 'success_after_failure',
      timestamp: new Date().toISOString(),
    })}\n`, 'utf-8');

    const ruleStore = createRuleStore({
      projectRoot: root,
      dbPath,
      logger: logger(),
    });

    const reflector = createReflector({
      projectRoot: root,
      dbPath,
      logger: logger(),
      ruleStore,
      llm: {
        provider: 'api',
        model: 'llm-mock',
        apiKey: 'test-key',
        baseURL,
      },
    });

    const reflected = await reflector.reflectMemory();
    assert(reflected.reflected_count >= 1);
    const rulesContent = fs.readFileSync(path.join(dbPath, 'CORTEX_RULES.md'), 'utf-8');
    assert(rulesContent.includes('优先沉淀可复用修复策略'));

    assert(requests.embedding > 0);
    assert(requests.rerank > 0);
    assert(requests.llm > 0);

    console.log('model-regression-pass');
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
