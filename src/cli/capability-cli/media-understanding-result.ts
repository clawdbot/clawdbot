import type { RunMediaUnderstandingFileResult } from "../../media-understanding/runtime-types.js";

export function isMissingMediaUnderstandingProvider(
  result: RunMediaUnderstandingFileResult,
): boolean {
  const decision = result.decision;
  return (
    decision?.outcome === "skipped" &&
    decision.attachments.length > 0 &&
    decision.attachments.every((attachment) => attachment.attempts.length === 0)
  );
}
