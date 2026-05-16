import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

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
