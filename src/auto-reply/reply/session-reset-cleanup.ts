/** Clears reset-related queues and system events for session keys. */
import { clearEmbeddedSessionPromptStates } from "../../agents/embedded-agent-runner/session-prompt-state.js";
import { drainSystemEventEntries } from "../../infra/system-events.js";
import { clearSessionQueues, type ClearSessionQueueResult } from "./queue/cleanup.js";
import { clearReplyRunForResetBySessionId } from "./reply-run-registry.js";

/** Runtime cleanup result for reset-related queues and system events. */
type ClearSessionResetRuntimeStateResult = ClearSessionQueueResult & {
  systemEventsCleared: number;
};

/** Clears queued follow-ups and pending system events for reset session keys. */
export function clearSessionResetRuntimeState(
  keys: Array<string | undefined>,
  opts?: { activeReplySessionId?: string },
): ClearSessionResetRuntimeStateResult {
  clearEmbeddedSessionPromptStates(keys);
  const cleared = clearSessionQueues(keys);
  let systemEventsCleared = 0;

  for (const key of cleared.keys) {
    systemEventsCleared += drainSystemEventEntries(key).length;
  }

  if (opts?.activeReplySessionId) {
    clearReplyRunForResetBySessionId(opts.activeReplySessionId);
  }

  return {
    ...cleared,
    systemEventsCleared,
  };
}
