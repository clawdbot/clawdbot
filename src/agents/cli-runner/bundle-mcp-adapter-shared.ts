import type { BundleMcpServerConfig } from "../../plugins/bundle-mcp.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? [...value]
    : undefined;
}

export function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter((entry): entry is [string, string] => {
    return typeof entry[1] === "string";
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function decodeHeaderEnvPlaceholder(
  value: string,
): { envVar: string; bearer: boolean } | null {
  const bearerMatch = /^Bearer \${([A-Z0-9_]+)}$/.exec(value);
  if (bearerMatch) {
    return { envVar: bearerMatch[1], bearer: true };
  }
  const envMatch = /^\${([A-Z0-9_]+)}$/.exec(value);
  if (envMatch) {
    return { envVar: envMatch[1], bearer: false };
  }
  return null;
}

export function applyCommonServerConfig(
  next: Record<string, unknown>,
  server: BundleMcpServerConfig,
): void {
  if (typeof server.command === "string") {
    next.command = server.command;
  }
  const args = normalizeStringArray(server.args);
  if (args) {
    next.args = args;
  }
  const env = normalizeStringRecord(server.env);
  if (env) {
    next.env = env;
  }
  if (typeof server.cwd === "string") {
    next.cwd = server.cwd;
  }
  if (typeof server.url === "string") {
    next.url = server.url;
  }
}
