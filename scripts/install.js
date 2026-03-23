const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");

console.log("[Cortex Memory] Setting up TypeScript runtime...\n");

try {
  execSync("npm run build", {
    cwd: rootDir,
    stdio: "inherit",
  });

  const srcManifest = path.join(rootDir, "openclaw.plugin.json");
  const distManifest = path.join(rootDir, "dist", "openclaw.plugin.json");
  if (fs.existsSync(srcManifest)) {
    fs.copyFileSync(srcManifest, distManifest);
    console.log("Plugin manifest copied to dist/");
  }

  console.log("\n[SUCCESS] TypeScript setup complete");
} catch (error) {
  console.error("\n[ERROR] TypeScript setup failed");
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
}
