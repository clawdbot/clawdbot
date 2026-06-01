import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";

/** Accepted string literals for boolean parsing beyond actual booleans. */
export type BooleanParseOptions = {
  truthy?: string[];
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
