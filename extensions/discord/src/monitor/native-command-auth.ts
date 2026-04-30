import { resolveCommandAuthorizedFromAuthorizers } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import { resolveOpenProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { resolveDiscordAccountAllowFrom, resolveDiscordAccountDmPolicy } from "../accounts.js";
import type { AutocompleteInteraction } from "../internal/discord.js";
import {
  normalizeDiscordAllowList,
  resolveDiscordAllowListMatch,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordChannelPolicyCommandAuthorizer,
  resolveDiscordGuildEntry,
  resolveDiscordMemberAccessState,
  resolveDiscordOwnerAccess,
  resolveGroupDmAllow,
} from "./allow-list.js";
import { resolveDiscordDmCommandAccess } from "./dm-command-auth.js";
import type { DiscordConfig } from "./native-command.types.js";
import { resolveDiscordNativeInteractionChannelContext } from "./native-interaction-channel-context.js";
import { resolveDiscordSenderIdentity } from "./sender-identity.js";

export function resolveDiscordNativeCommandAllowlistAccess(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  sender: { id: string; name?: string; tag?: string };
  chatType: "direct" | "group" | "thread" | "channel";
  conversationId?: string;
  guildId?: string | null;
}) {
  const commandsAllowFrom = params.cfg.commands?.allowFrom;
  if (!commandsAllowFrom || typeof commandsAllowFrom !== "object") {
    return { configured: false, allowed: false } as const;
  }
  const rawAllowList = Array.isArray(commandsAllowFrom.discord)
    ? commandsAllowFrom.discord
    : commandsAllowFrom["*"];
  if (!Array.isArray(rawAllowList)) {
    return { configured: false, allowed: false } as const;
  }
  const guildId = normalizeOptionalString(params.guildId);
  if (guildId) {
    for (const entry of rawAllowList) {
      const text = normalizeOptionalString(String(entry)) ?? "";
      if (text.startsWith("guild:") && text.slice("guild:".length) === guildId) {
        return { configured: true, allowed: true } as const;
      }
    }
  }
  const allowList = normalizeDiscordAllowList(rawAllowList.map(String), [
    "discord:",
    "user:",
    "pk:",
  ]);
  if (!allowList) {
    return { configured: true, allowed: false } as const;
  }
  const match = resolveDiscordAllowListMatch({
    allowList,
    candidate: params.sender,
    allowNameMatching: false,
  });
  return { configured: true, allowed: match.allowed } as const;
}

export function resolveDiscordGuildNativeCommandAuthorized(params: {
  cfg: OpenClawConfig;
  discordConfig: DiscordConfig;
  useAccessGroups: boolean;
  commandsAllowFromAccess: ReturnType<typeof resolveDiscordNativeCommandAllowlistAccess>;
  guildInfo?: ReturnType<typeof resolveDiscordGuildEntry> | null;
  channelConfig?: ReturnType<typeof resolveDiscordChannelConfigWithFallback> | null;
  memberRoleIds: string[];
  sender: { id: string; name?: string; tag?: string };
  allowNameMatching: boolean;
  ownerAllowListConfigured: boolean;
  ownerAllowed: boolean;
}) {
  const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: params.cfg.channels?.discord !== undefined,
    groupPolicy: params.discordConfig?.groupPolicy,
    defaultGroupPolicy: params.cfg.channels?.defaults?.groupPolicy,
  });
  const policyAuthorizer = resolveDiscordChannelPolicyCommandAuthorizer({
    groupPolicy,
    guildInfo: params.guildInfo,
    channelConfig: params.channelConfig,
  });
  if (!policyAuthorizer.allowed) {
    return false;
  }
  const { hasAccessRestrictions, memberAllowed } = resolveDiscordMemberAccessState({
    channelConfig: params.channelConfig,
    guildInfo: params.guildInfo,
    memberRoleIds: params.memberRoleIds,
    sender: params.sender,
    allowNameMatching: params.allowNameMatching,
  });
  const commandAllowlistAuthorizer = {
    configured: params.commandsAllowFromAccess.configured,
    allowed: params.commandsAllowFromAccess.allowed,
  };
  const ownerAuthorizer = {
    configured: params.ownerAllowListConfigured,
    allowed: params.ownerAllowed,
  };
  const memberAuthorizer = {
    configured: hasAccessRestrictions,
    allowed: memberAllowed,
  };
  const hasStricterAccessRestrictions = ownerAuthorizer.configured || memberAuthorizer.configured;
  const policyFallbackAuthorizer = {
    configured: policyAuthorizer.configured && !hasStricterAccessRestrictions,
    allowed: policyAuthorizer.allowed,
  };
  const fallbackAuthorizers = [policyFallbackAuthorizer, ownerAuthorizer, memberAuthorizer];
  const authorizers = params.commandsAllowFromAccess.configured
    ? [commandAllowlistAuthorizer]
    : fallbackAuthorizers;
  return resolveCommandAuthorizedFromAuthorizers({
    useAccessGroups: params.useAccessGroups,
    authorizers,
    modeWhenAccessGroupsOff: "configured",
  });
}

export function resolveDiscordNativeGroupDmAccess(params: {
  isGroupDm: boolean;
  groupEnabled?: boolean;
  groupChannels?: string[];
  channelId: string;
  channelName?: string;
  channelSlug: string;
}): { allowed: true } | { allowed: false; reason: "disabled" | "not-allowlisted" } {
  if (!params.isGroupDm) {
    return { allowed: true };
  }
  if (params.groupEnabled === false) {
    return { allowed: false, reason: "disabled" };
  }
  if (
    !resolveGroupDmAllow({
      channels: params.groupChannels,
      channelId: params.channelId,
      channelName: params.channelName,
      channelSlug: params.channelSlug,
    })
  ) {
    return { allowed: false, reason: "not-allowlisted" };
  }
  return { allowed: true };
}

export async function resolveDiscordNativeAutocompleteAuthorized(params: {
  interaction: AutocompleteInteraction;
  cfg: OpenClawConfig;
  discordConfig: DiscordConfig;
  accountId: string;
}): Promise<boolean> {
  const { interaction, cfg, discordConfig, accountId } = params;
  const user = interaction.user;
  if (!user) {
    return false;
  }
  const sender = resolveDiscordSenderIdentity({ author: user, pluralkitInfo: null });
  const {
    isDirectMessage,
    isGroupDm,
    isThreadChannel,
    channelName,
    channelSlug,
    rawChannelId,
    threadParentId,
    threadParentName,
    threadParentSlug,
  } = await resolveDiscordNativeInteractionChannelContext({
    channel: interaction.channel,
    client: interaction.client,
    hasGuild: Boolean(interaction.guild),
    channelIdFallback: "",
  });
  const memberRoleIds = Array.isArray(interaction.rawData.member?.roles)
    ? interaction.rawData.member.roles.map((roleId: string) => roleId)
    : [];
  const allowNameMatching = isDangerousNameMatchingEnabled(discordConfig);
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const configuredDmAllowFrom =
    resolveDiscordAccountAllowFrom({
      cfg,
      accountId,
    }) ?? [];
  const { ownerAllowList, ownerAllowed: ownerOk } = resolveDiscordOwnerAccess({
    allowFrom: configuredDmAllowFrom,
    sender: {
      id: sender.id,
      name: sender.name,
      tag: sender.tag,
    },
    allowNameMatching,
  });
  const commandsAllowFromAccess = resolveDiscordNativeCommandAllowlistAccess({
    cfg,
    accountId,
    sender: {
      id: sender.id,
      name: sender.name,
      tag: sender.tag,
    },
    chatType: isDirectMessage
      ? "direct"
      : isThreadChannel
        ? "thread"
        : interaction.guild
          ? "channel"
          : "group",
    conversationId: rawChannelId || undefined,
    guildId: interaction.guild?.id,
  });
  const guildInfo = resolveDiscordGuildEntry({
    guild: interaction.guild ?? undefined,
    guildId: interaction.guild?.id ?? undefined,
    guildEntries: discordConfig?.guilds,
  });
  const channelConfig = interaction.guild
    ? resolveDiscordChannelConfigWithFallback({
        guildInfo,
        channelId: rawChannelId,
        channelName,
        channelSlug,
        parentId: threadParentId,
        parentName: threadParentName,
        parentSlug: threadParentSlug,
        scope: isThreadChannel ? "thread" : "channel",
      })
    : null;
  if (channelConfig?.enabled === false) {
    return false;
  }
  if (interaction.guild && channelConfig?.allowed === false) {
    return false;
  }
  if (useAccessGroups && interaction.guild) {
    const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
      providerConfigPresent: cfg.channels?.discord !== undefined,
      groupPolicy: discordConfig?.groupPolicy,
      defaultGroupPolicy: cfg.channels?.defaults?.groupPolicy,
    });
    const policyAuthorizer = resolveDiscordChannelPolicyCommandAuthorizer({
      groupPolicy,
      guildInfo,
      channelConfig,
    });
    if (!policyAuthorizer.allowed) {
      return false;
    }
  }
  const dmEnabled = discordConfig?.dm?.enabled ?? true;
  const dmPolicy = resolveDiscordAccountDmPolicy({ cfg, accountId }) ?? "pairing";
  if (isDirectMessage) {
    if (!dmEnabled || dmPolicy === "disabled") {
      return false;
    }
    const dmAccess = await resolveDiscordDmCommandAccess({
      accountId,
      dmPolicy,
      configuredAllowFrom: configuredDmAllowFrom,
      sender: {
        id: sender.id,
        name: sender.name,
        tag: sender.tag,
      },
      allowNameMatching,
      useAccessGroups,
    });
    if (dmAccess.decision !== "allow") {
      return false;
    }
  }
  const groupDmAccess = resolveDiscordNativeGroupDmAccess({
    isGroupDm,
    groupEnabled: discordConfig?.dm?.groupEnabled,
    groupChannels: discordConfig?.dm?.groupChannels,
    channelId: rawChannelId,
    channelName,
    channelSlug,
  });
  if (!groupDmAccess.allowed) {
    return false;
  }
  if (!isDirectMessage) {
    return resolveDiscordGuildNativeCommandAuthorized({
      cfg,
      discordConfig,
      useAccessGroups,
      commandsAllowFromAccess,
      guildInfo,
      channelConfig,
      memberRoleIds,
      sender,
      allowNameMatching,
      ownerAllowListConfigured: ownerAllowList != null,
      ownerAllowed: ownerOk,
    });
  }
  return true;
}
