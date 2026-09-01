// Clears follow-up queues and their session command lanes.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveEmbeddedSessionLane } from "../../../agents/embedded-agent-runner/lanes.js";
import { clearCommandLane } from "../../../process/command-queue.js";
import { clearFollowupDrainCallback } from "./drain.js";
import { clearFollowupQueue } from "./state.js";

export type ClearSessionQueueResult = {
  followupCleared: number;
  laneCleared: number;
  keys: string[];
};

export function clearSessionQueues(keys: Array<string | undefined>): ClearSessionQueueResult {
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
    followupCleared += clearFollowupQueue(cleaned);
    clearFollowupDrainCallback(cleaned);
    laneCleared += clearCommandLane(resolveEmbeddedSessionLane(cleaned));
  }

  return { followupCleared, laneCleared, keys: clearedKeys };
}
