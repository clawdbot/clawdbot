import { getConversationDeliveryOperation } from "../config/sessions/conversation-delivery-store.js";
import {
  resolveConversation,
  type ConversationRecord,
  type ConversationRegistryScope,
} from "../config/sessions/conversation-registry.js";
import { resolveConversationRouteFingerprint } from "../config/sessions/conversation-route-fingerprint.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { PlatformMessageNotDispatchedError } from "../infra/outbound/deliver-types.js";
import {
  resolveConversationRouteEligibilityForAgent,
  type ConversationRouteCandidate,
} from "../routing/conversation-route-ownership.js";
import { ConversationInputError } from "./conversation-errors.js";

export { resolveConversationRouteEligibilityForAgent };

/** Enforces current route ownership at a Gateway request boundary. */
export function assertConversationRouteEligibleForAgent(params: {
  config: OpenClawConfig;
  agentId: string;
  conversation: ConversationRouteCandidate & Pick<ConversationRecord, "conversationRef">;
}): void {
  const eligibility = resolveConversationRouteEligibilityForAgent(params);
  if (eligibility === "eligible") {
    return;
  }
  if (eligibility === "denied") {
    throw new ConversationInputError(
      `Conversation is not available to this agent: ${params.conversation.conversationRef}`,
    );
  }
  throw new Error(
    `Conversation ownership is temporarily unavailable: ${params.conversation.conversationRef}`,
  );
}

type ResolveConversation = typeof resolveConversation;

export function assertConversationDeliveryAttemptAuthorized(params: {
  config: OpenClawConfig;
  agentId: string;
  conversationRef: string;
  expectedRouteFingerprint: string;
  expectedSessionId?: string;
  expectedSessionKey?: string;
  scope: ConversationRegistryScope;
  resolveConversation?: ResolveConversation;
}): void {
  const conversation = (params.resolveConversation ?? resolveConversation)(
    params.scope,
    params.conversationRef,
  );
  if (
    !conversation ||
    resolveConversationRouteFingerprint(conversation) !== params.expectedRouteFingerprint ||
    (params.expectedSessionId !== undefined &&
      conversation.sessionId !== params.expectedSessionId) ||
    (params.expectedSessionKey !== undefined &&
      conversation.sessionKey !== params.expectedSessionKey)
  ) {
    throw new PlatformMessageNotDispatchedError(
      `Conversation is no longer available to this agent: ${params.conversationRef}`,
      { cause: undefined, retryable: false },
    );
  }
  const eligibility = resolveConversationRouteEligibilityForAgent({
    config: params.config,
    agentId: params.agentId,
    conversation,
  });
  if (eligibility === "eligible") {
    return;
  }
  throw new PlatformMessageNotDispatchedError(
    eligibility === "unavailable"
      ? `Conversation ownership is temporarily unavailable: ${params.conversationRef}`
      : `Conversation is no longer available to this agent: ${params.conversationRef}`,
    { cause: undefined, retryable: eligibility === "unavailable" },
  );
}

export function assertQueuedConversationDeliveryAttemptAuthorized(params: {
  config: OpenClawConfig;
  agentId: string;
  operationId: string;
  storePath?: string;
  routeFingerprint: string;
}): void {
  const scope = {
    agentId: params.agentId,
    ...(params.storePath ? { storePath: params.storePath } : {}),
  };
  const operation = getConversationDeliveryOperation(scope, params.operationId);
  if (!operation) {
    throw new PlatformMessageNotDispatchedError(
      `Conversation delivery operation no longer exists: ${params.operationId}`,
      { cause: undefined, retryable: false },
    );
  }
  assertConversationDeliveryAttemptAuthorized({
    config: params.config,
    agentId: params.agentId,
    conversationRef: operation.conversationRef,
    expectedRouteFingerprint: params.routeFingerprint,
    scope,
  });
}
