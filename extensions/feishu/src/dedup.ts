// Feishu inbound replay protection rides the core claimable dedupe: Feishu
// redelivers events after reconnects/restarts and multi-account groups receive
// the same event once per bot, so handlers claim a dedupe key before
// processing, commit once handling is dispatched, and release on retryable
// failure so the event can be redelivered.
import { feishuDedupeState } from "./dedup-state.js";

type FeishuDedupeLog = (...args: unknown[]) => void;

type FeishuMessageClaim = "claimed" | "duplicate" | "inflight";

function dedupeKey(messageId: string | undefined | null): string {
  return messageId?.trim() ?? "";
}

function dedupeOptions(namespace: string | undefined, log: FeishuDedupeLog | undefined) {
  return {
    ...(namespace ? { namespace } : {}),
    // Persistence is best effort: a broken state DB must never block inbound
    // handling, so disk errors surface to the caller's log while the memory
    // layer keeps deduping.
    ...(log
      ? {
          onDiskError: (error: unknown) =>
            log(`feishu-dedup: persistent state error: ${String(error)}`),
        }
      : {}),
  };
}

/**
 * Claims a dedupe key for exclusive handling. Duplicate (already committed)
 * and in-flight keys are reported; blank keys fail open as claimed so an
 * unidentifiable event is never suppressed.
 */
export async function claimUnprocessedFeishuMessage(params: {
  messageId: string | undefined | null;
  namespace?: string;
  log?: FeishuDedupeLog;
}): Promise<FeishuMessageClaim> {
  const key = dedupeKey(params.messageId);
  if (!key) {
    return "claimed";
  }
  return (await feishuDedupeState.guard.claim(key, dedupeOptions(params.namespace, params.log)))
    .kind;
}

/** Drops an uncommitted claim so a failed handler can retry the message. */
export function releaseFeishuMessageProcessing(
  messageId: string | undefined | null,
  namespace = "global",
): void {
  const key = dedupeKey(messageId);
  if (key) {
    feishuDedupeState.guard.release(key, { namespace });
  }
}

/**
 * Claims (unless the caller already holds the claim) and commits a message.
 * False means another handler owns it, it was already handled, or the key is
 * blank; handlers must skip dispatch then.
 */
export async function finalizeFeishuMessageProcessing(params: {
  messageId: string | undefined | null;
  namespace?: string;
  log?: FeishuDedupeLog;
  claimHeld?: boolean;
}): Promise<boolean> {
  const key = dedupeKey(params.messageId);
  if (!key) {
    return false;
  }
  const options = dedupeOptions(params.namespace, params.log);
  if (!params.claimHeld && (await feishuDedupeState.guard.claim(key, options)).kind !== "claimed") {
    return false;
  }
  return await feishuDedupeState.guard.commit(key, options);
}

/** Records a handled message so restart/replay cannot dispatch it again; false when already recorded. */
export async function recordProcessedFeishuMessage(
  messageId: string | undefined | null,
  namespace = "global",
  log?: FeishuDedupeLog,
): Promise<boolean> {
  const key = dedupeKey(messageId);
  if (!key) {
    return false;
  }
  return await feishuDedupeState.guard.commit(key, dedupeOptions(namespace, log));
}

/** Forgets a recorded message so a retryable synthetic event can be handled on redelivery. */
export async function forgetProcessedFeishuMessage(
  messageId: string | undefined | null,
  namespace = "global",
  log?: FeishuDedupeLog,
): Promise<boolean> {
  const key = dedupeKey(messageId);
  if (!key) {
    return false;
  }
  return await feishuDedupeState.guard.forget(key, dedupeOptions(namespace, log));
}

/** Checks recency without claiming or recording. */
export async function hasProcessedFeishuMessage(
  messageId: string | undefined | null,
  namespace = "global",
  log?: FeishuDedupeLog,
): Promise<boolean> {
  const key = dedupeKey(messageId);
  if (!key) {
    return false;
  }
  return await feishuDedupeState.guard.hasRecent(key, dedupeOptions(namespace, log));
}

/** Loads recent persisted entries into memory at account start; returns the loaded count. */
export async function warmupDedupFromPluginState(
  namespace: string,
  log?: FeishuDedupeLog,
): Promise<number> {
  return await feishuDedupeState.guard.warmup(namespace, (error) =>
    log?.(`feishu-dedup: warmup persistent state error: ${String(error)}`),
  );
}
