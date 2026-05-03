import { ChannelType } from "discord-api-types/v10";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { logError } from "openclaw/plugin-sdk/text-runtime";
import {
  type AgentComponentContext,
  type AgentComponentInteraction,
  type AgentComponentMessageInteraction,
  type ComponentInteractionContext,
  type DiscordChannelContext,
} from "./agent-components.types.js";
import { normalizeDiscordDisplaySlug, normalizeDiscordSlug } from "./allow-list.js";
import { resolveDiscordChannelInfoSafe } from "./channel-access.js";

function formatUsername(user: { username: string; discriminator?: string | null }): string {
  if (user.discriminator && user.discriminator !== "0") {
    return `${user.username}#${user.discriminator}`;
  }
  return user.username;
}

function isThreadChannelType(channelType: number | undefined): boolean {
  return (
    channelType === ChannelType.PublicThread ||
    channelType === ChannelType.PrivateThread ||
    channelType === ChannelType.AnnouncementThread
  );
}

export function resolveAgentComponentRoute(params: {
  ctx: AgentComponentContext;
  rawGuildId: string | undefined;
  memberRoleIds: string[];
  isDirectMessage: boolean;
  isGroupDm: boolean;
  userId: string;
  channelId: string;
  parentId: string | undefined;
}) {
  return resolveAgentRoute({
    cfg: params.ctx.cfg,
    channel: "discord",
    accountId: params.ctx.accountId,
    guildId: params.rawGuildId,
    memberRoleIds: params.memberRoleIds,
    peer: {
      kind: params.isDirectMessage ? "direct" : params.isGroupDm ? "group" : "channel",
      id: params.isDirectMessage ? params.userId : params.channelId,
    },
    parentPeer: params.parentId ? { kind: "channel", id: params.parentId } : undefined,
  });
}

export async function ackComponentInteraction(params: {
  interaction: AgentComponentInteraction;
  replyOpts: { ephemeral?: boolean };
  label: string;
}) {
  try {
    await params.interaction.reply({
      content: "✓",
      ...params.replyOpts,
    });
  } catch (err) {
    logError(`${params.label}: failed to acknowledge interaction: ${String(err)}`);
  }
}

export function resolveDiscordChannelContext(
  interaction: AgentComponentInteraction,
): DiscordChannelContext {
  const channel = interaction.channel;
  const channelInfo = resolveDiscordChannelInfoSafe(channel);
  const channelName = channelInfo.name;
  const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
  const displayChannelSlug = channelName ? normalizeDiscordDisplaySlug(channelName) : "";
  const channelType = channelInfo.type;
  const isThread = isThreadChannelType(channelType);

  let parentId: string | undefined;
  let parentName: string | undefined;
  let parentSlug = "";
  if (isThread) {
    parentId = channelInfo.parentId;
    parentName = channelInfo.parentName;
    if (parentName) {
      parentSlug = normalizeDiscordSlug(parentName);
    }
  }

  return {
    channelName,
    channelSlug,
    displayChannelSlug,
    channelType,
    isThread,
    parentId,
    parentName,
    parentSlug,
  };
}

export async function resolveComponentInteractionContext(params: {
  interaction: AgentComponentInteraction;
  label: string;
  defer?: boolean;
}): Promise<ComponentInteractionContext | null> {
  const { interaction, label } = params;
  const channelId = interaction.rawData.channel_id;
  if (!channelId) {
    logError(`${label}: missing channel_id in interaction`);
    return null;
  }

  const user = interaction.user;
  if (!user) {
    logError(`${label}: missing user in interaction`);
    return null;
  }

  const shouldDefer = params.defer !== false && "defer" in interaction;
  let didDefer = false;
  if (shouldDefer) {
    try {
      await (interaction as AgentComponentMessageInteraction).defer({ ephemeral: true });
      didDefer = true;
    } catch (err) {
      logError(`${label}: failed to defer interaction: ${String(err)}`);
    }
  }
  const replyOpts = didDefer ? {} : { ephemeral: true };

  const username = formatUsername(user);
  const userId = user.id;
  const rawGuildId = interaction.rawData.guild_id;
  const channelType = resolveDiscordChannelContext(interaction).channelType;
  const isGroupDm = channelType === ChannelType.GroupDM;
  const isDirectMessage =
    channelType === ChannelType.DM || (!rawGuildId && !isGroupDm && channelType == null);
  const memberRoleIds = Array.isArray(interaction.rawData.member?.roles)
    ? interaction.rawData.member.roles.map((roleId: string) => roleId)
    : [];

  return {
    channelId,
    user,
    username,
    userId,
    replyOpts,
    rawGuildId,
    isDirectMessage,
    isGroupDm,
    memberRoleIds,
  };
}
