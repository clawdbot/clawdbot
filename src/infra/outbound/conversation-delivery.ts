/** Durable external-conversation delivery independent from local model sessions. */
import crypto from "node:crypto";
import { resolveMessageReceiptPrimaryId } from "../../channels/message/receipt.js";
import type { DurableMessageSendIntent } from "../../channels/message/types.js";
import {
  beginConversationDeliveryOperation,
  getConversationDeliveryOperation,
  markConversationDeliveryQueued,
  markConversationDeliverySent,
  markConversationDeliverySuppressed,
  type ConversationDeliveryRecord,
  type ConversationDeliveryStoreScope,
} from "../../config/sessions/conversation-delivery-store.js";
import type { ConversationRecord } from "../../config/sessions/conversation-registry.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { runMessageAction, type MessageActionRunResult } from "./message-action-runner.js";

export type ConversationDeliveryDeps = {
  beginOperation: typeof beginConversationDeliveryOperation;
  getOperation: typeof getConversationDeliveryOperation;
  markQueued: typeof markConversationDeliveryQueued;
  markSent: typeof markConversationDeliverySent;
  markSuppressed: typeof markConversationDeliverySuppressed;
  runMessageAction: typeof runMessageAction;
};

export const defaultConversationDeliveryDeps: ConversationDeliveryDeps = {
  beginOperation: beginConversationDeliveryOperation,
  getOperation: getConversationDeliveryOperation,
  markQueued: markConversationDeliveryQueued,
  markSent: markConversationDeliverySent,
  markSuppressed: markConversationDeliverySuppressed,
  runMessageAction,
};

type ConversationDeliveryContext = {
  agentId: string;
  sourceSessionKey?: string;
  config: OpenClawConfig;
  senderIsOwner?: boolean;
};

type ConversationMessageDeliveryResult = {
  deliveryStatus: "sent" | "suppressed" | "queued" | "unknown";
  operation: ConversationDeliveryRecord;
  messageId?: string;
};

export class ConversationDeliveryRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationDeliveryRejectedError";
  }
}

function buildConversationDeliveryIntentId(agentId: string, operationId: string): string {
  // Operation ids are agent-scoped, while the delivery queue is process-global.
  // Bind both owners so equal tool-call ids cannot suppress another agent's send.
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify([agentId, operationId]))
    .digest("hex")
    .slice(0, 32);
  return `convq_${digest}`;
}

function resolveConversationDeliveryStoreScope(
  context: ConversationDeliveryContext,
): ConversationDeliveryStoreScope {
  return {
    agentId: context.agentId,
    // Recovery cannot serialize process.env. Persist the resolved marker path
    // so it reopens the same per-agent SQLite database after restart.
    storePath: resolveStorePath(context.config.session?.store, { agentId: context.agentId }),
  };
}

function readMessageIdFromActionResult(result: MessageActionRunResult): string | undefined {
  if (result.kind !== "send") {
    return undefined;
  }
  const sendResult = result.sendResult?.result;
  if (sendResult && "receipt" in sendResult && sendResult.receipt) {
    const receiptId = resolveMessageReceiptPrimaryId(sendResult.receipt);
    if (receiptId) {
      return receiptId;
    }
  }
  if (sendResult && "messageId" in sendResult && typeof sendResult.messageId === "string") {
    return sendResult.messageId.trim() || undefined;
  }
  const payload = result.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const messageId = (payload as { messageId?: unknown }).messageId;
    return typeof messageId === "string" && messageId.trim() ? messageId.trim() : undefined;
  }
  return undefined;
}

function resultFromExistingOperation(
  operation: ConversationDeliveryRecord,
): ConversationMessageDeliveryResult | undefined {
  switch (operation.status) {
    case "sent":
    case "replied":
      return {
        deliveryStatus: "sent",
        operation,
        ...(operation.platformMessageId || operation.preparedMessageId
          ? { messageId: operation.platformMessageId ?? operation.preparedMessageId }
          : {}),
      };
    case "queued":
      return {
        deliveryStatus: "queued",
        operation,
        ...(operation.preparedMessageId ? { messageId: operation.preparedMessageId } : {}),
      };
    case "suppressed":
      return { deliveryStatus: "suppressed", operation };
    case "rejected":
      throw new ConversationDeliveryRejectedError(
        operation.rejectionError ?? "Conversation delivery was permanently rejected",
      );
    case "unknown":
      return { deliveryStatus: "unknown", operation };
    case "created":
      return undefined;
  }
  return operation.status satisfies never;
}

/**
 * Sends one external message after a durable operation and queue intent exist.
 * A retry with the same operation id observes prior state instead of re-sending.
 */
export async function sendGatewayConversationMessage(params: {
  deps: ConversationDeliveryDeps;
  context: ConversationDeliveryContext;
  conversation: ConversationRecord;
  message: string;
  operationId: string;
  operationKind: ConversationDeliveryRecord["operationKind"];
  operation?: ConversationDeliveryRecord;
  preparedMessageId?: string;
  signal?: AbortSignal;
}): Promise<ConversationMessageDeliveryResult> {
  const scope = resolveConversationDeliveryStoreScope(params.context);
  const begun = params.operation
    ? { created: false, record: params.operation }
    : params.deps.beginOperation(scope, {
        operationId: params.operationId,
        operationKind: params.operationKind,
        conversationRef: params.conversation.conversationRef,
        ...(params.context.sourceSessionKey
          ? { sourceSessionKey: params.context.sourceSessionKey }
          : {}),
        message: params.message,
        ...(params.preparedMessageId ? { preparedMessageId: params.preparedMessageId } : {}),
      });
  const existing = resultFromExistingOperation(begun.record);
  if (existing) {
    return existing;
  }

  let latestOperation = begun.record;
  const readAuthoritativeOperation = () =>
    params.deps.getOperation(scope, begun.record.operationId) ?? latestOperation;
  const onDeliveryIntent = (intent: DurableMessageSendIntent) => {
    latestOperation = params.deps.markQueued(scope, begun.record.operationId, intent.id);
  };
  try {
    const action = await params.deps.runMessageAction({
      cfg: params.context.config,
      action: "send",
      params: {
        channel: params.conversation.channel,
        to: params.conversation.target,
        accountId: params.conversation.accountId,
        message: params.message,
        ...(params.conversation.threadId ? { threadId: params.conversation.threadId } : {}),
        idempotencyKey: params.operationId,
      },
      defaultAccountId: params.conversation.accountId,
      agentId: params.context.agentId,
      sessionKey: params.context.sourceSessionKey,
      senderIsOwner: params.context.senderIsOwner,
      suppressTranscriptMirror: true,
      forceCoreDelivery: true,
      gatewayOwnedDelivery: true,
      requireQueuePersistence: true,
      deliveryIntentId: buildConversationDeliveryIntentId(
        params.context.agentId,
        begun.record.operationId,
      ),
      deliveryCompletion: {
        kind: "conversation",
        agentId: scope.agentId,
        operationId: begun.record.operationId,
        ...(scope.storePath ? { storePath: scope.storePath } : {}),
      },
      onDeliveryIntent,
      ...(begun.record.preparedMessageId
        ? { preparedMessageId: begun.record.preparedMessageId }
        : {}),
      ...(params.signal ? { abortSignal: params.signal } : {}),
    });
    if (action.kind !== "send") {
      throw new Error(`Conversation delivery returned unexpected action: ${action.kind}`);
    }
    if (action.dryRun) {
      throw new Error("Conversation delivery was only prepared; no message was sent");
    }
    if (action.handledBy !== "core" || !action.sendResult) {
      throw new Error("Conversation delivery did not return a core platform send result");
    }
    const messageId = readMessageIdFromActionResult(action);
    if (action.sendResult.deliveryStatus === "suppressed") {
      const operation = params.deps.markSuppressed(scope, begun.record.operationId);
      return { deliveryStatus: "suppressed", operation };
    }
    if (action.sendResult.deliveryStatus !== "sent") {
      throw new Error(
        `Conversation delivery was not confirmed (${action.sendResult.deliveryStatus ?? "unknown"})`,
      );
    }
    const authoritativeOperation = readAuthoritativeOperation();
    const operation =
      authoritativeOperation.status === "sent" || authoritativeOperation.status === "replied"
        ? authoritativeOperation
        : params.deps.markSent(scope, begun.record.operationId, messageId);
    const confirmedMessageId =
      messageId ?? operation.platformMessageId ?? operation.preparedMessageId;
    return {
      deliveryStatus: "sent",
      operation,
      ...(confirmedMessageId ? { messageId: confirmedMessageId } : {}),
    };
  } catch (error) {
    // The serialized queue owner may have completed after the intent callback,
    // while this stack still holds its older queued snapshot.
    const persisted = resultFromExistingOperation(readAuthoritativeOperation());
    if (persisted) {
      return persisted;
    }
    // Required queue delivery cannot cross platform I/O before the intent
    // callback. Pre-queue errors remain retryable; a callback failure leaves
    // the stable queue id in charge of dedupe.
    throw error;
  }
}
