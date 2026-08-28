import type { InternalGetReplyOptions } from "../get-reply.types.js";
import {
  clearRestoredPendingDrainKey,
  resolveRestoredFollowupQueueRecoveryKey,
} from "./persist.js";
import type { FollowupRun } from "./types.js";

/**
 * Restored user follow-ups must not inherit heartbeat-only execution policy
 * from the recovery wake. Keep this object narrow: no heartbeat tools,
 * timeout override, lightweight bootstrap, or wake abort signal.
 */
export function createRestoredFollowupDrainOpts(): InternalGetReplyOptions {
  return { isHeartbeat: false };
}

/**
 * When a heartbeat (or other synthetic wake) reaches agent-runner after a
 * gateway restart, register a drain callback for the original restored queue
 * key and idle-kick it. Isolated heartbeats use `<base>:heartbeat` while the
 * durable queue stays keyed by `<base>`.
 *
 * Returns the restored queue key when recovery drain was scheduled.
 */
export function tryScheduleRestoredFollowupQueueDrain<
  TOperation extends { sessionId: string },
>(params: {
  candidates: Array<string | undefined | null>;
  createRunFollowup: (restoredQueueKey: string) => (run: FollowupRun) => Promise<void>;
  getActiveReplyOperation: (key: string) => TOperation | undefined;
  scheduleAfterClear: (args: {
    operation: TOperation;
    queueKey: string;
    runFollowup: (run: FollowupRun) => Promise<void>;
  }) => void;
  scheduleNow: (queueKey: string, runFollowup: (run: FollowupRun) => Promise<void>) => void;
}): string | undefined {
  const restoredQueueKey = resolveRestoredFollowupQueueRecoveryKey(params.candidates);
  if (!restoredQueueKey) {
    return undefined;
  }
  const runFollowup = params.createRunFollowup(restoredQueueKey);
  const activeReplyOperation = params.getActiveReplyOperation(restoredQueueKey);
  if (activeReplyOperation) {
    params.scheduleAfterClear({
      operation: activeReplyOperation,
      queueKey: restoredQueueKey,
      runFollowup,
    });
  } else {
    params.scheduleNow(restoredQueueKey, runFollowup);
  }
  clearRestoredPendingDrainKey(restoredQueueKey);
  return restoredQueueKey;
}
