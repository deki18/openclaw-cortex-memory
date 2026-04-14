#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");

async function main() {
  const root = process.cwd();
  const distIndexPath = path.join(root, "dist", "index.js");
  if (!fs.existsSync(distIndexPath)) {
    throw new Error("dist/index.js not found. Run `npm run build` first.");
  }

  const plugin = require(distIndexPath);
  if (!plugin || typeof plugin.register !== "function") {
    throw new Error("Plugin register function not found in dist/index.js");
  }

  const tools = new Map();
  const logger = {
    debug: () => {},
    info: () => {},
    warn: (...args) => console.warn("[capture-baseline]", ...args),
    error: (...args) => console.error("[capture-baseline]", ...args),
  };

  const mockApi = {
    logger,
    config: {},
    pluginConfig: {},
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    unregisterTool(name) {
      tools.delete(name);
    },
    on() {},
    off() {},
    getLogger() {
      return logger;
    },
    getBuiltinMemory() {
      return null;
    },
  };

  plugin.register(mockApi, {
    enabled: true,
    fallbackToBuiltin: false,
    autoSync: true,
    autoReflect: false,
    autoReflectIntervalMinutes: 30,
    graphQualityMode: "warn",
    wikiProjection: {
      enabled: false,
      mode: "off",
      maxBatch: 100,
    },
    embedding: {
      provider: "openai-compatible",
      model: "text-embedding-3-small",
      apiKey: "",
      baseURL: "",
    },
    llm: {
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey: "",
      baseURL: "",
    },
    reranker: {
      provider: "",
      model: "",
      apiKey: "",
      baseURL: "",
    },
  });

  const diagnosticsTool = tools.get("cortex_diagnostics") || tools.get("diagnostics");
  if (!diagnosticsTool || typeof diagnosticsTool.execute !== "function") {
    throw new Error("cortex_diagnostics tool not registered");
  }

  const context = {
    agentId: "baseline-capture",
    sessionId: "baseline-capture",
    workspaceId: "local",
  };

  const result = await diagnosticsTool.execute({
    args: {},
    context,
  });

  const details = result && typeof result === "object" ? result.details : null;
  const detailRecord = details && typeof details === "object" ? details : null;
  if (!detailRecord || detailRecord.status !== "ok") {
    throw new Error(`cortex_diagnostics execution failed: ${detailRecord?.error || "unknown_error"}`);
  }

  const baselineDir = path.join(root, "docs", "baseline");
  fs.mkdirSync(baselineDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:]/g, "-");
  const filename = `baseline-cortex-diagnostics-${ts}.json`;
  const snapshotPath = path.join(baselineDir, filename);
  const latestPath = path.join(baselineDir, "baseline-latest.json");
  const payload = {
    captured_at: new Date().toISOString(),
    source_tool: "cortex_diagnostics",
    file: filename,
    result: detailRecord,
  };

  fs.writeFileSync(snapshotPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  fs.writeFileSync(latestPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");

  if (typeof plugin.unregister === "function") {
    await plugin.unregister();
  }

  console.log(JSON.stringify({
    success: true,
    snapshot: snapshotPath,
    latest: latestPath,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
