// Session transcript path comparison helper.
// Normalizes transcript paths for cache, history, and update matching.
import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

/** Resolve a transcript file path into a stable comparison key. */
export function resolveTranscriptPathForComparison(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  const resolved = path.resolve(trimmed);
  try {
    return fs.realpathSync(resolved);
  } catch {
    // Some session references point at files that may not exist yet; still compare absolute paths.
    return resolved;
  }
}
