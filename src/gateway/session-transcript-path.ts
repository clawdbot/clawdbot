// Session transcript path comparison helper.
// Normalizes transcript paths for cache, history, and update matching.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveRealpathOrAbsolute } from "../infra/boundary-path.js";

/** Resolve a transcript file path into a stable comparison key. */
export function resolveTranscriptPathForComparison(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  return resolveRealpathOrAbsolute(trimmed);
}
