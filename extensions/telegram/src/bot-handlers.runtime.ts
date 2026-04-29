import type { Message, ReactionTypeEmoji } from "@grammyjs/types";
import { parseExecApprovalCommandText } from "openclaw/plugin-sdk/approval-reply-runtime";
import { resolveChannelConfigWrites } from "openclaw/plugin-sdk/channel-config-helpers";
import { shouldDebounceTextInbound } from "openclaw/plugin-sdk/channel-inbound";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "openclaw/plugin-sdk/channel-inbound-debounce";
import { resolveStoredModelOverride } from "openclaw/plugin-sdk/command-auth";
import {
  resolveCommandAuthorization,
  resolveCommandAuthorizedFromAuthorizers,
} from "openclaw/plugin-sdk/command-auth-native";
import { buildCommandsMessagePaginated } from "openclaw/plugin-sdk/command-status";
import { replaceConfigFile } from "openclaw/plugin-sdk/config-mutation";
import type { DmPolicy, OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { TelegramGroupConfig, TelegramTopicConfig } from "openclaw/plugin-sdk/config-types";
import {
  buildPluginBindingResolvedText,
  parsePluginBindingApprovalCustomId,
  resolvePluginConversationBindingApproval,
} from "openclaw/plugin-sdk/conversation-runtime";
import { applyModelOverrideToSessionEntry } from "openclaw/plugin-sdk/model-session-runtime";
import { formatModelsAvailableHeader } from "openclaw/plugin-sdk/models-provider-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import { danger, logVerbose, warn } from "openclaw/plugin-sdk/runtime-env";
import {
  loadSessionStore,
  resolveSessionStoreEntry,
  updateSessionStore,
} from "openclaw/plugin-sdk/session-store-runtime";
import { resolveTelegramMediaRuntimeOptions } from "./accounts.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import {
  isSenderAllowed,
  normalizeDmAllowFromWithStore,
  type NormalizedAllowFrom,
} from "./bot-access.js";
import {
  resolveAgentDir,
  resolveDefaultAgentId,
  resolveDefaultModelForAgent,
} from "./bot-handlers.agent.runtime.js";
import {
  buildTelegramInboundDebounceConversationKey,
  buildTelegramInboundDebounceKey,
} from "./bot-handlers.debounce-key.js";
import {
  hasInboundMedia,
  hasReplyTargetMedia,
  isMediaSizeLimitError,
  isRecoverableMediaGroupError,
  resolveInboundMediaFileId,
} from "./bot-handlers.media.js";
import type { TelegramMediaRef } from "./bot-message-context.js";
import {
  parseTelegramNativeCommandCallbackData,
  RegisterTelegramHandlerParams,
} from "./bot-native-commands.js";
import {
  MEDIA_GROUP_TIMEOUT_MS,
  type MediaGroupEntry,
  type TelegramUpdateKeyContext,
} from "./bot-updates.js";
import { resolveMedia } from "./bot/delivery.resolve-media.js";
import {
  getTelegramTextParts,
  buildTelegramGroupFrom,
  buildTelegramGroupPeerId,
  buildTelegramParentPeer,
  resolveTelegramForumFlag,
  resolveTelegramForumThreadId,
  resolveTelegramGroupAllowFromContext,
  withResolvedTelegramForumFlag,
} from "./bot/helpers.js";
import type { TelegramContext, TelegramGetChat } from "./bot/types.js";
import { buildCommandsPaginationKeyboard, buildTelegramModelsMenuButtons } from "./command-ui.js";
import {
  resolveTelegramConversationBaseSessionKey,
  resolveTelegramConversationRoute,
} from "./conversation-route.js";
import { enforceTelegramDmAccess } from "./dm-access.js";
import { resolveTelegramExecApproval } from "./exec-approval-resolver.js";
import {
  isTelegramExecApprovalApprover,
  isTelegramExecApprovalAuthorizedSender,
  shouldEnableTelegramExecApprovalButtons,
} from "./exec-approvals.js";
import {
  evaluateTelegramGroupBaseAccess,
  evaluateTelegramGroupPolicyAccess,
} from "./group-access.js";
import { migrateTelegramGroupConfig } from "./group-migration.js";
import { resolveTelegramInlineButtonsScope } from "./inline-buttons.js";
import { dispatchTelegramPluginInteractiveHandler } from "./interactive-dispatch.js";
import {
  buildModelsKeyboard,
  buildProviderKeyboard,
  calculateTotalPages,
  getModelsPageSize,
  parseModelCallbackData,
  resolveModelSelection,
  type ProviderInfo,
} from "./model-buttons.js";
import { buildInlineKeyboard } from "./send.js";

export const registerTelegramHandlers = ({
  cfg,
  accountId,
  bot,
  opts,
  telegramTransport,
  runtime,
  mediaMaxBytes,
  telegramCfg,
  allowFrom,
  groupAllowFrom,
  resolveGroupPolicy,
  resolveTelegramGroupConfig,
  shouldSkipUpdate,
  processMessage,
  logger,
  telegramDeps,
}: RegisterTelegramHandlerParams) => {
  const mediaRuntimeOptions = resolveTelegramMediaRuntimeOptions({
    cfg,
    accountId,
    token: opts.token,
    transport: telegramTransport,
  });
  const DEFAULT_TEXT_FRAGMENT_MAX_GAP_MS = 1500;
  const TELEGRAM_TEXT_FRAGMENT_START_THRESHOLD_CHARS = 4000;
  const TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS =
    typeof opts.testTimings?.textFragmentGapMs === "number" &&
    Number.isFinite(opts.testTimings.textFragmentGapMs)
      ? Math.max(10, Math.floor(opts.testTimings.textFragmentGapMs))
      : DEFAULT_TEXT_FRAGMENT_MAX_GAP_MS;
  const TELEGRAM_TEXT_FRAGMENT_MAX_ID_GAP = 1;
  const TELEGRAM_TEXT_FRAGMENT_MAX_PARTS = 12;
  const TELEGRAM_TEXT_FRAGMENT_MAX_TOTAL_CHARS = 50_000;
  const mediaGroupTimeoutMs =
    typeof opts.testTimings?.mediaGroupFlushMs === "number" &&
    Number.isFinite(opts.testTimings.mediaGroupFlushMs)
      ? Math.max(10, Math.floor(opts.testTimings.mediaGroupFlushMs))
      : MEDIA_GROUP_TIMEOUT_MS;

  const mediaGroupBuffer = new Map<string, MediaGroupEntry>();
  let mediaGroupProcessing: Promise<void> = Promise.resolve();

  type TextFragmentEntry = {
    key: string;
    messages: Array<{ msg: Message; ctx: TelegramContext; receivedAtMs: number }>;
    timer: ReturnType<typeof setTimeout>;
  };
  const textFragmentBuffer = new Map<string, TextFragmentEntry>();
  let textFragmentProcessing: Promise<void> = Promise.resolve();

  const debounceMs = resolveInboundDebounceMs({ cfg, channel: "telegram" });
  const FORWARD_BURST_DEBOUNCE_MS = 80;
  type TelegramDebounceLane = "default" | "forward";
  type TelegramDebounceEntry = {
    ctx: TelegramContext;
    msg: Message;
    allMedia: TelegramMediaRef[];
    storeAllowFrom: string[];
    receivedAtMs: number;
    debounceKey: string | null;
    debounceLane: TelegramDebounceLane;
    botUsername?: string;
  };
  const resolveTelegramDebounceLane = (msg: Message): TelegramDebounceLane => {
    const forwardMeta = msg as {
      forward_origin?: unknown;
      forward_from?: unknown;
      forward_from_chat?: unknown;
      forward_sender_name?: unknown;
      forward_date?: unknown;
    };
    return (forwardMeta.forward_origin ??
      forwardMeta.forward_from ??
      forwardMeta.forward_from_chat ??
      forwardMeta.forward_sender_name ??
      forwardMeta.forward_date)
      ? "forward"
      : "default";
  };
  const buildSyntheticTextMessage = (params: {
    base: Message;
    text: string;
    date?: number;
    from?: Message["from"];
  }): Message => ({
    ...params.base,
    ...(params.from ? { from: params.from } : {}),
    text: params.text,
    caption: undefined,
    caption_entities: undefined,
    entities: undefined,
    ...(params.date != null ? { date: params.date } : {}),
  });
  const buildSyntheticContext = (
    ctx: Pick<TelegramContext, "me"> & { getFile?: unknown },
    message: Message,
  ): TelegramContext => {
    const getFile =
      typeof ctx.getFile === "function"
        ? (ctx.getFile as TelegramContext["getFile"]).bind(ctx as object)
        : async () => ({});
    return { message, me: ctx.me, getFile };
  };
  const inboundDebouncer = createInboundDebouncer<TelegramDebounceEntry>({
    debounceMs,
    resolveDebounceMs: (entry) =>
      entry.debounceLane === "forward" ? FORWARD_BURST_DEBOUNCE_MS : debounceMs,
    buildKey: (entry) => entry.debounceKey,
    shouldDebounce: (entry) => {
      const text = getTelegramTextParts(entry.msg).text;
      const hasDebounceableText = shouldDebounceTextInbound({
        text,
        cfg,
        commandOptions: { botUsername: entry.botUsername },
      });
      if (entry.debounceLane === "forward") {
        // Forwarded bursts often split text + media into adjacent updates.
        // Debounce media-only forward entries too so they can coalesce.
        return hasDebounceableText || entry.allMedia.length > 0;
      }
      if (!hasDebounceableText) {
        return false;
      }
      return entry.allMedia.length === 0;
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      if (entries.length === 1) {
        const replyMedia = await resolveReplyMediaForMessage(last.ctx, last.msg);
        await processMessage(
          last.ctx,
          last.allMedia,
          last.storeAllowFrom,
          {
            receivedAtMs: last.receivedAtMs,
            ingressBuffer: "inbound-debounce",
          },
          replyMedia,
        );
        return;
      }
      const combinedText = entries
        .map((entry) => getTelegramTextParts(entry.msg).text)
        .filter(Boolean)
        .join("\n");
      const combinedMedia = entries.flatMap((entry) => entry.allMedia);
      if (!combinedText.trim() && combinedMedia.length === 0) {
        return;
      }
      const first = entries[0];
      const baseCtx = first.ctx;
      const syntheticMessage = buildSyntheticTextMessage({
        base: first.msg,
        text: combinedText,
        date: last.msg.date ?? first.msg.date,
      });
      const messageIdOverride = last.msg.message_id ? String(last.msg.message_id) : undefined;
      const syntheticCtx = buildSyntheticContext(baseCtx, syntheticMessage);
      const replyMedia = await resolveReplyMediaForMessage(baseCtx, syntheticMessage);
      await processMessage(
        syntheticCtx,
        combinedMedia,
        first.storeAllowFrom,
        {
          ...(messageIdOverride ? { messageIdOverride } : {}),
          receivedAtMs: first.receivedAtMs,
          ingressBuffer: "inbound-debounce",
        },
        replyMedia,
      );
    },
    onError: (err, items) => {
      runtime.error?.(danger(`telegram debounce flush failed: ${String(err)}`));
      const chatId = items[0]?.msg.chat.id;
      if (chatId != null) {
        const threadId = items[0]?.msg.message_thread_id;
        void bot.api
          .sendMessage(
            chatId,
            "Something went wrong while processing your message. Please try again.",
            threadId != null ? { message_thread_id: threadId } : undefined,
          )
          .catch((sendErr) => {
            logVerbose(`telegram: error fallback send failed: ${String(sendErr)}`);
          });
      }
    },
  });

  const resolveTelegramSessionState = (params: {
    chatId: number | string;
    isGroup: boolean;
    isForum: boolean;
    messageThreadId?: number;
    resolvedThreadId?: number;
    senderId?: string | number;
  }): {
    agentId: string;
    sessionEntry: ReturnType<typeof resolveSessionStoreEntry>["existing"];
    sessionKey: string;
    model?: string;
  } => {
    const runtimeCfg = telegramDeps.getRuntimeConfig();
    const resolvedThreadId =
      params.resolvedThreadId ??
      resolveTelegramForumThreadId({
        isForum: params.isForum,
        messageThreadId: params.messageThreadId,
      });
    const dmThreadId = !params.isGroup ? params.messageThreadId : undefined;
    const topicThreadId = resolvedThreadId ?? dmThreadId;
    const { topicConfig } = resolveTelegramGroupConfig(params.chatId, topicThreadId);
    const { route } = resolveTelegramConversationRoute({
      cfg: runtimeCfg,
      accountId,
      chatId: params.chatId,
      isGroup: params.isGroup,
      resolvedThreadId,
      replyThreadId: topicThreadId,
      senderId: params.senderId,
      topicAgentId: topicConfig?.agentId,
    });
    const baseSessionKey = resolveTelegramConversationBaseSessionKey({
      cfg: runtimeCfg,
      route,
      chatId: params.chatId,
      isGroup: params.isGroup,
      senderId: params.senderId,
    });
    const threadKeys =
      dmThreadId != null
        ? resolveThreadSessionKeys({ baseSessionKey, threadId: `${params.chatId}:${dmThreadId}` })
        : null;
    const sessionKey = threadKeys?.sessionKey ?? baseSessionKey;
    const storePath = telegramDeps.resolveStorePath(runtimeCfg.session?.store, {
      agentId: route.agentId,
    });
    const store = loadSessionStore(storePath);
    const entry = resolveSessionStoreEntry({ store, sessionKey }).existing;
    const storedOverride = resolveStoredModelOverride({
      sessionEntry: entry,
      sessionStore: store,
      sessionKey,
      defaultProvider: resolveDefaultModelForAgent({
        cfg: runtimeCfg,
        agentId: route.agentId,
      }).provider,
    });
    if (storedOverride) {
      return {
        agentId: route.agentId,
        sessionEntry: entry,
        sessionKey,
        model: storedOverride.provider
          ? `${storedOverride.provider}/${storedOverride.model}`
          : storedOverride.model,
      };
    }
    const provider = entry?.modelProvider?.trim();
    const model = entry?.model?.trim();
    if (provider && model) {
      return {
        agentId: route.agentId,
        sessionEntry: entry,
        sessionKey,
        model: `${provider}/${model}`,
      };
    }
    const modelCfg = runtimeCfg.agents?.defaults?.model;
    return {
      agentId: route.agentId,
      sessionEntry: entry,
      sessionKey,
      model: typeof modelCfg === "string" ? modelCfg : modelCfg?.primary,
    };
  };

  const processMediaGroup = async (entry: MediaGroupEntry) => {
    try {
      entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);

      const captionMsg = entry.messages.find((m) => m.msg.caption || m.msg.text);
      const primaryEntry = captionMsg ?? entry.messages[0];

      const allMedia: TelegramMediaRef[] = [];
      for (const { ctx } of entry.messages) {
        let media;
        try {
          media = await resolveMedia({
            ctx,
            maxBytes: mediaMaxBytes,
            ...mediaRuntimeOptions,
          });
        } catch (mediaErr) {
          if (!isRecoverableMediaGroupError(mediaErr)) {
            throw mediaErr;
          }
          runtime.log?.(
            warn(`media group: skipping photo that failed to fetch: ${String(mediaErr)}`),
          );
          continue;
        }
        if (media) {
          allMedia.push({
            path: media.path,
            contentType: media.contentType,
            stickerMetadata: media.stickerMetadata,
          });
        }
      }

      const storeAllowFrom = await loadStoreAllowFrom();
      const replyMedia = await resolveReplyMediaForMessage(primaryEntry.ctx, primaryEntry.msg);
      await processMessage(primaryEntry.ctx, allMedia, storeAllowFrom, undefined, replyMedia);
    } catch (err) {
      runtime.error?.(danger(`media group handler failed: ${String(err)}`));
    }
  };

  const flushTextFragments = async (entry: TextFragmentEntry) => {
    try {
      entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);

      const first = entry.messages[0];
      const last = entry.messages.at(-1);
      if (!first || !last) {
        return;
      }

      const combinedText = entry.messages.map((m) => m.msg.text ?? "").join("");
      if (!combinedText.trim()) {
        return;
      }

      const syntheticMessage = buildSyntheticTextMessage({
        base: first.msg,
        text: combinedText,
        date: last.msg.date ?? first.msg.date,
      });

      const storeAllowFrom = await loadStoreAllowFrom();
      const baseCtx = first.ctx;

      await processMessage(buildSyntheticContext(baseCtx, syntheticMessage), [], storeAllowFrom, {
        messageIdOverride: String(last.msg.message_id),
        receivedAtMs: first.receivedAtMs,
        ingressBuffer: "text-fragment",
      });
    } catch (err) {
      runtime.error?.(danger(`text fragment handler failed: ${String(err)}`));
    }
  };

  const queueTextFragmentFlush = async (entry: TextFragmentEntry) => {
    textFragmentProcessing = textFragmentProcessing
      .then(async () => {
        await flushTextFragments(entry);
      })
      .catch(() => undefined);
    await textFragmentProcessing;
  };

  const runTextFragmentFlush = async (entry: TextFragmentEntry) => {
    textFragmentBuffer.delete(entry.key);
    await queueTextFragmentFlush(entry);
  };

  const scheduleTextFragmentFlush = (entry: TextFragmentEntry) => {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(async () => {
      await runTextFragmentFlush(entry);
    }, TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS);
  };

  const loadStoreAllowFrom = async () =>
    telegramDeps.readChannelAllowFromStore("telegram", process.env, accountId).catch(() => []);

  const resolveReplyMediaForMessage = async (
    ctx: TelegramContext,
    msg: Message,
  ): Promise<TelegramMediaRef[]> => {
    const replyMessage = msg.reply_to_message;
    if (!replyMessage || !hasInboundMedia(replyMessage)) {
      return [];
    }
    const replyFileId = resolveInboundMediaFileId(replyMessage);
    if (!replyFileId) {
      return [];
    }
    try {
      const media = await resolveMedia({
        ctx: {
          message: replyMessage,
          me: ctx.me,
          getFile: async () => await bot.api.getFile(replyFileId),
        },
        maxBytes: mediaMaxBytes,
        ...mediaRuntimeOptions,
      });
      if (!media) {
        return [];
      }
      return [
        {
          path: media.path,
          contentType: media.contentType,
          stickerMetadata: media.stickerMetadata,
        },
      ];
    } catch (err) {
      logger.warn({ chatId: msg.chat.id, error: String(err) }, "reply media fetch failed");
      return [];
    }
  };

  const isAllowlistAuthorized = (
    allow: NormalizedAllowFrom,
    senderId: string,
    senderUsername: string,
  ) =>
    allow.hasWildcard ||
    (allow.hasEntries &&
      isSenderAllowed({
        allow,
        senderId,
        senderUsername,
      }));

  const shouldSkipGroupMessage = (params: {
    isGroup: boolean;
    chatId: string | number;
    chatTitle?: string;
    resolvedThreadId?: number;
    senderId: string;
    senderUsername: string;
    effectiveGroupAllow: NormalizedAllowFrom;
    hasGroupAllowOverride: boolean;
    groupConfig?: TelegramGroupConfig;
    topicConfig?: TelegramTopicConfig;
  }) => {
    const {
      isGroup,
      chatId,
      chatTitle,
      resolvedThreadId,
      senderId,
      senderUsername,
      effectiveGroupAllow,
      hasGroupAllowOverride,
      groupConfig,
      topicConfig,
    } = params;
    const baseAccess = evaluateTelegramGroupBaseAccess({
      isGroup,
      groupConfig,
      topicConfig,
      hasGroupAllowOverride,
      effectiveGroupAllow,
      senderId,
      senderUsername,
      enforceAllowOverride: true,
      requireSenderForAllowOverride: true,
    });
    if (!baseAccess.allowed) {
      if (baseAccess.reason === "group-disabled") {
        logVerbose(`Blocked telegram group ${chatId} (group disabled)`);
        return true;
      }
      if (baseAccess.reason === "topic-disabled") {
        logVerbose(
          `Blocked telegram topic ${chatId} (${resolvedThreadId ?? "unknown"}) (topic disabled)`,
        );
        return true;
      }
      logVerbose(
        `Blocked telegram group sender ${senderId || "unknown"} (group allowFrom override)`,
      );
      return true;
    }
    if (!isGroup) {
      return false;
    }
    const policyAccess = evaluateTelegramGroupPolicyAccess({
      isGroup,
      chatId,
      cfg,
      telegramCfg,
      topicConfig,
      groupConfig,
      effectiveGroupAllow,
      senderId,
      senderUsername,
      resolveGroupPolicy,
      enforcePolicy: true,
      useTopicAndGroupOverrides: true,
      enforceAllowlistAuthorization: true,
      allowEmptyAllowlistEntries: false,
      requireSenderForAllowlistAuthorization: true,
      checkChatAllowlist: true,
    });
    if (!policyAccess.allowed) {
      if (policyAccess.reason === "group-policy-disabled") {
        logVerbose("Blocked telegram group message (groupPolicy: disabled)");
        return true;
      }
      if (policyAccess.reason === "group-policy-allowlist-no-sender") {
        logVerbose("Blocked telegram group message (no sender ID, groupPolicy: allowlist)");
        return true;
      }
      if (policyAccess.reason === "group-policy-allowlist-empty") {
        logVerbose(
          "Blocked telegram group message (groupPolicy: allowlist, no group allowlist entries)",
        );
        return true;
      }
      if (policyAccess.reason === "group-policy-allowlist-unauthorized") {
        logVerbose(`Blocked telegram group message from ${senderId} (groupPolicy: allowlist)`);
        return true;
      }
      logger.info({ chatId, title: chatTitle, reason: "not-allowed" }, "skipping group message");
      return true;
    }
    return false;
  };

  type TelegramGroupAllowContext = Awaited<ReturnType<typeof resolveTelegramGroupAllowFromContext>>;
  type TelegramEventAuthorizationMode = "reaction" | "callback-scope" | "callback-allowlist";
  type TelegramEventAuthorizationResult = { allowed: true } | { allowed: false; reason: string };
  type TelegramEventAuthorizationContext = TelegramGroupAllowContext & { dmPolicy: DmPolicy };
  const getChat =
    typeof (bot.api as { getChat?: unknown }).getChat === "function"
      ? (bot.api as { getChat: TelegramGetChat }).getChat.bind(bot.api)
      : undefined;

  const TELEGRAM_EVENT_AUTH_RULES: Record<
    TelegramEventAuthorizationMode,
    {
      enforceDirectAuthorization: boolean;
      enforceGroupAllowlistAuthorization: boolean;
      deniedDmReason: string;
      deniedGroupReason: string;
    }
  > = {
    reaction: {
      enforceDirectAuthorization: true,
      enforceGroupAllowlistAuthorization: false,
      deniedDmReason: "reaction unauthorized by dm policy/allowlist",
      deniedGroupReason: "reaction unauthorized by group allowlist",
    },
    "callback-scope": {
      enforceDirectAuthorization: false,
      enforceGroupAllowlistAuthorization: false,
      deniedDmReason: "callback unauthorized by inlineButtonsScope",
      deniedGroupReason: "callback unauthorized by inlineButtonsScope",
    },
    "callback-allowlist": {
      enforceDirectAuthorization: true,
      // Group auth is already enforced by shouldSkipGroupMessage (group policy + allowlist).
      // An extra allowlist gate here would block users whose original command was authorized.
      enforceGroupAllowlistAuthorization: false,
      deniedDmReason: "callback unauthorized by inlineButtonsScope allowlist",
      deniedGroupReason: "callback unauthorized by inlineButtonsScope allowlist",
    },
  };

  class TelegramRetryableCallbackError extends Error {
    constructor(public readonly cause: unknown) {
      super(String(cause));
      this.name = "TelegramRetryableCallbackError";
    }
  }

  const TELEGRAM_PERMANENT_CALLBACK_EDIT_ERROR_RE =
    /400:\s*Bad Request:\s*message to edit not found|400:\s*Bad Request:\s*there is no text in the message to edit|MESSAGE_ID_INVALID|400:\s*Bad Request:\s*message can't be edited/i;

  const isPermanentTelegramCallbackEditError = (err: unknown): boolean =>
    TELEGRAM_PERMANENT_CALLBACK_EDIT_ERROR_RE.test(String(err));

  const resolveTelegramEventAuthorizationContext = async (params: {
    chatId: number;
    isGroup: boolean;
    isForum: boolean;
    messageThreadId?: number;
    groupAllowContext?: TelegramGroupAllowContext;
  }): Promise<TelegramEventAuthorizationContext> => {
    const groupAllowContext =
      params.groupAllowContext ??
      (await resolveTelegramGroupAllowFromContext({
        chatId: params.chatId,
        accountId,
        isGroup: params.isGroup,
        isForum: params.isForum,
        messageThreadId: params.messageThreadId,
        groupAllowFrom,
        readChannelAllowFromStore: telegramDeps.readChannelAllowFromStore,
        resolveTelegramGroupConfig,
      }));
    // Use direct config dmPolicy override if available for DMs
    const effectiveDmPolicy =
      !params.isGroup &&
      groupAllowContext.groupConfig &&
      "dmPolicy" in groupAllowContext.groupConfig
        ? (groupAllowContext.groupConfig.dmPolicy ?? telegramCfg.dmPolicy ?? "pairing")
        : (telegramCfg.dmPolicy ?? "pairing");
    return { dmPolicy: effectiveDmPolicy, ...groupAllowContext };
  };

  const authorizeTelegramEventSender = (params: {
    chatId: number;
    chatTitle?: string;
    isGroup: boolean;
    senderId: string;
    senderUsername: string;
    mode: TelegramEventAuthorizationMode;
    context: TelegramEventAuthorizationContext;
  }): TelegramEventAuthorizationResult => {
    const { chatId, chatTitle, isGroup, senderId, senderUsername, mode, context } = params;
    const {
      dmPolicy,
      resolvedThreadId,
      storeAllowFrom,
      groupConfig,
      topicConfig,
      groupAllowOverride,
      effectiveGroupAllow,
      hasGroupAllowOverride,
    } = context;
    const authRules = TELEGRAM_EVENT_AUTH_RULES[mode];
    const {
      enforceDirectAuthorization,
      enforceGroupAllowlistAuthorization,
      deniedDmReason,
      deniedGroupReason,
    } = authRules;
    if (
      shouldSkipGroupMessage({
        isGroup,
        chatId,
        chatTitle,
        resolvedThreadId,
        senderId,
        senderUsername,
        effectiveGroupAllow,
        hasGroupAllowOverride,
        groupConfig,
        topicConfig,
      })
    ) {
      return { allowed: false, reason: "group-policy" };
    }

    if (!isGroup && enforceDirectAuthorization) {
      if (dmPolicy === "disabled") {
        logVerbose(
          `Blocked telegram direct event from ${senderId || "unknown"} (${deniedDmReason})`,
        );
        return { allowed: false, reason: "direct-disabled" };
      }
      // For DMs, prefer per-DM/topic allowFrom (groupAllowOverride) over account-level allowFrom.
      const dmAllowFrom = groupAllowOverride ?? allowFrom;
      const effectiveDmAllow = normalizeDmAllowFromWithStore({
        allowFrom: dmAllowFrom,
        storeAllowFrom,
        dmPolicy,
      });
      const hasPublicDmAccess = dmPolicy === "open" && effectiveDmAllow.hasWildcard;
      if (
        !hasPublicDmAccess &&
        !isAllowlistAuthorized(effectiveDmAllow, senderId, senderUsername)
      ) {
        logVerbose(`Blocked telegram direct sender ${senderId || "unknown"} (${deniedDmReason})`);
        return { allowed: false, reason: "direct-unauthorized" };
      }
    }
    if (isGroup && enforceGroupAllowlistAuthorization) {
      if (!isAllowlistAuthorized(effectiveGroupAllow, senderId, senderUsername)) {
        logVerbose(`Blocked telegram group sender ${senderId || "unknown"} (${deniedGroupReason})`);
        return { allowed: false, reason: "group-unauthorized" };
      }
    }
    return { allowed: true };
  };

  const isTelegramModelCallbackAuthorized = (params: {
    chatId: number;
    isGroup: boolean;
    senderId: string;
    senderUsername: string;
    context: TelegramEventAuthorizationContext;
    cfg: OpenClawConfig;
  }): boolean => {
    const { chatId, isGroup, senderId, senderUsername, context, cfg } = params;
    const useAccessGroups = cfg.commands?.useAccessGroups !== false;
    const dmAllowFrom = context.groupAllowOverride ?? allowFrom;
    const commandsAllowFrom = cfg.commands?.allowFrom;
    const commandsAllowFromConfigured =
      commandsAllowFrom != null &&
      typeof commandsAllowFrom === "object" &&
      (Array.isArray(commandsAllowFrom.telegram) || Array.isArray(commandsAllowFrom["*"]));
    if (commandsAllowFromConfigured) {
      return resolveCommandAuthorization({
        ctx: {
          Provider: "telegram",
          Surface: "telegram",
          OriginatingChannel: "telegram",
          AccountId: accountId,
          ChatType: isGroup ? "group" : "direct",
          From: isGroup
            ? buildTelegramGroupFrom(chatId, context.resolvedThreadId)
            : `telegram:${chatId}`,
          SenderId: senderId || undefined,
          SenderUsername: senderUsername || undefined,
        },
        cfg,
        commandAuthorized: false,
      }).isAuthorizedSender;
    }

    const dmAllow = normalizeDmAllowFromWithStore({
      allowFrom: dmAllowFrom,
      storeAllowFrom: isGroup ? [] : context.storeAllowFrom,
      dmPolicy: context.dmPolicy,
    });
    const senderAllowed = isSenderAllowed({
      allow: dmAllow,
      senderId,
      senderUsername,
    });
    const groupSenderAllowed = isGroup
      ? isSenderAllowed({
          allow: context.effectiveGroupAllow,
          senderId,
          senderUsername,
        })
      : false;

    return resolveCommandAuthorizedFromAuthorizers({
      useAccessGroups,
      authorizers: [
        { configured: dmAllow.hasEntries, allowed: senderAllowed },
        ...(isGroup
          ? [
              {
                configured: context.effectiveGroupAllow.hasEntries,
                allowed: groupSenderAllowed,
              },
            ]
          : []),
      ],
      modeWhenAccessGroupsOff: "configured",
    });
  };

  // Handle emoji reactions to messages.
  bot.on("message_reaction", async (ctx) => {
    try {
      const reaction = ctx.messageReaction;
      if (!reaction) {
        return;
      }
      if (shouldSkipUpdate(ctx)) {
        return;
      }

      const chatId = reaction.chat.id;
      const messageId = reaction.message_id;
      const user = reaction.user;
      const senderId = user?.id != null ? String(user.id) : "";
      const senderUsername = user?.username ?? "";
      const isGroup = reaction.chat.type === "group" || reaction.chat.type === "supergroup";
      const isForum = reaction.chat.is_forum === true;

      // Resolve reaction notification mode (default: "own").
      const reactionMode = telegramCfg.reactionNotifications ?? "own";
      if (reactionMode === "off") {
        return;
      }
      if (user?.is_bot) {
        return;
      }
      if (reactionMode === "own" && !telegramDeps.wasSentByBot(chatId, messageId, cfg)) {
        logVerbose(
          `telegram: skipped reaction on msg ${messageId} in chat ${chatId} (own mode, not sent by bot)`,
        );
        return;
      }
      const eventAuthContext = await resolveTelegramEventAuthorizationContext({
        chatId,
        isGroup,
        isForum,
      });
      const senderAuthorization = authorizeTelegramEventSender({
        chatId,
        chatTitle: reaction.chat.title,
        isGroup,
        senderId,
        senderUsername,
        mode: "reaction",
        context: eventAuthContext,
      });
      if (!senderAuthorization.allowed) {
        return;
      }

      // Enforce requireTopic for DM reactions: since Telegram doesn't provide messageThreadId
      // for reactions, we cannot determine if the reaction came from a topic, so block all
      // reactions if requireTopic is enabled for this DM.
      if (!isGroup) {
        const requireTopic = (
          eventAuthContext.groupConfig as { requireTopic?: boolean } | undefined
        )?.requireTopic;
        if (requireTopic === true) {
          logVerbose(
            `Blocked telegram reaction in DM ${chatId}: requireTopic=true but topic unknown for reactions`,
          );
          return;
        }
      }

      // Detect added reactions.
      const oldEmojis = new Set(
        reaction.old_reaction
          .filter((r): r is ReactionTypeEmoji => r.type === "emoji")
          .map((r) => r.emoji),
      );
      const addedReactions = reaction.new_reaction
        .filter((r): r is ReactionTypeEmoji => r.type === "emoji")
        .filter((r) => !oldEmojis.has(r.emoji));

      if (addedReactions.length === 0) {
        return;
      }

      // Build sender label.
      const senderName = user
        ? [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || user.username
        : undefined;
      const senderUsernameLabel = user?.username ? `@${user.username}` : undefined;
      let senderLabel = senderName;
      if (senderName && senderUsernameLabel) {
        senderLabel = `${senderName} (${senderUsernameLabel})`;
      } else if (!senderName && senderUsernameLabel) {
        senderLabel = senderUsernameLabel;
      }
      if (!senderLabel && user?.id) {
        senderLabel = `id:${user.id}`;
      }
      senderLabel = senderLabel || "unknown";

      // Reactions target a specific message_id; the Telegram Bot API does not include
      // message_thread_id on MessageReactionUpdated, so we route to the chat-level
      // session (forum topic routing is not available for reactions).
      const resolvedThreadId = isForum
        ? resolveTelegramForumThreadId({ isForum, messageThreadId: undefined })
        : undefined;
      const peerId = isGroup ? buildTelegramGroupPeerId(chatId, resolvedThreadId) : String(chatId);
      const parentPeer = buildTelegramParentPeer({ isGroup, resolvedThreadId, chatId });
      // Fresh config for bindings lookup; other routing inputs are payload-derived.
      const route = resolveAgentRoute({
        cfg: telegramDeps.getRuntimeConfig(),
        channel: "telegram",
        accountId,
        peer: { kind: isGroup ? "group" : "direct", id: peerId },
        parentPeer,
      });
      const sessionKey = route.sessionKey;

      // Enqueue system event for each added reaction.
      for (const r of addedReactions) {
        const emoji = r.emoji;
        const text = `Telegram reaction added: ${emoji} by ${senderLabel} on msg ${messageId}`;
        telegramDeps.enqueueSystemEvent(text, {
          sessionKey,
          contextKey: `telegram:reaction:add:${chatId}:${messageId}:${user?.id ?? "anon"}:${emoji}`,
        });
        logVerbose(`telegram: reaction event enqueued: ${text}`);
      }
    } catch (err) {
      runtime.error?.(danger(`telegram reaction handler failed: ${String(err)}`));
      throw err;
    }
  });
  const processInboundMessage = async (params: {
    ctx: TelegramContext;
    msg: Message;
    chatId: number;
    resolvedThreadId?: number;
    dmThreadId?: number;
    storeAllowFrom: string[];
    sendOversizeWarning: boolean;
    oversizeLogMessage: string;
  }) => {
    const {
      ctx,
      msg,
      chatId,
      resolvedThreadId,
      dmThreadId,
      storeAllowFrom,
      sendOversizeWarning,
      oversizeLogMessage,
    } = params;

    // Text fragment handling - Telegram splits long pastes into multiple inbound messages (~4096 chars).
    // We buffer “near-limit” messages and append immediately-following parts.
    const text = typeof msg.text === "string" ? msg.text : undefined;
    const isCommandLike = (text ?? "").trim().startsWith("/");
    if (text && !isCommandLike) {
      const nowMs = Date.now();
      const senderId = msg.from?.id != null ? String(msg.from.id) : "unknown";
      // Use resolvedThreadId for forum groups, dmThreadId for DM topics
      const threadId = resolvedThreadId ?? dmThreadId;
      const key = `text:${chatId}:${threadId ?? "main"}:${senderId}`;
      const existing = textFragmentBuffer.get(key);

      if (existing) {
        const last = existing.messages.at(-1);
        const lastMsgId = last?.msg.message_id;
        const lastReceivedAtMs = last?.receivedAtMs ?? nowMs;
        const idGap = typeof lastMsgId === "number" ? msg.message_id - lastMsgId : Infinity;
        const timeGapMs = nowMs - lastReceivedAtMs;
        const canAppend =
          idGap > 0 &&
          idGap <= TELEGRAM_TEXT_FRAGMENT_MAX_ID_GAP &&
          timeGapMs >= 0 &&
          timeGapMs <= TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS;

        if (canAppend) {
          const currentTotalChars = existing.messages.reduce(
            (sum, m) => sum + (m.msg.text?.length ?? 0),
            0,
          );
          const nextTotalChars = currentTotalChars + text.length;
          if (
            existing.messages.length + 1 <= TELEGRAM_TEXT_FRAGMENT_MAX_PARTS &&
            nextTotalChars <= TELEGRAM_TEXT_FRAGMENT_MAX_TOTAL_CHARS
          ) {
            existing.messages.push({ msg, ctx, receivedAtMs: nowMs });
            scheduleTextFragmentFlush(existing);
            return;
          }
        }

        // Not appendable (or limits exceeded): flush buffered entry first, then continue normally.
        clearTimeout(existing.timer);
        textFragmentBuffer.delete(key);
        textFragmentProcessing = textFragmentProcessing
          .then(async () => {
            await flushTextFragments(existing);
          })
          .catch(() => undefined);
        await textFragmentProcessing;
      }

      const shouldStart = text.length >= TELEGRAM_TEXT_FRAGMENT_START_THRESHOLD_CHARS;
      if (shouldStart) {
        const entry: TextFragmentEntry = {
          key,
          messages: [{ msg, ctx, receivedAtMs: nowMs }],
          timer: setTimeout(() => {}, TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS),
        };
        textFragmentBuffer.set(key, entry);
        scheduleTextFragmentFlush(entry);
        return;
      }
    }

    // Media group handling - buffer multi-image messages
    const mediaGroupId = msg.media_group_id;
    if (mediaGroupId) {
      const existing = mediaGroupBuffer.get(mediaGroupId);
      if (existing) {
        clearTimeout(existing.timer);
        existing.messages.push({ msg, ctx });
        existing.timer = setTimeout(async () => {
          mediaGroupBuffer.delete(mediaGroupId);
          mediaGroupProcessing = mediaGroupProcessing
            .then(async () => {
              await processMediaGroup(existing);
            })
            .catch(() => undefined);
          await mediaGroupProcessing;
        }, mediaGroupTimeoutMs);
      } else {
        const entry: MediaGroupEntry = {
          messages: [{ msg, ctx }],
          timer: setTimeout(async () => {
            mediaGroupBuffer.delete(mediaGroupId);
            mediaGroupProcessing = mediaGroupProcessing
              .then(async () => {
                await processMediaGroup(entry);
              })
              .catch(() => undefined);
            await mediaGroupProcessing;
          }, mediaGroupTimeoutMs),
        };
        mediaGroupBuffer.set(mediaGroupId, entry);
      }
      return;
    }

    let media: Awaited<ReturnType<typeof resolveMedia>> = null;
    try {
      media = await resolveMedia({
        ctx,
        maxBytes: mediaMaxBytes,
        ...mediaRuntimeOptions,
      });
    } catch (mediaErr) {
      if (isMediaSizeLimitError(mediaErr)) {
        if (sendOversizeWarning) {
          const limitMb = Math.round(mediaMaxBytes / (1024 * 1024));
          await withTelegramApiErrorLogging({
            operation: "sendMessage",
            runtime,
            fn: () =>
              bot.api.sendMessage(chatId, `⚠️ File too large. Maximum size is ${limitMb}MB.`, {
                reply_parameters: {
                  message_id: msg.message_id,
                  allow_sending_without_reply: true,
                },
              }),
          }).catch(() => {});
        }
        logger.warn({ chatId, error: String(mediaErr) }, oversizeLogMessage);
        return;
      }
      logger.warn({ chatId, error: String(mediaErr) }, "media fetch failed");
      await withTelegramApiErrorLogging({
        operation: "sendMessage",
        runtime,
        fn: () =>
          bot.api.sendMessage(chatId, "⚠️ Failed to download media. Please try again.", {
            reply_parameters: {
              message_id: msg.message_id,
              allow_sending_without_reply: true,
            },
          }),
      }).catch(() => {});
      return;
    }

    // Skip sticker-only messages where the sticker was skipped (animated/video)
    // These have no media and no text content to process.
    const hasText = Boolean(getTelegramTextParts(msg).text.trim());
    if (msg.sticker && !media && !hasText) {
      logVerbose("telegram: skipping sticker-only message (unsupported sticker type)");
      return;
    }

    const allMedia = media
      ? [
          {
            path: media.path,
            contentType: media.contentType,
            stickerMetadata: media.stickerMetadata,
          },
        ]
      : [];
    const senderId = msg.from?.id ? String(msg.from.id) : "";
    const conversationKey = buildTelegramInboundDebounceConversationKey({
      chatId,
      threadId: resolvedThreadId ?? dmThreadId,
    });
    const debounceLane = resolveTelegramDebounceLane(msg);
    const debounceKey = senderId
      ? buildTelegramInboundDebounceKey({
          accountId,
          conversationKey,
          senderId,
          debounceLane,
        })
      : null;
    await inboundDebouncer.enqueue({
      ctx,
      msg,
      allMedia,
      storeAllowFrom,
      receivedAtMs: Date.now(),
      debounceKey,
      debounceLane,
      botUsername: ctx.me?.username,
    });
  };
  bot.on("callback_query", async (ctx) => {
    const callback = ctx.callbackQuery;
    if (!callback) {
      return;
    }
    if (shouldSkipUpdate(ctx)) {
      return;
    }
    const answerCallbackQuery =
      typeof (ctx as { answerCallbackQuery?: unknown }).answerCallbackQuery === "function"
        ? () => ctx.answerCallbackQuery()
        : () => bot.api.answerCallbackQuery(callback.id);
    // Answer immediately to prevent Telegram from retrying while we process
    await withTelegramApiErrorLogging({
      operation: "answerCallbackQuery",
      runtime,
      fn: answerCallbackQuery,
    }).catch(() => {});
    try {
      const data = (callback.data ?? "").trim();
      const callbackMessage = callback.message;
      if (!data || !callbackMessage) {
        return;
      }
      const editCallbackMessage = async (
        text: string,
        params?: Parameters<typeof bot.api.editMessageText>[3],
      ) => {
        const editTextFn = (ctx as { editMessageText?: unknown }).editMessageText;
        if (typeof editTextFn === "function") {
          return await ctx.editMessageText(text, params);
        }
        return await bot.api.editMessageText(
          callbackMessage.chat.id,
          callbackMessage.message_id,
          text,
          params,
        );
      };
      const clearCallbackButtons = async () => {
        const emptyKeyboard = { inline_keyboard: [] };
        const replyMarkup = { reply_markup: emptyKeyboard };
        const editReplyMarkupFn = (ctx as { editMessageReplyMarkup?: unknown })
          .editMessageReplyMarkup;
        if (typeof editReplyMarkupFn === "function") {
          return await ctx.editMessageReplyMarkup(replyMarkup);
        }
        const apiEditReplyMarkupFn = (bot.api as { editMessageReplyMarkup?: unknown })
          .editMessageReplyMarkup;
        if (typeof apiEditReplyMarkupFn === "function") {
          return await bot.api.editMessageReplyMarkup(
            callbackMessage.chat.id,
            callbackMessage.message_id,
            replyMarkup,
          );
        }
        // Fallback path for older clients that do not expose editMessageReplyMarkup.
        const messageText = callbackMessage.text ?? callbackMessage.caption;
        if (typeof messageText !== "string" || messageText.trim().length === 0) {
          return undefined;
        }
        return await editCallbackMessage(messageText, replyMarkup);
      };
      const editCallbackButtons = async (
        buttons: Array<
          Array<{ text: string; callback_data: string; style?: "danger" | "success" | "primary" }>
        >,
      ) => {
        const keyboard = buildInlineKeyboard(buttons) ?? { inline_keyboard: [] };
        const replyMarkup = { reply_markup: keyboard };
        const editReplyMarkupFn = (ctx as { editMessageReplyMarkup?: unknown })
          .editMessageReplyMarkup;
        if (typeof editReplyMarkupFn === "function") {
          return await ctx.editMessageReplyMarkup(replyMarkup);
        }
        return await bot.api.editMessageReplyMarkup(
          callbackMessage.chat.id,
          callbackMessage.message_id,
          replyMarkup,
        );
      };
      const deleteCallbackMessage = async () => {
        const deleteFn = (ctx as { deleteMessage?: unknown }).deleteMessage;
        if (typeof deleteFn === "function") {
          return await ctx.deleteMessage();
        }
        return await bot.api.deleteMessage(callbackMessage.chat.id, callbackMessage.message_id);
      };
      const replyToCallbackChat = async (
        text: string,
        params?: Parameters<typeof bot.api.sendMessage>[2],
      ) => {
        const replyFn = (ctx as { reply?: unknown }).reply;
        if (typeof replyFn === "function") {
          return await ctx.reply(text, params);
        }
        return await bot.api.sendMessage(callbackMessage.chat.id, text, params);
      };

      const chatId = callbackMessage.chat.id;
      const isGroup =
        callbackMessage.chat.type === "group" || callbackMessage.chat.type === "supergroup";
      const approvalCallback = parseExecApprovalCommandText(data);
      const isApprovalCallback = approvalCallback !== null;
      const inlineButtonsScope = resolveTelegramInlineButtonsScope({
        cfg,
        accountId,
      });
      const execApprovalButtonsEnabled =
        isApprovalCallback &&
        shouldEnableTelegramExecApprovalButtons({
          cfg,
          accountId,
          to: String(chatId),
        });
      if (!execApprovalButtonsEnabled) {
        if (inlineButtonsScope === "off") {
          return;
        }
        if (inlineButtonsScope === "dm" && isGroup) {
          return;
        }
        if (inlineButtonsScope === "group" && !isGroup) {
          return;
        }
      }

      const messageThreadId = callbackMessage.message_thread_id;
      const isForum = await resolveTelegramForumFlag({
        chatId,
        chatType: callbackMessage.chat.type,
        isGroup,
        isForum: callbackMessage.chat.is_forum,
        getChat,
      });
      const eventAuthContext = await resolveTelegramEventAuthorizationContext({
        chatId,
        isGroup,
        isForum,
        messageThreadId,
      });
      const { resolvedThreadId, dmThreadId, storeAllowFrom, groupConfig } = eventAuthContext;
      const requireTopic = (groupConfig as { requireTopic?: boolean } | undefined)?.requireTopic;
      if (!isGroup && requireTopic === true && dmThreadId == null) {
        logVerbose(
          `Blocked telegram callback in DM ${chatId}: requireTopic=true but no topic present`,
        );
        return;
      }
      const senderId = callback.from?.id ? String(callback.from.id) : "";
      const senderUsername = callback.from?.username ?? "";
      const authorizationMode: TelegramEventAuthorizationMode =
        !isGroup || (!execApprovalButtonsEnabled && inlineButtonsScope === "allowlist")
          ? "callback-allowlist"
          : "callback-scope";
      const senderAuthorization = authorizeTelegramEventSender({
        chatId,
        chatTitle: callbackMessage.chat.title,
        isGroup,
        senderId,
        senderUsername,
        mode: authorizationMode,
        context: eventAuthContext,
      });
      if (!senderAuthorization.allowed) {
        return;
      }

      const callbackThreadId = resolvedThreadId ?? dmThreadId;
      const callbackConversationId =
        callbackThreadId != null ? `${chatId}:topic:${callbackThreadId}` : String(chatId);
      const pluginBindingApproval = parsePluginBindingApprovalCustomId(data);
      if (pluginBindingApproval) {
        let resolved: Awaited<ReturnType<typeof resolvePluginConversationBindingApproval>>;
        try {
          resolved = await resolvePluginConversationBindingApproval({
            approvalId: pluginBindingApproval.approvalId,
            decision: pluginBindingApproval.decision,
            senderId: senderId || undefined,
          });
        } catch (err) {
          throw new TelegramRetryableCallbackError(err);
        }
        await clearCallbackButtons();
        await replyToCallbackChat(buildPluginBindingResolvedText(resolved));
        return;
      }
      const pluginCallback = await dispatchTelegramPluginInteractiveHandler({
        data,
        callbackId: callback.id,
        ctx: {
          accountId,
          callbackId: callback.id,
          conversationId: callbackConversationId,
          parentConversationId: callbackThreadId != null ? String(chatId) : undefined,
          senderId: senderId || undefined,
          senderUsername: senderUsername || undefined,
          threadId: callbackThreadId,
          isGroup,
          isForum,
          auth: {
            isAuthorizedSender: true,
          },
          callbackMessage: {
            messageId: callbackMessage.message_id,
            chatId: String(chatId),
            messageText: callbackMessage.text ?? callbackMessage.caption,
          },
        },
        respond: {
          reply: async ({ text, buttons }) => {
            await replyToCallbackChat(
              text,
              buttons ? { reply_markup: buildInlineKeyboard(buttons) } : undefined,
            );
          },
          editMessage: async ({ text, buttons }) => {
            await editCallbackMessage(
              text,
              buttons ? { reply_markup: buildInlineKeyboard(buttons) } : undefined,
            );
          },
          editButtons: async ({ buttons }) => {
            await editCallbackButtons(buttons);
          },
          clearButtons: async () => {
            await clearCallbackButtons();
          },
          deleteMessage: async () => {
            await deleteCallbackMessage();
          },
        },
      });
      if (pluginCallback.handled) {
        return;
      }

      const runtimeCfg = telegramDeps.getRuntimeConfig();
      if (approvalCallback) {
        const isPluginApproval = approvalCallback.approvalId.startsWith("plugin:");
        const pluginApprovalAuthorizedSender = isTelegramExecApprovalApprover({
          cfg: runtimeCfg,
          accountId,
          senderId,
        });
        const execApprovalAuthorizedSender = isTelegramExecApprovalAuthorizedSender({
          cfg: runtimeCfg,
          accountId,
          senderId,
        });
        const authorizedApprovalSender = isPluginApproval
          ? pluginApprovalAuthorizedSender
          : execApprovalAuthorizedSender || pluginApprovalAuthorizedSender;
        if (!authorizedApprovalSender) {
          logVerbose(
            `Blocked telegram approval callback from ${senderId || "unknown"} (not authorized)`,
          );
          return;
        }
        try {
          // Resolve approval callbacks directly so Telegram approvers are not forced through
          // the generic chat-command authorization path.
          await (telegramDeps.resolveExecApproval ?? resolveTelegramExecApproval)({
            cfg: runtimeCfg,
            approvalId: approvalCallback.approvalId,
            decision: approvalCallback.decision,
            senderId,
            allowPluginFallback: pluginApprovalAuthorizedSender,
          });
        } catch (resolveErr) {
          const errStr = String(resolveErr);
          logVerbose(
            `telegram: failed to resolve approval callback ${approvalCallback.approvalId}: ${errStr}`,
          );
          throw new TelegramRetryableCallbackError(resolveErr);
        }
        try {
          await clearCallbackButtons();
        } catch (editErr) {
          const errStr = String(editErr);
          if (
            errStr.includes("message is not modified") ||
            errStr.includes("there is no text in the message to edit")
          ) {
            return;
          }
          logVerbose(`telegram: failed to clear approval callback buttons: ${errStr}`);
        }
        return;
      }

      const paginationMatch = data.match(/^commands_page_(\d+|noop)(?::(.+))?$/);
      if (paginationMatch) {
        const pageValue = paginationMatch[1];
        if (pageValue === "noop") {
          return;
        }

        const page = Number.parseInt(pageValue, 10);
        if (Number.isNaN(page) || page < 1) {
          return;
        }

        const agentId = paginationMatch[2]?.trim() || resolveDefaultAgentId(runtimeCfg);
        let result: ReturnType<typeof buildCommandsMessagePaginated>;
        try {
          const skillCommands = telegramDeps.listSkillCommandsForAgents({
            cfg: runtimeCfg,
            agentIds: [agentId],
          });
          result = buildCommandsMessagePaginated(runtimeCfg, skillCommands, {
            page,
            forcePaginatedList: true,
            surface: "telegram",
          });
        } catch (err) {
          throw new TelegramRetryableCallbackError(err);
        }

        const keyboard =
          result.totalPages > 1
            ? buildInlineKeyboard(
                buildCommandsPaginationKeyboard(result.currentPage, result.totalPages, agentId),
              )
            : undefined;

        try {
          await editCallbackMessage(result.text, keyboard ? { reply_markup: keyboard } : undefined);
        } catch (editErr) {
          const errStr = String(editErr);
          if (!errStr.includes("message is not modified")) {
            throw new TelegramRetryableCallbackError(editErr);
          }
        }
        return;
      }

      // Model selection callback handler (mdl_prov, mdl_list_*, mdl_sel_*, mdl_back)
      const modelCallback = parseModelCallbackData(data);
      if (modelCallback) {
        if (
          !isTelegramModelCallbackAuthorized({
            chatId,
            isGroup,
            senderId,
            senderUsername,
            context: eventAuthContext,
            cfg: runtimeCfg,
          })
        ) {
          logVerbose(
            `Blocked telegram model callback from ${senderId || "unknown"} (not authorized for /models)`,
          );
          return;
        }
        let sessionState: ReturnType<typeof resolveTelegramSessionState>;
        let modelData: Awaited<ReturnType<typeof telegramDeps.buildModelsProviderData>>;
        try {
          // Retry only the callback preflight that happens before any visible chat mutation.
          sessionState = resolveTelegramSessionState({
            chatId,
            isGroup,
            isForum,
            messageThreadId,
            resolvedThreadId,
            senderId,
          });
          modelData = await telegramDeps.buildModelsProviderData(runtimeCfg, sessionState.agentId);
        } catch (err) {
          throw new TelegramRetryableCallbackError(err);
        }
        const { byProvider, providers, modelNames } = modelData;

        const editMessageWithButtons = async (
          text: string,
          buttons: ReturnType<typeof buildProviderKeyboard>,
          extra?: { parse_mode?: "HTML" | "Markdown" | "MarkdownV2" },
        ) => {
          const keyboard = buildInlineKeyboard(buttons);
          const editParams = keyboard ? { reply_markup: keyboard, ...extra } : extra;
          try {
            await editCallbackMessage(text, editParams);
          } catch (editErr) {
            const errStr = String(editErr);
            if (errStr.includes("no text in the message")) {
              try {
                await deleteCallbackMessage();
              } catch {}
              await replyToCallbackChat(
                text,
                keyboard ? { reply_markup: keyboard, ...extra } : extra,
              );
            } else if (!errStr.includes("message is not modified")) {
              throw editErr;
            }
          }
        };

        if (modelCallback.type === "providers" || modelCallback.type === "back") {
          if (providers.length === 0) {
            try {
              await editMessageWithButtons("No providers available.", []);
            } catch (err) {
              throw new TelegramRetryableCallbackError(err);
            }
            return;
          }
          const providerInfos: ProviderInfo[] = providers.map((p) => ({
            id: p,
            count: byProvider.get(p)?.size ?? 0,
          }));
          const buttons = buildTelegramModelsMenuButtons({ providers: providerInfos });
          try {
            await editMessageWithButtons("Select a provider:", buttons);
          } catch (err) {
            throw new TelegramRetryableCallbackError(err);
          }
          return;
        }

        if (modelCallback.type === "list") {
          const { provider, page } = modelCallback;
          const modelSet = byProvider.get(provider);
          if (!modelSet || modelSet.size === 0) {
            // Provider not found or no models - show providers list
            const providerInfos: ProviderInfo[] = providers.map((p) => ({
              id: p,
              count: byProvider.get(p)?.size ?? 0,
            }));
            const buttons = buildTelegramModelsMenuButtons({ providers: providerInfos });
            try {
              await editMessageWithButtons(
                `Unknown provider: ${provider}\n\nSelect a provider:`,
                buttons,
              );
            } catch (err) {
              throw new TelegramRetryableCallbackError(err);
            }
            return;
          }
          const models = [...modelSet].toSorted((left, right) => left.localeCompare(right));
          const pageSize = getModelsPageSize();
          const totalPages = calculateTotalPages(models.length, pageSize);
          const safePage = Math.max(1, Math.min(page, totalPages));

          // Resolve current model from session (prefer overrides)
          const currentModel = sessionState.model;

          const buttons = buildModelsKeyboard({
            provider,
            models,
            currentModel,
            currentPage: safePage,
            totalPages,
            pageSize,
            modelNames,
          });
          const text = formatModelsAvailableHeader({
            provider,
            total: models.length,
            cfg,
            agentDir: resolveAgentDir(cfg, sessionState.agentId),
            sessionEntry: sessionState.sessionEntry,
          });
          try {
            await editMessageWithButtons(text, buttons);
          } catch (err) {
            throw new TelegramRetryableCallbackError(err);
          }
          return;
        }

        if (modelCallback.type === "select") {
          const selection = resolveModelSelection({
            callback: modelCallback,
            providers,
            byProvider,
          });
          if (selection.kind !== "resolved") {
            const providerInfos: ProviderInfo[] = providers.map((p) => ({
              id: p,
              count: byProvider.get(p)?.size ?? 0,
            }));
            const buttons = buildTelegramModelsMenuButtons({ providers: providerInfos });
            try {
              await editMessageWithButtons(
                `Could not resolve model "${selection.model}".\n\nSelect a provider:`,
                buttons,
              );
            } catch (err) {
              throw new TelegramRetryableCallbackError(err);
            }
            return;
          }

          const modelSet = byProvider.get(selection.provider);
          if (!modelSet?.has(selection.model)) {
            try {
              await editMessageWithButtons(
                `❌ Model "${selection.provider}/${selection.model}" is not allowed.`,
                [],
              );
            } catch (err) {
              throw new TelegramRetryableCallbackError(err);
            }
            return;
          }

          // Directly set model override in session
          try {
            // Use the fresh runtimeCfg (loaded at callback entry) so store path
            // and default-model resolution stay consistent with the next
            // inbound message.  The outer `cfg` is a snapshot captured at
            // handler-registration time and becomes stale after config reloads,
            // which can cause the override to be written to the wrong store or
            // incorrectly treated as the default model (clearing the override).
            const storePath = telegramDeps.resolveStorePath(runtimeCfg.session?.store, {
              agentId: sessionState.agentId,
            });

            const resolvedDefault = resolveDefaultModelForAgent({
              cfg: runtimeCfg,
              agentId: sessionState.agentId,
            });
            const isDefaultSelection =
              selection.provider === resolvedDefault.provider &&
              selection.model === resolvedDefault.model;

            try {
              await updateSessionStore(storePath, (store) => {
                const sessionKey = sessionState.sessionKey;
                const entry = store[sessionKey] ?? {};
                store[sessionKey] = entry;
                applyModelOverrideToSessionEntry({
                  entry,
                  selection: {
                    provider: selection.provider,
                    model: selection.model,
                    isDefault: isDefaultSelection,
                  },
                });
              });
            } catch (err) {
              throw new TelegramRetryableCallbackError(err);
            }

            // Update message to show success with visual feedback
            const escapeHtml = (text: string) =>
              text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            const actionText = isDefaultSelection
              ? "reset to default"
              : `changed to <b>${escapeHtml(selection.provider)}/${escapeHtml(selection.model)}</b>`;
            await editMessageWithButtons(
              `✅ Model ${actionText}\n\nThis model will be used for your next message.`,
              [], // Empty buttons = remove inline keyboard
              { parse_mode: "HTML" },
            );
          } catch (err) {
            if (err instanceof TelegramRetryableCallbackError) {
              throw err;
            }
            await editMessageWithButtons(`❌ Failed to change model: ${String(err)}`, []);
          }
          return;
        }

        return;
      }

      const nativeCallbackCommand = parseTelegramNativeCommandCallbackData(data);
      const syntheticMessage = buildSyntheticTextMessage({
        base: withResolvedTelegramForumFlag(callbackMessage, isForum),
        from: callback.from,
        text: nativeCallbackCommand ?? data,
      });
      await processMessage(buildSyntheticContext(ctx, syntheticMessage), [], storeAllowFrom, {
        ...(nativeCallbackCommand ? { commandSource: "native" as const } : {}),
        forceWasMentioned: true,
        messageIdOverride: callback.id,
      });
    } catch (err) {
      if (err instanceof TelegramRetryableCallbackError) {
        if (isPermanentTelegramCallbackEditError(err.cause)) {
          logVerbose(`telegram: swallowing permanent callback edit error: ${String(err.cause)}`);
          return;
        }
        runtime.error?.(danger(`callback handler failed: ${String(err)}`));
        throw err.cause;
      }
      runtime.error?.(danger(`callback handler failed: ${String(err)}`));
    }
  });

  // Handle group migration to supergroup (chat ID changes)
  bot.on("message:migrate_to_chat_id", async (ctx) => {
    try {
      const msg = ctx.message;
      if (!msg?.migrate_to_chat_id) {
        return;
      }
      if (shouldSkipUpdate(ctx)) {
        return;
      }

      const oldChatId = String(msg.chat.id);
      const newChatId = String(msg.migrate_to_chat_id);
      const chatTitle = msg.chat.title ?? "Unknown";

      runtime.log?.(warn(`[telegram] Group migrated: "${chatTitle}" ${oldChatId} → ${newChatId}`));

      if (!resolveChannelConfigWrites({ cfg, channelId: "telegram", accountId })) {
        runtime.log?.(warn("[telegram] Config writes disabled; skipping group config migration."));
        return;
      }

      // Check if old chat ID has config and migrate it
      const currentConfig = telegramDeps.getRuntimeConfig();
      const migration = migrateTelegramGroupConfig({
        cfg: currentConfig,
        accountId,
        oldChatId,
        newChatId,
      });

      if (migration.migrated) {
        runtime.log?.(warn(`[telegram] Migrating group config from ${oldChatId} to ${newChatId}`));
        migrateTelegramGroupConfig({ cfg, accountId, oldChatId, newChatId });
        await replaceConfigFile({
          nextConfig: currentConfig,
          afterWrite: { mode: "auto" },
        });
        runtime.log?.(warn(`[telegram] Group config migrated and saved successfully`));
      } else if (migration.skippedExisting) {
        runtime.log?.(
          warn(
            `[telegram] Group config already exists for ${newChatId}; leaving ${oldChatId} unchanged`,
          ),
        );
      } else {
        runtime.log?.(
          warn(`[telegram] No config found for old group ID ${oldChatId}, migration logged only`),
        );
      }
    } catch (err) {
      runtime.error?.(danger(`[telegram] Group migration handler failed: ${String(err)}`));
      throw err;
    }
  });

  type InboundTelegramEvent = {
    ctxForDedupe: TelegramUpdateKeyContext;
    ctx: TelegramContext;
    msg: Message;
    chatId: number;
    isGroup: boolean;
    isForum: boolean;
    messageThreadId?: number;
    senderId: string;
    senderUsername: string;
    requireConfiguredGroup: boolean;
    sendOversizeWarning: boolean;
    oversizeLogMessage: string;
    errorMessage: string;
  };

  const handleInboundMessageLike = async (event: InboundTelegramEvent) => {
    try {
      if (shouldSkipUpdate(event.ctxForDedupe)) {
        return;
      }
      const eventAuthContext = await resolveTelegramEventAuthorizationContext({
        chatId: event.chatId,
        isGroup: event.isGroup,
        isForum: event.isForum,
        messageThreadId: event.messageThreadId,
      });
      const {
        dmPolicy,
        resolvedThreadId,
        dmThreadId,
        storeAllowFrom,
        groupConfig,
        topicConfig,
        groupAllowOverride,
        effectiveGroupAllow,
        hasGroupAllowOverride,
      } = eventAuthContext;
      // For DMs, prefer per-DM/topic allowFrom (groupAllowOverride) over account-level allowFrom
      const dmAllowFrom = groupAllowOverride ?? allowFrom;
      const effectiveDmAllow = normalizeDmAllowFromWithStore({
        allowFrom: dmAllowFrom,
        storeAllowFrom,
        dmPolicy,
      });

      if (event.requireConfiguredGroup && (!groupConfig || groupConfig.enabled === false)) {
        logVerbose(`Blocked telegram channel ${event.chatId} (channel disabled)`);
        return;
      }

      if (
        shouldSkipGroupMessage({
          isGroup: event.isGroup,
          chatId: event.chatId,
          chatTitle: event.msg.chat.title,
          resolvedThreadId,
          senderId: event.senderId,
          senderUsername: event.senderUsername,
          effectiveGroupAllow,
          hasGroupAllowOverride,
          groupConfig,
          topicConfig,
        })
      ) {
        return;
      }

      if (!event.isGroup && (hasInboundMedia(event.msg) || hasReplyTargetMedia(event.msg))) {
        const dmAuthorized = await enforceTelegramDmAccess({
          isGroup: event.isGroup,
          dmPolicy,
          msg: event.msg,
          chatId: event.chatId,
          effectiveDmAllow,
          accountId,
          bot,
          logger,
          upsertPairingRequest: telegramDeps.upsertChannelPairingRequest,
        });
        if (!dmAuthorized) {
          return;
        }
      }

      await processInboundMessage({
        ctx: event.ctx,
        msg: event.msg,
        chatId: event.chatId,
        resolvedThreadId,
        dmThreadId,
        storeAllowFrom,
        sendOversizeWarning: event.sendOversizeWarning,
        oversizeLogMessage: event.oversizeLogMessage,
      });
    } catch (err) {
      runtime.error?.(danger(`${event.errorMessage}: ${String(err)}`));
    }
  };

  bot.on("message", async (ctx) => {
    const msg = ctx.message;
    if (!msg) {
      return;
    }
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
    const isForum = await resolveTelegramForumFlag({
      chatId: msg.chat.id,
      chatType: msg.chat.type,
      isGroup,
      isForum: msg.chat.is_forum,
      getChat,
    });
    const normalizedMsg = withResolvedTelegramForumFlag(msg, isForum);
    // Bot-authored message updates can be echoed back by Telegram. Skip them here
    // and rely on the dedicated channel_post handler for channel-originated posts.
    if (normalizedMsg.from?.id != null && normalizedMsg.from.id === ctx.me?.id) {
      return;
    }
    await handleInboundMessageLike({
      ctxForDedupe: ctx,
      ctx: buildSyntheticContext(ctx, normalizedMsg),
      msg: normalizedMsg,
      chatId: normalizedMsg.chat.id,
      isGroup,
      isForum,
      messageThreadId: normalizedMsg.message_thread_id,
      senderId: normalizedMsg.from?.id != null ? String(normalizedMsg.from.id) : "",
      senderUsername: normalizedMsg.from?.username ?? "",
      requireConfiguredGroup: false,
      sendOversizeWarning: true,
      oversizeLogMessage: "media exceeds size limit",
      errorMessage: "handler failed",
    });
  });

  // Handle channel posts — enables bot-to-bot communication via Telegram channels.
  // Telegram bots cannot see other bot messages in groups, but CAN in channels.
  // This handler normalizes channel_post updates into the standard message pipeline.
  bot.on("channel_post", async (ctx) => {
    const post = ctx.channelPost;
    if (!post) {
      return;
    }

    const chatId = post.chat.id;
    const syntheticFrom = post.sender_chat
      ? {
          id: post.sender_chat.id,
          is_bot: true as const,
          first_name: post.sender_chat.title || "Channel",
          username: post.sender_chat.username,
        }
      : {
          id: chatId,
          is_bot: true as const,
          first_name: post.chat.title || "Channel",
          username: post.chat.username,
        };
    const syntheticMsg: Message = {
      ...post,
      from: post.from ?? syntheticFrom,
      chat: {
        ...post.chat,
        type: "supergroup" as const,
      },
    } as Message;

    await handleInboundMessageLike({
      ctxForDedupe: ctx,
      ctx: buildSyntheticContext(ctx, syntheticMsg),
      msg: syntheticMsg,
      chatId,
      isGroup: true,
      isForum: false,
      senderId:
        post.sender_chat?.id != null
          ? String(post.sender_chat.id)
          : post.from?.id != null
            ? String(post.from.id)
            : "",
      senderUsername: post.sender_chat?.username ?? post.from?.username ?? "",
      requireConfiguredGroup: true,
      sendOversizeWarning: false,
      oversizeLogMessage: "channel post media exceeds size limit",
      errorMessage: "channel_post handler failed",
    });
  });
};
