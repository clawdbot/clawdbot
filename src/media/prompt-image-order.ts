import { readPersistedMediaImageLayout } from "../agents/embedded-agent-runner/run/prompt-image-metadata.js";
import type { UserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.types.js";
import { isImageMediaFact, readPersistedMediaFacts, type MediaFact } from "./media-facts.js";

/** Tracks whether prompt images stayed inline or were offloaded while preserving model order. */
export type PromptImageOrderEntry = "inline" | "offloaded";

/** Stored images require vision; facts already replaced by text descriptions do not. */
export function hasPromptImageInput(input?: {
  images?: readonly unknown[];
  imageOrder?: readonly PromptImageOrderEntry[];
  media?: readonly MediaFact[];
  userTurnTranscriptRecorder?: Pick<UserTurnTranscriptRecorder, "message">;
}): boolean {
  const message = input?.userTurnTranscriptRecorder?.message;
  const suppressed = message
    ? readPersistedMediaImageLayout(message)?.suppressedFactIndexes
    : undefined;
  const needsImageBytes = (fact: MediaFact) =>
    isImageMediaFact(fact) && fact.hydrationSuppressed !== true;
  return Boolean(
    input?.images?.length ||
    input?.imageOrder?.length ||
    input?.media?.some(needsImageBytes) ||
    (message &&
      readPersistedMediaFacts(message)?.some(
        (fact, index) => needsImageBytes(fact) && !suppressed?.includes(index),
      )),
  );
}
