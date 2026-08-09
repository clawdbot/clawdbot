// iMessage age fence. This is not replay dedupe: Apple can write never-seen
// backlog with a fresh ROWID/GUID but the original old send date, so only the
// send-date fence can distinguish that backlog from live traffic.
import type { IMessagePayload } from "./types.js";

// Drop a LIVE inbound row whose send date is older than this relative to
// arrival. Stale backlog Apple flushes after a Push recovery carries old send
// dates; live messages are seconds old. 15min sits far above clock skew between
// a remote bridge host and the gateway, and far below any plausible live
// conversation latency.
export const IMESSAGE_STALE_INBOUND_THRESHOLD_MS = 15 * 60 * 1000;

// Recovery (catchup): on startup imsg replays rows that landed while the gateway
// was down. Those replayed rows are deliberately requested, so they use a wider
// age window than the live fence — deliver a missed message up to this old,
// suppress anything older so a long downtime cannot dump ancient history.
export const IMESSAGE_RECOVERY_MAX_AGE_MS = 2 * 60 * 60 * 1000;
// Cap the replay span so a months-down gateway does not stream its whole
// history: never set since_rowid more than this many rows below the current max.
export const IMESSAGE_RECOVERY_MAX_ROWS = 500;

/**
 * Age fence: true when the message's own send date is materially older than
 * now, i.e. stale backlog rather than a live message. Fails open (returns
 * false) when the send date is missing or unparseable so an undateable message
 * is never suppressed on a timestamp we cannot read.
 */
export function isStaleIMessageBacklog(
  message: IMessagePayload,
  nowMs: number,
  thresholdMs: number = IMESSAGE_STALE_INBOUND_THRESHOLD_MS,
): boolean {
  const createdAt = message.created_at?.trim();
  if (!createdAt) {
    return false;
  }
  const sentMs = Date.parse(createdAt);
  if (!Number.isFinite(sentMs)) {
    return false;
  }
  return nowMs - sentMs > thresholdMs;
}
