// Gateway JSON parsing helper.
// Safely parses optional JSON payloads while preserving invalid raw payload text.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

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
