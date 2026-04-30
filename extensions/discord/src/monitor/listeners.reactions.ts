import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithLists,
} from "openclaw/plugin-sdk/security-runtime";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import {
  ChannelType,
  type Client,
  MessageReactionAddListener,
  MessageReactionRemoveListener,
  type User,
} from "../internal/discord.js";
import {
  isDiscordGroupAllowedByPolicy,
  normalizeDiscordAllowList,
  normalizeDiscordSlug,
  resolveDiscordAllowListMatch,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordGuildEntry,
  resolveDiscordMemberAccessState,
  resolveGroupDmAllow,
  shouldEmitDiscordReactionNotification,
} from "./allow-list.js";
import { formatDiscordReactionEmoji, formatDiscordUserTag } from "./format.js";
import { runDiscordListenerWithSlowLog, type DiscordListenerLogger } from "./listeners.queue.js";
import { resolveFetchedDiscordThreadLikeChannelContext } from "./thread-channel-context.js";

type LoadedConfig = OpenClawConfig;
type RuntimeEnv = import("openclaw/plugin-sdk/runtime-env").RuntimeEnv;

type DiscordReactionEvent = Parameters<MessageReactionAddListener["handle"]>[0];

type DiscordReactionListenerParams = {
  cfg: LoadedConfig;
  runtime: RuntimeEnv;
  logger: DiscordListenerLogger;
  onEvent?: () => void;
} & DiscordReactionRoutingParams;

type DiscordReactionRoutingParams = {
  accountId: string;
  botUserId?: string;
  dmEnabled: boolean;
  groupDmEnabled: boolean;
  groupDmChannels: string[];
  dmPolicy: "open" | "pairing" | "allowlist" | "disabled";
  allowFrom: string[];
  groupPolicy: "open" | "allowlist" | "disabled";
  allowNameMatching: boolean;
  guildEntries?: Record<string, import("./allow-list.js").DiscordGuildEntryResolved>;
};

type DiscordReactionMode = "off" | "own" | "all" | "allowlist";
type DiscordReactionChannelConfig = ReturnType<typeof resolveDiscordChannelConfigWithFallback>;
type DiscordReactionIngressAccess = Awaited<ReturnType<typeof authorizeDiscordReactionIngress>>;
type DiscordFetchedReactionMessage = { author?: User | null } | null;

export class DiscordReactionListener extends MessageReactionAddListener {
  constructor(private params: DiscordReactionListenerParams) {
    super();
  }

  async handle(data: DiscordReactionEvent, client: Client) {
    this.params.onEvent?.();
    await runDiscordReactionHandler({
      data,
      client,
      action: "added",
      handlerParams: this.params,
      listener: this.constructor.name,
      event: this.type,
    });
  }
}

export class DiscordReactionRemoveListener extends MessageReactionRemoveListener {
  constructor(private params: DiscordReactionListenerParams) {
    super();
  }

  async handle(data: DiscordReactionEvent, client: Client) {
    this.params.onEvent?.();
    await runDiscordReactionHandler({
      data,
      client,
      action: "removed",
      handlerParams: this.params,
      listener: this.constructor.name,
      event: this.type,
    });
  }
}

async function runDiscordReactionHandler(params: {
  data: DiscordReactionEvent;
  client: Client;
  action: "added" | "removed";
  handlerParams: DiscordReactionListenerParams;
  listener: string;
  event: string;
}): Promise<void> {
  await runDiscordListenerWithSlowLog({
    logger: params.handlerParams.logger,
    listener: params.listener,
    event: params.event,
    run: async () =>
      handleDiscordReactionEvent({
        data: params.data,
        client: params.client,
        action: params.action,
        cfg: params.handlerParams.cfg,
        accountId: params.handlerParams.accountId,
        botUserId: params.handlerParams.botUserId,
        dmEnabled: params.handlerParams.dmEnabled,
        groupDmEnabled: params.handlerParams.groupDmEnabled,
        groupDmChannels: params.handlerParams.groupDmChannels,
        dmPolicy: params.handlerParams.dmPolicy,
        allowFrom: params.handlerParams.allowFrom,
        groupPolicy: params.handlerParams.groupPolicy,
        allowNameMatching: params.handlerParams.allowNameMatching,
        guildEntries: params.handlerParams.guildEntries,
        logger: params.handlerParams.logger,
      }),
  });
}

type DiscordReactionIngressAuthorizationParams = {
  accountId: string;
  user: User;
  memberRoleIds: string[];
  isDirectMessage: boolean;
  isGroupDm: boolean;
  isGuildMessage: boolean;
  channelId: string;
  channelName?: string;
  channelSlug: string;
  dmEnabled: boolean;
  groupDmEnabled: boolean;
  groupDmChannels: string[];
  dmPolicy: "open" | "pairing" | "allowlist" | "disabled";
  allowFrom: string[];
  groupPolicy: "open" | "allowlist" | "disabled";
  allowNameMatching: boolean;
  guildInfo: import("./allow-list.js").DiscordGuildEntryResolved | null;
  channelConfig?: import("./allow-list.js").DiscordChannelConfigResolved | null;
};

async function authorizeDiscordReactionIngress(
  params: DiscordReactionIngressAuthorizationParams,
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  if (params.isDirectMessage && !params.dmEnabled) {
    return { allowed: false, reason: "dm-disabled" };
  }
  if (params.isGroupDm && !params.groupDmEnabled) {
    return { allowed: false, reason: "group-dm-disabled" };
  }
  if (params.isDirectMessage) {
    const storeAllowFrom = await readStoreAllowFromForDmPolicy({
      provider: "discord",
      accountId: params.accountId,
      dmPolicy: params.dmPolicy,
    });
    const access = resolveDmGroupAccessWithLists({
      isGroup: false,
      dmPolicy: params.dmPolicy,
      groupPolicy: params.groupPolicy,
      allowFrom: params.allowFrom,
      groupAllowFrom: [],
      storeAllowFrom,
      isSenderAllowed: (allowEntries) => {
        const allowList = normalizeDiscordAllowList(allowEntries, ["discord:", "user:", "pk:"]);
        const allowMatch = allowList
          ? resolveDiscordAllowListMatch({
              allowList,
              candidate: {
                id: params.user.id,
                name: params.user.username,
                tag: formatDiscordUserTag(params.user),
              },
              allowNameMatching: params.allowNameMatching,
            })
          : { allowed: false };
        return allowMatch.allowed;
      },
    });
    if (access.decision !== "allow") {
      return { allowed: false, reason: access.reason };
    }
  }
  if (
    params.isGroupDm &&
    !resolveGroupDmAllow({
      channels: params.groupDmChannels,
      channelId: params.channelId,
      channelName: params.channelName,
      channelSlug: params.channelSlug,
    })
  ) {
    return { allowed: false, reason: "group-dm-not-allowlisted" };
  }
  if (!params.isGuildMessage) {
    return { allowed: true };
  }
  const channelAllowlistConfigured =
    Boolean(params.guildInfo?.channels) && Object.keys(params.guildInfo?.channels ?? {}).length > 0;
  const channelAllowed = params.channelConfig?.allowed !== false;
  if (
    !isDiscordGroupAllowedByPolicy({
      groupPolicy: params.groupPolicy,
      guildAllowlisted: Boolean(params.guildInfo),
      channelAllowlistConfigured,
      channelAllowed,
    })
  ) {
    return { allowed: false, reason: "guild-policy" };
  }
  if (params.channelConfig?.allowed === false) {
    return { allowed: false, reason: "guild-channel-denied" };
  }
  const { hasAccessRestrictions, memberAllowed } = resolveDiscordMemberAccessState({
    channelConfig: params.channelConfig,
    guildInfo: params.guildInfo,
    memberRoleIds: params.memberRoleIds,
    sender: {
      id: params.user.id,
      name: params.user.username,
      tag: formatDiscordUserTag(params.user),
    },
    allowNameMatching: params.allowNameMatching,
  });
  if (hasAccessRestrictions && !memberAllowed) {
    return { allowed: false, reason: "guild-member-denied" };
  }
  return { allowed: true };
}

async function handleDiscordThreadReactionNotification(params: {
  reactionMode: DiscordReactionMode;
  message: DiscordReactionEvent["message"];
  parentId?: string;
  resolveThreadChannelAccess: () => Promise<{
    access: DiscordReactionIngressAccess;
    channelConfig: DiscordReactionChannelConfig;
  }>;
  shouldNotifyReaction: (options: {
    mode: DiscordReactionMode;
    messageAuthorId?: string;
    channelConfig?: DiscordReactionChannelConfig;
  }) => boolean;
  resolveReactionBase: () => { baseText: string; contextKey: string };
  emitReaction: (text: string, parentPeerId?: string) => void;
  emitReactionWithAuthor: (message: DiscordFetchedReactionMessage) => void;
}) {
  if (params.reactionMode === "off") {
    return;
  }

  if (params.reactionMode === "all" || params.reactionMode === "allowlist") {
    const { access, channelConfig } = await params.resolveThreadChannelAccess();
    if (
      !access.allowed ||
      !params.shouldNotifyReaction({ mode: params.reactionMode, channelConfig })
    ) {
      return;
    }

    const { baseText } = params.resolveReactionBase();
    params.emitReaction(baseText, params.parentId);
    return;
  }

  const message = await params.message.fetch().catch(() => null);
  const { access, channelConfig } = await params.resolveThreadChannelAccess();
  const messageAuthorId = message?.author?.id ?? undefined;
  if (
    !access.allowed ||
    !params.shouldNotifyReaction({
      mode: params.reactionMode,
      messageAuthorId,
      channelConfig,
    })
  ) {
    return;
  }

  params.emitReactionWithAuthor(message);
}

async function handleDiscordChannelReactionNotification(params: {
  isGuildMessage: boolean;
  reactionMode: DiscordReactionMode;
  message: DiscordReactionEvent["message"];
  channelConfig: DiscordReactionChannelConfig;
  parentId?: string;
  authorizeReactionIngressForChannel: (
    channelConfig: DiscordReactionChannelConfig,
  ) => Promise<DiscordReactionIngressAccess>;
  shouldNotifyReaction: (options: {
    mode: DiscordReactionMode;
    messageAuthorId?: string;
    channelConfig?: DiscordReactionChannelConfig;
  }) => boolean;
  resolveReactionBase: () => { baseText: string; contextKey: string };
  emitReaction: (text: string, parentPeerId?: string) => void;
  emitReactionWithAuthor: (message: DiscordFetchedReactionMessage) => void;
}) {
  if (params.isGuildMessage) {
    const access = await params.authorizeReactionIngressForChannel(params.channelConfig);
    if (!access.allowed) {
      return;
    }
  }

  if (params.reactionMode === "off") {
    return;
  }

  if (params.reactionMode === "all" || params.reactionMode === "allowlist") {
    if (
      !params.shouldNotifyReaction({
        mode: params.reactionMode,
        channelConfig: params.channelConfig,
      })
    ) {
      return;
    }

    const { baseText } = params.resolveReactionBase();
    params.emitReaction(baseText, params.parentId);
    return;
  }

  const message = await params.message.fetch().catch(() => null);
  const messageAuthorId = message?.author?.id ?? undefined;
  if (
    !params.shouldNotifyReaction({
      mode: params.reactionMode,
      messageAuthorId,
      channelConfig: params.channelConfig,
    })
  ) {
    return;
  }

  params.emitReactionWithAuthor(message);
}

function hasDiscordGuildChannelOverrides(
  guildInfo: import("./allow-list.js").DiscordGuildEntryResolved | null,
) {
  return Boolean(guildInfo?.channels && Object.keys(guildInfo.channels).length > 0);
}

function shouldSkipGuildReactionBeforeChannelFetch(params: {
  reactionMode: DiscordReactionMode;
  guildInfo: import("./allow-list.js").DiscordGuildEntryResolved | null;
  groupPolicy: DiscordReactionRoutingParams["groupPolicy"];
  memberRoleIds: string[];
  user: User;
  botUserId?: string;
  allowNameMatching: boolean;
}) {
  if (params.reactionMode === "off" || params.groupPolicy === "disabled") {
    return true;
  }
  if (params.reactionMode !== "allowlist") {
    return false;
  }
  if (hasDiscordGuildChannelOverrides(params.guildInfo)) {
    return false;
  }
  return !shouldEmitDiscordReactionNotification({
    mode: params.reactionMode,
    botId: params.botUserId,
    userId: params.user.id,
    userName: params.user.username,
    userTag: formatDiscordUserTag(params.user),
    guildInfo: params.guildInfo,
    memberRoleIds: params.memberRoleIds,
    allowNameMatching: params.allowNameMatching,
  });
}

async function handleDiscordReactionEvent(
  params: {
    data: DiscordReactionEvent;
    client: Client;
    action: "added" | "removed";
    cfg: LoadedConfig;
    logger: DiscordListenerLogger;
  } & DiscordReactionRoutingParams,
) {
  try {
    const { data, client, action, botUserId, guildEntries } = params;
    if (!("user" in data)) {
      return;
    }
    const user = data.user;
    if (!user || user.bot) {
      return;
    }
    if (botUserId && user.id === botUserId) {
      return;
    }

    const isGuildMessage = Boolean(data.guild_id);
    const guildInfo = isGuildMessage
      ? resolveDiscordGuildEntry({
          guild: data.guild ?? undefined,
          guildId: data.guild_id ?? undefined,
          guildEntries,
        })
      : null;
    if (isGuildMessage && guildEntries && Object.keys(guildEntries).length > 0 && !guildInfo) {
      return;
    }
    const memberRoleIds = Array.isArray(data.rawMember?.roles)
      ? data.rawMember.roles.map((roleId: string) => roleId)
      : [];
    const reactionMode = guildInfo?.reactionNotifications ?? "own";
    if (
      isGuildMessage &&
      shouldSkipGuildReactionBeforeChannelFetch({
        reactionMode,
        guildInfo,
        groupPolicy: params.groupPolicy,
        memberRoleIds,
        user,
        botUserId,
        allowNameMatching: params.allowNameMatching,
      })
    ) {
      return;
    }

    const channel = await client.fetchChannel(data.channel_id);
    if (!channel) {
      return;
    }
    const channelContext = await resolveFetchedDiscordThreadLikeChannelContext({
      client,
      channel,
      channelIdFallback: data.channel_id,
    });
    const channelName = channelContext.channelName;
    const channelSlug = channelContext.channelSlug;
    const channelType = channelContext.channelType;
    const isDirectMessage = channelType === ChannelType.DM;
    const isGroupDm = channelType === ChannelType.GroupDM;
    const isThreadChannel = channelContext.isThreadChannel;
    const reactionIngressBase: Omit<DiscordReactionIngressAuthorizationParams, "channelConfig"> = {
      accountId: params.accountId,
      user,
      memberRoleIds,
      isDirectMessage,
      isGroupDm,
      isGuildMessage,
      channelId: data.channel_id,
      channelName,
      channelSlug,
      dmEnabled: params.dmEnabled,
      groupDmEnabled: params.groupDmEnabled,
      groupDmChannels: params.groupDmChannels,
      dmPolicy: params.dmPolicy,
      allowFrom: params.allowFrom,
      groupPolicy: params.groupPolicy,
      allowNameMatching: params.allowNameMatching,
      guildInfo,
    };
    if (!isGuildMessage) {
      const ingressAccess = await authorizeDiscordReactionIngress(reactionIngressBase);
      if (!ingressAccess.allowed) {
        logVerbose(`discord reaction blocked sender=${user.id} (reason=${ingressAccess.reason})`);
        return;
      }
    }
    const parentId = isThreadChannel ? channelContext.threadParentId : channelContext.parentId;
    const parentName = isThreadChannel ? channelContext.threadParentName : undefined;
    const parentSlug = isThreadChannel ? channelContext.threadParentSlug : "";
    let reactionBase: { baseText: string; contextKey: string } | null = null;
    const resolveReactionBase = () => {
      if (reactionBase) {
        return reactionBase;
      }
      const emojiLabel = formatDiscordReactionEmoji(data.emoji);
      const actorLabel = formatDiscordUserTag(user);
      const guildSlug =
        guildInfo?.slug ||
        (data.guild?.name
          ? normalizeDiscordSlug(data.guild.name)
          : (data.guild_id ?? (isGroupDm ? "group-dm" : "dm")));
      const channelLabel = channelSlug
        ? `#${channelSlug}`
        : channelName
          ? `#${normalizeDiscordSlug(channelName)}`
          : `#${data.channel_id}`;
      const baseText = `Discord reaction ${action}: ${emojiLabel} by ${actorLabel} on ${guildSlug} ${channelLabel} msg ${data.message_id}`;
      const contextKey = `discord:reaction:${action}:${data.message_id}:${user.id}:${emojiLabel}`;
      reactionBase = { baseText, contextKey };
      return reactionBase;
    };
    const emitReaction = (text: string, parentPeerId?: string) => {
      const { contextKey } = resolveReactionBase();
      const route = resolveAgentRoute({
        cfg: params.cfg,
        channel: "discord",
        accountId: params.accountId,
        guildId: data.guild_id ?? undefined,
        memberRoleIds,
        peer: {
          kind: isDirectMessage ? "direct" : isGroupDm ? "group" : "channel",
          id: isDirectMessage ? user.id : data.channel_id,
        },
        parentPeer: parentPeerId ? { kind: "channel", id: parentPeerId } : undefined,
      });
      enqueueSystemEvent(text, {
        sessionKey: route.sessionKey,
        contextKey,
      });
    };
    const shouldNotifyReaction = (options: {
      mode: DiscordReactionMode;
      messageAuthorId?: string;
      channelConfig?: DiscordReactionChannelConfig;
    }) =>
      shouldEmitDiscordReactionNotification({
        mode: options.mode,
        botId: botUserId,
        messageAuthorId: options.messageAuthorId,
        userId: user.id,
        userName: user.username,
        userTag: formatDiscordUserTag(user),
        channelConfig: options.channelConfig,
        guildInfo,
        memberRoleIds,
        allowNameMatching: params.allowNameMatching,
      });
    const emitReactionWithAuthor = (message: DiscordFetchedReactionMessage) => {
      const { baseText } = resolveReactionBase();
      const authorLabel = message?.author ? formatDiscordUserTag(message.author) : undefined;
      const text = authorLabel ? `${baseText} from ${authorLabel}` : baseText;
      emitReaction(text, parentId);
    };
    const resolveThreadChannelConfig = () =>
      resolveDiscordChannelConfigWithFallback({
        guildInfo,
        channelId: data.channel_id,
        channelName,
        channelSlug,
        parentId,
        parentName,
        parentSlug,
        scope: "thread",
      });
    const authorizeReactionIngressForChannel = async (
      channelConfig: DiscordReactionChannelConfig,
    ) =>
      await authorizeDiscordReactionIngress({
        ...reactionIngressBase,
        channelConfig,
      });
    const resolveThreadChannelAccess = async () => {
      const channelConfig = resolveThreadChannelConfig();
      const access = await authorizeReactionIngressForChannel(channelConfig);
      return { access, channelConfig };
    };

    if (isThreadChannel) {
      await handleDiscordThreadReactionNotification({
        reactionMode,
        message: data.message,
        parentId,
        resolveThreadChannelAccess,
        shouldNotifyReaction,
        resolveReactionBase,
        emitReaction,
        emitReactionWithAuthor,
      });
      return;
    }

    const channelConfig = resolveDiscordChannelConfigWithFallback({
      guildInfo,
      channelId: data.channel_id,
      channelName,
      channelSlug,
      parentId,
      parentName,
      parentSlug,
      scope: "channel",
    });
    await handleDiscordChannelReactionNotification({
      isGuildMessage,
      reactionMode,
      message: data.message,
      channelConfig,
      parentId,
      authorizeReactionIngressForChannel,
      shouldNotifyReaction,
      resolveReactionBase,
      emitReaction,
      emitReactionWithAuthor,
    });
  } catch (err) {
    params.logger.error(danger(`discord reaction handler failed: ${String(err)}`));
  }
}
