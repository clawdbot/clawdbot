import path from "node:path";
import type { CodexThread } from "./protocol.js";

export function resolveCodexThreadRolloutPath(thread: CodexThread): string | undefined {
  const rolloutPath = thread.path?.trim();
  if (
    !rolloutPath ||
    !path.isAbsolute(rolloutPath) ||
    path.extname(rolloutPath) !== ".jsonl" ||
    !path.basename(rolloutPath).includes(thread.id)
  ) {
    return undefined;
  }
  return rolloutPath;
}
