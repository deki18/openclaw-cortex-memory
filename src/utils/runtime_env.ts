import * as os from "os";

export function getEnvValue(key: string): string {
  const value = process.env[key];
  return typeof value === "string" ? value : "";
}

export function getHomeDir(): string {
  return os.homedir() || "";
}

export function getProcessEnvCopy(): Record<string, string> {
  const entries = Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return Object.fromEntries(entries);
}
