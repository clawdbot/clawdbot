import { isDeepStrictEqual } from "node:util";
import JSON5 from "json5";
import { uniqueStrings } from "../shared/string-normalization.js";

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
    result = result.replaceAll(value, params.redactedSentinel);
  }
  return result;
}

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
    return !isDeepStrictEqual(restored.result, params.originalConfig);
  } catch {
    return true;
  }
}
