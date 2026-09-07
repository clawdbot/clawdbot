// Bounded, drainable WhatsApp read-receipt dispatch for the inbound
// delivery coordinator.
import { createHash } from "node:crypto";
import { formatError } from "../session.js";
import type { WhatsAppReadReceiptTarget } from "./durable-receive.js";

export type WhatsAppReadReceiptDispatcherDeps = {
  /** Transport acknowledgement entry point (bounded by the socket operation timeout). */
  markRead: (target: WhatsAppReadReceiptTarget) => Promise<unknown>;
  /** Owner-configured receipt policy; false disables all receipt dispatch. */
  sendReadReceipts: boolean;
  logVerbose: (message: string) => void;
  logger: { warn: (obj: unknown, message: string) => void };
};

export type WhatsAppReadReceiptDispatcher = {
  maybeMarkInboundAsRead: (target: WhatsAppReadReceiptTarget | undefined) => Promise<void>;
};

export function createWhatsAppReadReceiptDispatcher(
  deps: WhatsAppReadReceiptDispatcherDeps,
): WhatsAppReadReceiptDispatcher {
  const { markRead, sendReadReceipts, logVerbose, logger } = deps;

  // One read receipt per transport message id: the receive-time accepted path
  // fires it, and later redeliveries (pending or completed verdicts) must not
  // re-send it. Successful receipts and in-flight claims are tracked
  // separately: a claim is only reserved while the markRead call is running
  // and is released when it rejects or times out, so a later same-process
  // redelivery can retry a lost receipt instead of being suppressed forever.
  // The success memo is bounded like the prepared-inbound map; the in-flight
  // claims are transient but are also bounded (READ_RECEIPT_INFLIGHT_MAX).
  // Receipts that arrive while the in-flight window is full are not dropped:
  // they enter a bounded FIFO pending queue (READ_RECEIPT_PENDING_MAX) and
  // are dispatched one at a time as each in-flight claim settles, so a
  // stalled socket cannot silently swallow blue ticks for accepted messages.
  // Only a burst beyond the pending bound is dropped, with a warn; message
  // admission is never blocked at any point.
  const READ_RECEIPT_MEMO_MAX = 1000;
  // Upper bound on concurrently stalled socket acknowledgements. markRead is
  // bounded by the socket operation timeout (default 60s); while the socket
  // is stalled, each distinct inbound message would otherwise start one more
  // socket operation with no cap.
  const READ_RECEIPT_INFLIGHT_MAX = 32;
  // Upper bound on receipt targets waiting for a free in-flight slot. Kept
  // small (128 entries, roughly four stalled in-flight windows) so memory
  // stays bounded even during a long socket outage; only a burst beyond this
  // bound is dropped (with a warn), and those stay retryable via redelivery.
  const READ_RECEIPT_PENDING_MAX = 128;
  const readReceiptsSent = new Set<string>();
  const readReceiptsInFlight = new Set<string>();
  const readReceiptsPending = new Map<string, WhatsAppReadReceiptTarget>();
  const buildReadReceiptDedupeKey = (target: WhatsAppReadReceiptTarget): string =>
    createHash("sha256").update(`${target.remoteJid}\n${target.id}`).digest("hex");

  const startReadReceiptDispatch = async (
    dedupeKey: string,
    target: WhatsAppReadReceiptTarget,
  ): Promise<void> => {
    if (readReceiptsSent.size >= READ_RECEIPT_MEMO_MAX) {
      const oldest = readReceiptsSent.keys().next().value;
      if (oldest !== undefined) {
        readReceiptsSent.delete(oldest);
      }
    }
    readReceiptsInFlight.add(dedupeKey);
    const { id, remoteJid, participant } = target;
    try {
      await markRead(target);
      // Record success only after the call resolves: a rejected or timed-out
      // attempt releases its reservation below and stays retryable.
      readReceiptsSent.add(dedupeKey);
      const suffix = participant ? ` (participant ${participant})` : "";
      logVerbose(`Marked message ${id} as read for ${remoteJid}${suffix}`);
    } catch (err) {
      logVerbose(`Failed to mark message ${id} read: ${String(err)}`);
    } finally {
      readReceiptsInFlight.delete(dedupeKey);
      // A slot freed up: drain the oldest queued receipt target (FIFO) so
      // saturated receipts are eventually delivered instead of dropped.
      const nextPending = readReceiptsPending.entries().next();
      if (!nextPending.done) {
        const [nextKey, nextTarget] = nextPending.value;
        readReceiptsPending.delete(nextKey);
        void startReadReceiptDispatch(nextKey, nextTarget).catch((error: unknown) => {
          logger.warn(
            { error: formatError(error) },
            "failed draining queued WhatsApp read receipt",
          );
        });
      }
    }
  };

  const maybeMarkInboundAsRead = async (target: WhatsAppReadReceiptTarget | undefined) => {
    if (!target || !sendReadReceipts) {
      return;
    }
    const dedupeKey = buildReadReceiptDedupeKey(target);
    if (readReceiptsSent.has(dedupeKey)) {
      logVerbose(`Skipping read receipt for already-acknowledged message ${target.id}`);
      return;
    }
    if (readReceiptsInFlight.has(dedupeKey)) {
      // A concurrent duplicate delivery is already acknowledging this
      // message; it must not double-fire.
      logVerbose(`Skipping read receipt for in-flight acknowledgement of message ${target.id}`);
      return;
    }
    if (readReceiptsPending.has(dedupeKey)) {
      // Already queued behind the saturated in-flight window; it must not be
      // double-queued.
      logVerbose(`Skipping read receipt for queued acknowledgement of message ${target.id}`);
      return;
    }
    if (readReceiptsInFlight.size >= READ_RECEIPT_INFLIGHT_MAX) {
      if (readReceiptsPending.size >= READ_RECEIPT_PENDING_MAX) {
        // Both windows are full: the receipt target cannot be retained.
        // Warn and drop without recording success so a later redelivery can
        // retry it once capacity frees up; admission of the message itself
        // is unaffected.
        logger.warn(
          {
            messageId: target.id,
            remoteJid: target.remoteJid,
            inFlight: readReceiptsInFlight.size,
            pending: readReceiptsPending.size,
          },
          "read receipt queues saturated; dropping receipt target for admitted message",
        );
        return;
      }
      // The acknowledgement window is full of stalled socket operations:
      // queue the target (FIFO) instead of dropping it. A freed in-flight
      // slot drains the queue head, so blue ticks are not silently lost
      // during a socket stall. Admission of the message is unaffected.
      readReceiptsPending.set(dedupeKey, target);
      logVerbose(
        `Read receipt dispatch saturated (${readReceiptsInFlight.size} in flight); queuing acknowledgement for message ${target.id} (pending ${readReceiptsPending.size})`,
      );
      return;
    }
    await startReadReceiptDispatch(dedupeKey, target);
  };

  return { maybeMarkInboundAsRead };
}
