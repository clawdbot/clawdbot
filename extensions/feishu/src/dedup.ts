// PERMANENT logical-identity guard above durable event_id tombstones. Feishu
// can redeliver one text message with a fresh message_id/event_id (#46778),
// and multi-account groups receive one logical broadcast per bot account.
// Queue tombstones cannot cover either twin; claims commit at turn adoption.
import type { ChannelReplayClaimHandle } from "openclaw/plugin-sdk/persistent-dedupe";
import { feishuDedupeState } from "./dedup-state.js";

type FeishuDedupeLog = (...args: unknown[]) => void;

export type FeishuMessageProcessingClaim = ChannelReplayClaimHandle;

type FeishuMessageClaim =
  | { kind: "claimed"; handle: FeishuMessageProcessingClaim }
  | { kind: "duplicate" }
  | { kind: "inflight"; pending: Promise<boolean> }
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
