// Telegram plugin module implements bot handlers behavior.
import { randomUUID } from "node:crypto";
import type { Message, ReactionTypeEmoji } from "grammy/types";
import { parseExecApprovalCommandText } from "openclaw/plugin-sdk/approval-reply-runtime";
import { resolveChannelConfigWrites } from "openclaw/plugin-sdk/channel-config-helpers";
import {
  buildMentionRegexes,
  implicitMentionKindWhen,
  matchesMentionWithExplicit,
  resolveInboundMentionDecision,
  shouldDebounceTextInbound,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "openclaw/plugin-sdk/channel-inbound-debounce";
import { resolveStoredModelOverride } from "openclaw/plugin-sdk/command-auth-native";
import { hasControlCommand } from "openclaw/plugin-sdk/command-detection";
import { isAbortRequestText } from "openclaw/plugin-sdk/command-primitives-runtime";
import { buildCommandsMessagePaginated } from "openclaw/plugin-sdk/command-status";
import type {
  DmPolicy,
  OpenClawConfig,
  TelegramAccountConfig,
} from "openclaw/plugin-sdk/config-contracts";
import type {
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { mutateConfigFile } from "openclaw/plugin-sdk/config-mutation";
import { resolveChannelContextVisibilityMode } from "openclaw/plugin-sdk/context-visibility-runtime";
import {
  buildPluginBindingResolvedText,
  parsePluginBindingApprovalCustomId,
  resolvePluginConversationBindingApproval,
} from "openclaw/plugin-sdk/conversation-runtime";
import { isApprovalNotFoundError } from "openclaw/plugin-sdk/error-runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { applyModelOverrideToSessionEntry } from "openclaw/plugin-sdk/model-session-runtime";
import { formatModelsAvailableHeader } from "openclaw/plugin-sdk/models-provider-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { DEFAULT_GROUP_HISTORY_LIMIT } from "openclaw/plugin-sdk/reply-history";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import { danger, logVerbose, sleepWithAbort, warn } from "openclaw/plugin-sdk/runtime-env";
import { evaluateSupplementalContextVisibility } from "openclaw/plugin-sdk/security-runtime";
import {
  getSessionEntry,
  listSessionEntries,
  patchSessionEntry,
  readAmbientTranscriptWatermark,
  resolveAmbientTranscriptWatermarkKey,
} from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { stripInlineDirectiveTagsForDelivery } from "openclaw/plugin-sdk/text-chunking";
import { expandTelegramAllowFromWithAccessGroups } from "./access-groups.js";
import { resolveTelegramAccount, resolveTelegramMediaRuntimeOptions } from "./accounts.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import {
  normalizeDmAllowFromWithStore,
  firstDefined,
  isSenderAllowed,
  normalizeAllowFrom,
  resolveTelegramEffectiveDmPolicy,
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
  isDurablyRetryableInboundMediaError,
  isMediaSizeLimitError,
  isRecoverableMediaGroupError,
  resolveInboundMediaFileId,
  TelegramBotApiFileTooLargeError,
} from "./bot-handlers.media.js";
import type { TelegramMediaRef } from "./bot-message-context.js";
import type {
  TelegramMessageContextOptions,
  TelegramPromptContextEntry,
} from "./bot-message-context.types.js";
import type { TelegramAmbientTranscriptWatermark } from "./bot-message-context.types.js";
import { resolveTelegramMessageTurnSettings } from "./bot-message.js";
import { parseTelegramNativeCommandCallbackData } from "./bot-native-commands.js";
import type { RegisterTelegramHandlerParams } from "./bot-native-commands.js";
import {
  createTelegramSpooledReplayParticipant,
  createTelegramSpooledReplayDeferredParticipant,
  getTelegramSpooledReplayDeferredParticipant,
  isTelegramSpooledReplayUpdate,
  recordTelegramMessageProcessingResult,
  type TelegramMessageProcessingResult,
  type TelegramSpooledReplayDeferredParticipant,
  type TelegramSpooledReplaySettlementHold,
} from "./bot-processing-outcome.js";
import {
  MEDIA_GROUP_TIMEOUT_MS,
  type MediaGroupEntry,
  type TelegramUpdateKeyContext,
} from "./bot-updates.js";
import { resolveMedia } from "./bot/delivery.resolve-media.js";
import {
  buildSenderName,
  getTelegramTextParts,
  hasBotMention,
  buildTelegramThreadParams,
  buildTelegramGroupPeerId,
  buildTelegramParentPeer,
  isTelegramCommandsAllowFromConfigured,
  resolveTelegramCommandAuthorization,
  resolveTelegramForumFlag,
  resolveTelegramForumThreadId,
  resolveTelegramGroupAllowFromContext,
  resolveTelegramThreadSpec,
  resolveTelegramBotHasTopicsEnabled,
  resolveTelegramMediaPlaceholder,
  TelegramPairingStoreReadError,
  shouldUseTelegramDmThreadSession,
  withResolvedTelegramForumFlag,
} from "./bot/helpers.js";
import type { TelegramContext, TelegramGetChat } from "./bot/types.js";
import { getTelegramCallbackQueryAnswerPromise } from "./callback-query-answer-state.js";
import { buildCommandsPaginationKeyboard, buildTelegramModelsMenuButtons } from "./command-ui.js";
import {
  resolveTelegramConversationBaseSessionKey,
  resolveTelegramConversationRoute,
} from "./conversation-route.js";
import { enforceTelegramDmAccess, isTelegramDmAccessAllowed } from "./dm-access.js";
import { resolveTelegramExecApproval } from "./exec-approval-resolver.js";
import {
  isTelegramExecApprovalApprover,
  isTelegramExecApprovalAuthorizedSender,
  shouldEnableTelegramExecApprovalButtons,
} from "./exec-approvals.js";
import { isTelegramForumServiceMessage } from "./forum-service-message.js";
import {
  evaluateTelegramGroupBaseAccess,
  evaluateTelegramGroupPolicyAccess,
} from "./group-access.js";
import { resolveTelegramScopedGroupConfig } from "./group-config-helpers.js";
import {
  buildTelegramSelfSenderName,
  isTelegramHistoryEntryAfterAmbientWatermark,
  isTelegramSelfSenderName,
} from "./group-history-window.js";
import { migrateTelegramGroupConfig } from "./group-migration.js";
import {
  resolveTelegramCommandIngressAuthorization,
  resolveTelegramEventIngressAuthorization,
} from "./ingress.js";
import { resolveTelegramInlineButtonsScope } from "./inline-buttons.js";
import { dispatchTelegramPluginInteractiveHandler } from "./interactive-dispatch.js";
import {
  buildTelegramConversationContext,
  buildTelegramReplyChain,
  createTelegramMessageCache,
  isTelegramSessionBoundaryCommandText,
  resolveTelegramMessageCacheScope,
  type TelegramCachedMessageNode,
  type TelegramReplyChainEntry,
} from "./message-cache.js";
import {
  claimTelegramMessageDispatchReplay,
  commitTelegramMessageDispatchReplay,
  createTelegramMessageDispatchReplayGuard,
  releaseTelegramMessageDispatchReplay,
} from "./message-dispatch-dedupe.js";
import {
  buildModelsKeyboard,
  buildProviderKeyboard,
  calculateTotalPages,
  getModelsPageSize,
  parseModelCallbackData,
  resolveModelSelection,
  type ProviderInfo,
} from "./model-buttons.js";
import { parseTelegramOpaqueCallbackData } from "./native-command-callback-data.js";
import {
  isTelegramEditTargetMissingError,
  isTelegramMessageHasNoTextError,
} from "./network-errors.js";
import { resolveTelegramPromptMediaPath } from "./prompt-media-path.js";
import { buildInlineKeyboard } from "./send.js";
import { buildTelegramSessionTranscriptPromptMessages } from "./session-transcript-context.js";

type TelegramPromptContextMessageForDedupe = {
  body?: unknown;
  timestamp_ms?: unknown;
};

function resolvePromptContextTextDedupeKey(
  message: TelegramPromptContextMessageForDedupe,
): string | undefined {
  if (typeof message.body !== "string") {
    return undefined;
  }
  const visibleBody = stripInlineDirectiveTagsForDelivery(message.body).text.trim();
  if (!visibleBody) {
    return undefined;
  }
  if (typeof message.timestamp_ms !== "number" || !Number.isFinite(message.timestamp_ms)) {
    return undefined;
  }
  return `${message.timestamp_ms}:${visibleBody}`;
}

export const registerTelegramHandlers = ({
  cfg,
  accountId,
  bot,
  opts,
  telegramTransport,
  runtime,
  mediaMaxBytes,
  telegramCfg,
  resolveGroupPolicy,
  resolveTelegramGroupConfig,
  shouldSkipUpdate,
  processMessage,
  logger,
  telegramDeps,
  resolveGroupActivation,
  resolveGroupRequireMention,
}: RegisterTelegramHandlerParams) => {
  const mediaRuntimeOptions = resolveTelegramMediaRuntimeOptions({
    cfg,
    accountId,
    token: opts.token,
    transport: telegramTransport,
  });
  const mediaAbortSignal =
    opts.mediaAbortSignal && opts.fetchAbortSignal
      ? AbortSignal.any([opts.mediaAbortSignal, opts.fetchAbortSignal])
      : (opts.mediaAbortSignal ?? opts.fetchAbortSignal);
  const mediaRuntimeWithAbort = {
    ...mediaRuntimeOptions,
    abortSignal: mediaAbortSignal,
  };
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
      : typeof telegramCfg.mediaGroupFlushMs === "number" &&
          Number.isFinite(telegramCfg.mediaGroupFlushMs)
        ? Math.max(10, Math.floor(telegramCfg.mediaGroupFlushMs))
        : MEDIA_GROUP_TIMEOUT_MS;

  type BufferedMediaGroupEntry = MediaGroupEntry & {
    // Album mention preflight must use the same policy snapshot that admitted its first item.
    authorizationCfg: OpenClawConfig;
    storeAllowFrom: string[];
    isGroup: boolean;
    isForum: boolean;
    resolvedThreadId?: number;
    dmThreadId?: number;
    senderId: string;
    effectiveGroupAllow: NormalizedAllowFrom;
    effectiveDmAllow: NormalizedAllowFrom;
    groupConfig?: TelegramGroupConfig;
    topicConfig?: TelegramTopicConfig;
    dispatchDedupeKeys: string[];
    spooledReplayParticipants: TelegramSpooledReplayDeferredParticipant[];
  };
  type PromptContextMessageSelection = ReadonlyMap<string, "include" | "exclude">;

  const mediaGroupBuffer = new Map<string, BufferedMediaGroupEntry>();
  const mediaGroupProcessingQueue = new KeyedAsyncQueue();
  const messageCache = createTelegramMessageCache({
    scope: resolveTelegramMessageCacheScope(telegramDeps.resolveStorePath(cfg.session?.store)),
  });
  const resolvePromptSender = (
    node: TelegramCachedMessageNode,
    ctx: TelegramContext,
  ): string | undefined => {
    const botInfo = ctx.me ?? opts.botInfo;
    // Business replies keep the account user in `from`; Telegram authenticates the bot separately.
    const isAuthenticatedSelf =
      botInfo?.id != null &&
      (node.senderId === String(botInfo.id) ||
        node.sourceMessage.sender_business_bot?.id === botInfo.id);
    if (isAuthenticatedSelf) {
      return buildTelegramSelfSenderName(telegramCfg.name, botInfo);
    }
    if (node.senderId === "0" && node.sourceMessage.from?.is_bot === true) {
      return node.sender;
    }
    // Config reloads restart this handler; `(you)` stays reserved for authenticated bot ids.
    return isTelegramSelfSenderName(node.sender) ? `${node.sender} (Telegram sender)` : node.sender;
  };
  const messageDispatchReplayGuard = createTelegramMessageDispatchReplayGuard({
    onDiskError: (error) => {
      runtime.error?.(danger(`[telegram] message dispatch dedupe store failed: ${String(error)}`));
    },
  });

  type TextFragmentEntry = {
    key: string;
    storeAllowFrom: string[];
    threadId?: number;
    messages: Array<{ msg: Message; ctx: TelegramContext; receivedAtMs: number }>;
    promptContextMinTimestampMs?: number;
    promptContextAmbientWatermark?: TelegramAmbientTranscriptWatermark;
    dispatchDedupeKeys: string[];
    spooledReplayParticipants: TelegramSpooledReplayDeferredParticipant[];
    timer: ReturnType<typeof setTimeout>;
  };
  const textFragmentBuffer = new Map<string, TextFragmentEntry>();
  const textFragmentProcessingQueue = new KeyedAsyncQueue();

  const queueBufferedProcessing = async (
    queue: KeyedAsyncQueue,
    key: string,
    task: () => Promise<void>,
  ) => {
    await queue.enqueue(key, async () => {
      await task().catch(() => undefined);
    });
  };

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
    threadId?: number;
    promptContextMinTimestampMs?: number;
    promptContextAmbientWatermark?: TelegramAmbientTranscriptWatermark;
    dispatchDedupeKeys: string[];
    spooledReplayParticipant?: TelegramSpooledReplayDeferredParticipant;
  };
  const resolveTelegramDebounceEntryMs = (entry: TelegramDebounceEntry): number =>
    entry.debounceLane === "forward" ? FORWARD_BURST_DEBOUNCE_MS : debounceMs;
  const shouldDebounceTelegramEntry = (entry: TelegramDebounceEntry): boolean => {
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
  };
  const normalizePromptContextMinTimestampMs = (timestampMs?: number) =>
    typeof timestampMs === "number" && Number.isFinite(timestampMs) ? timestampMs : undefined;
  const promptContextBoundaryOptions = (
    timestampMs?: number,
    ambientWatermark?: TelegramAmbientTranscriptWatermark,
  ): Pick<
    TelegramMessageContextOptions,
    "promptContextMinTimestampMs" | "promptContextAmbientWatermark"
  > => {
    const promptContextMinTimestampMs = normalizePromptContextMinTimestampMs(timestampMs);
    return {
      ...(promptContextMinTimestampMs === undefined ? {} : { promptContextMinTimestampMs }),
      ...(ambientWatermark === undefined
        ? {}
        : { promptContextAmbientWatermark: ambientWatermark }),
    };
  };
  const latestPromptContextMinTimestampMs = (
    ...timestamps: Array<number | undefined>
  ): number | undefined => {
    let latest: number | undefined;
    for (const timestampMs of timestamps) {
      const normalized = normalizePromptContextMinTimestampMs(timestampMs);
      if (normalized === undefined) {
        continue;
      }
      latest = latest === undefined ? normalized : Math.max(latest, normalized);
    }
    return latest;
  };
  const latestPromptContextAmbientWatermark = (
    ...watermarks: Array<TelegramAmbientTranscriptWatermark | undefined>
  ): TelegramAmbientTranscriptWatermark | undefined => {
    return watermarks.findLast((watermark) => watermark !== undefined);
  };
  const mergeDispatchDedupeKeys = (...groups: Array<readonly string[] | undefined>) => [
    ...new Set(normalizeStringEntries(groups.flatMap((group) => group ?? []))),
  ];
  const releaseDispatchDedupeKeys = (keys: readonly string[], error?: unknown) => {
    releaseTelegramMessageDispatchReplay({
      guard: messageDispatchReplayGuard,
      keys,
      error,
    });
  };
  const commitDispatchDedupeKeys = async (
    keys: readonly string[],
    options: { requirePersistent?: boolean } = {},
  ) => {
    await commitTelegramMessageDispatchReplay({
      guard: messageDispatchReplayGuard,
      keys,
      ...options,
    });
  };
  const buildFailedProcessingResult = (error: unknown): TelegramMessageProcessingResult => ({
    kind: "failed-retryable",
    error,
  });
  const settleSpooledReplayParticipants = (
    participants: readonly TelegramSpooledReplayDeferredParticipant[],
    result: TelegramMessageProcessingResult,
  ) => {
    for (const participant of new Set(participants)) {
      participant.settle(result);
    }
  };
  const beginSpooledReplaySettlementHolds = (
    participants: readonly TelegramSpooledReplayDeferredParticipant[],
  ) => {
    const holds: TelegramSpooledReplaySettlementHold[] = [];
    for (const participant of new Set(participants)) {
      const hold = participant.beginSettlementHold();
      if (!hold) {
        for (const acquired of holds) {
          acquired.release("replay-pending");
        }
        const reason = participant.abortSignal.reason;
        throw reason instanceof Error
          ? reason
          : new Error(
              `telegram spooled replay participant ${participant.key} settled before durable adoption`,
            );
      }
      holds.push(hold);
    }
    return (mode: Parameters<TelegramSpooledReplaySettlementHold["release"]>[0]) => {
      for (const hold of holds) {
        hold.release(mode);
      }
    };
  };
  const createSpooledReplayParticipantForBufferedWork = (
    key: string,
  ): TelegramSpooledReplayDeferredParticipant | undefined =>
    createTelegramSpooledReplayDeferredParticipant(key) ?? undefined;
  const spooledReplayOptions = (
    participants: readonly TelegramSpooledReplayDeferredParticipant[],
  ): Pick<TelegramMessageContextOptions, "spooledReplay"> =>
    participants.length > 0 ? { spooledReplay: true } : {};
  const claimMessageDispatchDedupe = async (
    msg: Message,
  ): Promise<{ process: true; keys: string[] } | { process: false }> => {
    const claim = await claimTelegramMessageDispatchReplay({
      guard: messageDispatchReplayGuard,
      accountId,
      msg,
    });
    if (claim.kind === "duplicate") {
      logVerbose(`telegram dispatch dedupe: skipped message ${msg.chat.id}:${msg.message_id}`);
      return { process: false };
    }
    return { process: true, keys: claim.kind === "claimed" ? [claim.key] : [] };
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
  // grammy's Context.getFile reads update state via `this`; keep the receiver bound.
  const buildSyntheticContext = (
    ctx: Pick<TelegramContext, "me" | "getFile">,
    message: Message,
  ): TelegramContext => ({ message, me: ctx.me, getFile: ctx.getFile.bind(ctx) });

  const formatTelegramAmbientTranscriptLine = (msg: Message): string => {
    const text = getTelegramTextParts(msg).text.trim();
    const body =
      text || resolveTelegramMediaPlaceholder(msg) || "[User sent media without caption]";
    const messageId = msg.message_id ? `#${msg.message_id}` : undefined;
    const sender = buildSenderName(msg);
    const prefix = [messageId, sender].filter(Boolean).join(" ");
    return prefix ? `${prefix}: ${body}` : body;
  };

  const formatTelegramAmbientTranscriptBody = (
    messages: readonly Message[],
  ): string | undefined => {
    const lines = messages.map(formatTelegramAmbientTranscriptLine);
    return lines.length > 0 ? lines.join("\n") : undefined;
  };

  const MULTI_SELECT_PREFIX = "OC_MULTI|";
  const MULTI_SELECT_TOGGLE_PREFIX = `${MULTI_SELECT_PREFIX}toggle|`;
  const SELECT_PREFIX = "OC_SELECT|";
  const SELECTED_PREFIX = "✅ ";

  type TelegramManagedSelectCallback =
    | { type: "multi-toggle"; value: string }
    | { type: "multi-clear" }
    | { type: "multi-submit" }
    | { type: "select"; value: string };

  type TelegramCallbackButton = {
    text: string;
    callback_data: string;
    style?: "danger" | "success" | "primary";
  };

  const parseTelegramManagedSelectCallback = (
    data: string,
  ): TelegramManagedSelectCallback | undefined => {
    if (data.startsWith(MULTI_SELECT_TOGGLE_PREFIX)) {
      return { type: "multi-toggle", value: data.slice(MULTI_SELECT_TOGGLE_PREFIX.length) };
    }
    if (data === `${MULTI_SELECT_PREFIX}clear`) {
      return { type: "multi-clear" };
    }
    if (data === `${MULTI_SELECT_PREFIX}submit`) {
      return { type: "multi-submit" };
    }
    if (data.startsWith(SELECT_PREFIX)) {
      return { type: "select", value: data.slice(SELECT_PREFIX.length) };
    }
    return undefined;
  };

  const cloneInlineKeyboardButtons = (message: Message): TelegramCallbackButton[][] => {
    const rows = (message as { reply_markup?: { inline_keyboard?: unknown } }).reply_markup
      ?.inline_keyboard;
    if (!Array.isArray(rows)) {
      return [];
    }
    return rows
      .map((row) =>
        Array.isArray(row)
          ? row
              .map((button): TelegramCallbackButton | null => {
                const candidate = button as {
                  text?: unknown;
                  callback_data?: unknown;
                  style?: unknown;
                };
                if (
                  typeof candidate.text !== "string" ||
                  typeof candidate.callback_data !== "string"
                ) {
                  return null;
                }
                const style =
                  candidate.style === "danger" ||
                  candidate.style === "success" ||
                  candidate.style === "primary"
                    ? candidate.style
                    : undefined;
                return {
                  text: candidate.text,
                  callback_data: candidate.callback_data,
                  ...(style ? { style } : {}),
                };
              })
              .filter((button): button is TelegramCallbackButton => button !== null)
          : [],
      )
      .filter((row) => row.length > 0);
  };
  const stripMultiSelectPrefix = (text: string): string => text.replace(/^✅\s*/, "");
  const isSelectedMultiButton = (button: TelegramCallbackButton): boolean =>
    /^✅\s*/.test(button.text);
  const isMultiToggleButton = (button: TelegramCallbackButton): boolean =>
    button.callback_data.startsWith(MULTI_SELECT_TOGGLE_PREFIX);
  const resolveMultiSelectedValues = (buttons: TelegramCallbackButton[][]): string[] =>
    buttons.flatMap((row) =>
      row.flatMap((button) => {
        if (!isMultiToggleButton(button) || !isSelectedMultiButton(button)) {
          return [];
        }
        return [button.callback_data.slice(MULTI_SELECT_TOGGLE_PREFIX.length)];
      }),
    );
  const updateMultiSelectKeyboard = (
    message: Message,
    action: "toggle" | "clear",
    value = "",
  ): TelegramCallbackButton[][] =>
    cloneInlineKeyboardButtons(message).map((row) =>
      row.map((button) => {
        if (!isMultiToggleButton(button)) {
          return button;
        }
        const buttonValue = button.callback_data.slice(MULTI_SELECT_TOGGLE_PREFIX.length);
        const baseText = stripMultiSelectPrefix(button.text);
        const selected =
          action === "clear"
            ? false
            : buttonValue === value
              ? !isSelectedMultiButton(button)
              : isSelectedMultiButton(button);
        return {
          ...button,
          text: selected ? `${SELECTED_PREFIX}${baseText}` : baseText,
        };
      }),
    );
  const buildCallbackSyntheticTextContext = (params: {
    ctx: Pick<TelegramContext, "me" | "getFile">;
    callbackMessage: Message;
    callback: { from?: Message["from"] };
    text: string;
    isForum: boolean;
  }): { ctx: TelegramContext; message: Message } => {
    const message = buildSyntheticTextMessage({
      base: withResolvedTelegramForumFlag(params.callbackMessage, params.isForum),
      from: params.callback.from,
      text: params.text,
    });
    return { ctx: buildSyntheticContext(params.ctx, message), message };
  };

  const inboundDebouncer = createInboundDebouncer<TelegramDebounceEntry>({
    debounceMs,
    serializeImmediate: true,
    resolveDebounceMs: resolveTelegramDebounceEntryMs,
    buildKey: (entry) => entry.debounceKey,
    shouldDebounce: shouldDebounceTelegramEntry,
    onFlush: async (entries) => {
      const spooledReplayParticipants = entries
        .map((entry) => entry.spooledReplayParticipant)
        .filter(
          (participant): participant is TelegramSpooledReplayDeferredParticipant =>
            participant !== undefined,
        );
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      try {
        if (entries.length === 1) {
          const result = await processMessageWithReplyChain({
            ctx: last.ctx,
            msg: last.msg,
            allMedia: last.allMedia,
            storeAllowFrom: last.storeAllowFrom,
            options: {
              receivedAtMs: last.receivedAtMs,
              ingressBuffer: "inbound-debounce",
              ...promptContextBoundaryOptions(
                last.promptContextMinTimestampMs,
                last.promptContextAmbientWatermark,
              ),
              ...spooledReplayOptions(spooledReplayParticipants),
            },
            dispatchDedupeKeys: last.dispatchDedupeKeys,
            spooledReplayParticipants,
          });
          settleSpooledReplayParticipants(spooledReplayParticipants, result);
          return;
        }
        const combinedText = entries
          .map((entry) => getTelegramTextParts(entry.msg).text)
          .filter(Boolean)
          .join("\n");
        const combinedMedia = entries.flatMap((entry) => entry.allMedia);
        if (!combinedText.trim() && combinedMedia.length === 0) {
          releaseDispatchDedupeKeys(
            mergeDispatchDedupeKeys(...entries.map((entry) => entry.dispatchDedupeKeys)),
          );
          settleSpooledReplayParticipants(spooledReplayParticipants, { kind: "skipped" });
          return;
        }
        const first = entries[0];
        const promptContextMinTimestampMs = latestPromptContextMinTimestampMs(
          ...entries.map((entry) => entry.promptContextMinTimestampMs),
        );
        const promptContextAmbientWatermark = latestPromptContextAmbientWatermark(
          ...entries.map((entry) => entry.promptContextAmbientWatermark),
        );
        const baseCtx = first.ctx;
        const syntheticMessage = buildSyntheticTextMessage({
          base: first.msg,
          text: combinedText,
          date: last.msg.date ?? first.msg.date,
        });
        const messageIdOverride = last.msg.message_id ? String(last.msg.message_id) : undefined;
        const syntheticCtx = buildSyntheticContext(baseCtx, syntheticMessage);
        const result = await processMessageWithReplyChain({
          ctx: syntheticCtx,
          msg: syntheticMessage,
          allMedia: combinedMedia,
          storeAllowFrom: first.storeAllowFrom,
          options: {
            ...(messageIdOverride ? { messageIdOverride } : {}),
            ambientTranscriptBody: formatTelegramAmbientTranscriptBody(
              entries.map((entry) => entry.msg),
            ),
            receivedAtMs: first.receivedAtMs,
            ingressBuffer: "inbound-debounce",
            ...promptContextBoundaryOptions(
              promptContextMinTimestampMs,
              promptContextAmbientWatermark,
            ),
            ...spooledReplayOptions(spooledReplayParticipants),
          },
          dispatchDedupeKeys: mergeDispatchDedupeKeys(
            ...entries.map((entry) => entry.dispatchDedupeKeys),
          ),
          spooledReplayParticipants,
        });
        settleSpooledReplayParticipants(spooledReplayParticipants, result);
      } catch (err) {
        settleSpooledReplayParticipants(
          spooledReplayParticipants,
          buildFailedProcessingResult(err),
        );
        throw err;
      }
    },
    onError: (err, items) => {
      const spooledReplayParticipants = items
        .map((item) => item.spooledReplayParticipant)
        .filter(
          (participant): participant is TelegramSpooledReplayDeferredParticipant =>
            participant !== undefined,
        );
      settleSpooledReplayParticipants(spooledReplayParticipants, buildFailedProcessingResult(err));
      runtime.error?.(danger(`telegram debounce flush failed: ${String(err)}`));
      if (spooledReplayParticipants.length > 0) {
        return;
      }
      const chatId = items[0]?.msg.chat.id;
      if (chatId != null) {
        const threadId = items[0]?.msg.message_thread_id;
        void bot.api
          .sendMessage(
            chatId,
            "Something went wrong while processing your message. Please try again.",
            threadId != null ? { message_thread_id: threadId } : undefined,
          )
          .catch((sendErr: unknown) => {
            logVerbose(`telegram: error fallback send failed: ${String(sendErr)}`);
          });
      }
    },
    onCancel: (items) => {
      releaseDispatchDedupeKeys(
        mergeDispatchDedupeKeys(...items.map((item) => item.dispatchDedupeKeys)),
      );
      settleSpooledReplayParticipants(
        items
          .map((item) => item.spooledReplayParticipant)
          .filter(
            (participant): participant is TelegramSpooledReplayDeferredParticipant =>
              participant !== undefined,
          ),
        { kind: "skipped" },
      );
    },
  });

  const resolveTelegramSessionState = (params: {
    chatId: number | string;
    isGroup: boolean;
    isForum: boolean;
    messageThreadId?: number;
    resolvedThreadId?: number;
    botHasTopicsEnabled?: boolean;
    senderId?: string | number;
    runtimeCfg: OpenClawConfig;
  }): {
    agentId: string;
    sessionEntry: ReturnType<typeof getSessionEntry>;
    sessionKey: string;
    storePath: string;
    model?: string;
  } => {
    const runtimeCfg = params.runtimeCfg;
    const resolvedThreadId =
      params.resolvedThreadId ??
      resolveTelegramForumThreadId({
        isForum: params.isForum,
        messageThreadId: params.messageThreadId,
      });
    const dmThreadId = !params.isGroup ? params.messageThreadId : undefined;
    const topicThreadId = resolvedThreadId ?? dmThreadId;
    const { topicConfig } = resolveTelegramGroupConfig(params.chatId, topicThreadId, runtimeCfg);
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
      shouldUseTelegramDmThreadSession({
        dmThreadId,
        botHasTopicsEnabled: params.botHasTopicsEnabled,
      }) && dmThreadId != null
        ? resolveThreadSessionKeys({ baseSessionKey, threadId: `${params.chatId}:${dmThreadId}` })
        : null;
    const sessionKey = threadKeys?.sessionKey ?? baseSessionKey;
    const storePath = telegramDeps.resolveStorePath(runtimeCfg.session?.store, {
      agentId: route.agentId,
    });
    const entry = (telegramDeps.getSessionEntry ?? getSessionEntry)({ storePath, sessionKey });
    const store = Object.fromEntries(
      (telegramDeps.listSessionEntries ?? listSessionEntries)({ storePath }).map(
        ({ sessionKey: key, entry: value }) => [key, value],
      ),
    );
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
        storePath,
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
        storePath,
        model: `${provider}/${model}`,
      };
    }
    const modelCfg = runtimeCfg.agents?.defaults?.model;
    return {
      agentId: route.agentId,
      sessionEntry: entry,
      sessionKey,
      storePath,
      model: typeof modelCfg === "string" ? modelCfg : modelCfg?.primary,
    };
  };

  const resolvePromptContextAmbientWatermark = (params: {
    chatId: number | string;
    isGroup: boolean;
    resolvedThreadId?: number;
    sessionKey: string;
    storePath: string;
  }): TelegramAmbientTranscriptWatermark | undefined => {
    if (!params.isGroup) {
      return undefined;
    }
    const key = (
      telegramDeps.resolveAmbientTranscriptWatermarkKey ?? resolveAmbientTranscriptWatermarkKey
    )({
      channel: "telegram",
      accountId,
      conversationId: String(params.chatId),
      ...(params.resolvedThreadId !== undefined ? { threadId: params.resolvedThreadId } : {}),
    });
    return (telegramDeps.readAmbientTranscriptWatermark ?? readAmbientTranscriptWatermark)({
      storePath: params.storePath,
      sessionKey: params.sessionKey,
      key,
    });
  };

  const mediaMayNeedDownloadForMentionDetection = (msg: Message): boolean => {
    const textParts = getTelegramTextParts(msg);
    if (textParts.text.trim()) {
      return false;
    }
    const documentMime = msg.document?.mime_type?.split(";")[0]?.trim().toLowerCase();
    return Boolean(msg.audio ?? msg.voice ?? documentMime?.startsWith("audio/"));
  };

  const shouldSkipMediaDownloadForUnaddressedMentionGroup = async (params: {
    authorizationCfg: OpenClawConfig;
    ctx: TelegramContext;
    msg: Message;
    chatId: number;
    isGroup: boolean;
    isForum: boolean;
    resolvedThreadId?: number;
    dmThreadId?: number;
    senderId: string;
    effectiveGroupAllow: NormalizedAllowFrom;
    effectiveDmAllow: NormalizedAllowFrom;
    groupConfig?: TelegramGroupConfig;
    topicConfig?: TelegramTopicConfig;
  }): Promise<boolean> => {
    const {
      authorizationCfg,
      ctx,
      msg,
      chatId,
      isGroup,
      isForum,
      resolvedThreadId,
      dmThreadId,
      senderId,
      effectiveGroupAllow,
      effectiveDmAllow,
      groupConfig,
      topicConfig,
    } = params;
    if (!isGroup || mediaMayNeedDownloadForMentionDetection(msg)) {
      return false;
    }

    const runtimeCfg = authorizationCfg;
    const sessionState = resolveTelegramSessionState({
      chatId,
      isGroup,
      isForum,
      resolvedThreadId,
      messageThreadId: resolvedThreadId ?? dmThreadId,
      senderId,
      runtimeCfg,
    });
    const activationOverride = resolveGroupActivation({
      chatId,
      messageThreadId: resolvedThreadId,
      sessionKey: sessionState.sessionKey,
      agentId: sessionState.agentId,
      cfg: runtimeCfg,
    });
    const requireMention = firstDefined(
      topicConfig?.requireMention,
      activationOverride,
      groupConfig?.requireMention,
      resolveGroupRequireMention(chatId, runtimeCfg),
    );
    if (!requireMention) {
      return false;
    }

    const botUsername = ctx.me?.username?.trim().toLowerCase();
    const mentionRegexes = buildMentionRegexes(runtimeCfg, sessionState.agentId);
    const messageTextParts = getTelegramTextParts(msg);
    const hasAnyMention = messageTextParts.entities.some((ent) => ent.type === "mention");
    const explicitlyMentioned = botUsername ? hasBotMention(msg, botUsername) : false;
    const wasMentioned = matchesMentionWithExplicit({
      text: messageTextParts.text,
      mentionRegexes,
      explicit: {
        hasAnyMention,
        isExplicitlyMentioned: explicitlyMentioned,
        canResolveExplicit: Boolean(botUsername),
      },
    });
    const botId = ctx.me?.id;
    const replyFromId = msg.reply_to_message?.from?.id;
    const replyToBotMessage = botId != null && replyFromId === botId;
    const isReplyToServiceMessage =
      replyToBotMessage && isTelegramForumServiceMessage(msg.reply_to_message);
    const implicitMentionKinds = implicitMentionKindWhen(
      "reply_to_bot",
      replyToBotMessage && !isReplyToServiceMessage,
    );
    const canDetectMention = Boolean(botUsername) || mentionRegexes.length > 0;
    const hasControlCommandInMessage = hasControlCommand(messageTextParts.text, runtimeCfg, {
      botUsername,
    });
    const commandGate = await resolveTelegramCommandIngressAuthorization({
      accountId,
      cfg: runtimeCfg,
      dmPolicy: "pairing",
      isGroup,
      chatId,
      resolvedThreadId,
      senderId,
      effectiveDmAllow,
      effectiveGroupAllow,
      ownerAccess: { ownerList: [], senderIsOwner: false },
      eventKind: "message",
      allowTextCommands: true,
      hasControlCommand: hasControlCommandInMessage,
      modeWhenAccessGroupsOff: "allow",
      includeDmAllowForGroupCommands: false,
    });
    const mentionDecision = resolveInboundMentionDecision({
      facts: {
        canDetectMention,
        wasMentioned,
        hasAnyMention,
        implicitMentionKinds,
      },
      policy: {
        isGroup,
        requireMention: true,
        allowTextCommands: true,
        hasControlCommand: hasControlCommandInMessage,
        commandAuthorized: commandGate.authorized,
      },
    });
    if (mentionDecision.shouldSkip) {
      logger.info({ chatId, reason: "no-mention" }, "skipping group media before download");
      return true;
    }
    return false;
  };

  const processMediaGroup = async (entry: BufferedMediaGroupEntry) => {
    try {
      entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);

      const captionMsg = entry.messages.find((m) => m.msg.caption || m.msg.text);
      const primaryEntry = captionMsg ?? entry.messages[0];
      if (!primaryEntry) {
        releaseDispatchDedupeKeys(entry.dispatchDedupeKeys);
        settleSpooledReplayParticipants(entry.spooledReplayParticipants, { kind: "skipped" });
        return;
      }

      if (
        await shouldSkipMediaDownloadForUnaddressedMentionGroup({
          authorizationCfg: entry.authorizationCfg,
          ctx: primaryEntry.ctx,
          msg: primaryEntry.msg,
          chatId: primaryEntry.msg.chat.id,
          isGroup: entry.isGroup,
          isForum: entry.isForum,
          resolvedThreadId: entry.resolvedThreadId,
          dmThreadId: entry.dmThreadId,
          senderId: entry.senderId,
          effectiveGroupAllow: entry.effectiveGroupAllow,
          effectiveDmAllow: entry.effectiveDmAllow,
          groupConfig: entry.groupConfig,
          topicConfig: entry.topicConfig,
        })
      ) {
        releaseDispatchDedupeKeys(entry.dispatchDedupeKeys);
        settleSpooledReplayParticipants(entry.spooledReplayParticipants, { kind: "skipped" });
        return;
      }

      const allMedia: TelegramMediaRef[] = [];
      const promptContextMessageSelection = new Map<string, "include" | "exclude">();
      let skippedCount = 0;
      for (const { ctx, msg } of entry.messages) {
        const sourceMessageId = String(msg.message_id);
        let media;
        try {
          media = await resolveMedia({
            ctx,
            maxBytes: mediaMaxBytes,
            ...mediaRuntimeWithAbort,
          });
        } catch (mediaErr) {
          // Only durable ingress can replay an aborted album. Classic polling keeps
          // its best-effort partial delivery so Telegram does not acknowledge a drop.
          if (
            mediaRuntimeWithAbort.abortSignal?.aborted &&
            entry.spooledReplayParticipants.length > 0
          ) {
            throw mediaErr;
          }
          if (!isRecoverableMediaGroupError(mediaErr)) {
            throw mediaErr;
          }
          runtime.log?.(
            warn(`media group: skipping photo that failed to fetch: ${String(mediaErr)}`),
          );
          promptContextMessageSelection.set(sourceMessageId, "exclude");
          skippedCount++;
          continue;
        }
        if (media) {
          allMedia.push({
            path: media.path,
            contentType: media.contentType,
            stickerMetadata: media.stickerMetadata,
            sourceMessageId,
          });
          promptContextMessageSelection.set(sourceMessageId, "include");
        } else {
          promptContextMessageSelection.set(sourceMessageId, "exclude");
          skippedCount++;
        }
      }

      if (skippedCount > 0) {
        const total = entry.messages.length;
        const wasOrWere = skippedCount === 1 ? "was" : "were";
        await withTelegramApiErrorLogging({
          operation: "sendMessage",
          runtime,
          fn: () =>
            bot.api.sendMessage(
              primaryEntry.msg.chat.id,
              `⚠️ Received ${allMedia.length} of ${total} images — ${skippedCount} could not be fetched and ${wasOrWere} skipped.`,
              {
                reply_parameters: {
                  message_id: primaryEntry.msg.message_id,
                  allow_sending_without_reply: true,
                },
              },
            ),
        }).catch(() => {});
      }

      const result = await processMessageWithReplyChain({
        ctx: primaryEntry.ctx,
        msg: primaryEntry.msg,
        allMedia,
        promptContextMessageSelection,
        storeAllowFrom: entry.storeAllowFrom,
        options: {
          ...promptContextBoundaryOptions(
            entry.promptContextMinTimestampMs,
            entry.promptContextAmbientWatermark,
          ),
          ...spooledReplayOptions(entry.spooledReplayParticipants),
        },
        dispatchDedupeKeys: entry.dispatchDedupeKeys,
        spooledReplayParticipants: entry.spooledReplayParticipants,
      });
      settleSpooledReplayParticipants(entry.spooledReplayParticipants, result);
    } catch (err) {
      releaseDispatchDedupeKeys(entry.dispatchDedupeKeys, err);
      settleSpooledReplayParticipants(
        entry.spooledReplayParticipants,
        buildFailedProcessingResult(err),
      );
      runtime.error?.(danger(`media group handler failed: ${String(err)}`));
    }
  };

  const flushTextFragments = async (entry: TextFragmentEntry) => {
    try {
      entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);

      const first = entry.messages[0];
      const last = entry.messages.at(-1);
      if (!first || !last) {
        releaseDispatchDedupeKeys(entry.dispatchDedupeKeys);
        settleSpooledReplayParticipants(entry.spooledReplayParticipants, { kind: "skipped" });
        return;
      }

      const combinedText = entry.messages.map((m) => m.msg.text ?? "").join("");
      if (!combinedText.trim()) {
        releaseDispatchDedupeKeys(entry.dispatchDedupeKeys);
        settleSpooledReplayParticipants(entry.spooledReplayParticipants, { kind: "skipped" });
        return;
      }

      const syntheticMessage = buildSyntheticTextMessage({
        base: first.msg,
        text: combinedText,
        date: last.msg.date ?? first.msg.date,
      });

      const baseCtx = first.ctx;

      const syntheticCtx = buildSyntheticContext(baseCtx, syntheticMessage);
      const result = await processMessageWithReplyChain({
        ctx: syntheticCtx,
        msg: syntheticMessage,
        allMedia: [],
        storeAllowFrom: entry.storeAllowFrom,
        options: {
          messageIdOverride: String(last.msg.message_id),
          ambientTranscriptBody: formatTelegramAmbientTranscriptBody(
            entry.messages.map((message) => message.msg),
          ),
          receivedAtMs: first.receivedAtMs,
          ingressBuffer: "text-fragment",
          ...promptContextBoundaryOptions(
            entry.promptContextMinTimestampMs,
            entry.promptContextAmbientWatermark,
          ),
          ...spooledReplayOptions(entry.spooledReplayParticipants),
        },
        dispatchDedupeKeys: entry.dispatchDedupeKeys,
        spooledReplayParticipants: entry.spooledReplayParticipants,
      });
      settleSpooledReplayParticipants(entry.spooledReplayParticipants, result);
    } catch (err) {
      releaseDispatchDedupeKeys(entry.dispatchDedupeKeys, err);
      settleSpooledReplayParticipants(
        entry.spooledReplayParticipants,
        buildFailedProcessingResult(err),
      );
      runtime.error?.(danger(`text fragment handler failed: ${String(err)}`));
    }
  };

  const queueTextFragmentFlush = async (entry: TextFragmentEntry) => {
    await queueBufferedProcessing(textFragmentProcessingQueue, entry.key, async () => {
      await flushTextFragments(entry);
    });
  };

  const runTextFragmentFlush = async (entry: TextFragmentEntry) => {
    textFragmentBuffer.delete(entry.key);
    await queueTextFragmentFlush(entry);
  };

  const scheduleTextFragmentFlush = (entry: TextFragmentEntry) => {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      void runTextFragmentFlush(entry);
    }, TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS);
  };

  const recordMessageForReplyChain = (msg: Message, threadId?: number) =>
    messageCache.record({
      accountId,
      chatId: msg.chat.id,
      msg,
      ...(threadId != null ? { threadId } : {}),
    });

  const buildReplyChainForMessage = (msg: Message) =>
    buildTelegramReplyChain({
      cache: messageCache,
      accountId,
      chatId: msg.chat.id,
      msg,
    });

  const toReplyChainEntry = (
    node: TelegramCachedMessageNode,
    ctx: TelegramContext,
    media?: TelegramMediaRef,
  ): TelegramReplyChainEntry => {
    const { sourceMessage: _sourceMessage, ...entry } = node;
    const projectedEntry = { ...entry, sender: resolvePromptSender(node, ctx) };
    if (!media?.path) {
      return projectedEntry;
    }
    const { mediaRef: _mediaRef, ...entryWithoutProviderMediaRef } = projectedEntry;
    return {
      ...entryWithoutProviderMediaRef,
      mediaPath: media.path,
      ...(media?.contentType ? { mediaType: media.contentType } : {}),
    };
  };

  const toPromptContextMessage = (
    node: TelegramCachedMessageNode,
    ctx: TelegramContext,
    flags?: { replyTarget?: boolean },
    media?: TelegramMediaRef,
  ) => ({
    message_id: node.messageId,
    thread_id: node.threadId,
    sender: resolvePromptSender(node, ctx),
    sender_id: node.senderId,
    sender_username: node.senderUsername,
    timestamp_ms: node.timestamp,
    body: node.body,
    media_type: media?.contentType ?? node.mediaType,
    media_path: media?.path,
    media_ref: media?.path ? undefined : node.mediaRef,
    reply_to_id: node.replyToId,
    is_reply_target: flags?.replyTarget === true ? true : undefined,
  });

  const buildPromptContextForMessage = async (
    ctx: TelegramContext,
    msg: Message,
    replyChainNodes: TelegramCachedMessageNode[],
    runtimeCfg: OpenClawConfig,
    runtimeTelegramCfg: TelegramAccountConfig,
    options?: TelegramMessageContextOptions,
    mediaByMessageId?: ReadonlyMap<string, TelegramMediaRef>,
    selectedMessageIds?: PromptContextMessageSelection,
  ): Promise<TelegramPromptContextEntry[]> => {
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
    const groupHistoryLimit = Math.max(
      0,
      runtimeTelegramCfg.historyLimit ??
        runtimeCfg.messages?.groupChat?.historyLimit ??
        DEFAULT_GROUP_HISTORY_LIMIT,
    );
    const messageId = typeof msg.message_id === "number" ? String(msg.message_id) : undefined;
    const currentNode = await messageCache.get({
      accountId,
      chatId: msg.chat.id,
      messageId,
    });
    const threadId = currentNode?.threadId ? Number(currentNode.threadId) : undefined;
    const sessionBeforeTimestampMs =
      options?.receivedAtMs ?? (msg.date ? msg.date * 1000 : undefined);
    const isSessionBoundaryMessage = isTelegramSessionBoundaryCommandText(
      getTelegramTextParts(msg).text,
    );
    const sessionPromptMessages =
      isGroup || isSessionBoundaryMessage
        ? []
        : await buildTelegramSessionTranscriptPromptMessages({
            ...resolveTelegramSessionState({
              chatId: msg.chat.id,
              isGroup: false,
              isForum: false,
              messageThreadId: msg.message_thread_id,
              botHasTopicsEnabled: resolveTelegramBotHasTopicsEnabled(ctx.me),
              senderId: msg.from?.id,
              runtimeCfg,
            }),
            limit: 10,
            ...(sessionBeforeTimestampMs !== undefined
              ? { beforeTimestampMs: sessionBeforeTimestampMs }
              : {}),
            ...(options?.promptContextMinTimestampMs !== undefined
              ? { minTimestampMs: options.promptContextMinTimestampMs }
              : {}),
          });
    const conversationContext =
      isGroup && groupHistoryLimit <= 0
        ? []
        : await buildTelegramConversationContext({
            cache: messageCache,
            messageId,
            accountId,
            chatId: msg.chat.id,
            ...(Number.isFinite(threadId) ? { threadId } : {}),
            replyChainNodes,
            recentLimit: isGroup ? groupHistoryLimit : 10,
            replyTargetWindowSize: 2,
            ...(options?.promptContextMinTimestampMs !== undefined
              ? { minTimestampMs: options.promptContextMinTimestampMs }
              : {}),
            ...(isGroup && options?.promptContextAmbientWatermark !== undefined
              ? {
                  includeNode: (
                    node: TelegramCachedMessageNode,
                    flags?: { replyTarget?: boolean },
                  ) =>
                    // Explicit reply targets stay visible so the current turn is not shown
                    // as a reply to invisible transcript-owned text.
                    flags?.replyTarget === true ||
                    isTelegramHistoryEntryAfterAmbientWatermark(
                      node,
                      options.promptContextAmbientWatermark,
                    ),
                }
              : {}),
          });
    const conversationContextById = new Map(
      conversationContext.flatMap((entry) =>
        entry.node.messageId ? [[entry.node.messageId, entry] as const] : [],
      ),
    );
    for (const [selectedMessageId, selection] of selectedMessageIds ?? []) {
      if (selection === "exclude") {
        conversationContextById.delete(selectedMessageId);
        continue;
      }
      if (selectedMessageId === messageId || conversationContextById.has(selectedMessageId)) {
        continue;
      }
      const node = await messageCache.get({
        accountId,
        chatId: msg.chat.id,
        messageId: selectedMessageId,
      });
      if (node?.messageId) {
        conversationContextById.set(node.messageId, { node });
      }
    }
    const cachePromptMessages = Array.from(conversationContextById.values()).map((entry) =>
      toPromptContextMessage(
        entry.node,
        ctx,
        { replyTarget: entry.isReplyTarget },
        entry.node.messageId ? mediaByMessageId?.get(entry.node.messageId) : undefined,
      ),
    );
    const cacheTextKeys = new Set(
      cachePromptMessages
        .map((message) => resolvePromptContextTextDedupeKey(message))
        .filter((key) => key !== undefined),
    );
    const sessionOnlyPromptMessages = sessionPromptMessages.filter((message) => {
      const key = resolvePromptContextTextDedupeKey(message);
      return key === undefined || !cacheTextKeys.has(key);
    });
    const promptMessages = [...sessionOnlyPromptMessages, ...cachePromptMessages].toSorted(
      (left, right) => (left.timestamp_ms ?? 0) - (right.timestamp_ms ?? 0),
    );
    return promptMessages.length > 0
      ? [
          {
            label: "Conversation context",
            source: sessionOnlyPromptMessages.length > 0 ? "session" : "telegram",
            type: "chat_window",
            payload: {
              order: "chronological",
              relation: "selected_for_current_message",
              messages: promptMessages,
            },
          },
        ]
      : [];
  };

  const resolveReplyMediaForChain = async (
    ctx: TelegramContext,
    chain: TelegramCachedMessageNode[],
    shouldHydrateMedia: (node: TelegramCachedMessageNode, index: number) => Promise<boolean>,
    durableMediaReplay: boolean,
  ): Promise<{ replyMedia: TelegramMediaRef[]; replyChain: TelegramReplyChainEntry[] }> => {
    const replyMedia: TelegramMediaRef[] = [];
    const replyChain: TelegramReplyChainEntry[] = [];
    for (const [index, node] of chain.entries()) {
      let mediaRef: TelegramMediaRef | undefined;
      const replyFileId = resolveInboundMediaFileId(node.sourceMessage);
      if (
        replyFileId &&
        hasInboundMedia(node.sourceMessage) &&
        (await shouldHydrateMedia(node, index))
      ) {
        try {
          const media = await resolveMedia({
            ctx: {
              message: node.sourceMessage,
              me: ctx.me,
              getFile: async (signal) => await bot.api.getFile(replyFileId, signal),
            },
            maxBytes: mediaMaxBytes,
            ...mediaRuntimeWithAbort,
          });
          mediaRef = media
            ? {
                path: media.path,
                ...(media.contentType ? { contentType: media.contentType } : {}),
                ...(media.stickerMetadata ? { stickerMetadata: media.stickerMetadata } : {}),
              }
            : undefined;
        } catch (err) {
          // Only durable ingress can replay a reply-media abort. Live polling must
          // preserve the current text instead of acknowledging it without dispatch.
          if (mediaRuntimeWithAbort.abortSignal?.aborted && durableMediaReplay) {
            recordTelegramMessageProcessingResult({ kind: "failed-retryable", error: err });
            throw err;
          }
          logger.warn(
            { chatId: ctx.message.chat.id, error: String(err) },
            "reply media fetch failed",
          );
        }
      }
      if (mediaRef) {
        replyMedia.push(mediaRef);
      }
      replyChain.push(toReplyChainEntry(node, ctx, mediaRef));
    }
    return { replyMedia, replyChain };
  };

  const processMessageWithReplyChain = async (params: {
    ctx: TelegramContext;
    msg: Message;
    allMedia: TelegramMediaRef[];
    promptContextMessageSelection?: PromptContextMessageSelection;
    storeAllowFrom: string[];
    options?: TelegramMessageContextOptions;
    dispatchDedupeKeys?: string[];
    spooledReplayParticipants?: readonly TelegramSpooledReplayDeferredParticipant[];
    spooledReplayAbortSignal?: AbortSignal;
  }): Promise<TelegramMessageProcessingResult> => {
    let dispatchDedupeCommitted = false;
    let spooledReplayFinalResult: TelegramMessageProcessingResult | undefined;
    let spooledReplayFinalization: Promise<TelegramMessageProcessingResult> | undefined;
    // Callback-submit retries also set options.spooledReplay without durable ingress.
    // Media aborts retry only when the update frame or a buffered participant owns replay.
    const durableMediaReplay =
      isTelegramSpooledReplayUpdate(params.ctx.update) ||
      Boolean(params.spooledReplayParticipants?.length);
    const spooledReplay = params.options?.spooledReplay === true || durableMediaReplay;
    const explicitParticipants = params.spooledReplayParticipants ?? [];
    const frameParticipant =
      spooledReplay &&
      explicitParticipants.length === 0 &&
      params.options?.isolateSpooledReplaySettlement !== true
        ? (getTelegramSpooledReplayDeferredParticipant() ??
          createTelegramSpooledReplayDeferredParticipant(
            `message:${params.msg.chat.id}:${params.msg.message_id}`,
          ) ??
          undefined)
        : undefined;
    const ingressSpooledReplayParticipants = [
      ...explicitParticipants,
      ...(frameParticipant ? [frameParticipant] : []),
    ];
    const processingParticipant =
      explicitParticipants.length > 0
        ? createTelegramSpooledReplayParticipant(
            `message-processing:${params.msg.chat.id}:${params.msg.message_id}`,
          )
        : frameParticipant;
    if (processingParticipant && explicitParticipants.length > 0) {
      for (const participant of explicitParticipants) {
        void participant.task.then((result) => {
          processingParticipant.settle(result);
        });
      }
    }
    const spooledReplayParticipants = [
      ...new Set([
        ...ingressSpooledReplayParticipants,
        ...(processingParticipant ? [processingParticipant] : []),
      ]),
    ];
    const finalizeSpooledReplayResult = async (
      result: TelegramMessageProcessingResult,
    ): Promise<TelegramMessageProcessingResult> => {
      if (spooledReplayFinalResult) {
        return spooledReplayFinalResult;
      }
      if (spooledReplayFinalization) {
        return await spooledReplayFinalization;
      }
      const finalization = (async () => {
        const finalized = result;
        if (result.kind === "completed") {
          // Do not cache or settle a durable-adoption failure. Deferred queue
          // ownership retries this callback with the same spool participants.
          const releaseSettlementHolds = beginSpooledReplaySettlementHolds(
            ingressSpooledReplayParticipants,
          );
          try {
            await commitDispatchDedupeKeys(params.dispatchDedupeKeys ?? [], {
              requirePersistent: true,
            });
          } catch (error) {
            releaseSettlementHolds("replay-pending");
            throw error;
          }
          releaseSettlementHolds("discard-pending");
          dispatchDedupeCommitted = true;
        } else {
          releaseDispatchDedupeKeys(
            params.dispatchDedupeKeys ?? [],
            result.kind === "failed-retryable" ? result.error : undefined,
          );
        }
        spooledReplayFinalResult = finalized;
        settleSpooledReplayParticipants(spooledReplayParticipants, finalized);
        return finalized;
      })();
      spooledReplayFinalization = finalization;
      try {
        return await finalization;
      } finally {
        if (!spooledReplayFinalResult && spooledReplayFinalization === finalization) {
          spooledReplayFinalization = undefined;
        }
      }
    };
    try {
      // One assembled turn owns one config identity. Reloading below this point
      // can validate a model pin against a different allowlist than dispatch uses.
      const runtimeCfg = telegramDeps.getRuntimeConfig();
      const runtimeTelegramCfg = resolveTelegramAccount({ cfg: runtimeCfg, accountId }).config;
      const replyChainNodes = await buildReplyChainForMessage(params.msg);
      const isGroupConversation =
        params.msg.chat.type === "group" || params.msg.chat.type === "supergroup";
      const isForum =
        params.msg.chat.type === "supergroup" &&
        Boolean(params.msg.chat.is_forum || params.msg.is_topic_message);
      const scopedThreadId = resolveTelegramForumThreadId({
        isForum,
        messageThreadId: params.msg.message_thread_id,
      });
      const { groupConfig, topicConfig } = resolveTelegramScopedGroupConfig(
        runtimeTelegramCfg,
        params.msg.chat.id,
        scopedThreadId,
      );
      const scopedAllowFrom = firstDefined(topicConfig?.allowFrom, groupConfig?.allowFrom);
      const configuredGroupAllowFrom =
        scopedAllowFrom ??
        opts.groupAllowFrom ??
        runtimeTelegramCfg.groupAllowFrom ??
        runtimeTelegramCfg.allowFrom ??
        opts.allowFrom;
      const contextVisibilityMode = resolveChannelContextVisibilityMode({
        cfg: runtimeCfg,
        channel: "telegram",
        accountId,
      });
      const shouldHydrateReplyMedia = async (
        node: TelegramCachedMessageNode,
        index: number,
      ): Promise<boolean> => {
        if (!isGroupConversation) {
          return true;
        }
        const expandedAllowFrom = await expandTelegramAllowFromWithAccessGroups({
          cfg: runtimeCfg,
          allowFrom: configuredGroupAllowFrom,
          accountId,
          senderId: node.senderId,
        });
        const effectiveAllow = normalizeAllowFrom(expandedAllowFrom);
        const senderAllowed = effectiveAllow.hasEntries
          ? isSenderAllowed({
              allow: effectiveAllow,
              senderId: node.senderId,
              senderUsername: node.senderUsername,
            })
          : true;
        return evaluateSupplementalContextVisibility({
          mode: contextVisibilityMode,
          kind: index === 0 ? "quote" : "thread",
          senderAllowed,
        }).include;
      };
      const { replyMedia, replyChain } = await resolveReplyMediaForChain(
        params.ctx,
        replyChainNodes,
        shouldHydrateReplyMedia,
        durableMediaReplay,
      );
      const promptContextMediaByMessageId = new Map<string, TelegramMediaRef>();
      const currentMessageId =
        typeof params.msg.message_id === "number" ? String(params.msg.message_id) : undefined;
      for (const [index, media] of params.allMedia.entries()) {
        const messageId = media.sourceMessageId ?? (index === 0 ? currentMessageId : undefined);
        const promptMediaPath = media.path ? resolveTelegramPromptMediaPath(media.path) : undefined;
        if (messageId && promptMediaPath) {
          promptContextMediaByMessageId.set(messageId, {
            ...media,
            path: promptMediaPath,
          });
        }
      }
      for (const entry of replyChain) {
        const promptMediaPath = entry.mediaPath
          ? resolveTelegramPromptMediaPath(entry.mediaPath)
          : undefined;
        if (entry.messageId && entry.mediaPath && promptMediaPath) {
          promptContextMediaByMessageId.set(entry.messageId, {
            path: promptMediaPath,
            ...(entry.mediaType ? { contentType: entry.mediaType } : {}),
          });
        }
      }
      const promptContext = await buildPromptContextForMessage(
        params.ctx,
        params.msg,
        replyChainNodes,
        runtimeCfg,
        runtimeTelegramCfg,
        params.options,
        promptContextMediaByMessageId,
        params.promptContextMessageSelection,
      );
      const result = await processMessage(
        params.ctx,
        params.allMedia,
        params.storeAllowFrom,
        {
          cfg: runtimeCfg,
          telegramCfg: runtimeTelegramCfg,
          onDispatchStart: async () => {
            await commitDispatchDedupeKeys(params.dispatchDedupeKeys ?? []);
            dispatchDedupeCommitted = true;
          },
          spooledReplayAbortSignal: params.spooledReplayAbortSignal,
          spooledReplayParticipant: processingParticipant,
          finalizeSpooledReplayResult: async (processingResult) =>
            await finalizeSpooledReplayResult(processingResult),
          completeSpooledReplayAfterIrrevocableAdoption: async () => {
            const completed = { kind: "completed" } satisfies TelegramMessageProcessingResult;
            return await finalizeSpooledReplayResult(completed);
          },
        },
        params.options,
        replyMedia,
        replyChain,
        promptContext,
      );
      if (spooledReplay) {
        return await finalizeSpooledReplayResult(result);
      }
      if (result.kind === "completed" && !dispatchDedupeCommitted) {
        await commitDispatchDedupeKeys(params.dispatchDedupeKeys ?? []);
      } else if (result.kind !== "completed" && !dispatchDedupeCommitted) {
        releaseDispatchDedupeKeys(params.dispatchDedupeKeys ?? []);
      }
      return result;
    } catch (err) {
      if (spooledReplay) {
        return await finalizeSpooledReplayResult(buildFailedProcessingResult(err));
      }
      if (!dispatchDedupeCommitted) {
        releaseDispatchDedupeKeys(params.dispatchDedupeKeys ?? [], err);
      }
      throw err;
    }
  };

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
    cfg: OpenClawConfig;
    telegramCfg: TelegramAccountConfig;
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
      cfg: authorizationCfg,
      telegramCfg: authorizationTelegramCfg,
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
      cfg: authorizationCfg,
      telegramCfg: authorizationTelegramCfg,
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
  type TelegramEventAuthorizationContext = TelegramGroupAllowContext & {
    cfg: OpenClawConfig;
    telegramCfg: TelegramAccountConfig;
    allowFrom: ReturnType<typeof resolveTelegramMessageTurnSettings>["allowFrom"];
    dmPolicy: DmPolicy;
  };
  const getChat: TelegramGetChat = bot.api.getChat.bind(bot.api);

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
    public override readonly cause: unknown;

    constructor(cause: unknown) {
      super(String(cause));
      this.cause = cause;
      this.name = "TelegramRetryableCallbackError";
    }
  }

  const isPermanentTelegramCallbackEditError = (err: unknown): boolean =>
    isTelegramEditTargetMissingError(err) || isTelegramMessageHasNoTextError(err);

  const TELEGRAM_PLUGIN_CALLBACK_SUBMIT_RETRY_DELAYS_MS = [250, 1000, 2500] as const;
  const REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE = /reply session initialization conflicted for \S+/u;

  const resolvePluginCallbackSubmitText = (submitText: unknown): string | undefined => {
    if (typeof submitText !== "string") {
      return undefined;
    }
    const trimmed = submitText.trim();
    return trimmed ? trimmed : undefined;
  };

  const isReplySessionInitConflictError = (err: unknown): boolean =>
    REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE.test(String(err instanceof Error ? err.message : err));

  const isReplySessionInitConflictResult = (result: TelegramMessageProcessingResult): boolean =>
    result.kind === "failed-retryable" && isReplySessionInitConflictError(result.error);

  const processPluginCallbackSubmitText = async (params: {
    callbackId: string;
    syntheticCtx: Parameters<typeof processMessageWithReplyChain>[0]["ctx"];
    syntheticMessage: Parameters<typeof processMessageWithReplyChain>[0]["msg"];
    storeAllowFrom: Parameters<typeof processMessageWithReplyChain>[0]["storeAllowFrom"];
  }): Promise<"completed" | "skipped"> => {
    const spooledReplayParticipant = isTelegramSpooledReplayUpdate(params.syntheticCtx.update)
      ? (getTelegramSpooledReplayDeferredParticipant() ??
        createTelegramSpooledReplayDeferredParticipant(
          `plugin-callback-submit:${params.callbackId}`,
        ) ??
        undefined)
      : undefined;
    const settleFinalResult = (result: TelegramMessageProcessingResult) => {
      spooledReplayParticipant?.settle(result);
      return result.kind;
    };
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await processMessageWithReplyChain({
          ctx: params.syntheticCtx,
          msg: params.syntheticMessage,
          allMedia: [],
          storeAllowFrom: params.storeAllowFrom,
          options: {
            spooledReplay: true,
            isolateSpooledReplaySettlement: true,
            forceWasMentioned: true,
            messageIdOverride: params.callbackId,
          },
          spooledReplayAbortSignal: spooledReplayParticipant?.abortSignal,
        });
        if (result.kind === "completed") {
          settleFinalResult(result);
          return "completed";
        }
        if (result.kind === "skipped") {
          settleFinalResult(result);
          return "skipped";
        }
        const retryDelayMs = TELEGRAM_PLUGIN_CALLBACK_SUBMIT_RETRY_DELAYS_MS[attempt];
        if (!isReplySessionInitConflictResult(result) || retryDelayMs === undefined) {
          throw new TelegramRetryableCallbackError(result.error);
        }
        logVerbose(
          `telegram plugin callback submitText hit active reply session; retrying in ${retryDelayMs}ms`,
        );
        await sleepWithAbort(retryDelayMs, spooledReplayParticipant?.abortSignal);
        continue;
      } catch (err) {
        const retryDelayMs = TELEGRAM_PLUGIN_CALLBACK_SUBMIT_RETRY_DELAYS_MS[attempt];
        if (!isReplySessionInitConflictError(err) || retryDelayMs === undefined) {
          settleFinalResult(buildFailedProcessingResult(err));
          throw err;
        }
        logVerbose(
          `telegram plugin callback submitText hit active reply session; retrying in ${retryDelayMs}ms`,
        );
        await sleepWithAbort(retryDelayMs, spooledReplayParticipant?.abortSignal);
      }
    }
  };

  // Authorization owns one ingress snapshot. The agent turn intentionally
  // captures again after batching so reloads during debounce apply to execution.
  const resolveTelegramEventAuthorizationContext = async (params: {
    cfg: OpenClawConfig;
    chatId: number;
    isGroup: boolean;
    isForum: boolean;
    senderId?: string;
    messageThreadId?: number;
  }): Promise<TelegramEventAuthorizationContext> => {
    const authorizationCfg = params.cfg;
    const authorizationTelegramCfg = resolveTelegramAccount({
      cfg: authorizationCfg,
      accountId,
    }).config;
    const authorizationSettings = resolveTelegramMessageTurnSettings({
      accountId,
      cfg: authorizationCfg,
      telegramCfg: authorizationTelegramCfg,
      opts,
    });
    const groupAllowContext = await resolveTelegramGroupAllowFromContext({
      cfg: authorizationCfg,
      chatId: params.chatId,
      accountId,
      dmPolicy: authorizationSettings.dmPolicy,
      allowFrom: authorizationSettings.allowFrom,
      senderId: params.senderId,
      isGroup: params.isGroup,
      isForum: params.isForum,
      messageThreadId: params.messageThreadId,
      groupAllowFrom: authorizationSettings.groupAllowFrom,
      readChannelAllowFromStore: telegramDeps.readChannelAllowFromStore,
      resolveTelegramGroupConfig,
    });
    const effectiveDmPolicy = resolveTelegramEffectiveDmPolicy({
      isGroup: params.isGroup,
      groupConfig: groupAllowContext.groupConfig,
      dmPolicy: authorizationSettings.dmPolicy,
    });
    return {
      cfg: authorizationCfg,
      allowFrom: authorizationSettings.allowFrom,
      telegramCfg: authorizationTelegramCfg,
      dmPolicy: effectiveDmPolicy,
      ...groupAllowContext,
    };
  };

  const authorizeTelegramEventSender = async (params: {
    chatId: number;
    chatTitle?: string;
    isGroup: boolean;
    senderId: string;
    senderUsername: string;
    mode: TelegramEventAuthorizationMode;
    context: TelegramEventAuthorizationContext;
  }): Promise<boolean> => {
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
      cfg: authorizationCfg,
      telegramCfg: authorizationTelegramCfg,
      allowFrom: authorizationAllowFrom,
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
        cfg: authorizationCfg,
        telegramCfg: authorizationTelegramCfg,
      })
    ) {
      return false;
    }

    if (!isGroup && enforceDirectAuthorization) {
      // For DMs, prefer per-DM/topic allowFrom (groupAllowOverride) over account-level allowFrom.
      const dmAllowFrom = groupAllowOverride ?? authorizationAllowFrom;
      const expandedDmAllowFrom = await expandTelegramAllowFromWithAccessGroups({
        cfg: authorizationCfg,
        allowFrom: dmAllowFrom,
        accountId,
        senderId,
      });
      const effectiveDmAllow = normalizeDmAllowFromWithStore({
        allowFrom: expandedDmAllowFrom,
        storeAllowFrom,
        dmPolicy,
      });
      const eventAccess = await resolveTelegramEventIngressAuthorization({
        accountId,
        dmPolicy,
        isGroup,
        chatId,
        resolvedThreadId,
        senderId,
        effectiveDmAllow,
        effectiveGroupAllow,
        enforceGroupAuthorization: false,
        eventKind: mode === "reaction" ? "reaction" : "button",
      });
      if (eventAccess.decision !== "allow") {
        if (eventAccess.reasonCode === "dm_policy_disabled") {
          logVerbose(
            `Blocked telegram direct event from ${senderId || "unknown"} (${deniedDmReason})`,
          );
          return false;
        }
        logVerbose(`Blocked telegram direct sender ${senderId || "unknown"} (${deniedDmReason})`);
        return false;
      }
    }
    if (isGroup && enforceGroupAllowlistAuthorization) {
      const eventAccess = await resolveTelegramEventIngressAuthorization({
        accountId,
        dmPolicy,
        isGroup,
        chatId,
        resolvedThreadId,
        senderId,
        effectiveDmAllow: normalizeDmAllowFromWithStore({ allowFrom: [], dmPolicy }),
        effectiveGroupAllow,
        enforceGroupAuthorization: true,
        eventKind: mode === "reaction" ? "reaction" : "button",
      });
      if (eventAccess.decision !== "allow") {
        logVerbose(`Blocked telegram group sender ${senderId || "unknown"} (${deniedGroupReason})`);
        return false;
      }
    }
    return true;
  };

  const isTelegramModelCallbackAuthorized = async (params: {
    chatId: number;
    isGroup: boolean;
    senderId: string;
    senderUsername: string;
    context: TelegramEventAuthorizationContext;
  }): Promise<boolean> => {
    const { chatId, isGroup, senderId, senderUsername, context } = params;
    const cfgLocal = context.cfg;
    const dmAllowFrom = context.groupAllowOverride ?? context.allowFrom;
    if (isTelegramCommandsAllowFromConfigured(cfgLocal)) {
      return resolveTelegramCommandAuthorization({
        cfg: cfgLocal,
        accountId,
        chatId,
        isGroup,
        resolvedThreadId: context.resolvedThreadId,
        senderId,
        senderUsername,
      }).isAuthorizedSender;
    }

    const expandedDmAllowFrom = await expandTelegramAllowFromWithAccessGroups({
      cfg: cfgLocal,
      allowFrom: dmAllowFrom,
      accountId,
      senderId,
    });
    const dmAllow = normalizeDmAllowFromWithStore({
      allowFrom: expandedDmAllowFrom,
      storeAllowFrom: isGroup ? [] : context.storeAllowFrom,
      dmPolicy: context.dmPolicy,
    });
    return (
      await resolveTelegramCommandIngressAuthorization({
        accountId,
        cfg: cfgLocal,
        dmPolicy: context.dmPolicy,
        isGroup,
        chatId,
        resolvedThreadId: context.resolvedThreadId,
        senderId,
        effectiveDmAllow: dmAllow,
        effectiveGroupAllow: context.effectiveGroupAllow,
        ownerAccess: { ownerList: [], senderIsOwner: false },
        eventKind: "button",
      })
    ).authorized;
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
      const authorizationCfg = telegramDeps.getRuntimeConfig();
      const authorizationTelegramCfg = resolveTelegramAccount({
        cfg: authorizationCfg,
        accountId,
      }).config;

      // Resolve reaction notification mode (default: "own").
      const reactionMode = authorizationTelegramCfg.reactionNotifications ?? "own";
      if (reactionMode === "off") {
        return;
      }
      if (user?.is_bot) {
        return;
      }
      if (
        reactionMode === "own" &&
        !telegramDeps.wasSentByBot(chatId, messageId, authorizationCfg)
      ) {
        logVerbose(
          `telegram: skipped reaction on msg ${messageId} in chat ${chatId} (own mode, not sent by bot)`,
        );
        return;
      }
      const eventAuthContext = await resolveTelegramEventAuthorizationContext({
        cfg: authorizationCfg,
        chatId,
        isGroup,
        isForum,
        senderId,
      });
      const senderAuthorization = await authorizeTelegramEventSender({
        chatId,
        chatTitle: reaction.chat.title,
        isGroup,
        senderId,
        senderUsername,
        mode: "reaction",
        context: eventAuthContext,
      });
      if (!senderAuthorization) {
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
        cfg: eventAuthContext.cfg,
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
    authorizationCfg: OpenClawConfig;
    ctx: TelegramContext;
    msg: Message;
    chatId: number;
    isGroup: boolean;
    isForum: boolean;
    resolvedThreadId?: number;
    dmThreadId?: number;
    dmPolicy: DmPolicy;
    storeAllowFrom: string[];
    senderId: string;
    effectiveGroupAllow: NormalizedAllowFrom;
    effectiveDmAllow: NormalizedAllowFrom;
    groupConfig?: TelegramGroupConfig;
    topicConfig?: TelegramTopicConfig;
    sendOversizeWarning: boolean;
    oversizeLogMessage: string;
    promptContextMinTimestampMs?: number;
    promptContextAmbientWatermark?: TelegramAmbientTranscriptWatermark;
    dispatchDedupeKeys: string[];
  }) => {
    const {
      authorizationCfg,
      ctx,
      msg,
      chatId,
      isGroup,
      isForum,
      resolvedThreadId,
      dmThreadId,
      dmPolicy,
      storeAllowFrom,
      senderId,
      effectiveGroupAllow,
      effectiveDmAllow,
      groupConfig,
      topicConfig,
      sendOversizeWarning,
      oversizeLogMessage,
      promptContextMinTimestampMs,
      promptContextAmbientWatermark,
      dispatchDedupeKeys,
    } = params;

    const messageText = getTelegramTextParts(msg).text;
    const botUsername = ctx.me?.username;
    const isAbortControlMessage = isAbortRequestText(messageText, { botUsername });
    let abortControlAuthorized: Promise<boolean> | undefined;
    const isAuthorizedAbortControlMessage = () => {
      if (!isAbortControlMessage || !senderId) {
        return Promise.resolve(false);
      }
      abortControlAuthorized ??= resolveTelegramCommandIngressAuthorization({
        accountId,
        cfg: authorizationCfg,
        dmPolicy,
        isGroup,
        chatId,
        resolvedThreadId,
        senderId,
        effectiveDmAllow,
        effectiveGroupAllow,
        ownerAccess: { ownerList: [], senderIsOwner: false },
        eventKind: "message",
        allowTextCommands: true,
        hasControlCommand: true,
        modeWhenAccessGroupsOff: "allow",
        includeDmAllowForGroupCommands: false,
      }).then((gate) => gate.authorized);
      return abortControlAuthorized;
    };

    // Text fragment handling - Telegram splits long pastes into multiple inbound messages (~4096 chars).
    // We buffer “near-limit” messages and append immediately-following parts.
    const text = typeof msg.text === "string" ? msg.text : undefined;
    const isCommandLike = (text ?? "").trim().startsWith("/");
    if (text && !isCommandLike && !isAbortControlMessage) {
      const nowMs = Date.now();
      const senderIdValue = msg.from?.id != null ? String(msg.from.id) : "unknown";
      // Use resolvedThreadId for forum groups, dmThreadId for DM topics
      const threadId = resolvedThreadId ?? dmThreadId;
      const key = `text:${chatId}:${threadId ?? "main"}:${senderIdValue}`;
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
            const spooledReplayParticipant = createSpooledReplayParticipantForBufferedWork(
              `text-fragment:${key}:${msg.message_id}`,
            );
            if (spooledReplayParticipant) {
              existing.spooledReplayParticipants.push(spooledReplayParticipant);
            }
            existing.messages.push({ msg, ctx, receivedAtMs: nowMs });
            existing.promptContextMinTimestampMs = latestPromptContextMinTimestampMs(
              existing.promptContextMinTimestampMs,
              promptContextMinTimestampMs,
            );
            existing.promptContextAmbientWatermark = latestPromptContextAmbientWatermark(
              existing.promptContextAmbientWatermark,
              promptContextAmbientWatermark,
            );
            existing.dispatchDedupeKeys = mergeDispatchDedupeKeys(
              existing.dispatchDedupeKeys,
              dispatchDedupeKeys,
            );
            scheduleTextFragmentFlush(existing);
            return;
          }
        }

        // Not appendable (or limits exceeded): flush buffered entry first, then continue normally.
        clearTimeout(existing.timer);
        textFragmentBuffer.delete(key);
        await queueTextFragmentFlush(existing);
      }

      const shouldStart = text.length >= TELEGRAM_TEXT_FRAGMENT_START_THRESHOLD_CHARS;
      if (shouldStart) {
        const spooledReplayParticipant = createSpooledReplayParticipantForBufferedWork(
          `text-fragment:${key}:${msg.message_id}`,
        );
        const entry: TextFragmentEntry = {
          key,
          storeAllowFrom,
          messages: [{ msg, ctx, receivedAtMs: nowMs }],
          dispatchDedupeKeys,
          spooledReplayParticipants: spooledReplayParticipant ? [spooledReplayParticipant] : [],
          ...promptContextBoundaryOptions(
            promptContextMinTimestampMs,
            promptContextAmbientWatermark,
          ),
          timer: setTimeout(() => {}, TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS),
        };
        textFragmentBuffer.set(key, entry);
        scheduleTextFragmentFlush(entry);
        return;
      }
    } else if (text && isAbortControlMessage && (await isAuthorizedAbortControlMessage())) {
      const senderIdLocal = msg.from?.id != null ? String(msg.from.id) : "unknown";
      const threadId = resolvedThreadId ?? dmThreadId;
      const key = `text:${chatId}:${threadId ?? "main"}:${senderIdLocal}`;
      const existing = textFragmentBuffer.get(key);
      if (existing) {
        clearTimeout(existing.timer);
        textFragmentBuffer.delete(key);
        releaseDispatchDedupeKeys(existing.dispatchDedupeKeys);
        settleSpooledReplayParticipants(existing.spooledReplayParticipants, { kind: "skipped" });
      }
    }

    // Media group handling - buffer multi-image messages
    const mediaGroupId = msg.media_group_id;
    if (mediaGroupId) {
      const threadId = resolvedThreadId ?? dmThreadId;
      const mediaGroupKey = `media:${chatId}:${threadId ?? "main"}:${mediaGroupId}`;
      const existing = mediaGroupBuffer.get(mediaGroupKey);
      if (existing) {
        const spooledReplayParticipant = createSpooledReplayParticipantForBufferedWork(
          `media-group:${mediaGroupKey}:${msg.message_id}`,
        );
        if (spooledReplayParticipant) {
          existing.spooledReplayParticipants.push(spooledReplayParticipant);
        }
        clearTimeout(existing.timer);
        existing.messages.push({ msg, ctx });
        existing.promptContextMinTimestampMs = latestPromptContextMinTimestampMs(
          existing.promptContextMinTimestampMs,
          promptContextMinTimestampMs,
        );
        existing.promptContextAmbientWatermark = latestPromptContextAmbientWatermark(
          existing.promptContextAmbientWatermark,
          promptContextAmbientWatermark,
        );
        existing.dispatchDedupeKeys = mergeDispatchDedupeKeys(
          existing.dispatchDedupeKeys,
          dispatchDedupeKeys,
        );
        existing.timer = setTimeout(() => {
          mediaGroupBuffer.delete(mediaGroupKey);
          void queueBufferedProcessing(mediaGroupProcessingQueue, mediaGroupKey, async () => {
            await processMediaGroup(existing);
          });
        }, mediaGroupTimeoutMs);
      } else {
        const spooledReplayParticipant = createSpooledReplayParticipantForBufferedWork(
          `media-group:${mediaGroupKey}:${msg.message_id}`,
        );
        const entry: BufferedMediaGroupEntry = {
          authorizationCfg,
          messages: [{ msg, ctx }],
          storeAllowFrom,
          isGroup,
          isForum,
          resolvedThreadId,
          dmThreadId,
          senderId,
          effectiveGroupAllow,
          effectiveDmAllow,
          groupConfig,
          topicConfig,
          dispatchDedupeKeys,
          spooledReplayParticipants: spooledReplayParticipant ? [spooledReplayParticipant] : [],
          ...promptContextBoundaryOptions(
            promptContextMinTimestampMs,
            promptContextAmbientWatermark,
          ),
          timer: setTimeout(() => {
            mediaGroupBuffer.delete(mediaGroupKey);
            void queueBufferedProcessing(mediaGroupProcessingQueue, mediaGroupKey, async () => {
              await processMediaGroup(entry);
            });
          }, mediaGroupTimeoutMs),
        };
        mediaGroupBuffer.set(mediaGroupKey, entry);
      }
      return;
    }

    if (
      await shouldSkipMediaDownloadForUnaddressedMentionGroup({
        authorizationCfg,
        ctx,
        msg,
        chatId,
        isGroup,
        isForum,
        resolvedThreadId,
        dmThreadId,
        senderId,
        effectiveGroupAllow,
        effectiveDmAllow,
        groupConfig,
        topicConfig,
      })
    ) {
      releaseDispatchDedupeKeys(dispatchDedupeKeys);
      return;
    }

    let media: Awaited<ReturnType<typeof resolveMedia>>;
    try {
      media = await resolveMedia({
        ctx,
        maxBytes: mediaMaxBytes,
        ...mediaRuntimeWithAbort,
      });
    } catch (mediaErr) {
      if (isMediaSizeLimitError(mediaErr)) {
        if (sendOversizeWarning) {
          const limitMb =
            mediaErr instanceof TelegramBotApiFileTooLargeError
              ? Math.min(mediaErr.limitMb, Math.round(mediaMaxBytes / (1024 * 1024)))
              : Math.round(mediaMaxBytes / (1024 * 1024));
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
        releaseDispatchDedupeKeys(dispatchDedupeKeys);
        return;
      }
      logger.warn({ chatId, error: String(mediaErr) }, "media fetch failed");
      const retryable = isDurablyRetryableInboundMediaError(mediaErr);
      if (retryable) {
        recordTelegramMessageProcessingResult({ kind: "failed-retryable", error: mediaErr });
      }
      if (!(retryable && isTelegramSpooledReplayUpdate(ctx.update))) {
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
      }
      releaseDispatchDedupeKeys(dispatchDedupeKeys, retryable ? mediaErr : undefined);
      return;
    }

    // Skip sticker-only messages where the sticker was skipped (animated/video)
    // These have no media and no text content to process.
    const hasText = Boolean(getTelegramTextParts(msg).text.trim());
    if (msg.sticker && !media && !hasText) {
      logVerbose("telegram: skipping sticker-only message (unsupported sticker type)");
      releaseDispatchDedupeKeys(dispatchDedupeKeys);
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
    if (senderId && (await isAuthorizedAbortControlMessage())) {
      for (const lane of ["default", "forward"] as const) {
        inboundDebouncer.cancelKey(
          buildTelegramInboundDebounceKey({
            accountId,
            conversationKey,
            senderId,
            debounceLane: lane,
          }),
        );
      }
    }
    const debounceEntry: TelegramDebounceEntry = {
      ctx,
      msg,
      allMedia,
      storeAllowFrom,
      receivedAtMs: Date.now(),
      debounceKey: isAbortControlMessage ? null : debounceKey,
      debounceLane,
      botUsername,
      ...promptContextBoundaryOptions(promptContextMinTimestampMs, promptContextAmbientWatermark),
      dispatchDedupeKeys,
    };
    if (
      debounceEntry.debounceKey &&
      resolveTelegramDebounceEntryMs(debounceEntry) > 0 &&
      shouldDebounceTelegramEntry(debounceEntry)
    ) {
      debounceEntry.spooledReplayParticipant = createSpooledReplayParticipantForBufferedWork(
        `inbound-debounce:${debounceEntry.debounceKey}`,
      );
    }
    await inboundDebouncer.enqueue(debounceEntry);
  };
  bot.on("callback_query", async (ctx) => {
    const callback = ctx.callbackQuery;
    if (!callback) {
      return;
    }
    if (shouldSkipUpdate(ctx)) {
      return;
    }
    const answerCallbackQuery = async () => {
      // Answer immediately to prevent Telegram from retrying while we process.
      // Pre-sequentialize middleware usually does this first; this remains the
      // fallback for failed early answers and direct handler tests.
      await withTelegramApiErrorLogging({
        operation: "answerCallbackQuery",
        runtime,
        fn: () => bot.api.answerCallbackQuery(callback.id),
      }).catch(() => {});
    };
    const earlyAnswerPromise = getTelegramCallbackQueryAnswerPromise(ctx);
    if (earlyAnswerPromise) {
      await earlyAnswerPromise.catch(answerCallbackQuery);
    } else {
      await answerCallbackQuery();
    }
    try {
      const data = (callback.data ?? "").trim();
      const callbackMessage = callback.message;
      if (!data || !callbackMessage) {
        return;
      }
      const callbackBusinessParams =
        callbackMessage.business_connection_id !== undefined
          ? { business_connection_id: callbackMessage.business_connection_id }
          : undefined;
      const withCallbackBusinessParams = <T extends object>(params: T) =>
        callbackBusinessParams ? { ...callbackBusinessParams, ...params } : params;
      const editCallbackMessage = async (
        text: string,
        params?: Parameters<typeof bot.api.editMessageText>[3],
      ) => {
        return await bot.api.editMessageText(
          callbackMessage.chat.id,
          callbackMessage.message_id,
          text,
          params ? withCallbackBusinessParams(params) : callbackBusinessParams,
        );
      };
      const clearCallbackButtons = async () => {
        const emptyKeyboard = { inline_keyboard: [] };
        const replyMarkup = { reply_markup: emptyKeyboard };
        return await bot.api.editMessageReplyMarkup(
          callbackMessage.chat.id,
          callbackMessage.message_id,
          withCallbackBusinessParams(replyMarkup),
        );
      };
      const editCallbackButtons = async (
        buttons: Array<
          Array<{ text: string; callback_data: string; style?: "danger" | "success" | "primary" }>
        >,
      ) => {
        const keyboard = buildInlineKeyboard(buttons) ?? { inline_keyboard: [] };
        const replyMarkup = { reply_markup: keyboard };
        return await bot.api.editMessageReplyMarkup(
          callbackMessage.chat.id,
          callbackMessage.message_id,
          withCallbackBusinessParams(replyMarkup),
        );
      };
      const deleteCallbackMessage = async () => {
        return await bot.api.deleteMessage(callbackMessage.chat.id, callbackMessage.message_id);
      };
      const replyToCallbackChat = async (
        text: string,
        params?: Parameters<typeof bot.api.sendMessage>[2],
      ) => {
        const threadParams = buildTelegramThreadParams(
          resolveTelegramThreadSpec({
            isGroup,
            isForum,
            messageThreadId: callbackMessage.message_thread_id,
          }),
        );
        const topicParams = {
          ...callbackBusinessParams,
          ...threadParams,
          ...(callbackMessage.direct_messages_topic?.topic_id != null
            ? { direct_messages_topic_id: callbackMessage.direct_messages_topic.topic_id }
            : {}),
        };
        const replyParams =
          Object.keys(topicParams).length > 0 || params ? { ...topicParams, ...params } : params;
        return await bot.api.sendMessage(callbackMessage.chat.id, text, replyParams);
      };

      const chatId = callbackMessage.chat.id;
      const isGroup =
        callbackMessage.chat.type === "group" || callbackMessage.chat.type === "supergroup";
      const nativeCallbackCommand = parseTelegramNativeCommandCallbackData(data);
      const opaqueCallbackData = parseTelegramOpaqueCallbackData(data);
      const genericCallbackText = data.startsWith("/") ? data : `callback_data: ${data}`;
      const callbackCommandText =
        nativeCallbackCommand ?? (opaqueCallbackData ? "" : genericCallbackText);
      const pluginCallbackData = opaqueCallbackData ?? data;
      const approvalCallback = parseExecApprovalCommandText(
        nativeCallbackCommand ?? (opaqueCallbackData ? "" : data),
      );
      const isApprovalCallback = approvalCallback !== null;
      const authorizationCfg = telegramDeps.getRuntimeConfig();
      const inlineButtonsScope = resolveTelegramInlineButtonsScope({
        cfg: authorizationCfg,
        accountId,
      });
      const execApprovalButtonsEnabled =
        isApprovalCallback &&
        shouldEnableTelegramExecApprovalButtons({
          cfg: authorizationCfg,
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
        isTopicMessage: callbackMessage.is_topic_message,
        getChat,
      });
      const senderId = callback.from?.id ? String(callback.from.id) : "";
      const senderUsername = callback.from?.username ?? "";
      const eventAuthContext = await resolveTelegramEventAuthorizationContext({
        cfg: authorizationCfg,
        chatId,
        isGroup,
        isForum,
        senderId,
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
      const authorizationMode: TelegramEventAuthorizationMode =
        !isGroup || (!execApprovalButtonsEnabled && inlineButtonsScope === "allowlist")
          ? "callback-allowlist"
          : "callback-scope";
      const senderAuthorization = await authorizeTelegramEventSender({
        chatId,
        chatTitle: callbackMessage.chat.title,
        isGroup,
        senderId,
        senderUsername,
        mode: authorizationMode,
        context: eventAuthContext,
      });
      if (!senderAuthorization) {
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
      const runtimeCfg = eventAuthContext.cfg;
      const pluginCallback = await dispatchTelegramPluginInteractiveHandler({
        data: pluginCallbackData,
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
            isAuthorizedSender: await isTelegramModelCallbackAuthorized({
              chatId,
              isGroup,
              senderId,
              senderUsername,
              context: eventAuthContext,
            }),
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
        afterInvoke: async (result) => {
          if (result?.handled === false) {
            return;
          }
          const submitText = resolvePluginCallbackSubmitText(result?.submitText);
          if (!submitText) {
            return;
          }
          const { ctx: syntheticCtx, message: syntheticMessage } =
            buildCallbackSyntheticTextContext({
              ctx,
              callbackMessage,
              callback,
              text: submitText,
              isForum,
            });
          const submitOutcome = await processPluginCallbackSubmitText({
            callbackId: callback.id,
            syntheticCtx,
            syntheticMessage,
            storeAllowFrom,
          });
          if (submitOutcome === "skipped") {
            return;
          }
          // The agent turn already completed. Cleanup failure must not release
          // callback dedupe and replay the submitted turn.
          await clearCallbackButtons().catch((err: unknown) => {
            logVerbose(`telegram plugin callback button cleanup skipped: ${String(err)}`);
          });
        },
      });
      if (pluginCallback.handled) {
        return;
      }

      const managedSelectCallback = parseTelegramManagedSelectCallback(data);
      if (managedSelectCallback) {
        if (
          managedSelectCallback.type === "multi-toggle" ||
          managedSelectCallback.type === "multi-clear"
        ) {
          const buttons = updateMultiSelectKeyboard(
            callbackMessage,
            managedSelectCallback.type === "multi-clear" ? "clear" : "toggle",
            managedSelectCallback.type === "multi-toggle" ? managedSelectCallback.value : "",
          );
          if (buttons.length > 0) {
            try {
              await editCallbackButtons(buttons);
            } catch (editErr) {
              if (!String(editErr).includes("message is not modified")) {
                throw new TelegramRetryableCallbackError(editErr);
              }
            }
          }
          return;
        }

        if (managedSelectCallback.type === "multi-submit") {
          const selected = resolveMultiSelectedValues(cloneInlineKeyboardButtons(callbackMessage));
          const synthetic = buildCallbackSyntheticTextContext({
            ctx,
            callbackMessage,
            callback,
            text: `Multi-select submitted: ${selected.length > 0 ? selected.join(", ") : "none"}`,
            isForum,
          });
          await processMessageWithReplyChain({
            ctx: synthetic.ctx,
            msg: synthetic.message,
            allMedia: [],
            storeAllowFrom,
            options: {
              forceWasMentioned: true,
              messageIdOverride: callback.id,
            },
          });
          return;
        }

        try {
          await clearCallbackButtons();
        } catch (editErr) {
          const errStr = String(editErr);
          if (
            !errStr.includes("message is not modified") &&
            !errStr.includes("there is no text in the message to edit")
          ) {
            throw new TelegramRetryableCallbackError(editErr);
          }
        }
        const synthetic = buildCallbackSyntheticTextContext({
          ctx,
          callbackMessage,
          callback,
          text: `Single-select submitted: ${managedSelectCallback.value}`,
          isForum,
        });
        await processMessageWithReplyChain({
          ctx: synthetic.ctx,
          msg: synthetic.message,
          allMedia: [],
          storeAllowFrom,
          options: {
            forceWasMentioned: true,
            messageIdOverride: callback.id,
          },
        });
        return;
      }

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
          if (isApprovalNotFoundError(resolveErr)) {
            if (isPluginApproval || pluginApprovalAuthorizedSender) {
              try {
                await clearCallbackButtons();
              } catch (editErr) {
                logVerbose(
                  `telegram: failed to clear expired approval callback buttons: ${String(editErr)}`,
                );
              }
            }
            return;
          }
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

      if (opaqueCallbackData) {
        return;
      }

      const paginationMatch = data.match(/^commands_page_(\d+|noop)(?::(.+))?$/);
      if (paginationMatch) {
        const pageValue = paginationMatch[1];
        if (pageValue === "noop") {
          return;
        }

        const page = parseStrictPositiveInteger(pageValue);
        if (page === undefined) {
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
          !(await isTelegramModelCallbackAuthorized({
            chatId,
            isGroup,
            senderId,
            senderUsername,
            context: eventAuthContext,
          }))
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
            botHasTopicsEnabled: resolveTelegramBotHasTopicsEnabled(ctx.me),
            senderId,
            runtimeCfg,
          });
          modelData = await telegramDeps.buildModelsProviderData(runtimeCfg, sessionState.agentId);
        } catch (err) {
          throw new TelegramRetryableCallbackError(err);
        }
        const {
          byProvider,
          providers,
          modelNames,
          resolvedDefault: activeResolvedDefault,
        } = modelData;

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

          // Resolve current model from session (prefer overrides), then the active default.
          const currentModel =
            sessionState.model ||
            `${activeResolvedDefault.provider}/${activeResolvedDefault.model}`;

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
            cfg: runtimeCfg,
            agentDir: resolveAgentDir(runtimeCfg, sessionState.agentId),
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
              await patchSessionEntry({
                storePath,
                sessionKey: sessionState.sessionKey,
                fallbackEntry: {
                  sessionId: randomUUID(),
                  updatedAt: Date.now(),
                },
                replaceEntry: true,
                update: (entry) => {
                  applyModelOverrideToSessionEntry({
                    entry,
                    selection: {
                      provider: selection.provider,
                      model: selection.model,
                      isDefault: isDefaultSelection,
                    },
                  });
                  return entry;
                },
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
            const scopeText = isDefaultSelection
              ? "Session selection cleared. Runtime unchanged. New replies use the agent's configured default."
              : `Session-only model selection. Runtime unchanged. Use /model ${escapeHtml(selection.provider)}/${escapeHtml(selection.model)} --runtime &lt;runtime&gt; to switch harnesses. The agent default in openclaw.json is unchanged; /reset or a new session may return to that default.`;
            await editMessageWithButtons(
              `✅ Model ${actionText}\n\n${scopeText}`,
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

      const syntheticMessage = buildSyntheticTextMessage({
        base: withResolvedTelegramForumFlag(callbackMessage, isForum),
        from: callback.from,
        text: callbackCommandText,
      });
      const syntheticCtx = buildSyntheticContext(ctx, syntheticMessage);
      await processMessageWithReplyChain({
        ctx: syntheticCtx,
        msg: syntheticMessage,
        allMedia: [],
        storeAllowFrom,
        options: {
          ...(nativeCallbackCommand ? { commandSource: "native" as const } : {}),
          forceWasMentioned: true,
          messageIdOverride: callback.id,
        },
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
      if (isTelegramSpooledReplayUpdate(ctx.update)) {
        recordTelegramMessageProcessingResult({ kind: "failed-retryable", error: err });
      }
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
        await mutateConfigFile({
          afterWrite: { mode: "auto" },
          mutate: (draft) => {
            migrateTelegramGroupConfig({ cfg: draft, accountId, oldChatId, newChatId });
          },
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

  const normalizeChannelPostMessage = (post: Message): Message => {
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
    return {
      ...post,
      from: post.from ?? syntheticFrom,
      chat: {
        ...post.chat,
        type: "supergroup" as const,
      },
    } as Message;
  };

  type TelegramInboundGate =
    | { allowed: false }
    | {
        allowed: true;
        context: TelegramEventAuthorizationContext;
        effectiveDmAllow: NormalizedAllowFrom;
      };

  // Single authorization gate for every message-like update that can reach the
  // reply-chain cache or dispatch: fresh messages, edits, channel posts. Must run
  // before any cache/dedupe side effect so blocked content is never recorded.
  // dmAccess "challenge" may send a pairing reply; "silent" only decides (edits
  // must never reply).
  const authorizeInboundMessage = async (params: {
    msg: Message;
    chatId: number;
    isGroup: boolean;
    isForum: boolean;
    messageThreadId?: number;
    senderId: string;
    senderUsername: string;
    requireConfiguredGroup: boolean;
    dmAccess: "challenge" | "silent";
  }): Promise<TelegramInboundGate> => {
    const authorizationCfg = telegramDeps.getRuntimeConfig();
    const context = await resolveTelegramEventAuthorizationContext({
      cfg: authorizationCfg,
      chatId: params.chatId,
      isGroup: params.isGroup,
      isForum: params.isForum,
      senderId: params.senderId,
      messageThreadId: params.messageThreadId,
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
      telegramCfg: authorizationTelegramCfg,
      allowFrom: authorizationAllowFrom,
    } = context;
    // For DMs, prefer per-DM/topic allowFrom (groupAllowOverride) over account-level allowFrom
    const expandedDmAllowFrom = await expandTelegramAllowFromWithAccessGroups({
      cfg: authorizationCfg,
      allowFrom: groupAllowOverride ?? authorizationAllowFrom,
      accountId,
      senderId: params.senderId,
    });
    const effectiveDmAllow = normalizeDmAllowFromWithStore({
      allowFrom: expandedDmAllowFrom,
      storeAllowFrom,
      dmPolicy,
    });

    if (params.requireConfiguredGroup && (!groupConfig || groupConfig.enabled === false)) {
      logVerbose(`Blocked telegram channel ${params.chatId} (channel disabled)`);
      return { allowed: false };
    }

    if (
      shouldSkipGroupMessage({
        isGroup: params.isGroup,
        chatId: params.chatId,
        chatTitle: params.msg.chat.title,
        resolvedThreadId,
        senderId: params.senderId,
        senderUsername: params.senderUsername,
        effectiveGroupAllow,
        hasGroupAllowOverride,
        groupConfig,
        topicConfig,
        cfg: authorizationCfg,
        telegramCfg: authorizationTelegramCfg,
      })
    ) {
      return { allowed: false };
    }

    if (!params.isGroup) {
      const requireTopic =
        groupConfig && "requireTopic" in groupConfig ? groupConfig.requireTopic : undefined;
      if (requireTopic === true && dmThreadId == null) {
        logVerbose(`Blocked telegram DM ${params.chatId}: requireTopic=true but no topic present`);
        return { allowed: false };
      }
      const dmAuthorized =
        params.dmAccess === "challenge"
          ? await enforceTelegramDmAccess({
              isGroup: params.isGroup,
              dmPolicy,
              msg: params.msg,
              chatId: params.chatId,
              effectiveDmAllow,
              accountId,
              bot,
              logger,
              upsertPairingRequest: telegramDeps.upsertChannelPairingRequest,
            })
          : await isTelegramDmAccessAllowed({
              dmPolicy,
              msg: params.msg,
              chatId: params.chatId,
              effectiveDmAllow,
              accountId,
            });
      if (!dmAuthorized) {
        return { allowed: false };
      }
    }

    return { allowed: true, context, effectiveDmAllow };
  };

  const recordEditedMessageForReplyChain = async (params: {
    ctxForDedupe: TelegramUpdateKeyContext;
    msg: Message;
    requireConfiguredGroup: boolean;
  }) => {
    if (shouldSkipUpdate(params.ctxForDedupe)) {
      return;
    }
    const msg = params.msg;
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
    const isForum = await resolveTelegramForumFlag({
      chatId: msg.chat.id,
      chatType: msg.chat.type,
      isGroup,
      isForum: msg.chat.is_forum,
      isTopicMessage: msg.is_topic_message,
      getChat,
    });
    const normalizedMsg = withResolvedTelegramForumFlag(msg, isForum);
    const gate = await authorizeInboundMessage({
      msg: normalizedMsg,
      chatId: normalizedMsg.chat.id,
      isGroup,
      isForum,
      messageThreadId: normalizedMsg.message_thread_id,
      senderId: normalizedMsg.from?.id != null ? String(normalizedMsg.from.id) : "",
      senderUsername: normalizedMsg.from?.username ?? "",
      requireConfiguredGroup: params.requireConfiguredGroup,
      dmAccess: "silent",
    });
    if (!gate.allowed) {
      return;
    }
    const { resolvedThreadId, dmThreadId } = gate.context;
    await recordMessageForReplyChain(normalizedMsg, resolvedThreadId ?? dmThreadId);
  };

  const handleInboundMessageLike = async (event: InboundTelegramEvent) => {
    let dispatchDedupeKeys: string[] = [];
    try {
      if (shouldSkipUpdate(event.ctxForDedupe)) {
        return;
      }
      const gate = await authorizeInboundMessage({
        msg: event.msg,
        chatId: event.chatId,
        isGroup: event.isGroup,
        isForum: event.isForum,
        messageThreadId: event.messageThreadId,
        senderId: event.senderId,
        senderUsername: event.senderUsername,
        requireConfiguredGroup: event.requireConfiguredGroup,
        dmAccess: "challenge",
      });
      if (!gate.allowed) {
        return;
      }
      const { effectiveDmAllow } = gate;
      const {
        dmPolicy,
        resolvedThreadId,
        dmThreadId,
        storeAllowFrom,
        groupConfig,
        topicConfig,
        effectiveGroupAllow,
      } = gate.context;

      const sessionState = resolveTelegramSessionState({
        chatId: event.chatId,
        isGroup: event.isGroup,
        isForum: event.isForum,
        messageThreadId: event.messageThreadId,
        resolvedThreadId,
        botHasTopicsEnabled: resolveTelegramBotHasTopicsEnabled(event.ctx.me),
        senderId: event.senderId,
        runtimeCfg: gate.context.cfg,
      });
      const promptContextMinTimestampMs = normalizePromptContextMinTimestampMs(
        sessionState.sessionEntry?.sessionStartedAt,
      );
      const promptContextAmbientWatermark = resolvePromptContextAmbientWatermark({
        chatId: event.chatId,
        isGroup: event.isGroup,
        resolvedThreadId,
        sessionKey: sessionState.sessionKey,
        storePath: sessionState.storePath,
      });

      const dispatchDedupe = await claimMessageDispatchDedupe(event.msg);
      if (!dispatchDedupe.process) {
        return;
      }
      dispatchDedupeKeys = dispatchDedupe.keys;
      await recordMessageForReplyChain(event.msg, resolvedThreadId ?? dmThreadId);
      await processInboundMessage({
        authorizationCfg: gate.context.cfg,
        ctx: event.ctx,
        msg: event.msg,
        chatId: event.chatId,
        isGroup: event.isGroup,
        isForum: event.isForum,
        resolvedThreadId,
        dmThreadId,
        dmPolicy,
        storeAllowFrom,
        senderId: event.senderId,
        effectiveGroupAllow,
        effectiveDmAllow,
        groupConfig: event.isGroup ? (groupConfig as TelegramGroupConfig | undefined) : undefined,
        topicConfig,
        sendOversizeWarning: event.sendOversizeWarning,
        oversizeLogMessage: event.oversizeLogMessage,
        dispatchDedupeKeys,
        ...promptContextBoundaryOptions(promptContextMinTimestampMs, promptContextAmbientWatermark),
      });
    } catch (err) {
      releaseDispatchDedupeKeys(dispatchDedupeKeys, err);
      runtime.error?.(danger(`${event.errorMessage}: ${String(err)}`));
      const spooledReplay = isTelegramSpooledReplayUpdate(event.ctx.update);
      if (err instanceof TelegramPairingStoreReadError || spooledReplay) {
        recordTelegramMessageProcessingResult({ kind: "failed-retryable", error: err });
        // Spooled replays are durably retried; live updates get one apology
        // because they are acked without replay.
        if (spooledReplay) {
          return;
        }
        await withTelegramApiErrorLogging({
          operation: "sendMessage",
          runtime,
          fn: () =>
            bot.api.sendMessage(
              event.chatId,
              "⚠️ Couldn't process this message, please try again in a moment.",
              {
                reply_parameters: {
                  message_id: event.msg.message_id,
                  allow_sending_without_reply: true,
                },
              },
            ),
        }).catch(() => {});
      }
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
      isTopicMessage: msg.is_topic_message,
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

  bot.on("edited_message", async (ctx) => {
    const msg = ctx.editedMessage;
    if (!msg) {
      return;
    }
    await recordEditedMessageForReplyChain({
      ctxForDedupe: ctx,
      msg,
      requireConfiguredGroup: false,
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
    const syntheticMsg = normalizeChannelPostMessage(post);

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

  bot.on("edited_channel_post", async (ctx) => {
    const post = ctx.editedChannelPost;
    if (!post) {
      return;
    }
    await recordEditedMessageForReplyChain({
      ctxForDedupe: ctx,
      msg: normalizeChannelPostMessage(post),
      requireConfiguredGroup: true,
    });
  });
};
