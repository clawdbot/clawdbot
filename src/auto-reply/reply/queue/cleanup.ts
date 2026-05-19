import { resolveEmbeddedSessionLane } from "../../../agents/pi-embedded-runner/lanes.js";
import { clearCommandLane } from "../../../process/command-queue.js";
import { normalizeOptionalString } from "../../../shared/string-coerce.js";
import { clearFollowupDrainCallback } from "./drain.js";
import { clearFollowupQueue } from "./state.js";

export type ClearSessionQueueResult = {
  followupCleared: number;
  laneCleared: number;
  keys: string[];
};

const defaultQueueCleanupDeps = {
  resolveEmbeddedSessionLane,
  clearCommandLane,
};

const queueCleanupDeps = {
  ...defaultQueueCleanupDeps,
};

function resolveQueueCleanupLaneResolver() {
  return typeof queueCleanupDeps.resolveEmbeddedSessionLane === "function"
    ? queueCleanupDeps.resolveEmbeddedSessionLane
    : defaultQueueCleanupDeps.resolveEmbeddedSessionLane;
}

function resolveQueueCleanupLaneClearer() {
  return typeof queueCleanupDeps.clearCommandLane === "function"
    ? queueCleanupDeps.clearCommandLane
    : defaultQueueCleanupDeps.clearCommandLane;
}

export const testing = {
  setDepsForTests(deps: Partial<typeof defaultQueueCleanupDeps> | undefined): void {
    queueCleanupDeps.resolveEmbeddedSessionLane =
      typeof deps?.resolveEmbeddedSessionLane === "function"
        ? deps.resolveEmbeddedSessionLane
        : defaultQueueCleanupDeps.resolveEmbeddedSessionLane;
    queueCleanupDeps.clearCommandLane =
      typeof deps?.clearCommandLane === "function"
        ? deps.clearCommandLane
        : defaultQueueCleanupDeps.clearCommandLane;
  },
  resetDepsForTests(): void {
    queueCleanupDeps.resolveEmbeddedSessionLane =
      defaultQueueCleanupDeps.resolveEmbeddedSessionLane;
    queueCleanupDeps.clearCommandLane = defaultQueueCleanupDeps.clearCommandLane;
  },
};

export function clearSessionQueues(keys: Array<string | undefined>): ClearSessionQueueResult {
  const seen = new Set<string>();
  let followupCleared = 0;
  let laneCleared = 0;
  const clearedKeys: string[] = [];
  const resolveLane = resolveQueueCleanupLaneResolver();
  const clearLane = resolveQueueCleanupLaneClearer();

  for (const key of keys) {
    const cleaned = normalizeOptionalString(key);
    if (!cleaned || seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    clearedKeys.push(cleaned);
    followupCleared += clearFollowupQueue(cleaned);
    clearFollowupDrainCallback(cleaned);
    laneCleared += clearLane(resolveLane(cleaned));
  }

  return { followupCleared, laneCleared, keys: clearedKeys };
}
export { testing as __testing };
