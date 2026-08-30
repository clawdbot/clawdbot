// Applies low-level redaction transforms to raw config snapshot data.
import { isDeepStrictEqual } from "node:util";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import JSON5 from "json5";

/** Replaces known sensitive values in raw config text while preserving parseable structure. */
export function replaceSensitiveValuesInRaw(params: {
  raw: string;
  sensitiveValues: string[];
  redactedSentinel: string;
}): string {
  // Empty string is not a valid replacement token here: replaceAll("", x)
  // matches every character boundary and corrupts the whole raw snapshot.
  const values = uniqueStrings(params.sensitiveValues)
    .filter((value) => value !== "")
    .toSorted((a, b) => b.length - a.length);
  let result = params.raw;
  for (const value of values) {
    // Replace longer overlapping values first so a short prefix cannot hide the full secret.
    result = result.replaceAll(value, params.redactedSentinel);
  }
  return result;
}

/** Returns whether raw string redaction changed semantics and structured redaction is needed. */
export function shouldFallbackToStructuredRawRedaction(params: {
  redactedRaw: string;
  originalConfig: unknown;
  restoreParsed: (parsed: unknown) => { ok: boolean; result?: unknown };
}): boolean {
  try {
    const parsed = JSON5.parse(params.redactedRaw);
    const restored = params.restoreParsed(parsed);
    if (!restored.ok) {
      return true;
    }
    // Raw replacement is only safe when parsing and restoring produces the original config shape.
    return !isDeepStrictEqual(restored.result, params.originalConfig);
  } catch {
    return true;
  }
}
