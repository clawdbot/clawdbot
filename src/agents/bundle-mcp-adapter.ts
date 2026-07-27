// Shared mechanics for projecting bundle MCP config into provider-owned runners.
import { isRecord } from "../../packages/normalization-core/src/record-coerce.js";
import type { BundleMcpServerConfig } from "../plugins/bundle-mcp.js";
export { isRecord } from "../../packages/normalization-core/src/record-coerce.js";

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
  const match = /^(Bearer )?\${([A-Z0-9_]+)}$/.exec(value);
  return match?.[2] ? { envVar: match[2], bearer: Boolean(match[1]) } : null;
}

const COMMON_STRING_FIELDS = ["command", "cwd", "url"] as const;

export function normalizeBundleMcpServerConfig(
  server: BundleMcpServerConfig,
  fields: {
    strings?: readonly (keyof BundleMcpServerConfig)[];
    booleans?: readonly (keyof BundleMcpServerConfig)[];
  } = {},
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const field of [...COMMON_STRING_FIELDS, ...(fields.strings ?? [])]) {
    if (typeof server[field] === "string") {
      next[field] = server[field];
    }
  }
  for (const field of fields.booleans ?? []) {
    if (typeof server[field] === "boolean") {
      next[field] = server[field];
    }
  }
  const args =
    Array.isArray(server.args) && server.args.every((entry) => typeof entry === "string")
      ? [...server.args]
      : undefined;
  if (args) {
    next.args = args;
  }
  const env = normalizeStringRecord(server.env);
  if (env) {
    next.env = env;
  }
  return next;
}
