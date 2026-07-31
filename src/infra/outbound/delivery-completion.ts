import {
  markModelSpendAlertsDelivered,
  markModelSpendAlertsQueued,
  markModelSpendAlertsUnknown,
  releaseModelSpendAlerts,
  type ModelSpendAlertCompletion,
} from "../../agents/model-spend-alerts.js";
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
type ConversationDurableDeliveryCompletion = {
  kind: "conversation";
  agentId: string;
  operationId: string;
  storePath?: string;
};

export type DurableDeliveryCompletion =
  | ConversationDurableDeliveryCompletion
  | ({ kind: "model_spend_alert" } & ModelSpendAlertCompletion);

type DurableDeliveryOwnerState = {
  status: string;
  platformMessageId?: string | null;
  preparedMessageId?: string | null;
  rejectionError?: string | null;
};

function scopeForCompletion(completion: ConversationDurableDeliveryCompletion) {
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
): DurableDeliveryOwnerState {
  if (completion.kind === "model_spend_alert") {
    return markModelSpendAlertsQueued(completion, queueId);
  }
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
): ConversationDeliveryRecord | void {
  if (completion.kind === "model_spend_alert") {
    markModelSpendAlertsDelivered(completion);
    return;
  }
  return markConversationDeliverySent(
    scopeForCompletion(completion),
    completion.operationId,
    readPlatformMessageId(result),
  );
}

/** Finalizes a policy-suppressed send before its durable intent is acknowledged. */
export function suppressDurableDelivery(
  completion: DurableDeliveryCompletion,
): ConversationDeliveryRecord | void {
  if (completion.kind === "model_spend_alert") {
    releaseModelSpendAlerts(completion);
    return;
  }
  return markConversationDeliverySuppressed(scopeForCompletion(completion), completion.operationId);
}

/** Finalizes a permanent provider rejection that provably preceded platform I/O. */
export function rejectDurableDelivery(
  completion: DurableDeliveryCompletion,
  error: string,
): ConversationDeliveryRecord | void {
  if (completion.kind === "model_spend_alert") {
    releaseModelSpendAlerts(completion);
    return;
  }
  return markConversationDeliveryRejected(
    scopeForCompletion(completion),
    completion.operationId,
    error,
  );
}

/** Makes a dead-lettered durable send terminal without allowing a blind replay. */
export function failDurableDelivery(
  completion: DurableDeliveryCompletion,
): ConversationDeliveryRecord | void {
  if (completion.kind === "model_spend_alert") {
    markModelSpendAlertsUnknown(completion);
    return;
  }
  return markConversationDeliveryUnknown(scopeForCompletion(completion), completion.operationId);
}
