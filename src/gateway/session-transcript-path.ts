import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

/**
 * Resolves transcript file paths into a stable comparison key for history and update matching.
 */
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
