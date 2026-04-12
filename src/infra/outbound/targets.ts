import { mapAllowFromEntries } from "openclaw/plugin-sdk/channel-config-helpers";
import { normalizeChatType, type ChatType } from "../../channels/chat-type.js";
import type { ChannelOutboundTargetMode } from "../../channels/plugins/types.core.js";
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
import {
  resolveOutboundTargetWithPlugin,
  type OutboundTargetResolution,
} from "./targets-resolve-shared.js";

export type OutboundChannel = DeliverableMessageChannel;

export type HeartbeatTarget = OutboundChannel;

export type OutboundTarget = {
  channel: OutboundChannel;
  to?: string;
  reason?: string;
  accountId?: string;
  threadId?: string | number;
  lastChannel?: DeliverableMessageChannel;
  lastAccountId?: string;
};

export type HeartbeatSenderContext = {
  sender: string;
  provider?: DeliverableMessageChannel;
  allowFrom: string[];
};

export type { OutboundTargetResolution } from "./targets-resolve-shared.js";
export { resolveSessionDeliveryTarget, type SessionDeliveryTarget } from "./targets-session.js";
import { resolveSessionDeliveryTarget } from "./targets-session.js";

// Channel docking: prefer plugin.outbound.resolveTarget + allowFrom to normalize destinations.
export function resolveOutboundTarget(params: {
  channel: GatewayMessageChannel;
  to?: string;
  allowFrom?: string[];
  cfg?: OpenClawConfig;
  accountId?: string | null;
  mode?: ChannelOutboundTargetMode;
}): OutboundTargetResolution {
  return (
    resolveOutboundTargetWithPlugin({
      plugin: resolveOutboundChannelPlugin({
        channel: params.channel,
        cfg: params.cfg,
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

  return {
    channel: resolvedTarget.channel,
    to: resolved.to,
    reason,
    accountId: effectiveAccountId,
    threadId: resolvedTarget.threadId,
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
