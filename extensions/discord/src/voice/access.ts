import type { Guild } from "@buape/carbon";
import { resolveCommandAuthorizedFromAuthorizers } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveOpenProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
import {
  isDiscordGroupAllowedByPolicy,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordGuildEntry,
  resolveDiscordMemberAccessState,
  resolveDiscordOwnerAccess,
} from "../monitor/allow-list.js";

export async function authorizeDiscordVoiceIngress(params: {
  cfg: OpenClawConfig;
  discordConfig: DiscordAccountConfig;
  groupPolicy?: "open" | "disabled" | "allowlist";
  useAccessGroups?: boolean;
  guild?: Guild<true> | Guild | null;
  guildName?: string;
  guildId: string;
  channelId: string;
  channelName?: string;
  channelSlug: string;
  parentId?: string;
  parentName?: string;
  parentSlug?: string;
  scope?: "channel" | "thread";
  channelLabel?: string;
  memberRoleIds: string[];
  sender: { id: string; name?: string; tag?: string };
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const groupPolicy =
    params.groupPolicy ??
    resolveOpenProviderRuntimeGroupPolicy({
      providerConfigPresent: params.cfg.channels?.discord !== undefined,
      groupPolicy: params.discordConfig.groupPolicy,
      defaultGroupPolicy: params.cfg.channels?.defaults?.groupPolicy,
    }).groupPolicy;
  const guild =
    params.guild ??
    ({ id: params.guildId, ...(params.guildName ? { name: params.guildName } : {}) } as Guild);
  const guildInfo = resolveDiscordGuildEntry({
    guild,
    guildId: params.guildId,
    guildEntries: params.discordConfig.guilds,
  });
  const channelConfig = params.channelId
    ? resolveDiscordChannelConfigWithFallback({
        guildInfo,
        channelId: params.channelId,
        channelName: params.channelName,
        channelSlug: params.channelSlug,
        parentId: params.parentId,
        parentName: params.parentName,
        parentSlug: params.parentSlug,
        scope: params.scope,
      })
    : null;

  if (channelConfig?.enabled === false) {
    return { ok: false, message: "This channel is disabled." };
  }

  const channelAllowlistConfigured =
    Boolean(guildInfo?.channels) && Object.keys(guildInfo?.channels ?? {}).length > 0;
  if (!params.channelId && groupPolicy === "allowlist" && channelAllowlistConfigured) {
    return {
      ok: false,
      message: `${params.channelLabel ?? "This channel"} is not allowlisted for voice commands.`,
    };
  }

  const channelAllowed = channelConfig ? channelConfig.allowed : !channelAllowlistConfigured;
  if (
    !isDiscordGroupAllowedByPolicy({
      groupPolicy,
      guildAllowlisted: Boolean(guildInfo),
      channelAllowlistConfigured,
      channelAllowed,
    }) ||
    channelConfig?.allowed === false
  ) {
    return {
      ok: false,
      message: `${params.channelLabel ?? "This channel"} is not allowlisted for voice commands.`,
    };
  }

  const { hasAccessRestrictions, memberAllowed } = resolveDiscordMemberAccessState({
    channelConfig,
    guildInfo,
    memberRoleIds: params.memberRoleIds,
    sender: params.sender,
    allowNameMatching: false,
  });

  const { ownerAllowList, ownerAllowed } = resolveDiscordOwnerAccess({
    allowFrom: params.discordConfig.allowFrom ?? params.discordConfig.dm?.allowFrom ?? [],
    sender: params.sender,
    allowNameMatching: false,
  });

  const useAccessGroups = params.useAccessGroups ?? params.cfg.commands?.useAccessGroups !== false;
  const authorizers = useAccessGroups
    ? [
        { configured: ownerAllowList != null, allowed: ownerAllowed },
        { configured: hasAccessRestrictions, allowed: memberAllowed },
      ]
    : [{ configured: hasAccessRestrictions, allowed: memberAllowed }];

  return resolveCommandAuthorizedFromAuthorizers({
    useAccessGroups,
    authorizers,
    modeWhenAccessGroupsOff: "configured",
  })
    ? { ok: true }
    : { ok: false, message: "You are not authorized to use this command." };
}
