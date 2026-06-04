/** Clears reset-related queues and system events for session keys. */
import { drainSystemEventEntries } from "../../infra/system-events.js";
import { clearSessionQueues, type ClearSessionQueueResult } from "./queue/cleanup.js";

/** Runtime cleanup result for reset-related queues and system events. */
export type ClearSessionResetRuntimeStateResult = ClearSessionQueueResult & {
  systemEventsCleared: number;
};

/** Clears queued follow-ups and pending system events for reset session keys. */
export function clearSessionResetRuntimeState(
  keys: Array<string | undefined>,
): ClearSessionResetRuntimeStateResult {
  const cleared = clearSessionQueues(keys);
  let systemEventsCleared = 0;

  for (const key of cleared.keys) {
    systemEventsCleared += drainSystemEventEntries(key).length;
  }

  return {
    ...cleared,
    systemEventsCleared,
  };
}
