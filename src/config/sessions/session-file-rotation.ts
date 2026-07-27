// Session file rotation rewrites transcript paths when session ids reset or fork.
import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

/** Rewrites transcript file paths when a session id changes during reset or fork. */
export function rewriteSessionFileForNewSessionId(params: {
  sessionFile?: string;
  previousSessionId: string;
  nextSessionId: string;
}): string | undefined {
  const trimmed = normalizeOptionalString(params.sessionFile);
  if (!trimmed) {
    return undefined;
  }
  const base = path.basename(trimmed);
  if (!base.endsWith(".jsonl")) {
    return undefined;
  }
  const withoutExt = base.slice(0, -".jsonl".length);
  if (withoutExt === params.previousSessionId) {
    return path.join(path.dirname(trimmed), `${params.nextSessionId}.jsonl`);
  }
  if (withoutExt.startsWith(`${params.previousSessionId}-topic-`)) {
    // Topic transcripts preserve their encoded topic suffix while adopting the new session id.
    return path.join(
      path.dirname(trimmed),
      `${params.nextSessionId}${base.slice(params.previousSessionId.length)}`,
    );
  }
  const forkMatch = withoutExt.match(
    /^(\d{4}-\d{2}-\d{2}T[\w-]+(?:Z|[+-]\d{2}(?:-\d{2})?)?)_(.+)$/,
  );
  if (forkMatch?.[2] === params.previousSessionId) {
    return path.join(path.dirname(trimmed), `${forkMatch[1]}_${params.nextSessionId}.jsonl`);
  }
  return undefined;
}

export function canonicalizeAbsoluteSessionFilePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  const missingSegments: string[] = [];
  let cursor = resolved;
  while (true) {
    try {
      // Canonicalize the deepest existing parent; the transcript file may not exist yet.
      return path.join(fs.realpathSync(cursor), ...missingSegments.toReversed());
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        return resolved;
      }
      missingSegments.push(path.basename(cursor));
      cursor = parent;
    }
  }
}
