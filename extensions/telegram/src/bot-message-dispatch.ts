import path from "node:path";
import type { Bot } from "grammy";
import {
  appendSessionTranscriptMessage,
  emitSessionTranscriptUpdate,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  DEFAULT_TIMING,
  logAckFailure,
  logTypingFailure,
  removeAckReactionAfterReply,
} from "openclaw/plugin-sdk/channel-feedback";
import {
  formatInboundEnvelope,
  resolveEnvelopeFormatOptions,
  runChannelInboundEvent,
} from "openclaw/plugin-sdk/channel-inbound";
import { CURRENT_MESSAGE_MARKER } from "openclaw/plugin-sdk/channel-mention-gating";
import {
  createChannelMessageReplyPipeline,
  createOutboundPayloadPlan,
  deriveDurableFinalDeliveryRequirements,
  projectOutboundPayloadPlanForDelivery,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  buildChannelProgressDraftLineForEntry,
  createChannelProgressDraftGate,
  type ChannelProgressDraftLine,
  formatChannelProgressDraftLine,
  formatChannelProgressDraftLineForEntry,
  formatChannelProgressDraftText,
  isChannelProgressDraftWorkToolName,
  mergeChannelProgressDraftLine,
  resolveChannelProgressDraftMaxLines,
  resolveChannelStreamingBlockEnabled,
  resolveChannelStreamingPreviewNativeToolProgress,
  resolveChannelStreamingPreviewNativeToolProgressAllowFrom,
  resolveChannelStreamingPreviewToolProgress,
  resolveTranscriptBackedChannelFinalText,
} from "openclaw/plugin-sdk/channel-outbound";
import type {
  OpenClawConfig,
  ReplyToMode,
  TelegramAccountConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeMessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import { chunkMarkdownTextWithMode } from "openclaw/plugin-sdk/reply-chunking";
import { createChannelHistoryWindow } from "openclaw/plugin-sdk/reply-history";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import {
  createSubsystemLogger,
  danger,
  logVerbose,
  sleepWithAbort,
} from "openclaw/plugin-sdk/runtime-env";
import { resolveTelegramConfigReasoningDefault } from "./agent-config.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { normalizeAllowFrom } from "./bot-access.js";
import type { TelegramBotDeps } from "./bot-deps.js";
import type { TelegramMessageContext } from "./bot-message-context.js";
import {
  findModelInCatalog,
  loadModelCatalog,
  modelSupportsVision,
  resolveAgentDir,
  resolveDefaultModelForAgent,
} from "./bot-message-dispatch.agent.runtime.js";
import { deduplicateBlockSentMedia } from "./bot-message-dispatch.media-dedup.js";
import { pruneStickerMediaFromContext } from "./bot-message-dispatch.media.js";
import {
  generateTopicLabel,
  getAgentScopedMediaLocalRoots,
  loadSessionStore,
  readLatestAssistantTextFromSessionTranscript,
  resolveAutoTopicLabelConfig,
  resolveChunkMode,
  resolveMarkdownTableMode,
  resolveAndPersistSessionFile,
  resolveSessionStoreEntry,
} from "./bot-message-dispatch.runtime.js";
import type { TelegramBotOptions } from "./bot.types.js";
import { deliverReplies, emitInternalMessageSentHook } from "./bot/delivery.js";
import {
  buildTelegramGroupPeerId,
  buildTelegramGroupFrom,
  buildTelegramInboundOriginTarget,
  buildGroupLabel,
  buildTypingThreadParams,
  getTelegramTextParts,
  resolveTelegramReplyId,
  type TelegramThreadSpec,
} from "./bot/helpers.js";
import {
  addTelegramNativeQuoteCandidate,
  buildTelegramNativeQuoteCandidate,
  type TelegramNativeQuoteCandidateByMessageId,
} from "./bot/native-quote.js";
import type { TelegramStreamMode } from "./bot/types.js";
import { resolveTelegramInlineButtons, type TelegramInlineButtons } from "./button-types.js";
import { createTelegramDraftStream } from "./draft-stream.js";
import {
  buildTelegramErrorScopeKey,
  isSilentErrorPolicy,
  resolveTelegramErrorPolicy,
  shouldSuppressTelegramError,
} from "./error-policy.js";
import { shouldSuppressLocalTelegramExecApprovalPrompt } from "./exec-approvals.js";
import { markdownToTelegramChunks, renderTelegramHtmlText } from "./format.js";
import { beginTelegramInboundEventDeliveryCorrelation } from "./inbound-event-delivery.js";
import {
  createLaneDeliveryStateTracker,
  createLaneTextDeliverer,
  type DraftLaneState,
  type LaneDeliveryResult,
  type LaneName,
} from "./lane-delivery.js";
import { createNativeTelegramToolProgressDraft } from "./native-tool-progress-draft.js";
import { recordOutboundMessageForPromptContext } from "./outbound-message-context.js";
import {
  createTelegramReasoningStepState,
  splitTelegramReasoningText,
} from "./reasoning-lane-coordinator.js";
import { editMessageTelegram } from "./send.js";
import { getTelegramSequentialKey } from "./sequential-key.js";
import { cacheSticker, describeStickerImage } from "./sticker-cache.js";
import {
  beginTelegramReplyFence,
  buildTelegramNonInterruptingReplyFenceKey,
  buildTelegramReplyFenceLaneKey,
  endTelegramReplyFence,
  getTelegramReplyFenceSizeForTests,
  isTelegramReplyFenceSuperseded,
  releaseTelegramReplyFenceAbortController,
  resetTelegramReplyFenceForTests,
  resolveTelegramReplyFenceKey,
  shouldSupersedeTelegramReplyFence,
  supersedeTelegramReplyFence,
} from "./telegram-reply-fence.js";

export { pruneStickerMediaFromContext } from "./bot-message-dispatch.media.js";
export { getTelegramReplyFenceSizeForTests, resetTelegramReplyFenceForTests };

const EMPTY_RESPONSE_FALLBACK = "No response generated. Please try again.";
const silentReplyDispatchLogger = createSubsystemLogger("telegram/silent-reply-dispatch");

/** Minimum chars before sending first streaming message (improves push notification UX) */
const DRAFT_MIN_INITIAL_CHARS = 30;

type DraftPartialTextUpdate = {
  text: string;
  delta?: string;
  replace?: true;
};

function resolveDraftPartialText(
  previous: string,
  update: DraftPartialTextUpdate,
): string | undefined {
  const nextText =
    update.replace || update.delta === undefined ? update.text : `${previous}${update.delta}`;
  if (nextText === previous) {
    return undefined;
  }
  return nextText;
}

function resolvePayloadTelegramInlineButtons(
  payload: ReplyPayload,
): TelegramInlineButtons | undefined {
  const telegramData = payload.channelData?.telegram as
    | { buttons?: TelegramInlineButtons }
    | undefined;
  const presentation = normalizeMessagePresentation(payload.presentation);
  return resolveTelegramInlineButtons({
    buttons: telegramData?.buttons,
    presentation,
    interactive: payload.interactive,
  });
}

function hasExecApprovalPayload(payload: ReplyPayload): boolean {
  const channelData = payload.channelData;
  if (!channelData || typeof channelData !== "object" || Array.isArray(channelData)) {
    return false;
  }
  const execApproval = channelData.execApproval;
  return Boolean(execApproval && typeof execApproval === "object" && !Array.isArray(execApproval));
}

function canUseNativeToolProgressDraft(params: {
  payload: ReplyPayload;
  reply: ReturnType<typeof resolveSendableOutboundReplyParts>;
  buttons?: TelegramInlineButtons;
}): boolean {
  return (
    !params.reply.hasMedia &&
    params.payload.isError !== true &&
    !hasExecApprovalPayload(params.payload) &&
    params.buttons === undefined
  );
}

function canUseNativeToolProgressDraftForChat(params: {
  telegramCfg: TelegramAccountConfig;
  chatId: number | string;
}): boolean {
  if (!resolveChannelStreamingPreviewNativeToolProgress(params.telegramCfg)) {
    return false;
  }
  const allowFrom = resolveChannelStreamingPreviewNativeToolProgressAllowFrom(params.telegramCfg);
  if (!allowFrom || allowFrom.length === 0) {
    return true;
  }
  const normalized = normalizeAllowFrom(allowFrom);
  return normalized.hasWildcard || normalized.entries.includes(String(params.chatId));
}

async function resolveStickerVisionSupport(cfg: OpenClawConfig, agentId: string) {
  try {
    const catalog = await loadModelCatalog({ config: cfg });
    const defaultModel = resolveDefaultModelForAgent({ cfg, agentId });
    const entry = findModelInCatalog(catalog, defaultModel.provider, defaultModel.model);
    if (!entry) {
      return false;
    }
    return modelSupportsVision(entry);
  } catch {
    return false;
  }
}

type DispatchTelegramMessageParams = {
  context: TelegramMessageContext;
  bot: Bot;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  replyToMode: ReplyToMode;
  streamMode: TelegramStreamMode;
  textLimit: number;
  telegramCfg: TelegramAccountConfig;
  telegramDeps?: TelegramBotDeps;
  opts: Pick<TelegramBotOptions, "token" | "mediaMaxMb">;
};

type TelegramReasoningLevel = "off" | "on" | "stream";

type TelegramTranscriptMirrorPayload = { text?: string; mediaUrls?: string[] };
type TelegramSessionStore = ReturnType<typeof loadSessionStore>;
type FreshTelegramSessionStoreLoader = ((agentId: string) => {
  storePath: string;
  store: TelegramSessionStore;
}) & {
  clear: () => void;
};

function createFreshTelegramSessionStoreLoader(params: {
  cfg: OpenClawConfig;
  telegramDeps: TelegramBotDeps;
}): FreshTelegramSessionStoreLoader {
  const storesByPath = new Map<string, TelegramSessionStore>();
  const load = ((agentId: string) => {
    const storePath = params.telegramDeps.resolveStorePath(params.cfg.session?.store, { agentId });
    const cachedStore = storesByPath.get(storePath);
    if (cachedStore) {
      return { storePath, store: cachedStore };
    }
    const store = (params.telegramDeps.loadSessionStore ?? loadSessionStore)(storePath, {
      skipCache: true,
    });
    storesByPath.set(storePath, store);
    return { storePath, store };
  }) as FreshTelegramSessionStoreLoader;
  load.clear = () => storesByPath.clear();
  return load;
}

function resolveTelegramReasoningLevel(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  agentId: string;
  loadFreshSessionStore: FreshTelegramSessionStoreLoader;
}): TelegramReasoningLevel {
  const { cfg, sessionKey, agentId } = params;
  const configDefault = resolveTelegramConfigReasoningDefault(cfg, agentId);
  if (!sessionKey) {
    return configDefault;
  }
  try {
    const { store } = params.loadFreshSessionStore(agentId);
    const entry = resolveSessionStoreEntry({ store, sessionKey }).existing;
    const level = entry?.reasoningLevel;
    if (level === "on" || level === "stream" || level === "off") {
      return level;
    }
  } catch {
    return "off";
  }
  return configDefault;
}

function resolveTelegramMirroredTranscriptText(
  payload: TelegramTranscriptMirrorPayload,
): string | null {
  const mediaUrls = payload.mediaUrls?.filter((url) => url.trim()) ?? [];
  if (mediaUrls.length > 0) {
    return mediaUrls
      .map((url) => {
        const pathname = url.split("#")[0]?.split("?")[0] ?? url;
        const base = path.basename(pathname);
        return base && base !== "." && base !== "/" ? base : "media";
      })
      .join(", ");
  }

  const text = payload.text?.trim();
  return text ? text : null;
}

async function mirrorTelegramAssistantReplyToTranscript(params: {
  cfg: OpenClawConfig;
  route: TelegramMessageContext["route"];
  sessionKey: string;
  loadFreshSessionStore: FreshTelegramSessionStoreLoader;
  payload: TelegramTranscriptMirrorPayload;
}) {
  const text = resolveTelegramMirroredTranscriptText(params.payload);
  if (!text) {
    return;
  }
  const { storePath, store } = params.loadFreshSessionStore(params.route.agentId);
  const sessionEntry = resolveSessionStoreEntry({
    store,
    sessionKey: params.sessionKey,
  }).existing;
  if (!sessionEntry?.sessionId) {
    return;
  }
  const { sessionFile } = await resolveAndPersistSessionFile({
    sessionId: sessionEntry.sessionId,
    sessionKey: params.sessionKey,
    sessionStore: store,
    storePath,
    sessionEntry,
    agentId: params.route.agentId,
    sessionsDir: path.dirname(storePath),
  });
  const message = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai-responses",
    provider: "openclaw",
    model: "delivery-mirror",
    usage: {
      input: 0,
      output: 0,
      total: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      cache: {
        read: 0,
        write: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
  const { messageId, message: appendedMessage } = await appendSessionTranscriptMessage({
    transcriptPath: sessionFile,
    message,
    config: params.cfg,
  });
  emitSessionTranscriptUpdate({
    sessionFile,
    sessionKey: params.sessionKey,
    message: appendedMessage,
    messageId,
  });
}

const MAX_PROGRESS_MARKDOWN_TEXT_CHARS = 300;
const TELEGRAM_GENERAL_TOPIC_ID = 1;

function clipProgressMarkdownText(text: string): string {
  if (text.length <= MAX_PROGRESS_MARKDOWN_TEXT_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_PROGRESS_MARKDOWN_TEXT_CHARS - 1).trimEnd()}…`;
}

function sanitizeProgressMarkdownText(text: string): string {
  return text.replaceAll("`", "'");
}

function formatProgressAsMarkdownCode(text: string): string {
  const clipped = clipProgressMarkdownText(text);
  return `\`${sanitizeProgressMarkdownText(clipped)}\``;
}

function normalizeTelegramThreadId(value: unknown): number | undefined {
  const raw =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(raw)) {
    return undefined;
  }
  const normalized = Math.trunc(raw);
  return normalized > 0 ? normalized : undefined;
}

function resolveTelegramForumThreadScopeFromSessionKey(
  sessionKey: unknown,
): { chatId: string; threadId: number } | undefined {
  if (typeof sessionKey !== "string") {
    return undefined;
  }
  const match = /:telegram:group:(-?\d+):topic:(\d+)(?::|$)/.exec(sessionKey);
  const threadId = normalizeTelegramThreadId(match?.[2]);
  if (!match?.[1] || threadId == null) {
    return undefined;
  }
  return { chatId: match[1], threadId };
}

function resolveDispatchTelegramThreadSpec(params: {
  chatId: TelegramMessageContext["chatId"];
  ctxPayload: TelegramMessageContext["ctxPayload"];
  threadSpec: TelegramThreadSpec;
}): TelegramThreadSpec {
  if (
    params.threadSpec.scope !== "forum" ||
    (params.threadSpec.id != null && params.threadSpec.id !== TELEGRAM_GENERAL_TOPIC_ID)
  ) {
    return params.threadSpec;
  }
  const scopedThread = resolveTelegramForumThreadScopeFromSessionKey(params.ctxPayload.SessionKey);
  const scopedThreadId =
    scopedThread?.chatId === String(params.chatId) ? scopedThread.threadId : undefined;
  const payloadThreadId =
    normalizeTelegramThreadId(params.ctxPayload.MessageThreadId) ??
    normalizeTelegramThreadId(params.ctxPayload.TransportThreadId);
  // Missing forum IDs are normalized to General; topic-scoped turn facts are more specific.
  const recoveredThreadId = scopedThreadId ?? payloadThreadId;
  return recoveredThreadId == null || recoveredThreadId === params.threadSpec.id
    ? params.threadSpec
    : { ...params.threadSpec, id: recoveredThreadId };
}

function extractCurrentTelegramBody(body: string | undefined): string {
  if (!body) {
    return "";
  }
  const markerIndex = body.lastIndexOf(CURRENT_MESSAGE_MARKER);
  if (markerIndex === -1) {
    return body;
  }
  return body.slice(markerIndex + CURRENT_MESSAGE_MARKER.length).trimStart();
}

function buildRecoveredTelegramBody(params: {
  cfg: OpenClawConfig;
  context: TelegramMessageContext;
  currentMessage: string;
  historyKey?: string;
  threadSpec: TelegramThreadSpec;
}): string {
  if (!params.context.isGroup || !params.historyKey || params.context.historyLimit <= 0) {
    return params.currentMessage;
  }
  const groupLabel = buildGroupLabel(
    params.context.msg,
    params.context.chatId,
    params.threadSpec.id,
  );
  const envelopeOptions = resolveEnvelopeFormatOptions(params.cfg);
  return createChannelHistoryWindow({
    historyMap: params.context.groupHistories,
  }).buildPendingContext({
    historyKey: params.historyKey,
    limit: params.context.historyLimit,
    currentMessage: params.currentMessage,
    formatEntry: (entry) =>
      formatInboundEnvelope({
        channel: "Telegram",
        from: groupLabel,
        timestamp: entry.timestamp,
        body: `${entry.body} [id:${entry.messageId ?? "unknown"} chat:${params.context.chatId}]`,
        chatType: "group",
        senderLabel: entry.sender,
        envelope: envelopeOptions,
      }),
  });
}

function buildRecoveredTelegramChatActionSender(params: {
  context: TelegramMessageContext;
  threadId?: number;
  action: "typing" | "record_voice";
}): () => Promise<void> {
  return async () => {
    try {
      await withTelegramApiErrorLogging({
        operation: "sendChatAction",
        fn: () =>
          params.context.sendChatActionHandler.sendChatAction(
            params.context.chatId,
            params.action,
            buildTypingThreadParams(params.threadId),
          ),
      });
    } catch (err) {
      if (params.action !== "record_voice") {
        throw err;
      }
      logVerbose(
        `telegram record_voice cue failed for chat ${params.context.chatId}: ${String(err)}`,
      );
    }
  };
}

function migrateRecoveredTelegramRoomEventHistory(params: {
  context: TelegramMessageContext;
  recoveredHistoryKey?: string;
}) {
  const originalHistoryKey = params.context.historyKey;
  const recoveredHistoryKey = params.recoveredHistoryKey;
  if (
    !params.context.isGroup ||
    params.context.ctxPayload.InboundEventKind !== "room_event" ||
    !originalHistoryKey ||
    !recoveredHistoryKey ||
    originalHistoryKey === recoveredHistoryKey ||
    params.context.historyLimit <= 0
  ) {
    return;
  }
  const originalEntries = params.context.groupHistories.get(originalHistoryKey);
  if (!originalEntries?.length) {
    return;
  }
  const messageId = params.context.ctxPayload.MessageSid;
  const rawBody = params.context.ctxPayload.RawBody;
  const entryIndex = originalEntries.findLastIndex((entry) => {
    if (messageId && entry.messageId === messageId) {
      return true;
    }
    return !messageId && typeof rawBody === "string" && entry.body === rawBody;
  });
  if (entryIndex === -1) {
    return;
  }
  const [entry] = originalEntries.splice(entryIndex, 1);
  if (!entry) {
    return;
  }
  createChannelHistoryWindow({
    historyMap: params.context.groupHistories,
  }).record({
    historyKey: recoveredHistoryKey,
    limit: params.context.historyLimit,
    entry,
  });
}

function resolveDispatchTelegramContext(params: {
  cfg: OpenClawConfig;
  context: TelegramMessageContext;
}): TelegramMessageContext {
  const threadSpec = resolveDispatchTelegramThreadSpec({
    chatId: params.context.chatId,
    ctxPayload: params.context.ctxPayload,
    threadSpec: params.context.threadSpec,
  });
  if (threadSpec === params.context.threadSpec || threadSpec.scope !== "forum") {
    return params.context;
  }
  const recoveredRoutingTarget = buildTelegramInboundOriginTarget(
    params.context.chatId,
    threadSpec,
  );
  const recoveredFrom = params.context.isGroup
    ? buildTelegramGroupFrom(params.context.chatId, threadSpec.id)
    : params.context.ctxPayload.From;
  const recoveredUpdateLastRoute =
    params.context.turn.record.updateLastRoute && threadSpec.id != null
      ? {
          ...params.context.turn.record.updateLastRoute,
          to: `telegram:${params.context.chatId}:topic:${threadSpec.id}`,
          threadId: String(threadSpec.id),
        }
      : params.context.turn.record.updateLastRoute;
  const recoveredHistoryKey = params.context.isGroup
    ? buildTelegramGroupPeerId(params.context.chatId, threadSpec.id)
    : params.context.historyKey;
  migrateRecoveredTelegramRoomEventHistory({
    context: params.context,
    recoveredHistoryKey,
  });
  const recoveredInboundHistory =
    params.context.isGroup && recoveredHistoryKey && params.context.historyLimit > 0
      ? createChannelHistoryWindow({
          historyMap: params.context.groupHistories,
        }).buildInboundHistory({
          historyKey: recoveredHistoryKey,
          limit: params.context.historyLimit,
        })
      : params.context.ctxPayload.InboundHistory;
  const recoveredBodyForAgent = extractCurrentTelegramBody(
    params.context.ctxPayload.BodyForAgent ?? params.context.ctxPayload.Body,
  );
  const recoveredBody = buildRecoveredTelegramBody({
    cfg: params.cfg,
    context: params.context,
    currentMessage: recoveredBodyForAgent,
    historyKey: recoveredHistoryKey,
    threadSpec,
  });
  const recoveredSendTyping = buildRecoveredTelegramChatActionSender({
    context: params.context,
    threadId: threadSpec.id,
    action: "typing",
  });
  const recoveredSendRecordVoice = buildRecoveredTelegramChatActionSender({
    context: params.context,
    threadId: threadSpec.id,
    action: "record_voice",
  });
  return {
    ...params.context,
    historyKey: recoveredHistoryKey,
    threadSpec,
    resolvedThreadId: threadSpec.id,
    replyThreadId: threadSpec.id,
    sendTyping: recoveredSendTyping,
    sendRecordVoice: recoveredSendRecordVoice,
    turn: {
      ...params.context.turn,
      record: {
        ...params.context.turn.record,
        updateLastRoute: recoveredUpdateLastRoute,
      },
    },
    ctxPayload:
      threadSpec.id == null
        ? params.context.ctxPayload
        : {
            ...params.context.ctxPayload,
            Body: recoveredBody,
            BodyForAgent: recoveredBodyForAgent,
            From: recoveredFrom,
            InboundHistory: recoveredInboundHistory,
            MessageThreadId: threadSpec.id,
            OriginatingTo: recoveredRoutingTarget,
            To: recoveredRoutingTarget,
            TransportThreadId: threadSpec.id,
          },
  };
}

export const dispatchTelegramMessage = async ({
  context,
  bot,
  cfg,
  runtime,
  replyToMode,
  streamMode,
  textLimit,
  telegramCfg,
  telegramDeps: injectedTelegramDeps,
  opts,
}: DispatchTelegramMessageParams) => {
  const dispatchStartedAt = Date.now();
  const dispatchContext = resolveDispatchTelegramContext({ cfg, context });
  const telegramDeps =
    injectedTelegramDeps ?? (await import("./bot-deps.js")).defaultTelegramBotDeps;
  const loadFreshSessionStore = createFreshTelegramSessionStoreLoader({ cfg, telegramDeps });
  const {
    ctxPayload,
    msg,
    chatId,
    isGroup,
    groupConfig,
    topicConfig,
    threadSpec,
    historyKey,
    historyLimit,
    groupHistories,
    route,
    skillFilter,
    sendTyping,
    sendRecordVoice,
    ackReactionPromise,
    reactionApi,
    removeAckAfterReply,
    statusReactionController: rawStatusReactionController,
  } = dispatchContext;
  const isRoomEvent = ctxPayload.InboundEventKind === "room_event";
  const statusReactionController = isRoomEvent ? null : rawStatusReactionController;
  const statusReactionTiming = {
    ...DEFAULT_TIMING,
    ...cfg.messages?.statusReactions?.timing,
  };
  const clearTelegramStatusReaction = async () => {
    if (!msg.message_id || !reactionApi) {
      return;
    }
    await reactionApi(chatId, msg.message_id, []);
  };
  const finalizeTelegramStatusReaction = async (params: {
    outcome: "done" | "error";
    hasFinalResponse: boolean;
  }) => {
    if (!statusReactionController) {
      return;
    }
    if (params.outcome === "done") {
      await statusReactionController.setDone();
      if (removeAckAfterReply) {
        await sleepWithAbort(statusReactionTiming.doneHoldMs);
        await clearTelegramStatusReaction();
      } else {
        await statusReactionController.restoreInitial();
      }
      return;
    }
    await statusReactionController.setError();
    if (params.hasFinalResponse) {
      if (removeAckAfterReply) {
        await sleepWithAbort(statusReactionTiming.errorHoldMs);
        await clearTelegramStatusReaction();
      } else {
        await statusReactionController.restoreInitial();
      }
      return;
    }
    if (removeAckAfterReply) {
      await sleepWithAbort(statusReactionTiming.errorHoldMs);
    }
    await statusReactionController.restoreInitial();
  };
  const replyFenceKey = resolveTelegramReplyFenceKey({
    ctxPayload,
    chatId,
    threadSpec,
  });
  const replyFenceLaneKey = getTelegramSequentialKey({
    message: msg,
    ...(context.primaryCtx.me ? { me: context.primaryCtx.me } : {}),
  });
  const scopedReplyFenceLaneKey = buildTelegramReplyFenceLaneKey({
    accountId: route.accountId,
    sequentialKey: replyFenceLaneKey,
  });
  let activeReplyFenceKey = replyFenceKey.activeKey;
  let replyFenceGeneration: number | undefined;
  const replyAbortController = new AbortController();
  let replyAbortControllerQueued = false;
  let dispatchWasSuperseded = false;
  const isDispatchSuperseded = () =>
    replyFenceGeneration !== undefined &&
    isTelegramReplyFenceSuperseded({
      key: activeReplyFenceKey,
      generation: replyFenceGeneration,
    });
  const releaseReplyFence = () => {
    if (replyFenceGeneration === undefined) {
      return;
    }
    endTelegramReplyFence(
      activeReplyFenceKey,
      replyAbortControllerQueued ? undefined : replyAbortController,
    );
    replyFenceGeneration = undefined;
  };
  const draftMaxChars = Math.min(textLimit, 4096);
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "telegram",
    accountId: route.accountId,
  });
  const renderStreamText = (text: string) => ({
    text: renderTelegramHtmlText(text, { tableMode }),
    parseMode: "HTML" as const,
  });
  const accountBlockStreamingEnabled =
    resolveChannelStreamingBlockEnabled(telegramCfg) ??
    cfg.agents?.defaults?.blockStreamingDefault === "on";
  const resolvedReasoningLevel = resolveTelegramReasoningLevel({
    cfg,
    sessionKey: ctxPayload.SessionKey,
    agentId: route.agentId,
    loadFreshSessionStore,
  });
  const forceBlockStreamingForReasoning = resolvedReasoningLevel === "on";
  const streamReasoningDraft = resolvedReasoningLevel === "stream";
  const streamDeliveryEnabled = !isRoomEvent && streamMode !== "off";
  const rawReplyQuoteText =
    ctxPayload.ReplyToIsQuote && typeof ctxPayload.ReplyToQuoteText === "string"
      ? ctxPayload.ReplyToQuoteText
      : undefined;
  const replyQuoteText = ctxPayload.ReplyToIsQuote
    ? rawReplyQuoteText?.trim()
      ? rawReplyQuoteText
      : ctxPayload.ReplyToBody?.trim() || undefined
    : undefined;
  const replyQuoteMessageId =
    replyQuoteText && !ctxPayload.ReplyToIsExternal
      ? resolveTelegramReplyId(ctxPayload.ReplyToId)
      : undefined;
  const replyQuoteByMessageId: TelegramNativeQuoteCandidateByMessageId = {};
  if (replyToMode !== "off") {
    if (replyQuoteText && replyQuoteMessageId != null) {
      addTelegramNativeQuoteCandidate(replyQuoteByMessageId, replyQuoteMessageId, {
        text: replyQuoteText,
        ...(typeof ctxPayload.ReplyToQuotePosition === "number"
          ? { position: ctxPayload.ReplyToQuotePosition }
          : {}),
        ...(Array.isArray(ctxPayload.ReplyToQuoteEntities)
          ? { entities: ctxPayload.ReplyToQuoteEntities }
          : {}),
      });
    }

    addTelegramNativeQuoteCandidate(
      replyQuoteByMessageId,
      ctxPayload.MessageSid ?? msg.message_id,
      buildTelegramNativeQuoteCandidate(getTelegramTextParts(msg)),
    );

    if (!ctxPayload.ReplyToIsExternal && typeof ctxPayload.ReplyToQuoteSourceText === "string") {
      addTelegramNativeQuoteCandidate(
        replyQuoteByMessageId,
        ctxPayload.ReplyToId,
        buildTelegramNativeQuoteCandidate({
          text: ctxPayload.ReplyToQuoteSourceText,
          entities: Array.isArray(ctxPayload.ReplyToQuoteSourceEntities)
            ? ctxPayload.ReplyToQuoteSourceEntities
            : undefined,
        }),
      );
    }
  }
  const hasTelegramQuoteReply = replyToMode !== "off" && replyQuoteText != null;
  const canStreamAnswerDraft =
    streamDeliveryEnabled &&
    !hasTelegramQuoteReply &&
    !accountBlockStreamingEnabled &&
    !forceBlockStreamingForReasoning;
  const canStreamReasoningDraft = !isRoomEvent && streamReasoningDraft;
  const draftReplyToMessageId =
    replyToMode !== "off" && typeof msg.message_id === "number"
      ? (replyQuoteMessageId ?? msg.message_id)
      : undefined;
  const draftMinInitialChars = streamMode === "progress" ? 0 : DRAFT_MIN_INITIAL_CHARS;
  const progressSeed = `${route.accountId}:${chatId}:${threadSpec.id ?? ""}`;
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, route.agentId);
  const createDraftLane = (laneName: LaneName, enabled: boolean): DraftLaneState => {
    const stream = enabled
      ? (telegramDeps.createTelegramDraftStream ?? createTelegramDraftStream)({
          api: bot.api,
          chatId,
          maxChars: draftMaxChars,
          thread: threadSpec,
          replyToMessageId: draftReplyToMessageId,
          minInitialChars: draftMinInitialChars,
          renderText: renderStreamText,
          onSupersededPreview: (superseded) => {
            if (superseded.retain) {
              return;
            }
            void bot.api.deleteMessage(chatId, superseded.messageId).catch((err: unknown) => {
              logVerbose(
                `telegram: superseded ${laneName} stream cleanup failed (${superseded.messageId}): ${String(err)}`,
              );
            });
          },
          log: logVerbose,
          warn: logVerbose,
        })
      : undefined;
    return {
      stream,
      lastPartialText: "",
      hasStreamedMessage: false,
      finalized: false,
    };
  };
  const lanes: Record<LaneName, DraftLaneState> = {
    answer: createDraftLane("answer", canStreamAnswerDraft),
    reasoning: createDraftLane("reasoning", canStreamReasoningDraft),
  };
  const answerLane = lanes.answer;
  const reasoningLane = lanes.reasoning;
  const streamToolProgressEnabled =
    Boolean(answerLane.stream) && resolveChannelStreamingPreviewToolProgress(telegramCfg);
  const nativeToolProgressDraft =
    streamToolProgressEnabled &&
    !isRoomEvent &&
    !isGroup &&
    threadSpec.scope === "dm" &&
    canUseNativeToolProgressDraftForChat({ telegramCfg, chatId })
      ? (
          telegramDeps.createNativeTelegramToolProgressDraft ??
          createNativeTelegramToolProgressDraft
        )({
          api: bot.api,
          chatId,
          thread: threadSpec,
          log: logVerbose,
        })
      : undefined;
  let streamToolProgressSuppressed = false;
  let streamToolProgressLines: Array<string | ChannelProgressDraftLine> = [];
  let lastAnswerPartialText = "";
  let activeAnswerDraftIsToolProgressOnly = false;
  function resetAnswerToolProgressDraft() {
    activeAnswerDraftIsToolProgressOnly = false;
  }
  async function prepareAnswerLaneForToolProgress() {
    if (activeAnswerDraftIsToolProgressOnly) {
      return;
    }
    if (answerLane.hasStreamedMessage) {
      await rotateLaneForNewMessage(answerLane);
    }
    activeAnswerDraftIsToolProgressOnly = true;
  }
  const renderProgressDraft = async (options?: { flush?: boolean }): Promise<boolean> => {
    if (!answerLane.stream || streamMode !== "progress") {
      return false;
    }
    const streamText = formatChannelProgressDraftText({
      entry: telegramCfg,
      lines: streamToolProgressLines,
      seed: progressSeed,
      formatLine: formatProgressAsMarkdownCode,
    });
    if (!streamText || streamText === answerLane.lastPartialText) {
      return false;
    }
    await prepareAnswerLaneForToolProgress();
    answerLane.lastPartialText = streamText;
    answerLane.hasStreamedMessage = true;
    answerLane.finalized = false;
    answerLane.stream.update(streamText);
    if (options?.flush) {
      await answerLane.stream.flush();
    }
    return true;
  };
  const progressDraftGate = createChannelProgressDraftGate({
    onStart: async () => {
      await renderProgressDraft({ flush: true });
    },
  });
  let finalAnswerDeliveryStarted = false;
  let finalAnswerDelivered = false;
  const pushStreamToolProgress = async (
    line?: string | ChannelProgressDraftLine,
    options?: { toolName?: string; startImmediately?: boolean },
  ) => {
    if (!answerLane.stream) {
      return false;
    }
    if (answerLane.finalized || finalAnswerDeliveryStarted || finalAnswerDelivered) {
      return false;
    }
    if (options?.toolName !== undefined && !isChannelProgressDraftWorkToolName(options.toolName)) {
      return false;
    }
    const rawText = typeof line === "string" ? line : line?.text;
    const normalized = sanitizeProgressMarkdownText(rawText?.replace(/\s+/g, " ").trim() ?? "");
    if (streamToolProgressSuppressed) {
      return false;
    }
    if (streamMode !== "progress" && !streamToolProgressEnabled) {
      return false;
    }
    const shouldUpdateProgressLines =
      streamToolProgressEnabled && !streamToolProgressSuppressed && Boolean(normalized);
    if (!shouldUpdateProgressLines && streamMode !== "progress") {
      return false;
    }
    const progressLine =
      typeof line === "object" && line !== undefined ? { ...line, text: normalized } : normalized;
    const nextLines = shouldUpdateProgressLines
      ? mergeChannelProgressDraftLine(streamToolProgressLines, progressLine, {
          maxLines: resolveChannelProgressDraftMaxLines(telegramCfg),
        })
      : streamToolProgressLines;
    if (shouldUpdateProgressLines && nextLines === streamToolProgressLines) {
      return false;
    }
    if (nativeToolProgressDraft && shouldUpdateProgressLines) {
      const streamText = formatChannelProgressDraftText({
        entry: telegramCfg,
        lines: nextLines,
        seed: progressSeed,
      });
      if (streamText && (await nativeToolProgressDraft.update(streamText))) {
        streamToolProgressLines = nextLines;
        return true;
      }
    }
    if (streamMode !== "progress") {
      streamToolProgressLines = nextLines;
      const streamText = formatChannelProgressDraftText({
        entry: telegramCfg,
        lines: streamToolProgressLines,
        seed: progressSeed,
        formatLine: formatProgressAsMarkdownCode,
      });
      await prepareAnswerLaneForToolProgress();
      answerLane.lastPartialText = streamText;
      answerLane.hasStreamedMessage = true;
      answerLane.finalized = false;
      answerLane.stream.update(streamText);
      return true;
    }
    streamToolProgressLines = nextLines;
    if (options?.startImmediately) {
      const alreadyStarted = progressDraftGate.hasStarted;
      await progressDraftGate.startNow();
      if (alreadyStarted && progressDraftGate.hasStarted) {
        await renderProgressDraft();
        return true;
      }
      return progressDraftGate.hasStarted;
    }
    const alreadyStarted = progressDraftGate.hasStarted;
    await progressDraftGate.noteWork();
    if (alreadyStarted && progressDraftGate.hasStarted) {
      await renderProgressDraft();
      return true;
    }
    return false;
  };
  let splitReasoningOnNextStream = false;
  let draftLaneEventQueue = Promise.resolve();
  const reasoningStepState = createTelegramReasoningStepState();
  const enqueueDraftLaneEvent = (task: () => Promise<void>): Promise<void> => {
    const next = draftLaneEventQueue.then(async () => {
      if (isDispatchSuperseded()) {
        return;
      }
      await task();
    });
    draftLaneEventQueue = next.catch((err) => {
      logVerbose(`telegram: draft lane callback failed: ${String(err)}`);
    });
    return draftLaneEventQueue;
  };
  type SplitLaneSegment = { lane: LaneName; update: DraftPartialTextUpdate };
  type SplitLaneSegmentsResult = {
    segments: SplitLaneSegment[];
    suppressedReasoningOnly: boolean;
  };
  const splitTextIntoLaneSegments = (
    update: { text?: string; delta?: string; replace?: true },
    isReasoning?: boolean,
  ): SplitLaneSegmentsResult => {
    const split = splitTelegramReasoningText(update.text, isReasoning);
    const splitSegments: Array<{ lane: LaneName; text: string }> = [];
    const useDelta = !update.replace && update.delta !== undefined;
    const segments: SplitLaneSegment[] = [];
    const suppressReasoning = resolvedReasoningLevel === "off";
    if (split.reasoningText && !suppressReasoning) {
      splitSegments.push({ lane: "reasoning", text: split.reasoningText });
    }
    if (split.answerText) {
      splitSegments.push({ lane: "answer", text: split.answerText });
    }
    for (const segment of splitSegments) {
      const canApplyDelta = useDelta && splitSegments.length === 1;
      segments.push({
        lane: segment.lane,
        update: {
          text: segment.text,
          ...(canApplyDelta ? { delta: update.delta } : {}),
          ...(update.replace ? { replace: true } : {}),
        },
      });
    }
    return {
      segments,
      suppressedReasoningOnly:
        Boolean(split.reasoningText) && suppressReasoning && !split.answerText,
    };
  };
  const resetDraftLaneState = (lane: DraftLaneState) => {
    lane.lastPartialText = "";
    if (lane === answerLane) {
      lastAnswerPartialText = "";
    }
    lane.hasStreamedMessage = false;
    lane.finalized = false;
    if (lane === answerLane) {
      resetAnswerToolProgressDraft();
    }
  };
  const rotateLaneForNewMessage = async (lane: DraftLaneState) => {
    if (!lane.hasStreamedMessage && typeof lane.stream?.messageId() !== "number") {
      resetDraftLaneState(lane);
      return;
    }
    await lane.stream?.stop();
    lane.stream?.forceNewMessage();
    resetDraftLaneState(lane);
  };
  const rotateAnswerLaneAfterToolProgress = async () => {
    nativeToolProgressDraft?.stop();
    if (!activeAnswerDraftIsToolProgressOnly) {
      return false;
    }
    await answerLane.stream?.clear();
    answerLane.stream?.forceNewMessage();
    resetDraftLaneState(answerLane);
    streamToolProgressSuppressed = true;
    streamToolProgressLines = [];
    return true;
  };
  const prepareAnswerLaneForText = async () => {
    nativeToolProgressDraft?.stop();
    if (await rotateAnswerLaneAfterToolProgress()) {
      return;
    }
    if (!answerLane.finalized) {
      return;
    }
    await rotateLaneForNewMessage(answerLane);
  };
  const updateDraftFromPartial = (lane: DraftLaneState, update: DraftPartialTextUpdate) => {
    const laneStream = lane.stream;
    if (!laneStream || !update.text) {
      return;
    }
    const previousText = lane === answerLane ? lastAnswerPartialText : lane.lastPartialText;
    const nextText = resolveDraftPartialText(previousText, update);
    if (!nextText) {
      return;
    }
    if (lane === answerLane) {
      if (streamMode === "progress") {
        return;
      }
      resetAnswerToolProgressDraft();
      streamToolProgressSuppressed = true;
      streamToolProgressLines = [];
    }
    lane.hasStreamedMessage = true;
    lane.finalized = false;
    if (lane === answerLane) {
      lastAnswerPartialText = nextText;
    }
    lane.lastPartialText = nextText;
    laneStream.update(nextText);
  };
  const ingestDraftLaneSegments = async (
    update: { text?: string; delta?: string; replace?: true },
    isReasoning?: boolean,
  ) => {
    const split = splitTextIntoLaneSegments(update, isReasoning);
    for (const segment of split.segments) {
      if (segment.lane === "answer") {
        await prepareAnswerLaneForText();
      }
      if (segment.lane === "reasoning") {
        reasoningStepState.noteReasoningHint();
        reasoningStepState.noteReasoningDelivered();
      }
      updateDraftFromPartial(lanes[segment.lane], segment.update);
    }
  };
  const flushDraftLane = async (lane: DraftLaneState) => {
    if (!lane.stream) {
      return;
    }
    await lane.stream.flush();
  };

  const resolvedBlockStreamingEnabled = resolveChannelStreamingBlockEnabled(telegramCfg);
  const disableBlockStreaming = !streamDeliveryEnabled
    ? true
    : forceBlockStreamingForReasoning
      ? false
      : typeof resolvedBlockStreamingEnabled === "boolean"
        ? !resolvedBlockStreamingEnabled
        : canStreamAnswerDraft
          ? true
          : undefined;

  const chunkMode = resolveChunkMode(cfg, "telegram", route.accountId);

  const supersedeReplyFence = shouldSupersedeTelegramReplyFence(ctxPayload);
  activeReplyFenceKey = supersedeReplyFence
    ? replyFenceKey.activeKey
    : buildTelegramNonInterruptingReplyFenceKey({
        activeKey: replyFenceKey.activeKey,
        laneKey: scopedReplyFenceLaneKey,
      });
  if (!isRoomEvent && supersedeReplyFence) {
    supersedeTelegramReplyFence(replyFenceKey.roomEventKey);
  }
  replyFenceGeneration = beginTelegramReplyFence({
    key: activeReplyFenceKey,
    supersede: supersedeReplyFence,
    abortController: replyAbortController,
    laneKey: scopedReplyFenceLaneKey,
  });

  const implicitQuoteReplyTargetId =
    replyQuoteMessageId != null ? String(replyQuoteMessageId) : undefined;
  const currentMessageIdForQuoteReply =
    implicitQuoteReplyTargetId && ctxPayload.MessageSid ? ctxPayload.MessageSid : undefined;
  const replyQuotePosition =
    typeof ctxPayload.ReplyToQuotePosition === "number"
      ? ctxPayload.ReplyToQuotePosition
      : undefined;
  const replyQuoteEntities = Array.isArray(ctxPayload.ReplyToQuoteEntities)
    ? ctxPayload.ReplyToQuoteEntities
    : undefined;
  const deliveryState = createLaneDeliveryStateTracker();
  const clearGroupHistory = () => {
    if (isGroup && historyKey) {
      createChannelHistoryWindow({ historyMap: groupHistories }).clear({
        historyKey,
        limit: historyLimit,
      });
    }
  };
  const beginDeliveryCorrelation = () =>
    beginTelegramInboundEventDeliveryCorrelation(
      ctxPayload.SessionKey,
      {
        outboundTo: historyKey || String(chatId),
        outboundAccountId: route.accountId,
        markInboundEventDelivered: () => {
          deliveryState.markDelivered();
          if (isRoomEvent) {
            clearGroupHistory();
          }
        },
      },
      { inboundEventKind: ctxPayload.InboundEventKind },
    );
  const endTelegramInboundEventDeliveryCorrelation = beginDeliveryCorrelation();
  const sessionKey = ctxPayload.SessionKey;
  const resolveCurrentTurnTranscriptFinalText = async (): Promise<string | undefined> => {
    if (!sessionKey) {
      return undefined;
    }
    try {
      const { storePath, store } = loadFreshSessionStore(route.agentId);
      const sessionEntry = resolveSessionStoreEntry({
        store,
        sessionKey,
      }).existing;
      if (!sessionEntry?.sessionId) {
        return undefined;
      }
      const { sessionFile } = await resolveAndPersistSessionFile({
        sessionId: sessionEntry.sessionId,
        sessionKey,
        sessionStore: store,
        storePath,
        sessionEntry,
        agentId: route.agentId,
        sessionsDir: path.dirname(storePath),
      });
      const latest = await readLatestAssistantTextFromSessionTranscript(sessionFile);
      if (!latest?.timestamp || latest.timestamp < dispatchStartedAt) {
        return undefined;
      }
      return latest.text;
    } catch (err) {
      logVerbose(`telegram transcript final candidate lookup failed: ${formatErrorMessage(err)}`);
      return undefined;
    }
  };
  const deliveryBaseOptions = {
    chatId: String(chatId),
    accountId: route.accountId,
    sessionKeyForInternalHooks: ctxPayload.SessionKey,
    mirrorIsGroup: isGroup,
    mirrorGroupId: isGroup ? String(chatId) : undefined,
    token: opts.token,
    runtime,
    bot,
    mediaLocalRoots,
    mediaMaxBytes: (opts.mediaMaxMb ?? telegramCfg.mediaMaxMb ?? 100) * 1024 * 1024,
    replyToMode,
    textLimit,
    thread: threadSpec,
    tableMode,
    chunkMode,
    linkPreview: telegramCfg.linkPreview,
    replyQuoteMessageId,
    replyQuoteText,
    replyQuotePosition,
    replyQuoteEntities,
    replyQuoteByMessageId,
    transcriptMirror: sessionKey
      ? async (payload: TelegramTranscriptMirrorPayload) => {
          await mirrorTelegramAssistantReplyToTranscript({
            cfg,
            route,
            sessionKey,
            loadFreshSessionStore,
            payload,
          });
        }
      : undefined,
  };
  const silentErrorReplies = telegramCfg.silentErrorReplies === true;
  const isDmTopic = !isGroup && threadSpec.scope === "dm" && threadSpec.id != null;
  let queuedFinal = false;
  let suppressSilentReplyFallback = false;
  let hadErrorReplyFailureOrSkip = false;
  let isFirstTurnInSession = false;
  let dispatchError: unknown;

  try {
    const sticker = ctxPayload.Sticker;
    if (sticker?.fileId && sticker.fileUniqueId && ctxPayload.MediaPath) {
      const agentDir = resolveAgentDir(cfg, route.agentId);
      const stickerSupportsVision = await resolveStickerVisionSupport(cfg, route.agentId);
      let description = sticker.cachedDescription ?? null;
      if (!description) {
        description = await describeStickerImage({
          imagePath: ctxPayload.MediaPath,
          cfg,
          agentDir,
          agentId: route.agentId,
        });
      }
      if (description) {
        const stickerContext = [sticker.emoji, sticker.setName ? `from "${sticker.setName}"` : null]
          .filter(Boolean)
          .join(" ");
        const formattedDesc = `[Sticker${stickerContext ? ` ${stickerContext}` : ""}] ${description}`;

        sticker.cachedDescription = description;
        if (!stickerSupportsVision) {
          ctxPayload.Body = formattedDesc;
          ctxPayload.BodyForAgent = formattedDesc;
          pruneStickerMediaFromContext(ctxPayload, {
            stickerMediaIncluded: ctxPayload.StickerMediaIncluded,
          });
        }
        cacheSticker({
          fileId: sticker.fileId,
          fileUniqueId: sticker.fileUniqueId,
          emoji: sticker.emoji,
          setName: sticker.setName,
          description,
          cachedAt: new Date().toISOString(),
          receivedFrom: ctxPayload.From,
        });
        logVerbose(`telegram: cached sticker description for ${sticker.fileUniqueId}`);
      }
    }

    const applyTextToPayload = (payload: ReplyPayload, text: string): ReplyPayload => {
      if (payload.text === text) {
        return payload;
      }
      return { ...payload, text };
    };
    const applyTextToFollowUpPayload = (payload: ReplyPayload, text: string): ReplyPayload => {
      const next = applyTextToPayload(payload, text);
      const {
        replyToId: _replyToId,
        replyToCurrent: _replyToCurrent,
        replyToTag: _replyToTag,
        ...followUp
      } = next;
      return followUp;
    };
    const splitFinalTextForStream = (text: string): string[] => {
      const markdownChunks =
        chunkMode === "newline"
          ? chunkMarkdownTextWithMode(text, draftMaxChars, chunkMode)
          : [text];
      return markdownChunks.flatMap((chunk) =>
        markdownToTelegramChunks(chunk, draftMaxChars, { tableMode }).map(
          (telegramChunk) => telegramChunk.text,
        ),
      );
    };
    const applyQuoteReplyTarget = (payload: ReplyPayload): ReplyPayload => {
      if (
        !implicitQuoteReplyTargetId ||
        !currentMessageIdForQuoteReply ||
        payload.replyToId !== currentMessageIdForQuoteReply ||
        payload.replyToTag ||
        payload.replyToCurrent
      ) {
        return payload;
      }
      return { ...payload, replyToId: implicitQuoteReplyTargetId };
    };
    const usesNativeTelegramQuote = (payload: ReplyPayload): boolean => {
      if (replyQuoteText != null) {
        return true;
      }
      return payload.replyToId != null && replyQuoteByMessageId[payload.replyToId] != null;
    };
    const sendPayload = async (
      payload: ReplyPayload,
      options?: { durable?: boolean; silent?: boolean },
    ) => {
      if (isDispatchSuperseded()) {
        return false;
      }
      const deliverablePayload = applyQuoteReplyTarget(payload);
      const silent = options?.silent ?? (silentErrorReplies && payload.isError === true);
      const durableDelivery = telegramDeps.deliverInboundReplyWithMessageSendContext;
      if (options?.durable && durableDelivery) {
        const durable = await durableDelivery({
          cfg,
          channel: "telegram",
          to: String(chatId),
          accountId: route.accountId,
          agentId: route.agentId,
          ctxPayload,
          payload: deliverablePayload,
          info: { kind: "final" },
          replyToMode,
          threadId: threadSpec.id,
          formatting: {
            textLimit,
            tableMode,
            chunkMode,
          },
          silent,
          requiredCapabilities: deriveDurableFinalDeliveryRequirements({
            payload: deliverablePayload,
            replyToId: deliverablePayload.replyToId,
            threadId: threadSpec.id,
            silent,
            payloadTransport: true,
            extraCapabilities: {
              nativeQuote: usesNativeTelegramQuote(deliverablePayload),
            },
          }),
        });
        if (durable.status === "failed") {
          throw durable.error;
        }
        if (durable.status === "handled_visible") {
          deliveryState.markDelivered();
          return true;
        }
        if (durable.status === "handled_no_send") {
          return false;
        }
      }
      const result = await (telegramDeps.deliverReplies ?? deliverReplies)({
        ...deliveryBaseOptions,
        transcriptMirror: options?.durable ? deliveryBaseOptions.transcriptMirror : undefined,
        replies: [deliverablePayload],
        onVoiceRecording: sendRecordVoice,
        silent,
        mediaLoader: telegramDeps.loadWebMedia,
      });
      if (result.delivered) {
        deliveryState.markDelivered();
      }
      return result.delivered;
    };
    const emitPreviewFinalizedHook = async (result: LaneDeliveryResult) => {
      if (isDispatchSuperseded() || result.kind !== "preview-finalized") {
        return;
      }
      (telegramDeps.emitInternalMessageSentHook ?? emitInternalMessageSentHook)({
        sessionKeyForInternalHooks: deliveryBaseOptions.sessionKeyForInternalHooks,
        chatId: deliveryBaseOptions.chatId,
        accountId: deliveryBaseOptions.accountId,
        content: result.delivery.content,
        success: true,
        messageId: result.delivery.messageId,
        isGroup: deliveryBaseOptions.mirrorIsGroup,
        groupId: deliveryBaseOptions.mirrorGroupId,
      });
      try {
        await (
          telegramDeps.recordOutboundMessageForPromptContext ??
          recordOutboundMessageForPromptContext
        )({
          cfg,
          account: { accountId: route.accountId },
          chatId: deliveryBaseOptions.chatId,
          message: { message_id: result.delivery.messageId },
          messageId: result.delivery.messageId,
          text: result.delivery.promptContextContent ?? result.delivery.content,
          ...(threadSpec.id !== undefined ? { messageThreadId: threadSpec.id } : {}),
        });
      } catch (error) {
        logVerbose(
          `telegram: failed to record streamed reply for prompt context: ${formatErrorMessage(
            error,
          )}`,
        );
      }
      if (deliveryBaseOptions.transcriptMirror && result.delivery.content) {
        void deliveryBaseOptions
          .transcriptMirror({ text: result.delivery.content })
          .catch((err: unknown) => {
            logVerbose(
              `telegram preview-finalized transcriptMirror failed: ${formatErrorMessage(err)}`,
            );
          });
      }
    };
    const deliverLaneText = createLaneTextDeliverer({
      lanes,
      draftMaxChars,
      applyTextToPayload,
      applyTextToFollowUpPayload,
      splitFinalTextForStream: splitFinalTextForStream,
      sendPayload,
      flushDraftLane,
      stopDraftLane: async (lane) => {
        await lane.stream?.stop();
      },
      clearDraftLane: async (lane) => {
        await lane.stream?.clear();
      },
      editStreamMessage: async ({ messageId, text, buttons }) => {
        if (isDispatchSuperseded()) {
          return;
        }
        await (telegramDeps.editMessageTelegram ?? editMessageTelegram)(chatId, messageId, text, {
          api: bot.api,
          cfg,
          accountId: route.accountId,
          linkPreview: telegramCfg.linkPreview,
          buttons,
        });
      },
      resolveFinalTextCandidate: () => resolveCurrentTurnTranscriptFinalText(),
      log: logVerbose,
      markDelivered: () => {
        deliveryState.markDelivered();
      },
    });
    const deliverProgressModeFinalAnswer = async (
      payload: ReplyPayload,
      text: string,
    ): Promise<LaneDeliveryResult> => {
      if (activeAnswerDraftIsToolProgressOnly) {
        await rotateAnswerLaneAfterToolProgress();
      } else {
        await answerLane.stream?.clear();
        resetDraftLaneState(answerLane);
      }
      const delivered = await sendPayload(applyTextToPayload(payload, text), { durable: true });
      if (!delivered) {
        return { kind: "skipped" };
      }
      answerLane.finalized = true;
      finalAnswerDelivered = true;
      return { kind: "sent" };
    };
    const resolveTranscriptBackedFinalText = async (text: string): Promise<string> =>
      await resolveTranscriptBackedChannelFinalText({
        finalText: text,
        resolveCandidateText: resolveCurrentTurnTranscriptFinalText,
      });

    if (isDmTopic) {
      try {
        const { store } = loadFreshSessionStore(route.agentId);
        const sessionKey = ctxPayload.SessionKey;
        if (sessionKey) {
          const entry = resolveSessionStoreEntry({ store, sessionKey }).existing;
          isFirstTurnInSession = !entry?.systemSent;
        } else {
          logVerbose("auto-topic-label: SessionKey is absent, skipping first-turn detection");
        }
      } catch (err) {
        logVerbose(`auto-topic-label: session store error: ${formatErrorMessage(err)}`);
      }
    }
    loadFreshSessionStore.clear();

    if (statusReactionController && !isRoomEvent) {
      void statusReactionController.setThinking();
    }

    const { onModelSelected, ...replyPipeline } = (
      telegramDeps.createChannelMessageReplyPipeline ?? createChannelMessageReplyPipeline
    )({
      cfg,
      agentId: route.agentId,
      channel: "telegram",
      accountId: route.accountId,
      typing: {
        start: sendTyping,
        onStartError: (err) => {
          logTypingFailure({
            log: logVerbose,
            channel: "telegram",
            target: String(chatId),
            error: err,
          });
        },
      },
    });

    try {
      const turnResult = await runChannelInboundEvent({
        channel: "telegram",
        accountId: route.accountId,
        raw: dispatchContext,
        adapter: {
          ingest: () => ({
            id: ctxPayload.MessageSid ?? `${chatId}:${Date.now()}`,
            timestamp: typeof ctxPayload.Timestamp === "number" ? ctxPayload.Timestamp : undefined,
            rawText: ctxPayload.RawBody ?? "",
            textForAgent: ctxPayload.BodyForAgent,
            textForCommands: ctxPayload.CommandBody,
            raw: dispatchContext,
          }),
          resolveTurn: () => ({
            channel: "telegram",
            accountId: route.accountId,
            routeSessionKey: route.sessionKey,
            storePath: dispatchContext.turn.storePath,
            ctxPayload,
            recordInboundSession: dispatchContext.turn.recordInboundSession,
            record: dispatchContext.turn.record,
            runDispatch: () => {
              const sentBlockMediaUrls = new Set<string>();

              return telegramDeps.dispatchReplyWithBufferedBlockDispatcher({
                ctx: ctxPayload,
                cfg,
                dispatcherOptions: {
                  ...replyPipeline,
                  beforeDeliver: async (payload) => payload,
                  deliver: async (payload, info) => {
                    if (isDispatchSuperseded()) {
                      return;
                    }
                    if (payload.isError === true) {
                      hadErrorReplyFailureOrSkip = true;
                    }

                    const deduped =
                      info.kind === "final"
                        ? deduplicateBlockSentMedia(payload, sentBlockMediaUrls)
                        : payload;
                    if (deduped === undefined) {
                      return;
                    }
                    const effectivePayload = deduped;

                    if (
                      shouldSuppressLocalTelegramExecApprovalPrompt({
                        cfg,
                        accountId: route.accountId,
                        payload,
                      })
                    ) {
                      queuedFinal = true;
                      return;
                    }
                    const telegramButtons = resolvePayloadTelegramInlineButtons(effectivePayload);
                    const split = splitTextIntoLaneSegments(
                      { text: effectivePayload.text },
                      payload.isReasoning,
                    );
                    const segments = split.segments;
                    const reply = resolveSendableOutboundReplyParts(effectivePayload);
                    if (info.kind === "final" && (reply.text.length > 0 || reply.hasMedia)) {
                      finalAnswerDeliveryStarted = true;
                    }
                    if (info.kind === "final") {
                      await enqueueDraftLaneEvent(async () => {});
                    }
                    if (
                      info.kind === "tool" &&
                      (finalAnswerDeliveryStarted || finalAnswerDelivered) &&
                      !reply.hasMedia &&
                      !hasExecApprovalPayload(effectivePayload)
                    ) {
                      return;
                    }

                    const deliverFinalAnswerText = async (
                      answerPayload: ReplyPayload,
                      text: string,
                      buttons?: TelegramInlineButtons,
                    ) => {
                      const finalText = await resolveTranscriptBackedFinalText(text);
                      if (streamMode === "progress") {
                        return deliverProgressModeFinalAnswer(answerPayload, finalText);
                      }
                      await rotateAnswerLaneAfterToolProgress();
                      const result = await deliverLaneText({
                        laneName: "answer",
                        text: finalText,
                        payload: answerPayload,
                        infoKind: "final",
                        buttons,
                      });
                      if (result.kind !== "skipped") {
                        finalAnswerDelivered = true;
                      }
                      return result;
                    };

                    const flushBufferedFinalAnswer = async () => {
                      const buffered =
                        reasoningStepState.takeBufferedFinalAnswer(replyFenceGeneration);
                      if (!buffered) {
                        return;
                      }
                      const bufferedButtons = resolvePayloadTelegramInlineButtons(buffered.payload);
                      await deliverFinalAnswerText(
                        buffered.payload,
                        buffered.text,
                        bufferedButtons,
                      );
                      reasoningStepState.resetForNextStep();
                    };

                    let blockDelivered = false;
                    for (const segment of segments) {
                      if (
                        segment.lane === "answer" &&
                        info.kind === "final" &&
                        reasoningStepState.shouldBufferFinalAnswer()
                      ) {
                        reasoningStepState.bufferFinalAnswer({
                          payload: effectivePayload,
                          text: segment.update.text,
                          bufferedGeneration: replyFenceGeneration,
                        });
                        continue;
                      }
                      if (segment.lane === "reasoning") {
                        reasoningStepState.noteReasoningHint();
                      }
                      if (segment.lane === "answer" && info.kind === "tool") {
                        const canRepresentAsTransientProgress = canUseNativeToolProgressDraft({
                          payload: effectivePayload,
                          reply,
                          buttons: telegramButtons,
                        });
                        if (nativeToolProgressDraft && canRepresentAsTransientProgress) {
                          if (await pushStreamToolProgress(segment.update.text)) {
                            blockDelivered = true;
                            continue;
                          }
                        }
                        if (
                          canRepresentAsTransientProgress &&
                          streamMode === "progress" &&
                          answerLane.stream
                        ) {
                          // Progress-mode streams render tool status in the
                          // live draft. Do not also emit text-only tool output
                          // as answer text, or simple commands duplicate and
                          // restart the progress draft.
                          continue;
                        }
                        await prepareAnswerLaneForToolProgress();
                      }
                      const result =
                        segment.lane === "answer" && info.kind === "final"
                          ? await deliverFinalAnswerText(
                              effectivePayload,
                              segment.update.text,
                              telegramButtons,
                            )
                          : await deliverLaneText({
                              laneName: segment.lane,
                              text: segment.update.text,
                              payload: effectivePayload,
                              infoKind: info.kind,
                              buttons: telegramButtons,
                            });
                      if (info.kind === "final") {
                        await emitPreviewFinalizedHook(result);
                      }
                      blockDelivered = blockDelivered || result.kind !== "skipped";
                      if (segment.lane === "reasoning") {
                        if (result.kind !== "skipped") {
                          reasoningStepState.noteReasoningDelivered();
                          await flushBufferedFinalAnswer();
                        }
                        continue;
                      }
                      if (info.kind === "final") {
                        reasoningStepState.resetForNextStep();
                      }
                    }
                    const trackBlockMedia = (delivered: boolean) => {
                      if (delivered && info.kind === "block" && payload.mediaUrls?.length) {
                        for (const url of payload.mediaUrls) {
                          sentBlockMediaUrls.add(url);
                        }
                      }
                    };

                    if (segments.length > 0) {
                      trackBlockMedia(blockDelivered);
                      return;
                    }
                    if (split.suppressedReasoningOnly) {
                      let delivered = false;
                      if (reply.hasMedia) {
                        const payloadWithoutSuppressedReasoning =
                          typeof effectivePayload.text === "string"
                            ? { ...effectivePayload, text: "" }
                            : effectivePayload;
                        delivered = await sendPayload(payloadWithoutSuppressedReasoning, {
                          durable: info.kind === "final",
                        });
                      }
                      if (info.kind === "final" && delivered) {
                        finalAnswerDelivered = true;
                      }
                      if (info.kind === "final") {
                        await flushBufferedFinalAnswer();
                      }
                      trackBlockMedia(delivered);
                      return;
                    }

                    if (info.kind === "final") {
                      await rotateAnswerLaneAfterToolProgress();
                      await answerLane.stream?.stop();
                      await reasoningLane.stream?.stop();
                      reasoningStepState.resetForNextStep();
                    }
                    const canSendAsIs = reply.hasMedia || reply.text.length > 0;
                    if (!canSendAsIs) {
                      if (info.kind === "final") {
                        await flushBufferedFinalAnswer();
                      }
                      return;
                    }
                    const delivered = await sendPayload(effectivePayload, {
                      durable: info.kind === "final",
                    });
                    if (info.kind === "final" && delivered) {
                      finalAnswerDelivered = true;
                    }
                    if (info.kind === "final") {
                      await flushBufferedFinalAnswer();
                    }
                    trackBlockMedia(delivered);
                  },
                  onSkip: (payload, info) => {
                    if (payload.isError === true) {
                      hadErrorReplyFailureOrSkip = true;
                    }
                    if (info.reason !== "silent") {
                      deliveryState.markNonSilentSkip();
                    }
                  },
                  onError: (err, info) => {
                    const errorPolicy = resolveTelegramErrorPolicy({
                      accountConfig: telegramCfg,
                      groupConfig,
                      topicConfig,
                    });
                    if (isSilentErrorPolicy(errorPolicy.policy)) {
                      return;
                    }
                    if (
                      errorPolicy.policy === "once" &&
                      shouldSuppressTelegramError({
                        scopeKey: buildTelegramErrorScopeKey({
                          accountId: route.accountId,
                          chatId,
                          threadId: threadSpec.id,
                        }),
                        cooldownMs: errorPolicy.cooldownMs,
                        errorMessage: String(err),
                      })
                    ) {
                      return;
                    }
                    deliveryState.markNonSilentFailure();
                    runtime.error?.(danger(`telegram ${info.kind} reply failed: ${String(err)}`));
                  },
                },
                replyOptions: {
                  skillFilter,
                  disableBlockStreaming,
                  abortSignal: replyAbortController.signal,
                  sourceReplyDeliveryMode: isRoomEvent ? "message_tool_only" : undefined,
                  queuedDeliveryCorrelations: isRoomEvent
                    ? [{ begin: beginDeliveryCorrelation }]
                    : undefined,
                  queuedFollowupLifecycle: isRoomEvent
                    ? {
                        onEnqueued: () => {
                          replyAbortControllerQueued = true;
                        },
                        onComplete: () => {
                          replyAbortControllerQueued = false;
                          releaseTelegramReplyFenceAbortController(
                            activeReplyFenceKey,
                            replyAbortController,
                          );
                        },
                      }
                    : undefined,
                  suppressTyping: isRoomEvent,
                  onPartialReply:
                    answerLane.stream || reasoningLane.stream
                      ? (payload) =>
                          enqueueDraftLaneEvent(async () => {
                            await ingestDraftLaneSegments(payload);
                          })
                      : undefined,
                  onReasoningStream: reasoningLane.stream
                    ? (payload) =>
                        enqueueDraftLaneEvent(async () => {
                          if (splitReasoningOnNextStream) {
                            reasoningLane.stream?.forceNewMessage();
                            resetDraftLaneState(reasoningLane);
                            splitReasoningOnNextStream = false;
                          }
                          await ingestDraftLaneSegments(payload, true);
                        })
                    : undefined,
                  onAssistantMessageStart: answerLane.stream
                    ? () =>
                        enqueueDraftLaneEvent(async () => {
                          reasoningStepState.resetForNextStep();
                          streamToolProgressSuppressed = false;
                          streamToolProgressLines = [];
                          if (answerLane.finalized) {
                            await rotateLaneForNewMessage(answerLane);
                          }
                        })
                    : undefined,
                  onReasoningEnd: reasoningLane.stream
                    ? () =>
                        enqueueDraftLaneEvent(async () => {
                          splitReasoningOnNextStream = reasoningLane.hasStreamedMessage;
                          streamToolProgressSuppressed = false;
                          streamToolProgressLines = [];
                        })
                    : undefined,
                  suppressDefaultToolProgressMessages:
                    !streamDeliveryEnabled || Boolean(answerLane.stream),
                  allowProgressCallbacksWhenSourceDeliverySuppressed:
                    !isRoomEvent && Boolean(answerLane.stream),
                  onToolStart: async (payload) => {
                    const toolName = payload.name?.trim();
                    const progressPromise = pushStreamToolProgress(
                      formatChannelProgressDraftLineForEntry(
                        telegramCfg,
                        {
                          event: "tool",
                          name: toolName,
                          phase: payload.phase,
                          args: payload.args,
                        },
                        payload.detailMode ? { detailMode: payload.detailMode } : undefined,
                      ),
                      { toolName, startImmediately: true },
                    );
                    if (statusReactionController && toolName) {
                      await statusReactionController.setTool(toolName);
                    }
                    await progressPromise;
                  },
                  onItemEvent: async (payload) => {
                    await pushStreamToolProgress(
                      buildChannelProgressDraftLineForEntry(telegramCfg, {
                        event: "item",
                        itemId: payload.itemId,
                        itemKind: payload.kind,
                        title: payload.title,
                        name: payload.name,
                        phase: payload.phase,
                        status: payload.status,
                        summary: payload.summary,
                        progressText: payload.progressText,
                        meta: payload.meta,
                      }),
                    );
                  },
                  onPlanUpdate: async (payload) => {
                    if (payload.phase !== "update") {
                      return;
                    }
                    await pushStreamToolProgress(
                      formatChannelProgressDraftLine({
                        event: "plan",
                        phase: payload.phase,
                        title: payload.title,
                        explanation: payload.explanation,
                        steps: payload.steps,
                      }),
                    );
                  },
                  onApprovalEvent: async (payload) => {
                    if (payload.phase !== "requested") {
                      return;
                    }
                    await pushStreamToolProgress(
                      formatChannelProgressDraftLine({
                        event: "approval",
                        phase: payload.phase,
                        title: payload.title,
                        command: payload.command,
                        reason: payload.reason,
                        message: payload.message,
                      }),
                    );
                  },
                  onCommandOutput: async (payload) => {
                    if (payload.phase !== "end") {
                      return;
                    }
                    await pushStreamToolProgress(
                      formatChannelProgressDraftLine({
                        event: "command-output",
                        phase: payload.phase,
                        title: payload.title,
                        name: payload.name,
                        status: payload.status,
                        exitCode: payload.exitCode,
                      }),
                    );
                  },
                  onPatchSummary: async (payload) => {
                    if (payload.phase !== "end") {
                      return;
                    }
                    await pushStreamToolProgress(
                      formatChannelProgressDraftLine({
                        event: "patch",
                        phase: payload.phase,
                        title: payload.title,
                        name: payload.name,
                        added: payload.added,
                        modified: payload.modified,
                        deleted: payload.deleted,
                        summary: payload.summary,
                      }),
                    );
                  },
                  onCompactionStart: statusReactionController
                    ? async () => {
                        await statusReactionController.setCompacting();
                      }
                    : undefined,
                  onCompactionEnd: statusReactionController
                    ? async () => {
                        statusReactionController.cancelPending();
                        await statusReactionController.setThinking();
                      }
                    : undefined,
                  onModelSelected,
                },
              });
            },
          }),
        },
      });
      if (!turnResult.dispatched) {
        return;
      }
      ({ queuedFinal } = turnResult.dispatchResult);
      suppressSilentReplyFallback =
        turnResult.dispatchResult.sourceReplyDeliveryMode === "message_tool_only";
    } catch (err) {
      dispatchError = err;
      runtime.error?.(danger(`telegram dispatch failed: ${String(err)}`));
    } finally {
      progressDraftGate.cancel();
      await draftLaneEventQueue;
      nativeToolProgressDraft?.stop();
      const lanesToCleanup: Array<{ laneName: LaneName; lane: DraftLaneState }> = [
        { laneName: "answer", lane: answerLane },
        { laneName: "reasoning", lane: reasoningLane },
      ];
      for (const { lane } of lanesToCleanup) {
        const stream = lane.stream;
        if (!stream) {
          continue;
        }
        if (isDispatchSuperseded()) {
          await (typeof stream.discard === "function" ? stream.discard() : stream.stop());
          continue;
        }
        if (lane.finalized) {
          await stream.stop();
        } else {
          await stream.clear();
        }
      }
    }
  } finally {
    dispatchWasSuperseded = isDispatchSuperseded();
    releaseReplyFence();
    endTelegramInboundEventDeliveryCorrelation();
  }
  if (dispatchWasSuperseded) {
    if (statusReactionController) {
      void finalizeTelegramStatusReaction({ outcome: "done", hasFinalResponse: true }).catch(
        (err: unknown) => {
          logVerbose(`telegram: status reaction finalize failed: ${String(err)}`);
        },
      );
    } else {
      removeAckReactionAfterReply({
        removeAfterReply: removeAckAfterReply,
        ackReactionPromise,
        ackReactionValue: ackReactionPromise ? "ack" : null,
        remove: () =>
          (reactionApi?.(chatId, msg.message_id ?? 0, []) ?? Promise.resolve()).then(() => {}),
        onError: (err) => {
          if (!msg.message_id) {
            return;
          }
          logAckFailure({
            log: logVerbose,
            channel: "telegram",
            target: `${chatId}/${msg.message_id}`,
            error: err,
          });
        },
      });
    }
    if (!isRoomEvent || deliveryState.snapshot().delivered) {
      clearGroupHistory();
    }
    return;
  }
  let sentFallback = false;
  const deliverySummary = deliveryState.snapshot();
  const shouldSendFailureFallback =
    !isRoomEvent &&
    (dispatchError ||
      (!deliverySummary.delivered &&
        (deliverySummary.skippedNonSilent > 0 || deliverySummary.failedNonSilent > 0)));
  if (shouldSendFailureFallback) {
    const fallbackText = dispatchError
      ? "Something went wrong while processing your request. Please try again."
      : EMPTY_RESPONSE_FALLBACK;
    const result = await (telegramDeps.deliverReplies ?? deliverReplies)({
      replies: [{ text: fallbackText }],
      ...deliveryBaseOptions,
      silent: silentErrorReplies && (dispatchError != null || hadErrorReplyFailureOrSkip),
      mediaLoader: telegramDeps.loadWebMedia,
    });
    sentFallback = result.delivered;
  }

  if (
    !sentFallback &&
    !dispatchError &&
    !deliverySummary.delivered &&
    !suppressSilentReplyFallback &&
    !queuedFinal &&
    isGroup
  ) {
    const policySessionKey =
      ctxPayload.CommandSource === "native"
        ? (ctxPayload.CommandTargetSessionKey ?? ctxPayload.SessionKey)
        : ctxPayload.SessionKey;
    const silentReplyFallback = projectOutboundPayloadPlanForDelivery(
      createOutboundPayloadPlan([{ text: "NO_REPLY" }], {
        cfg,
        sessionKey: policySessionKey,
        surface: "telegram",
      }),
    );
    if (silentReplyFallback.length > 0) {
      const result = await (telegramDeps.deliverReplies ?? deliverReplies)({
        replies: silentReplyFallback,
        ...deliveryBaseOptions,
        silent: false,
        mediaLoader: telegramDeps.loadWebMedia,
      });
      sentFallback = result.delivered;
    }
    silentReplyDispatchLogger.debug("telegram turn ended without visible final response", {
      hasSessionKey: Boolean(policySessionKey),
      hasChatId: chatId != null,
      queuedFinal,
      sentFallback,
    });
  }

  const hasFinalResponse =
    deliverySummary.delivered || sentFallback || suppressSilentReplyFallback || queuedFinal;

  if (statusReactionController && !hasFinalResponse) {
    void finalizeTelegramStatusReaction({ outcome: "error", hasFinalResponse: false }).catch(
      (err: unknown) => {
        logVerbose(`telegram: status reaction error finalize failed: ${String(err)}`);
      },
    );
  }

  const shouldClearGroupHistory =
    !isRoomEvent || deliverySummary.delivered || sentFallback || queuedFinal;

  if (!hasFinalResponse) {
    if (!shouldClearGroupHistory) {
      return;
    }
    clearGroupHistory();
    return;
  }

  // Fire-and-forget: auto-rename DM topic on first message.
  if (isDmTopic && isFirstTurnInSession) {
    const userMessage = (ctxPayload.RawBody ?? ctxPayload.Body ?? "").slice(0, 500);
    if (userMessage.trim()) {
      const agentDir = resolveAgentDir(cfg, route.agentId);
      const directAutoTopicLabel =
        !isGroup && groupConfig && "autoTopicLabel" in groupConfig
          ? groupConfig.autoTopicLabel
          : undefined;
      const accountAutoTopicLabel = telegramCfg?.autoTopicLabel;
      const autoTopicConfig = resolveAutoTopicLabelConfig(
        directAutoTopicLabel,
        accountAutoTopicLabel,
      );
      if (autoTopicConfig) {
        const topicThreadId = threadSpec.id!;
        void (async () => {
          try {
            const label = await generateTopicLabel({
              userMessage,
              prompt: autoTopicConfig.prompt,
              cfg,
              agentId: route.agentId,
              agentDir,
            });
            if (!label) {
              logVerbose("auto-topic-label: LLM returned empty label");
              return;
            }
            logVerbose(`auto-topic-label: generated label (len=${label.length})`);
            await bot.api.editForumTopic(chatId, topicThreadId, { name: label });
            logVerbose(`auto-topic-label: renamed topic ${chatId}/${topicThreadId}`);
          } catch (err) {
            logVerbose(`auto-topic-label: failed: ${formatErrorMessage(err)}`);
          }
        })();
      }
    }
  }

  if (statusReactionController) {
    const statusReactionOutcome = dispatchError || sentFallback ? "error" : "done";
    void finalizeTelegramStatusReaction({
      outcome: statusReactionOutcome,
      hasFinalResponse: true,
    }).catch((err: unknown) => {
      logVerbose(`telegram: status reaction finalize failed: ${String(err)}`);
    });
  } else {
    removeAckReactionAfterReply({
      removeAfterReply: removeAckAfterReply,
      ackReactionPromise,
      ackReactionValue: ackReactionPromise ? "ack" : null,
      remove: () =>
        (reactionApi?.(chatId, msg.message_id ?? 0, []) ?? Promise.resolve()).then(() => {}),
      onError: (err) => {
        if (!msg.message_id) {
          return;
        }
        logAckFailure({
          log: logVerbose,
          channel: "telegram",
          target: `${chatId}/${msg.message_id}`,
          error: err,
        });
      },
    });
  }
  if (shouldClearGroupHistory) {
    clearGroupHistory();
  }
};
