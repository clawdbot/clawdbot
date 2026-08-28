import {
  peekRestoredPendingDrainKeys,
  setRestoredFollowupQueuesListener,
  unsetRestoredFollowupQueuesListener,
} from "../auto-reply/reply/queue/persist.js";
import { getExistingFollowupQueue } from "../auto-reply/reply/queue/state.js";
import { requestHeartbeat } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("gateway/followup-queue-recovery");

function resolveRestoredQueueWakeTarget(params: {
  key: string;
  queue: NonNullable<ReturnType<typeof getExistingFollowupQueue>>;
}): { sessionKey: string; pendingCount: number } | null {
  const itemCount = params.queue.items.length;
  const summaryCount = Math.max(params.queue.droppedCount, params.queue.summarySources.length);
  const pendingCount = itemCount > 0 ? itemCount : summaryCount;
  if (pendingCount <= 0) {
    return null;
  }
  const routingRun =
    params.queue.items[0]?.run ??
    params.queue.summarySources[0]?.run ??
    params.queue.summaryElisions[0]?.sources[0]?.run ??
    params.queue.lastRun;
  const sessionKey = routingRun?.sessionKey?.trim() || params.key;
  return { sessionKey, pendingCount };
}

/**
 * After a cold gateway restart, followup queues are restored from SQLite but
 * drain callbacks are empty until agent-runner registers one for the route.
 * Wake each affected session so the next agent turn (including the recovery
 * heartbeat) can register a non-heartbeat drain callback for the original
 * queue key — including when isolated heartbeats rewrite the session to
 * `<base>:heartbeat` — and drain via the normal idle-kick path.
 */
export function wakeRestoredFollowupQueueSessions(): number {
  const pendingKeys = [...peekRestoredPendingDrainKeys()];
  if (pendingKeys.length === 0) {
    return 0;
  }

  let woke = 0;
  for (const key of pendingKeys) {
    const queue = getExistingFollowupQueue(key);
    if (!queue) {
      continue;
    }
    const wakeTarget = resolveRestoredQueueWakeTarget({ key, queue });
    if (!wakeTarget) {
      continue;
    }
    const { sessionKey, pendingCount } = wakeTarget;
    enqueueSystemEvent(
      `Restored ${pendingCount} pending followup message${pendingCount === 1 ? "" : "s"} after gateway restart; they will drain on the next agent turn for this route.`,
      { sessionKey },
    );
    requestHeartbeat({
      source: "followup-queue-restore",
      intent: "immediate",
      reason: "restored-followup-queue",
      sessionKey,
    });
    woke += 1;
  }

  if (woke > 0) {
    log.info(`requested heartbeat wake for ${woke} restored followup queue route(s)`);
  }
  return woke;
}

export function scheduleRestoredFollowupQueueRecovery(params: {
  log: { error: (message: string) => void };
  delayMs?: number;
}): () => void {
  let disposed = false;
  const wakeOrLog = () => {
    if (disposed) {
      return;
    }
    try {
      wakeRestoredFollowupQueueSessions();
    } catch (err: unknown) {
      params.log.error(`Followup queue recovery failed: ${String(err)}`);
    }
  };
  // Restore retries can succeed after the one-shot startup timer. Re-wake then.
  setRestoredFollowupQueuesListener(wakeOrLog);
  const delayMs = params.delayMs ?? 1_250;
  const timer = setTimeout(wakeOrLog, delayMs);
  timer.unref?.();
  return () => {
    if (disposed) {
      return;
    }
    disposed = true;
    clearTimeout(timer);
    unsetRestoredFollowupQueuesListener(wakeOrLog);
  };
}
