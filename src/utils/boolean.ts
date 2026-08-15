// Boolean utility helpers normalize string-like boolean inputs.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";

/**
 * Shared boolean coercion helpers for config, env, and plugin SDK runtime inputs.
 *
 * `asBoolean` is intentionally strict; string parsing is opt-in through
 * `parseBooleanValue` so schema callers do not silently accept ambiguous text.
 */

/** Accepted string literals for boolean parsing beyond actual booleans. */
type BooleanParseOptions = {
  /** Lowercase string values that should parse as true. */
  truthy?: string[];
  /** Lowercase string values that should parse as false. */
  falsy?: string[];
};

const DEFAULT_TRUTHY = ["true", "1", "yes", "on"] as const;
const DEFAULT_FALSY = ["false", "0", "no", "off"] as const;
const DEFAULT_TRUTHY_SET = new Set<string>(DEFAULT_TRUTHY);
const DEFAULT_FALSY_SET = new Set<string>(DEFAULT_FALSY);

/** Returns only real boolean values and leaves boolean-like strings for explicit parsing. */
export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Parses booleans and configured string literals, returning undefined for ambiguous input. */
export function parseBooleanValue(
  value: unknown,
  options: BooleanParseOptions = {},
): boolean | undefined {
  const booleanValue = asBoolean(value);
  if (booleanValue !== undefined) {
    return booleanValue;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = normalizeOptionalLowercaseString(value);
  if (!normalized) {
    return undefined;
  }
  const truthy = options.truthy ?? DEFAULT_TRUTHY;
  const falsy = options.falsy ?? DEFAULT_FALSY;
  // Reuse default sets on hot paths; custom literals get per-call sets to keep caller state immutable.
  const truthySet = truthy === DEFAULT_TRUTHY ? DEFAULT_TRUTHY_SET : new Set(truthy);
  const falsySet = falsy === DEFAULT_FALSY ? DEFAULT_FALSY_SET : new Set(falsy);
  if (truthySet.has(normalized)) {
    return true;
  }
  if (falsySet.has(normalized)) {
    return false;
  }
  return undefined;
}
