import type { SessionWriterDeliveryAuthority } from "../../auto-reply/reply-payload.js";
import { resolveMessageReceiptPrimaryId } from "../../channels/message/receipt.js";
import {
  ConversationDeliveryMissingError,
  markConversationDeliveryQueued,
  markConversationDeliveryRejected,
  markConversationDeliverySent,
  markConversationDeliverySuppressed,
  markConversationDeliveryUnknown,
  type ConversationDeliveryRecord,
} from "../../config/sessions/conversation-delivery-store.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OutboundDeliveryResult } from "./deliver-types.js";

/** Serializable owner callback for a durable queue entry. */
export type DurableDeliveryCompletion =
  | {
      kind: "conversation";
      agentId: string;
      operationId: string;
      storePath?: string;
      /** Present on Gateway-owned conversation intents created with route authorization. */
      routeFingerprint?: string;
    }
  | {
      kind: "pending-final";
      deliveryId: string;
      intentId: string;
      sessionId: string;
      sessionKey: string;
      storePath: string;
      sessionWriterDeliveryAuthority?: SessionWriterDeliveryAuthority;
    };

type DurableDeliveryCompletionResult = {
  state: "prepared" | "queued" | "delivered" | "suppressed" | "rejected" | "unknown" | "stale";
  platformMessageId?: string;
  rejectionError?: string;
};

function scopeForCompletion(
  completion: Extract<DurableDeliveryCompletion, { kind: "conversation" }>,
) {
  return {
    agentId: completion.agentId,
    ...(completion.storePath ? { storePath: completion.storePath } : {}),
  };
}

function conversationResult(
  update: () => ConversationDeliveryRecord,
): DurableDeliveryCompletionResult {
  let record: ConversationDeliveryRecord;
  try {
    record = update();
  } catch (error) {
    // Full session deletion can retire the owner before its shared queue settles.
    if (error instanceof ConversationDeliveryMissingError) {
      return { state: "stale" };
    }
    throw error;
  }
  const delivered = record.status === "sent" || record.status === "replied";
  return {
    state: delivered
      ? "delivered"
      : record.status === "suppressed" ||
          record.status === "rejected" ||
          record.status === "unknown"
        ? record.status
        : "queued",
    ...(delivered && (record.platformMessageId || record.preparedMessageId)
      ? { platformMessageId: record.platformMessageId ?? record.preparedMessageId }
      : {}),
    ...(record.status === "rejected" && record.rejectionError
      ? { rejectionError: record.rejectionError }
      : {}),
  };
}

export async function settlePendingFinalDelivery(
  completion: Extract<DurableDeliveryCompletion, { kind: "pending-final" }>,
  state: Exclude<DurableDeliveryCompletionResult["state"], "rejected" | "stale">,
  expectedStates?: readonly ("prepared" | "queued" | "unknown")[],
  options: { stateDir?: string; preserveActivity?: boolean } = {},
): Promise<DurableDeliveryCompletionResult> {
  let settled: DurableDeliveryCompletionResult["state"] = "stale";
  let wakeRecovery = false;
  await patchSessionEntryCore(
    { sessionKey: completion.sessionKey, storePath: completion.storePath },
    (entry) => {
      const internalEntry: InternalSessionEntry = entry;
      if (
        internalEntry.sessionId !== completion.sessionId ||
        internalEntry.pendingFinalDelivery?.intentId !== completion.intentId
      ) {
        return null;
      }
      const deliveries = internalEntry.pendingFinalDelivery.deliveries;
      const index = deliveries?.findIndex(({ id }) => id === completion.deliveryId) ?? -1;
      if (!deliveries || index < 0) {
        return null;
      }
      const current = deliveries[index]!.state;
      if (expectedStates && !expectedStates.some((expected) => expected === current)) {
        return null;
      }
      const terminal =
        current === "delivered" ||
        current === "suppressed" ||
        (current === "unknown" && state === "unknown");
      settled = terminal ? current : state;
      const pending = internalEntry.pendingFinalDelivery;
      const existingNotice = internalEntry.pendingDeliveryNotice;
      const owedNotice =
        settled === "unknown" &&
        (current === "queued" || current === "unknown") &&
        pending.context &&
        pending.intentId &&
        existingNotice?.intentId !== pending.intentId &&
        (!existingNotice || existingNotice.createdAt <= pending.createdAt)
          ? {
              pendingDeliveryNotice: {
                createdAt: pending.createdAt,
                context: pending.context,
                intentId: pending.intentId,
                state: "owed" as const,
              },
            }
          : undefined;
      const updatedDeliveries = deliveries.with(index, {
        id: completion.deliveryId,
        state: settled,
      });
      const clearsNotice =
        existingNotice?.state !== "acknowledged" &&
        !updatedDeliveries.some((delivery) => delivery.state === "unknown") &&
        settled !== "queued" &&
        settled !== "unknown" &&
        existingNotice?.intentId === pending.intentId;
      // One resolved sibling cannot erase another's ambiguity. Acknowledgment
      // remains an intent-level fact so delayed settlement cannot owe it again.
      if (settled === current && !owedNotice && !clearsNotice) {
        return null;
      }
      wakeRecovery =
        settled !== "queued" &&
        internalEntry.status === "running" &&
        internalEntry.abortedLastRun === true;
      return {
        ...(internalEntry.mainRestartRecovery
          ? {
              mainRestartRecovery: {
                ...internalEntry.mainRestartRecovery,
                revision: internalEntry.mainRestartRecovery.revision + 1,
              },
            }
          : {}),
        pendingFinalDelivery: {
          ...internalEntry.pendingFinalDelivery,
          deliveries: updatedDeliveries,
        },
        ...(clearsNotice ? { pendingDeliveryNotice: undefined } : owedNotice),
      };
    },
    { skipMaintenance: true, takeCacheOwnership: true, preserveActivity: options.preserveActivity },
  );
  if (wakeRecovery) {
    const { scheduleMainSessionRecoveryPendingTarget } =
      await import("../../agents/main-session-recovery/main-session-recovery-owner-release.js");
    scheduleMainSessionRecoveryPendingTarget({
      sessionId: completion.sessionId,
      sessionKey: completion.sessionKey,
      ...(options.stateDir !== undefined ? { stateDir: options.stateDir } : {}),
      storePath: completion.storePath,
    });
  }
  return { state: settled };
}

function readPlatformMessageId(result: OutboundDeliveryResult): string | undefined {
  const receiptId = result.receipt ? resolveMessageReceiptPrimaryId(result.receipt) : undefined;
  return receiptId ?? (result.messageId.trim() || undefined);
}

/** Records queue ownership before either the live sender or recovery crosses platform I/O. */
export async function markDurableDeliveryQueued(
  completion: DurableDeliveryCompletion,
  queueId: string,
  expectedPendingFinalState?: "prepared",
): Promise<DurableDeliveryCompletionResult> {
  return completion.kind === "pending-final"
    ? // The reply dispatcher may have claimed direct custody ("queued") before the
      // durable enqueue; both states still belong to this send attempt.
      await settlePendingFinalDelivery(
        completion,
        "queued",
        expectedPendingFinalState ? ["prepared", "queued"] : undefined,
      )
    : conversationResult(() =>
        markConversationDeliveryQueued(
          scopeForCompletion(completion),
          completion.operationId,
          queueId,
        ),
      );
}

/** Finalizes owner state from identified platform evidence before queue acknowledgement. */
export async function completeDurableDelivery(
  completion: DurableDeliveryCompletion,
  result: OutboundDeliveryResult,
  stateDir?: string,
): Promise<DurableDeliveryCompletionResult> {
  return completion.kind === "pending-final"
    ? await settlePendingFinalDelivery(completion, "delivered", undefined, { stateDir })
    : conversationResult(() =>
        markConversationDeliverySent(
          scopeForCompletion(completion),
          completion.operationId,
          readPlatformMessageId(result),
        ),
      );
}

/** Finalizes a policy-suppressed send before its durable intent is acknowledged. */
async function suppressDurableDelivery(
  completion: DurableDeliveryCompletion,
  stateDir?: string,
): Promise<DurableDeliveryCompletionResult> {
  return completion.kind === "pending-final"
    ? await settlePendingFinalDelivery(completion, "suppressed", undefined, { stateDir })
    : conversationResult(() =>
        markConversationDeliverySuppressed(scopeForCompletion(completion), completion.operationId),
      );
}

/** Finalizes a permanent provider rejection that provably preceded platform I/O. */
export async function rejectDurableDelivery(
  completion: DurableDeliveryCompletion,
  error: string,
  stateDir?: string,
): Promise<DurableDeliveryCompletionResult> {
  // Proven no-send: terminal suppression, not the unknown state that owes an
  // uncertainty notice for a send the provider asserts never began.
  return completion.kind === "pending-final"
    ? await settlePendingFinalDelivery(completion, "suppressed", undefined, { stateDir })
    : conversationResult(() =>
        markConversationDeliveryRejected(
          scopeForCompletion(completion),
          completion.operationId,
          error,
        ),
      );
}

/** Makes a dead-lettered durable send terminal without allowing a blind replay. */
export async function failDurableDelivery(
  completion: DurableDeliveryCompletion,
  stateDir?: string,
): Promise<DurableDeliveryCompletionResult> {
  return completion.kind === "pending-final"
    ? await settlePendingFinalDelivery(completion, "unknown", undefined, { stateDir })
    : conversationResult(() =>
        markConversationDeliveryUnknown(scopeForCompletion(completion), completion.operationId),
      );
}

type DurableDeliveryTerminalEvidence =
  | { result: OutboundDeliveryResult }
  | { platformSendStarted: boolean };

/** Settles the completion owner from the final evidence held by its lifecycle owner. */
export async function settleDurableDelivery(
  completion: DurableDeliveryCompletion,
  evidence: DurableDeliveryTerminalEvidence,
  stateDir?: string,
): Promise<DurableDeliveryCompletionResult> {
  return "result" in evidence
    ? completeDurableDelivery(completion, evidence.result, stateDir)
    : evidence.platformSendStarted
      ? failDurableDelivery(completion, stateDir)
      : suppressDurableDelivery(completion, stateDir);
}
