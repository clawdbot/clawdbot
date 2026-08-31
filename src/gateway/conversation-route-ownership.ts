import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { AgentSelectionRequiredError } from "../agents/agent-scope-config.js";
import { normalizeChatType } from "../channels/chat-type.js";
import {
  resolveConfiguredBindingRoute,
  resolveRuntimeConversationBindingRoute,
} from "../channels/plugins/binding-routing.js";
import { getLoadedChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import { listRouteBindings } from "../config/bindings.js";
import { getConversationDeliveryOperation } from "../config/sessions/conversation-delivery-store.js";
import {
  resolveConversation,
  type ConversationRecord,
  type ConversationRegistryScope,
} from "../config/sessions/conversation-registry.js";
import type { ConversationRouteContext } from "../config/sessions/conversation-route-context.js";
import { resolveConversationRouteFingerprint } from "../config/sessions/conversation-route-fingerprint.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { PlatformMessageNotDispatchedError } from "../infra/outbound/deliver-types.js";
import { getGlobalPluginRegistry } from "../plugins/hook-runner-global.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { normalizeRouteBindingId } from "../routing/binding-scope.js";
import { peerKindMatches } from "../routing/peer-kind-match.js";
import { resolveAgentRoute, type ResolvedAgentRoute } from "../routing/resolve-route.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { ConversationInputError } from "./conversation-errors.js";

type ConversationRouteCandidate = Pick<
  ConversationRecord,
  "accountId" | "channel" | "kind" | "parentConversationRef" | "peerId" | "target" | "threadId"
> & {
  nativeChannelId?: string;
  routeContext?: ConversationRouteContext;
  routeContextObserved?: true;
};

type ConversationRouteEligibility = "eligible" | "denied" | "unavailable";

type RouteOwnerResolution = { kind: "available"; agentId?: string } | { kind: "unavailable" };

function hasActivePluginClaimOwner(pluginId: string): boolean {
  return (
    getGlobalPluginRegistry()?.typedHooks.some(
      (hook) => hook.pluginId === pluginId && hook.hookName === "inbound_claim",
    ) === true
  );
}

function resolvePluginRouteOwner(
  config: OpenClawConfig,
  conversation: ConversationRouteCandidate,
): RouteOwnerResolution | undefined {
  const channelId = normalizeChannelId(conversation.channel);
  const resolver = channelId
    ? getLoadedChannelPlugin(channelId)?.messaging?.resolveConversationRouteOwner
    : undefined;
  if (!resolver) {
    return undefined;
  }
  try {
    const owner = resolver({
      cfg: config,
      accountId: normalizeAccountId(conversation.accountId),
      conversation: {
        kind: conversation.kind,
        peerId: conversation.peerId,
        target: conversation.target,
        ...(conversation.threadId ? { threadId: conversation.threadId } : {}),
        ...(conversation.nativeChannelId ? { nativeChannelId: conversation.nativeChannelId } : {}),
        ...(conversation.routeContext ? { context: conversation.routeContext } : {}),
      },
    });
    if (owner === undefined) {
      return undefined;
    }
    if (owner === null) {
      return { kind: "available" };
    }
    if (owner.kind === "unavailable") {
      return owner;
    }
    if (owner.kind === "plugin") {
      return hasActivePluginClaimOwner(owner.pluginId)
        ? { kind: "available" }
        : { kind: "available", agentId: normalizeAgentId(owner.fallbackAgentId) };
    }
    return { kind: "available", agentId: normalizeAgentId(owner.agentId) };
  } catch (error) {
    if (error instanceof AgentSelectionRequiredError) {
      return { kind: "available" };
    }
    throw error;
  }
}

function resolveConfiguredRouteOwner(
  config: OpenClawConfig,
  conversation: ConversationRouteCandidate,
  context?: ConversationRouteContext,
): ResolvedAgentRoute | undefined {
  try {
    return resolveAgentRoute({
      cfg: config,
      channel: conversation.channel,
      accountId: conversation.accountId,
      peer: { kind: conversation.kind, id: conversation.peerId },
      ...(context?.parentPeerId && conversation.kind !== "direct"
        ? { parentPeer: { kind: conversation.kind, id: context.parentPeerId } }
        : {}),
      ...(context?.guildId ? { guildId: context.guildId } : {}),
      ...(context?.teamId ? { teamId: context.teamId } : {}),
      ...(context?.memberRoleIds ? { memberRoleIds: context.memberRoleIds } : {}),
    });
  } catch (error) {
    if (error instanceof AgentSelectionRequiredError) {
      return undefined;
    }
    throw error;
  }
}

function resolveGenericRouteOwner(params: {
  config: OpenClawConfig;
  conversation: ConversationRouteCandidate;
  route: ResolvedAgentRoute;
  context?: ConversationRouteContext;
}): RouteOwnerResolution {
  const conversation = {
    channel: params.conversation.channel,
    accountId: normalizeAccountId(params.conversation.accountId),
    conversationId: params.conversation.peerId,
    ...(params.context?.parentPeerId ? { parentConversationId: params.context.parentPeerId } : {}),
  };
  // Generic ingress applies configured ACP routing before runtime bindings. Discord and Slack
  // have different precedence and bypass this path through their channel-owned resolvers.
  const configured = resolveConfiguredBindingRoute({
    cfg: params.config,
    route: params.route,
    conversation,
  });
  const runtime = resolveRuntimeConversationBindingRoute({
    route: configured.route,
    conversation,
    touchBinding: false,
  });
  if (runtime.bindingOwnerAvailable === false) {
    return { kind: "unavailable" };
  }
  if (runtime.pluginId && hasActivePluginClaimOwner(runtime.pluginId)) {
    return { kind: "available" };
  }
  return { kind: "available", agentId: normalizeAgentId(runtime.route.agentId) };
}

function bindingPeerCouldMatchConversation(
  binding: ReturnType<typeof listRouteBindings>[number],
  conversation: ConversationRouteCandidate,
): boolean {
  // Before routePeer persistence, migration derived peerId from the delivery target, so topic
  // rows retain their parent chat there. Current child peers always carry observed parent context.
  // Treating every same-kind peer as a possible parent would let unrelated bindings deny valid routes.
  const peer = binding.match.peer;
  if (!peer) {
    return true;
  }
  const kind = normalizeChatType(peer.kind);
  const id = normalizeRouteBindingId(peer.id);
  if (!kind || !id) {
    return false;
  }
  return peerKindMatches(kind, conversation.kind) && (id === "*" || id === conversation.peerId);
}

function hasUnrecordedContextualBinding(params: {
  config: OpenClawConfig;
  conversation: ConversationRouteCandidate;
  resolvedAgentId: string;
}): boolean {
  const channel = normalizeLowercaseStringOrEmpty(params.conversation.channel);
  const accountId = normalizeAccountId(params.conversation.accountId);
  const hasThreadContext = Boolean(
    params.conversation.parentConversationRef || params.conversation.threadId,
  );
  const hasGuildContext = params.conversation.kind === "channel";
  return listRouteBindings(params.config).some((binding) => {
    const pattern = binding.match.accountId?.trim() ?? "";
    const contextualScope = Boolean(
      (hasGuildContext && normalizeRouteBindingId(binding.match.guildId)) ||
      normalizeRouteBindingId(binding.match.teamId) ||
      (hasGuildContext && binding.match.roles?.length) ||
      (hasThreadContext &&
        binding.match.peer?.kind !== "direct" &&
        normalizeRouteBindingId(binding.match.peer?.id)),
    );
    return (
      contextualScope &&
      normalizeAgentId(binding.agentId) !== params.resolvedAgentId &&
      normalizeLowercaseStringOrEmpty(binding.match.channel) === channel &&
      (pattern === "*" || normalizeAccountId(pattern) === accountId) &&
      bindingPeerCouldMatchConversation(binding, params.conversation)
    );
  });
}

/** Replays current configured and plugin-owned routing for a persisted conversation address. */
export function resolveConversationRouteEligibilityForAgent(params: {
  config: OpenClawConfig;
  agentId: string;
  conversation: ConversationRouteCandidate;
}): ConversationRouteEligibility {
  const requestedAgentId = normalizeAgentId(params.agentId);
  const hasObservedContext = Boolean(
    params.conversation.routeContextObserved || params.conversation.routeContext,
  );
  const pluginOwner = resolvePluginRouteOwner(params.config, params.conversation);
  if (pluginOwner) {
    if (pluginOwner.kind === "unavailable") {
      return "unavailable";
    }
    return pluginOwner.agentId === requestedAgentId &&
      !(
        !hasObservedContext &&
        pluginOwner.agentId &&
        hasUnrecordedContextualBinding({
          config: params.config,
          conversation: params.conversation,
          resolvedAgentId: pluginOwner.agentId,
        })
      )
      ? "eligible"
      : "denied";
  }

  const route = resolveConfiguredRouteOwner(
    params.config,
    params.conversation,
    params.conversation.routeContext,
  );
  if (!route) {
    return "denied";
  }
  const owner = resolveGenericRouteOwner({
    config: params.config,
    conversation: params.conversation,
    route,
    ...(params.conversation.routeContext ? { context: params.conversation.routeContext } : {}),
  });
  if (owner.kind === "unavailable") {
    return "unavailable";
  }
  if (owner.agentId !== requestedAgentId) {
    return "denied";
  }
  return !hasObservedContext &&
    hasUnrecordedContextualBinding({
      config: params.config,
      conversation: params.conversation,
      resolvedAgentId: owner.agentId,
    })
    ? "denied"
    : "eligible";
}

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
