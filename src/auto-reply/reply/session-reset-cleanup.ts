/** Clears reset-related queues and system events for session keys. */
import { clearEmbeddedSessionPromptStates } from "../../agents/embedded-agent-runner/session-prompt-state.js";
import { selectAgentSystemEvents } from "../../infra/system-event-ownership.js";
import {
  consumeSelectedSystemEventEntries,
  peekSystemEventEntries,
} from "../../infra/system-events.js";
import { clearDelegateDispatchHedge } from "../continuation/delegate-dispatch-hedge.js";
import { cancelSessionContinuations } from "../continuation/session-reset.js";
import { clearTrackedContinuationTimers } from "../continuation/state.js";
import { clearContinuationWorkDispatch } from "../continuation/work-dispatch.js";
import { clearSessionQueues, type ClearSessionQueueResult } from "./queue/cleanup.js";
import { clearReplyRunForResetBySessionId } from "./reply-run-registry.js";

/** Runtime cleanup result for reset-related queues and system events. */
type ClearSessionResetRuntimeStateResult = ClearSessionQueueResult & {
  systemEventsCleared: number;
};

/** Clears queued follow-ups and pending system events visible to the resetting agent. */
export function clearSessionResetRuntimeState(
  keys: Array<string | undefined>,
  opts: { agentId: string; activeReplySessionId?: string },
): ClearSessionResetRuntimeStateResult {
  clearEmbeddedSessionPromptStates(keys);
  const cleared = clearSessionQueues(keys);
  let systemEventsCleared = 0;

  for (const key of cleared.keys) {
    clearContinuationWorkDispatch(key);
    clearDelegateDispatchHedge(key);
    clearTrackedContinuationTimers(key);
    cancelSessionContinuations(key);
    // Global session rows may share one transient queue across agents. An
    // agent-scoped reset must not discard another agent's pending work.
    const removed = consumeSelectedSystemEventEntries(
      key,
      selectAgentSystemEvents(peekSystemEventEntries(key), opts.agentId),
    );
    systemEventsCleared += removed.length;
  }

  if (opts.activeReplySessionId) {
    clearReplyRunForResetBySessionId(opts.activeReplySessionId);
  }

  return {
    ...cleared,
    systemEventsCleared,
  };
}
