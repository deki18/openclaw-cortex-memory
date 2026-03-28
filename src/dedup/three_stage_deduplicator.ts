import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

interface LoggerLike {
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
}

interface DedupStateItem {
  id: string;
  summary: string;
  simhash: string;
  minhash: number[];
  embedding?: number[];
  createdAt: string;
}

interface DedupState {
  items: DedupStateItem[];
}

interface DedupInput {
  id: string;
  summary: string;
  embedding?: number[];
}

interface DedupResult {
  duplicate: boolean;
  stage?: "simhash" | "minhash" | "vector";
  matchedId?: string;
}

interface DeduplicatorOptions {
  memoryRoot: string;
  logger: LoggerLike;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function buildShingles(tokens: string[], size: number): string[] {
  if (tokens.length < size) {
    return [tokens.join(" ")].filter(Boolean);
  }
  const result: string[] = [];
  for (let i = 0; i <= tokens.length - size; i += 1) {
    result.push(tokens.slice(i, i + size).join(" "));
  }
  return result;
}

function hashToken(value: string): bigint {
  const digest = crypto.createHash("sha1").update(value).digest();
  let output = 0n;
  for (let i = 0; i < 8; i += 1) {
    output = (output << 8n) + BigInt(digest[i]);
  }
  return output;
}

function computeSimhash(text: string): bigint {
  const tokens = tokenize(text);
  const vector = Array.from({ length: 64 }, () => 0);
  for (const token of tokens) {
    const hash = hashToken(token);
    for (let bit = 0; bit < 64; bit += 1) {
      const mask = 1n << BigInt(bit);
      vector[bit] += (hash & mask) !== 0n ? 1 : -1;
    }
  }
  let result = 0n;
  for (let bit = 0; bit < 64; bit += 1) {
    if (vector[bit] >= 0) {
      result |= 1n << BigInt(bit);
    }
  }
  return result;
}

function hammingDistance(left: bigint, right: bigint): number {
  let value = left ^ right;
  let count = 0;
  while (value > 0n) {
    count += Number(value & 1n);
    value >>= 1n;
  }
  return count;
}

function seedHash(seed: number, token: string): number {
  const digest = crypto.createHash("sha1").update(`${seed}:${token}`).digest();
  return digest.readUInt32BE(0);
}

function computeMinhash(text: string, signatures = 64): number[] {
  const tokens = tokenize(text);
  const shingles = buildShingles(tokens, 2);
  if (shingles.length === 0) {
    return Array.from({ length: signatures }, () => 0);
  }
  const output: number[] = [];
  for (let seed = 0; seed < signatures; seed += 1) {
    let min = Number.MAX_SAFE_INTEGER;
    for (const shingle of shingles) {
      const value = seedHash(seed, shingle);
      if (value < min) {
        min = value;
      }
    }
    output.push(min === Number.MAX_SAFE_INTEGER ? 0 : min);
  }
  return output;
}

function minhashSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  const size = Math.min(left.length, right.length);
  let same = 0;
  for (let i = 0; i < size; i += 1) {
    if (left[i] === right[i]) {
      same += 1;
    }
  }
  return same / size;
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (!left.length || !right.length) {
    return 0;
  }
  const size = Math.min(left.length, right.length);
  let dot = 0;
  let normLeft = 0;
  let normRight = 0;
  for (let i = 0; i < size; i += 1) {
    dot += left[i] * right[i];
    normLeft += left[i] * left[i];
    normRight += right[i] * right[i];
  }
  if (normLeft === 0 || normRight === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normLeft) * Math.sqrt(normRight));
}

function readState(filePath: string): DedupState {
  try {
    if (!fs.existsSync(filePath)) {
      return { items: [] };
    }
    const content = fs.readFileSync(filePath, "utf-8").trim();
    if (!content) {
      return { items: [] };
    }
    const parsed = JSON.parse(content) as DedupState;
    if (!Array.isArray(parsed.items)) {
      return { items: [] };
    }
    return parsed;
  } catch {
    return { items: [] };
  }
}

function writeState(filePath: string, state: DedupState): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
}

export function createThreeStageDeduplicator(options: DeduplicatorOptions): {
  check(input: DedupInput): DedupResult;
  append(input: DedupInput): void;
} {
  const statePath = path.join(options.memoryRoot, ".dedup_index.json");
  const maxItems = 8000;

  function check(input: DedupInput): DedupResult {
    const state = readState(statePath);
    const simhash = computeSimhash(input.summary);
    const minhash = computeMinhash(input.summary);
    const recent = state.items.slice(-2000);
    for (const item of recent) {
      const distance = hammingDistance(simhash, BigInt(`0x${item.simhash}`));
      if (distance <= 3) {
        return { duplicate: true, stage: "simhash", matchedId: item.id };
      }
    }
    for (const item of recent) {
      const similarity = minhashSimilarity(minhash, item.minhash);
      if (similarity >= 0.88) {
        return { duplicate: true, stage: "minhash", matchedId: item.id };
      }
    }
    if (input.embedding && input.embedding.length > 0) {
      for (const item of recent) {
        if (!item.embedding || item.embedding.length === 0) {
          continue;
        }
        const similarity = cosineSimilarity(input.embedding, item.embedding);
        if (similarity >= 0.95) {
          return { duplicate: true, stage: "vector", matchedId: item.id };
        }
      }
    }
    return { duplicate: false };
  }

  function append(input: DedupInput): void {
    const state = readState(statePath);
    const item: DedupStateItem = {
      id: input.id,
      summary: input.summary.slice(0, 500),
      simhash: computeSimhash(input.summary).toString(16).padStart(16, "0"),
      minhash: computeMinhash(input.summary),
      embedding: input.embedding && input.embedding.length > 0 ? input.embedding : undefined,
      createdAt: new Date().toISOString(),
    };
    state.items.push(item);
    if (state.items.length > maxItems) {
      state.items = state.items.slice(state.items.length - maxItems);
    }
    writeState(statePath, state);
    options.logger.debug(`ThreeStageDeduplicator indexed event ${input.id}`);
  }

  options.logger.info(`ThreeStageDeduplicator initialized at ${statePath}`);
  return { check, append };
}
