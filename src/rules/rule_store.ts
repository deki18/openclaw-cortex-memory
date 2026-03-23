import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

interface LoggerLike {
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
}

interface RuleStoreState {
  hashes: string[];
}

interface RuleStoreOptions {
  projectRoot: string;
  dbPath?: string;
  logger: LoggerLike;
}

function readState(filePath: string): RuleStoreState {
  try {
    if (!fs.existsSync(filePath)) {
      return { hashes: [] };
    }
    const content = fs.readFileSync(filePath, "utf-8").trim();
    if (!content) {
      return { hashes: [] };
    }
    const parsed = JSON.parse(content) as RuleStoreState;
    if (!Array.isArray(parsed.hashes)) {
      return { hashes: [] };
    }
    return parsed;
  } catch {
    return { hashes: [] };
  }
}

function writeState(filePath: string, state: RuleStoreState): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
}

function normalizeRule(content: string): string {
  return content.replace(/\s+/g, " ").trim();
}

function hashRule(content: string): string {
  return crypto.createHash("sha1").update(content).digest("hex");
}

export function createRuleStore(options: RuleStoreOptions): {
  addRule(args: { sectionTitle: string; content: string }): { added: boolean; reason?: string; hash?: string };
} {
  const memoryRoot = options.dbPath ? path.resolve(options.dbPath) : path.join(options.projectRoot, "data", "memory");
  const rulesPath = path.join(memoryRoot, "CORTEX_RULES.md");
  const statePath = path.join(memoryRoot, ".rule_store_state.json");

  function addRule(args: { sectionTitle: string; content: string }): { added: boolean; reason?: string; hash?: string } {
    const normalized = normalizeRule(args.content);
    if (!normalized) {
      return { added: false, reason: "empty_rule" };
    }
    const contentHash = hashRule(normalized);
    const state = readState(statePath);
    if (state.hashes.includes(contentHash)) {
      return { added: false, reason: "duplicate_rule", hash: contentHash };
    }

    const ruleDir = path.dirname(rulesPath);
    if (!fs.existsSync(ruleDir)) {
      fs.mkdirSync(ruleDir, { recursive: true });
    }
    if (!fs.existsSync(rulesPath)) {
      fs.writeFileSync(rulesPath, "# CORTEX_RULES.md\n", "utf-8");
    }

    fs.appendFileSync(rulesPath, `\n## ${args.sectionTitle}\n${normalized}\n`, "utf-8");
    state.hashes.push(contentHash);
    writeState(statePath, state);
    options.logger.info(`TS rule_store appended ${args.sectionTitle}`);
    return { added: true, hash: contentHash };
  }

  options.logger.debug(`TS rule_store initialized at ${rulesPath}`);
  return { addRule };
}
