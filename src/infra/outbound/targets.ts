import { expectDefined } from "@openclaw/normalization-core";
// Outbound target helpers resolve direct send targets, heartbeat destinations,
// sender context, and session-route aware heartbeat refinements.
import { mapAllowFromEntries } from "openclaw/plugin-sdk/channel-config-helpers";
import { normalizeChatType, type ChatType } from "../../channels/chat-type.js";
import { listChannelPlugins } from "../../channels/plugins/index.js";
import type { ChannelOutboundTargetMode } from "../../channels/plugins/types.core.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import {
  deliveryContextFromSession,
  mergeDeliveryContext,
} from "../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
} from "../../utils/message-channel.js";
import {
  normalizeDeliverableOutboundChannel,
  resolveOutboundChannelPlugin,
} from "./channel-resolution.js";
import {
  resolveTargetPrefixedChannel,
  stripTargetProviderPrefix,
} from "./channel-target-prefix.js";
import { isPotentialConfiguredMessageChannel } from "./message-account-selection.js";
import { resolveOutboundSessionRoute } from "./outbound-session.js";
import { isReservedTargetLiteralError } from "./target-errors.js";
import { resolveChannelTarget, type ResolvedMessagingTarget } from "./target-resolver.js";
import {
  resolveOutboundTargetWithPlugin,
  type OutboundTargetResolution,
} from "./targets-resolve-shared.js";
import { resolveSessionDeliveryTarget, type SessionDeliveryTarget } from "./targets-session.js";

/** Resolved outbound delivery destination and routing hints. */
type OutboundTarget = {
  channel: string;
  to?: string;
  targetSessionKey?: string;
  chatType?: ChatType;
  reason?: string;
  accountId?: string;
  threadId?: string | number;
  lastChannel?: string;
  lastAccountId?: string;
  implicitDefaultRoute?: true;
};

/** Sender identity context used when a heartbeat needs channel-compatible metadata. */
type HeartbeatSenderContext = {
  sender: string;
  provider?: string;
  allowFrom: string[];
};

export type { OutboundTargetResolution } from "./targets-resolve-shared.js";
export { resolveSessionDeliveryTarget, type SessionDeliveryTarget } from "./targets-session.js";

/** Resolves a user-supplied outbound destination through the channel plugin. */
export function resolveOutboundTarget(params: {
  channel: string;
  plugin?: ChannelPlugin;
  to?: string;
  allowFrom?: string[];
  allowBootstrap?: boolean;
  cfg?: OpenClawConfig;
  accountId?: string | null;
  mode?: ChannelOutboundTargetMode;
}): OutboundTargetResolution {
  return (
    resolveOutboundTargetWithPlugin({
      plugin:
        params.plugin ??
        resolveOutboundChannelPlugin({
          channel: params.channel,
          cfg: params.cfg,
          allowBootstrap: params.allowBootstrap,
        }),
      target: params,
      onMissingPlugin: () =>
        params.channel === INTERNAL_MESSAGE_CHANNEL
          ? undefined
          : {
              ok: false,
              error: new Error(`Unsupported channel: ${params.channel}`),
            },
    }) ?? {
      ok: false,
      error: new Error(`Unsupported channel: ${params.channel}`),
    }
  );
}

function concreteAllowFromEntries(entries: Array<string | number> | null | undefined): string[] {
  return mapAllowFromEntries(entries)
    .map((entry) => entry.trim())
    .filter((entry) => entry && entry !== "*" && !entry.endsWith(":*"));
}

function ownerIdMatchesRoute(plugin: ChannelPlugin, ownerId: string, routeTo: string): boolean {
  const normalize = (value: string) => {
    const prefixedChannel = resolveTargetPrefixedChannel(value);
    return prefixedChannel === plugin.id
      ? stripTargetProviderPrefix(value, plugin.id, ...(plugin.messaging?.targetPrefixes ?? []))
      : value.trim();
  };
  return normalize(ownerId) === normalize(routeTo);
}

function resolveHeartbeatOwnerRoute(params: {
  cfg: OpenClawConfig;
  entry?: SessionEntry;
  heartbeat?: AgentDefaultsConfig["heartbeat"];
}): { plugin: ChannelPlugin; ownerId: string; reuseSessionRoute: boolean } | undefined {
  const session = deliveryContextFromSession(params.entry);
  const plugins: ChannelPlugin[] = [];
  const seen = new Set<string>();
  const add = (plugin: ChannelPlugin | undefined) => {
    if (plugin && isDeliverableMessageChannel(plugin.id) && !seen.has(plugin.id)) {
      seen.add(plugin.id);
      plugins.push(plugin);
    }
  };
  if (session?.channel) {
    add(resolveOutboundChannelPlugin({ channel: session.channel, cfg: params.cfg }));
  }
  for (const plugin of listChannelPlugins()) {
    if (isPotentialConfiguredMessageChannel({ cfg: params.cfg, plugin })) {
      add(plugin);
    }
  }

  const buildRoute = (plugin: ChannelPlugin, ownerId: string) => ({
    plugin,
    ownerId,
    reuseSessionRoute:
      session?.channel === plugin.id &&
      Boolean(session.to) &&
      normalizeChatType(params.entry?.chatType) === "direct" &&
      ownerIdMatchesRoute(plugin, ownerId, session.to ?? ""),
  });

  // commands.ownerAllowFrom is the documented higher-priority owner identity:
  // exhaust it across every eligible channel before any channel-local
  // allowFrom fallback, or a session channel's fallback shadows a prefixed
  // configured owner on a later channel.
  const configuredOwners = concreteAllowFromEntries(params.cfg.commands?.ownerAllowFrom);
  for (const plugin of plugins) {
    const configuredOwner = configuredOwners.find((ownerId) => {
      const prefixedChannel = resolveTargetPrefixedChannel(ownerId);
      return (
        (!prefixedChannel || prefixedChannel === plugin.id) &&
        isPositivelyDirectHeartbeatOwnerTarget({ plugin, to: ownerId })
      );
    });
    if (configuredOwner) {
      return buildRoute(plugin, configuredOwner);
    }
  }
  for (const plugin of plugins) {
    const ownerId = concreteAllowFromEntries(
      plugin.config.resolveAllowFrom?.({
        cfg: params.cfg,
        accountId:
          params.heartbeat?.accountId ??
          (session?.channel === plugin.id ? session.accountId : undefined),
      }),
    )[0];
    if (ownerId) {
      return buildRoute(plugin, ownerId);
    }
  }
  return undefined;
}

/** Read-only owner-route probe for status/doctor surfaces. Unproven targets fail closed. */
export function hasResolvableHeartbeatOwnerRoute(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  entry?: SessionEntry;
  heartbeat?: AgentDefaultsConfig["heartbeat"];
}): boolean {
  const delivery = resolveHeartbeatDeliveryTarget({
    ...params,
    heartbeat: { ...params.heartbeat, target: "owner" },
  });
  return delivery.channel !== "none" && Boolean(delivery.to);
}

/**
 * Resolves heartbeat delivery. Owner/unset ignores `to`; only explicit channels consume it.
 */
export function resolveHeartbeatDeliveryTarget(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  entry?: SessionEntry;
  heartbeat?: AgentDefaultsConfig["heartbeat"];
  turnSource?: DeliveryContext;
}): OutboundTarget {
  const { cfg, entry } = params;
  const heartbeat = params.heartbeat ?? cfg.agents?.defaults?.heartbeat;
  const rawTarget = heartbeat?.target;
  const implicitDefaultRoute = rawTarget === undefined;
  let target = implicitDefaultRoute ? "owner" : "none";
  let preparedExplicitPlugin: ChannelPlugin | undefined;
  let preparedExplicitTo: string | undefined;
  if (rawTarget === "none" || rawTarget === "last" || rawTarget === "owner") {
    target = rawTarget;
  } else if (typeof rawTarget === "string") {
    const normalized = normalizeDeliverableOutboundChannel(rawTarget);
    if (normalized) {
      target = normalized;
    } else {
      const explicitTo = heartbeat?.to?.trim();
      if (explicitTo) {
        preparedExplicitPlugin = resolveOutboundChannelPlugin({
          channel: rawTarget,
          cfg,
          agentId: params.agentId,
          allowBootstrap: true,
        });
        if (preparedExplicitPlugin) {
          target = preparedExplicitPlugin.id;
          preparedExplicitTo = explicitTo;
        }
      }
    }
  }

  if (target === "none") {
    const base = resolveSessionDeliveryTarget({ entry });
    return buildNoHeartbeatDeliveryTarget({
      reason: "target-none",
      lastChannel: base.lastChannel,
      lastAccountId: base.lastAccountId,
    });
  }

  const ownerMode = target === "owner";
  const ownerTurnSource = ownerMode && hasDeliverableHeartbeatTurnSource(params.turnSource);
  const resolvedTurnSource =
    target === "last" || ownerTurnSource
      ? mergeDeliveryContext(params.turnSource, deliveryContextFromSession(entry))
      : undefined;
  const ownerRoute =
    ownerMode && !ownerTurnSource
      ? resolveHeartbeatOwnerRoute({ cfg, entry, heartbeat })
      : undefined;
  if (ownerMode && !ownerTurnSource && !ownerRoute) {
    const base = resolveSessionDeliveryTarget({ entry });
    return buildNoHeartbeatDeliveryTarget({
      reason: "no-route",
      lastChannel: base.lastChannel,
      lastAccountId: base.lastAccountId,
    });
  }
  const ownerSession = ownerRoute?.reuseSessionRoute
    ? deliveryContextFromSession(entry)
    : undefined;

  const resolvedTarget =
    preparedExplicitPlugin && preparedExplicitTo
      ? resolveSessionDeliveryTarget({
          entry,
          requestedChannel: target,
          explicitTo: preparedExplicitTo,
          mode: "heartbeat",
        })
      : ownerRoute
        ? resolveSessionDeliveryTarget({
            entry,
            requestedChannel: ownerRoute.plugin.id,
            explicitTo: ownerSession?.to ?? ownerRoute.ownerId,
            explicitThreadId: ownerSession?.threadId,
            mode: "heartbeat",
          })
        : resolveSessionDeliveryTarget({
            entry,
            requestedChannel: target === "last" || ownerTurnSource ? "last" : target,
            explicitTo: ownerMode ? undefined : heartbeat?.to,
            mode: "heartbeat",
            turnSourceChannel:
              resolvedTurnSource?.channel && isDeliverableMessageChannel(resolvedTurnSource.channel)
                ? resolvedTurnSource.channel
                : undefined,
            turnSourceTo: resolvedTurnSource?.to,
            turnSourceAccountId: resolvedTurnSource?.accountId,
            // Explicit wake origins own their thread. Session-only threads stay dropped;
            // reusing one could post a later heartbeat into a stale conversation.
            turnSourceThreadId: params.turnSource?.threadId,
          });

  const heartbeatAccountId = ownerTurnSource ? undefined : heartbeat?.accountId?.trim();
  // Use explicit accountId from heartbeat config if provided, otherwise fall back to session
  let effectiveAccountId = heartbeatAccountId || resolvedTarget.accountId;

  if (!resolvedTarget.channel || !resolvedTarget.to) {
    return buildNoHeartbeatDeliveryTarget({
      reason: target === "last" || ownerMode ? "no-route" : "no-target",
      accountId: effectiveAccountId,
      lastChannel: resolvedTarget.lastChannel,
      lastAccountId: resolvedTarget.lastAccountId,
    });
  }

  // Bootstrap once after a concrete route exists, then carry the prepared plugin
  // through account validation, target policy, and allow-from comparison.
  const preparedPlugin = preparedExplicitPlugin ?? ownerRoute?.plugin;
  const plugin =
    resolveOutboundChannelPlugin({
      channel: resolvedTarget.channel,
      cfg,
      agentId: params.agentId,
      allowBootstrap: true,
    }) ?? preparedPlugin;

  if (heartbeatAccountId) {
    const listAccountIds = plugin?.config.listAccountIds;
    const accountIds = listAccountIds ? listAccountIds(cfg) : [];
    if (accountIds.length > 0) {
      const normalizedAccountId = normalizeAccountId(heartbeatAccountId);
      const normalizedAccountIds = new Set(
        accountIds.map((accountId) => normalizeAccountId(accountId)),
      );
      if (!normalizedAccountIds.has(normalizedAccountId)) {
        return buildNoHeartbeatDeliveryTarget({
          reason: ownerMode ? "no-route" : "unknown-account",
          accountId: normalizedAccountId,
          lastChannel: resolvedTarget.lastChannel,
          lastAccountId: resolvedTarget.lastAccountId,
        });
      }
      effectiveAccountId = normalizedAccountId;
    }
  }

  const resolved = resolveOutboundTargetWithPlugin({
    plugin,
    target: {
      channel: resolvedTarget.channel,
      to: resolvedTarget.to,
      allowFrom: ownerRoute ? [ownerRoute.ownerId] : undefined,
      cfg,
      accountId: effectiveAccountId,
      mode: "heartbeat",
    },
  });
  if (!resolved?.ok) {
    return buildNoHeartbeatDeliveryTarget({
      reason: ownerMode ? "no-route" : "no-target",
      accountId: effectiveAccountId,
      lastChannel: resolvedTarget.lastChannel,
      lastAccountId: resolvedTarget.lastAccountId,
    });
  }

  const sessionChatTypeHint =
    (target === "last" && !heartbeat?.to) || ownerRoute?.reuseSessionRoute
      ? normalizeChatType(entry?.chatType)
      : undefined;
  const deliveryChatType = resolveHeartbeatDeliveryChatType({
    channel: resolvedTarget.channel,
    to: resolved.to,
    sessionChatType: sessionChatTypeHint,
    plugin,
  });
  if (deliveryChatType === "direct" && heartbeat?.directPolicy === "block") {
    return buildNoHeartbeatDeliveryTarget({
      reason: "dm-blocked",
      accountId: effectiveAccountId,
      lastChannel: resolvedTarget.lastChannel,
      lastAccountId: resolvedTarget.lastAccountId,
    });
  }
  if (
    ownerMode &&
    !ownerTurnSource &&
    !isPositivelyDirectHeartbeatOwnerTarget({
      plugin,
      to: resolved.to,
      chatType: deliveryChatType,
    })
  ) {
    return buildNoHeartbeatDeliveryTarget({
      reason: "no-route",
      accountId: effectiveAccountId,
      lastChannel: resolvedTarget.lastChannel,
      lastAccountId: resolvedTarget.lastAccountId,
    });
  }

  let reason: string | undefined;
  if (plugin?.config.resolveAllowFrom) {
    const explicit = resolveOutboundTargetWithPlugin({
      plugin,
      target: {
        channel: resolvedTarget.channel,
        to: resolvedTarget.to,
        cfg,
        accountId: effectiveAccountId,
        mode: "explicit",
      },
    });
    if (explicit?.ok && explicit.to !== resolved.to) {
      reason = "allowFrom-fallback";
    }
  }

  const inheritedHeartbeatThreadId = shouldReuseHeartbeatRouteThreadId({
    cfg,
    target,
    heartbeat,
    turnSource: params.turnSource,
    entry,
    resolvedTarget,
    plugin,
  })
    ? resolvedTarget.lastThreadId
    : undefined;

  return {
    channel: resolvedTarget.channel,
    to: resolved.to,
    chatType: deliveryChatType,
    reason,
    accountId: effectiveAccountId,
    // Heartbeats normally avoid inheriting session reply-thread IDs, but some
    // plugins encode thread/topic ids as part of the destination identity.
    threadId: resolvedTarget.threadId ?? inheritedHeartbeatThreadId,
    lastChannel: resolvedTarget.lastChannel,
    lastAccountId: resolvedTarget.lastAccountId,
    ...(implicitDefaultRoute ? { implicitDefaultRoute: true as const } : {}),
  };
}

function isPositivelyDirectHeartbeatOwnerTarget(params: {
  plugin?: ChannelPlugin;
  to: string;
  chatType?: ChatType;
}): boolean {
  const to = params.plugin
    ? stripTargetProviderPrefix(
        params.to,
        params.plugin.id,
        ...(params.plugin.messaging?.targetPrefixes ?? []),
      )
    : params.to.trim();
  const chatType =
    normalizeChatType(params.chatType) ?? params.plugin?.messaging?.inferTargetChatType?.({ to });
  // Implicit delivery must prove a direct destination via the channel's own
  // classifier; syntax alone (even `user:`) never admits, so unclassified
  // shapes fail closed and operator alerts cannot escape into a shared chat.
  return chatType === "direct";
}

function hasDeliverableHeartbeatTurnSource(turnSource: DeliveryContext | undefined): boolean {
  return Boolean(
    turnSource?.channel && isDeliverableMessageChannel(turnSource.channel) && turnSource.to?.trim(),
  );
}

function buildNoHeartbeatDeliveryTarget(params: {
  reason: string;
  accountId?: string;
  lastChannel?: string;
  lastAccountId?: string;
}): OutboundTarget {
  return {
    channel: "none",
    reason: params.reason,
    accountId: params.accountId,
    lastChannel: params.lastChannel,
    lastAccountId: params.lastAccountId,
  };
}

/** Resolves heartbeat delivery and lets plugins refine the outbound session route. */
export async function resolveHeartbeatDeliveryTargetWithSessionRoute(params: {
  cfg: OpenClawConfig;
  agentId: string;
  entry?: SessionEntry;
  heartbeat?: AgentDefaultsConfig["heartbeat"];
  turnSource?: DeliveryContext;
  currentSessionKey?: string;
}): Promise<OutboundTarget> {
  const delivery = resolveHeartbeatDeliveryTarget(params);
  const heartbeat = params.heartbeat ?? params.cfg.agents?.defaults?.heartbeat;
  const ownerRouteMustBeDirect =
    (heartbeat?.target === undefined || heartbeat.target === "owner") &&
    !hasDeliverableHeartbeatTurnSource(params.turnSource);
  if (delivery.channel === "none" || !delivery.to) {
    return delivery;
  }
  const rejectDelivery = (reason: string) =>
    buildNoHeartbeatDeliveryTarget({
      reason,
      accountId: delivery.accountId,
      lastChannel: delivery.lastChannel,
      lastAccountId: delivery.lastAccountId,
    });
  const deliveryTo = delivery.to;
  const plugin = resolveOutboundChannelPlugin({
    channel: delivery.channel,
    cfg: params.cfg,
    agentId: params.agentId,
    allowBootstrap: true,
  });
  const resolveSessionRoute = plugin?.messaging?.resolveOutboundSessionRoute;
  if (
    ownerRouteMustBeDirect &&
    !isPositivelyDirectHeartbeatOwnerTarget({
      plugin,
      to: deliveryTo,
      chatType: delivery.chatType,
    })
  ) {
    return rejectDelivery("no-route");
  }
  if (!resolveSessionRoute && !plugin?.messaging?.targetResolver) {
    return delivery;
  }
  let routeResolvedTarget: ResolvedMessagingTarget | undefined;
  const targetResolution = await (async () => {
    try {
      return await resolveChannelTarget({
        cfg: params.cfg,
        channel: delivery.channel as ChannelId,
        input: deliveryTo,
        accountId: delivery.accountId,
        unknownTargetMode: "normalized",
        plugin,
      });
    } catch {
      // Target normalization failure should not suppress an otherwise deliverable heartbeat.
      return null;
    }
  })();
  if (targetResolution?.ok) {
    routeResolvedTarget = targetResolution.target;
  } else if (targetResolution && isReservedTargetLiteralError(targetResolution.error)) {
    return rejectDelivery(ownerRouteMustBeDirect ? "no-route" : "no-target");
  }
  if (routeResolvedTarget?.kind === "user" && heartbeat?.directPolicy === "block") {
    return rejectDelivery("dm-blocked");
  }
  if (
    ownerRouteMustBeDirect &&
    !isPositivelyDirectHeartbeatOwnerTarget({
      plugin,
      to: routeResolvedTarget?.to ?? deliveryTo,
    })
  ) {
    return rejectDelivery("no-route");
  }
  if (!resolveSessionRoute) {
    return delivery;
  }
  const route = await (async () => {
    try {
      return await resolveOutboundSessionRoute({
        cfg: params.cfg,
        channel: delivery.channel as ChannelId,
        plugin,
        agentId: params.agentId,
        accountId: delivery.accountId,
        target: routeResolvedTarget?.to ?? deliveryTo,
        resolvedTarget: routeResolvedTarget,
        currentSessionKey: params.currentSessionKey,
        threadId: delivery.threadId,
      });
    } catch {
      return null;
    }
  })();
  if (!route) {
    return delivery;
  }
  if (route.chatType === "direct" && heartbeat?.directPolicy === "block") {
    return rejectDelivery("dm-blocked");
  }
  if (
    ownerRouteMustBeDirect &&
    !isPositivelyDirectHeartbeatOwnerTarget({
      plugin,
      to: route.to,
      chatType: normalizeChatType(route.chatType),
    })
  ) {
    return rejectDelivery("no-route");
  }
  return {
    ...delivery,
    to: route.to,
    chatType: route.chatType,
    threadId: route.threadId ?? delivery.threadId,
    ...(route.recipientSessionExact === true ? { targetSessionKey: route.sessionKey } : {}),
  };
}

function inferChatTypeFromTarget(params: {
  channel: string;
  to: string;
  plugin?: ChannelPlugin;
}): ChatType | undefined {
  const to = params.to.trim();
  if (!to) {
    return undefined;
  }

  if (/^user:/i.test(to)) {
    return "direct";
  }
  if (/^(channel:|thread:)/i.test(to)) {
    return "channel";
  }
  if (/^group:/i.test(to)) {
    return "group";
  }
  const plugin =
    params.plugin ??
    resolveOutboundChannelPlugin({
      channel: params.channel,
    });
  return plugin?.messaging?.inferTargetChatType?.({ to }) ?? undefined;
}

function resolveHeartbeatDeliveryChatType(params: {
  channel: string;
  to: string;
  sessionChatType?: ChatType;
  plugin?: ChannelPlugin;
}): ChatType | undefined {
  if (params.sessionChatType) {
    return params.sessionChatType;
  }
  return inferChatTypeFromTarget({
    channel: params.channel,
    to: params.to,
    plugin: params.plugin,
  });
}

function shouldReuseHeartbeatRouteThreadId(params: {
  cfg: OpenClawConfig;
  target: string;
  heartbeat?: AgentDefaultsConfig["heartbeat"];
  turnSource?: DeliveryContext;
  entry?: SessionEntry;
  resolvedTarget: SessionDeliveryTarget;
  plugin?: ChannelPlugin;
}): boolean {
  const channel = params.resolvedTarget.channel;
  const messaging = params.plugin
    ? params.plugin.messaging
    : channel
      ? resolveOutboundChannelPlugin({ channel, cfg: params.cfg })?.messaging
      : undefined;
  return (
    messaging?.preserveHeartbeatThreadIdForGroupRoute === true &&
    params.resolvedTarget.threadId == null &&
    params.target === "last" &&
    !params.heartbeat?.to &&
    params.turnSource?.threadId == null &&
    params.resolvedTarget.channel === params.resolvedTarget.lastChannel &&
    Boolean(params.resolvedTarget.to) &&
    Boolean(params.resolvedTarget.lastTo) &&
    params.resolvedTarget.to === params.resolvedTarget.lastTo &&
    normalizeChatType(params.entry?.chatType) === "group"
  );
}

function resolveHeartbeatSenderId(params: {
  allowFrom: Array<string | number>;
  deliveryTo?: string;
  lastTo?: string;
  provider?: string | null;
}) {
  const { allowFrom, deliveryTo, lastTo, provider } = params;
  const candidates = [
    deliveryTo?.trim(),
    provider && deliveryTo ? `${provider}:${deliveryTo}` : undefined,
    lastTo?.trim(),
    provider && lastTo ? `${provider}:${lastTo}` : undefined,
  ].filter((val): val is string => Boolean(val?.trim()));

  const allowList = concreteAllowFromEntries(allowFrom);
  if (mapAllowFromEntries(allowFrom).some((entry) => entry.trim() === "*")) {
    return candidates[0] ?? "heartbeat";
  }
  if (candidates.length > 0 && allowList.length > 0) {
    const matched = candidates.find((candidate) => allowList.includes(candidate));
    if (matched) {
      return matched;
    }
  }
  if (candidates.length > 0 && allowList.length === 0) {
    return candidates[0];
  }
  if (allowList.length > 0) {
    return allowList[0];
  }
  return candidates[0] ?? "heartbeat";
}

/** Resolves the sender id/allow-list context used for heartbeat sends. */
export function resolveHeartbeatSenderContext(params: {
  cfg: OpenClawConfig;
  entry?: SessionEntry;
  delivery: OutboundTarget;
}): HeartbeatSenderContext {
  const provider =
    params.delivery.channel !== "none" ? params.delivery.channel : params.delivery.lastChannel;
  const accountId =
    params.delivery.accountId ??
    (provider === params.delivery.lastChannel ? params.delivery.lastAccountId : undefined);
  const allowFromRaw = provider
    ? (resolveOutboundChannelPlugin({
        channel: provider,
        cfg: params.cfg,
      })?.config.resolveAllowFrom?.({
        cfg: params.cfg,
        accountId,
      }) ?? [])
    : [];
  const allowFrom = mapAllowFromEntries(allowFromRaw);

  const sender = resolveHeartbeatSenderId({
    allowFrom,
    deliveryTo: params.delivery.to,
    lastTo: deliveryContextFromSession(params.entry)?.to,
    provider,
  });

  return { sender: expectDefined(sender, "resolved sender"), provider, allowFrom };
}
