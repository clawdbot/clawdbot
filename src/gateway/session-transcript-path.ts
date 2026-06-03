import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

export function resolveTranscriptPathForComparison(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  const resolved = path.resolve(trimmed);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}
