import { resolveCommandAuthorizedFromAuthorizers } from "openclaw/plugin-sdk/command-auth-native";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveOpenProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
import type { DiscordComponentEntry } from "../components.js";
import { resolveDiscordChannelContext } from "./agent-components-context.js";
import { resolveInteractionContextWithDmAuth } from "./agent-components-dm-auth.js";
import { replySilently } from "./agent-components-reply.js";
import type {
  AgentComponentContext,
  AgentComponentInteraction,
  ComponentInteractionContext,
  DiscordChannelContext,
  DiscordUser,
} from "./agent-components.types.js";
import {
  isDiscordGroupAllowedByPolicy,
  normalizeDiscordAllowList,
  resolveDiscordAllowListMatch,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordGuildEntry,
  resolveDiscordMemberAccessState,
  resolveDiscordOwnerAccess,
} from "./allow-list.js";
import { formatDiscordUserTag } from "./format.js";

function resolveComponentRuntimeGroupPolicy(ctx: AgentComponentContext) {
  return resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: ctx.cfg.channels?.discord !== undefined,
    groupPolicy: ctx.discordConfig?.groupPolicy,
    defaultGroupPolicy: ctx.cfg.channels?.defaults?.groupPolicy,
  }).groupPolicy;
}

async function ensureGuildComponentMemberAllowed(params: {
  interaction: AgentComponentInteraction;
  guildInfo: ReturnType<typeof resolveDiscordGuildEntry>;
  channelId: string;
  rawGuildId: string | undefined;
  channelCtx: DiscordChannelContext;
  memberRoleIds: string[];
  user: DiscordUser;
  replyOpts: { ephemeral?: boolean };
  componentLabel: string;
  unauthorizedReply: string;
  allowNameMatching: boolean;
  groupPolicy: "open" | "disabled" | "allowlist";
}) {
  const {
    interaction,
    guildInfo,
    channelId,
    rawGuildId,
    channelCtx,
    memberRoleIds,
    user,
    replyOpts,
    componentLabel,
    unauthorizedReply,
  } = params;

  if (!rawGuildId) {
    return true;
  }

  const replyUnauthorized = async () => {
    await replySilently(interaction, { content: unauthorizedReply, ...replyOpts });
  };

  const channelConfig = resolveDiscordChannelConfigWithFallback({
    guildInfo,
    channelId,
    channelName: channelCtx.channelName,
    channelSlug: channelCtx.channelSlug,
    parentId: channelCtx.parentId,
    parentName: channelCtx.parentName,
    parentSlug: channelCtx.parentSlug,
    scope: channelCtx.isThread ? "thread" : "channel",
  });

  if (channelConfig?.enabled === false) {
    await replyUnauthorized();
    return false;
  }
  const channelAllowlistConfigured =
    Boolean(guildInfo?.channels) && Object.keys(guildInfo?.channels ?? {}).length > 0;
  const channelAllowed = channelConfig?.allowed !== false;
  if (
    !isDiscordGroupAllowedByPolicy({
      groupPolicy: params.groupPolicy,
      guildAllowlisted: Boolean(guildInfo),
      channelAllowlistConfigured,
      channelAllowed,
    })
  ) {
    await replyUnauthorized();
    return false;
  }
  if (channelConfig?.allowed === false) {
    await replyUnauthorized();
    return false;
  }

  const { memberAllowed } = resolveDiscordMemberAccessState({
    channelConfig,
    guildInfo,
    memberRoleIds,
    sender: {
      id: user.id,
      name: user.username,
      tag: user.discriminator ? `${user.username}#${user.discriminator}` : undefined,
    },
    allowNameMatching: params.allowNameMatching,
  });
  if (memberAllowed) {
    return true;
  }

  logVerbose(`agent ${componentLabel}: blocked user ${user.id} (not in users/roles allowlist)`);
  await replyUnauthorized();
  return false;
}

export async function ensureComponentUserAllowed(params: {
  entry: DiscordComponentEntry;
  interaction: AgentComponentInteraction;
  user: DiscordUser;
  replyOpts: { ephemeral?: boolean };
  componentLabel: string;
  unauthorizedReply: string;
  allowNameMatching: boolean;
}) {
  const allowList = normalizeDiscordAllowList(params.entry.allowedUsers, [
    "discord:",
    "user:",
    "pk:",
  ]);
  if (!allowList) {
    return true;
  }
  const match = resolveDiscordAllowListMatch({
    allowList,
    candidate: {
      id: params.user.id,
      name: params.user.username,
      tag: formatDiscordUserTag(params.user),
    },
    allowNameMatching: params.allowNameMatching,
  });
  if (match.allowed) {
    return true;
  }

  logVerbose(
    `discord component ${params.componentLabel}: blocked user ${params.user.id} (not in allowedUsers)`,
  );
  await replySilently(params.interaction, {
    content: params.unauthorizedReply,
    ...params.replyOpts,
  });
  return false;
}

export async function ensureAgentComponentInteractionAllowed(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentInteraction;
  channelId: string;
  rawGuildId: string | undefined;
  memberRoleIds: string[];
  user: DiscordUser;
  replyOpts: { ephemeral?: boolean };
  componentLabel: string;
  unauthorizedReply: string;
}) {
  const guildInfo = resolveDiscordGuildEntry({
    guild: params.interaction.guild ?? undefined,
    guildId: params.rawGuildId,
    guildEntries: params.ctx.guildEntries,
  });
  const channelCtx = resolveDiscordChannelContext(params.interaction);
  const memberAllowed = await ensureGuildComponentMemberAllowed({
    interaction: params.interaction,
    guildInfo,
    channelId: params.channelId,
    rawGuildId: params.rawGuildId,
    channelCtx,
    memberRoleIds: params.memberRoleIds,
    user: params.user,
    replyOpts: params.replyOpts,
    componentLabel: params.componentLabel,
    unauthorizedReply: params.unauthorizedReply,
    allowNameMatching: isDangerousNameMatchingEnabled(params.ctx.discordConfig),
    groupPolicy: resolveComponentRuntimeGroupPolicy(params.ctx),
  });
  if (!memberAllowed) {
    return null;
  }
  return { parentId: channelCtx.parentId };
}

export async function resolveAuthorizedComponentInteraction(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentInteraction;
  label: string;
  componentLabel: string;
  unauthorizedReply: string;
  defer?: boolean;
}) {
  const interactionCtx = await resolveInteractionContextWithDmAuth({
    ctx: params.ctx,
    interaction: params.interaction,
    label: params.label,
    componentLabel: params.componentLabel,
    defer: params.defer,
  });
  if (!interactionCtx) {
    return null;
  }

  const { channelId, user, replyOpts, rawGuildId, memberRoleIds } = interactionCtx;
  const guildInfo = resolveDiscordGuildEntry({
    guild: params.interaction.guild ?? undefined,
    guildId: rawGuildId,
    guildEntries: params.ctx.guildEntries,
  });
  const channelCtx = resolveDiscordChannelContext(params.interaction);
  const allowNameMatching = isDangerousNameMatchingEnabled(params.ctx.discordConfig);
  const channelConfig = resolveDiscordChannelConfigWithFallback({
    guildInfo,
    channelId,
    channelName: channelCtx.channelName,
    channelSlug: channelCtx.channelSlug,
    parentId: channelCtx.parentId,
    parentName: channelCtx.parentName,
    parentSlug: channelCtx.parentSlug,
    scope: channelCtx.isThread ? "thread" : "channel",
  });
  const memberAllowed = await ensureGuildComponentMemberAllowed({
    interaction: params.interaction,
    guildInfo,
    channelId,
    rawGuildId,
    channelCtx,
    memberRoleIds,
    user,
    replyOpts,
    componentLabel: params.componentLabel,
    unauthorizedReply: params.unauthorizedReply,
    allowNameMatching,
    groupPolicy: resolveComponentRuntimeGroupPolicy(params.ctx),
  });
  if (!memberAllowed) {
    return null;
  }

  const commandAuthorized = resolveComponentCommandAuthorized({
    ctx: params.ctx,
    interactionCtx,
    channelConfig,
    guildInfo,
    allowNameMatching,
  });

  return {
    interactionCtx,
    channelCtx,
    guildInfo,
    channelConfig,
    allowNameMatching,
    commandAuthorized,
    user,
    replyOpts,
  };
}

export function resolveComponentCommandAuthorized(params: {
  ctx: AgentComponentContext;
  interactionCtx: ComponentInteractionContext;
  channelConfig: ReturnType<typeof resolveDiscordChannelConfigWithFallback>;
  guildInfo: ReturnType<typeof resolveDiscordGuildEntry>;
  allowNameMatching: boolean;
}) {
  const { ctx, interactionCtx, channelConfig, guildInfo } = params;
  if (interactionCtx.isDirectMessage) {
    return true;
  }

  const { ownerAllowList, ownerAllowed: ownerOk } = resolveDiscordOwnerAccess({
    allowFrom: ctx.allowFrom,
    sender: {
      id: interactionCtx.user.id,
      name: interactionCtx.user.username,
      tag: formatDiscordUserTag(interactionCtx.user),
    },
    allowNameMatching: params.allowNameMatching,
  });

  const { hasAccessRestrictions, memberAllowed } = resolveDiscordMemberAccessState({
    channelConfig,
    guildInfo,
    memberRoleIds: interactionCtx.memberRoleIds,
    sender: {
      id: interactionCtx.user.id,
      name: interactionCtx.user.username,
      tag: formatDiscordUserTag(interactionCtx.user),
    },
    allowNameMatching: params.allowNameMatching,
  });
  const useAccessGroups = ctx.cfg.commands?.useAccessGroups !== false;
  const authorizers = useAccessGroups
    ? [
        { configured: ownerAllowList != null, allowed: ownerOk },
        { configured: hasAccessRestrictions, allowed: memberAllowed },
      ]
    : [{ configured: hasAccessRestrictions, allowed: memberAllowed }];

  return resolveCommandAuthorizedFromAuthorizers({
    useAccessGroups,
    authorizers,
    modeWhenAccessGroupsOff: "configured",
  });
}
