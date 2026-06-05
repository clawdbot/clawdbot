// Voice Call plugin module implements deep merge behavior.
import { isRecord as isPlainObject } from "openclaw/plugin-sdk/string-coerce-runtime";

// Prototype-safe deep merge for config overrides that ignores undefined values.

const BLOCKED_MERGE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** Deep-merge plain objects, keeping base values when overrides are undefined. */
export function deepMergeDefined(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? base : override;
  }

  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (BLOCKED_MERGE_KEYS.has(key) || value === undefined) {
      continue;
    }

    // Blocked keys above prevent prototype pollution while preserving normal nested overrides.
    const existing = result[key];
    result[key] = key in result ? deepMergeDefined(existing, value) : value;
  }

  return result;
}
