#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const srcManifest = path.join(rootDir, "openclaw.plugin.json");
const distManifest = path.join(distDir, "openclaw.plugin.json");

console.log("[Cortex Memory] Verifying packaged assets...\n");

try {
  if (!fs.existsSync(distDir)) {
    console.log("dist/ not found, skipping install-time file operations.");
    process.exit(0);
  }

  if (fs.existsSync(srcManifest)) {
    fs.mkdirSync(distDir, { recursive: true });
    fs.copyFileSync(srcManifest, distManifest);
    console.log("Plugin manifest copied to dist/");
  } else {
    console.log("openclaw.plugin.json not found, skipping manifest copy.");
  }

  console.log("\n[SUCCESS] Install verification complete");
} catch (error) {
  console.error("\n[ERROR] Install verification failed");
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
}
