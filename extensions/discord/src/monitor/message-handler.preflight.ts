import { ChannelType, MessageType, type Message, type User } from "@buape/carbon";
import { Routes, type APIMessage } from "discord-api-types/v10";
import { formatAllowlistMatchMeta } from "openclaw/plugin-sdk/allow-from";
import {
  buildMentionRegexes,
  implicitMentionKindWhen,
  logInboundDrop,
  matchesMentionWithExplicit,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveControlCommandGate } from "openclaw/plugin-sdk/command-auth-native";
import { hasControlCommand } from "openclaw/plugin-sdk/command-detection";
import { shouldHandleTextCommands } from "openclaw/plugin-sdk/command-surface";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/config-runtime";
import type { SessionBindingRecord } from "openclaw/plugin-sdk/conversation-binding-runtime";
import { enqueueSystemEvent, recordChannelActivity } from "openclaw/plugin-sdk/infra-runtime";
import {
  recordPendingHistoryEntryIfEnabled,
  type HistoryEntry,
} from "openclaw/plugin-sdk/reply-history";
import { getChildLogger, logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { logDebug, normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { resolveDefaultDiscordAccountId } from "../accounts.js";
import { resolveDiscordConversationIdentity } from "../conversation-identity.js";
import {
  isDiscordGroupAllowedByPolicy,
  normalizeDiscordSlug,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordGuildEntry,
  resolveDiscordMemberAccessState,
  resolveDiscordOwnerAccess,
  resolveDiscordShouldRequireMention,
  resolveGroupDmAllow,
} from "./allow-list.js";
import { resolveDiscordChannelInfoSafe, resolveDiscordChannelNameSafe } from "./channel-access.js";
import { resolveDiscordDmCommandAccess } from "./dm-command-auth.js";
import { handleDiscordDmCommandDecision } from "./dm-command-decision.js";
import {
  formatDiscordUserTag,
  resolveDiscordSystemLocation,
  resolveTimestampMs,
} from "./format.js";
import type {
  DiscordMessagePreflightContext,
  DiscordMessagePreflightParams,
} from "./message-handler.preflight.types.js";
import {
  resolveDiscordChannelInfo,
  resolveDiscordMessageChannelId,
  resolveDiscordMessageText,
} from "./message-utils.js";
import {
  buildDiscordRoutePeer,
  resolveDiscordConversationRoute,
  resolveDiscordEffectiveRoute,
} from "./route-resolution.js";
import { resolveDiscordSenderIdentity, resolveDiscordWebhookId } from "./sender-identity.js";
import { isRecentlyUnboundThreadWebhookMessage } from "./thread-bindings.js";

export type {
  DiscordMessagePreflightContext,
  DiscordMessagePreflightParams,
} from "./message-handler.preflight.types.js";

const DISCORD_BOUND_THREAD_SYSTEM_PREFIXES = ["⚙️", "🤖", "🧰"];

let conversationRuntimePromise:
  | Promise<typeof import("openclaw/plugin-sdk/conversation-binding-runtime")>
  | undefined;
let pluralkitRuntimePromise: Promise<typeof import("../pluralkit.js")> | undefined;
let discordSendRuntimePromise: Promise<typeof import("../send.js")> | undefined;
let preflightAudioRuntimePromise: Promise<typeof import("./preflight-audio.js")> | undefined;
let systemEventsRuntimePromise: Promise<typeof import("./system-events.js")> | undefined;
let discordThreadingRuntimePromise: Promise<typeof import("./threading.js")> | undefined;

async function loadConversationRuntime() {
  conversationRuntimePromise ??= import("openclaw/plugin-sdk/conversation-binding-runtime");
  return await conversationRuntimePromise;
}

async function loadPluralKitRuntime() {
  pluralkitRuntimePromise ??= import("../pluralkit.js");
  return await pluralkitRuntimePromise;
}

async function loadDiscordSendRuntime() {
  discordSendRuntimePromise ??= import("../send.js");
  return await discordSendRuntimePromise;
}

async function loadPreflightAudioRuntime() {
  preflightAudioRuntimePromise ??= import("./preflight-audio.js");
  return await preflightAudioRuntimePromise;
}

async function loadSystemEventsRuntime() {
  systemEventsRuntimePromise ??= import("./system-events.js");
  return await systemEventsRuntimePromise;
}

async function loadDiscordThreadingRuntime() {
  discordThreadingRuntimePromise ??= import("./threading.js");
  return await discordThreadingRuntimePromise;
}

function isPreflightAborted(abortSignal?: AbortSignal): boolean {
  return Boolean(abortSignal?.aborted);
}

function isBoundThreadBotSystemMessage(params: {
  isBoundThreadSession: boolean;
  isBotAuthor: boolean;
  text?: string;
}): boolean {
  if (!params.isBoundThreadSession || !params.isBotAuthor) {
    return false;
  }
  const text = params.text?.trim();
  if (!text) {
    return false;
  }
  return DISCORD_BOUND_THREAD_SYSTEM_PREFIXES.some((prefix) => text.startsWith(prefix));
}

type BoundThreadLookupRecordLike = {
  webhookId?: string | null;
  metadata?: {
    webhookId?: string | null;
  };
};

function isDiscordThreadChannelType(type: ChannelType | undefined): boolean {
  return (
    type === ChannelType.PublicThread ||
    type === ChannelType.PrivateThread ||
    type === ChannelType.AnnouncementThread
  );
}

function isDiscordThreadChannelMessage(params: {
  isGuildMessage: boolean;
  message: Message;
  channelInfo: import("./message-utils.js").DiscordChannelInfo | null;
}): boolean {
  if (!params.isGuildMessage) {
    return false;
  }
  const channel =
    "channel" in params.message ? (params.message as { channel?: unknown }).channel : undefined;
  return Boolean(
    (channel &&
      typeof channel === "object" &&
      "isThread" in channel &&
      typeof (channel as { isThread?: unknown }).isThread === "function" &&
      (channel as { isThread: () => boolean }).isThread()) ||
    isDiscordThreadChannelType(params.channelInfo?.type),
  );
}

function resolveInjectedBoundThreadLookupRecord(params: {
  threadBindings: DiscordMessagePreflightParams["threadBindings"];
  threadId: string;
}): BoundThreadLookupRecordLike | undefined {
  const getByThreadId = (params.threadBindings as { getByThreadId?: (threadId: string) => unknown })
    .getByThreadId;
  if (typeof getByThreadId !== "function") {
    return undefined;
  }
  const binding = getByThreadId(params.threadId);
  return binding && typeof binding === "object"
    ? (binding as BoundThreadLookupRecordLike)
    : undefined;
}

function resolveDiscordMentionState(params: {
  authorIsBot: boolean;
  botId?: string;
  hasAnyMention: boolean;
  isDirectMessage: boolean;
  isExplicitlyMentioned: boolean;
  mentionRegexes: RegExp[];
  mentionText: string;
  mentionedEveryone: boolean;
  referencedAuthorId?: string;
  senderIsPluralKit: boolean;
  transcript?: string;
}) {
  if (params.isDirectMessage) {
    return {
      implicitMentionKinds: [],
      wasMentioned: false,
    };
  }

  const everyoneMentioned =
    params.mentionedEveryone && (!params.authorIsBot || params.senderIsPluralKit);
  const wasMentioned =
    everyoneMentioned ||
    matchesMentionWithExplicit({
      text: params.mentionText,
      mentionRegexes: params.mentionRegexes,
      explicit: {
        hasAnyMention: params.hasAnyMention,
        isExplicitlyMentioned: params.isExplicitlyMentioned,
        canResolveExplicit: Boolean(params.botId),
      },
      transcript: params.transcript,
    });
  const implicitMentionKinds = implicitMentionKindWhen(
    "reply_to_bot",
    Boolean(params.botId) &&
      Boolean(params.referencedAuthorId) &&
      params.referencedAuthorId === params.botId,
  );

  return {
    implicitMentionKinds,
    wasMentioned,
  };
}

export function resolvePreflightMentionRequirement(params: {
  shouldRequireMention: boolean;
  bypassMentionRequirement: boolean;
}): boolean {
  if (!params.shouldRequireMention) {
    return false;
  }
  return !params.bypassMentionRequirement;
}

export function shouldIgnoreBoundThreadWebhookMessage(params: {
  accountId?: string;
  threadId?: string;
  webhookId?: string | null;
  threadBinding?: BoundThreadLookupRecordLike;
}): boolean {
  const webhookId = normalizeOptionalString(params.webhookId) ?? "";
  if (!webhookId) {
    return false;
  }
  const boundWebhookId =
    normalizeOptionalString(params.threadBinding?.webhookId) ??
    normalizeOptionalString(params.threadBinding?.metadata?.webhookId) ??
    "";
  if (!boundWebhookId) {
    const threadId = normalizeOptionalString(params.threadId) ?? "";
    if (!threadId) {
      return false;
    }
    return isRecentlyUnboundThreadWebhookMessage({
      accountId: params.accountId,
      threadId,
      webhookId,
    });
  }
  return webhookId === boundWebhookId;
}

function mergeFetchedDiscordMessage(base: Message, fetched: APIMessage): Message {
  const baseReferenced = (
    base as unknown as {
      referencedMessage?: {
        mentionedUsers?: unknown[];
        mentionedRoles?: unknown[];
        mentionedEveryone?: boolean;
      };
    }
  ).referencedMessage;
  const fetchedMentions = Array.isArray(fetched.mentions)
    ? fetched.mentions.map((mention) => ({
        ...mention,
        globalName: mention.global_name ?? undefined,
      }))
    : undefined;
  const assignWithPrototype = <T extends object>(baseObject: T, ...sources: object[]): T =>
    Object.assign(
      Object.create(Object.getPrototypeOf(baseObject) ?? Object.prototype),
      baseObject,
      ...sources,
    ) as T;
  const referencedMessage = fetched.referenced_message
    ? assignWithPrototype(
        ((base as { referencedMessage?: Message }).referencedMessage ?? {}) as Message,
        fetched.referenced_message,
        {
          mentionedUsers: Array.isArray(fetched.referenced_message.mentions)
            ? fetched.referenced_message.mentions.map((mention) => ({
                ...mention,
                globalName: mention.global_name ?? undefined,
              }))
            : (baseReferenced?.mentionedUsers ?? []),
          mentionedRoles:
            fetched.referenced_message.mention_roles ?? baseReferenced?.mentionedRoles ?? [],
          mentionedEveryone:
            fetched.referenced_message.mention_everyone ??
            baseReferenced?.mentionedEveryone ??
            false,
        } satisfies Record<string, unknown>,
      )
    : (base as { referencedMessage?: Message }).referencedMessage;
  const baseRawData = (base as { rawData?: Record<string, unknown> }).rawData;
  const rawData = {
    ...(base as { rawData?: Record<string, unknown> }).rawData,
    message_snapshots:
      fetched.message_snapshots ??
      (base as { rawData?: { message_snapshots?: unknown } }).rawData?.message_snapshots,
    sticker_items:
      (fetched as { sticker_items?: unknown }).sticker_items ?? baseRawData?.sticker_items,
  };
  return assignWithPrototype(base, fetched, {
    content: fetched.content ?? base.content,
    attachments: fetched.attachments ?? base.attachments,
    embeds: fetched.embeds ?? base.embeds,
    stickers:
      (fetched as { stickers?: unknown }).stickers ??
      (fetched as { sticker_items?: unknown }).sticker_items ??
      base.stickers,
    mentionedUsers: fetchedMentions ?? base.mentionedUsers,
    mentionedRoles: fetched.mention_roles ?? base.mentionedRoles,
    mentionedEveryone: fetched.mention_everyone ?? base.mentionedEveryone,
    referencedMessage,
    rawData,
  }) as unknown as Message;
}

function shouldHydrateDiscordMessage(params: { message: Message }) {
  const currentText = resolveDiscordMessageText(params.message, {
    includeForwarded: true,
  });
  if (!currentText) {
    return true;
  }
  const hasMentionMetadata =
    (params.message.mentionedUsers?.length ?? 0) > 0 ||
    (params.message.mentionedRoles?.length ?? 0) > 0 ||
    params.message.mentionedEveryone;
  if (hasMentionMetadata) {
    return false;
  }
  return /<@!?\d+>|<@&\d+>|@everyone|@here/u.test(currentText);
}

async function hydrateDiscordMessageIfNeeded(params: {
  client: DiscordMessagePreflightParams["client"];
  message: Message;
  messageChannelId: string;
}): Promise<Message> {
  if (!shouldHydrateDiscordMessage({ message: params.message })) {
    return params.message;
  }
  const rest = params.client.rest as { get?: (route: string) => Promise<unknown> } | undefined;
  if (typeof rest?.get !== "function") {
    return params.message;
  }
  try {
    const fetched = (await rest.get(
      Routes.channelMessage(params.messageChannelId, params.message.id),
    )) as APIMessage | null | undefined;
    if (!fetched) {
      return params.message;
    }
    logVerbose(`discord: hydrated inbound payload via REST for ${params.message.id}`);
    return mergeFetchedDiscordMessage(params.message, fetched);
  } catch (err) {
    logVerbose(`discord: failed to hydrate message ${params.message.id}: ${String(err)}`);
    return params.message;
  }
}

export async function preflightDiscordMessage(
  params: DiscordMessagePreflightParams,
): Promise<DiscordMessagePreflightContext | null> {
  if (isPreflightAborted(params.abortSignal)) {
    return null;
  }
  const logger = getChildLogger({ module: "discord-auto-reply" });
  let message = params.data.message;
  const author = params.data.author;
  if (!author) {
    return null;
  }
  const messageChannelId = resolveDiscordMessageChannelId({
    message,
    eventChannelId: params.data.channel_id,
  });
  if (!messageChannelId) {
    logVerbose(`discord: drop message ${message.id} (missing channel id)`);
    return null;
  }

  const allowBotsSetting = params.discordConfig?.allowBots;
  const allowBotsMode =
    allowBotsSetting === "mentions" ? "mentions" : allowBotsSetting === true ? "all" : "off";
  if (params.botUserId && author.id === params.botUserId) {
    // Always ignore own messages to prevent self-reply loops
    return null;
  }

  message = await hydrateDiscordMessageIfNeeded({
    client: params.client,
    message,
    messageChannelId,
  });
  if (isPreflightAborted(params.abortSignal)) {
    return null;
  }

  const pluralkitConfig = params.discordConfig?.pluralkit;
  const webhookId = resolveDiscordWebhookId(message);
  const shouldCheckPluralKit = Boolean(pluralkitConfig?.enabled) && !webhookId;
  let pluralkitInfo: Awaited<
    ReturnType<typeof import("../pluralkit.js").fetchPluralKitMessageInfo>
  > = null;
  if (shouldCheckPluralKit) {
    try {
      const { fetchPluralKitMessageInfo } = await loadPluralKitRuntime();
      pluralkitInfo = await fetchPluralKitMessageInfo({
        messageId: message.id,
        config: pluralkitConfig,
      });
      if (isPreflightAborted(params.abortSignal)) {
        return null;
      }
    } catch (err) {
      logVerbose(`discord: pluralkit lookup failed for ${message.id}: ${String(err)}`);
    }
  }
  const sender = resolveDiscordSenderIdentity({
    author,
    member: params.data.member,
    pluralkitInfo,
  });

  if (author.bot) {
    if (allowBotsMode === "off" && !sender.isPluralKit) {
      logVerbose("discord: drop bot message (allowBots=false)");
      return null;
    }
  }

  const isGuildMessage = Boolean(params.data.guild_id);
  const channelInfo = await resolveDiscordChannelInfo(params.client, messageChannelId);
  if (isPreflightAborted(params.abortSignal)) {
    return null;
  }
  const isDirectMessage = channelInfo?.type === ChannelType.DM;
  const isGroupDm = channelInfo?.type === ChannelType.GroupDM;
  const messageText = resolveDiscordMessageText(message, {
    includeForwarded: true,
  });
  const injectedBoundThreadBinding =
    !isDirectMessage && !isGroupDm
      ? resolveInjectedBoundThreadLookupRecord({
          threadBindings: params.threadBindings,
          threadId: messageChannelId,
        })
      : undefined;
  if (
    shouldIgnoreBoundThreadWebhookMessage({
      accountId: params.accountId,
      threadId: messageChannelId,
      webhookId,
      threadBinding: injectedBoundThreadBinding,
    })
  ) {
    logVerbose(`discord: drop bound-thread webhook echo message ${message.id}`);
    return null;
  }
  if (
    isBoundThreadBotSystemMessage({
      isBoundThreadSession:
        Boolean(injectedBoundThreadBinding) &&
        isDiscordThreadChannelMessage({
          isGuildMessage,
          message,
          channelInfo,
        }),
      isBotAuthor: Boolean(author.bot),
      text: messageText,
    })
  ) {
    logVerbose(`discord: drop bound-thread bot system message ${message.id}`);
    return null;
  }
  const data = message === params.data.message ? params.data : { ...params.data, message };
  logDebug(
    `[discord-preflight] channelId=${messageChannelId} guild_id=${params.data.guild_id} channelType=${channelInfo?.type} isGuild=${isGuildMessage} isDM=${isDirectMessage} isGroupDm=${isGroupDm}`,
  );

  if (isGroupDm && !params.groupDmEnabled) {
    logVerbose("discord: drop group dm (group dms disabled)");
    return null;
  }
  if (isDirectMessage && !params.dmEnabled) {
    logVerbose("discord: drop dm (dms disabled)");
    return null;
  }

  const dmPolicy = params.discordConfig?.dmPolicy ?? params.discordConfig?.dm?.policy ?? "pairing";
  const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
  const resolvedAccountId = params.accountId ?? resolveDefaultDiscordAccountId(params.cfg);
  const allowNameMatching = isDangerousNameMatchingEnabled(params.discordConfig);
  let commandAuthorized = true;
  if (isDirectMessage) {
    if (dmPolicy === "disabled") {
      logVerbose("discord: drop dm (dmPolicy: disabled)");
      return null;
    }
    const dmAccess = await resolveDiscordDmCommandAccess({
      accountId: resolvedAccountId,
      dmPolicy,
      configuredAllowFrom: params.allowFrom ?? [],
      sender: {
        id: sender.id,
        name: sender.name,
        tag: sender.tag,
      },
      allowNameMatching,
      useAccessGroups,
    });
    if (isPreflightAborted(params.abortSignal)) {
      return null;
    }
    commandAuthorized = dmAccess.commandAuthorized;
    if (dmAccess.decision !== "allow") {
      const allowMatchMeta = formatAllowlistMatchMeta(
        dmAccess.allowMatch.allowed ? dmAccess.allowMatch : undefined,
      );
      await handleDiscordDmCommandDecision({
        dmAccess,
        accountId: resolvedAccountId,
        sender: {
          id: author.id,
          tag: formatDiscordUserTag(author),
          name: author.username ?? undefined,
        },
        onPairingCreated: async (code) => {
          logVerbose(
            `discord pairing request sender=${author.id} tag=${formatDiscordUserTag(author)} (${allowMatchMeta})`,
          );
          try {
            const conversationRuntime = await loadConversationRuntime();
            const { sendMessageDiscord } = await loadDiscordSendRuntime();
            await sendMessageDiscord(
              `user:${author.id}`,
              conversationRuntime.buildPairingReply({
                channel: "discord",
                idLine: `Your Discord user id: ${author.id}`,
                code,
              }),
              {
                cfg: params.cfg,
                token: params.token,
                rest: params.client.rest,
                accountId: params.accountId,
              },
            );
          } catch (err) {
            logVerbose(`discord pairing reply failed for ${author.id}: ${String(err)}`);
          }
        },
        onUnauthorized: async () => {
          logVerbose(
            `Blocked unauthorized discord sender ${sender.id} (dmPolicy=${dmPolicy}, ${allowMatchMeta})`,
          );
        },
      });
      return null;
    }
  }

  const botId = params.botUserId;
  const baseText = resolveDiscordMessageText(message, {
    includeForwarded: false,
  });

  // Intercept text-only slash commands (e.g. user typing "/reset" instead of using Discord's slash command picker)
  // These should not be forwarded to the agent; proper slash command interactions are handled elsewhere
  if (!isDirectMessage && baseText && hasControlCommand(baseText, params.cfg)) {
    logVerbose(`discord: drop text-based slash command ${message.id} (intercepted at gateway)`);
    return null;
  }

  recordChannelActivity({
    channel: "discord",
    accountId: params.accountId,
    direction: "inbound",
  });

  // Resolve thread parent early for binding inheritance
  const channelName =
    channelInfo?.name ??
    (isGuildMessage || isGroupDm ? resolveDiscordChannelNameSafe(message.channel) : undefined);
  const { resolveDiscordThreadChannel, resolveDiscordThreadParentInfo } =
    await loadDiscordThreadingRuntime();
  const earlyThreadChannel = resolveDiscordThreadChannel({
    isGuildMessage,
    message,
    channelInfo,
    messageChannelId,
  });
  let earlyThreadParentId: string | undefined;
  let earlyThreadParentName: string | undefined;
  let earlyThreadParentType: ChannelType | undefined;
  if (earlyThreadChannel) {
    const parentInfo = await resolveDiscordThreadParentInfo({
      client: params.client,
      threadChannel: earlyThreadChannel,
      channelInfo,
    });
    if (isPreflightAborted(params.abortSignal)) {
      return null;
    }
    earlyThreadParentId = parentInfo.id;
    earlyThreadParentName = parentInfo.name;
    earlyThreadParentType = parentInfo.type;
  }

  // Routing inputs are payload-derived, but config must come from the boundary
  // snapshot already threaded into the monitor path.
  const memberRoleIds = Array.isArray(params.data.rawMember?.roles)
    ? params.data.rawMember.roles
    : [];
  const conversationRuntime = await loadConversationRuntime();
  const route = resolveDiscordConversationRoute({
    cfg: params.cfg,
    accountId: params.accountId,
    guildId: params.data.guild_id ?? undefined,
    memberRoleIds,
    peer: buildDiscordRoutePeer({
      isDirectMessage,
      isGroupDm,
      directUserId: author.id,
      conversationId: messageChannelId,
    }),
    parentConversationId: earlyThreadParentId,
  });
  const bindingConversationId = isDirectMessage
    ? (resolveDiscordConversationIdentity({
        isDirectMessage,
        userId: author.id,
      }) ?? `user:${author.id}`)
    : messageChannelId;
  let threadBinding: SessionBindingRecord | undefined;
  const runtimeRoute = conversationRuntime.resolveRuntimeConversationBindingRoute({
    route,
    conversation: {
      channel: "discord",
      accountId: params.accountId,
      conversationId: bindingConversationId,
      parentConversationId: earlyThreadParentId,
    },
  });
  threadBinding = runtimeRoute.bindingRecord ?? undefined;
  const configuredRoute =
    threadBinding == null
      ? conversationRuntime.resolveConfiguredBindingRoute({
          cfg: params.cfg,
          route,
          conversation: {
            channel: "discord",
            accountId: params.accountId,
            conversationId: messageChannelId,
            parentConversationId: earlyThreadParentId,
          },
        })
      : null;
  const configuredBinding = configuredRoute?.bindingResolution ?? null;
  if (!threadBinding && configuredBinding) {
    threadBinding = configuredBinding.record;
  }
  if (
    shouldIgnoreBoundThreadWebhookMessage({
      accountId: params.accountId,
      threadId: messageChannelId,
      webhookId,
      threadBinding,
    })
  ) {
    logVerbose(`discord: drop bound-thread webhook echo message ${message.id}`);
    return null;
  }
  const boundSessionKey = conversationRuntime.isPluginOwnedSessionBindingRecord(threadBinding)
    ? ""
    : (runtimeRoute.boundSessionKey ?? threadBinding?.targetSessionKey?.trim());
  const effectiveRoute = runtimeRoute.boundSessionKey
    ? runtimeRoute.route
    : resolveDiscordEffectiveRoute({
        route,
        boundSessionKey,
        configuredRoute,
        matchedBy: "binding.channel",
      });
  const boundAgentId = boundSessionKey ? effectiveRoute.agentId : undefined;
  const isBoundThreadSession = Boolean(threadBinding && earlyThreadChannel);
  const bypassMentionRequirement = isBoundThreadSession;
  if (
    isBoundThreadBotSystemMessage({
      isBoundThreadSession,
      isBotAuthor: Boolean(author.bot),
      text: messageText,
    })
  ) {
    logVerbose(`discord: drop bound-thread bot system message ${message.id}`);
    return null;
  }
  const mentionRegexes = buildMentionRegexes(params.cfg, effectiveRoute.agentId);
  const explicitlyMentioned = Boolean(
    botId && message.mentionedUsers?.some((user: User) => user.id === botId),
  );
  const hasAnyMention = Boolean(
    !isDirectMessage &&
    ((message.mentionedUsers?.length ?? 0) > 0 ||
      (message.mentionedRoles?.length ?? 0) > 0 ||
      (message.mentionedEveryone && (!author.bot || sender.isPluralKit))),
  );
  const hasUserOrRoleMention =
    !isDirectMessage &&
    ((message.mentionedUsers?.length ?? 0) > 0 || (message.mentionedRoles?.length ?? 0) > 0);

  if (
    isGuildMessage &&
    (message.type === MessageType.ChatInputCommand ||
      message.type === MessageType.ContextMenuCommand)
  ) {
    logVerbose("discord: drop channel command message");
    return null;
  }

  const guildInfo = isGuildMessage
    ? resolveDiscordGuildEntry({
        guild: params.data.guild ?? undefined,
        guildId: params.data.guild_id ?? undefined,
        guildEntries: params.guildEntries,
      })
    : null;
  logDebug(
    `[discord-preflight] guild_id=${params.data.guild_id} guild_obj=${!!params.data.guild} guild_obj_id=${params.data.guild?.id} guildInfo=${!!guildInfo} guildEntries=${params.guildEntries ? Object.keys(params.guildEntries).join(",") : "none"}`,
  );
  if (
    isGuildMessage &&
    params.guildEntries &&
    Object.keys(params.guildEntries).length > 0 &&
    !guildInfo
  ) {
    logDebug(
      `[discord-preflight] guild blocked: guild_id=${params.data.guild_id} guildEntries keys=${Object.keys(params.guildEntries).join(",")}`,
    );
    logVerbose(
      `Blocked discord guild ${params.data.guild_id ?? "unknown"} (not in discord.guilds)`,
    );
    return null;
  }

  // Reuse early thread resolution from above (for binding inheritance)
  const threadChannel = earlyThreadChannel;
  const threadParentId = earlyThreadParentId;
  const threadParentName = earlyThreadParentName;
  const threadParentType = earlyThreadParentType;
  const threadName = threadChannel?.name;
  const configChannelName = threadParentName ?? channelName;
  const configChannelSlug = configChannelName ? normalizeDiscordSlug(configChannelName) : "";
  const displayChannelName = threadName ?? channelName;
  const displayChannelSlug = displayChannelName ? normalizeDiscordSlug(displayChannelName) : "";
  const guildSlug =
    guildInfo?.slug ||
    (params.data.guild?.name ? normalizeDiscordSlug(params.data.guild.name) : "");

  const threadChannelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
  const threadParentSlug = threadParentName ? normalizeDiscordSlug(threadParentName) : "";

  const baseSessionKey = effectiveRoute.sessionKey;
  const channelConfig = isGuildMessage
    ? resolveDiscordChannelConfigWithFallback({
        guildInfo,
        channelId: messageChannelId,
        channelName,
        channelSlug: threadChannelSlug,
        parentId: threadParentId ?? undefined,
        parentName: threadParentName ?? undefined,
        parentSlug: threadParentSlug,
        scope: threadChannel ? "thread" : "channel",
      })
    : null;
  const channelMatchMeta = formatAllowlistMatchMeta(channelConfig);
  if (shouldLogVerbose()) {
    const channelConfigSummary = channelConfig
      ? `allowed=${channelConfig.allowed} enabled=${channelConfig.enabled ?? "unset"} requireMention=${channelConfig.requireMention ?? "unset"} ignoreOtherMentions=${channelConfig.ignoreOtherMentions ?? "unset"} matchKey=${channelConfig.matchKey ?? "none"} matchSource=${channelConfig.matchSource ?? "none"} users=${channelConfig.users?.length ?? 0} roles=${channelConfig.roles?.length ?? 0} skills=${channelConfig.skills?.length ?? 0}`
      : "none";
    logDebug(
      `[discord-preflight] channelConfig=${channelConfigSummary} channelMatchMeta=${channelMatchMeta} channelId=${messageChannelId}`,
    );
  }
  if (isGuildMessage && channelConfig?.enabled === false) {
    logDebug(`[discord-preflight] drop: channel disabled`);
    logVerbose(
      `Blocked discord channel ${messageChannelId} (channel disabled, ${channelMatchMeta})`,
    );
    return null;
  }

  const groupDmAllowed =
    isGroupDm &&
    resolveGroupDmAllow({
      channels: params.groupDmChannels,
      channelId: messageChannelId,
      channelName: displayChannelName,
      channelSlug: displayChannelSlug,
    });
  if (isGroupDm && !groupDmAllowed) {
    return null;
  }

  const channelAllowlistConfigured =
    Boolean(guildInfo?.channels) && Object.keys(guildInfo?.channels ?? {}).length > 0;
  const channelAllowed = channelConfig?.allowed !== false;
  if (
    isGuildMessage &&
    !isDiscordGroupAllowedByPolicy({
      groupPolicy: params.groupPolicy,
      guildAllowlisted: Boolean(guildInfo),
      channelAllowlistConfigured,
      channelAllowed,
    })
  ) {
    if (params.groupPolicy === "disabled") {
      logDebug(`[discord-preflight] drop: groupPolicy disabled`);
      logVerbose(`discord: drop guild message (groupPolicy: disabled, ${channelMatchMeta})`);
    } else if (!channelAllowlistConfigured) {
      logDebug(`[discord-preflight] drop: groupPolicy allowlist, no channel allowlist configured`);
      logVerbose(
        `discord: drop guild message (groupPolicy: allowlist, no channel allowlist, ${channelMatchMeta})`,
      );
    } else {
      logDebug(
        `[discord] Ignored message from channel ${messageChannelId} (not in guild allowlist). Add to guilds.<guildId>.channels to enable.`,
      );
      logVerbose(
        `Blocked discord channel ${messageChannelId} not in guild channel allowlist (groupPolicy: allowlist, ${channelMatchMeta})`,
      );
    }
    return null;
  }

  if (isGuildMessage && channelConfig?.allowed === false) {
    logDebug(`[discord-preflight] drop: channelConfig.allowed===false`);
    logVerbose(
      `Blocked discord channel ${messageChannelId} not in guild channel allowlist (${channelMatchMeta})`,
    );
    return null;
  }
  if (isGuildMessage) {
    logDebug(`[discord-preflight] pass: channel allowed`);
    logVerbose(`discord: allow channel ${messageChannelId} (${channelMatchMeta})`);
  }

  const textForHistory = resolveDiscordMessageText(message, {
    includeForwarded: true,
  });
  const historyEntry =
    isGuildMessage && params.historyLimit > 0 && textForHistory
      ? ({
          sender: sender.label,
          body: textForHistory,
          timestamp: resolveTimestampMs(message.timestamp),
          messageId: message.id,
        } satisfies HistoryEntry)
      : undefined;

  const threadOwnerId = threadChannel
    ? (resolveDiscordChannelInfoSafe(threadChannel).ownerId ?? channelInfo?.ownerId)
    : undefined;
  const shouldRequireMentionByConfig = resolveDiscordShouldRequireMention({
    isGuildMessage,
    isThread: Boolean(threadChannel),
    botId,
    threadOwnerId,
    channelConfig,
    guildInfo,
  });
  const shouldRequireMention = resolvePreflightMentionRequirement({
    shouldRequireMention: shouldRequireMentionByConfig,
    bypassMentionRequirement,
  });
  const { hasAccessRestrictions, memberAllowed } = resolveDiscordMemberAccessState({
    channelConfig,
    guildInfo,
    memberRoleIds,
    sender,
    allowNameMatching,
  });

  if (isGuildMessage && hasAccessRestrictions && !memberAllowed) {
    logDebug(`[discord-preflight] drop: member not allowed`);
    // Keep stable Discord user IDs out of routine deny-path logs.
    logVerbose("Blocked discord guild sender (not in users/roles allowlist)");
    return null;
  }

  // Only authorized guild senders should reach the expensive transcription path.
  const { resolveDiscordPreflightAudioMentionContext } = await loadPreflightAudioRuntime();
  const { hasTypedText, transcript: preflightTranscript } =
    await resolveDiscordPreflightAudioMentionContext({
      message,
      isDirectMessage,
      shouldRequireMention,
      mentionRegexes,
      cfg: params.cfg,
      abortSignal: params.abortSignal,
    });
  if (isPreflightAborted(params.abortSignal)) {
    return null;
  }

  const mentionText = hasTypedText ? baseText : "";
  const { implicitMentionKinds, wasMentioned } = resolveDiscordMentionState({
    authorIsBot: Boolean(author.bot),
    botId,
    hasAnyMention,
    isDirectMessage,
    isExplicitlyMentioned: explicitlyMentioned,
    mentionRegexes,
    mentionText,
    mentionedEveryone: Boolean(message.mentionedEveryone),
    referencedAuthorId: message.referencedMessage?.author?.id,
    senderIsPluralKit: sender.isPluralKit,
    transcript: preflightTranscript,
  });
  if (shouldLogVerbose()) {
    logVerbose(
      `discord: inbound id=${message.id} guild=${params.data.guild_id ?? "dm"} channel=${messageChannelId} mention=${wasMentioned ? "yes" : "no"} type=${isDirectMessage ? "dm" : isGroupDm ? "group-dm" : "guild"} content=${messageText ? "yes" : "no"}`,
    );
  }

  const allowTextCommands = shouldHandleTextCommands({
    cfg: params.cfg,
    surface: "discord",
  });
  const hasControlCommandInMessage = hasControlCommand(baseText, params.cfg);

  if (!isDirectMessage) {
    const { ownerAllowList, ownerAllowed: ownerOk } = resolveDiscordOwnerAccess({
      allowFrom: params.allowFrom,
      sender: {
        id: sender.id,
        name: sender.name,
        tag: sender.tag,
      },
      allowNameMatching,
    });
    const commandGate = resolveControlCommandGate({
      useAccessGroups,
      authorizers: [
        { configured: ownerAllowList != null, allowed: ownerOk },
        { configured: hasAccessRestrictions, allowed: memberAllowed },
      ],
      modeWhenAccessGroupsOff: "configured",
      allowTextCommands,
      hasControlCommand: hasControlCommandInMessage,
    });
    commandAuthorized = commandGate.commandAuthorized;

    if (commandGate.shouldBlock) {
      logInboundDrop({
        log: logVerbose,
        channel: "discord",
        reason: "control command (unauthorized)",
        target: sender.id,
      });
      return null;
    }
  }

  const canDetectMention = Boolean(botId) || mentionRegexes.length > 0;
  const mentionDecision = resolveInboundMentionDecision({
    facts: {
      canDetectMention,
      wasMentioned,
      hasAnyMention,
      implicitMentionKinds,
    },
    policy: {
      isGroup: isGuildMessage,
      requireMention: shouldRequireMention,
      allowTextCommands,
      hasControlCommand: hasControlCommandInMessage,
      commandAuthorized,
    },
  });
  const effectiveWasMentioned = mentionDecision.effectiveWasMentioned;
  logDebug(
    `[discord-preflight] shouldRequireMention=${shouldRequireMention} baseRequireMention=${shouldRequireMentionByConfig} boundThreadSession=${isBoundThreadSession} mentionDecision.shouldSkip=${mentionDecision.shouldSkip} wasMentioned=${wasMentioned}`,
  );
  if (isGuildMessage && shouldRequireMention) {
    if (botId && mentionDecision.shouldSkip) {
      logDebug(`[discord-preflight] drop: no-mention`);
      logVerbose(`discord: drop guild message (mention required, botId=${botId})`);
      logger.info(
        {
          channelId: messageChannelId,
          reason: "no-mention",
        },
        "discord: skipping guild message",
      );
      recordPendingHistoryEntryIfEnabled({
        historyMap: params.guildHistories,
        historyKey: messageChannelId,
        limit: params.historyLimit,
        entry: historyEntry ?? null,
      });
      return null;
    }
  }

  if (author.bot && !sender.isPluralKit && allowBotsMode === "mentions") {
    const botMentioned = isDirectMessage || wasMentioned || mentionDecision.implicitMention;
    if (!botMentioned) {
      logDebug(`[discord-preflight] drop: bot message missing mention (allowBots=mentions)`);
      logVerbose("discord: drop bot message (allowBots=mentions, missing mention)");
      return null;
    }
  }

  const ignoreOtherMentions =
    channelConfig?.ignoreOtherMentions ?? guildInfo?.ignoreOtherMentions ?? false;
  if (
    isGuildMessage &&
    ignoreOtherMentions &&
    hasUserOrRoleMention &&
    !wasMentioned &&
    !mentionDecision.implicitMention
  ) {
    logDebug(`[discord-preflight] drop: other-mention`);
    logVerbose(
      `discord: drop guild message (another user/role mentioned, ignoreOtherMentions=true, botId=${botId})`,
    );
    recordPendingHistoryEntryIfEnabled({
      historyMap: params.guildHistories,
      historyKey: messageChannelId,
      limit: params.historyLimit,
      entry: historyEntry ?? null,
    });
    return null;
  }

  const systemLocation = resolveDiscordSystemLocation({
    isDirectMessage,
    isGroupDm,
    guild: params.data.guild ?? undefined,
    channelName: channelName ?? messageChannelId,
  });
  const { resolveDiscordSystemEvent } = await loadSystemEventsRuntime();
  const systemText = resolveDiscordSystemEvent(message, systemLocation);
  if (systemText) {
    logDebug(`[discord-preflight] drop: system event`);
    enqueueSystemEvent(systemText, {
      sessionKey: effectiveRoute.sessionKey,
      contextKey: `discord:system:${messageChannelId}:${message.id}`,
    });
    return null;
  }

  if (!messageText) {
    logDebug(`[discord-preflight] drop: empty content`);
    logVerbose(`discord: drop message ${message.id} (empty content)`);
    return null;
  }
  if (configuredBinding) {
    const ensured = await conversationRuntime.ensureConfiguredBindingRouteReady({
      cfg: params.cfg,
      bindingResolution: configuredBinding,
    });
    if (!ensured.ok) {
      logVerbose(
        `discord: configured ACP binding unavailable for channel ${configuredBinding.record.conversation.conversationId}: ${ensured.error}`,
      );
      return null;
    }
  }

  logDebug(
    `[discord-preflight] success: route=${effectiveRoute.agentId} sessionKey=${effectiveRoute.sessionKey}`,
  );
  return {
    cfg: params.cfg,
    discordConfig: params.discordConfig,
    accountId: params.accountId,
    token: params.token,
    runtime: params.runtime,
    botUserId: params.botUserId,
    abortSignal: params.abortSignal,
    guildHistories: params.guildHistories,
    historyLimit: params.historyLimit,
    mediaMaxBytes: params.mediaMaxBytes,
    textLimit: params.textLimit,
    replyToMode: params.replyToMode,
    ackReactionScope: params.ackReactionScope,
    groupPolicy: params.groupPolicy,
    data,
    client: params.client,
    message,
    messageChannelId,
    author,
    sender,
    memberRoleIds,
    channelInfo,
    channelName,
    isGuildMessage,
    isDirectMessage,
    isGroupDm,
    commandAuthorized,
    baseText,
    messageText,
    ...(preflightTranscript !== undefined ? { preflightAudioTranscript: preflightTranscript } : {}),
    wasMentioned,
    route: effectiveRoute,
    threadBinding,
    boundSessionKey: boundSessionKey || undefined,
    boundAgentId,
    guildInfo,
    guildSlug,
    threadChannel,
    threadParentId,
    threadParentName,
    threadParentType,
    threadName,
    configChannelName,
    configChannelSlug,
    displayChannelName,
    displayChannelSlug,
    baseSessionKey,
    channelConfig,
    channelAllowlistConfigured,
    channelAllowed,
    shouldRequireMention,
    hasAnyMention,
    allowTextCommands,
    shouldBypassMention: mentionDecision.shouldBypassMention,
    effectiveWasMentioned,
    canDetectMention,
    historyEntry,
    threadBindings: params.threadBindings,
    discordRestFetch: params.discordRestFetch,
  };
}
