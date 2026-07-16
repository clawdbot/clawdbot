/**
 * JSON parser compatibility helper for persisted config, manifests, and legacy stores.
 * Strict JSON stays the fast path; JSON5 is only the authored/legacy fallback.
 */
import JSON5 from "json5";

/** Parses strict JSON first, then accepts JSON5 syntax such as comments and trailing commas. */
export function parseJsonWithJson5Fallback(
  raw: string,
  json5: { parse: (value: string) => unknown } = JSON5,
): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return json5.parse(raw);
  }
}
