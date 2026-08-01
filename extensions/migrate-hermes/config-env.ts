// Hermes environment interpolation shared by provider and MCP config.
import { isRecord } from "./helpers.js";

export const MCP_ENV_REFERENCE_RE = /\$\{([^}]+)\}/gu;

function normalizeHermesEnvReferenceName(value: string): string | undefined {
  const trimmed = value.trim();
  const name = trimmed.startsWith("env:") ? trimmed.slice("env:".length).trim() : trimmed;
  return name || undefined;
}

export function resolveMcpEnvReferences(
  value: unknown,
  env: Record<string, string>,
): { unresolved: boolean; value: unknown } {
  if (typeof value === "string") {
    let unresolved = false;
    const resolved = value.replace(MCP_ENV_REFERENCE_RE, (match, rawName: string) => {
      const name = normalizeHermesEnvReferenceName(rawName);
      if (!name) {
        unresolved = true;
        return match;
      }
      const replacement = env[name];
      if (replacement === undefined) {
        unresolved = true;
        return match;
      }
      return replacement;
    });
    return { unresolved, value: resolved };
  }
  if (Array.isArray(value)) {
    const entries = value.map((entry) => resolveMcpEnvReferences(entry, env));
    return {
      unresolved: entries.some((entry) => entry.unresolved),
      value: entries.map((entry) => entry.value),
    };
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).map(
      ([key, entry]) => [key, resolveMcpEnvReferences(entry, env)] as const,
    );
    return {
      unresolved: entries.some(([, entry]) => entry.unresolved),
      value: Object.fromEntries(entries.map(([key, entry]) => [key, entry.value])),
    };
  }
  return { unresolved: false, value };
}

export function mcpValueHasEnvReferences(value: unknown): boolean {
  return value !== undefined && resolveMcpEnvReferences(value, {}).unresolved;
}
