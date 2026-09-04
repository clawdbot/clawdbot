import type { ConversationTurnResult } from "../../packages/gateway-protocol/src/schema/agent.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import { ConversationDeliveryInputError } from "../config/sessions/conversation-delivery-store.js";
import {
  resolveConversation,
  resolveConversationRegistryScope,
  type ConversationRecord,
  type ConversationRegistryScope,
} from "../config/sessions/conversation-registry.js";
import { resolveConversationRouteFingerprint } from "../config/sessions/conversation-route-fingerprint.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveOutboundChannelPlugin } from "../infra/outbound/channel-resolution.js";
import {
  ConversationDeliveryRejectedError,
  defaultConversationDeliveryDeps,
  sendGatewayConversationMessage,
  type ConversationDeliveryDeps,
} from "../infra/outbound/conversation-delivery.js";
import {
  bindOutboundSessionEntry,
  resolveOutboundSessionRoute,
} from "../infra/outbound/outbound-session.js";
import { registerPendingConversationTurn } from "../sessions/conversation-turns.js";
import {
  ConversationInputError,
  ConversationOperationConflictError,
} from "./conversation-errors.js";
import {
  assertConversationDeliveryAttemptAuthorized,
  assertConversationRouteEligibleForAgent,
} from "./conversation-route-ownership.js";

type ConversationTurnDeps = ConversationDeliveryDeps & {
  registerPendingConversationTurn: typeof registerPendingConversationTurn;
  resolveConversation: typeof resolveConversation;
  resolveOutboundChannelPlugin: typeof resolveOutboundChannelPlugin;
  bindOutboundSessionEntry: typeof bindOutboundSessionEntry;
  resolveOutboundSessionRoute: typeof resolveOutboundSessionRoute;
};

type BoundConversationRecord = ConversationRecord & {
  sessionId: string;
  sessionKey: string;
};

function hasConversationSessionBinding(
  conversation: ConversationRecord,
): conversation is BoundConversationRecord {
  return Boolean(conversation.sessionId && conversation.sessionKey);
}

const defaultDeps: ConversationTurnDeps = {
  ...defaultConversationDeliveryDeps,
  registerPendingConversationTurn,
  resolveConversation,
  resolveOutboundChannelPlugin,
  bindOutboundSessionEntry,
  resolveOutboundSessionRoute,
};

function resultForCompletedOperation(params: {
  operation: ReturnType<ConversationDeliveryDeps["beginOperation"]>["record"];
}): ConversationTurnResult | undefined {
  const { operation } = params;
  const messageId = operation.platformMessageId ?? operation.preparedMessageId;
  if (operation.status === "replied" && operation.reply && messageId) {
    return {
      status: "replied",
      conversationRef: operation.conversationRef,
      channel: operation.channel,
      messageId,
      correlationPersisted: true,
      reply: {
        conversationRef: operation.conversationRef,
        messageId: operation.reply.messageId,
        ...(operation.reply.replyToId ? { replyToId: operation.reply.replyToId } : {}),
        ...(operation.reply.threadId ? { threadId: operation.reply.threadId } : {}),
        text: operation.reply.text,
        timestamp: operation.reply.timestamp,
      },
    };
  }
  if (operation.status === "created") {
    return undefined;
  }
  const base = {
    conversationRef: operation.conversationRef,
    channel: operation.channel,
    ...(messageId ? { messageId } : {}),
  };
  switch (operation.status) {
    case "sent":
      return {
        ...base,
        status: "sent",
        correlationPersisted: true,
        error: "Message was already sent; no process-local reply waiter remains.",
      };
    case "queued":
      return {
        ...base,
        status: "queued",
        correlationPersisted: true,
        error: "Delivery is queued; a later reply will start an ordinary inbound turn.",
      };
    case "suppressed":
      return {
        ...base,
        status: "suppressed",
        correlationPersisted: false,
        error: "Delivery was suppressed before a message was sent.",
      };
    case "rejected":
      throw new ConversationInputError(
        operation.rejectionError ?? "Conversation delivery was permanently rejected",
      );
    case "unknown":
      return {
        ...base,
        status: "unknown",
        correlationPersisted: false,
        error: "Delivery could not be confirmed and will not be retried automatically.",
      };
    case "replied":
      return {
        ...base,
        status: "sent",
        correlationPersisted: true,
        error: "A reply was recorded, but its durable reply payload is incomplete.",
      };
  }
  return operation.status satisfies never;
}

function prepareConversationMessageId(params: {
  plugin: ReturnType<typeof resolveOutboundChannelPlugin>;
  config: OpenClawConfig;
  conversation: ConversationRecord;
  message: string;
}): string {
  const prepare = params.plugin?.outbound?.prepareConversationTurnMessageId;
  if (!prepare) {
    throw new ConversationInputError(
      `Channel ${params.conversation.channel} does not support correlated conversation turns; use conversations_send`,
    );
  }
  let preparedMessageId: string;
  try {
    preparedMessageId = prepare({
      cfg: params.config,
      to: params.conversation.target,
      text: params.message,
      accountId: params.conversation.accountId,
      threadId: params.conversation.threadId,
    }).trim();
  } catch (error) {
    throw new ConversationInputError(error instanceof Error ? error.message : String(error));
  }
  if (!preparedMessageId) {
    throw new ConversationInputError(
      `Channel ${params.conversation.channel} prepared an empty conversation-turn message id`,
    );
  }
  return preparedMessageId;
}

async function ensureConversationContextBinding(params: {
  deps: ConversationTurnDeps;
  scope: ConversationRegistryScope;
  config: OpenClawConfig;
  agentId: string;
  sourceSessionKey?: string;
  conversation: ConversationRecord;
  plugin: ReturnType<typeof resolveOutboundChannelPlugin>;
  expectedRouteFingerprint: string;
  readCurrentConfig: () => OpenClawConfig;
}): Promise<BoundConversationRecord> {
  if (hasConversationSessionBinding(params.conversation)) {
    return params.conversation;
  }
  const channel = (params.plugin?.id ?? params.conversation.channel) as ChannelId;
  const route = await params.deps.resolveOutboundSessionRoute({
    cfg: params.config,
    channel,
    ...(params.plugin ? { plugin: params.plugin } : {}),
    agentId: params.agentId,
    accountId: params.conversation.accountId,
    target: params.conversation.target,
    ...(params.conversation.threadId ? { threadId: params.conversation.threadId } : {}),
  });
  if (!route) {
    throw new ConversationInputError(
      `Conversation ${params.conversation.conversationRef} no longer resolves to a channel route`,
    );
  }
  await params.deps.bindOutboundSessionEntry({
    cfg: params.config,
    channel,
    accountId: params.conversation.accountId,
    route,
    sourceSessionKey: params.sourceSessionKey,
    // Route resolution can await plugin work; replay authority at the exact
    // session-binding commit so a concurrent config change cannot persist it.
    assertCommitAllowed: () => {
      assertConversationDeliveryAttemptAuthorized({
        config: params.readCurrentConfig(),
        agentId: params.agentId,
        conversationRef: params.conversation.conversationRef,
        expectedRouteFingerprint: params.expectedRouteFingerprint,
        scope: params.scope,
        resolveConversation: params.deps.resolveConversation,
      });
    },
  });
  const bound = params.deps.resolveConversation(params.scope, params.conversation.conversationRef);
  if (!bound || !hasConversationSessionBinding(bound)) {
    throw new Error(
      `Conversation ${params.conversation.conversationRef} could not create its local context binding`,
    );
  }
  return bound;
}

/** Owns correlation, delivery, and waiting inside the Gateway process that receives ingress. */
export async function runGatewayConversationTurn(
  params: {
    config: OpenClawConfig;
    readCurrentConfig?: () => OpenClawConfig;
    agentId: string;
    senderIsOwner: boolean;
    sourceSessionKey?: string;
    turnId: string;
    conversationRef: string;
    message: string;
    timeoutMs: number;
  },
  deps: ConversationTurnDeps = defaultDeps,
): Promise<ConversationTurnResult> {
  const scope = resolveConversationRegistryScope(params);
  const prior = deps.getOperation(scope, params.turnId);
  let begun: ReturnType<ConversationDeliveryDeps["beginOperation"]> | undefined;
  try {
    if (prior) {
      begun = deps.beginOperation(scope, {
        operationId: params.turnId,
        operationKind: "turn",
        conversationRef: params.conversationRef,
        ...(params.sourceSessionKey ? { sourceSessionKey: params.sourceSessionKey } : {}),
        message: params.message,
        ...(prior.preparedMessageId ? { preparedMessageId: prior.preparedMessageId } : {}),
      });
    }
  } catch (error) {
    if (error instanceof ConversationDeliveryInputError) {
      throw new ConversationOperationConflictError(error.message);
    }
    throw error;
  }

  const discoveredConversation = deps.resolveConversation(scope, params.conversationRef);
  if (!discoveredConversation) {
    throw new ConversationInputError(
      `Conversation not found: ${params.conversationRef} (use conversations_list)`,
    );
  }
  const readCurrentConfig = params.readCurrentConfig ?? (() => params.config);
  const currentConfig = readCurrentConfig();
  assertConversationRouteEligibleForAgent({
    config: currentConfig,
    agentId: params.agentId,
    conversation: discoveredConversation,
  });
  const discoveredRouteFingerprint = resolveConversationRouteFingerprint(discoveredConversation);
  if (begun) {
    const completed = resultForCompletedOperation({ operation: begun.record });
    if (completed) {
      return completed;
    }
  }
  const plugin = deps.resolveOutboundChannelPlugin({
    channel: discoveredConversation.channel,
    cfg: currentConfig,
  });
  const candidatePreparedMessageId = begun
    ? begun.record.preparedMessageId
    : prepareConversationMessageId({
        plugin,
        config: currentConfig,
        conversation: discoveredConversation,
        message: params.message,
      });
  if (!candidatePreparedMessageId) {
    throw new ConversationInputError(
      `Conversation turn ${params.turnId} is missing its prepared message id`,
    );
  }
  const conversation = await ensureConversationContextBinding({
    deps,
    scope,
    config: currentConfig,
    agentId: params.agentId,
    sourceSessionKey: params.sourceSessionKey,
    conversation: discoveredConversation,
    plugin,
    expectedRouteFingerprint: discoveredRouteFingerprint,
    readCurrentConfig,
  });
  const authorizedConfig = readCurrentConfig();
  assertConversationRouteEligibleForAgent({
    config: authorizedConfig,
    agentId: params.agentId,
    conversation,
  });
  const routeFingerprint = resolveConversationRouteFingerprint(conversation);
  if (!begun) {
    try {
      begun = deps.beginOperation(scope, {
        operationId: params.turnId,
        operationKind: "turn",
        conversationRef: conversation.conversationRef,
        ...(params.sourceSessionKey ? { sourceSessionKey: params.sourceSessionKey } : {}),
        message: params.message,
        preparedMessageId: candidatePreparedMessageId,
      });
    } catch (error) {
      if (error instanceof ConversationDeliveryInputError) {
        throw new ConversationOperationConflictError(error.message);
      }
      throw error;
    }
    const completed = resultForCompletedOperation({ operation: begun.record });
    if (completed) {
      return completed;
    }
  }
  // Another process may have created the operation after our initial read.
  // Its durable reservation owns correlation; never send with our stale candidate.
  const preparedMessageId = begun.record.preparedMessageId;
  if (!preparedMessageId) {
    throw new ConversationInputError(
      `Conversation turn ${params.turnId} is missing its prepared message id`,
    );
  }

  const pending = deps.registerPendingConversationTurn({
    agentId: params.agentId,
    id: params.turnId,
    conversationRef: conversation.conversationRef,
    sessionId: conversation.sessionId,
    ...(conversation.threadId ? { threadId: conversation.threadId } : {}),
    timeoutMs: params.timeoutMs,
  });
  // Correlation exists before recipient-visible I/O; a fast peer may reply
  // while the transport send promise is still resolving.
  pending.setOutboundMessageId(preparedMessageId);
  try {
    const sent = await sendGatewayConversationMessage({
      deps,
      context: {
        agentId: params.agentId,
        ...(params.sourceSessionKey ? { sourceSessionKey: params.sourceSessionKey } : {}),
        config: authorizedConfig,
        senderIsOwner: params.senderIsOwner,
      },
      conversation,
      message: params.message,
      operationId: pending.id,
      operationKind: "turn",
      operation: begun.record,
      preparedMessageId,
      routeFingerprint,
      onDeliveryAttempt: async () => {
        assertConversationDeliveryAttemptAuthorized({
          config: readCurrentConfig(),
          agentId: params.agentId,
          conversationRef: conversation.conversationRef,
          expectedRouteFingerprint: routeFingerprint,
          expectedSessionId: conversation.sessionId,
          expectedSessionKey: conversation.sessionKey,
          scope,
          resolveConversation: deps.resolveConversation,
        });
      },
    });
    if (sent.deliveryStatus !== "sent") {
      pending.cancel();
      return resultForCompletedOperation({ operation: sent.operation })!;
    }
    const exactMessageId = sent.messageId === preparedMessageId;
    if (!exactMessageId) {
      pending.cancel();
      return {
        status: "sent",
        conversationRef: conversation.conversationRef,
        channel: conversation.channel,
        ...(sent.messageId ? { messageId: sent.messageId } : {}),
        correlationPersisted: true,
        error:
          "Channel delivery did not preserve its prepared message id; reply correlation was disabled.",
      };
    }
    pending.markReady();
    const reply = await pending.wait();
    return reply
      ? {
          status: "replied",
          conversationRef: conversation.conversationRef,
          channel: conversation.channel,
          messageId: preparedMessageId,
          correlationPersisted: true,
          reply,
        }
      : {
          status: "timeout",
          conversationRef: conversation.conversationRef,
          channel: conversation.channel,
          messageId: preparedMessageId,
          correlationPersisted: true,
        };
  } catch (error) {
    pending.cancel();
    if (error instanceof ConversationDeliveryRejectedError) {
      throw new ConversationInputError(error.message);
    }
    throw error;
  }
}
