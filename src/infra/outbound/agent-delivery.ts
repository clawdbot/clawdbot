// Agent delivery planning resolves final reply destinations from explicit
// options, session history, turn source, bindings, and channel route hooks.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import type {
  ChannelId,
  ChannelOutboundTargetMode,
  ChannelPlugin,
} from "../../channels/plugins/types.public.js";
import { listRouteBindings } from "../../config/bindings.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeOptionalAccountId } from "../../routing/account-id.js";
import { normalizeRouteBindingChannelId } from "../../routing/binding-scope.js";
import { buildAgentMainSessionKey, normalizeAgentId } from "../../routing/session-key.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  isGatewayMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import { resolveOutboundChannelPlugin } from "./channel-resolution.js";
import { resolveOutboundSessionRoute } from "./outbound-session.js";
import { resolveChannelTarget, type ResolvedMessagingTarget } from "./target-resolver.js";
import {
  type OutboundTargetResolution,
  resolveOutboundTarget,
  resolveSessionDeliveryTarget,
  type SessionDeliveryTarget,
} from "./targets.js";

type AgentDeliveryPlan = {
  baseDelivery: SessionDeliveryTarget;
  resolvedChannel: string;
  plugin?: ChannelPlugin;
  resolvedTo?: string;
  resolvedAccountId?: string;
  resolvedThreadId?: string | number;
  deliveryTargetMode?: ChannelOutboundTargetMode;
  resolvedSessionKey?: string;
  targetResolutionError?: Error;
};

function resolveAgentDeliveryPlan(params: {
  sessionEntry?: SessionEntry;
  requestedChannel?: string;
  explicitTo?: string;
  explicitThreadId?: string | number;
  accountId?: string;
  wantsDelivery: boolean;
  /**
   * The channel that originated the current agent turn.  When provided,
   * overrides session-level `lastChannel` to prevent cross-channel reply
   * routing in shared sessions (dmScope="main").
   *
   * @see https://github.com/openclaw/openclaw/issues/24152
   */
  turnSourceChannel?: string;
  /** Turn-source `to` — paired with `turnSourceChannel`. */
  turnSourceTo?: string;
  /** Turn-source `accountId` — paired with `turnSourceChannel`. */
  turnSourceAccountId?: string;
  /** Turn-source `threadId` — paired with `turnSourceChannel`. */
  turnSourceThreadId?: string | number;
}): AgentDeliveryPlan {
  const requestedRaw = normalizeOptionalString(params.requestedChannel) ?? "";
  const normalizedRequested = requestedRaw ? normalizeMessageChannel(requestedRaw) : undefined;
  const requestedChannel = normalizedRequested || "last";

  const explicitTo = normalizeOptionalString(params.explicitTo) ?? undefined;

  // Resolve turn-source channel for cross-channel safety.
  const normalizedTurnSource = params.turnSourceChannel
    ? normalizeMessageChannel(params.turnSourceChannel)
    : undefined;
  const turnSourceChannel =
    normalizedTurnSource && isDeliverableMessageChannel(normalizedTurnSource)
      ? normalizedTurnSource
      : undefined;
  const turnSourceTo = normalizeOptionalString(params.turnSourceTo) ?? undefined;
  const turnSourceAccountId = normalizeOptionalAccountId(params.turnSourceAccountId);
  const turnSourceThreadId =
    params.turnSourceThreadId != null && params.turnSourceThreadId !== ""
      ? params.turnSourceThreadId
      : undefined;

  const baseDelivery = resolveSessionDeliveryTarget({
    entry: params.sessionEntry,
    requestedChannel: requestedChannel === INTERNAL_MESSAGE_CHANNEL ? "last" : requestedChannel,
    explicitTo,
    explicitThreadId: params.explicitThreadId,
    turnSourceChannel,
    turnSourceTo,
    turnSourceAccountId,
    turnSourceThreadId,
  });

  const resolvedChannel = (() => {
    if (requestedChannel === INTERNAL_MESSAGE_CHANNEL) {
      return INTERNAL_MESSAGE_CHANNEL;
    }
    if (requestedChannel === "last") {
      if (baseDelivery.channel && baseDelivery.channel !== INTERNAL_MESSAGE_CHANNEL) {
        return baseDelivery.channel;
      }
      return INTERNAL_MESSAGE_CHANNEL;
    }

    if (isGatewayMessageChannel(requestedChannel)) {
      return requestedChannel;
    }

    if (baseDelivery.channel && baseDelivery.channel !== INTERNAL_MESSAGE_CHANNEL) {
      return baseDelivery.channel;
    }
    return INTERNAL_MESSAGE_CHANNEL;
  })();

  const deliveryTargetMode = explicitTo
    ? "explicit"
    : isDeliverableMessageChannel(resolvedChannel)
      ? "implicit"
      : undefined;

  const resolvedAccountId =
    normalizeOptionalAccountId(params.accountId) ??
    (deliveryTargetMode === "implicit" ? baseDelivery.accountId : undefined);

  let resolvedTo = explicitTo;
  if (
    !resolvedTo &&
    isDeliverableMessageChannel(resolvedChannel) &&
    resolvedChannel === baseDelivery.lastChannel
  ) {
    resolvedTo = baseDelivery.lastTo;
  }

  return {
    baseDelivery,
    resolvedChannel,
    resolvedTo,
    resolvedAccountId,
    resolvedThreadId: baseDelivery.threadId,
    deliveryTargetMode,
  };
}

export async function resolveAgentDeliveryPlanWithSessionRoute(
  params: Parameters<typeof resolveAgentDeliveryPlan>[0] & {
    cfg: OpenClawConfig;
    agentId: string;
    currentSessionKey?: string;
    sessionRouteMode?: "plugin-only" | "allow-fallback";
    /** Channel plugin already selected and bootstrapped by the caller. */
    preparedPlugin?: ChannelPlugin;
  },
): Promise<AgentDeliveryPlan> {
  const plan = resolveAgentDeliveryPlan(params);
  const { resolvedChannel } = plan;
  if (!params.wantsDelivery || !isDeliverableMessageChannel(resolvedChannel)) {
    return plan;
  }
  const plugin =
    params.preparedPlugin ??
    resolveOutboundChannelPlugin({
      channel: resolvedChannel,
      cfg: params.cfg,
      agentId: params.agentId,
      allowBootstrap: true,
    });
  if (!plugin) {
    return plan;
  }
  const pluginPlan = { ...plan, plugin };
  const hasPluginSessionRoute = Boolean(plugin?.messaging?.resolveOutboundSessionRoute);
  const hasPluginTargetResolver = Boolean(plugin?.messaging?.targetResolver);
  // Only concrete plugin resolution makes a directory miss authoritative.
  // Heuristic-only resolvers preserve the shipped normalized fallback.
  const hasPluginConcreteTargetResolver = Boolean(plugin?.messaging?.targetResolver?.resolveTarget);
  if (
    !hasPluginSessionRoute &&
    !hasPluginTargetResolver &&
    params.sessionRouteMode !== "allow-fallback"
  ) {
    return pluginPlan;
  }
  const resolvedAccountId =
    pluginPlan.resolvedAccountId ??
    (params.sessionRouteMode === "allow-fallback"
      ? resolveChannelDefaultAccountId({ plugin, cfg: params.cfg })
      : undefined);
  const routedPlan =
    resolvedAccountId === pluginPlan.resolvedAccountId
      ? pluginPlan
      : { ...pluginPlan, resolvedAccountId };
  const normalizedTarget = resolveOutboundTarget({
    channel: resolvedChannel,
    plugin,
    to: routedPlan.resolvedTo,
    cfg: params.cfg,
    accountId: routedPlan.resolvedAccountId,
    mode: routedPlan.deliveryTargetMode ?? "explicit",
  });
  const targetInput = normalizedTarget.ok ? normalizedTarget.to : routedPlan.resolvedTo;
  if (!targetInput) {
    return normalizedTarget.ok
      ? routedPlan
      : { ...routedPlan, targetResolutionError: normalizedTarget.error };
  }
  const resolvedTarget = await resolveChannelTarget({
    cfg: params.cfg,
    channel: resolvedChannel as ChannelId,
    input: targetInput,
    accountId: routedPlan.resolvedAccountId,
    unknownTargetMode: hasPluginConcreteTargetResolver ? "error" : "normalized",
    plugin,
  });
  if (!resolvedTarget.ok) {
    return { ...routedPlan, targetResolutionError: resolvedTarget.error };
  }
  // An async normalized fallback cannot erase an earlier synchronous validation error.
  if (!normalizedTarget.ok && resolvedTarget.target.resolutionSource === "normalized") {
    return { ...routedPlan, targetResolutionError: normalizedTarget.error };
  }
  const sessionRouteTarget = resolvedTarget.target.to;
  const resolvedSessionRouteTarget: ResolvedMessagingTarget | undefined =
    !normalizedTarget.ok ||
    normalizedTarget.to !== resolvedTarget.target.to ||
    resolvedTarget.target.resolutionSource === "directory"
      ? resolvedTarget.target
      : undefined;
  const resolvedPlan = { ...routedPlan, resolvedTo: sessionRouteTarget };
  if (!hasPluginSessionRoute && params.sessionRouteMode !== "allow-fallback") {
    return resolvedPlan;
  }
  const explicitThreadId =
    params.explicitThreadId != null && params.explicitThreadId !== ""
      ? params.explicitThreadId
      : undefined;
  const route = await (async () => {
    try {
      return await resolveOutboundSessionRoute({
        cfg: params.cfg,
        channel: resolvedChannel as ChannelId,
        plugin,
        agentId: params.agentId,
        accountId: routedPlan.resolvedAccountId,
        target: sessionRouteTarget,
        ...(resolvedSessionRouteTarget ? { resolvedTarget: resolvedSessionRouteTarget } : {}),
        currentSessionKey: params.currentSessionKey,
        threadId:
          routedPlan.deliveryTargetMode === "explicit"
            ? explicitThreadId
            : resolvedPlan.resolvedThreadId,
      });
    } catch {
      return null;
    }
  })();
  const globalDmScope = params.cfg.session?.dmScope ?? "main";
  const knownNonExactRoute =
    params.sessionRouteMode === "allow-fallback" &&
    (route?.recipientSessionExact === false || route?.recipientSessionExact === "direct-alias");
  // A best-effort alias is safe only when every direct recipient on this channel
  // shares the selected agent's main session; binding overrides can isolate peers.
  const canonicalMainSessionKey = buildAgentMainSessionKey({
    agentId: params.agentId,
    mainKey: params.cfg.session?.mainKey,
  });
  const usesCanonicalMainSession =
    route?.recipientSessionExact === "direct-alias" &&
    route.chatType === "direct" &&
    route.sessionKey === route.baseSessionKey &&
    route.sessionKey === canonicalMainSessionKey &&
    globalDmScope === "main" &&
    !listRouteBindings(params.cfg).some(
      (binding) =>
        binding.session?.dmScope !== undefined &&
        binding.session.dmScope !== "main" &&
        normalizeRouteBindingChannelId(binding.match.channel) === resolvedChannel,
    );
  // Stable outbound-only identities may resume each other, but never the shared
  // agent main session. Omitted markers retain the external plugin contract.
  const usesIsolatedDeliveryIdentity =
    route?.recipientSessionExact === "delivery-identity" &&
    route.baseSessionKey !== canonicalMainSessionKey &&
    route.baseSessionKey.startsWith(
      `agent:${normalizeAgentId(params.agentId)}:${resolvedChannel}:`,
    ) &&
    (route.sessionKey === route.baseSessionKey ||
      route.sessionKey.startsWith(`${route.baseSessionKey}:`));
  const selectedRoute =
    route &&
    (route.recipientSessionExact === "delivery-identity"
      ? usesIsolatedDeliveryIdentity
      : !knownNonExactRoute || usesCanonicalMainSession)
      ? route
      : null;
  if (!selectedRoute) {
    if (resolvedSessionRouteTarget) {
      return {
        ...resolvedPlan,
        resolvedTo: resolvedSessionRouteTarget.to,
        resolvedThreadId:
          resolvedPlan.deliveryTargetMode === "explicit"
            ? explicitThreadId
            : resolvedPlan.resolvedThreadId,
      };
    }
    return resolvedPlan;
  }
  return {
    ...resolvedPlan,
    resolvedSessionKey: selectedRoute.sessionKey,
    // Generic routes use portable user/channel prefixes. Delivery still needs the
    // plugin-normalized target; only provider-owned route hooks may replace it.
    resolvedTo: hasPluginSessionRoute
      ? selectedRoute.to
      : (resolvedSessionRouteTarget?.to ?? sessionRouteTarget),
    resolvedThreadId:
      selectedRoute.threadId ??
      (resolvedPlan.deliveryTargetMode === "explicit"
        ? explicitThreadId
        : resolvedPlan.resolvedThreadId),
  };
}

/** Resolves an explicit recipient into its canonical or stable provider-owned session. */
export async function resolveAgentExplicitRecipientSession(params: {
  cfg: OpenClawConfig;
  agentId: string;
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
}): Promise<{
  sessionKey?: string;
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
  error?: Error;
}> {
  const plan = await resolveAgentDeliveryPlanWithSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    requestedChannel: params.channel,
    explicitTo: params.to,
    explicitThreadId: params.threadId,
    accountId: params.accountId,
    wantsDelivery: true,
    sessionRouteMode: "allow-fallback",
  });
  if (!plan.resolvedSessionKey && !plan.targetResolutionError) {
    return {
      error: new Error(`Unable to resolve a session route for channel "${params.channel}"`),
    };
  }
  return {
    sessionKey: plan.resolvedSessionKey,
    channel: plan.resolvedChannel,
    to: plan.resolvedTo,
    accountId: plan.resolvedAccountId,
    threadId: plan.resolvedThreadId,
    error: plan.targetResolutionError,
  };
}

export function resolveAgentOutboundTarget(params: {
  cfg: OpenClawConfig;
  plan: AgentDeliveryPlan;
  targetMode?: ChannelOutboundTargetMode;
  validateExplicitTarget?: boolean;
}): {
  resolvedTarget: OutboundTargetResolution | null;
  resolvedTo?: string;
  targetMode: ChannelOutboundTargetMode;
} {
  const targetMode =
    params.targetMode ??
    params.plan.deliveryTargetMode ??
    (params.plan.resolvedTo ? "explicit" : "implicit");
  if (params.plan.targetResolutionError) {
    return {
      resolvedTarget: { ok: false, error: params.plan.targetResolutionError },
      resolvedTo: undefined,
      targetMode,
    };
  }
  if (!isDeliverableMessageChannel(params.plan.resolvedChannel)) {
    return {
      resolvedTarget: null,
      resolvedTo: params.plan.resolvedTo,
      targetMode,
    };
  }
  if (params.validateExplicitTarget !== true && params.plan.resolvedTo) {
    return {
      resolvedTarget: null,
      resolvedTo: params.plan.resolvedTo,
      targetMode,
    };
  }
  const resolvedTarget = resolveOutboundTarget({
    channel: params.plan.resolvedChannel,
    ...(params.plan.plugin ? { plugin: params.plan.plugin } : {}),
    to: params.plan.resolvedTo,
    cfg: params.cfg,
    accountId: params.plan.resolvedAccountId,
    mode: targetMode,
  });
  return {
    resolvedTarget,
    resolvedTo: resolvedTarget.ok ? resolvedTarget.to : params.plan.resolvedTo,
    targetMode,
  };
}
