import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

// Gateway JSON parsing accepts optional payload JSON and preserves invalid
// payload text for callers that need to surface or forward parse failures.
/** Safely parses an optional JSON string, returning a payloadJSON wrapper on parse failure. */
export function safeParseJson(value: string | null | undefined): unknown {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return { payloadJSON: value };
  }
}
