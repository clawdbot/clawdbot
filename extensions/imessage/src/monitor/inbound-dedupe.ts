// iMessage inbound replay protection: brings the channel in line with the
// other channels (whatsapp/discord/signal/...) by deduping inbound messages on
// a stable identity, plus an age fence that suppresses stale backlog Apple
// delivers in a burst after a bridge/Push recovery.
//
// Why both:
// - The GUID dedupe stops a message that was already dispatched from being
//   dispatched again when imsg re-emits a recent row on reconnect.
// - Dedupe cannot catch a message that was *never seen* (the gateway was down
//   when it was sent). Apple writes that backlog into chat.db with a fresh
//   ROWID but the original (old) send date, so it arrives on the live watch as
//   a "new" row. The age fence is what recognizes it as stale.
import { createHash } from "node:crypto";
import { createChannelReplayGuard } from "openclaw/plugin-sdk/persistent-dedupe";
import type { IMessagePayload } from "./types.js";

const IMESSAGE_INBOUND_DEDUPE_PLUGIN_ID = "imessage";
const IMESSAGE_INBOUND_DEDUPE_NAMESPACE_PREFIX = "imessage.inbound-dedupe";
// 4h recency window: long enough to absorb a reconnect/restart burst that
// re-emits recently dispatched rows, short enough that a genuinely-new message
// reusing a stale composite key after hours is not wrongly suppressed.
const IMESSAGE_INBOUND_DEDUPE_TTL_MS = 4 * 60 * 60 * 1000;
const IMESSAGE_INBOUND_DEDUPE_MEMORY_MAX = 5_000;
const IMESSAGE_INBOUND_DEDUPE_STATE_MAX_ENTRIES = 10_000;

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
 * Persistent inbound replay guard. Claimable (not a bare check/record) so the
 * claim is atomic: a duplicate emitted twice in a reconnect burst while the
 * first copy is still in flight is reported as a duplicate/inflight instead of
 * racing through. Persistent so a claim committed before a crash still blocks a
 * post-restart re-emit; release on dispatch failure lets a transient failure
 * retry instead of being permanently suppressed.
 */
type IMessageInboundReplayEvent =
  | { accountId: string; message: IMessagePayload }
  | { accountId: string; keys: readonly string[] };

export function createIMessageInboundReplayGuard() {
  return createChannelReplayGuard<IMessageInboundReplayEvent>({
    dedupe: {
      pluginId: IMESSAGE_INBOUND_DEDUPE_PLUGIN_ID,
      namespacePrefix: IMESSAGE_INBOUND_DEDUPE_NAMESPACE_PREFIX,
      ttlMs: IMESSAGE_INBOUND_DEDUPE_TTL_MS,
      memoryMaxSize: IMESSAGE_INBOUND_DEDUPE_MEMORY_MAX,
      stateMaxEntries: IMESSAGE_INBOUND_DEDUPE_STATE_MAX_ENTRIES,
    },
    buildReplayKey: (event) =>
      "message" in event
        ? buildIMessageInboundReplayKey({ accountId: event.accountId, message: event.message })
        : event.keys,
    namespace: (event) => event.accountId,
  });
}

/**
 * Stable replay key for an inbound message. Prefers the Apple GUID (globally
 * unique, survives chat.db rowid churn). Falls back to a composite of the
 * fields that identify a distinct send when no GUID is present, and returns
 * null when the message cannot be identified at all (fail open: never suppress
 * an unidentifiable message).
 */
export function buildIMessageInboundReplayKey(params: {
  accountId: string;
  message: IMessagePayload;
}): string | null {
  const { accountId, message } = params;
  const guid = message.guid?.trim();
  if (guid) {
    return `${accountId}:guid:${guid}`;
  }
  const sender = message.sender?.trim();
  const conversation =
    message.chat_id != null
      ? `chat:${message.chat_id}`
      : (message.chat_guid?.trim() ?? message.chat_identifier?.trim());
  const createdAt = message.created_at?.trim();
  if (!sender || !conversation || !createdAt) {
    return null;
  }
  const text = (message.text ?? "").trim();
  // Hash the variable parts so the key is bounded regardless of text length
  // (the persisted dedupe store caps key size); createdAt + sender + text make
  // the identity unique enough for a GUID-less row.
  const digest = createHash("sha256")
    .update(`${conversation}\0${sender}\0${createdAt}\0${text}`)
    .digest("hex")
    .slice(0, 32);
  return `${accountId}:c:${digest}`;
}

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
