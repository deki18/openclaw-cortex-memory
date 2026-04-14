const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const plugin = require('../dist/index.js');

const PLUGIN_ID = 'openclaw-cortex-memory';
const requiredTools = [
  'search_memory',
  'store_event',
  'query_graph',
  'get_hot_context',
  'get_auto_context',
  'reflect_memory',
  'sync_memory',
  'delete_memory',
  'cortex_diagnostics',
];

function logger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function isOkToolPayload(payload) {
  return Boolean(payload && payload.details && payload.details.status === 'ok');
}

function cfg(dbPath) {
  return {
    enabled: true,
    autoSync: false,
    autoReflect: false,
    fallbackToBuiltin: true,
    engineMode: 'ts',
    dbPath,
    embedding: { provider: 'api', model: 'm1', apiKey: 'k', baseURL: 'https://example.com/v1' },
    llm: { provider: 'api', model: 'm2', apiKey: 'k', baseURL: 'https://example.com/v1' },
    reranker: { provider: 'api', model: 'm3', apiKey: 'k', baseURL: 'https://example.com/v1' },
  };
}

function writeConfig(filePath, enabled) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      plugins: {
        entries: {
          [PLUGIN_ID]: {
            enabled,
          },
        },
      },
    }, null, 2),
    'utf-8',
  );
}

function buildApi(mode, dbPath) {
  const tools = new Map();
  const hooks = new Map();
  const api = {
    rootDir: process.cwd(),
    pluginConfig: cfg(dbPath),
    config: { plugins: { entries: { [PLUGIN_ID]: { enabled: true, config: cfg(dbPath) } } } },
    getLogger: () => logger(),
    getBuiltinMemory: () => ({ search: async () => [], store: async () => 'id', delete: async () => true }),
    registerTool: (tool) => tools.set(tool.name, tool),
    unregisterTool: (name) => tools.delete(name),
    off: (event) => hooks.delete(event),
    unregisterHook: (event) => hooks.delete(event),
  };
  if (mode === 'on') {
    api.on = (event, handler) => hooks.set(event, handler);
  } else {
    api.registerHook = ({ event, handler }) => hooks.set(event, handler);
  }
  return { api, tools, hooks };
}

async function runApiCompatibility(mode) {
  const dbPath = path.join(os.tmpdir(), `cortex-memory-compat-${mode}-${Date.now()}`);
  const { api, tools, hooks } = buildApi(mode, dbPath);
  plugin.register(api, cfg(dbPath));
  for (const name of requiredTools) {
    assert(tools.has(name), `missing tool ${name}`);
  }
  assert(hooks.has('message_received'));
  assert(hooks.has('session_end'));
  const context = { agentId: 'agent', workspaceId: 'ws', sessionId: 'session-1' };
  const searchTool = tools.get('search_memory');
  const executeResult = await searchTool.execute({ args: { query: '修复成功', top_k: 3 }, context });
  assert(isOkToolPayload(executeResult), `unexpected execute result: ${JSON.stringify(executeResult)}`);
  const handlerResult = await searchTool.handler({ query: '修复成功', top_k: 3 }, context);
  assert(isOkToolPayload(handlerResult), `unexpected handler result: ${JSON.stringify(handlerResult)}`);
  await hooks.get('message_received')({ content: '出现错误后修复成功' }, context);
  await hooks.get('session_end')({ sync_records: false }, context);
  await plugin.unregister();
}

async function runFallbackCompatibility() {
  const dbPath = path.join(os.tmpdir(), `cortex-memory-fallback-${Date.now()}`);
  const tools = new Map();
  const hooks = new Map();
  const api = {
    rootDir: process.cwd(),
    pluginConfig: cfg(dbPath),
    config: { plugins: { entries: { [PLUGIN_ID]: { enabled: true, config: cfg(dbPath) } } } },
    getLogger: () => logger(),
    getBuiltinMemory: () => ({
      search: async () => [{ id: 'b1', text: 'builtin', source: 'builtin' }],
      store: async () => 'builtin-id',
      delete: async () => true,
    }),
    registerTool: (tool) => tools.set(tool.name, tool),
    unregisterTool: (name) => tools.delete(name),
    on: (event, handler) => hooks.set(event, handler),
    off: (event) => hooks.delete(event),
  };
  plugin.register(api, cfg(dbPath));
  await plugin.disable();
  assert(tools.has('search_memory'));
  assert(tools.has('store_event'));
  assert(tools.has('cortex_memory_status'));
  const result = await tools.get('search_memory').execute({
    args: { query: 'x', top_k: 1 },
    context: { agentId: 'agent', workspaceId: 'ws', sessionId: 'session-fallback' },
  });
  assert(isOkToolPayload(result), `unexpected fallback result: ${JSON.stringify(result)}`);
  await plugin.unregister();
}

async function runPathPriorityCompatibility() {
  const baseTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-memory-path-priority-'));
  const explicitConfigPath = path.join(baseTmp, 'explicit', 'openclaw.json');
  const stateDir = path.join(baseTmp, 'state');
  const baseDir = path.join(baseTmp, 'base');
  const homeDir = path.join(baseTmp, 'home');
  writeConfig(explicitConfigPath, false);
  writeConfig(path.join(stateDir, 'openclaw.json'), true);
  writeConfig(path.join(baseDir, 'openclaw.json'), true);
  writeConfig(path.join(homeDir, '.openclaw', 'openclaw.json'), true);

  const old = {
    OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
    OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
    OPENCLAW_BASE_PATH: process.env.OPENCLAW_BASE_PATH,
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
  };

  try {
    process.env.OPENCLAW_CONFIG_PATH = explicitConfigPath;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.OPENCLAW_BASE_PATH = baseDir;
    process.env.USERPROFILE = homeDir;
    process.env.HOME = homeDir;

    const dbPath = path.join(baseTmp, 'db-explicit');
    const { api } = buildApi('on', dbPath);
    plugin.register(api, cfg(dbPath));
    assert.strictEqual(plugin.getStatus().enabled, false);
    await plugin.unregister();

    delete process.env.OPENCLAW_CONFIG_PATH;
    writeConfig(path.join(stateDir, 'openclaw.json'), false);
    writeConfig(path.join(baseDir, 'openclaw.json'), true);
    writeConfig(path.join(homeDir, '.openclaw', 'openclaw.json'), true);
    const { api: api2 } = buildApi('on', path.join(baseTmp, 'db-state'));
    plugin.register(api2, cfg(path.join(baseTmp, 'db-state')));
    assert.strictEqual(plugin.getStatus().enabled, false);
    await plugin.unregister();

    delete process.env.OPENCLAW_STATE_DIR;
    writeConfig(path.join(baseDir, 'openclaw.json'), false);
    writeConfig(path.join(homeDir, '.openclaw', 'openclaw.json'), true);
    const { api: api3 } = buildApi('on', path.join(baseTmp, 'db-base'));
    plugin.register(api3, cfg(path.join(baseTmp, 'db-base')));
    assert.strictEqual(plugin.getStatus().enabled, false);
    await plugin.unregister();
  } finally {
    if (old.OPENCLAW_CONFIG_PATH === undefined) delete process.env.OPENCLAW_CONFIG_PATH; else process.env.OPENCLAW_CONFIG_PATH = old.OPENCLAW_CONFIG_PATH;
    if (old.OPENCLAW_STATE_DIR === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = old.OPENCLAW_STATE_DIR;
    if (old.OPENCLAW_BASE_PATH === undefined) delete process.env.OPENCLAW_BASE_PATH; else process.env.OPENCLAW_BASE_PATH = old.OPENCLAW_BASE_PATH;
    if (old.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = old.USERPROFILE;
    if (old.HOME === undefined) delete process.env.HOME; else process.env.HOME = old.HOME;
  }
}

async function main() {
  await runApiCompatibility('on');
  await runApiCompatibility('registerHook');
  await runFallbackCompatibility();
  await runPathPriorityCompatibility();
  console.log('compat-regression-pass');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
