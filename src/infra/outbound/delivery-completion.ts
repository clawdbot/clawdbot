import { resolveMessageReceiptPrimaryId } from "../../channels/message/receipt.js";
import {
  markConversationDeliveryQueued,
  markConversationDeliveryRejected,
  markConversationDeliverySent,
  markConversationDeliverySuppressed,
  markConversationDeliveryUnknown,
  type ConversationDeliveryRecord,
} from "../../config/sessions/conversation-delivery-store.js";
import type { OutboundDeliveryResult } from "./deliver-types.js";

/** Serializable owner callback for a durable queue entry. */
export type DurableDeliveryCompletion = {
  kind: "conversation";
  agentId: string;
  operationId: string;
  storePath?: string;
};

function scopeForCompletion(completion: DurableDeliveryCompletion) {
  return {
    agentId: completion.agentId,
    ...(completion.storePath ? { storePath: completion.storePath } : {}),
  };
}

function readPlatformMessageId(result: OutboundDeliveryResult): string | undefined {
  const receiptId = result.receipt ? resolveMessageReceiptPrimaryId(result.receipt) : undefined;
  return receiptId ?? (result.messageId.trim() || undefined);
}

/** Records queue ownership before either the live sender or recovery crosses platform I/O. */
export function markDurableDeliveryQueued(
  completion: DurableDeliveryCompletion,
  queueId: string,
): ConversationDeliveryRecord {
  return markConversationDeliveryQueued(
    scopeForCompletion(completion),
    completion.operationId,
    queueId,
  );
}

/** Finalizes owner state from identified platform evidence before queue acknowledgement. */
export function completeDurableDelivery(
  completion: DurableDeliveryCompletion,
  result: OutboundDeliveryResult,
): ConversationDeliveryRecord {
  return markConversationDeliverySent(
    scopeForCompletion(completion),
    completion.operationId,
    readPlatformMessageId(result),
  );
}

/** Finalizes a policy-suppressed send before its durable intent is acknowledged. */
export function suppressDurableDelivery(
  completion: DurableDeliveryCompletion,
): ConversationDeliveryRecord {
  return markConversationDeliverySuppressed(scopeForCompletion(completion), completion.operationId);
}

/** Finalizes a permanent provider rejection that provably preceded platform I/O. */
export function rejectDurableDelivery(
  completion: DurableDeliveryCompletion,
  error: string,
): ConversationDeliveryRecord {
  return markConversationDeliveryRejected(
    scopeForCompletion(completion),
    completion.operationId,
    error,
  );
}

/** Makes a dead-lettered durable send terminal without allowing a blind replay. */
export function failDurableDelivery(
  completion: DurableDeliveryCompletion,
): ConversationDeliveryRecord {
  return markConversationDeliveryUnknown(scopeForCompletion(completion), completion.operationId);
}
