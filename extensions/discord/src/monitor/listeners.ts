import {
  ChannelType,
  type Client,
  MessageCreateListener,
  MessageReactionAddListener,
  MessageReactionRemoveListener,
  PresenceUpdateListener,
  ThreadUpdateListener,
  type User,
} from "@buape/carbon";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/infra-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import {
  createSubsystemLogger,
  danger,
  formatDurationSeconds,
  logVerbose,
} from "openclaw/plugin-sdk/runtime-env";
import {
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithLists,
} from "openclaw/plugin-sdk/security-runtime";
import {
  isDiscordGroupAllowedByPolicy,
  normalizeDiscordAllowList,
  normalizeDiscordSlug,
  resolveDiscordAllowListMatch,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordMemberAccessState,
  resolveGroupDmAllow,
  resolveDiscordGuildEntry,
  shouldEmitDiscordReactionNotification,
} from "./allow-list.js";
import { formatDiscordReactionEmoji, formatDiscordUserTag } from "./format.js";
import { resolveDiscordChannelInfo } from "./message-utils.js";
import { setPresence } from "./presence-cache.js";
import { isThreadArchived } from "./thread-bindings.discord-api.js";
import { closeDiscordThreadSessions } from "./thread-session-close.js";
import { normalizeDiscordListenerTimeoutMs, runDiscordTaskWithTimeout } from "./timeouts.js";

type LoadedConfig = ReturnType<typeof import("openclaw/plugin-sdk/config-runtime").loadConfig>;
type RuntimeEnv = import("openclaw/plugin-sdk/runtime-env").RuntimeEnv;
type Logger = ReturnType<typeof import("openclaw/plugin-sdk/runtime-env").createSubsystemLogger>;

export type DiscordMessageEvent = Parameters<MessageCreateListener["handle"]>[0];

export type DiscordMessageHandler = (
  data: DiscordMessageEvent,
  client: Client,
  options?: { abortSignal?: AbortSignal },
) => Promise<void>;

type DiscordReactionEvent = Parameters<MessageReactionAddListener["handle"]>[0];

type DiscordReactionListenerParams = {
  cfg: LoadedConfig;
  runtime: RuntimeEnv;
  logger: Logger;
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

const DISCORD_SLOW_LISTENER_THRESHOLD_MS = 30_000;
const discordEventQueueLog = createSubsystemLogger("discord/event-queue");

function formatListenerContextValue(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return null;
}

function formatListenerContextSuffix(context?: Record<string, unknown>): string {
  if (!context) {
    return "";
  }
  const entries = Object.entries(context).flatMap(([key, value]) => {
    const formatted = formatListenerContextValue(value);
    return formatted ? [`${key}=${formatted}`] : [];
  });
  if (entries.length === 0) {
    return "";
  }
  return ` (${entries.join(" ")})`;
}

function logSlowDiscordListener(params: {
  logger: Logger | undefined;
  listener: string;
  event: string;
  durationMs: number;
  context?: Record<string, unknown>;
}) {
  if (params.durationMs < DISCORD_SLOW_LISTENER_THRESHOLD_MS) {
    return;
  }
  const duration = formatDurationSeconds(params.durationMs, {
    decimals: 1,
    unit: "seconds",
  });
  const message = `Slow listener detected: ${params.listener} took ${duration} for event ${params.event}`;
  const logger = params.logger ?? discordEventQueueLog;
  logger.warn("Slow listener detected", {
    listener: params.listener,
    event: params.event,
    durationMs: params.durationMs,
    duration,
    ...params.context,
    consoleMessage: `${message}${formatListenerContextSuffix(params.context)}`,
  });
}

async function runDiscordListenerWithSlowLog(params: {
  logger: Logger | undefined;
  listener: string;
  event: string;
  run: (abortSignal: AbortSignal | undefined) => Promise<void>;
  timeoutMs?: number;
  context?: Record<string, unknown>;
  onError?: (err: unknown) => void;
}) {
  const startedAt = Date.now();
  const timeoutMs = normalizeDiscordListenerTimeoutMs(params.timeoutMs);
  const logger = params.logger ?? discordEventQueueLog;
  let timedOut = false;

  try {
    timedOut = await runDiscordTaskWithTimeout({
      run: params.run,
      timeoutMs,
      onTimeout: (resolvedTimeoutMs) => {
        logger.error(
          danger(
            `discord handler timed out after ${formatDurationSeconds(resolvedTimeoutMs, {
              decimals: 1,
              unit: "seconds",
            })}${formatListenerContextSuffix(params.context)}`,
          ),
        );
      },
      onAbortAfterTimeout: () => {
        logger.warn(
          `discord handler canceled after timeout${formatListenerContextSuffix(params.context)}`,
        );
      },
      onErrorAfterTimeout: (err) => {
        logger.error(
          danger(
            `discord handler failed after timeout: ${String(err)}${formatListenerContextSuffix(params.context)}`,
          ),
        );
      },
    });
    if (timedOut) {
      return;
    }
  } catch (err) {
    if (params.onError) {
      params.onError(err);
      return;
    }
    throw err;
  } finally {
    if (!timedOut) {
      logSlowDiscordListener({
        logger: params.logger,
        listener: params.listener,
        event: params.event,
        durationMs: Date.now() - startedAt,
        context: params.context,
      });
    }
  }
}

export function registerDiscordListener(listeners: Array<object>, listener: object) {
  if (listeners.some((existing) => existing.constructor === listener.constructor)) {
    return false;
  }
  listeners.push(listener);
  return true;
}

export class DiscordMessageListener extends MessageCreateListener {
  constructor(
    private handler: DiscordMessageHandler,
    private logger?: Logger,
    private onEvent?: () => void,
    _options?: { timeoutMs?: number },
  ) {
    super();
  }

  async handle(data: DiscordMessageEvent, client: Client) {
    this.onEvent?.();
    // Fire-and-forget: hand off to the handler without blocking the
    // Carbon listener.  Per-session ordering and run timeouts are owned
    // by the inbound worker queue, so the listener no longer serializes
    // or applies its own timeout.
    void Promise.resolve()
      .then(() => this.handler(data, client))
      .catch((err) => {
        const logger = this.logger ?? discordEventQueueLog;
        logger.error(danger(`discord handler failed: ${String(err)}`));
      });
  }
}

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

async function handleDiscordReactionEvent(
  params: {
    data: DiscordReactionEvent;
    client: Client;
    action: "added" | "removed";
    cfg: LoadedConfig;
    logger: Logger;
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

    // Early exit: skip bot's own reactions before expensive network calls
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

    const channel = await client.fetchChannel(data.channel_id);
    if (!channel) {
      return;
    }
    const channelName = "name" in channel ? (channel.name ?? undefined) : undefined;
    const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
    const channelType = "type" in channel ? channel.type : undefined;
    const isDirectMessage = channelType === ChannelType.DM;
    const isGroupDm = channelType === ChannelType.GroupDM;
    const isThreadChannel =
      channelType === ChannelType.PublicThread ||
      channelType === ChannelType.PrivateThread ||
      channelType === ChannelType.AnnouncementThread;
    const memberRoleIds = Array.isArray(data.rawMember?.roles)
      ? data.rawMember.roles.map((roleId: string) => roleId)
      : [];
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
    // Guild reactions need resolved channel/thread config before member access
    // can mirror the normal message preflight path.
    if (!isGuildMessage) {
      const ingressAccess = await authorizeDiscordReactionIngress(reactionIngressBase);
      if (!ingressAccess.allowed) {
        logVerbose(`discord reaction blocked sender=${user.id} (reason=${ingressAccess.reason})`);
        return;
      }
    }
    let parentId = "parentId" in channel ? (channel.parentId ?? undefined) : undefined;
    let parentName: string | undefined;
    let parentSlug = "";
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
      mode: "off" | "own" | "all" | "allowlist";
      messageAuthorId?: string;
      channelConfig?: ReturnType<typeof resolveDiscordChannelConfigWithFallback>;
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
    const emitReactionWithAuthor = (message: { author?: User } | null) => {
      const { baseText } = resolveReactionBase();
      const authorLabel = message?.author ? formatDiscordUserTag(message.author) : undefined;
      const text = authorLabel ? `${baseText} from ${authorLabel}` : baseText;
      emitReaction(text, parentId);
    };
    const loadThreadParentInfo = async () => {
      if (!parentId) {
        return;
      }
      const parentInfo = await resolveDiscordChannelInfo(client, parentId);
      parentName = parentInfo?.name;
      parentSlug = parentName ? normalizeDiscordSlug(parentName) : "";
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
      channelConfig: ReturnType<typeof resolveDiscordChannelConfigWithFallback>,
    ) =>
      await authorizeDiscordReactionIngress({
        ...reactionIngressBase,
        channelConfig,
      });
    const resolveThreadChannelAccess = async (channelInfo: { parentId?: string } | null) => {
      parentId = channelInfo?.parentId;
      await loadThreadParentInfo();
      const channelConfig = resolveThreadChannelConfig();
      const access = await authorizeReactionIngressForChannel(channelConfig);
      return { access, channelConfig };
    };

    // Parallelize async operations for thread channels
    if (isThreadChannel) {
      const reactionMode = guildInfo?.reactionNotifications ?? "own";

      // Early exit: skip fetching message if notifications are off
      if (reactionMode === "off") {
        return;
      }

      const channelInfoPromise = parentId
        ? Promise.resolve({ parentId })
        : resolveDiscordChannelInfo(client, data.channel_id);

      // Fast path: for "all" and "allowlist" modes, we don't need to fetch the message
      if (reactionMode === "all" || reactionMode === "allowlist") {
        const channelInfo = await channelInfoPromise;
        const { access: threadAccess, channelConfig: threadChannelConfig } =
          await resolveThreadChannelAccess(channelInfo);
        if (!threadAccess.allowed) {
          return;
        }
        if (
          !shouldNotifyReaction({
            mode: reactionMode,
            channelConfig: threadChannelConfig,
          })
        ) {
          return;
        }

        const { baseText } = resolveReactionBase();
        emitReaction(baseText, parentId);
        return;
      }

      // For "own" mode, we need to fetch the message to check the author
      const messagePromise = data.message.fetch().catch(() => null);

      const [channelInfo, message] = await Promise.all([channelInfoPromise, messagePromise]);
      const { access: threadAccess, channelConfig: threadChannelConfig } =
        await resolveThreadChannelAccess(channelInfo);
      if (!threadAccess.allowed) {
        return;
      }

      const messageAuthorId = message?.author?.id ?? undefined;
      if (
        !shouldNotifyReaction({
          mode: reactionMode,
          messageAuthorId,
          channelConfig: threadChannelConfig,
        })
      ) {
        return;
      }

      emitReactionWithAuthor(message);
      return;
    }

    // Non-thread channel path
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
    if (isGuildMessage) {
      const channelAccess = await authorizeReactionIngressForChannel(channelConfig);
      if (!channelAccess.allowed) {
        return;
      }
    }

    const reactionMode = guildInfo?.reactionNotifications ?? "own";

    // Early exit: skip fetching message if notifications are off
    if (reactionMode === "off") {
      return;
    }

    // Fast path: for "all" and "allowlist" modes, we don't need to fetch the message
    if (reactionMode === "all" || reactionMode === "allowlist") {
      if (!shouldNotifyReaction({ mode: reactionMode, channelConfig })) {
        return;
      }

      const { baseText } = resolveReactionBase();
      emitReaction(baseText, parentId);
      return;
    }

    // For "own" mode, we need to fetch the message to check the author
    const message = await data.message.fetch().catch(() => null);
    const messageAuthorId = message?.author?.id ?? undefined;
    if (!shouldNotifyReaction({ mode: reactionMode, messageAuthorId, channelConfig })) {
      return;
    }

    emitReactionWithAuthor(message);
  } catch (err) {
    params.logger.error(danger(`discord reaction handler failed: ${String(err)}`));
  }
}

type PresenceUpdateEvent = Parameters<PresenceUpdateListener["handle"]>[0];

export class DiscordPresenceListener extends PresenceUpdateListener {
  private logger?: Logger;
  private accountId?: string;

  constructor(params: { logger?: Logger; accountId?: string }) {
    super();
    this.logger = params.logger;
    this.accountId = params.accountId;
  }

  async handle(data: PresenceUpdateEvent) {
    try {
      const userId =
        "user" in data && data.user && typeof data.user === "object" && "id" in data.user
          ? String(data.user.id)
          : undefined;
      if (!userId) {
        return;
      }
      setPresence(
        this.accountId,
        userId,
        data as import("discord-api-types/v10").GatewayPresenceUpdate,
      );
    } catch (err) {
      const logger = this.logger ?? discordEventQueueLog;
      logger.error(danger(`discord presence handler failed: ${String(err)}`));
    }
  }
}

type ThreadUpdateEvent = Parameters<ThreadUpdateListener["handle"]>[0];

export class DiscordThreadUpdateListener extends ThreadUpdateListener {
  constructor(
    private cfg: OpenClawConfig,
    private accountId: string,
    private logger?: Logger,
  ) {
    super();
  }

  async handle(data: ThreadUpdateEvent) {
    await runDiscordListenerWithSlowLog({
      logger: this.logger,
      listener: this.constructor.name,
      event: this.type,
      run: async () => {
        // Discord only fires THREAD_UPDATE when a field actually changes, so
        // `thread_metadata.archived === true` in this payload means the thread
        // just transitioned to the archived state.
        if (!isThreadArchived(data)) {
          return;
        }
        const threadId = "id" in data && typeof data.id === "string" ? data.id : undefined;
        if (!threadId) {
          return;
        }
        const logger = this.logger ?? discordEventQueueLog;
        const count = await closeDiscordThreadSessions({
          cfg: this.cfg,
          accountId: this.accountId,
          threadId,
        });
        if (count > 0) {
          logger.info("Discord thread archived — reset sessions", { threadId, count });
        }
      },
      onError: (err) => {
        const logger = this.logger ?? discordEventQueueLog;
        logger.error(danger(`discord thread-update handler failed: ${String(err)}`));
      },
    });
  }
}
