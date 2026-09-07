/** Clears reset-related queues and system events for session keys. */
import { clearEmbeddedSessionPromptStates } from "../../agents/embedded-agent-runner/session-prompt-state.js";
import { killSessionSubagentRuns } from "../../agents/subagents/registry/subagent-control-kill.js";
import { loadExactSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { selectAgentSystemEvents } from "../../infra/system-event-ownership.js";
import {
  consumeSelectedSystemEventEntries,
  peekSystemEventEntries,
} from "../../infra/system-events.js";
import { clearSessionQueues, type ClearSessionQueueResult } from "./queue/cleanup.js";
import { clearReplyRunForResetBySessionId } from "./reply-run-registry.js";

export class SessionResetCleanupError extends Error {}

/** Bind runtime cleanup to the parent incarnation accepted before asynchronous work. */
export function createSessionResetCleanupGuard(params: {
  storePath: string;
  sessionKey: string;
  expectedSession: Pick<SessionEntry, "sessionId" | "lifecycleRevision"> | undefined;
  assertCurrent?: () => void;
}): () => void {
  const sessionId = params.expectedSession?.sessionId;
  const lifecycleRevision = params.expectedSession?.lifecycleRevision;
  return () => {
    params.assertCurrent?.();
    const current = loadExactSessionEntryReadOnly({
      storePath: params.storePath,
      sessionKey: params.sessionKey,
      clone: false,
    })?.entry;
    if (current?.sessionId !== sessionId || current?.lifecycleRevision !== lifecycleRevision) {
      throw new SessionResetCleanupError(
        "Reset did not complete because the session changed before cleanup. Retry /reset.",
      );
    }
  };
}

/** Reset must report unfinished child cleanup before committing a fresh conversation. */
export async function stopSessionResetSubagents(
  params: Parameters<typeof killSessionSubagentRuns>[0] & { assertCurrent: () => void },
): Promise<void> {
  try {
    // Hooks and child finalizers can yield after reset accepted its parent. Fence
    // that incarnation before selection and at every child cancellation boundary.
    params.assertCurrent();
    const result = await killSessionSubagentRuns(params);
    params.assertCurrent();
    if (result.status === "error") {
      throw new Error(result.error);
    }
  } catch (cause) {
    if (cause instanceof SessionResetCleanupError) {
      throw cause;
    }
    throw new SessionResetCleanupError(
      "Reset did not complete because some subagent tasks could not be stopped. Inspect the remaining tasks and retry /reset.",
      { cause },
    );
  }
}

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
