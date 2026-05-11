import { logDebug } from "openclaw/plugin-sdk/logging-core";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  isDiscordGroupAllowedByPolicy,
  resolveGroupDmAllow,
  type DiscordChannelConfigResolved,
  type DiscordGuildEntryResolved,
} from "./allow-list.js";

export function resolveDiscordPreflightChannelAccess(params: {
  isGuildMessage: boolean;
  isGroupDm: boolean;
  groupPolicy: "open" | "disabled" | "allowlist";
  groupDmChannels?: string[];
  messageChannelId: string;
  displayChannelName?: string;
  displayChannelSlug: string;
  guildInfo: DiscordGuildEntryResolved | null;
  channelConfig: DiscordChannelConfigResolved | null;
  channelMatchMeta: string;
}): { allowed: boolean; channelAllowlistConfigured: boolean; channelAllowed: boolean } {
  if (params.isGuildMessage && params.channelConfig?.enabled === false) {
    logDebug(`[discord-preflight] drop: channel disabled`);
    logVerbose(
      `Blocked discord channel ${params.messageChannelId} (channel disabled, ${params.channelMatchMeta})`,
    );
    return { allowed: false, channelAllowlistConfigured: false, channelAllowed: false };
  }

  const groupDmAllowed =
    params.isGroupDm &&
    resolveGroupDmAllow({
      channels: params.groupDmChannels,
      channelId: params.messageChannelId,
      channelName: params.displayChannelName,
      channelSlug: params.displayChannelSlug,
    });
  if (params.isGroupDm && !groupDmAllowed) {
    return { allowed: false, channelAllowlistConfigured: false, channelAllowed: false };
  }

  const channelAllowlistConfigured =
    Boolean(params.guildInfo?.channels) && Object.keys(params.guildInfo?.channels ?? {}).length > 0;
  const channelAllowed = params.channelConfig?.allowed !== false;
  if (
    params.isGuildMessage &&
    !isDiscordGroupAllowedByPolicy({
      groupPolicy: params.groupPolicy,
      guildAllowlisted: Boolean(params.guildInfo),
      channelAllowlistConfigured,
      channelAllowed,
    })
  ) {
    if (params.groupPolicy === "disabled") {
      logDebug(`[discord-preflight] drop: groupPolicy disabled`);
      logVerbose(`discord: drop guild message (groupPolicy: disabled, ${params.channelMatchMeta})`);
    } else if (!channelAllowlistConfigured) {
      logDebug(`[discord-preflight] drop: groupPolicy allowlist, no channel allowlist configured`);
      logVerbose(
        `discord: drop guild message (groupPolicy: allowlist, no channel allowlist, ${params.channelMatchMeta})`,
      );
    } else {
      logDebug(
        `[discord] Ignored message from channel ${params.messageChannelId} (not in guild allowlist). Add to guilds.<guildId>.channels to enable.`,
      );
      logVerbose(
        `Blocked discord channel ${params.messageChannelId} not in guild channel allowlist (groupPolicy: allowlist, ${params.channelMatchMeta})`,
      );
    }
    return { allowed: false, channelAllowlistConfigured, channelAllowed };
  }

  if (params.isGuildMessage && params.channelConfig?.allowed === false) {
    logDebug(`[discord-preflight] drop: channelConfig.allowed===false`);
    logVerbose(
      `Blocked discord channel ${params.messageChannelId} not in guild channel allowlist (${params.channelMatchMeta})`,
    );
    return { allowed: false, channelAllowlistConfigured, channelAllowed };
  }
  if (params.isGuildMessage) {
    logDebug(`[discord-preflight] pass: channel allowed`);
    logVerbose(`discord: allow channel ${params.messageChannelId} (${params.channelMatchMeta})`);
  }

  return { allowed: true, channelAllowlistConfigured, channelAllowed };
}
