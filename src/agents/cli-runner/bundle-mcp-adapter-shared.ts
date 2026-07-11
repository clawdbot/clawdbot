/**
 * Shared normalization helpers for CLI-specific bundle MCP adapters.
 */
import { isRecord } from "../../../packages/normalization-core/src/record-coerce.js";
import type { BundleMcpServerConfig } from "../../plugins/bundle-mcp.js";
/** Re-exported record guard for adapter modules that share loose JSON inputs. */
export { isRecord } from "../../../packages/normalization-core/src/record-coerce.js";

function normalizeStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? [...value]
    : undefined;
}

/** Normalize a string-valued record, dropping non-string entries. */
export function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter((entry): entry is [string, string] => {
    return typeof entry[1] === "string";
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Decode supported `${ENV}` and `Bearer ${ENV}` header placeholders. */
export function decodeHeaderEnvPlaceholder(
  value: string,
): { envVar: string; bearer: boolean } | null {
  const bearerMatch = /^Bearer \${([A-Z0-9_]+)}$/.exec(value);
  const bearerEnvVar = bearerMatch?.at(1);
  if (bearerEnvVar) {
    return { envVar: bearerEnvVar, bearer: true };
  }
  const envMatch = /^\${([A-Z0-9_]+)}$/.exec(value);
  const envVar = envMatch?.at(1);
  if (envVar) {
    return { envVar, bearer: false };
  }
  return null;
}

/** Copy common MCP server config fields into a CLI adapter config object. */
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
