import type { ConversationSendResult } from "../../packages/gateway-protocol/src/schema/agent.js";
import {
  ConversationDeliveryInputError,
  type ConversationDeliveryRecord,
} from "../config/sessions/conversation-delivery-store.js";
import {
  resolveConversation,
  resolveConversationRegistryScope,
} from "../config/sessions/conversation-registry.js";
import { resolveConversationRouteFingerprint } from "../config/sessions/conversation-route-fingerprint.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  ConversationDeliveryRejectedError,
  defaultConversationDeliveryDeps,
  sendGatewayConversationMessage,
  type ConversationDeliveryDeps,
} from "../infra/outbound/conversation-delivery.js";
import {
  ConversationInputError,
  ConversationOperationConflictError,
} from "./conversation-errors.js";
import {
  assertConversationDeliveryAttemptAuthorized,
  assertConversationRouteEligibleForAgent,
} from "./conversation-route-ownership.js";

type ConversationSendDeps = ConversationDeliveryDeps & {
  resolveConversation: typeof resolveConversation;
};

const defaultDeps: ConversationSendDeps = {
  ...defaultConversationDeliveryDeps,
  resolveConversation,
};

function resultForCompletedOperation(
  operation: ConversationDeliveryRecord,
): ConversationSendResult | undefined {
  const base = {
    conversationRef: operation.conversationRef,
    channel: operation.channel,
    ...(operation.queueId ? { queueId: operation.queueId } : {}),
  };
  switch (operation.status) {
    case "sent":
    case "replied":
      return {
        ...base,
        status: "sent",
        ...(operation.platformMessageId || operation.preparedMessageId
          ? { messageId: operation.platformMessageId ?? operation.preparedMessageId }
          : {}),
      };
    case "queued":
      return {
        ...base,
        status: "queued",
        ...(operation.preparedMessageId ? { messageId: operation.preparedMessageId } : {}),
      };
    case "suppressed":
      return { ...base, status: "suppressed" };
    case "rejected":
      throw new ConversationDeliveryRejectedError(
        operation.rejectionError ?? "Conversation delivery was permanently rejected",
      );
    case "unknown":
      return { ...base, status: "unknown" };
    case "created":
      return undefined;
  }
  return operation.status satisfies never;
}

/** Performs one durable conversation send inside the Gateway channel owner. */
export async function runGatewayConversationSend(
  params: {
    config: OpenClawConfig;
    readCurrentConfig?: () => OpenClawConfig;
    agentId: string;
    senderIsOwner: boolean;
    sourceSessionKey?: string;
    operationId: string;
    conversationRef: string;
    message: string;
    signal?: AbortSignal;
  },
  deps: ConversationSendDeps = defaultDeps,
): Promise<ConversationSendResult> {
  const scope = resolveConversationRegistryScope(params);
  try {
    const prior = deps.getOperation(scope, params.operationId);
    let operation: ConversationDeliveryRecord | undefined;
    if (prior) {
      operation = deps.beginOperation(scope, {
        operationId: params.operationId,
        operationKind: "send",
        conversationRef: params.conversationRef,
        ...(params.sourceSessionKey ? { sourceSessionKey: params.sourceSessionKey } : {}),
        message: params.message,
      }).record;
    }

    const conversation = deps.resolveConversation(scope, params.conversationRef);
    if (!conversation) {
      throw new ConversationInputError(
        `Conversation not found: ${params.conversationRef} (use conversations_list)`,
      );
    }
    const currentConfig = params.readCurrentConfig?.() ?? params.config;
    assertConversationRouteEligibleForAgent({
      config: currentConfig,
      agentId: params.agentId,
      conversation,
    });
    const routeFingerprint = resolveConversationRouteFingerprint(conversation);
    if (operation) {
      const completed = resultForCompletedOperation(operation);
      if (completed) {
        return completed;
      }
    }
    const sent = await sendGatewayConversationMessage({
      deps,
      context: {
        agentId: params.agentId,
        ...(params.sourceSessionKey ? { sourceSessionKey: params.sourceSessionKey } : {}),
        config: currentConfig,
        senderIsOwner: params.senderIsOwner,
      },
      conversation,
      message: params.message,
      operationId: params.operationId,
      operationKind: "send",
      routeFingerprint,
      onDeliveryAttempt: async () => {
        assertConversationDeliveryAttemptAuthorized({
          config: params.readCurrentConfig?.() ?? currentConfig,
          agentId: params.agentId,
          conversationRef: conversation.conversationRef,
          expectedRouteFingerprint: routeFingerprint,
          scope,
          resolveConversation: deps.resolveConversation,
        });
      },
      ...(operation ? { operation } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    return {
      status: sent.deliveryStatus,
      conversationRef: conversation.conversationRef,
      channel: conversation.channel,
      ...(sent.messageId ? { messageId: sent.messageId } : {}),
      ...(sent.operation.queueId ? { queueId: sent.operation.queueId } : {}),
    };
  } catch (error) {
    if (error instanceof ConversationDeliveryInputError) {
      throw new ConversationOperationConflictError(error.message);
    }
    if (error instanceof ConversationDeliveryRejectedError) {
      throw new ConversationInputError(error.message);
    }
    throw error;
  }
}
