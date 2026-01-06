import {
  type Attachment,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type Guild,
  type Message,
  type MessageReaction,
  type MessageSnapshot,
  MessageType,
  type PartialMessage,
  type PartialMessageReaction,
  Partials,
  type PartialUser,
  type User,
} from "discord.js";
import { chunkText, resolveTextChunkLimit } from "../auto-reply/chunk.js";
import { hasControlCommand } from "../auto-reply/command-detection.js";
import { formatAgentEnvelope } from "../auto-reply/envelope.js";
import { dispatchReplyFromConfig } from "../auto-reply/reply/dispatch-from-config.js";
import {
  buildMentionRegexes,
  matchesMentionPatterns,
} from "../auto-reply/reply/mentions.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import type { TypingController } from "../auto-reply/reply/typing.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type {
  DiscordSlashCommandConfig,
  ReplyToMode,
} from "../config/config.js";
import { loadConfig } from "../config/config.js";
import {
  resolveSessionKey,
  resolveStorePath,
  updateLastRoute,
} from "../config/sessions.js";
import { danger, logVerbose, shouldLogVerbose } from "../globals.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { getChildLogger } from "../logging.js";
import { detectMime } from "../media/mime.js";
import { saveMediaBuffer } from "../media/store.js";
import {
  readProviderAllowFromStore,
  upsertProviderPairingRequest,
} from "../pairing/pairing-store.js";
import type { RuntimeEnv } from "../runtime.js";
import { sendMessageDiscord } from "./send.js";
import { normalizeDiscordToken } from "./token.js";

export type MonitorDiscordOpts = {
  token?: string;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  mediaMaxMb?: number;
  historyLimit?: number;
  replyToMode?: ReplyToMode;
  slashCommand?: DiscordSlashCommandConfig;
};

type DiscordMediaInfo = {
  path: string;
  contentType?: string;
  placeholder: string;
};

type DiscordHistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
  messageId?: string;
};

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
  channels?: Record<string, { allow?: boolean; requireMention?: boolean }>;
};

export type DiscordChannelConfigResolved = {
  allowed: boolean;
  requireMention?: boolean;
};

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
  const cfg = loadConfig();
  const token = normalizeDiscordToken(
    opts.token ??
      process.env.DISCORD_BOT_TOKEN ??
      cfg.discord?.token ??
      undefined,
  );
  if (!token) {
    throw new Error(
      "DISCORD_BOT_TOKEN or discord.token is required for Discord gateway",
    );
  }

  const runtime: RuntimeEnv = opts.runtime ?? {
    log: console.log,
    error: console.error,
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };

  const dmConfig = cfg.discord?.dm;
  const guildEntries = cfg.discord?.guilds;
  const groupPolicy = cfg.discord?.groupPolicy ?? "open";
  const dmPolicy = dmConfig?.policy ?? "pairing";
  const allowFrom = dmConfig?.allowFrom;
  const mediaMaxBytes =
    (opts.mediaMaxMb ?? cfg.discord?.mediaMaxMb ?? 8) * 1024 * 1024;
  const textLimit = resolveTextChunkLimit(cfg, "discord");
  const mentionRegexes = buildMentionRegexes(cfg);
  const ackReaction = (cfg.messages?.ackReaction ?? "").trim();
  const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
  const historyLimit = Math.max(
    0,
    opts.historyLimit ?? cfg.discord?.historyLimit ?? 20,
  );
  const replyToMode = opts.replyToMode ?? cfg.discord?.replyToMode ?? "off";
  const dmEnabled = dmConfig?.enabled ?? true;
  const groupDmEnabled = dmConfig?.groupEnabled ?? false;
  const groupDmChannels = dmConfig?.groupChannels;

  if (shouldLogVerbose()) {
    logVerbose(
      `discord: config dm=${dmEnabled ? "on" : "off"} dmPolicy=${dmPolicy} allowFrom=${summarizeAllowList(allowFrom)} groupDm=${groupDmEnabled ? "on" : "off"} groupDmChannels=${summarizeAllowList(groupDmChannels)} groupPolicy=${groupPolicy} guilds=${summarizeGuilds(guildEntries)} historyLimit=${historyLimit} mediaMaxMb=${Math.round(mediaMaxBytes / (1024 * 1024))}`,
    );
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.DirectMessageReactions,
    ],
    partials: [
      Partials.Channel,
      Partials.Message,
      Partials.Reaction,
      Partials.User,
    ],
  });

  const logger = getChildLogger({ module: "discord-auto-reply" });
  const guildHistories = new Map<string, DiscordHistoryEntry[]>();

  client.once(Events.ClientReady, () => {
    runtime.log?.(`logged in as ${client.user?.tag ?? "unknown"}`);
  });

  client.on(Events.Error, (err) => {
    runtime.error?.(danger(`client error: ${String(err)}`));
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      if (message.author?.bot) return;
      if (!message.author) return;

      // Discord.js typing excludes GroupDM for message.channel.type; widen for runtime check.
      const channelType = message.channel.type as ChannelType;
      const isGroupDm = channelType === ChannelType.GroupDM;
      const isDirectMessage = channelType === ChannelType.DM;
      const isGuildMessage = Boolean(message.guild);
      if (isGroupDm && !groupDmEnabled) {
        logVerbose("discord: drop group dm (group dms disabled)");
        return;
      }
      if (isDirectMessage && !dmEnabled) {
        logVerbose("discord: drop dm (dms disabled)");
        return;
      }
      if (isDirectMessage && dmPolicy === "disabled") {
        logVerbose("discord: drop dm (dmPolicy: disabled)");
        return;
      }
      const botId = client.user?.id;
      const forwardedSnapshot = resolveForwardedSnapshot(message);
      const forwardedText = forwardedSnapshot
        ? resolveDiscordSnapshotText(forwardedSnapshot.snapshot)
        : "";
      const baseText = resolveDiscordMessageText(message, forwardedText);
      const wasMentioned =
        !isDirectMessage &&
        (Boolean(botId && message.mentions.has(botId)) ||
          matchesMentionPatterns(baseText, mentionRegexes));
      if (shouldLogVerbose()) {
        logVerbose(
          `discord: inbound id=${message.id} guild=${message.guild?.id ?? "dm"} channel=${message.channelId} mention=${wasMentioned ? "yes" : "no"} type=${isDirectMessage ? "dm" : isGroupDm ? "group-dm" : "guild"} content=${baseText ? "yes" : "no"}`,
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
            guild: message.guild,
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
          `Blocked discord guild ${message.guild?.id ?? "unknown"} (not in discord.guilds)`,
        );
        return;
      }

      const channelName =
        (isGuildMessage || isGroupDm) && "name" in message.channel
          ? message.channel.name
          : undefined;
      const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
      const guildSlug =
        guildInfo?.slug ||
        (message.guild?.name ? normalizeDiscordSlug(message.guild.name) : "");
      const channelConfig = isGuildMessage
        ? resolveDiscordChannelConfig({
            guildInfo,
            channelId: message.channelId,
            channelName,
            channelSlug,
          })
        : null;

      const groupDmAllowed =
        isGroupDm &&
        resolveGroupDmAllow({
          channels: groupDmChannels,
          channelId: message.channelId,
          channelName,
          channelSlug,
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

      if (isGuildMessage && historyLimit > 0 && baseText) {
        const history = guildHistories.get(message.channelId) ?? [];
        history.push({
          sender: message.member?.displayName ?? message.author.tag,
          body: baseText,
          timestamp: message.createdTimestamp,
          messageId: message.id,
        });
        while (history.length > historyLimit) history.shift();
        guildHistories.set(message.channelId, history);
      }

      const resolvedRequireMention =
        channelConfig?.requireMention ?? guildInfo?.requireMention ?? true;
      const hasAnyMention = Boolean(
        !isDirectMessage &&
          (message.mentions?.everyone ||
            (message.mentions?.users?.size ?? 0) > 0 ||
            (message.mentions?.roles?.size ?? 0) > 0),
      );
      const commandAuthorized = resolveDiscordCommandAuthorized({
        isDirectMessage,
        allowFrom,
        guildInfo,
        author: message.author,
      });
      const shouldBypassMention =
        isGuildMessage &&
        resolvedRequireMention &&
        !wasMentioned &&
        !hasAnyMention &&
        commandAuthorized &&
        hasControlCommand(baseText);
      const canDetectMention = Boolean(botId) || mentionRegexes.length > 0;
      if (isGuildMessage && resolvedRequireMention && canDetectMention) {
        if (!wasMentioned && !shouldBypassMention) {
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
        const userAllow = guildInfo?.users;
        if (Array.isArray(userAllow) && userAllow.length > 0) {
          const users = normalizeDiscordAllowList(userAllow, [
            "discord:",
            "user:",
          ]);
          const userOk =
            !users ||
            allowListMatches(users, {
              id: message.author.id,
              name: message.author.username,
              tag: message.author.tag,
            });
          if (!userOk) {
            logVerbose(
              `Blocked discord guild sender ${message.author.id} (not in guild users allowlist)`,
            );
            return;
          }
        }
      }

      if (isDirectMessage && dmPolicy !== "open") {
        const storeAllowFrom = await readProviderAllowFromStore(
          "discord",
        ).catch(() => []);
        const effectiveAllowFrom = Array.from(
          new Set([...(allowFrom ?? []), ...storeAllowFrom]),
        );
        const allowList = normalizeDiscordAllowList(effectiveAllowFrom, [
          "discord:",
          "user:",
        ]);
        const permitted =
          allowList != null &&
          allowListMatches(allowList, {
            id: message.author.id,
            name: message.author.username,
            tag: message.author.tag,
          });
        if (!permitted) {
          if (dmPolicy === "pairing") {
            const { code } = await upsertProviderPairingRequest({
              provider: "discord",
              id: message.author.id,
              meta: {
                username: message.author.username,
                tag: message.author.tag,
              },
            });
            logVerbose(
              `discord pairing request sender=${message.author.id} tag=${message.author.tag} code=${code}`,
            );
            try {
              await message.reply(
                [
                  "Clawdbot: access not configured.",
                  "",
                  `Pairing code: ${code}`,
                  "",
                  "Ask the bot owner to approve with:",
                  "clawdbot pairing approve --provider discord <code>",
                ].join("\n"),
              );
            } catch (err) {
              logVerbose(
                `discord pairing reply failed for ${message.author.id}: ${String(err)}`,
              );
            }
          } else {
            logVerbose(
              `Blocked unauthorized discord sender ${message.author.id} (dmPolicy=${dmPolicy})`,
            );
          }
          return;
        }
      }

      const systemText = resolveDiscordSystemEvent(message);
      if (systemText) {
        const sessionCfg = cfg.session;
        const sessionScope = sessionCfg?.scope ?? "per-sender";
        const mainKey = (sessionCfg?.mainKey ?? "main").trim() || "main";
        const sessionKey = resolveSessionKey(
          sessionScope,
          {
            From: isDirectMessage
              ? `discord:${message.author.id}`
              : `group:${message.channelId}`,
            ChatType: isDirectMessage ? "direct" : "group",
            Surface: "discord",
          },
          mainKey,
        );
        enqueueSystemEvent(systemText, {
          sessionKey,
          contextKey: `discord:system:${message.channelId}:${message.id}`,
        });
        return;
      }

      const media = await resolveMedia(message, mediaMaxBytes);
      const text =
        message.content?.trim() ??
        media?.placeholder ??
        message.embeds[0]?.description ??
        (forwardedSnapshot ? "<forwarded message>" : "");
      if (!text) {
        logVerbose(`discord: drop message ${message.id} (empty content)`);
        return;
      }
      const shouldAckReaction = () => {
        if (!ackReaction) return false;
        if (ackReactionScope === "all") return true;
        if (ackReactionScope === "direct") return isDirectMessage;
        const isGroupChat = isGuildMessage || isGroupDm;
        if (ackReactionScope === "group-all") return isGroupChat;
        if (ackReactionScope === "group-mentions") {
          if (!isGuildMessage) return false;
          if (!resolvedRequireMention) return false;
          if (!canDetectMention) return false;
          return wasMentioned || shouldBypassMention;
        }
        return false;
      };
      if (shouldAckReaction()) {
        message.react(ackReaction).catch((err) => {
          logVerbose(
            `discord react failed for channel ${message.channelId}: ${String(err)}`,
          );
        });
      }

      const fromLabel = isDirectMessage
        ? buildDirectLabel(message)
        : buildGuildLabel(message);
      const groupRoom =
        isGuildMessage && channelSlug ? `#${channelSlug}` : undefined;
      const groupSubject = isDirectMessage ? undefined : groupRoom;
      const messageText = text;
      let combinedBody = formatAgentEnvelope({
        surface: "Discord",
        from: fromLabel,
        timestamp: message.createdTimestamp,
        body: messageText,
      });
      let shouldClearHistory = false;
      if (!isDirectMessage) {
        const history =
          historyLimit > 0 ? (guildHistories.get(message.channelId) ?? []) : [];
        const historyWithoutCurrent =
          history.length > 0 ? history.slice(0, -1) : [];
        if (historyWithoutCurrent.length > 0) {
          const historyText = historyWithoutCurrent
            .map((entry) =>
              formatAgentEnvelope({
                surface: "Discord",
                from: fromLabel,
                timestamp: entry.timestamp,
                body: `${entry.sender}: ${entry.body} [id:${entry.messageId ?? "unknown"} channel:${message.channelId}]`,
              }),
            )
            .join("\n");
          combinedBody = `[Chat messages since your last reply - for context]\n${historyText}\n\n[Current message - respond to this]\n${combinedBody}`;
        }
        const name = message.author.tag;
        const id = message.author.id;
        combinedBody = `${combinedBody}\n[from: ${name} user id:${id}]`;
        shouldClearHistory = true;
      }
      const replyContext = await resolveReplyContext(message);
      if (replyContext) {
        combinedBody = `[Replied message - for context]\n${replyContext}\n\n${combinedBody}`;
      }
      if (forwardedSnapshot) {
        const forwarderName = message.author.tag ?? message.author.username;
        const forwarder = forwarderName
          ? `${forwarderName} id:${message.author.id}`
          : message.author.id;
        const snapshotText =
          resolveDiscordSnapshotText(forwardedSnapshot.snapshot) ||
          "<forwarded message>";
        const forwardMetaParts = [
          forwardedSnapshot.messageId
            ? `forwarded message id: ${forwardedSnapshot.messageId}`
            : null,
          forwardedSnapshot.channelId
            ? `channel: ${forwardedSnapshot.channelId}`
            : null,
          forwardedSnapshot.guildId
            ? `guild: ${forwardedSnapshot.guildId}`
            : null,
          typeof forwardedSnapshot.snapshot.type === "number"
            ? `snapshot type: ${forwardedSnapshot.snapshot.type}`
            : null,
        ].filter((entry): entry is string => Boolean(entry));
        const forwardedBody = forwardMetaParts.length
          ? `${snapshotText}\n[${forwardMetaParts.join(" ")}]`
          : snapshotText;
        const forwardedEnvelope = formatAgentEnvelope({
          surface: "Discord",
          from: `Forwarded by ${forwarder}`,
          timestamp:
            forwardedSnapshot.snapshot.createdTimestamp ??
            message.createdTimestamp ??
            undefined,
          body: forwardedBody,
        });
        combinedBody = `[Forwarded message]\n${forwardedEnvelope}\n\n${combinedBody}`;
      }

      const ctxPayload = {
        Body: combinedBody,
        From: isDirectMessage
          ? `discord:${message.author.id}`
          : `group:${message.channelId}`,
        To: `channel:${message.channelId}`,
        ChatType: isDirectMessage ? "direct" : "group",
        SenderName: message.member?.displayName ?? message.author.tag,
        SenderId: message.author.id,
        SenderUsername: message.author.username,
        SenderTag: message.author.tag,
        GroupSubject: groupSubject,
        GroupRoom: groupRoom,
        GroupSpace: isGuildMessage
          ? (guildInfo?.id ?? guildSlug) || undefined
          : undefined,
        Surface: "discord" as const,
        WasMentioned: wasMentioned,
        MessageSid: message.id,
        Timestamp: message.createdTimestamp,
        MediaPath: media?.path,
        MediaType: media?.contentType,
        MediaUrl: media?.path,
        CommandAuthorized: commandAuthorized,
      };
      const replyTarget = ctxPayload.To ?? undefined;
      if (!replyTarget) {
        runtime.error?.(danger("discord: missing reply target"));
        return;
      }

      if (isDirectMessage) {
        const sessionCfg = cfg.session;
        const mainKey = (sessionCfg?.mainKey ?? "main").trim() || "main";
        const storePath = resolveStorePath(sessionCfg?.store);
        await updateLastRoute({
          storePath,
          sessionKey: mainKey,
          channel: "discord",
          to: `user:${message.author.id}`,
        });
      }

      if (shouldLogVerbose()) {
        const preview = combinedBody.slice(0, 200).replace(/\n/g, "\\n");
        logVerbose(
          `discord inbound: channel=${message.channelId} from=${ctxPayload.From} preview="${preview}"`,
        );
      }

      let didSendReply = false;
      let typingController: TypingController | undefined;
      const dispatcher = createReplyDispatcher({
        responsePrefix: cfg.messages?.responsePrefix,
        deliver: async (payload) => {
          await deliverReplies({
            replies: [payload],
            target: replyTarget,
            token,
            runtime,
            replyToMode,
            textLimit,
          });
          didSendReply = true;
        },
        onIdle: () => {
          typingController?.markDispatchIdle();
        },
        onError: (err, info) => {
          runtime.error?.(
            danger(`discord ${info.kind} reply failed: ${String(err)}`),
          );
        },
      });

      const { queuedFinal, counts } = await dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg,
        dispatcher,
        replyOptions: {
          onReplyStart: () => sendTyping(message),
          onTypingController: (typing) => {
            typingController = typing;
          },
        },
      });
      typingController?.markDispatchIdle();
      if (!queuedFinal) {
        if (
          isGuildMessage &&
          shouldClearHistory &&
          historyLimit > 0 &&
          didSendReply
        ) {
          guildHistories.set(message.channelId, []);
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
      if (
        isGuildMessage &&
        shouldClearHistory &&
        historyLimit > 0 &&
        didSendReply
      ) {
        guildHistories.set(message.channelId, []);
      }
    } catch (err) {
      runtime.error?.(danger(`handler failed: ${String(err)}`));
    }
  });

  const handleReactionEvent = async (
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
    action: "added" | "removed",
  ) => {
    try {
      if (!user || user.bot) return;
      const resolvedReaction = reaction.partial
        ? await reaction.fetch()
        : reaction;
      const message = (resolvedReaction.message as Message | PartialMessage)
        .partial
        ? await resolvedReaction.message.fetch()
        : resolvedReaction.message;
      const guild = message.guild;
      if (!guild) return;
      const guildInfo = resolveDiscordGuildEntry({
        guild,
        guildEntries,
      });
      if (guildEntries && Object.keys(guildEntries).length > 0 && !guildInfo) {
        return;
      }
      const channelName =
        "name" in message.channel
          ? (message.channel.name ?? undefined)
          : undefined;
      const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
      const channelConfig = resolveDiscordChannelConfig({
        guildInfo,
        channelId: message.channelId,
        channelName,
        channelSlug,
      });
      if (channelConfig?.allowed === false) return;

      const botId = client.user?.id;
      if (botId && user.id === botId) return;

      const reactionMode = guildInfo?.reactionNotifications ?? "own";
      const shouldNotify = shouldEmitDiscordReactionNotification({
        mode: reactionMode,
        botId,
        messageAuthorId: message.author?.id,
        userId: user.id,
        userName: user.username,
        userTag: user.tag,
        allowlist: guildInfo?.users,
      });
      if (!shouldNotify) return;

      const emojiLabel = formatDiscordReactionEmoji(resolvedReaction);
      const actorLabel = user.tag ?? user.username ?? user.id;
      const guildSlug =
        guildInfo?.slug ||
        (guild.name ? normalizeDiscordSlug(guild.name) : guild.id);
      const channelLabel = channelSlug
        ? `#${channelSlug}`
        : channelName
          ? `#${normalizeDiscordSlug(channelName)}`
          : `#${message.channelId}`;
      const authorLabel = message.author?.tag ?? message.author?.username;
      const baseText = `Discord reaction ${action}: ${emojiLabel} by ${actorLabel} on ${guildSlug} ${channelLabel} msg ${message.id}`;
      const text = authorLabel ? `${baseText} from ${authorLabel}` : baseText;
      const sessionCfg = cfg.session;
      const sessionScope = sessionCfg?.scope ?? "per-sender";
      const mainKey = (sessionCfg?.mainKey ?? "main").trim() || "main";
      const sessionKey = resolveSessionKey(
        sessionScope,
        {
          From: `group:${message.channelId}`,
          ChatType: "group",
          Surface: "discord",
        },
        mainKey,
      );
      enqueueSystemEvent(text, {
        sessionKey,
        contextKey: `discord:reaction:${action}:${message.id}:${user.id}:${emojiLabel}`,
      });
    } catch (err) {
      runtime.error?.(
        danger(`discord reaction handler failed: ${String(err)}`),
      );
    }
  };

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    await handleReactionEvent(reaction, user, "added");
  });

  client.on(Events.MessageReactionRemove, async (reaction, user) => {
    await handleReactionEvent(reaction, user, "removed");
  });

  await client.login(token);

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      void client.destroy();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      opts.abortSignal?.removeEventListener("abort", onAbort);
      client.off(Events.Error, onError);
    };
    opts.abortSignal?.addEventListener("abort", onAbort, { once: true });
    client.on(Events.Error, onError);
  });
}

async function resolveMedia(
  message: Message,
  maxBytes: number,
): Promise<DiscordMediaInfo | null> {
  const attachment = message.attachments.first();
  if (!attachment) return null;
  const res = await fetch(attachment.url);
  if (!res.ok) {
    throw new Error(
      `Failed to download discord attachment: HTTP ${res.status}`,
    );
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const mime = await detectMime({
    buffer,
    headerMime: attachment.contentType ?? res.headers.get("content-type"),
    filePath: attachment.name ?? attachment.url,
  });
  const saved = await saveMediaBuffer(buffer, mime, "inbound", maxBytes);
  return {
    path: saved.path,
    contentType: saved.contentType,
    placeholder: inferPlaceholder(attachment),
  };
}

function inferPlaceholder(attachment: Attachment): string {
  const mime = attachment.contentType ?? "";
  if (mime.startsWith("image/")) return "<media:image>";
  if (mime.startsWith("video/")) return "<media:video>";
  if (mime.startsWith("audio/")) return "<media:audio>";
  return "<media:document>";
}

function resolveDiscordMessageText(
  message: Message,
  fallbackText?: string,
): string {
  const attachment = message.attachments.first();
  return (
    message.content?.trim() ||
    (attachment ? inferPlaceholder(attachment) : "") ||
    message.embeds[0]?.description ||
    fallbackText?.trim() ||
    ""
  );
}

function resolveDiscordSnapshotText(snapshot: MessageSnapshot): string {
  return snapshot.content?.trim() || snapshot.embeds[0]?.description || "";
}

async function resolveReplyContext(message: Message): Promise<string | null> {
  if (!message.reference?.messageId) return null;
  try {
    const referenced = await message.fetchReference();
    if (!referenced?.author) return null;
    const referencedText = resolveDiscordMessageText(referenced);
    if (!referencedText) return null;
    const channelType = referenced.channel.type as ChannelType;
    const isDirectMessage = channelType === ChannelType.DM;
    const fromLabel = isDirectMessage
      ? buildDirectLabel(referenced)
      : (referenced.member?.displayName ?? referenced.author.tag);
    const body = `${referencedText}\n[discord message id: ${referenced.id} channel: ${referenced.channelId} from: ${referenced.author.tag} user id:${referenced.author.id}]`;
    return formatAgentEnvelope({
      surface: "Discord",
      from: fromLabel,
      timestamp: referenced.createdTimestamp,
      body,
    });
  } catch (err) {
    logVerbose(
      `discord: failed to fetch reply context for ${message.id}: ${String(err)}`,
    );
    return null;
  }
}

function buildDirectLabel(message: Message) {
  const username = message.author.tag;
  return `${username} user id:${message.author.id}`;
}

function buildGuildLabel(message: Message) {
  const channelName =
    "name" in message.channel ? message.channel.name : message.channelId;
  return `${message.guild?.name ?? "Guild"} #${channelName} channel id:${message.channelId}`;
}

function resolveDiscordSystemEvent(message: Message): string | null {
  switch (message.type) {
    case MessageType.ChannelPinnedMessage:
      return buildDiscordSystemEvent(message, "pinned a message");
    case MessageType.RecipientAdd:
      return buildDiscordSystemEvent(message, "added a recipient");
    case MessageType.RecipientRemove:
      return buildDiscordSystemEvent(message, "removed a recipient");
    case MessageType.UserJoin:
      return buildDiscordSystemEvent(message, "user joined");
    case MessageType.GuildBoost:
      return buildDiscordSystemEvent(message, "boosted the server");
    case MessageType.GuildBoostTier1:
      return buildDiscordSystemEvent(
        message,
        "boosted the server (Tier 1 reached)",
      );
    case MessageType.GuildBoostTier2:
      return buildDiscordSystemEvent(
        message,
        "boosted the server (Tier 2 reached)",
      );
    case MessageType.GuildBoostTier3:
      return buildDiscordSystemEvent(
        message,
        "boosted the server (Tier 3 reached)",
      );
    case MessageType.ThreadCreated:
      return buildDiscordSystemEvent(message, "created a thread");
    case MessageType.AutoModerationAction:
      return buildDiscordSystemEvent(message, "auto moderation action");
    case MessageType.GuildIncidentAlertModeEnabled:
      return buildDiscordSystemEvent(message, "raid protection enabled");
    case MessageType.GuildIncidentAlertModeDisabled:
      return buildDiscordSystemEvent(message, "raid protection disabled");
    case MessageType.GuildIncidentReportRaid:
      return buildDiscordSystemEvent(message, "raid reported");
    case MessageType.GuildIncidentReportFalseAlarm:
      return buildDiscordSystemEvent(message, "raid report marked false alarm");
    case MessageType.StageStart:
      return buildDiscordSystemEvent(message, "stage started");
    case MessageType.StageEnd:
      return buildDiscordSystemEvent(message, "stage ended");
    case MessageType.StageSpeaker:
      return buildDiscordSystemEvent(message, "stage speaker updated");
    case MessageType.StageTopic:
      return buildDiscordSystemEvent(message, "stage topic updated");
    case MessageType.PollResult:
      return buildDiscordSystemEvent(message, "poll results posted");
    case MessageType.PurchaseNotification:
      return buildDiscordSystemEvent(message, "purchase notification");
    default:
      return null;
  }
}

function resolveForwardedSnapshot(message: Message): {
  snapshot: MessageSnapshot;
  messageId?: string;
  channelId?: string;
  guildId?: string;
} | null {
  const snapshots = message.messageSnapshots;
  if (!snapshots || snapshots.size === 0) return null;
  const snapshot = snapshots.first();
  if (!snapshot) return null;
  const reference = message.reference;
  return {
    snapshot,
    messageId: reference?.messageId ?? undefined,
    channelId: reference?.channelId ?? undefined,
    guildId: reference?.guildId ?? undefined,
  };
}

function buildDiscordSystemEvent(message: Message, action: string) {
  const channelName =
    "name" in message.channel ? message.channel.name : message.channelId;
  const channelType = message.channel.type as ChannelType;
  const location = message.guild?.name
    ? `${message.guild.name} #${channelName}`
    : channelType === ChannelType.GroupDM
      ? `Group DM #${channelName}`
      : "DM";
  const authorLabel = message.author?.tag ?? message.author?.username;
  const actor = authorLabel ? `${authorLabel} ` : "";
  return `Discord system: ${actor}${action} in ${location}`;
}

function formatDiscordReactionEmoji(
  reaction: MessageReaction | PartialMessageReaction,
) {
  if (typeof reaction.emoji.toString === "function") {
    const rendered = reaction.emoji.toString();
    if (rendered && rendered !== "[object Object]") return rendered;
  }
  if (reaction.emoji.id && reaction.emoji.name) {
    return `${reaction.emoji.name}:${reaction.emoji.id}`;
  }
  return reaction.emoji.name ?? "emoji";
}

export function normalizeDiscordAllowList(
  raw: Array<string | number> | undefined,
  prefixes: string[],
): DiscordAllowList | null {
  if (!raw || raw.length === 0) return null;
  const ids = new Set<string>();
  const names = new Set<string>();
  let allowAll = false;

  for (const rawEntry of raw) {
    let entry = String(rawEntry).trim();
    if (!entry) continue;
    if (entry === "*") {
      allowAll = true;
      continue;
    }
    for (const prefix of prefixes) {
      if (entry.toLowerCase().startsWith(prefix)) {
        entry = entry.slice(prefix.length);
        break;
      }
    }
    const mentionMatch = entry.match(/^<[@#][!]?(\d+)>$/);
    if (mentionMatch?.[1]) {
      ids.add(mentionMatch[1]);
      continue;
    }
    entry = entry.trim();
    if (entry.startsWith("@") || entry.startsWith("#")) {
      entry = entry.slice(1);
    }
    if (/^\d+$/.test(entry)) {
      ids.add(entry);
      continue;
    }
    const normalized = normalizeDiscordName(entry);
    if (normalized) names.add(normalized);
    const slugged = normalizeDiscordSlug(entry);
    if (slugged) names.add(slugged);
  }

  if (!allowAll && ids.size === 0 && names.size === 0) return null;
  return { allowAll, ids, names };
}

function normalizeDiscordName(value?: string | null) {
  if (!value) return "";
  return value.trim().toLowerCase();
}

export function normalizeDiscordSlug(value?: string | null) {
  if (!value) return "";
  let text = value.trim().toLowerCase();
  if (!text) return "";
  text = text.replace(/^[@#]+/, "");
  text = text.replace(/[\s_]+/g, "-");
  text = text.replace(/[^a-z0-9-]+/g, "-");
  text = text.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  return text;
}

export function allowListMatches(
  allowList: DiscordAllowList,
  candidates: {
    id?: string;
    name?: string | null;
    tag?: string | null;
  },
) {
  if (allowList.allowAll) return true;
  const { id, name, tag } = candidates;
  if (id && allowList.ids.has(id)) return true;
  const normalizedName = normalizeDiscordName(name);
  if (normalizedName && allowList.names.has(normalizedName)) return true;
  const normalizedTag = normalizeDiscordName(tag);
  if (normalizedTag && allowList.names.has(normalizedTag)) return true;
  const slugName = normalizeDiscordSlug(name);
  if (slugName && allowList.names.has(slugName)) return true;
  const slugTag = normalizeDiscordSlug(tag);
  if (slugTag && allowList.names.has(slugTag)) return true;
  return false;
}

function resolveDiscordCommandAuthorized(params: {
  isDirectMessage: boolean;
  allowFrom?: Array<string | number>;
  guildInfo?: DiscordGuildEntryResolved | null;
  author: User;
}): boolean {
  const { isDirectMessage, allowFrom, guildInfo, author } = params;
  if (isDirectMessage) {
    if (!Array.isArray(allowFrom) || allowFrom.length === 0) return true;
    const allowList = normalizeDiscordAllowList(allowFrom, [
      "discord:",
      "user:",
    ]);
    if (!allowList) return true;
    return allowListMatches(allowList, {
      id: author.id,
      name: author.username,
      tag: author.tag,
    });
  }
  const users = guildInfo?.users;
  if (!Array.isArray(users) || users.length === 0) return true;
  const allowList = normalizeDiscordAllowList(users, ["discord:", "user:"]);
  if (!allowList) return true;
  return allowListMatches(allowList, {
    id: author.id,
    name: author.username,
    tag: author.tag,
  });
}

export function shouldEmitDiscordReactionNotification(params: {
  mode: "off" | "own" | "all" | "allowlist" | undefined;
  botId?: string | null;
  messageAuthorId?: string | null;
  userId: string;
  userName?: string | null;
  userTag?: string | null;
  allowlist?: Array<string | number> | null;
}) {
  const { mode, botId, messageAuthorId, userId, userName, userTag, allowlist } =
    params;
  const effectiveMode = mode ?? "own";
  if (effectiveMode === "off") return false;
  if (effectiveMode === "own") {
    if (!botId || !messageAuthorId) return false;
    return messageAuthorId === botId;
  }
  if (effectiveMode === "allowlist") {
    if (!Array.isArray(allowlist) || allowlist.length === 0) return false;
    const users = normalizeDiscordAllowList(allowlist, ["discord:", "user:"]);
    if (!users) return false;
    return allowListMatches(users, {
      id: userId,
      name: userName ?? undefined,
      tag: userTag ?? undefined,
    });
  }
  return true;
}

export function resolveDiscordGuildEntry(params: {
  guild: Guild | null;
  guildEntries: Record<string, DiscordGuildEntryResolved> | undefined;
}): DiscordGuildEntryResolved | null {
  const { guild, guildEntries } = params;
  if (!guild || !guildEntries || Object.keys(guildEntries).length === 0) {
    return null;
  }
  const guildId = guild.id;
  const guildSlug = normalizeDiscordSlug(guild.name);
  const direct = guildEntries[guildId];
  if (direct) {
    return {
      id: guildId,
      slug: direct.slug ?? guildSlug,
      requireMention: direct.requireMention,
      reactionNotifications: direct.reactionNotifications,
      users: direct.users,
      channels: direct.channels,
    };
  }
  if (guildSlug && guildEntries[guildSlug]) {
    const entry = guildEntries[guildSlug];
    return {
      id: guildId,
      slug: entry.slug ?? guildSlug,
      requireMention: entry.requireMention,
      reactionNotifications: entry.reactionNotifications,
      users: entry.users,
      channels: entry.channels,
    };
  }
  const matchBySlug = Object.entries(guildEntries).find(([, entry]) => {
    const entrySlug = normalizeDiscordSlug(entry.slug);
    return entrySlug && entrySlug === guildSlug;
  });
  if (matchBySlug) {
    const entry = matchBySlug[1];
    return {
      id: guildId,
      slug: entry.slug ?? guildSlug,
      requireMention: entry.requireMention,
      reactionNotifications: entry.reactionNotifications,
      users: entry.users,
      channels: entry.channels,
    };
  }
  const wildcard = guildEntries["*"];
  if (wildcard) {
    return {
      id: guildId,
      slug: wildcard.slug ?? guildSlug,
      requireMention: wildcard.requireMention,
      reactionNotifications: wildcard.reactionNotifications,
      users: wildcard.users,
      channels: wildcard.channels,
    };
  }
  return null;
}

export function resolveDiscordChannelConfig(params: {
  guildInfo: DiscordGuildEntryResolved | null;
  channelId: string;
  channelName?: string;
  channelSlug?: string;
}): DiscordChannelConfigResolved | null {
  const { guildInfo, channelId, channelName, channelSlug } = params;
  const channelEntries = guildInfo?.channels;
  if (channelEntries && Object.keys(channelEntries).length > 0) {
    const entry =
      channelEntries[channelId] ??
      (channelSlug
        ? (channelEntries[channelSlug] ?? channelEntries[`#${channelSlug}`])
        : undefined) ??
      (channelName
        ? channelEntries[normalizeDiscordSlug(channelName)]
        : undefined);
    if (!entry) return { allowed: false };
    return {
      allowed: entry.allow !== false,
      requireMention: entry.requireMention,
    };
  }
  return { allowed: true };
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
  channels: Array<string | number> | undefined;
  channelId: string;
  channelName?: string;
  channelSlug?: string;
}) {
  const { channels, channelId, channelName, channelSlug } = params;
  if (!channels || channels.length === 0) return true;
  const allowList = normalizeDiscordAllowList(channels, ["channel:"]);
  if (!allowList) return true;
  return allowListMatches(allowList, {
    id: channelId,
    name: channelSlug || channelName,
  });
}

async function sendTyping(message: Message) {
  try {
    const channel = message.channel;
    if (channel.isSendable()) {
      await channel.sendTyping();
    }
  } catch {
    /* ignore */
  }
}

async function deliverReplies({
  replies,
  target,
  token,
  runtime,
  replyToMode,
  textLimit,
}: {
  replies: ReplyPayload[];
  target: string;
  token: string;
  runtime: RuntimeEnv;
  replyToMode: ReplyToMode;
  textLimit: number;
}) {
  let hasReplied = false;
  const chunkLimit = Math.min(textLimit, 2000);
  for (const payload of replies) {
    const mediaList =
      payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const text = payload.text ?? "";
    const replyToId = payload.replyToId;
    if (!text && mediaList.length === 0) continue;
    if (mediaList.length === 0) {
      for (const chunk of chunkText(text, chunkLimit)) {
        const replyTo = resolveDiscordReplyTarget({
          replyToMode,
          replyToId,
          hasReplied,
        });
        await sendMessageDiscord(target, chunk, {
          token,
          replyTo,
        });
        if (replyTo && !hasReplied) {
          hasReplied = true;
        }
      }
    } else {
      let first = true;
      for (const mediaUrl of mediaList) {
        const caption = first ? text : "";
        first = false;
        const replyTo = resolveDiscordReplyTarget({
          replyToMode,
          replyToId,
          hasReplied,
        });
        await sendMessageDiscord(target, caption, {
          token,
          mediaUrl,
          replyTo,
        });
        if (replyTo && !hasReplied) {
          hasReplied = true;
        }
      }
    }
    runtime.log?.(`delivered reply to ${target}`);
  }
}
