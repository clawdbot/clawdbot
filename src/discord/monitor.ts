import {
  ChannelType,
  Client,
  Command,
  type CommandInteraction,
  type CommandOptions,
  type Guild,
  type Message,
  MessageCreateListener,
  MessageReactionAddListener,
  MessageReactionRemoveListener,
  MessageType,
  type RequestClient,
  type User,
} from "@buape/carbon";
import { GatewayIntents, GatewayPlugin } from "@buape/carbon/gateway";
import type { APIAttachment } from "discord-api-types/v10";
import { ApplicationCommandOptionType, Routes } from "discord-api-types/v10";

import {
  resolveAckReaction,
  resolveEffectiveMessagesConfig,
  resolveHumanDelayConfig,
} from "../agents/identity.js";
import { resolveTextChunkLimit } from "../auto-reply/chunk.js";
import { hasControlCommand } from "../auto-reply/command-detection.js";
import {
  buildCommandText,
  listNativeCommandSpecs,
  shouldHandleTextCommands,
} from "../auto-reply/commands-registry.js";
import {
  formatAgentEnvelope,
  formatThreadStarterEnvelope,
} from "../auto-reply/envelope.js";
import { dispatchReplyFromConfig } from "../auto-reply/reply/dispatch-from-config.js";
import {
  buildHistoryContextFromMap,
  clearHistoryEntries,
  type HistoryEntry,
} from "../auto-reply/reply/history.js";
import {
  buildMentionRegexes,
  matchesMentionPatterns,
} from "../auto-reply/reply/mentions.js";
import {
  createReplyDispatcher,
  createReplyDispatcherWithTyping,
} from "../auto-reply/reply/reply-dispatcher.js";
import { getReplyFromConfig } from "../auto-reply/reply.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { ClawdbotConfig, ReplyToMode } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { resolveStorePath, updateLastRoute } from "../config/sessions.js";
import { danger, logVerbose, shouldLogVerbose } from "../globals.js";
import { formatDurationSeconds } from "../infra/format-duration.js";
import { recordProviderActivity } from "../infra/provider-activity.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { getChildLogger } from "../logging.js";
import { fetchRemoteMedia } from "../media/fetch.js";
import { saveMediaBuffer } from "../media/store.js";
import { buildPairingReply } from "../pairing/pairing-messages.js";
import {
  readProviderAllowFromStore,
  upsertProviderPairingRequest,
} from "../pairing/pairing-store.js";
import {
  buildAgentSessionKey,
  resolveAgentRoute,
} from "../routing/resolve-route.js";
import { resolveThreadSessionKeys } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { truncateUtf16Safe } from "../utils.js";
import { loadWebMedia } from "../web/media.js";
import { resolveDiscordAccount } from "./accounts.js";
import { chunkDiscordText } from "./chunk.js";
import { attachDiscordGatewayLogging } from "./gateway-logging.js";
import {
  getDiscordGatewayEmitter,
  waitForDiscordGatewayStop,
} from "./monitor.gateway.js";
import { fetchDiscordApplicationId } from "./probe.js";
import {
  reactMessageDiscord,
  removeReactionDiscord,
  sendMessageDiscord,
} from "./send.js";
import { normalizeDiscordToken } from "./token.js";

export type MonitorDiscordOpts = {
  token?: string;
  accountId?: string;
  config?: ClawdbotConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  mediaMaxMb?: number;
  historyLimit?: number;
  replyToMode?: ReplyToMode;
};

type DiscordMediaInfo = {
  path: string;
  contentType?: string;
  placeholder: string;
};

type DiscordSnapshotAuthor = {
  id?: string | null;
  username?: string | null;
  discriminator?: string | null;
  global_name?: string | null;
  name?: string | null;
};

type DiscordSnapshotMessage = {
  content?: string | null;
  embeds?: Array<{ description?: string | null; title?: string | null }> | null;
  attachments?: APIAttachment[] | null;
  author?: DiscordSnapshotAuthor | null;
};

type DiscordMessageSnapshot = {
  message?: DiscordSnapshotMessage | null;
};
type DiscordReactionEvent = Parameters<MessageReactionAddListener["handle"]>[0];
type DiscordThreadChannel = {
  id: string;
  name?: string | null;
  parentId?: string | null;
  parent?: { id?: string; name?: string };
};
type DiscordThreadStarter = {
  text: string;
  author: string;
  timestamp?: number;
};

type DiscordChannelInfo = {
  type: ChannelType;
  name?: string;
  topic?: string;
  parentId?: string;
};

const DISCORD_THREAD_STARTER_CACHE = new Map<string, DiscordThreadStarter>();
const DISCORD_CHANNEL_INFO_CACHE_TTL_MS = 5 * 60 * 1000;
const DISCORD_CHANNEL_INFO_NEGATIVE_CACHE_TTL_MS = 30 * 1000;
const DISCORD_CHANNEL_INFO_CACHE = new Map<
  string,
  { value: DiscordChannelInfo | null; expiresAt: number }
>();
const DISCORD_SLOW_LISTENER_THRESHOLD_MS = 1000;

function logSlowDiscordListener(params: {
  logger: ReturnType<typeof getChildLogger> | undefined;
  listener: string;
  event: string;
  durationMs: number;
}) {
  if (params.durationMs < DISCORD_SLOW_LISTENER_THRESHOLD_MS) return;
  const duration = formatDurationSeconds(params.durationMs, {
    decimals: 1,
    unit: "seconds",
  });
  const message = `[EventQueue] Slow listener detected: ${params.listener} took ${duration} for event ${params.event}`;
  if (params.logger?.warn) {
    params.logger.warn(message);
  } else {
    console.warn(message);
  }
}

async function resolveDiscordThreadStarter(params: {
  channel: DiscordThreadChannel;
  client: Client;
  parentId?: string;
  parentType?: ChannelType;
}): Promise<DiscordThreadStarter | null> {
  const cacheKey = params.channel.id;
  const cached = DISCORD_THREAD_STARTER_CACHE.get(cacheKey);
  if (cached) return cached;
  try {
    const parentType = params.parentType;
    const isForumParent =
      parentType === ChannelType.GuildForum ||
      parentType === ChannelType.GuildMedia;
    const messageChannelId = isForumParent
      ? params.channel.id
      : params.parentId;
    if (!messageChannelId) return null;
    const starter = (await params.client.rest.get(
      Routes.channelMessage(messageChannelId, params.channel.id),
    )) as {
      content?: string | null;
      embeds?: Array<{ description?: string | null }>;
      member?: { nick?: string | null; displayName?: string | null };
      author?: {
        id?: string | null;
        username?: string | null;
        discriminator?: string | null;
      };
      timestamp?: string | null;
    };
    if (!starter) return null;
    const text =
      starter.content?.trim() ?? starter.embeds?.[0]?.description?.trim() ?? "";
    if (!text) return null;
    const author =
      starter.member?.nick ??
      starter.member?.displayName ??
      (starter.author
        ? starter.author.discriminator && starter.author.discriminator !== "0"
          ? `${starter.author.username ?? "Unknown"}#${starter.author.discriminator}`
          : (starter.author.username ?? starter.author.id ?? "Unknown")
        : "Unknown");
    const timestamp = resolveTimestampMs(starter.timestamp);
    const payload: DiscordThreadStarter = {
      text,
      author,
      timestamp: timestamp ?? undefined,
    };
    DISCORD_THREAD_STARTER_CACHE.set(cacheKey, payload);
    return payload;
  } catch {
    return null;
  }
}

export type DiscordAllowList = {
  allowAll: boolean;
  ids: Set<string>;
  names: Set<string>;
};

export type DiscordGuildEntryResolved = {
  id?: string;
  slug?: string;
  requireMention?: boolean;
  reactionNotifications?: "off" | "own" | "all" | "allowlist";
  users?: Array<string | number>;
  channels?: Record<
    string,
    {
      allow?: boolean;
      requireMention?: boolean;
      skills?: string[];
      enabled?: boolean;
      users?: Array<string | number>;
      systemPrompt?: string;
    }
  >;
};

export type DiscordChannelConfigResolved = {
  allowed: boolean;
  requireMention?: boolean;
  skills?: string[];
  enabled?: boolean;
  users?: Array<string | number>;
  systemPrompt?: string;
};

export type DiscordMessageEvent = Parameters<
  MessageCreateListener["handle"]
>[0];

export type DiscordMessageHandler = (
  data: DiscordMessageEvent,
  client: Client,
) => Promise<void>;

function isDiscordThreadType(type: ChannelType | undefined): boolean {
  return (
    type === ChannelType.PublicThread ||
    type === ChannelType.PrivateThread ||
    type === ChannelType.AnnouncementThread
  );
}

type DiscordThreadParentInfo = {
  id?: string;
  name?: string;
  type?: ChannelType;
};

function resolveDiscordThreadChannel(params: {
  isGuildMessage: boolean;
  message: DiscordMessageEvent["message"];
  channelInfo: DiscordChannelInfo | null;
}): DiscordThreadChannel | null {
  if (!params.isGuildMessage) return null;
  const { message, channelInfo } = params;
  const channel =
    "channel" in message
      ? (message as { channel?: unknown }).channel
      : undefined;
  const isThreadChannel =
    channel &&
    typeof channel === "object" &&
    "isThread" in channel &&
    typeof (channel as { isThread?: unknown }).isThread === "function" &&
    (channel as { isThread: () => boolean }).isThread();
  if (isThreadChannel) return channel as unknown as DiscordThreadChannel;
  if (!isDiscordThreadType(channelInfo?.type)) return null;
  return {
    id: message.channelId,
    name: channelInfo?.name ?? undefined,
    parentId: channelInfo?.parentId ?? undefined,
    parent: undefined,
  };
}

async function resolveDiscordThreadParentInfo(params: {
  client: Client;
  threadChannel: DiscordThreadChannel;
  channelInfo: DiscordChannelInfo | null;
}): Promise<DiscordThreadParentInfo> {
  const { threadChannel, channelInfo, client } = params;
  const parentId =
    threadChannel.parentId ??
    threadChannel.parent?.id ??
    channelInfo?.parentId ??
    undefined;
  if (!parentId) return {};
  let parentName = threadChannel.parent?.name;
  const parentInfo = await resolveDiscordChannelInfo(client, parentId);
  parentName = parentName ?? parentInfo?.name;
  const parentType = parentInfo?.type;
  return { id: parentId, name: parentName, type: parentType };
}

export function resolveDiscordReplyTarget(opts: {
  replyToMode: ReplyToMode;
  replyToId?: string;
  hasReplied: boolean;
}): string | undefined {
  if (opts.replyToMode === "off") return undefined;
  const replyToId = opts.replyToId?.trim();
  if (!replyToId) return undefined;
  if (opts.replyToMode === "all") return replyToId;
  return opts.hasReplied ? undefined : replyToId;
}

function summarizeAllowList(list?: Array<string | number>) {
  if (!list || list.length === 0) return "any";
  const sample = list.slice(0, 4).map((entry) => String(entry));
  const suffix =
    list.length > sample.length ? ` (+${list.length - sample.length})` : "";
  return `${sample.join(", ")}${suffix}`;
}

function summarizeGuilds(entries?: Record<string, DiscordGuildEntryResolved>) {
  if (!entries || Object.keys(entries).length === 0) return "any";
  const keys = Object.keys(entries);
  const sample = keys.slice(0, 4);
  const suffix =
    keys.length > sample.length ? ` (+${keys.length - sample.length})` : "";
  return `${sample.join(", ")}${suffix}`;
}

export async function monitorDiscordProvider(opts: MonitorDiscordOpts = {}) {
  const cfg = opts.config ?? loadConfig();
  const account = resolveDiscordAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = normalizeDiscordToken(opts.token ?? undefined) ?? account.token;
  if (!token) {
    throw new Error(
      `Discord bot token missing for account "${account.accountId}" (set discord.accounts.${account.accountId}.token or DISCORD_BOT_TOKEN for default).`,
    );
  }

  const runtime: RuntimeEnv = opts.runtime ?? {
    log: console.log,
    error: console.error,
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };

  const discordCfg = account.config;
  const dmConfig = discordCfg.dm;
  const guildEntries = discordCfg.guilds;
  const groupPolicy = discordCfg.groupPolicy ?? "open";
  const allowFrom = dmConfig?.allowFrom;
  const mediaMaxBytes =
    (opts.mediaMaxMb ?? discordCfg.mediaMaxMb ?? 8) * 1024 * 1024;
  const textLimit = resolveTextChunkLimit(cfg, "discord", account.accountId);
  const historyLimit = Math.max(
    0,
    opts.historyLimit ??
      discordCfg.historyLimit ??
      cfg.messages?.groupChat?.historyLimit ??
      20,
  );
  const replyToMode = opts.replyToMode ?? discordCfg.replyToMode ?? "off";
  const dmEnabled = dmConfig?.enabled ?? true;
  const dmPolicy = dmConfig?.policy ?? "pairing";
  const groupDmEnabled = dmConfig?.groupEnabled ?? false;
  const groupDmChannels = dmConfig?.groupChannels;
  const nativeEnabled = cfg.commands?.native === true;
  const nativeDisabledExplicit = cfg.commands?.native === false;
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const sessionPrefix = "discord:slash";
  const ephemeralDefault = true;

  if (shouldLogVerbose()) {
    logVerbose(
      `discord: config dm=${dmEnabled ? "on" : "off"} dmPolicy=${dmPolicy} allowFrom=${summarizeAllowList(allowFrom)} groupDm=${groupDmEnabled ? "on" : "off"} groupDmChannels=${summarizeAllowList(groupDmChannels)} groupPolicy=${groupPolicy} guilds=${summarizeGuilds(guildEntries)} historyLimit=${historyLimit} mediaMaxMb=${Math.round(mediaMaxBytes / (1024 * 1024))} native=${nativeEnabled ? "on" : "off"} accessGroups=${useAccessGroups ? "on" : "off"}`,
    );
  }

  const applicationId = await fetchDiscordApplicationId(token, 4000);
  if (!applicationId) {
    throw new Error("Failed to resolve Discord application id");
  }

  const commandSpecs = nativeEnabled ? listNativeCommandSpecs() : [];
  const commands = commandSpecs.map((spec) =>
    createDiscordNativeCommand({
      command: spec,
      cfg,
      discordConfig: discordCfg,
      accountId: account.accountId,
      sessionPrefix,
      ephemeralDefault,
    }),
  );

  const client = new Client(
    {
      baseUrl: "http://localhost",
      deploySecret: "a",
      clientId: applicationId,
      publicKey: "a",
      token,
      autoDeploy: nativeEnabled,
    },
    {
      commands,
      listeners: [],
    },
    [
      new GatewayPlugin({
        reconnect: {
          maxAttempts: Number.POSITIVE_INFINITY,
        },
        intents:
          GatewayIntents.Guilds |
          GatewayIntents.GuildMessages |
          GatewayIntents.MessageContent |
          GatewayIntents.DirectMessages |
          GatewayIntents.GuildMessageReactions |
          GatewayIntents.DirectMessageReactions,
        autoInteractions: true,
      }),
    ],
  );

  const logger = getChildLogger({ module: "discord-auto-reply" });
  const guildHistories = new Map<string, HistoryEntry[]>();
  let botUserId: string | undefined;

  if (nativeDisabledExplicit) {
    await clearDiscordNativeCommands({
      client,
      applicationId,
      runtime,
    });
  }

  try {
    const botUser = await client.fetchUser("@me");
    botUserId = botUser?.id;
  } catch (err) {
    runtime.error?.(
      danger(`discord: failed to fetch bot identity: ${String(err)}`),
    );
  }

  const messageHandler = createDiscordMessageHandler({
    cfg,
    discordConfig: discordCfg,
    accountId: account.accountId,
    token,
    runtime,
    botUserId,
    guildHistories,
    historyLimit,
    mediaMaxBytes,
    textLimit,
    replyToMode,
    dmEnabled,
    groupDmEnabled,
    groupDmChannels,
    allowFrom,
    guildEntries,
  });

  client.listeners.push(new DiscordMessageListener(messageHandler, logger));
  client.listeners.push(
    new DiscordReactionListener({
      cfg,
      accountId: account.accountId,
      runtime,
      botUserId,
      guildEntries,
      logger,
    }),
  );
  client.listeners.push(
    new DiscordReactionRemoveListener({
      cfg,
      accountId: account.accountId,
      runtime,
      botUserId,
      guildEntries,
      logger,
    }),
  );

  runtime.log?.(`logged in to discord${botUserId ? ` as ${botUserId}` : ""}`);

  const gateway = client.getPlugin<GatewayPlugin>("gateway");
  const gatewayEmitter = getDiscordGatewayEmitter(gateway);
  const stopGatewayLogging = attachDiscordGatewayLogging({
    emitter: gatewayEmitter,
    runtime,
  });
  // Timeout to detect zombie connections where HELLO is never received.
  const HELLO_TIMEOUT_MS = 30000;
  let helloTimeoutId: ReturnType<typeof setTimeout> | undefined;
  const onGatewayDebug = (msg: unknown) => {
    const message = String(msg);
    if (!message.includes("WebSocket connection opened")) return;
    if (helloTimeoutId) clearTimeout(helloTimeoutId);
    helloTimeoutId = setTimeout(() => {
      if (!gateway?.isConnected) {
        runtime.log?.(
          danger(
            `[discord] connection stalled: no HELLO received within ${HELLO_TIMEOUT_MS}ms, forcing reconnect`,
          ),
        );
        gateway?.disconnect();
        gateway?.connect(false);
      }
      helloTimeoutId = undefined;
    }, HELLO_TIMEOUT_MS);
  };
  gatewayEmitter?.on("debug", onGatewayDebug);
  try {
    await waitForDiscordGatewayStop({
      gateway: gateway
        ? {
            emitter: gatewayEmitter,
            disconnect: () => gateway.disconnect(),
          }
        : undefined,
      abortSignal: opts.abortSignal,
      onGatewayError: (err) => {
        runtime.error?.(danger(`discord gateway error: ${String(err)}`));
      },
      shouldStopOnError: (err) => {
        const message = String(err);
        return (
          message.includes("Max reconnect attempts") ||
          message.includes("Fatal Gateway error")
        );
      },
    });
  } finally {
    stopGatewayLogging();
    stopGatewayLogging();
    if (helloTimeoutId) clearTimeout(helloTimeoutId);
    gatewayEmitter?.removeListener("debug", onGatewayDebug);
  }
}

async function clearDiscordNativeCommands(params: {
  client: Client;
  applicationId: string;
  runtime: RuntimeEnv;
}) {
  try {
    await params.client.rest.put(
      Routes.applicationCommands(params.applicationId),
      {
        body: [],
      },
    );
    logVerbose("discord: cleared native commands (commands.native=false)");
  } catch (err) {
    params.runtime.error?.(
      danger(`discord: failed to clear native commands: ${String(err)}`),
    );
  }
}

export function createDiscordMessageHandler(params: {
  cfg: ReturnType<typeof loadConfig>;
  discordConfig: ClawdbotConfig["discord"];
  accountId: string;
  token: string;
  runtime: RuntimeEnv;
  botUserId?: string;
  guildHistories: Map<string, HistoryEntry[]>;
  historyLimit: number;
  mediaMaxBytes: number;
  textLimit: number;
  replyToMode: ReplyToMode;
  dmEnabled: boolean;
  groupDmEnabled: boolean;
  groupDmChannels?: Array<string | number>;
  allowFrom?: Array<string | number>;
  guildEntries?: Record<string, DiscordGuildEntryResolved>;
}): DiscordMessageHandler {
  const {
    cfg,
    discordConfig,
    accountId,
    token,
    runtime,
    botUserId,
    guildHistories,
    historyLimit,
    mediaMaxBytes,
    textLimit,
    replyToMode,
    dmEnabled,
    groupDmEnabled,
    groupDmChannels,
    allowFrom,
    guildEntries,
  } = params;
  const logger = getChildLogger({ module: "discord-auto-reply" });
  const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
  const groupPolicy = discordConfig?.groupPolicy ?? "open";

  return async (data, client) => {
    try {
      const message = data.message;
      const author = data.author;
      if (!author || author.bot) return;

      const isGuildMessage = Boolean(data.guild_id);
      const channelInfo = await resolveDiscordChannelInfo(
        client,
        message.channelId,
      );
      const isDirectMessage = channelInfo?.type === ChannelType.DM;
      const isGroupDm = channelInfo?.type === ChannelType.GroupDM;

      if (isGroupDm && !groupDmEnabled) {
        logVerbose("discord: drop group dm (group dms disabled)");
        return;
      }
      if (isDirectMessage && !dmEnabled) {
        logVerbose("discord: drop dm (dms disabled)");
        return;
      }

      const dmPolicy = discordConfig?.dm?.policy ?? "pairing";
      let commandAuthorized = true;
      if (isDirectMessage) {
        if (dmPolicy === "disabled") {
          logVerbose("discord: drop dm (dmPolicy: disabled)");
          return;
        }
        if (dmPolicy !== "open") {
          const storeAllowFrom = await readProviderAllowFromStore(
            "discord",
          ).catch(() => []);
          const effectiveAllowFrom = [...(allowFrom ?? []), ...storeAllowFrom];
          const allowList = normalizeDiscordAllowList(effectiveAllowFrom, [
            "discord:",
            "user:",
          ]);
          const permitted = allowList
            ? allowListMatches(allowList, {
                id: author.id,
                name: author.username,
                tag: formatDiscordUserTag(author),
              })
            : false;
          if (!permitted) {
            commandAuthorized = false;
            if (dmPolicy === "pairing") {
              const { code, created } = await upsertProviderPairingRequest({
                provider: "discord",
                id: author.id,
                meta: {
                  tag: formatDiscordUserTag(author),
                  name: author.username ?? undefined,
                },
              });
              if (created) {
                logVerbose(
                  `discord pairing request sender=${author.id} tag=${formatDiscordUserTag(author)}`,
                );
                try {
                  await sendMessageDiscord(
                    `user:${author.id}`,
                    buildPairingReply({
                      provider: "discord",
                      idLine: `Your Discord user id: ${author.id}`,
                      code,
                    }),
                    { token, rest: client.rest, accountId },
                  );
                } catch (err) {
                  logVerbose(
                    `discord pairing reply failed for ${author.id}: ${String(err)}`,
                  );
                }
              }
            } else {
              logVerbose(
                `Blocked unauthorized discord sender ${author.id} (dmPolicy=${dmPolicy})`,
              );
            }
            return;
          }
          commandAuthorized = true;
        }
      }
      const botId = botUserId;
      const baseText = resolveDiscordMessageText(message, {
        includeForwarded: false,
      });
      const messageText = resolveDiscordMessageText(message, {
        includeForwarded: true,
      });
      recordProviderActivity({
        provider: "discord",
        accountId,
        direction: "inbound",
      });
      const route = resolveAgentRoute({
        cfg,
        provider: "discord",
        accountId,
        guildId: data.guild_id ?? undefined,
        peer: {
          kind: isDirectMessage ? "dm" : isGroupDm ? "group" : "channel",
          id: isDirectMessage ? author.id : message.channelId,
        },
      });
      const mentionRegexes = buildMentionRegexes(cfg, route.agentId);
      const wasMentioned =
        !isDirectMessage &&
        (Boolean(
          botId &&
            message.mentionedUsers?.some((user: User) => user.id === botId),
        ) ||
          matchesMentionPatterns(baseText, mentionRegexes));
      if (shouldLogVerbose()) {
        logVerbose(
          `discord: inbound id=${message.id} guild=${message.guild?.id ?? "dm"} channel=${message.channelId} mention=${wasMentioned ? "yes" : "no"} type=${isDirectMessage ? "dm" : isGroupDm ? "group-dm" : "guild"} content=${messageText ? "yes" : "no"}`,
        );
      }

      if (
        isGuildMessage &&
        (message.type === MessageType.ChatInputCommand ||
          message.type === MessageType.ContextMenuCommand)
      ) {
        logVerbose("discord: drop channel command message");
        return;
      }

      const guildInfo = isGuildMessage
        ? resolveDiscordGuildEntry({
            guild: data.guild ?? undefined,
            guildEntries,
          })
        : null;
      if (
        isGuildMessage &&
        guildEntries &&
        Object.keys(guildEntries).length > 0 &&
        !guildInfo
      ) {
        logVerbose(
          `Blocked discord guild ${data.guild_id ?? "unknown"} (not in discord.guilds)`,
        );
        return;
      }

      const channelName =
        channelInfo?.name ??
        ((isGuildMessage || isGroupDm) &&
        message.channel &&
        "name" in message.channel
          ? message.channel.name
          : undefined);
      const threadChannel = resolveDiscordThreadChannel({
        isGuildMessage,
        message,
        channelInfo,
      });
      let threadParentId: string | undefined;
      let threadParentName: string | undefined;
      let threadParentType: ChannelType | undefined;
      if (threadChannel) {
        const parentInfo = await resolveDiscordThreadParentInfo({
          client,
          threadChannel,
          channelInfo,
        });
        threadParentId = parentInfo.id;
        threadParentName = parentInfo.name;
        threadParentType = parentInfo.type;
      }
      const threadName = threadChannel?.name;
      const configChannelName = threadParentName ?? channelName;
      const configChannelSlug = configChannelName
        ? normalizeDiscordSlug(configChannelName)
        : "";
      const displayChannelName = threadName ?? channelName;
      const displayChannelSlug = displayChannelName
        ? normalizeDiscordSlug(displayChannelName)
        : "";
      const guildSlug =
        guildInfo?.slug ||
        (data.guild?.name ? normalizeDiscordSlug(data.guild.name) : "");

      const baseSessionKey = route.sessionKey;
      const channelConfig = isGuildMessage
        ? resolveDiscordChannelConfig({
            guildInfo,
            channelId: threadParentId ?? message.channelId,
            channelName: configChannelName,
            channelSlug: configChannelSlug,
          })
        : null;
      if (isGuildMessage && channelConfig?.enabled === false) {
        logVerbose(
          `Blocked discord channel ${message.channelId} (channel disabled)`,
        );
        return;
      }

      const groupDmAllowed =
        isGroupDm &&
        resolveGroupDmAllow({
          channels: groupDmChannels,
          channelId: message.channelId,
          channelName: displayChannelName,
          channelSlug: displayChannelSlug,
        });
      if (isGroupDm && !groupDmAllowed) return;

      const channelAllowlistConfigured =
        Boolean(guildInfo?.channels) &&
        Object.keys(guildInfo?.channels ?? {}).length > 0;
      const channelAllowed = channelConfig?.allowed !== false;
      if (
        isGuildMessage &&
        !isDiscordGroupAllowedByPolicy({
          groupPolicy,
          channelAllowlistConfigured,
          channelAllowed,
        })
      ) {
        if (groupPolicy === "disabled") {
          logVerbose("discord: drop guild message (groupPolicy: disabled)");
        } else if (!channelAllowlistConfigured) {
          logVerbose(
            "discord: drop guild message (groupPolicy: allowlist, no channel allowlist)",
          );
        } else {
          logVerbose(
            `Blocked discord channel ${message.channelId} not in guild channel allowlist (groupPolicy: allowlist)`,
          );
        }
        return;
      }

      if (isGuildMessage && channelConfig?.allowed === false) {
        logVerbose(
          `Blocked discord channel ${message.channelId} not in guild channel allowlist`,
        );
        return;
      }

      const textForHistory = resolveDiscordMessageText(message, {
        includeForwarded: true,
      });
      const historyEntry =
        isGuildMessage && historyLimit > 0 && textForHistory
          ? {
              sender:
                data.member?.nickname ??
                author.globalName ??
                author.username ??
                author.id,
              body: textForHistory,
              timestamp: resolveTimestampMs(message.timestamp),
              messageId: message.id,
            }
          : undefined;

      const shouldRequireMention =
        channelConfig?.requireMention ?? guildInfo?.requireMention ?? true;
      const hasAnyMention = Boolean(
        !isDirectMessage &&
          (message.mentionedEveryone ||
            (message.mentionedUsers?.length ?? 0) > 0 ||
            (message.mentionedRoles?.length ?? 0) > 0),
      );
      if (!isDirectMessage) {
        commandAuthorized = resolveDiscordCommandAuthorized({
          isDirectMessage,
          allowFrom,
          guildInfo,
          author,
        });
      }
      const allowTextCommands = shouldHandleTextCommands({
        cfg,
        surface: "discord",
      });
      const shouldBypassMention =
        allowTextCommands &&
        isGuildMessage &&
        shouldRequireMention &&
        !wasMentioned &&
        !hasAnyMention &&
        commandAuthorized &&
        hasControlCommand(baseText);
      const effectiveWasMentioned = wasMentioned || shouldBypassMention;
      const canDetectMention = Boolean(botId) || mentionRegexes.length > 0;
      if (isGuildMessage && shouldRequireMention) {
        if (botId && !wasMentioned && !shouldBypassMention) {
          logVerbose(
            `discord: drop guild message (mention required, botId=${botId})`,
          );
          logger.info(
            {
              channelId: message.channelId,
              reason: "no-mention",
            },
            "discord: skipping guild message",
          );
          return;
        }
      }

      if (isGuildMessage) {
        const channelUsers = channelConfig?.users ?? guildInfo?.users;
        if (Array.isArray(channelUsers) && channelUsers.length > 0) {
          const userOk = resolveDiscordUserAllowed({
            allowList: channelUsers,
            userId: author.id,
            userName: author.username,
            userTag: formatDiscordUserTag(author),
          });
          if (!userOk) {
            logVerbose(
              `Blocked discord guild sender ${author.id} (not in channel users allowlist)`,
            );
            return;
          }
        }
      }

      const systemLocation = resolveDiscordSystemLocation({
        isDirectMessage,
        isGroupDm,
        guild: data.guild ?? undefined,
        channelName: channelName ?? message.channelId,
      });
      const systemText = resolveDiscordSystemEvent(message, systemLocation);
      if (systemText) {
        enqueueSystemEvent(systemText, {
          sessionKey: route.sessionKey,
          contextKey: `discord:system:${message.channelId}:${message.id}`,
        });
        return;
      }

      const mediaList = await resolveMediaList(message, mediaMaxBytes);
      const text = messageText;
      if (!text) {
        logVerbose(`discord: drop message ${message.id} (empty content)`);
        return;
      }
      const ackReaction = resolveAckReaction(cfg, route.agentId);
      const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;
      const shouldAckReaction = () => {
        if (!ackReaction) return false;
        if (ackReactionScope === "all") return true;
        if (ackReactionScope === "direct") return isDirectMessage;
        const isGroupChat = isGuildMessage || isGroupDm;
        if (ackReactionScope === "group-all") return isGroupChat;
        if (ackReactionScope === "group-mentions") {
          if (!isGuildMessage) return false;
          if (!shouldRequireMention) return false;
          if (!canDetectMention) return false;
          return wasMentioned || shouldBypassMention;
        }
        return false;
      };
      const ackReactionPromise = shouldAckReaction()
        ? reactMessageDiscord(message.channelId, message.id, ackReaction, {
            rest: client.rest,
          }).then(
            () => true,
            (err) => {
              logVerbose(
                `discord react failed for channel ${message.channelId}: ${String(err)}`,
              );
              return false;
            },
          )
        : null;

      const fromLabel = isDirectMessage
        ? buildDirectLabel(author)
        : buildGuildLabel({
            guild: data.guild ?? undefined,
            channelName: channelName ?? message.channelId,
            channelId: message.channelId,
          });
      const groupRoom =
        isGuildMessage && displayChannelSlug
          ? `#${displayChannelSlug}`
          : undefined;
      const groupSubject = isDirectMessage ? undefined : groupRoom;
      const channelDescription = channelInfo?.topic?.trim();
      const systemPromptParts = [
        channelDescription ? `Channel topic: ${channelDescription}` : null,
        channelConfig?.systemPrompt?.trim() || null,
      ].filter((entry): entry is string => Boolean(entry));
      const groupSystemPrompt =
        systemPromptParts.length > 0
          ? systemPromptParts.join("\n\n")
          : undefined;
      let combinedBody = formatAgentEnvelope({
        provider: "Discord",
        from: fromLabel,
        timestamp: resolveTimestampMs(message.timestamp),
        body: text,
      });
      let shouldClearHistory = false;
      if (!isDirectMessage) {
        combinedBody = buildHistoryContextFromMap({
          historyMap: guildHistories,
          historyKey: message.channelId,
          limit: historyLimit,
          entry: historyEntry,
          currentMessage: combinedBody,
          formatEntry: (entry) =>
            formatAgentEnvelope({
              provider: "Discord",
              from: fromLabel,
              timestamp: entry.timestamp,
              body: `${entry.sender}: ${entry.body} [id:${entry.messageId ?? "unknown"} channel:${message.channelId}]`,
            }),
        });
        const name = formatDiscordUserTag(author);
        const id = author.id;
        combinedBody = `${combinedBody}\n[from: ${name} user id:${id}]`;
        shouldClearHistory = true;
      }
      const replyContext = resolveReplyContext(message);
      if (replyContext) {
        combinedBody = `[Replied message - for context]\n${replyContext}\n\n${combinedBody}`;
      }

      let threadStarterBody: string | undefined;
      let threadLabel: string | undefined;
      let parentSessionKey: string | undefined;
      if (threadChannel) {
        const starter = await resolveDiscordThreadStarter({
          channel: threadChannel,
          client,
          parentId: threadParentId,
          parentType: threadParentType,
        });
        if (starter?.text) {
          const starterEnvelope = formatThreadStarterEnvelope({
            provider: "Discord",
            author: starter.author,
            timestamp: starter.timestamp,
            body: starter.text,
          });
          threadStarterBody = starterEnvelope;
        }
        const parentName = threadParentName ?? "parent";
        threadLabel = threadName
          ? `Discord thread #${normalizeDiscordSlug(parentName)} › ${threadName}`
          : `Discord thread #${normalizeDiscordSlug(parentName)}`;
        if (threadParentId) {
          parentSessionKey = buildAgentSessionKey({
            agentId: route.agentId,
            provider: route.provider,
            peer: { kind: "channel", id: threadParentId },
          });
        }
      }
      const mediaPayload = buildDiscordMediaPayload(mediaList);
      const discordTo = `channel:${message.channelId}`;
      const threadKeys = resolveThreadSessionKeys({
        baseSessionKey,
        threadId: threadChannel ? message.channelId : undefined,
        parentSessionKey,
        useSuffix: false,
      });
      const ctxPayload = {
        Body: combinedBody,
        RawBody: baseText,
        CommandBody: baseText,
        From: isDirectMessage
          ? `discord:${author.id}`
          : `group:${message.channelId}`,
        To: discordTo,
        SessionKey: threadKeys.sessionKey,
        AccountId: route.accountId,
        ChatType: isDirectMessage ? "direct" : "group",
        SenderName:
          data.member?.nickname ?? author.globalName ?? author.username,
        SenderId: author.id,
        SenderUsername: author.username,
        SenderTag: formatDiscordUserTag(author),
        GroupSubject: groupSubject,
        GroupRoom: groupRoom,
        GroupSystemPrompt: isGuildMessage ? groupSystemPrompt : undefined,
        GroupSpace: isGuildMessage
          ? (guildInfo?.id ?? guildSlug) || undefined
          : undefined,
        Provider: "discord" as const,
        Surface: "discord" as const,
        WasMentioned: effectiveWasMentioned,
        MessageSid: message.id,
        ParentSessionKey: threadKeys.parentSessionKey,
        ThreadStarterBody: threadStarterBody,
        ThreadLabel: threadLabel,
        Timestamp: resolveTimestampMs(message.timestamp),
        ...mediaPayload,
        CommandAuthorized: commandAuthorized,
        CommandSource: "text" as const,
        // Originating channel for reply routing.
        OriginatingChannel: "discord" as const,
        OriginatingTo: discordTo,
      };
      const replyTarget = ctxPayload.To ?? undefined;
      if (!replyTarget) {
        runtime.error?.(danger("discord: missing reply target"));
        return;
      }

      if (isDirectMessage) {
        const sessionCfg = cfg.session;
        const storePath = resolveStorePath(sessionCfg?.store, {
          agentId: route.agentId,
        });
        await updateLastRoute({
          storePath,
          sessionKey: route.mainSessionKey,
          provider: "discord",
          to: `user:${author.id}`,
          accountId: route.accountId,
        });
      }

      if (shouldLogVerbose()) {
        const preview = truncateUtf16Safe(combinedBody, 200).replace(
          /\n/g,
          "\\n",
        );
        logVerbose(
          `discord inbound: channel=${message.channelId} from=${ctxPayload.From} preview="${preview}"`,
        );
      }

      let didSendReply = false;
      const { dispatcher, replyOptions, markDispatchIdle } =
        createReplyDispatcherWithTyping({
          responsePrefix: resolveEffectiveMessagesConfig(cfg, route.agentId)
            .responsePrefix,
          humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
          deliver: async (payload) => {
            await deliverDiscordReply({
              replies: [payload],
              target: replyTarget,
              token,
              accountId,
              rest: client.rest,
              runtime,
              replyToMode,
              textLimit,
              maxLinesPerMessage: discordConfig?.maxLinesPerMessage,
            });
            didSendReply = true;
          },
          onError: (err, info) => {
            runtime.error?.(
              danger(`discord ${info.kind} reply failed: ${String(err)}`),
            );
          },
          onReplyStart: () => sendTyping(message),
        });

      const { queuedFinal, counts } = await dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg,
        dispatcher,
        replyOptions: {
          ...replyOptions,
          skillFilter: channelConfig?.skills,
          disableBlockStreaming:
            typeof discordConfig?.blockStreaming === "boolean"
              ? !discordConfig.blockStreaming
              : undefined,
        },
      });
      markDispatchIdle();
      if (!queuedFinal) {
        if (
          isGuildMessage &&
          shouldClearHistory &&
          historyLimit > 0 &&
          didSendReply
        ) {
          clearHistoryEntries({
            historyMap: guildHistories,
            historyKey: message.channelId,
          });
        }
        return;
      }
      didSendReply = true;
      if (shouldLogVerbose()) {
        const finalCount = counts.final;
        logVerbose(
          `discord: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${replyTarget}`,
        );
      }
      if (removeAckAfterReply && ackReactionPromise && ackReaction) {
        const ackReactionValue = ackReaction;
        void ackReactionPromise.then((didAck) => {
          if (!didAck) return;
          removeReactionDiscord(
            message.channelId,
            message.id,
            ackReactionValue,
            {
              rest: client.rest,
            },
          ).catch((err) => {
            logVerbose(
              `discord: failed to remove ack reaction from ${message.channelId}/${message.id}: ${String(err)}`,
            );
          });
        });
      }
      if (
        isGuildMessage &&
        shouldClearHistory &&
        historyLimit > 0 &&
        didSendReply
      ) {
        clearHistoryEntries({
          historyMap: guildHistories,
          historyKey: message.channelId,
        });
      }
    } catch (err) {
      runtime.error?.(danger(`handler failed: ${String(err)}`));
    }
  };
}

class DiscordMessageListener extends MessageCreateListener {
  constructor(
    private handler: DiscordMessageHandler,
    private logger?: ReturnType<typeof getChildLogger>,
  ) {
    super();
  }

  async handle(data: DiscordMessageEvent, client: Client) {
    const startedAt = Date.now();
    try {
      await this.handler(data, client);
    } finally {
      logSlowDiscordListener({
        logger: this.logger,
        listener: this.constructor.name,
        event: this.type,
        durationMs: Date.now() - startedAt,
      });
    }
  }
}

class DiscordReactionListener extends MessageReactionAddListener {
  constructor(
    private params: {
      cfg: ReturnType<typeof loadConfig>;
      accountId: string;
      runtime: RuntimeEnv;
      botUserId?: string;
      guildEntries?: Record<string, DiscordGuildEntryResolved>;
      logger: ReturnType<typeof getChildLogger>;
    },
  ) {
    super();
  }

  async handle(data: DiscordReactionEvent, client: Client) {
    const startedAt = Date.now();
    try {
      await handleDiscordReactionEvent({
        data,
        client,
        action: "added",
        cfg: this.params.cfg,
        accountId: this.params.accountId,
        botUserId: this.params.botUserId,
        guildEntries: this.params.guildEntries,
        logger: this.params.logger,
      });
    } finally {
      logSlowDiscordListener({
        logger: this.params.logger,
        listener: this.constructor.name,
        event: this.type,
        durationMs: Date.now() - startedAt,
      });
    }
  }
}

class DiscordReactionRemoveListener extends MessageReactionRemoveListener {
  constructor(
    private params: {
      cfg: ReturnType<typeof loadConfig>;
      accountId: string;
      runtime: RuntimeEnv;
      botUserId?: string;
      guildEntries?: Record<string, DiscordGuildEntryResolved>;
      logger: ReturnType<typeof getChildLogger>;
    },
  ) {
    super();
  }

  async handle(data: DiscordReactionEvent, client: Client) {
    const startedAt = Date.now();
    try {
      await handleDiscordReactionEvent({
        data,
        client,
        action: "removed",
        cfg: this.params.cfg,
        accountId: this.params.accountId,
        botUserId: this.params.botUserId,
        guildEntries: this.params.guildEntries,
        logger: this.params.logger,
      });
    } finally {
      logSlowDiscordListener({
        logger: this.params.logger,
        listener: this.constructor.name,
        event: this.type,
        durationMs: Date.now() - startedAt,
      });
    }
  }
}

async function handleDiscordReactionEvent(params: {
  data: DiscordReactionEvent;
  client: Client;
  action: "added" | "removed";
  cfg: ReturnType<typeof loadConfig>;
  accountId: string;
  botUserId?: string;
  guildEntries?: Record<string, DiscordGuildEntryResolved>;
  logger: ReturnType<typeof getChildLogger>;
}) {
  try {
    const { data, client, action, botUserId, guildEntries } = params;
    if (!("user" in data)) return;
    const user = data.user;
    if (!user || user.bot) return;
    if (!data.guild_id) return;

    const guildInfo = resolveDiscordGuildEntry({
      guild: data.guild ?? undefined,
      guildEntries,
    });
    if (guildEntries && Object.keys(guildEntries).length > 0 && !guildInfo) {
      return;
    }

    const channel = await client.fetchChannel(data.channel_id);
    if (!channel) return;
    const channelName =
      "name" in channel ? (channel.name ?? undefined) : undefined;
    const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
    const channelConfig = resolveDiscordChannelConfig({
      guildInfo,
      channelId: data.channel_id,
      channelName,
      channelSlug,
    });
    if (channelConfig?.allowed === false) return;

    if (botUserId && user.id === botUserId) return;

    const reactionMode = guildInfo?.reactionNotifications ?? "own";
    const message = await data.message.fetch().catch(() => null);
    const messageAuthorId = message?.author?.id ?? undefined;
    const shouldNotify = shouldEmitDiscordReactionNotification({
      mode: reactionMode,
      botId: botUserId,
      messageAuthorId,
      userId: user.id,
      userName: user.username,
      userTag: formatDiscordUserTag(user),
      allowlist: guildInfo?.users,
    });
    if (!shouldNotify) return;

    const emojiLabel = formatDiscordReactionEmoji(data.emoji);
    const actorLabel = formatDiscordUserTag(user);
    const guildSlug =
      guildInfo?.slug ||
      (data.guild?.name
        ? normalizeDiscordSlug(data.guild.name)
        : data.guild_id);
    const channelLabel = channelSlug
      ? `#${channelSlug}`
      : channelName
        ? `#${normalizeDiscordSlug(channelName)}`
        : `#${data.channel_id}`;
    const authorLabel = message?.author
      ? formatDiscordUserTag(message.author)
      : undefined;
    const baseText = `Discord reaction ${action}: ${emojiLabel} by ${actorLabel} on ${guildSlug} ${channelLabel} msg ${data.message_id}`;
    const text = authorLabel ? `${baseText} from ${authorLabel}` : baseText;
    const route = resolveAgentRoute({
      cfg: params.cfg,
      provider: "discord",
      accountId: params.accountId,
      guildId: data.guild_id ?? undefined,
      peer: { kind: "channel", id: data.channel_id },
    });
    enqueueSystemEvent(text, {
      sessionKey: route.sessionKey,
      contextKey: `discord:reaction:${action}:${data.message_id}:${user.id}:${emojiLabel}`,
    });
  } catch (err) {
    params.logger.error(
      danger(`discord reaction handler failed: ${String(err)}`),
    );
  }
}

function createDiscordNativeCommand(params: {
  command: {
    name: string;
    description: string;
    acceptsArgs: boolean;
  };
  cfg: ReturnType<typeof loadConfig>;
  discordConfig: ClawdbotConfig["discord"];
  accountId: string;
  sessionPrefix: string;
  ephemeralDefault: boolean;
}) {
  const {
    command,
    cfg,
    discordConfig,
    accountId,
    sessionPrefix,
    ephemeralDefault,
  } = params;
  return new (class extends Command {
    name = command.name;
    description = command.description;
    defer = true;
    ephemeral = ephemeralDefault;
    options = command.acceptsArgs
      ? ([
          {
            name: "input",
            description: "Command input",
            type: ApplicationCommandOptionType.String,
            required: false,
          },
        ] satisfies CommandOptions)
      : undefined;

    async run(interaction: CommandInteraction) {
      const useAccessGroups = cfg.commands?.useAccessGroups !== false;
      const user = interaction.user;
      if (!user) return;
      const channel = interaction.channel;
      const channelType = channel?.type;
      const isDirectMessage = channelType === ChannelType.DM;
      const isGroupDm = channelType === ChannelType.GroupDM;
      const channelName =
        channel && "name" in channel ? (channel.name as string) : undefined;
      const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
      const prompt = buildCommandText(
        this.name,
        command.acceptsArgs
          ? interaction.options.getString("input")
          : undefined,
      );
      const guildInfo = resolveDiscordGuildEntry({
        guild: interaction.guild ?? undefined,
        guildEntries: discordConfig?.guilds,
      });
      const channelConfig = interaction.guild
        ? resolveDiscordChannelConfig({
            guildInfo,
            channelId: channel?.id ?? "",
            channelName,
            channelSlug,
          })
        : null;
      if (channelConfig?.enabled === false) {
        await interaction.reply({
          content: "This channel is disabled.",
        });
        return;
      }
      if (interaction.guild && channelConfig?.allowed === false) {
        await interaction.reply({
          content: "This channel is not allowed.",
        });
        return;
      }
      if (useAccessGroups && interaction.guild) {
        const channelAllowlistConfigured =
          Boolean(guildInfo?.channels) &&
          Object.keys(guildInfo?.channels ?? {}).length > 0;
        const channelAllowed = channelConfig?.allowed !== false;
        const allowByPolicy = isDiscordGroupAllowedByPolicy({
          groupPolicy: discordConfig?.groupPolicy ?? "open",
          channelAllowlistConfigured,
          channelAllowed,
        });
        if (!allowByPolicy) {
          await interaction.reply({
            content: "This channel is not allowed.",
          });
          return;
        }
      }
      const dmEnabled = discordConfig?.dm?.enabled ?? true;
      const dmPolicy = discordConfig?.dm?.policy ?? "pairing";
      let commandAuthorized = true;
      if (isDirectMessage) {
        if (!dmEnabled || dmPolicy === "disabled") {
          await interaction.reply({ content: "Discord DMs are disabled." });
          return;
        }
        if (dmPolicy !== "open") {
          const storeAllowFrom = await readProviderAllowFromStore(
            "discord",
          ).catch(() => []);
          const effectiveAllowFrom = [
            ...(discordConfig?.dm?.allowFrom ?? []),
            ...storeAllowFrom,
          ];
          const allowList = normalizeDiscordAllowList(effectiveAllowFrom, [
            "discord:",
            "user:",
          ]);
          const permitted = allowList
            ? allowListMatches(allowList, {
                id: user.id,
                name: user.username,
                tag: formatDiscordUserTag(user),
              })
            : false;
          if (!permitted) {
            commandAuthorized = false;
            if (dmPolicy === "pairing") {
              const { code, created } = await upsertProviderPairingRequest({
                provider: "discord",
                id: user.id,
                meta: {
                  tag: formatDiscordUserTag(user),
                  name: user.username ?? undefined,
                },
              });
              if (created) {
                await interaction.reply({
                  content: buildPairingReply({
                    provider: "discord",
                    idLine: `Your Discord user id: ${user.id}`,
                    code,
                  }),
                  ephemeral: true,
                });
              }
            } else {
              await interaction.reply({
                content: "You are not authorized to use this command.",
                ephemeral: true,
              });
            }
            return;
          }
          commandAuthorized = true;
        }
      }
      if (!isDirectMessage) {
        const channelUsers = channelConfig?.users ?? guildInfo?.users;
        if (Array.isArray(channelUsers) && channelUsers.length > 0) {
          const userOk = resolveDiscordUserAllowed({
            allowList: channelUsers,
            userId: user.id,
            userName: user.username,
            userTag: formatDiscordUserTag(user),
          });
          if (!userOk) {
            await interaction.reply({
              content: "You are not authorized to use this command.",
            });
            return;
          }
        }
      }
      if (isGroupDm && discordConfig?.dm?.groupEnabled === false) {
        await interaction.reply({ content: "Discord group DMs are disabled." });
        return;
      }

      const isGuild = Boolean(interaction.guild);
      const channelId = channel?.id ?? "unknown";
      const interactionId = interaction.rawData.id;
      const route = resolveAgentRoute({
        cfg,
        provider: "discord",
        accountId,
        guildId: interaction.guild?.id ?? undefined,
        peer: {
          kind: isDirectMessage ? "dm" : isGroupDm ? "group" : "channel",
          id: isDirectMessage ? user.id : channelId,
        },
      });
      const ctxPayload = {
        Body: prompt,
        CommandBody: prompt,
        From: isDirectMessage ? `discord:${user.id}` : `group:${channelId}`,
        To: `slash:${user.id}`,
        SessionKey: `agent:${route.agentId}:${sessionPrefix}:${user.id}`,
        CommandTargetSessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: isDirectMessage ? "direct" : "group",
        GroupSubject: isGuild ? interaction.guild?.name : undefined,
        GroupSystemPrompt: isGuild
          ? (() => {
              const channelTopic =
                channel && "topic" in channel
                  ? (channel.topic ?? undefined)
                  : undefined;
              const channelDescription = channelTopic?.trim();
              const systemPromptParts = [
                channelDescription
                  ? `Channel topic: ${channelDescription}`
                  : null,
                channelConfig?.systemPrompt?.trim() || null,
              ].filter((entry): entry is string => Boolean(entry));
              return systemPromptParts.length > 0
                ? systemPromptParts.join("\n\n")
                : undefined;
            })()
          : undefined,
        SenderName: user.globalName ?? user.username,
        SenderId: user.id,
        SenderUsername: user.username,
        SenderTag: formatDiscordUserTag(user),
        Provider: "discord" as const,
        Surface: "discord" as const,
        WasMentioned: true,
        MessageSid: interactionId,
        Timestamp: Date.now(),
        CommandAuthorized: commandAuthorized,
        CommandSource: "native" as const,
      };

      let didReply = false;
      const dispatcher = createReplyDispatcher({
        responsePrefix: resolveEffectiveMessagesConfig(cfg, route.agentId)
          .responsePrefix,
        humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
        deliver: async (payload, _info) => {
          await deliverDiscordInteractionReply({
            interaction,
            payload,
            textLimit: resolveTextChunkLimit(cfg, "discord", accountId),
            maxLinesPerMessage: discordConfig?.maxLinesPerMessage,
            preferFollowUp: didReply,
          });
          didReply = true;
        },
        onError: (err) => {
          console.error(err);
        },
      });

      const replyResult = await getReplyFromConfig(
        ctxPayload,
        { skillFilter: channelConfig?.skills },
        cfg,
      );
      const replies = replyResult
        ? Array.isArray(replyResult)
          ? replyResult
          : [replyResult]
        : [];
      for (const reply of replies) {
        dispatcher.sendFinalReply(reply);
      }
      await dispatcher.waitForIdle();
    }
  })();
}

async function deliverDiscordInteractionReply(params: {
  interaction: CommandInteraction;
  payload: ReplyPayload;
  textLimit: number;
  maxLinesPerMessage?: number;
  preferFollowUp: boolean;
}) {
  const {
    interaction,
    payload,
    textLimit,
    maxLinesPerMessage,
    preferFollowUp,
  } = params;
  const mediaList =
    payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
  const text = payload.text ?? "";

  let hasReplied = false;
  const sendMessage = async (
    content: string,
    files?: { name: string; data: Buffer }[],
  ) => {
    const payload =
      files && files.length > 0
        ? {
            content,
            files: files.map((file) => {
              if (file.data instanceof Blob) {
                return { name: file.name, data: file.data };
              }
              const arrayBuffer = Uint8Array.from(file.data).buffer;
              return { name: file.name, data: new Blob([arrayBuffer]) };
            }),
          }
        : { content };
    if (!preferFollowUp && !hasReplied) {
      await interaction.reply(payload);
      hasReplied = true;
      return;
    }
    await interaction.followUp(payload);
    hasReplied = true;
  };

  if (mediaList.length > 0) {
    const media = await Promise.all(
      mediaList.map(async (url) => {
        const loaded = await loadWebMedia(url);
        return {
          name: loaded.fileName ?? "upload",
          data: loaded.buffer,
        };
      }),
    );
    const chunks = chunkDiscordText(text, {
      maxChars: textLimit,
      maxLines: maxLinesPerMessage,
    });
    const caption = chunks[0] ?? "";
    await sendMessage(caption, media);
    for (const chunk of chunks.slice(1)) {
      if (!chunk.trim()) continue;
      await interaction.followUp({ content: chunk });
    }
    return;
  }

  if (!text.trim()) return;
  const chunks = chunkDiscordText(text, {
    maxChars: textLimit,
    maxLines: maxLinesPerMessage,
  });
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    await sendMessage(chunk);
  }
}

async function deliverDiscordReply(params: {
  replies: ReplyPayload[];
  target: string;
  token: string;
  accountId?: string;
  rest?: RequestClient;
  runtime: RuntimeEnv;
  textLimit: number;
  maxLinesPerMessage?: number;
  replyToMode: ReplyToMode;
}) {
  const chunkLimit = Math.min(params.textLimit, 2000);
  for (const payload of params.replies) {
    const mediaList =
      payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const text = payload.text ?? "";
    if (!text && mediaList.length === 0) continue;

    if (mediaList.length === 0) {
      for (const chunk of chunkDiscordText(text, {
        maxChars: chunkLimit,
        maxLines: params.maxLinesPerMessage,
      })) {
        const trimmed = chunk.trim();
        if (!trimmed) continue;
        await sendMessageDiscord(params.target, trimmed, {
          token: params.token,
          rest: params.rest,
          accountId: params.accountId,
        });
      }
      continue;
    }

    const firstMedia = mediaList[0];
    if (!firstMedia) continue;
    await sendMessageDiscord(params.target, text, {
      token: params.token,
      rest: params.rest,
      mediaUrl: firstMedia,
      accountId: params.accountId,
    });
    for (const extra of mediaList.slice(1)) {
      await sendMessageDiscord(params.target, "", {
        token: params.token,
        rest: params.rest,
        mediaUrl: extra,
        accountId: params.accountId,
      });
    }
  }
}

async function resolveDiscordChannelInfo(
  client: Client,
  channelId: string,
): Promise<DiscordChannelInfo | null> {
  const cached = DISCORD_CHANNEL_INFO_CACHE.get(channelId);
  if (cached) {
    if (cached.expiresAt > Date.now()) return cached.value;
    DISCORD_CHANNEL_INFO_CACHE.delete(channelId);
  }
  try {
    const channel = await client.fetchChannel(channelId);
    if (!channel) {
      DISCORD_CHANNEL_INFO_CACHE.set(channelId, {
        value: null,
        expiresAt: Date.now() + DISCORD_CHANNEL_INFO_NEGATIVE_CACHE_TTL_MS,
      });
      return null;
    }
    const name = "name" in channel ? (channel.name ?? undefined) : undefined;
    const topic = "topic" in channel ? (channel.topic ?? undefined) : undefined;
    const parentId =
      "parentId" in channel ? (channel.parentId ?? undefined) : undefined;
    const payload: DiscordChannelInfo = {
      type: channel.type,
      name,
      topic,
      parentId,
    };
    DISCORD_CHANNEL_INFO_CACHE.set(channelId, {
      value: payload,
      expiresAt: Date.now() + DISCORD_CHANNEL_INFO_CACHE_TTL_MS,
    });
    return payload;
  } catch (err) {
    logVerbose(`discord: failed to fetch channel ${channelId}: ${String(err)}`);
    DISCORD_CHANNEL_INFO_CACHE.set(channelId, {
      value: null,
      expiresAt: Date.now() + DISCORD_CHANNEL_INFO_NEGATIVE_CACHE_TTL_MS,
    });
    return null;
  }
}

async function resolveMediaList(
  message: Message,
  maxBytes: number,
): Promise<DiscordMediaInfo[]> {
  const attachments = message.attachments ?? [];
  if (attachments.length === 0) return [];
  const out: DiscordMediaInfo[] = [];
  for (const attachment of attachments) {
    try {
      const fetched = await fetchRemoteMedia({
        url: attachment.url,
        filePathHint: attachment.filename ?? attachment.url,
      });
      const saved = await saveMediaBuffer(
        fetched.buffer,
        fetched.contentType ?? attachment.content_type,
        "inbound",
        maxBytes,
      );
      out.push({
        path: saved.path,
        contentType: saved.contentType,
        placeholder: inferPlaceholder(attachment),
      });
    } catch (err) {
      const id = attachment.id ?? attachment.url;
      logVerbose(
        `discord: failed to download attachment ${id}: ${String(err)}`,
      );
    }
  }
  return out;
}

function inferPlaceholder(attachment: APIAttachment): string {
  const mime = attachment.content_type ?? "";
  if (mime.startsWith("image/")) return "<media:image>";
  if (mime.startsWith("video/")) return "<media:video>";
  if (mime.startsWith("audio/")) return "<media:audio>";
  return "<media:document>";
}

function isImageAttachment(attachment: APIAttachment): boolean {
  const mime = attachment.content_type ?? "";
  if (mime.startsWith("image/")) return true;
  const name = attachment.filename?.toLowerCase() ?? "";
  if (!name) return false;
  return /\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/.test(name);
}

function buildDiscordAttachmentPlaceholder(
  attachments?: APIAttachment[],
): string {
  if (!attachments || attachments.length === 0) return "";
  const count = attachments.length;
  const allImages = attachments.every(isImageAttachment);
  const label = allImages ? "image" : "file";
  const suffix = count === 1 ? label : `${label}s`;
  const tag = allImages ? "<media:image>" : "<media:document>";
  return `${tag} (${count} ${suffix})`;
}

function resolveDiscordMessageText(
  message: Message,
  options?: { fallbackText?: string; includeForwarded?: boolean },
): string {
  const baseText =
    message.content?.trim() ||
    buildDiscordAttachmentPlaceholder(message.attachments) ||
    message.embeds?.[0]?.description ||
    options?.fallbackText?.trim() ||
    "";
  if (!options?.includeForwarded) return baseText;
  const forwardedText = resolveDiscordForwardedMessagesText(message);
  if (!forwardedText) return baseText;
  if (!baseText) return forwardedText;
  return `${baseText}\n${forwardedText}`;
}

function resolveDiscordForwardedMessagesText(message: Message): string {
  const snapshots = resolveDiscordMessageSnapshots(message);
  if (snapshots.length === 0) return "";
  const forwardedBlocks = snapshots
    .map((snapshot) => {
      const snapshotMessage = snapshot.message;
      if (!snapshotMessage) return null;
      const text = resolveDiscordSnapshotMessageText(snapshotMessage);
      if (!text) return null;
      const authorLabel = formatDiscordSnapshotAuthor(snapshotMessage.author);
      const heading = authorLabel
        ? `[Forwarded message from ${authorLabel}]`
        : "[Forwarded message]";
      return `${heading}\n${text}`;
    })
    .filter((entry): entry is string => Boolean(entry));
  if (forwardedBlocks.length === 0) return "";
  return forwardedBlocks.join("\n\n");
}

function resolveDiscordMessageSnapshots(
  message: Message,
): DiscordMessageSnapshot[] {
  const rawData = (message as { rawData?: { message_snapshots?: unknown } })
    .rawData;
  const snapshots =
    rawData?.message_snapshots ??
    (message as { message_snapshots?: unknown }).message_snapshots ??
    (message as { messageSnapshots?: unknown }).messageSnapshots;
  if (!Array.isArray(snapshots)) return [];
  return snapshots.filter(
    (entry): entry is DiscordMessageSnapshot =>
      Boolean(entry) && typeof entry === "object",
  );
}

function resolveDiscordSnapshotMessageText(
  snapshot: DiscordSnapshotMessage,
): string {
  const content = snapshot.content?.trim() ?? "";
  const attachmentText = buildDiscordAttachmentPlaceholder(
    snapshot.attachments ?? undefined,
  );
  const embed = snapshot.embeds?.[0];
  const embedText = embed?.description?.trim() || embed?.title?.trim() || "";
  return content || attachmentText || embedText || "";
}

function formatDiscordSnapshotAuthor(
  author: DiscordSnapshotAuthor | null | undefined,
): string | undefined {
  if (!author) return undefined;
  const globalName = author.global_name ?? undefined;
  const username = author.username ?? undefined;
  const name = author.name ?? undefined;
  const discriminator = author.discriminator ?? undefined;
  const base = globalName || username || name;
  if (username && discriminator && discriminator !== "0") {
    return `@${username}#${discriminator}`;
  }
  if (base) return `@${base}`;
  if (author.id) return `@${author.id}`;
  return undefined;
}

export function buildDiscordMediaPayload(
  mediaList: Array<{ path: string; contentType?: string }>,
): {
  MediaPath?: string;
  MediaType?: string;
  MediaUrl?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
} {
  const first = mediaList[0];
  const mediaPaths = mediaList.map((media) => media.path);
  const mediaTypes = mediaList
    .map((media) => media.contentType)
    .filter(Boolean) as string[];
  return {
    MediaPath: first?.path,
    MediaType: first?.contentType,
    MediaUrl: first?.path,
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaUrls: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
  };
}

function resolveReplyContext(message: Message): string | null {
  const referenced = message.referencedMessage;
  if (!referenced?.author) return null;
  const referencedText = resolveDiscordMessageText(referenced, {
    includeForwarded: true,
  });
  if (!referencedText) return null;
  const fromLabel = referenced.author
    ? buildDirectLabel(referenced.author)
    : "Unknown";
  const body = `${referencedText}\n[discord message id: ${referenced.id} channel: ${referenced.channelId} from: ${formatDiscordUserTag(referenced.author)} user id:${referenced.author?.id ?? "unknown"}]`;
  return formatAgentEnvelope({
    provider: "Discord",
    from: fromLabel,
    timestamp: resolveTimestampMs(referenced.timestamp),
    body,
  });
}

function buildDirectLabel(author: User) {
  const username = formatDiscordUserTag(author);
  return `${username} user id:${author.id}`;
}

function buildGuildLabel(params: {
  guild?: Guild;
  channelName: string;
  channelId: string;
}) {
  const { guild, channelName, channelId } = params;
  return `${guild?.name ?? "Guild"} #${channelName} channel id:${channelId}`;
}

function resolveDiscordSystemEvent(
  message: Message,
  location: string,
): string | null {
  switch (message.type) {
    case MessageType.ChannelPinnedMessage:
      return buildDiscordSystemEvent(message, location, "pinned a message");
    case MessageType.RecipientAdd:
      return buildDiscordSystemEvent(message, location, "added a recipient");
    case MessageType.RecipientRemove:
      return buildDiscordSystemEvent(message, location, "removed a recipient");
    case MessageType.UserJoin:
      return buildDiscordSystemEvent(message, location, "user joined");
    case MessageType.GuildBoost:
      return buildDiscordSystemEvent(message, location, "boosted the server");
    case MessageType.GuildBoostTier1:
      return buildDiscordSystemEvent(
        message,
        location,
        "boosted the server (Tier 1 reached)",
      );
    case MessageType.GuildBoostTier2:
      return buildDiscordSystemEvent(
        message,
        location,
        "boosted the server (Tier 2 reached)",
      );
    case MessageType.GuildBoostTier3:
      return buildDiscordSystemEvent(
        message,
        location,
        "boosted the server (Tier 3 reached)",
      );
    case MessageType.ThreadCreated:
      return buildDiscordSystemEvent(message, location, "created a thread");
    case MessageType.AutoModerationAction:
      return buildDiscordSystemEvent(
        message,
        location,
        "auto moderation action",
      );
    case MessageType.GuildIncidentAlertModeEnabled:
      return buildDiscordSystemEvent(
        message,
        location,
        "raid protection enabled",
      );
    case MessageType.GuildIncidentAlertModeDisabled:
      return buildDiscordSystemEvent(
        message,
        location,
        "raid protection disabled",
      );
    case MessageType.GuildIncidentReportRaid:
      return buildDiscordSystemEvent(message, location, "raid reported");
    case MessageType.GuildIncidentReportFalseAlarm:
      return buildDiscordSystemEvent(
        message,
        location,
        "raid report marked false alarm",
      );
    case MessageType.StageStart:
      return buildDiscordSystemEvent(message, location, "stage started");
    case MessageType.StageEnd:
      return buildDiscordSystemEvent(message, location, "stage ended");
    case MessageType.StageSpeaker:
      return buildDiscordSystemEvent(
        message,
        location,
        "stage speaker updated",
      );
    case MessageType.StageTopic:
      return buildDiscordSystemEvent(message, location, "stage topic updated");
    case MessageType.PollResult:
      return buildDiscordSystemEvent(message, location, "poll results posted");
    case MessageType.PurchaseNotification:
      return buildDiscordSystemEvent(
        message,
        location,
        "purchase notification",
      );
    default:
      return null;
  }
}

function buildDiscordSystemEvent(
  message: Message,
  location: string,
  action: string,
) {
  const authorLabel = message.author
    ? formatDiscordUserTag(message.author)
    : "";
  const actor = authorLabel ? `${authorLabel} ` : "";
  return `Discord system: ${actor}${action} in ${location}`;
}

function resolveDiscordSystemLocation(params: {
  isDirectMessage: boolean;
  isGroupDm: boolean;
  guild?: Guild;
  channelName: string;
}) {
  const { isDirectMessage, isGroupDm, guild, channelName } = params;
  if (isDirectMessage) return "DM";
  if (isGroupDm) return `Group DM #${channelName}`;
  return guild?.name ? `${guild.name} #${channelName}` : `#${channelName}`;
}

function formatDiscordReactionEmoji(emoji: {
  id?: string | null;
  name?: string | null;
}) {
  if (emoji.id && emoji.name) {
    return `${emoji.name}:${emoji.id}`;
  }
  return emoji.name ?? "emoji";
}

function formatDiscordUserTag(user: User) {
  const discriminator = (user.discriminator ?? "").trim();
  if (discriminator && discriminator !== "0") {
    return `${user.username}#${discriminator}`;
  }
  return user.username ?? user.id;
}

function resolveTimestampMs(timestamp?: string | null) {
  if (!timestamp) return undefined;
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function normalizeDiscordAllowList(
  raw: Array<string | number> | undefined,
  prefixes: string[],
) {
  if (!raw || raw.length === 0) return null;
  const ids = new Set<string>();
  const names = new Set<string>();
  const allowAll = raw.some((entry) => String(entry).trim() === "*");
  for (const entry of raw) {
    const text = String(entry).trim();
    if (!text || text === "*") continue;
    const normalized = normalizeDiscordSlug(text);
    const maybeId = text.replace(/^<@!?/, "").replace(/>$/, "");
    if (/^\d+$/.test(maybeId)) {
      ids.add(maybeId);
      continue;
    }
    const prefix = prefixes.find((entry) => text.startsWith(entry));
    if (prefix) {
      const candidate = text.slice(prefix.length);
      if (candidate) ids.add(candidate);
      continue;
    }
    if (normalized) {
      names.add(normalized);
    }
  }
  return { allowAll, ids, names } satisfies DiscordAllowList;
}

export function normalizeDiscordSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^#/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function allowListMatches(
  list: DiscordAllowList,
  candidate: { id?: string; name?: string; tag?: string },
) {
  if (list.allowAll) return true;
  if (candidate.id && list.ids.has(candidate.id)) return true;
  const slug = candidate.name ? normalizeDiscordSlug(candidate.name) : "";
  if (slug && list.names.has(slug)) return true;
  if (candidate.tag && list.names.has(normalizeDiscordSlug(candidate.tag)))
    return true;
  return false;
}

function resolveDiscordUserAllowed(params: {
  allowList?: Array<string | number>;
  userId: string;
  userName?: string;
  userTag?: string;
}) {
  const allowList = normalizeDiscordAllowList(params.allowList, [
    "discord:",
    "user:",
  ]);
  if (!allowList) return true;
  return allowListMatches(allowList, {
    id: params.userId,
    name: params.userName,
    tag: params.userTag,
  });
}

export function resolveDiscordCommandAuthorized(params: {
  isDirectMessage: boolean;
  allowFrom?: Array<string | number>;
  guildInfo?: DiscordGuildEntryResolved | null;
  author: User;
}) {
  if (!params.isDirectMessage) return true;
  const allowList = normalizeDiscordAllowList(params.allowFrom, [
    "discord:",
    "user:",
  ]);
  if (!allowList) return true;
  return allowListMatches(allowList, {
    id: params.author.id,
    name: params.author.username,
    tag: formatDiscordUserTag(params.author),
  });
}

export function resolveDiscordGuildEntry(params: {
  guild?: Guild<true> | Guild<false> | null;
  guildEntries?: Record<string, DiscordGuildEntryResolved>;
}): DiscordGuildEntryResolved | null {
  const guild = params.guild;
  const entries = params.guildEntries;
  if (!guild || !entries) return null;
  const byId = entries[guild.id];
  if (byId) return { ...byId, id: guild.id };
  const slug = normalizeDiscordSlug(guild.name ?? "");
  const bySlug = entries[slug];
  if (bySlug) return { ...bySlug, id: guild.id, slug: slug || bySlug.slug };
  const wildcard = entries["*"];
  if (wildcard)
    return { ...wildcard, id: guild.id, slug: slug || wildcard.slug };
  return null;
}

export function resolveDiscordChannelConfig(params: {
  guildInfo?: DiscordGuildEntryResolved | null;
  channelId: string;
  channelName?: string;
  channelSlug: string;
}): DiscordChannelConfigResolved | null {
  const { guildInfo, channelId, channelName, channelSlug } = params;
  const channels = guildInfo?.channels;
  if (!channels) return null;
  const byId = channels[channelId];
  if (byId)
    return {
      allowed: byId.allow !== false,
      requireMention: byId.requireMention,
      skills: byId.skills,
      enabled: byId.enabled,
      users: byId.users,
      systemPrompt: byId.systemPrompt,
    };
  if (channelSlug && channels[channelSlug]) {
    const entry = channels[channelSlug];
    return {
      allowed: entry.allow !== false,
      requireMention: entry.requireMention,
      skills: entry.skills,
      enabled: entry.enabled,
      users: entry.users,
      systemPrompt: entry.systemPrompt,
    };
  }
  if (channelName && channels[channelName]) {
    const entry = channels[channelName];
    return {
      allowed: entry.allow !== false,
      requireMention: entry.requireMention,
      skills: entry.skills,
      enabled: entry.enabled,
      users: entry.users,
      systemPrompt: entry.systemPrompt,
    };
  }
  return { allowed: false };
}

export function isDiscordGroupAllowedByPolicy(params: {
  groupPolicy: "open" | "disabled" | "allowlist";
  channelAllowlistConfigured: boolean;
  channelAllowed: boolean;
}): boolean {
  const { groupPolicy, channelAllowlistConfigured, channelAllowed } = params;
  if (groupPolicy === "disabled") return false;
  if (groupPolicy === "open") return true;
  if (!channelAllowlistConfigured) return false;
  return channelAllowed;
}

export function resolveGroupDmAllow(params: {
  channels?: Array<string | number>;
  channelId: string;
  channelName?: string;
  channelSlug: string;
}) {
  const { channels, channelId, channelName, channelSlug } = params;
  if (!channels || channels.length === 0) return true;
  const allowList = channels.map((entry) =>
    normalizeDiscordSlug(String(entry)),
  );
  const candidates = [
    normalizeDiscordSlug(channelId),
    channelSlug,
    channelName ? normalizeDiscordSlug(channelName) : "",
  ].filter(Boolean);
  return (
    allowList.includes("*") ||
    candidates.some((candidate) => allowList.includes(candidate))
  );
}

export function shouldEmitDiscordReactionNotification(params: {
  mode?: "off" | "own" | "all" | "allowlist";
  botId?: string;
  messageAuthorId?: string;
  userId: string;
  userName?: string;
  userTag?: string;
  allowlist?: Array<string | number>;
}) {
  const mode = params.mode ?? "own";
  if (mode === "off") return false;
  if (mode === "all") return true;
  if (mode === "own") {
    return Boolean(params.botId && params.messageAuthorId === params.botId);
  }
  if (mode === "allowlist") {
    const list = normalizeDiscordAllowList(params.allowlist, [
      "discord:",
      "user:",
    ]);
    if (!list) return false;
    return allowListMatches(list, {
      id: params.userId,
      name: params.userName,
      tag: params.userTag,
    });
  }
  return false;
}

async function sendTyping(params: { client: Client; channelId: string }) {
  try {
    const channel = await params.client.fetchChannel(params.channelId);
    if (!channel) return;
    if (
      "triggerTyping" in channel &&
      typeof channel.triggerTyping === "function"
    ) {
      await channel.triggerTyping();
    }
  } catch (err) {
    logVerbose(
      `discord typing cue failed for channel ${params.channelId}: ${String(err)}`,
    );
  }
}
