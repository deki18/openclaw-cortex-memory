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

const LOCK_WAIT_MS = 5000;
const LOCK_RETRY_MS = 25;

function sleepMs(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  const arr = new Int32Array(sab);
  Atomics.wait(arr, 0, 0, Math.max(0, ms));
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
  const normalized: RuleStoreState = {
    hashes: [...new Set((state.hashes || []).filter(item => typeof item === "string" && item.trim()))],
  };
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(normalized, null, 2), "utf-8");
  fs.renameSync(tempPath, filePath);
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
  const lockPath = path.join(memoryRoot, ".rule_store.lock");

  function withLock<T>(run: () => T): { ok: true; value: T } | { ok: false; reason: string } {
    const lockDir = path.dirname(lockPath);
    if (!fs.existsSync(lockDir)) {
      fs.mkdirSync(lockDir, { recursive: true });
    }
    const started = Date.now();
    let lockFd: number | null = null;
    while (Date.now() - started < LOCK_WAIT_MS) {
      try {
        lockFd = fs.openSync(lockPath, "wx");
        fs.writeFileSync(lockFd, `${process.pid}:${Date.now()}`, "utf-8");
        break;
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err?.code !== "EEXIST") {
          options.logger.warn(`TS rule_store lock error: ${error}`);
          return { ok: false, reason: "lock_error" };
        }
        sleepMs(LOCK_RETRY_MS);
      }
    }
    if (lockFd === null) {
      return { ok: false, reason: "lock_timeout" };
    }
    try {
      return { ok: true, value: run() };
    } finally {
      try {
        fs.closeSync(lockFd);
      } catch {}
      try {
        fs.unlinkSync(lockPath);
      } catch {}
    }
  }

  function addRule(args: { sectionTitle: string; content: string }): { added: boolean; reason?: string; hash?: string } {
    const normalized = normalizeRule(args.content);
    if (!normalized) {
      return { added: false, reason: "empty_rule" };
    }
    const contentHash = hashRule(normalized);
    const lockResult = withLock(() => {
      const state = readState(statePath);
      if (state.hashes.includes(contentHash)) {
        return { added: false, reason: "duplicate_rule", hash: contentHash } as const;
      }
      const ruleDir = path.dirname(rulesPath);
      if (!fs.existsSync(ruleDir)) {
        fs.mkdirSync(ruleDir, { recursive: true });
      }
      if (!fs.existsSync(rulesPath)) {
        fs.writeFileSync(rulesPath, "# CORTEX_RULES.md\n", "utf-8");
      }
      const sectionTitle = (args.sectionTitle || "Rule").replace(/[\r\n]+/g, " ").trim() || "Rule";
      fs.appendFileSync(rulesPath, `\n## ${sectionTitle}\n${normalized}\n`, "utf-8");
      state.hashes.push(contentHash);
      writeState(statePath, state);
      options.logger.info(`TS rule_store appended ${sectionTitle}`);
      return { added: true, hash: contentHash } as const;
    });
    if (!lockResult.ok) {
      return { added: false, reason: lockResult.reason };
    }
    return lockResult.value;
  }

  options.logger.debug(`TS rule_store initialized at ${rulesPath}`);
  return { addRule };
}
