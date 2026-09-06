// Clears follow-up queues and their session command lanes.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveEmbeddedSessionLane } from "../../../agents/embedded-agent-runner/lanes.js";
import { prepareDiscardIngressClaims } from "../../../channels/message/ingress-processing-handoff.js";
import { clearCommandLane } from "../../../process/command-queue.js";
import { clearFollowupDrainCallback } from "./drain.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./state.js";

export type ClearSessionQueueResult = {
  followupCleared: number;
  laneCleared: number;
  keys: string[];
};

export function clearSessionQueues(
  keys: Array<string | undefined>,
  options?: { disposition: "stop" },
): ClearSessionQueueResult {
  const seen = new Set<string>();
  let followupCleared = 0;
  let laneCleared = 0;
  const clearedKeys: string[] = [];

  for (const key of keys) {
    const cleaned = normalizeOptionalString(key);
    if (!cleaned || seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    clearedKeys.push(cleaned);
  }

  const signals: AbortSignal[] = [];
  if (options?.disposition === "stop") {
    const queues = new Set(
      clearedKeys.map(getExistingFollowupQueue).filter((queue) => queue !== undefined),
    );
    for (const queue of queues) {
      const sources = new Set([
        ...queue.items,
        ...queue.inFlight,
        ...queue.summarySources,
        ...queue.summaryElisions.flatMap((entry) => entry.sources),
      ]);
      for (const source of sources) {
        const signal = source.turnAdoptionLifecycle?.abortSignal;
        if (signal) {
          signals.push(signal);
        }
      }
    }
  }
  const discard = prepareDiscardIngressClaims(signals);
  try {
    for (const cleaned of clearedKeys) {
      followupCleared += clearFollowupQueue(cleaned);
      clearFollowupDrainCallback(cleaned);
      laneCleared += clearCommandLane(resolveEmbeddedSessionLane(cleaned));
    }
  } finally {
    discard();
  }
  return { followupCleared, laneCleared, keys: clearedKeys };
}
