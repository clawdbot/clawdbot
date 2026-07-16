// Feishu inbound replay protection rides the core claimable dedupe: Feishu
// redelivers events after reconnects/restarts and multi-account groups receive
// the same event once per bot, so handlers claim a dedupe key before
// processing, commit once handling is dispatched, and release on retryable
// failure so the event can be redelivered.
import type { ChannelReplayClaimHandle } from "openclaw/plugin-sdk/persistent-dedupe";
import { feishuDedupeState } from "./dedup-state.js";

type FeishuDedupeLog = (...args: unknown[]) => void;

export type FeishuMessageProcessingClaim = ChannelReplayClaimHandle;

type FeishuMessageClaim =
  | { kind: "claimed"; handle: FeishuMessageProcessingClaim }
  | { kind: "duplicate" }
  | { kind: "inflight" }
  | { kind: "invalid" };

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
 * and in-flight keys are reported; blank keys fail open as invalid so an
 * unidentifiable event is never suppressed.
 */
export async function claimUnprocessedFeishuMessage(params: {
  messageId: string | undefined | null;
  namespace?: string;
  log?: FeishuDedupeLog;
}): Promise<FeishuMessageClaim> {
  const claim = await feishuDedupeState.guard.claim(
    params.messageId,
    dedupeOptions(params.namespace, params.log),
  );
  if (claim.kind === "inflight") {
    return { kind: "inflight" };
  }
  return claim;
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
  processingClaim?: FeishuMessageProcessingClaim;
}): Promise<boolean> {
  const key = dedupeKey(params.messageId);
  if (!key) {
    return false;
  }
  const options = dedupeOptions(params.namespace, params.log);
  const claim = params.processingClaim ?? (await feishuDedupeState.guard.claim(key, options));
  if ("kind" in claim && claim.kind !== "claimed") {
    return false;
  }
  return await ("kind" in claim ? claim.handle : claim).commit();
}

/** Records a handled message so restart/replay cannot dispatch it again; false when already recorded. */
export async function recordProcessedFeishuMessage(
  messageId: string | undefined | null,
  namespace = "global",
  log?: FeishuDedupeLog,
): Promise<boolean> {
  const claim = await feishuDedupeState.guard.claim(messageId, dedupeOptions(namespace, log));
  return claim.kind === "claimed" ? await claim.handle.commit() : false;
}

/** Forgets a recorded message so a retryable synthetic event can be handled on redelivery. */
export async function forgetProcessedFeishuMessage(
  messageId: string | undefined | null,
  namespace = "global",
  log?: FeishuDedupeLog,
): Promise<boolean> {
  return await feishuDedupeState.guard.forget(messageId, dedupeOptions(namespace, log));
}

/** Checks recency without claiming or recording. */
export async function hasProcessedFeishuMessage(
  messageId: string | undefined | null,
  namespace = "global",
  log?: FeishuDedupeLog,
): Promise<boolean> {
  return await feishuDedupeState.guard.hasRecent(messageId, dedupeOptions(namespace, log));
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
