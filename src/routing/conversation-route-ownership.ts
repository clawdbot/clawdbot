import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { AgentSelectionRequiredError } from "../agents/agent-scope-config.js";
import { normalizeChatType } from "../channels/chat-type.js";
import {
  resolveConfiguredBindingRoute,
  resolveRuntimeConversationBindingRoute,
} from "../channels/plugins/binding-routing.js";
import { getLoadedChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import { listRouteBindings } from "../config/bindings.js";
import type { ConversationRecord } from "../config/sessions/conversation-registry.js";
import type { ConversationRouteContext } from "../config/sessions/conversation-route-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getGlobalPluginRegistry } from "../plugins/hook-runner-global.js";
import { normalizeAccountId } from "./account-id.js";
import { normalizeRouteBindingId } from "./binding-scope.js";
import { peerKindMatches } from "./peer-kind-match.js";
import { resolveAgentRoute, type ResolvedAgentRoute } from "./resolve-route.js";
import { normalizeAgentId } from "./session-key.js";

export type ConversationRouteCandidate = Pick<
  ConversationRecord,
  "accountId" | "channel" | "kind" | "parentConversationRef" | "peerId" | "target" | "threadId"
> & {
  nativeChannelId?: string;
  routeContext?: ConversationRouteContext;
  routeContextObserved?: true;
};

export type ConversationRouteEligibility = "eligible" | "denied" | "unavailable";

type ConversationAgentSessionResolution =
  | { kind: "candidate" }
  | { kind: "base"; sessionKey: string }
  | { kind: "exact"; sessionKey: string }
  | { kind: "unknown" };

export type ConversationRouteOwnerResolution =
  | { kind: "agent"; agentId: string; session: ConversationAgentSessionResolution }
  | { kind: "plugin"; pluginId: string }
  | { kind: "denied" }
  | { kind: "unavailable" };

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
): ConversationRouteOwnerResolution | undefined {
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
      return { kind: "denied" };
    }
    if (owner.kind === "unavailable") {
      return owner;
    }
    if (owner.kind === "plugin") {
      return hasActivePluginClaimOwner(owner.pluginId)
        ? { kind: "plugin", pluginId: owner.pluginId }
        : {
            kind: "agent",
            agentId: normalizeAgentId(owner.fallbackAgentId),
            session: { kind: "candidate" },
          };
    }
    const sessionKey = owner.sessionKey?.trim();
    return {
      kind: "agent",
      agentId: normalizeAgentId(owner.agentId),
      session: sessionKey ? { kind: "exact", sessionKey } : { kind: "unknown" },
    };
  } catch (error) {
    if (error instanceof AgentSelectionRequiredError) {
      return { kind: "denied" };
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
}): ConversationRouteOwnerResolution {
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
    return { kind: "plugin", pluginId: runtime.pluginId };
  }
  const hasExactConversationBinding = Boolean(
    runtime.boundSessionKey ?? configured.boundSessionKey,
  );
  const hasSessionScopeOverride =
    params.conversation.kind === "direct"
      ? runtime.route.dmScope !== (params.config.session?.dmScope ?? "main")
      : runtime.route.groupScope !== (params.config.session?.groupScope ?? "per-group");
  return {
    kind: "agent",
    agentId: normalizeAgentId(runtime.route.agentId),
    session: hasExactConversationBinding
      ? { kind: "exact", sessionKey: runtime.route.sessionKey }
      : hasSessionScopeOverride
        ? { kind: "base", sessionKey: runtime.route.sessionKey }
        : { kind: "candidate" },
  };
}

function bindingPeerCouldMatchConversation(
  binding: ReturnType<typeof listRouteBindings>[number],
  conversation: ConversationRouteCandidate,
  hasThreadContext: boolean,
  strictSessionAuthority: boolean,
): boolean {
  // Before routePeer persistence, migration derived peerId from the delivery target, so topic
  // rows may retain their parent chat there. Exact parent identity is unknowable when context
  // was not recorded; the caller must fail closed for any compatible non-direct parent binding.
  const peer = binding.match.peer;
  if (!peer) {
    return true;
  }
  const kind = normalizeChatType(peer.kind);
  const id = normalizeRouteBindingId(peer.id);
  if (!kind || !id) {
    return false;
  }
  if (!peerKindMatches(kind, conversation.kind)) {
    return false;
  }
  // Detached projection needs the exact target session, so an unrecorded parent
  // could affect it even when that parent stays on the same agent. Gateway
  // eligibility preserves its shipped agent-owner check for unrelated peers.
  return (
    id === "*" ||
    id === conversation.peerId ||
    (strictSessionAuthority && hasThreadContext && kind !== "direct")
  );
}

function hasUnrecordedContextualBinding(params: {
  config: OpenClawConfig;
  conversation: ConversationRouteCandidate;
  resolvedAgentId: string;
  strictSessionAuthority: boolean;
}): boolean {
  const channel = normalizeLowercaseStringOrEmpty(params.conversation.channel);
  const accountId = normalizeAccountId(params.conversation.accountId);
  const hasThreadContext = Boolean(
    params.conversation.parentConversationRef || params.conversation.threadId,
  );
  const hasGuildContext = params.conversation.kind === "channel";
  return listRouteBindings(params.config).some((binding) => {
    const pattern = binding.match.accountId?.trim() ?? "";
    const peerKind = normalizeChatType(binding.match.peer?.kind);
    const peerId = normalizeRouteBindingId(binding.match.peer?.id);
    const hasNonPeerContext = Boolean(
      (hasGuildContext && normalizeRouteBindingId(binding.match.guildId)) ||
      normalizeRouteBindingId(binding.match.teamId) ||
      (hasGuildContext && binding.match.roles?.length),
    );
    const retainedPeerAlreadyResolved = Boolean(
      hasThreadContext &&
      !hasNonPeerContext &&
      peerKind &&
      peerKind !== "direct" &&
      peerKindMatches(peerKind, params.conversation.kind) &&
      (peerId === "*" || peerId === params.conversation.peerId) &&
      normalizeAgentId(binding.agentId) === params.resolvedAgentId,
    );
    if (retainedPeerAlreadyResolved) {
      return false;
    }
    const contextualScope = Boolean(
      hasNonPeerContext ||
      (hasThreadContext &&
        binding.match.peer?.kind !== "direct" &&
        normalizeRouteBindingId(binding.match.peer?.id)),
    );
    return (
      contextualScope &&
      (params.strictSessionAuthority ||
        normalizeAgentId(binding.agentId) !== params.resolvedAgentId) &&
      normalizeLowercaseStringOrEmpty(binding.match.channel) === channel &&
      (pattern === "*" || normalizeAccountId(pattern) === accountId) &&
      bindingPeerCouldMatchConversation(
        binding,
        params.conversation,
        hasThreadContext,
        params.strictSessionAuthority,
      )
    );
  });
}

function resolveConversationRouteOwnerBase(params: {
  config: OpenClawConfig;
  conversation: ConversationRouteCandidate;
}): ConversationRouteOwnerResolution {
  return (
    resolvePluginRouteOwner(params.config, params.conversation) ??
    (() => {
      const route = resolveConfiguredRouteOwner(
        params.config,
        params.conversation,
        params.conversation.routeContext,
      );
      return route
        ? resolveGenericRouteOwner({
            config: params.config,
            conversation: params.conversation,
            route,
            ...(params.conversation.routeContext
              ? { context: params.conversation.routeContext }
              : {}),
          })
        : { kind: "denied" as const };
    })()
  );
}

/** Resolves exact current agent/session authority for a detached conversation projection. */
export function resolveConversationRouteOwner(params: {
  config: OpenClawConfig;
  conversation: ConversationRouteCandidate;
}): ConversationRouteOwnerResolution {
  const owner = resolveConversationRouteOwnerBase(params);
  const hasObservedContext = Boolean(
    params.conversation.routeContextObserved || params.conversation.routeContext,
  );
  if (
    owner.kind === "agent" &&
    !hasObservedContext &&
    hasUnrecordedContextualBinding({
      config: params.config,
      conversation: params.conversation,
      resolvedAgentId: owner.agentId,
      strictSessionAuthority: true,
    })
  ) {
    return { kind: "denied" };
  }
  return owner;
}

/** Replays current configured and plugin-owned routing for a persisted conversation address. */
export function resolveConversationRouteEligibilityForAgent(params: {
  config: OpenClawConfig;
  agentId: string;
  conversation: ConversationRouteCandidate;
}): ConversationRouteEligibility {
  const owner = resolveConversationRouteOwnerBase(params);
  if (owner.kind === "unavailable") {
    return "unavailable";
  }
  if (owner.kind !== "agent" || owner.agentId !== normalizeAgentId(params.agentId)) {
    return "denied";
  }
  const hasObservedContext = Boolean(
    params.conversation.routeContextObserved || params.conversation.routeContext,
  );
  return !hasObservedContext &&
    hasUnrecordedContextualBinding({
      config: params.config,
      conversation: params.conversation,
      resolvedAgentId: owner.agentId,
      strictSessionAuthority: false,
    })
    ? "denied"
    : "eligible";
}
