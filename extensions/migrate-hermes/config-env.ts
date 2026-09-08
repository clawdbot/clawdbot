// Hermes environment interpolation shared by provider and MCP config.
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export const MCP_ENV_REFERENCE_RE = /\$\{([^}]+)\}/gu;

export function normalizeHermesEnvReferenceName(value: string): string | undefined {
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
    // RFC 7230 §3.2.6: HTTP header field values must be pure ASCII.
    // Node.js undici enforces this at fetch-time and crashes the calling
    // process with "Cannot convert argument to a ByteString" if a value
    // contains characters outside 0x00-0x7F. Surface this at config-load
    // time so the existing mcpManualItems "unresolved-secrets" warning
    // names the bad value before the plugin tries to use it.
    if (/[^\x00-\x7F]/.test(resolved)) {
      unresolved = true;
    }
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
