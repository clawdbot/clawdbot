import { drainSystemEventEntries } from "../../infra/system-events.js";
import { clearSessionQueues, type ClearSessionQueueResult } from "./queue/cleanup.js";

export type ClearSessionResetRuntimeStateResult = ClearSessionQueueResult & {
  systemEventsCleared: number;
};

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
