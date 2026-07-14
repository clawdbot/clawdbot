// Voice Call plugin module implements deep merge behavior.
import defu from "defu";
import { isRecord as isPlainObject } from "openclaw/plugin-sdk/string-coerce-runtime";

// Prototype-safe deep merge for config overrides that ignores undefined values.

const BLOCKED_MERGE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const NULL_OVERRIDE = Symbol("null-override");

class ArrayOverride {
  constructor(readonly value: unknown[]) {}
}

function prepareObject(
  value: Record<string, unknown>,
  encodeNull: boolean,
): Record<string, unknown> {
  const prepared: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (BLOCKED_MERGE_KEYS.has(key)) {
      continue;
    }
    if (encodeNull && entry === null) {
      prepared[key] = NULL_OVERRIDE;
    } else if (encodeNull && Array.isArray(entry)) {
      // Defu concatenates arrays. A non-plain wrapper preserves the plugin's
      // existing replacement policy until the merged result is decoded.
      prepared[key] = new ArrayOverride(entry);
    } else if (isPlainObject(entry)) {
      prepared[key] = prepareObject(entry, encodeNull);
    } else {
      prepared[key] = entry;
    }
  }
  return prepared;
}

function decodeNullOverrides(value: unknown): unknown {
  if (value instanceof ArrayOverride) {
    return value.value;
  }
  if (value === NULL_OVERRIDE) {
    return null;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, decodeNullOverrides(entry)]),
  );
}

/** Deep-merge plain objects, keeping base values when overrides are undefined. */
export function deepMergeDefined(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? base : override;
  }
  return decodeNullOverrides(defu(prepareObject(override, true), prepareObject(base, false)));
}
