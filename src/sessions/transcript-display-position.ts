import { createHash } from "node:crypto";
import type { TranscriptDisplayPosition } from "../chat/transcript-display-position.js";
import { readNestedToolActivity, type NestedToolActivity } from "./nested-tool-activity.js";

export type TranscriptDisplayActivity = Pick<
  NestedToolActivity["details"],
  "afterEntryId" | "scopeId" | "startOrder"
>;

/** Keep source namespaces and rewrite generations separate without exposing storage paths. */
export function createTranscriptDisplaySource(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("base64url");
}

export function createTranscriptDisplayPosition(
  source: string,
  rawSeq: number,
  message: unknown,
  entrySeq: (id: string) => number | undefined,
): TranscriptDisplayPosition {
  return createTranscriptDisplayPositionFromActivity(
    source,
    rawSeq,
    readNestedToolActivity(message)?.details,
    entrySeq,
  );
}

/** Archive indexes retain validated placement facts without retaining tool input/output. */
export function createTranscriptDisplayPositionFromActivity(
  source: string,
  rawSeq: number,
  activity: TranscriptDisplayActivity | undefined,
  entrySeq: (id: string) => number | undefined,
): TranscriptDisplayPosition {
  const position: TranscriptDisplayPosition = { source, rawSeq };
  if (!activity) {
    return position;
  }
  const { afterEntryId, scopeId, startOrder } = activity;
  const afterRawSeq = afterEntryId === null ? null : entrySeq(afterEntryId);
  // The dispatch cut is a physical fact, not the anchor's relocated display position.
  // Unresolved or rewritten anchors keep completion order rather than guessing a parent.
  if (afterRawSeq === null || (afterRawSeq !== undefined && afterRawSeq < rawSeq)) {
    position.activity = { afterRawSeq, scopeId, startOrder };
  }
  return position;
}
