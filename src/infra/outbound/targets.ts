import {
  getChannelPlugin,
  normalizeChannelId,
} from "../../channels/plugins/index.js";
import type {
  ChannelId,
  ChannelOutboundTargetMode,
} from "../../channels/plugins/types.js";
import type { ClawdbotConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type {
  DeliverableMessageChannel,
  GatewayMessageChannel,
} from "../../utils/message-channel.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";

export type OutboundChannel = DeliverableMessageChannel | "none";

export type HeartbeatTarget = OutboundChannel | "last";

export type OutboundTarget = {
  channel: OutboundChannel;
  to?: string;
  reason?: string;
};

export type OutboundTargetResolution =
  | { ok: true; to: string }
  | { ok: false; error: Error };

// Channel docking: prefer plugin.outbound.resolveTarget + allowFrom to normalize destinations.
export function resolveOutboundTarget(params: {
  channel: GatewayMessageChannel;
  to?: string;
  allowFrom?: string[];
  cfg?: ClawdbotConfig;
  accountId?: string | null;
  mode?: ChannelOutboundTargetMode;
}): OutboundTargetResolution {
  if (params.channel === INTERNAL_MESSAGE_CHANNEL) {
    return {
      ok: false,
      error: new Error(
        "Delivering to WebChat is not supported via `clawdbot agent`; use WhatsApp/Telegram or run with --deliver=false.",
      ),
    };
  }

  const plugin = getChannelPlugin(params.channel as ChannelId);
  if (!plugin) {
    return {
      ok: false,
      error: new Error(`Unsupported channel: ${params.channel}`),
    };
  }

  const allowFrom =
    params.allowFrom ??
    (params.cfg && plugin.config.resolveAllowFrom
      ? plugin.config.resolveAllowFrom({
          cfg: params.cfg,
          accountId: params.accountId ?? undefined,
        })
      : undefined);

  const resolveTarget = plugin.outbound?.resolveTarget;
  if (resolveTarget) {
    return resolveTarget({
      cfg: params.cfg,
      to: params.to,
      allowFrom,
      accountId: params.accountId ?? undefined,
      mode: params.mode ?? "explicit",
    });
  }

  const trimmed = params.to?.trim();
  if (trimmed) {
    return { ok: true, to: trimmed };
  }
  return {
    ok: false,
    error: new Error(`Delivering to ${plugin.meta.label} requires --to`),
  };
}

export function resolveHeartbeatDeliveryTarget(params: {
  cfg: ClawdbotConfig;
  entry?: SessionEntry;
}): OutboundTarget {
  const { cfg, entry } = params;
  const rawTarget = cfg.agents?.defaults?.heartbeat?.target;
  let target: HeartbeatTarget = "last";
  if (rawTarget === "none" || rawTarget === "last") {
    target = rawTarget;
  } else if (typeof rawTarget === "string") {
    const normalized = normalizeChannelId(rawTarget);
    if (normalized) target = normalized;
  }

  if (target === "none") {
    return { channel: "none", reason: "target-none" };
  }

  const explicitTo =
    typeof cfg.agents?.defaults?.heartbeat?.to === "string" &&
    cfg.agents.defaults.heartbeat.to.trim()
      ? cfg.agents.defaults.heartbeat.to.trim()
      : undefined;

  const lastChannel =
    entry?.lastChannel && entry.lastChannel !== INTERNAL_MESSAGE_CHANNEL
      ? normalizeChannelId(entry.lastChannel)
      : undefined;
  const lastTo = typeof entry?.lastTo === "string" ? entry.lastTo.trim() : "";
  const channel = target === "last" ? lastChannel : target;

  const to =
    explicitTo ||
    (channel && lastChannel === channel ? lastTo : undefined) ||
    (target === "last" ? lastTo : undefined);

  if (!channel || !to) {
    return { channel: "none", reason: "no-target" };
  }

  const accountId = channel === lastChannel ? entry?.lastAccountId : undefined;
  const resolved = resolveOutboundTarget({
    channel,
    to,
    cfg,
    accountId,
    mode: "heartbeat",
  });
  if (!resolved.ok) {
    return { channel: "none", reason: "no-target" };
  }

  let reason: string | undefined;
  const plugin = getChannelPlugin(channel as ChannelId);
  if (plugin?.config.resolveAllowFrom) {
    const explicit = resolveOutboundTarget({
      channel,
      to,
      cfg,
      accountId,
      mode: "explicit",
    });
    if (explicit.ok && explicit.to !== resolved.to) {
      reason = "allowFrom-fallback";
    }
  }

  return reason
    ? { channel, to: resolved.to, reason }
    : { channel, to: resolved.to };
}
