// Telegram plugin module implements bot message context behavior.
import type { ReactionTypeEmoji } from "grammy/types";
import {
  resolveAckReaction,
  shouldAckReaction as shouldAckReactionGate,
} from "openclaw/plugin-sdk/channel-feedback";
import { logInboundDrop } from "openclaw/plugin-sdk/channel-inbound";
import type {
  TelegramDirectConfig,
  TelegramGroupConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { deriveLastRoutePolicy } from "openclaw/plugin-sdk/routing";
import { normalizeAccountId, resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  expandTelegramAllowFromWithAccessGroups,
  resolveTelegramDmAllow,
} from "./access-groups.js";
import { resolveDefaultTelegramAccountId } from "./accounts.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import {
  firstDefined,
  normalizeAllowFrom,
  resolveTelegramEffectiveDmPolicy,
} from "./bot-access.js";
import { resolveTelegramInboundBody } from "./bot-message-context.body.js";
import {
  buildTelegramInboundContextPayload,
  resolveTelegramMessageContextStorePath,
} from "./bot-message-context.session.js";
import type { BuildTelegramMessageContextParams } from "./bot-message-context.types.js";
import {
  buildTelegramInboundOriginTarget,
  buildTypingThreadParams,
  extractTelegramForumFlag,
  resolveTelegramForumFlag,
  resolveTelegramBotHasTopicsEnabled,
  resolveTelegramThreadSpec,
  shouldUseTelegramDmThreadSession,
} from "./bot/helpers.js";
import type { TelegramGetChat } from "./bot/types.js";
import {
  resolveTelegramConversationBaseSessionKey,
  resolveTelegramConversationRoute,
} from "./conversation-route.js";
import { enforceTelegramDmAccess } from "./dm-access.js";
import { evaluateTelegramGroupBaseAccess } from "./group-access.js";
import {
  buildTelegramStatusReactionVariants,
  type TelegramReactionEmoji,
  isTelegramSupportedReactionEmoji,
  resolveTelegramAllowedEmojiReactions,
  resolveTelegramReactionVariant,
  resolveTelegramStatusReactionEmojis,
} from "./status-reaction-variants.js";
import { getTopicName, resolveTopicNameCacheScope, updateTopicName } from "./topic-name-cache.js";

export type {
  BuildTelegramMessageContextParams,
  TelegramMediaRef,
} from "./bot-message-context.types.js";

const loadTelegramMessageContextRuntime = createLazyRuntimeModule(
  () => import("./bot-message-context.runtime.js"),
);

type TelegramMessageContextPayload = Awaited<ReturnType<typeof buildTelegramInboundContextPayload>>;
type TelegramReactionApi = (
  chatId: BuildTelegramMessageContextParams["primaryCtx"]["message"]["chat"]["id"],
  messageId: number,
  reactions: Array<{ type: "emoji"; emoji: ReactionTypeEmoji["emoji"] }>,
) => Promise<unknown>;
type TelegramStatusReactionController = {
  setQueued: () => void | Promise<void>;
  setThinking: () => void | Promise<void>;
  setTool: (name: string) => void | Promise<void>;
  setCompacting: () => void | Promise<void>;
  cancelPending: () => void;
  setError: () => void | Promise<void>;
  setDone: () => void | Promise<void>;
  restoreInitial: () => void | Promise<void>;
};

export type TelegramMessageContext = {
  cfg: BuildTelegramMessageContextParams["cfg"];
  ctxPayload: TelegramMessageContextPayload["ctxPayload"];
  turn: TelegramMessageContextPayload["turn"];
  primaryCtx: BuildTelegramMessageContextParams["primaryCtx"];
  msg: BuildTelegramMessageContextParams["primaryCtx"]["message"];
  chatId: BuildTelegramMessageContextParams["primaryCtx"]["message"]["chat"]["id"];
  isGroup: boolean;
  groupConfig?: ReturnType<
    BuildTelegramMessageContextParams["resolveTelegramGroupConfig"]
  >["groupConfig"];
  topicConfig?: ReturnType<
    BuildTelegramMessageContextParams["resolveTelegramGroupConfig"]
  >["topicConfig"];
  resolvedThreadId?: number;
  threadSpec: ReturnType<typeof resolveTelegramThreadSpec>;
  replyThreadId?: number;
  isForum: boolean;
  historyKey?: string;
  historyLimit: BuildTelegramMessageContextParams["historyLimit"];
  groupHistories: BuildTelegramMessageContextParams["groupHistories"];
  route: ReturnType<typeof resolveTelegramConversationRoute>["route"];
  skillFilter: TelegramMessageContextPayload["skillFilter"];
  sendTyping: () => Promise<void>;
  sendRecordVoice: () => Promise<void>;
  sendChatActionHandler: BuildTelegramMessageContextParams["sendChatActionHandler"];
  initialTypingCueSent?: boolean;
  ackReactionPromise: Promise<boolean> | null;
  reactionApi: TelegramReactionApi | null;
  removeAckAfterReply: boolean;
  statusReactionController: TelegramStatusReactionController | null;
  accountId: string;
};

export const buildTelegramMessageContext = async ({
  primaryCtx,
  allMedia,
  replyMedia = [],
  replyChain = [],
  promptContext = [],
  storeAllowFrom,
  options,
  bot,
  cfg,
  account,
  historyLimit,
  groupHistories,
  dmPolicy,
  allowFrom,
  groupAllowFrom,
  ackReactionScope,
  logger,
  resolveGroupActivation,
  resolveGroupRequireMention,
  resolveTelegramGroupConfig,
  runtime,
  sessionRuntime,
  upsertPairingRequest,
  sendChatActionHandler,
}: BuildTelegramMessageContextParams): Promise<TelegramMessageContext | null> => {
  const msg = primaryCtx.message;
  const chatId = msg.chat.id;
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  const senderId = msg.from?.id ? String(msg.from.id) : "";
  const messageThreadId = (msg as { message_thread_id?: number }).message_thread_id;
  const reactionApi =
    typeof bot.api.setMessageReaction === "function"
      ? bot.api.setMessageReaction.bind(bot.api)
      : null;
  const getChatApi =
    typeof bot.api.getChat === "function"
      ? (bot.api.getChat.bind(bot.api) as TelegramGetChat)
      : undefined;
  const isForum = await resolveTelegramForumFlag({
    chatId,
    chatType: msg.chat.type,
    isGroup,
    isForum: extractTelegramForumFlag(msg.chat),
    isTopicMessage: msg.is_topic_message,
    getChat: getChatApi,
  });
  const threadSpec = resolveTelegramThreadSpec({
    isGroup,
    isForum,
    messageThreadId,
  });
  const resolvedThreadId = threadSpec.scope === "forum" ? threadSpec.id : undefined;
  const replyThreadId = threadSpec.id;
  const dmThreadId = threadSpec.scope === "dm" ? threadSpec.id : undefined;
  let topicName: string | undefined;
  if (isForum && resolvedThreadId != null) {
    const topicNameCacheScope = resolveTopicNameCacheScope(
      await resolveTelegramMessageContextStorePath({
        cfg,
        agentId: account.accountId,
        sessionRuntime,
      }),
    );
    const ftCreated = msg.forum_topic_created;
    const ftEdited = msg.forum_topic_edited;
    const ftClosed = msg.forum_topic_closed;
    const ftReopened = msg.forum_topic_reopened;
    const topicPatch = ftCreated?.name
      ? {
          name: ftCreated.name,
          iconColor: ftCreated.icon_color,
          iconCustomEmojiId: ftCreated.icon_custom_emoji_id,
          closed: false,
        }
      : ftEdited?.name
        ? {
            name: ftEdited.name,
            iconCustomEmojiId: ftEdited.icon_custom_emoji_id,
          }
        : ftClosed
          ? { closed: true }
          : ftReopened
            ? { closed: false }
            : undefined;

    if (topicPatch) {
      await updateTopicName(chatId, resolvedThreadId, topicPatch, topicNameCacheScope);
    }

    topicName = await getTopicName(chatId, resolvedThreadId, topicNameCacheScope);
    if (!topicName) {
      const replyFtCreated = msg.reply_to_message?.forum_topic_created;
      if (replyFtCreated?.name) {
        await updateTopicName(
          chatId,
          resolvedThreadId,
          {
            name: replyFtCreated.name,
            iconColor: replyFtCreated.icon_color,
            iconCustomEmojiId: replyFtCreated.icon_custom_emoji_id,
          },
          topicNameCacheScope,
        );
        topicName = replyFtCreated.name;
      }
    }
  }

  const threadIdForConfig = resolvedThreadId ?? dmThreadId;
  const { groupConfig, topicConfig } = resolveTelegramGroupConfig(chatId, threadIdForConfig, cfg);
  const directConfig = !isGroup ? (groupConfig as TelegramDirectConfig | undefined) : undefined;
  const telegramGroupConfig = isGroup
    ? (groupConfig as TelegramGroupConfig | undefined)
    : undefined;
  const effectiveDmPolicy = resolveTelegramEffectiveDmPolicy({
    isGroup,
    groupConfig,
    dmPolicy,
  });
  const conversationRoute = resolveTelegramConversationRoute({
    cfg,
    accountId: account.accountId,
    chatId,
    isGroup,
    resolvedThreadId,
    replyThreadId,
    senderId,
    topicAgentId: topicConfig?.agentId,
  });
  const { bindingMode } = conversationRoute;
  let { route } = conversationRoute;
  const requiresExplicitAccountBinding = (
    candidate: ReturnType<typeof resolveTelegramConversationRoute>["route"],
  ): boolean =>
    normalizeAccountId(candidate.accountId) !==
      normalizeAccountId(resolveDefaultTelegramAccountId(cfg)) && candidate.matchedBy === "default";
  const isNamedAccountFallback = requiresExplicitAccountBinding(route);
  const hasExplicitTopicRoute = isGroup && Boolean(topicConfig?.agentId?.trim());
  if (isNamedAccountFallback && isGroup && !hasExplicitTopicRoute) {
    logInboundDrop({
      log: logVerbose,
      channel: "telegram",
      reason: "non-default account requires explicit binding",
      target: route.accountId,
    });
    return null;
  }
  const groupAllowOverride = firstDefined(topicConfig?.allowFrom, groupConfig?.allowFrom);
  const dmAllow = await resolveTelegramDmAllow({
    cfg,
    groupAllowOverride,
    allowFrom,
    accountId: account.accountId,
    senderId,
    storeAllowFrom,
    dmPolicy: effectiveDmPolicy,
  });
  const expandedGroupAllowFrom = await expandTelegramAllowFromWithAccessGroups({
    cfg,
    allowFrom: groupAllowOverride ?? groupAllowFrom,
    accountId: account.accountId,
    senderId,
  });
  const effectiveGroupAllow = normalizeAllowFrom(expandedGroupAllowFrom);
  const hasGroupAllowOverride = groupAllowOverride !== undefined;
  const senderUsername = msg.from?.username ?? "";
  const baseAccess = evaluateTelegramGroupBaseAccess({
    isGroup,
    groupConfig,
    topicConfig,
    hasGroupAllowOverride,
    effectiveGroupAllow,
    senderId,
    senderUsername,
    enforceAllowOverride: true,
    requireSenderForAllowOverride: false,
  });
  if (!baseAccess.allowed) {
    if (baseAccess.reason === "group-disabled") {
      logVerbose(`Blocked telegram group ${chatId} (group disabled)`);
      return null;
    }
    if (baseAccess.reason === "topic-disabled") {
      logVerbose(
        `Blocked telegram topic ${chatId} (${resolvedThreadId ?? "unknown"}) (topic disabled)`,
      );
      return null;
    }
    logVerbose(
      isGroup
        ? `Blocked telegram group sender ${senderId || "unknown"} (group allowFrom override)`
        : `Blocked telegram DM sender ${senderId || "unknown"} (DM allowFrom override)`,
    );
    return null;
  }

  const requireTopic = directConfig?.requireTopic;
  const topicRequiredButMissing = !isGroup && requireTopic === true && dmThreadId == null;
  if (topicRequiredButMissing) {
    logVerbose(`Blocked telegram DM ${chatId}: requireTopic=true but no topic present`);
    return null;
  }

  const sendTyping = async () => {
    await withTelegramApiErrorLogging({
      operation: "sendChatAction",
      fn: () =>
        sendChatActionHandler.sendChatAction(
          chatId,
          "typing",
          buildTypingThreadParams(replyThreadId),
        ),
    });
  };

  const sendRecordVoice = async () => {
    try {
      await withTelegramApiErrorLogging({
        operation: "sendChatAction",
        fn: () =>
          sendChatActionHandler.sendChatAction(
            chatId,
            "record_voice",
            buildTypingThreadParams(replyThreadId),
          ),
      });
    } catch (err) {
      logVerbose(`telegram record_voice cue failed for chat ${chatId}: ${String(err)}`);
    }
  };

  if (
    !(await enforceTelegramDmAccess({
      isGroup,
      dmPolicy: effectiveDmPolicy,
      msg,
      chatId,
      effectiveDmAllow: dmAllow.effectiveAllow,
      accountId: account.accountId,
      bot,
      logger,
      upsertPairingRequest,
    }))
  ) {
    return null;
  }
  let initialTypingCueSent = false;
  const ensureConfiguredBindingReady = async (): Promise<boolean> => {
    if (bindingMode.kind !== "configured") {
      return true;
    }
    const ensureConfiguredBindingRouteReady =
      runtime?.ensureConfiguredBindingRouteReady ??
      (await loadTelegramMessageContextRuntime()).ensureConfiguredBindingRouteReady;
    const ensured = await ensureConfiguredBindingRouteReady({
      cfg,
      bindingResolution: bindingMode.binding,
    });
    if (ensured.ok) {
      logVerbose(
        `telegram: using configured ACP binding for ${bindingMode.binding.record.conversation.conversationId} -> ${bindingMode.sessionKey}`,
      );
      return true;
    }
    logVerbose(
      `telegram: configured ACP binding unavailable for ${bindingMode.binding.record.conversation.conversationId}: ${ensured.error}`,
    );
    logInboundDrop({
      log: logVerbose,
      channel: "telegram",
      reason: "configured ACP binding unavailable",
      target: bindingMode.binding.record.conversation.conversationId,
    });
    return false;
  };

  const baseSessionKey = resolveTelegramConversationBaseSessionKey({
    cfg,
    route,
    chatId,
    isGroup,
    senderId,
  });
  const useDmThreadSession = shouldUseTelegramDmThreadSession({
    dmThreadId,
    botHasTopicsEnabled: resolveTelegramBotHasTopicsEnabled(primaryCtx.me),
  });
  const threadKeys =
    useDmThreadSession && dmThreadId != null
      ? resolveThreadSessionKeys({ baseSessionKey, threadId: `${chatId}:${dmThreadId}` })
      : null;
  const sessionKey = threadKeys?.sessionKey ?? baseSessionKey;
  route = {
    ...route,
    sessionKey,
    lastRoutePolicy: deriveLastRoutePolicy({
      sessionKey,
      mainSessionKey: route.mainSessionKey,
    }),
  };
  const activationOverride = resolveGroupActivation({
    chatId,
    messageThreadId: resolvedThreadId,
    sessionKey,
    agentId: route.agentId,
    cfg,
  });
  const baseRequireMention = resolveGroupRequireMention(chatId, cfg);
  // Persisted session activation intentionally interleaves topic and group config.
  // ScopeTree resolves config only, so this precedence remains session-owned here.
  const groupRequireMention = firstDefined(
    topicConfig?.requireMention,
    activationOverride,
    telegramGroupConfig?.requireMention,
    baseRequireMention,
  );
  const requireMention =
    isGroup && bindingMode.kind === "plugin-owned-runtime" ? false : groupRequireMention;

  const recordChannelActivity =
    runtime?.recordChannelActivity ??
    (await loadTelegramMessageContextRuntime()).recordChannelActivity;
  recordChannelActivity({
    channel: "telegram",
    accountId: account.accountId,
    direction: "inbound",
  });

  const originatingTo = buildTelegramInboundOriginTarget(chatId, threadSpec);
  const bodyResult = await resolveTelegramInboundBody({
    cfg,
    primaryCtx,
    msg,
    allMedia,
    isGroup,
    chatId,
    accountId: account.accountId,
    senderId,
    senderUsername,
    resolvedThreadId,
    replyThreadId,
    originatingTo,
    routeAgentId: route.agentId,
    sessionKey,
    effectiveGroupAllow,
    effectiveDmAllow: dmAllow.effectiveAllow,
    groupConfig,
    topicConfig,
    providerMentionPatterns: cfg.channels?.telegram?.accounts?.[account.accountId]?.mentionPatterns,
    requireMention: Boolean(requireMention),
    options,
    groupHistories,
    historyLimit,
    logger,
  });
  if (!bodyResult) {
    return null;
  }

  if (!(await ensureConfiguredBindingReady())) {
    return null;
  }

  // Send the first typing cue before expensive context/session construction,
  // but only after intake has accepted the message as a non-room-event turn.
  if (bodyResult.inboundEventKind !== "room_event") {
    initialTypingCueSent = true;
    void sendTyping().catch((err: unknown) => {
      logVerbose(`telegram early typing cue failed for chat ${chatId}: ${String(err)}`);
    });
  }

  const { ctxPayload, skillFilter, turn } = await buildTelegramInboundContextPayload({
    cfg,
    primaryCtx,
    msg,
    allMedia,
    replyMedia,
    replyChain,
    promptContext,
    isGroup,
    isForum,
    chatId,
    senderId,
    senderUsername,
    resolvedThreadId,
    dmThreadId,
    threadSpec,
    route,
    rawBody: bodyResult.rawBody,
    bodyText: bodyResult.bodyText,
    historyKey: bodyResult.historyKey ?? "",
    historyLimit,
    groupHistories,
    groupConfig,
    topicConfig,
    effectiveWasMentioned: bodyResult.effectiveWasMentioned,
    inboundEventKind: bodyResult.inboundEventKind,
    groupRequireMention: Boolean(groupRequireMention),
    mentionFacts: bodyResult.mentionFacts,
    hasControlCommand: bodyResult.hasControlCommand,
    stickerCacheHit: bodyResult.stickerCacheHit,
    ...(bodyResult.audioTranscribedMediaIndex !== undefined
      ? { audioTranscribedMediaIndex: bodyResult.audioTranscribedMediaIndex }
      : {}),
    locationData: bodyResult.locationData,
    options,
    dmAllowFrom: dmAllow.allowFrom,
    effectiveGroupAllow,
    commandAuthorized: bodyResult.commandAuthorized,
    topicName,
    sessionRuntime,
  });
  const isRoomEvent = ctxPayload.InboundEventKind === "room_event";
  const canShowStatusReaction = !isRoomEvent;
  const ackReaction = resolveAckReaction(cfg, route.agentId, {
    channel: "telegram",
    accountId: account.accountId,
  });
  const ackReactionEmoji =
    ackReaction && isTelegramSupportedReactionEmoji(ackReaction) ? ackReaction : undefined;
  const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;
  const shouldSendAckReaction = Boolean(
    ackReaction &&
    shouldAckReactionGate({
      scope: ackReactionScope,
      inboundEventKind: ctxPayload.InboundEventKind,
      isDirect: !isGroup,
      isGroup,
      isMentionableGroup: isGroup,
      requireMention: Boolean(requireMention),
      canDetectMention: bodyResult.canDetectMention,
      effectiveWasMentioned: bodyResult.effectiveWasMentioned,
      shouldBypassMention: bodyResult.shouldBypassMention,
    }),
  );
  const statusReactionsConfig = cfg.messages?.statusReactions;
  const statusReactionsEnabled =
    canShowStatusReaction &&
    statusReactionsConfig?.enabled === true &&
    Boolean(reactionApi) &&
    shouldSendAckReaction;
  const resolvedStatusReactionEmojis = statusReactionsEnabled
    ? resolveTelegramStatusReactionEmojis({
        initialEmoji: ackReaction,
        overrides: statusReactionsConfig?.emojis,
      })
    : null;
  const statusReactionVariantsByEmoji = resolvedStatusReactionEmojis
    ? buildTelegramStatusReactionVariants(resolvedStatusReactionEmojis)
    : new Map<string, string[]>();
  let allowedStatusReactionEmojisPromise: Promise<Set<TelegramReactionEmoji> | null> | null = null;
  const createStatusReactionController =
    statusReactionsEnabled && resolvedStatusReactionEmojis && msg.message_id
      ? (runtime?.createStatusReactionController ??
        (await loadTelegramMessageContextRuntime()).createStatusReactionController)
      : null;
  const statusReactionController: TelegramStatusReactionController | null =
    createStatusReactionController
      ? createStatusReactionController({
          enabled: true,
          adapter: {
            setReaction: async (emoji: string) => {
              if (reactionApi) {
                if (!allowedStatusReactionEmojisPromise) {
                  allowedStatusReactionEmojisPromise = resolveTelegramAllowedEmojiReactions({
                    chat: msg.chat,
                    chatId,
                    getChat: getChatApi ?? undefined,
                  }).catch((err: unknown) => {
                    logVerbose(
                      `telegram status-reaction available_reactions lookup failed for chat ${chatId}: ${String(err)}`,
                    );
                    return null;
                  });
                }
                const allowedStatusReactionEmojis = await allowedStatusReactionEmojisPromise;
                const resolvedEmoji = resolveTelegramReactionVariant({
                  requestedEmoji: emoji,
                  variantsByRequestedEmoji: statusReactionVariantsByEmoji,
                  allowedEmojiReactions: allowedStatusReactionEmojis,
                });
                if (!resolvedEmoji) {
                  return;
                }
                await reactionApi(chatId, msg.message_id, [
                  { type: "emoji", emoji: resolvedEmoji },
                ]);
              }
            },
          },
          initialEmoji: ackReaction,
          emojis: resolvedStatusReactionEmojis ?? undefined,
          onError: (err) => {
            logVerbose(`telegram status-reaction error for chat ${chatId}: ${String(err)}`);
          },
        })
      : null;

  const ackReactionPromise: Promise<boolean> | null = statusReactionController
    ? shouldSendAckReaction
      ? Promise.resolve(statusReactionController.setQueued()).then(
          () => true,
          () => false,
        )
      : null
    : shouldSendAckReaction && msg.message_id && reactionApi && ackReactionEmoji
      ? withTelegramApiErrorLogging({
          operation: "setMessageReaction",
          fn: () =>
            reactionApi(chatId, msg.message_id, [{ type: "emoji", emoji: ackReactionEmoji }]),
        }).then(
          () => true,
          (err: unknown) => {
            logVerbose(`telegram react failed for chat ${chatId}: ${String(err)}`);
            return false;
          },
        )
      : null;

  return {
    cfg,
    ctxPayload,
    turn,
    primaryCtx,
    msg,
    chatId,
    isGroup,
    groupConfig,
    topicConfig,
    resolvedThreadId,
    threadSpec,
    replyThreadId,
    isForum,
    historyKey: bodyResult.historyKey ?? "",
    historyLimit,
    groupHistories,
    route,
    skillFilter,
    sendTyping,
    sendRecordVoice,
    sendChatActionHandler,
    initialTypingCueSent,
    ackReactionPromise,
    reactionApi,
    removeAckAfterReply,
    statusReactionController,
    accountId: account.accountId,
  };
};
