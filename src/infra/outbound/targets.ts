import { mapAllowFromEntries } from "openclaw/plugin-sdk/channel-config-helpers";
import { normalizeChatType, type ChatType } from "../../channels/chat-type.js";
import type { ChannelOutboundTargetMode } from "../../channels/plugins/types.core.js";
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
import type {
  DeliverableMessageChannel,
  GatewayMessageChannel,
} from "../../utils/message-channel.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
} from "../../utils/message-channel.js";
import {
  normalizeDeliverableOutboundChannel,
  resolveOutboundChannelPlugin,
} from "./channel-resolution.js";
import { resolveOutboundSessionRoute } from "./outbound-session.js";
import { resolveChannelTarget, type ResolvedMessagingTarget } from "./target-resolver.js";
import {
  resolveOutboundTargetWithPlugin,
  type OutboundTargetResolution,
} from "./targets-resolve-shared.js";

/** Deliverable channel id accepted by outbound target resolution. */
export type OutboundChannel = DeliverableMessageChannel;

/** Heartbeat target channel id from agent/default heartbeat config. */
export type HeartbeatTarget = OutboundChannel;

/** Resolved outbound delivery destination and routing hints. */
export type OutboundTarget = {
  channel: OutboundChannel;
  to?: string;
  chatType?: ChatType;
  reason?: string;
  accountId?: string;
  threadId?: string | number;
  lastChannel?: DeliverableMessageChannel;
  lastAccountId?: string;
};

/** Sender identity context used when a heartbeat needs channel-compatible metadata. */
export type HeartbeatSenderContext = {
  sender: string;
  provider?: DeliverableMessageChannel;
  allowFrom: string[];
};

export type { OutboundTargetResolution } from "./targets-resolve-shared.js";
export { resolveSessionDeliveryTarget, type SessionDeliveryTarget } from "./targets-session.js";
import { resolveSessionDeliveryTarget, type SessionDeliveryTarget } from "./targets-session.js";

/** Resolves a user-supplied outbound destination through the channel plugin. */
export function resolveOutboundTarget(params: {
  channel: GatewayMessageChannel;
  to?: string;
  allowFrom?: string[];
  allowBootstrap?: boolean;
  cfg?: OpenClawConfig;
  accountId?: string | null;
  mode?: ChannelOutboundTargetMode;
}): OutboundTargetResolution {
  return (
    resolveOutboundTargetWithPlugin({
      plugin: resolveOutboundChannelPlugin({
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

/** Resolves the heartbeat delivery destination from config, session state, and turn source. */
export function resolveHeartbeatDeliveryTarget(params: {
  cfg: OpenClawConfig;
  entry?: SessionEntry;
  heartbeat?: AgentDefaultsConfig["heartbeat"];
  turnSource?: DeliveryContext;
}): OutboundTarget {
  const { cfg, entry } = params;
  const heartbeat = params.heartbeat ?? cfg.agents?.defaults?.heartbeat;
  const rawTarget = heartbeat?.target;
  let target: HeartbeatTarget = "none";
  if (rawTarget === "none" || rawTarget === "last") {
    target = rawTarget;
  } else if (typeof rawTarget === "string") {
    const normalized = normalizeDeliverableOutboundChannel(rawTarget);
    if (normalized) {
      target = normalized;
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

  const resolvedTurnSource =
    target === "last"
      ? mergeDeliveryContext(params.turnSource, deliveryContextFromSession(entry))
      : undefined;

  const resolvedTarget = resolveSessionDeliveryTarget({
    entry,
    requestedChannel: target === "last" ? "last" : target,
    explicitTo: heartbeat?.to,
    mode: "heartbeat",
    turnSourceChannel:
      resolvedTurnSource?.channel && isDeliverableMessageChannel(resolvedTurnSource.channel)
        ? resolvedTurnSource.channel
        : undefined,
    turnSourceTo: resolvedTurnSource?.to,
    turnSourceAccountId: resolvedTurnSource?.accountId,
    // Only pass threadId from an explicit turn source (e.g., restart sentinel's
    // delivery context). Do NOT fall back to session-stored threadId here —
    // heartbeat mode intentionally drops inherited thread IDs to avoid replying
    // in stale threads (e.g., Slack thread_ts). The sentinel's delivery context
    // carries the correct topic/thread ID when present.
    turnSourceThreadId: params.turnSource?.threadId,
  });

  const heartbeatAccountId = heartbeat?.accountId?.trim();
  // Use explicit accountId from heartbeat config if provided, otherwise fall back to session
  let effectiveAccountId = heartbeatAccountId || resolvedTarget.accountId;

  if (heartbeatAccountId && resolvedTarget.channel) {
    const plugin = resolveOutboundChannelPlugin({
      channel: resolvedTarget.channel,
      cfg,
    });
    const listAccountIds = plugin?.config.listAccountIds;
    const accountIds = listAccountIds ? listAccountIds(cfg) : [];
    if (accountIds.length > 0) {
      const normalizedAccountId = normalizeAccountId(heartbeatAccountId);
      const normalizedAccountIds = new Set(
        accountIds.map((accountId) => normalizeAccountId(accountId)),
      );
      if (!normalizedAccountIds.has(normalizedAccountId)) {
        return buildNoHeartbeatDeliveryTarget({
          reason: "unknown-account",
          accountId: normalizedAccountId,
          lastChannel: resolvedTarget.lastChannel,
          lastAccountId: resolvedTarget.lastAccountId,
        });
      }
      effectiveAccountId = normalizedAccountId;
    }
  }

  if (!resolvedTarget.channel || !resolvedTarget.to) {
    return buildNoHeartbeatDeliveryTarget({
      reason: "no-target",
      accountId: effectiveAccountId,
      lastChannel: resolvedTarget.lastChannel,
      lastAccountId: resolvedTarget.lastAccountId,
    });
  }

  const resolved = resolveOutboundTarget({
    channel: resolvedTarget.channel,
    to: resolvedTarget.to,
    cfg,
    accountId: effectiveAccountId,
    mode: "heartbeat",
  });
  if (!resolved.ok) {
    return buildNoHeartbeatDeliveryTarget({
      reason: "no-target",
      accountId: effectiveAccountId,
      lastChannel: resolvedTarget.lastChannel,
      lastAccountId: resolvedTarget.lastAccountId,
    });
  }

  const sessionChatTypeHint =
    target === "last" && !heartbeat?.to ? normalizeChatType(entry?.chatType) : undefined;
  const deliveryChatType = resolveHeartbeatDeliveryChatType({
    channel: resolvedTarget.channel,
    to: resolved.to,
    sessionChatType: sessionChatTypeHint,
  });
  if (deliveryChatType === "direct" && heartbeat?.directPolicy === "block") {
    return buildNoHeartbeatDeliveryTarget({
      reason: "dm-blocked",
      accountId: effectiveAccountId,
      lastChannel: resolvedTarget.lastChannel,
      lastAccountId: resolvedTarget.lastAccountId,
    });
  }

  let reason: string | undefined;
  const plugin = resolveOutboundChannelPlugin({
    channel: resolvedTarget.channel,
    cfg,
  });
  if (plugin?.config.resolveAllowFrom) {
    const explicit = resolveOutboundTarget({
      channel: resolvedTarget.channel,
      to: resolvedTarget.to,
      cfg,
      accountId: effectiveAccountId,
      mode: "explicit",
    });
    if (explicit.ok && explicit.to !== resolved.to) {
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
  };
}

function buildNoHeartbeatDeliveryTarget(params: {
  reason: string;
  accountId?: string;
  lastChannel?: DeliverableMessageChannel;
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
  if (delivery.channel === "none" || !delivery.to) {
    return delivery;
  }
  const deliveryTo = delivery.to;
  const plugin = resolveOutboundChannelPlugin({
    channel: delivery.channel,
    cfg: params.cfg,
  });
  if (!plugin?.messaging?.resolveOutboundSessionRoute) {
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
      });
    } catch {
      // Target normalization failure should not suppress an otherwise deliverable heartbeat.
      return null;
    }
  })();
  if (targetResolution?.ok) {
    routeResolvedTarget = targetResolution.target;
  }
  const route = await (async () => {
    try {
      return await resolveOutboundSessionRoute({
        cfg: params.cfg,
        channel: delivery.channel as ChannelId,
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
    return buildNoHeartbeatDeliveryTarget({
      reason: "dm-blocked",
      accountId: delivery.accountId,
      lastChannel: delivery.lastChannel,
      lastAccountId: delivery.lastAccountId,
    });
  }
  return {
    ...delivery,
    to: route.to,
    chatType: route.chatType,
    threadId: route.threadId ?? delivery.threadId,
  };
}

function inferChatTypeFromTarget(params: {
  channel: DeliverableMessageChannel;
  to: string;
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
  return (
    resolveOutboundChannelPlugin({
      channel: params.channel,
    })?.messaging?.inferTargetChatType?.({ to }) ?? undefined
  );
}

function resolveHeartbeatDeliveryChatType(params: {
  channel: DeliverableMessageChannel;
  to: string;
  sessionChatType?: ChatType;
}): ChatType | undefined {
  if (params.sessionChatType) {
    return params.sessionChatType;
  }
  return inferChatTypeFromTarget({
    channel: params.channel,
    to: params.to,
  });
}

function shouldReuseHeartbeatRouteThreadId(params: {
  cfg: OpenClawConfig;
  target: HeartbeatTarget;
  heartbeat?: AgentDefaultsConfig["heartbeat"];
  turnSource?: DeliveryContext;
  entry?: SessionEntry;
  resolvedTarget: SessionDeliveryTarget;
}): boolean {
  const channel = params.resolvedTarget.channel;
  const messaging =
    channel && resolveOutboundChannelPlugin({ channel, cfg: params.cfg })?.messaging;
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

  const allowList = mapAllowFromEntries(allowFrom).filter((entry) => entry && entry !== "*");
  if (allowFrom.includes("*")) {
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
    lastTo: params.entry?.lastTo,
    provider,
  });

  return { sender, provider, allowFrom };
}
