import { formatAllowlistMatchMeta } from "openclaw/plugin-sdk/allow-from";
import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import {
  buildMentionRegexes,
  logInboundDrop,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveControlCommandGate } from "openclaw/plugin-sdk/command-auth-native";
import { hasControlCommand } from "openclaw/plugin-sdk/command-detection";
import { shouldHandleTextCommands } from "openclaw/plugin-sdk/command-surface";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import { recordPendingHistoryEntryIfEnabled } from "openclaw/plugin-sdk/reply-history";
import { getChildLogger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { logDebug } from "openclaw/plugin-sdk/text-runtime";
import { resolveDefaultDiscordAccountId } from "../accounts.js";
import { ChannelType, MessageType, type User } from "../internal/discord.js";
import {
  resolveDiscordGuildEntry,
  resolveDiscordMemberAccessState,
  resolveDiscordOwnerAccess,
  resolveDiscordShouldRequireMention,
} from "./allow-list.js";
import { resolveDiscordChannelInfoSafe, resolveDiscordChannelNameSafe } from "./channel-access.js";
import { resolveDiscordSystemLocation } from "./format.js";
import { resolveDiscordDmPreflightAccess } from "./message-handler.dm-preflight.js";
import { hydrateDiscordMessageIfNeeded } from "./message-handler.hydration.js";
import { resolveDiscordPreflightChannelAccess } from "./message-handler.preflight-channel-access.js";
import { resolveDiscordPreflightChannelContext } from "./message-handler.preflight-channel-context.js";
import { buildDiscordMessagePreflightContext } from "./message-handler.preflight-context.js";
import {
  isBoundThreadBotSystemMessage,
  isDiscordThreadChannelMessage,
  resolveDiscordMentionState,
  resolveInjectedBoundThreadLookupRecord,
  resolvePreflightMentionRequirement,
  shouldIgnoreBoundThreadWebhookMessage,
} from "./message-handler.preflight-helpers.js";
import { buildDiscordPreflightHistoryEntry } from "./message-handler.preflight-history.js";
import {
  logDiscordPreflightChannelConfig,
  logDiscordPreflightInboundSummary,
} from "./message-handler.preflight-logging.js";
import { resolveDiscordPreflightPluralKitInfo } from "./message-handler.preflight-pluralkit.js";
import {
  isPreflightAborted,
  loadPreflightAudioRuntime,
  loadSystemEventsRuntime,
} from "./message-handler.preflight-runtime.js";
import { resolveDiscordPreflightThreadContext } from "./message-handler.preflight-thread.js";
import type {
  DiscordMessagePreflightContext,
  DiscordMessagePreflightParams,
} from "./message-handler.preflight.types.js";
import { resolveDiscordPreflightRoute } from "./message-handler.routing-preflight.js";
import {
  resolveDiscordChannelInfo,
  resolveDiscordMessageChannelId,
  resolveDiscordMessageText,
} from "./message-utils.js";
import { resolveDiscordSenderIdentity, resolveDiscordWebhookId } from "./sender-identity.js";

export type {
  DiscordMessagePreflightContext,
  DiscordMessagePreflightParams,
} from "./message-handler.preflight.types.js";

export {
  resolvePreflightMentionRequirement,
  shouldIgnoreBoundThreadWebhookMessage,
} from "./message-handler.preflight-helpers.js";

function resolveDiscordPreflightConversationKind(params: {
  isGuildMessage: boolean;
  channelType?: ChannelType;
}) {
  const isGroupDm = params.channelType === ChannelType.GroupDM;
  const isDirectMessage =
    params.channelType === ChannelType.DM ||
    (!params.isGuildMessage && !isGroupDm && params.channelType == null);
  return { isDirectMessage, isGroupDm };
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
  const isGuildMessage = Boolean(params.data.guild_id);
  const channelInfo = await resolveDiscordChannelInfo(params.client, messageChannelId);
  if (isPreflightAborted(params.abortSignal)) {
    return null;
  }
  const { isDirectMessage, isGroupDm } = resolveDiscordPreflightConversationKind({
    isGuildMessage,
    channelType: channelInfo?.type,
  });
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
  const pluralkitInfo = await resolveDiscordPreflightPluralKitInfo({
    message,
    config: pluralkitConfig,
    abortSignal: params.abortSignal,
  });
  if (isPreflightAborted(params.abortSignal)) {
    return null;
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

  const dmPolicy = params.dmPolicy;
  const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
  const resolvedAccountId = params.accountId ?? resolveDefaultDiscordAccountId(params.cfg);
  const allowNameMatching = isDangerousNameMatchingEnabled(params.discordConfig);
  let commandAuthorized = true;
  if (isDirectMessage) {
    const access = await resolveDiscordDmPreflightAccess({
      preflight: params,
      author,
      sender,
      dmPolicy,
      resolvedAccountId,
      allowNameMatching,
      useAccessGroups,
    });
    if (isPreflightAborted(params.abortSignal)) {
      return null;
    }
    if (!access) {
      return null;
    }
    commandAuthorized = access.commandAuthorized;
  }

  const botId = params.botUserId;
  const baseText = resolveDiscordMessageText(message, {
    includeForwarded: false,
  });

  recordChannelActivity({
    channel: "discord",
    accountId: params.accountId,
    direction: "inbound",
  });

  // Resolve thread parent early for binding inheritance
  const channelName =
    channelInfo?.name ??
    (isGuildMessage || isGroupDm
      ? resolveDiscordChannelNameSafe(
          "channel" in message ? (message as { channel?: unknown }).channel : undefined,
        )
      : undefined);
  const threadContext = await resolveDiscordPreflightThreadContext({
    client: params.client,
    isGuildMessage,
    message,
    channelInfo,
    messageChannelId,
    abortSignal: params.abortSignal,
  });
  if (!threadContext) {
    return null;
  }
  const { earlyThreadChannel, earlyThreadParentId, earlyThreadParentName, earlyThreadParentType } =
    threadContext;

  // Routing inputs are payload-derived, but config must come from the boundary
  // snapshot already threaded into the monitor path.
  const memberRoleIds = Array.isArray(params.data.rawMember?.roles)
    ? params.data.rawMember.roles
    : [];
  const routeState = await resolveDiscordPreflightRoute({
    preflight: params,
    author,
    isDirectMessage,
    isGroupDm,
    messageChannelId,
    memberRoleIds,
    earlyThreadParentId,
  });
  const {
    conversationRuntime,
    threadBinding,
    configuredBinding,
    boundSessionKey,
    effectiveRoute,
    boundAgentId,
    baseSessionKey,
  } = routeState;
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
  const hasAnyMention =
    !isDirectMessage &&
    ((message.mentionedUsers?.length ?? 0) > 0 ||
      (message.mentionedRoles?.length ?? 0) > 0 ||
      (message.mentionedEveryone && (!author.bot || sender.isPluralKit)));
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
  const {
    threadName,
    configChannelName,
    configChannelSlug,
    displayChannelName,
    displayChannelSlug,
    guildSlug,
    channelConfig,
  } = resolveDiscordPreflightChannelContext({
    isGuildMessage,
    messageChannelId,
    channelName,
    guildName: params.data.guild?.name,
    guildInfo,
    threadChannel,
    threadParentId,
    threadParentName,
  });
  const channelMatchMeta = formatAllowlistMatchMeta(channelConfig);
  logDiscordPreflightChannelConfig({
    channelConfig,
    channelMatchMeta,
    channelId: messageChannelId,
  });
  const channelAccess = resolveDiscordPreflightChannelAccess({
    isGuildMessage,
    isGroupDm,
    groupPolicy: params.groupPolicy,
    groupDmChannels: params.groupDmChannels,
    messageChannelId,
    displayChannelName,
    displayChannelSlug,
    guildInfo,
    channelConfig,
    channelMatchMeta,
  });
  if (!channelAccess.allowed) {
    return null;
  }
  const { channelAllowlistConfigured, channelAllowed } = channelAccess;

  const historyEntry = buildDiscordPreflightHistoryEntry({
    isGuildMessage,
    historyLimit: params.historyLimit,
    message,
    senderLabel: sender.label,
  });

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
    mentionedEveryone: message.mentionedEveryone,
    referencedAuthorId: message.referencedMessage?.author?.id,
    senderIsPluralKit: sender.isPluralKit,
    transcript: preflightTranscript,
  });
  logDiscordPreflightInboundSummary({
    messageId: message.id,
    guildId: params.data.guild_id ?? undefined,
    channelId: messageChannelId,
    wasMentioned,
    isDirectMessage,
    isGroupDm,
    hasContent: Boolean(messageText),
  });

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
    if (mentionDecision.shouldSkip) {
      logDebug(`[discord-preflight] drop: no-mention`);
      logVerbose(`discord: drop guild message (mention required, botId=${botId ?? "<missing>"})`);
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
  return buildDiscordMessagePreflightContext({
    preflightParams: params,
    data,
    client: params.client,
    message,
    messageChannelId,
    author,
    sender,
    canonicalMessageId: pluralkitInfo?.original?.trim() || undefined,
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
  });
}
