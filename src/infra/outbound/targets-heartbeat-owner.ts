import { mapAllowFromEntries } from "openclaw/plugin-sdk/channel-config-helpers";
import { normalizeChatType, type ChatType } from "../../channels/chat-type.js";
import { listChannelPlugins } from "../../channels/plugins/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.shared.js";
import { isDeliverableMessageChannel } from "../../utils/message-channel.js";
import { resolveOutboundChannelPlugin } from "./channel-resolution.js";
import {
  resolveTargetPrefixedChannel,
  stripTargetProviderPrefix,
} from "./channel-target-prefix.js";
import { isPotentialConfiguredMessageChannel } from "./message-account-selection.js";

export function concreteAllowFromEntries(
  entries: Array<string | number> | null | undefined,
): string[] {
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

export function isPositivelyDirectHeartbeatOwnerTarget(params: {
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

export function resolveHeartbeatOwnerRoute(params: {
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
