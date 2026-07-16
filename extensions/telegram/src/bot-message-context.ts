import type { ReactionTypeEmoji } from "@grammyjs/types";
import {
  resolveAckReaction,
  shouldAckReaction as shouldAckReactionGate,
} from "openclaw/plugin-sdk/channel-feedback";
import { logInboundDrop } from "openclaw/plugin-sdk/channel-inbound";
import type { TelegramDirectConfig, TelegramGroupConfig } from "openclaw/plugin-sdk/config-runtime";
import { deriveLastRoutePolicy } from "openclaw/plugin-sdk/routing";
import { DEFAULT_ACCOUNT_ID, resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { firstDefined, normalizeAllowFrom, normalizeDmAllowFromWithStore } from "./bot-access.js";
import { resolveTelegramInboundBody } from "./bot-message-context.body.js";
import {
  buildTelegramInboundContextPayload,
  resolveTelegramMessageContextStorePath,
} from "./bot-message-context.session.js";
import type { BuildTelegramMessageContextParams } from "./bot-message-context.types.js";
import {
  buildTypingThreadParams,
  extractTelegramForumFlag,
  resolveTelegramForumFlag,
  resolveTelegramThreadSpec,
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
import { getTopicName, resolveTopicNameCachePath, updateTopicName } from "./topic-name-cache.js";

export type {
  BuildTelegramMessageContextParams,
  TelegramMediaRef,
} from "./bot-message-context.types.js";

type TelegramMessageContextRuntime = typeof import("./bot-message-context.runtime.js");

let telegramMessageContextRuntimePromise: Promise<TelegramMessageContextRuntime> | undefined;

async function loadTelegramMessageContextRuntime() {
  telegramMessageContextRuntimePromise ??= import("./bot-message-context.runtime.js");
  return await telegramMessageContextRuntimePromise;
}

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
};

export type TelegramMessageContext = {
  ctxPayload: TelegramMessageContextPayload["ctxPayload"];
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
  loadFreshConfig,
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
  const topicNameCachePath = resolveTopicNameCachePath(
    await resolveTelegramMessageContextStorePath({
      cfg,
      agentId: account.accountId,
      sessionRuntime,
    }),
  );
  let topicName: string | undefined;
  if (isForum && resolvedThreadId != null) {
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
      updateTopicName(chatId, resolvedThreadId, topicPatch, topicNameCachePath);
    }

    topicName = getTopicName(chatId, resolvedThreadId, topicNameCachePath);
    if (!topicName) {
      const replyFtCreated = msg.reply_to_message?.forum_topic_created;
      if (replyFtCreated?.name) {
        updateTopicName(
          chatId,
          resolvedThreadId,
          {
            name: replyFtCreated.name,
            iconColor: replyFtCreated.icon_color,
            iconCustomEmojiId: replyFtCreated.icon_custom_emoji_id,
          },
          topicNameCachePath,
        );
        topicName = replyFtCreated.name;
      }
    }
  }

  const threadIdForConfig = resolvedThreadId ?? dmThreadId;
  const { groupConfig, topicConfig } = resolveTelegramGroupConfig(chatId, threadIdForConfig);
  const directConfig = !isGroup ? (groupConfig as TelegramDirectConfig | undefined) : undefined;
  const telegramGroupConfig = isGroup
    ? (groupConfig as TelegramGroupConfig | undefined)
    : undefined;
  // Use direct config dmPolicy override if available for DMs
  const effectiveDmPolicy =
    !isGroup && groupConfig && "dmPolicy" in groupConfig
      ? (groupConfig.dmPolicy ?? dmPolicy)
      : dmPolicy;
  // Fresh config for bindings lookup; other routing inputs are payload-derived.
  const freshCfg =
    loadFreshConfig?.() ??
    (runtime?.loadConfig ?? (await loadTelegramMessageContextRuntime()).loadConfig)();
  let { route, configuredBinding, configuredBindingSessionKey } = resolveTelegramConversationRoute({
    cfg: freshCfg,
    accountId: account.accountId,
    chatId,
    isGroup,
    resolvedThreadId,
    replyThreadId,
    senderId,
    topicAgentId: topicConfig?.agentId,
  });
  const requiresExplicitAccountBinding = (
    candidate: ReturnType<typeof resolveTelegramConversationRoute>["route"],
  ): boolean => candidate.accountId !== DEFAULT_ACCOUNT_ID && candidate.matchedBy === "default";
  const isNamedAccountFallback = requiresExplicitAccountBinding(route);
  // Named-account groups still require an explicit binding; DMs get a
  // per-account fallback session key below to preserve isolation.
  if (isNamedAccountFallback && isGroup) {
    logInboundDrop({
      log: logVerbose,
      channel: "telegram",
      reason: "non-default account requires explicit binding",
      target: route.accountId,
    });
    return null;
  }
  // Calculate groupAllowOverride first - it's needed for both DM and group allowlist checks
  const groupAllowOverride = firstDefined(topicConfig?.allowFrom, groupConfig?.allowFrom);
  // For DMs, prefer per-DM/topic allowFrom (groupAllowOverride) over account-level allowFrom
  const dmAllowFrom = groupAllowOverride ?? allowFrom;
  const effectiveDmAllow = normalizeDmAllowFromWithStore({
    allowFrom: dmAllowFrom,
    storeAllowFrom,
    dmPolicy: effectiveDmPolicy,
  });
  // Group sender checks are explicit and must not inherit DM pairing-store entries.
  const effectiveGroupAllow = normalizeAllowFrom(groupAllowOverride ?? groupAllowFrom);
  const hasGroupAllowOverride = typeof groupAllowOverride !== "undefined";
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
      effectiveDmAllow,
      accountId: account.accountId,
      bot,
      logger,
      upsertPairingRequest,
    }))
  ) {
    return null;
  }
  const ensureConfiguredBindingReady = async (): Promise<boolean> => {
    if (!configuredBinding) {
      return true;
    }
    const ensureConfiguredBindingRouteReady =
      runtime?.ensureConfiguredBindingRouteReady ??
      (await loadTelegramMessageContextRuntime()).ensureConfiguredBindingRouteReady;
    const ensured = await ensureConfiguredBindingRouteReady({
      cfg: freshCfg,
      bindingResolution: configuredBinding,
    });
    if (ensured.ok) {
      logVerbose(
        `telegram: using configured ACP binding for ${configuredBinding.record.conversation.conversationId} -> ${configuredBindingSessionKey}`,
      );
      return true;
    }
    logVerbose(
      `telegram: configured ACP binding unavailable for ${configuredBinding.record.conversation.conversationId}: ${ensured.error}`,
    );
    logInboundDrop({
      log: logVerbose,
      channel: "telegram",
      reason: "configured ACP binding unavailable",
      target: configuredBinding.record.conversation.conversationId,
    });
    return false;
  };

  const baseSessionKey = resolveTelegramConversationBaseSessionKey({
    cfg: freshCfg,
    route,
    chatId,
    isGroup,
    senderId,
  });
  // DMs: use thread suffix for session isolation (works regardless of dmScope)
  const threadKeys =
    dmThreadId != null
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
  // Compute requireMention after access checks and final route selection.
  const activationOverride = resolveGroupActivation({
    chatId,
    messageThreadId: resolvedThreadId,
    sessionKey: sessionKey,
    agentId: route.agentId,
  });
  const baseRequireMention = resolveGroupRequireMention(chatId);
  const requireMention = firstDefined(
    activationOverride,
    topicConfig?.requireMention,
    telegramGroupConfig?.requireMention,
    baseRequireMention,
  );

  const recordChannelActivity =
    runtime?.recordChannelActivity ??
    (await loadTelegramMessageContextRuntime()).recordChannelActivity;
  recordChannelActivity({
    channel: "telegram",
    accountId: account.accountId,
    direction: "inbound",
  });

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
    routeAgentId: route.agentId,
    sessionKey,
    effectiveGroupAllow,
    effectiveDmAllow,
    groupConfig,
    topicConfig,
    requireMention,
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

  // ACK reactions
  const ackReaction = resolveAckReaction(cfg, route.agentId, {
    channel: "telegram",
    accountId: account.accountId,
  });
  const ackReactionEmoji =
    ackReaction && isTelegramSupportedReactionEmoji(ackReaction) ? ackReaction : undefined;
  const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;
  const shouldAckReaction = () =>
    Boolean(
      ackReaction &&
      shouldAckReactionGate({
        scope: ackReactionScope,
        isDirect: !isGroup,
        isGroup,
        isMentionableGroup: isGroup,
        requireMention: Boolean(requireMention),
        canDetectMention: bodyResult.canDetectMention,
        effectiveWasMentioned: bodyResult.effectiveWasMentioned,
        shouldBypassMention: bodyResult.shouldBypassMention,
      }),
    );
  // Status Reactions controller (lifecycle reactions)
  const statusReactionsConfig = cfg.messages?.statusReactions;
  const statusReactionsEnabled =
    statusReactionsConfig?.enabled === true && Boolean(reactionApi) && shouldAckReaction();
  const resolvedStatusReactionEmojis = resolveTelegramStatusReactionEmojis({
    initialEmoji: ackReaction,
    overrides: statusReactionsConfig?.emojis,
  });
  const statusReactionVariantsByEmoji = buildTelegramStatusReactionVariants(
    resolvedStatusReactionEmojis,
  );
  let allowedStatusReactionEmojisPromise: Promise<Set<TelegramReactionEmoji> | null> | null = null;
  const createStatusReactionController =
    statusReactionsEnabled && msg.message_id
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
                  }).catch((err) => {
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
            // Telegram replaces atomically — no removeReaction needed
          },
          initialEmoji: ackReaction,
          emojis: resolvedStatusReactionEmojis,
          timing: statusReactionsConfig?.timing,
          onError: (err) => {
            logVerbose(`telegram status-reaction error for chat ${chatId}: ${String(err)}`);
          },
        })
      : null;

  // When status reactions are enabled, setQueued() replaces the simple ack reaction
  const ackReactionPromise: Promise<boolean> | null = statusReactionController
    ? shouldAckReaction()
      ? Promise.resolve(statusReactionController.setQueued()).then(
          () => true,
          () => false,
        )
      : null
    : shouldAckReaction() && msg.message_id && reactionApi && ackReactionEmoji
      ? withTelegramApiErrorLogging({
          operation: "setMessageReaction",
          fn: () =>
            reactionApi(chatId, msg.message_id, [{ type: "emoji", emoji: ackReactionEmoji }]),
        }).then(
          () => true,
          (err) => {
            logVerbose(`telegram react failed for chat ${chatId}: ${String(err)}`);
            return false;
          },
        )
      : null;

  const { ctxPayload, skillFilter } = await buildTelegramInboundContextPayload({
    cfg,
    primaryCtx,
    msg,
    allMedia,
    replyMedia,
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
    stickerCacheHit: bodyResult.stickerCacheHit,
    effectiveWasMentioned: bodyResult.effectiveWasMentioned,
    locationData: bodyResult.locationData,
    options,
    dmAllowFrom,
    effectiveGroupAllow,
    commandAuthorized: bodyResult.commandAuthorized,
    topicName,
    sessionRuntime,
  });

  return {
    ctxPayload,
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
    ackReactionPromise,
    reactionApi,
    removeAckAfterReply,
    statusReactionController,
    accountId: account.accountId,
  };
};
