// Feishu plugin module implements reply dispatcher behavior.
import { formatReasoningMessage, resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import { logTypingFailure } from "openclaw/plugin-sdk/channel-feedback";
import {
  isChannelPartialDeliveryError,
  type ChannelInboundTurnPlan,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createChannelMessageReplyPipeline,
  formatChannelProgressDraftLineForEntry,
  isChannelProgressDraftWorkToolName,
  resolveChannelPreviewStreamMode,
  resolveChannelStreamingBlockEnabled,
} from "openclaw/plugin-sdk/channel-outbound";
import { toStringifiedError as toFeishuError } from "openclaw/plugin-sdk/error-runtime";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
import {
  getReplyPayloadTtsSupplement,
  resolveSendableOutboundReplyParts,
  resolveTextChunksWithFallback,
  sendMediaWithLeadingCaption,
} from "openclaw/plugin-sdk/reply-payload";
import { stripReasoningTagsFromText } from "openclaw/plugin-sdk/text-chunking";
import type { ClawdbotConfig, OutboundIdentity, ReplyPayload, RuntimeEnv } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { resolveConfiguredHttpTimeoutMs } from "./client-timeout.js";
import { createFeishuClient } from "./client.js";
import { resolveFeishuIdentityEmoji } from "./identity-header.js";
import { chunkFeishuPostMarkdown, materializeFeishuPostMarkdownSoftBreaks } from "./markdown.js";
import { buildFeishuMediaFallbackText } from "./media-fallback.js";
import { sendMediaFeishu, shouldSuppressFeishuTextForVoiceMedia } from "./media.js";
import type { MentionTarget } from "./mention-target.types.js";
import {
  consumeFeishuPresentationFallbackMarker,
  renderFeishuReplyPayload,
} from "./presentation-card.js";
import {
  createFeishuPartialReplyDeliveryError,
  createFeishuReplyDeliveryResult,
  mergeFeishuReplyDeliveryResults,
  noVisibleFeishuReplyDelivery,
  type FeishuReplyDeliveryResult,
  type FeishuReplyDeliveryResultWithFinalization,
  type FeishuReplyDeliverySource,
} from "./reply-delivery-result.js";
import { streamingStartBackoffUntilByAccount } from "./reply-dispatcher-state.js";
import { getFeishuRuntime } from "./runtime.js";
import {
  chunkFeishuCardMarkdown,
  sendCardFeishu,
  sendMessageFeishu,
  sendStructuredCardFeishu,
  type CardHeaderConfig,
} from "./send.js";
import {
  FeishuStreamingFinalizationError,
  FeishuStreamingSession,
  mergeStreamingText,
} from "./streaming-card.js";
import { resolveReceiveIdType } from "./targets.js";
import { addTypingIndicator, removeTypingIndicator, type TypingIndicatorState } from "./typing.js";

/** Detect if text contains markdown elements that benefit from card rendering */
function shouldUseCard(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

function mergeStreamingFinalText(
  previousText: string,
  nextText: string,
  appendError: boolean,
): string {
  if (!appendError || !previousText) {
    return nextText;
  }
  if (nextText.startsWith(previousText)) {
    return nextText;
  }
  if (previousText.endsWith(`\n\n${nextText}`)) {
    return previousText;
  }
  return `${previousText}\n\n${nextText}`;
}

/** Maximum age (ms) for a message to receive a typing indicator reaction.
 * Messages older than this are likely replays after context compaction (#30418). */
const TYPING_INDICATOR_MAX_AGE_MS = 2 * 60_000;
const MS_EPOCH_MIN = 1_000_000_000_000;
const STREAMING_START_FAILURE_BACKOFF_MS = 60_000;
const NO_VISIBLE_REPLY_FALLBACK_TEXT =
  "⚠️ This reply completed without visible content. The turn may have been interrupted; please retry or ask me to recover from recent context.";

function isStreamingStartBackedOff(accountId: string, now = Date.now()): boolean {
  const backoffUntil = streamingStartBackoffUntilByAccount.get(accountId);
  if (backoffUntil === undefined) {
    return false;
  }
  if (backoffUntil <= now) {
    streamingStartBackoffUntilByAccount.delete(accountId);
    return false;
  }
  return true;
}

function rememberStreamingStartFailure(accountId: string, now = Date.now()): number {
  const backoffUntil = now + STREAMING_START_FAILURE_BACKOFF_MS;
  streamingStartBackoffUntilByAccount.set(accountId, backoffUntil);
  return backoffUntil;
}

function normalizeEpochMs(timestamp: number | undefined): number | undefined {
  if (!Number.isFinite(timestamp) || timestamp === undefined || timestamp <= 0) {
    return undefined;
  }
  // Defensive normalization: some payloads use seconds, others milliseconds.
  // Values below 1e12 are treated as epoch-seconds.
  return timestamp < MS_EPOCH_MIN ? timestamp * 1000 : timestamp;
}

/** Build a card header from agent identity config. */
function resolveCardHeader(
  agentId: string,
  identity: OutboundIdentity | undefined,
): CardHeaderConfig | undefined {
  const name = identity?.name?.trim() || (agentId === "main" ? "" : agentId);
  const emoji = resolveFeishuIdentityEmoji(identity?.emoji);
  const title = (emoji ? `${emoji} ${name}` : name).trim();
  if (!title) {
    return undefined;
  }
  return {
    title,
    template: identity?.theme ?? "blue",
  };
}

/** Build a card note footer from agent identity and model context. */
function resolveCardNote(
  agentId: string,
  identity: OutboundIdentity | undefined,
  prefixCtx: { model?: string; provider?: string },
): string {
  const name = identity?.name?.trim() || agentId;
  const parts: string[] = [`Agent: ${name}`];
  if (prefixCtx.model) {
    parts.push(`Model: ${prefixCtx.model}`);
  }
  if (prefixCtx.provider) {
    parts.push(`Provider: ${prefixCtx.provider}`);
  }
  return parts.join(" | ");
}

type CreateFeishuReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  chatId: string;
  sendTarget: string;
  allowReasoningPreview?: boolean;
  replyToMessageId?: string;
  typingTargetMessageId?: string;
  /** When true, omit reply metadata from visible messages while keeping typing on its target. */
  skipReplyToInMessages?: boolean;
  replyInThread?: boolean;
  /** True when inbound message is already inside a thread/topic context */
  threadReply?: boolean;
  rootId?: string;
  accountId?: string;
  identity?: OutboundIdentity;
  mentionTargets?: MentionTarget[];
  /** Mentions required on every mention-capable text/card reply, used for bot-authored ingress. */
  requiredMentionTargets?: MentionTarget[];
  /** Epoch ms when the inbound message was created. Used to suppress typing
   *  indicators on old/replayed messages after context compaction (#30418). */
  messageCreateTimeMs?: number;
  sessionKey?: string;
};

export function createFeishuReplyDispatcher(params: CreateFeishuReplyDispatcherParams) {
  const core = getFeishuRuntime();
  const {
    cfg,
    agentId,
    chatId,
    sendTarget,
    replyToMessageId,
    typingTargetMessageId: explicitTypingTargetMessageId,
    skipReplyToInMessages,
    replyInThread,
    threadReply,
    rootId,
    accountId,
    identity,
    mentionTargets,
    requiredMentionTargets,
  } = params;
  const sendReplyToMessageId = skipReplyToInMessages ? undefined : replyToMessageId;
  const typingTargetMessageId = explicitTypingTargetMessageId?.trim() || replyToMessageId;
  const threadReplyMode = threadReply === true;
  const effectiveReplyInThread = threadReplyMode ? true : replyInThread;
  const allowTopLevelReplyFallback =
    effectiveReplyInThread === true &&
    threadReplyMode &&
    rootId !== undefined &&
    sendReplyToMessageId !== undefined &&
    sendReplyToMessageId !== rootId;
  const account = resolveFeishuRuntimeAccount({ cfg, accountId });
  let typingState: TypingIndicatorState | null = null;
  // Reply text and card attribution share the same selected-model context.
  const { typingCallbacks, responsePrefix, responsePrefixContextProvider, onModelSelected } =
    createChannelMessageReplyPipeline({
      cfg,
      agentId,
      channel: "feishu",
      accountId,
      typing: {
        start: async () => {
          // Check if typing indicator is enabled (default: true)
          if (!(account.config.typingIndicator ?? true)) {
            return;
          }
          if (!typingTargetMessageId) {
            return;
          }
          // Skip typing indicator for old messages — likely replays after context
          // compaction that would flood users with stale notifications (#30418).
          const messageCreateTimeMs = normalizeEpochMs(params.messageCreateTimeMs);
          if (
            messageCreateTimeMs !== undefined &&
            Date.now() - messageCreateTimeMs > TYPING_INDICATOR_MAX_AGE_MS
          ) {
            return;
          }
          // Feishu reactions persist until explicitly removed, so skip keepalive
          // re-adds when a reaction already exists. Re-adding the same emoji
          // triggers a new push notification for every call (#28660).
          if (typingState?.reactionId) {
            return;
          }
          typingState = await addTypingIndicator({
            cfg,
            messageId: typingTargetMessageId,
            accountId,
            runtime: params.runtime,
          });
        },
        stop: async () => {
          if (!typingState) {
            return;
          }
          await removeTypingIndicator({
            cfg,
            state: typingState,
            accountId,
            runtime: params.runtime,
          });
          typingState = null;
        },
        onStartError: (err) =>
          logTypingFailure({
            log: (message) => params.runtime.log?.(message),
            channel: "feishu",
            action: "start",
            error: err,
          }),
        onStopError: (err) =>
          logTypingFailure({
            log: (message) => params.runtime.log?.(message),
            channel: "feishu",
            action: "stop",
            error: err,
          }),
      },
    });

  const textChunkLimit = core.channel.text.resolveTextChunkLimit(cfg, "feishu", accountId, {
    fallbackLimit: 4000,
  });
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "feishu", accountId);
  const tableMode = core.channel.text.resolveMarkdownTableMode({ cfg, channel: "feishu" });
  const renderMode = account.config?.renderMode ?? "auto";
  // Streaming cards cannot attach native mention recipients. Bot-authored ingress
  // therefore uses normal cards/posts so every emitted unit reaches the peer bot.
  const streamingEnabled =
    !requiredMentionTargets?.length &&
    resolveChannelPreviewStreamMode(account.config, "partial") !== "off" &&
    renderMode !== "raw";
  const hookRunner = getGlobalHookRunner();
  const modifyingHooksRegistered =
    (hookRunner?.hasHooks("reply_payload_sending") ?? false) ||
    (hookRunner?.hasHooks("message_sending") ?? false);
  // A preview exists before modifying hooks accept the logical payload, so suppress all eager
  // CardKit activity whenever either hook could rewrite or cancel the eventual send.
  const previewStreamingEnabled = streamingEnabled && !modifyingHooksRegistered;
  const blockStreamingEnabled = resolveChannelStreamingBlockEnabled(account.config);
  const coreBlockStreamingEnabled = blockStreamingEnabled === true;
  const reasoningPreviewEnabled = previewStreamingEnabled && params.allowReasoningPreview === true;

  let streaming: FeishuStreamingSession | null = null;
  let streamText = "";
  let lastPartial = "";
  let reasoningText = "";
  let statusLine = "";
  let snapshotBaseText = "";
  let lastSnapshotTextLength = 0;
  // Partial previews are replaceable; only committed final text may precede an error notice.
  let hasStreamingFinalText = false;
  const deliveredFinalTexts = new Set<string>();
  type StreamingDisposition = "closed" | "discarded";
  type StreamingCloseOutcome = {
    disposition: StreamingDisposition;
    result: FeishuReplyDeliveryResult;
    generation?: number;
    error?: unknown;
  };
  type ClosedStreamingSettlement = StreamingCloseOutcome & {
    content: string;
    contentClaimed?: boolean;
  };
  const closedStreamingSettlements = new Map<number, ClosedStreamingSettlement>();
  let sentIndependentBlockText = false;
  let partialUpdateQueue: Promise<void> = Promise.resolve();
  let streamingStartPromise: Promise<void> | null = null;
  let streamingGeneration = 0;
  let activeStreamingGeneration: number | undefined;
  let inFlightStreamingClose:
    | {
        session: FeishuStreamingSession;
        generation: number;
        content: string;
        disposition: StreamingDisposition;
        promise: Promise<StreamingCloseOutcome>;
      }
    | undefined;
  let visibleReplySent = false;
  type ReplyOutcome =
    | { kind: "skipped"; reason: string; assistantMessageIndex?: number }
    | { kind: "suppressed"; reason: string }
    | { kind: "failed" };
  let replyOutcome: ReplyOutcome | undefined;
  let idleSideEffectsPromise: Promise<void> = Promise.resolve();
  let activeIdleSideEffectsPromise: Promise<void> | null = null;
  let idleRequestedForReply = false;
  let replyLifecycleStateInitialized = false;
  type PendingStreamingDelivery = {
    result: FeishuReplyDeliveryResult;
    infoKind?: string;
    streamingGeneration?: number;
    resolve: (result: FeishuReplyDeliveryResult) => void;
    reject: (error: unknown) => void;
  };
  const pendingStreamingDeliveries: PendingStreamingDelivery[] = [];
  type StreamTextUpdateMode = "snapshot" | "delta";

  const markVisibleReplySent = () => {
    visibleReplySent = true;
  };

  const formatReasoningPrefix = (thinking: string): string => {
    if (!thinking) {
      return "";
    }
    const withoutLabel = thinking.replace(/^(?:Reasoning:|Thinking\.{0,3})\s*/u, "");
    const plain = withoutLabel.replace(/^_(.*)_$/gm, "$1");
    const lines = plain.split("\n").map((line) => `> ${line}`);
    return `> 💭 **Thinking**\n${lines.join("\n")}`;
  };

  const buildCombinedStreamText = (thinking: string, answer: string): string => {
    const parts: string[] = [];
    if (thinking) {
      parts.push(formatReasoningPrefix(thinking));
    }
    if (thinking && answer) {
      parts.push("\n\n---\n\n");
    }
    if (answer) {
      parts.push(answer);
    }
    if (statusLine) {
      parts.push(parts.length > 0 ? `\n\n${statusLine}` : statusLine);
    }
    return parts.join("");
  };

  const flushStreamingCardUpdate = (combined: string) => {
    const session = streaming;
    const generation = activeStreamingGeneration;
    const startPromise = streamingStartPromise;
    partialUpdateQueue = partialUpdateQueue.then(async () => {
      if (startPromise) {
        await startPromise;
      }
      // Updates queued before close owns the captured session; updates queued after the
      // generation is sealed have no owner and cannot race provider finalization.
      if (generation !== undefined && session?.isActive()) {
        await session.update(combined);
      }
    });
  };

  const queueStreamingUpdate = (
    nextText: string,
    options?: {
      dedupeWithLastPartial?: boolean;
      mode?: StreamTextUpdateMode;
    },
  ) => {
    if (!nextText) {
      return;
    }
    if (options?.dedupeWithLastPartial && nextText === lastPartial) {
      return;
    }
    if (options?.dedupeWithLastPartial) {
      lastPartial = nextText;
    }
    const mode = options?.mode ?? "snapshot";
    if (mode === "delta") {
      streamText = `${streamText}${nextText}`;
    } else {
      const currentSnapshotText = snapshotBaseText
        ? streamText.slice(snapshotBaseText.length)
        : streamText;
      const startsNewSnapshotBlock =
        lastSnapshotTextLength >= 20 &&
        nextText.length < lastSnapshotTextLength * 0.5 &&
        !currentSnapshotText.includes(nextText);
      if (startsNewSnapshotBlock) {
        snapshotBaseText = streamText;
        streamText = `${snapshotBaseText}${nextText}`;
      } else {
        streamText = `${snapshotBaseText}${mergeStreamingText(currentSnapshotText, nextText)}`;
      }
      lastSnapshotTextLength = nextText.length;
    }
    flushStreamingCardUpdate(buildCombinedStreamText(reasoningText, streamText));
  };

  const queueReasoningUpdate = (nextThinking: string) => {
    if (!nextThinking) {
      return;
    }
    reasoningText = nextThinking;
    flushStreamingCardUpdate(buildCombinedStreamText(reasoningText, streamText));
  };

  const startStreaming = () => {
    if (
      !streamingEnabled ||
      streamingStartPromise ||
      streaming ||
      isStreamingStartBackedOff(account.accountId)
    ) {
      return;
    }
    streamingStartPromise = (async () => {
      const creds =
        account.appId && account.appSecret
          ? {
              appId: account.appId,
              appSecret: account.appSecret,
              domain: account.domain,
              httpTimeoutMs: resolveConfiguredHttpTimeoutMs(account),
            }
          : null;
      if (!creds) {
        return;
      }

      const session = new FeishuStreamingSession(createFeishuClient(account), creds, (message) =>
        params.runtime.log?.(`feishu[${account.accountId}] ${message}`),
      );
      const generation = ++streamingGeneration;
      streaming = session;
      activeStreamingGeneration = generation;
      try {
        const cardHeader = resolveCardHeader(agentId, identity);
        const cardNote = resolveCardNote(agentId, identity, responsePrefixContextProvider());
        const streamingTarget = sendTarget
          .replace(/^(feishu|lark):/i, "")
          .replace(/^(chat|user|group|dm|open_id):/i, "")
          .trim();
        await session.start(streamingTarget, resolveReceiveIdType(sendTarget), {
          replyToMessageId: sendReplyToMessageId,
          replyInThread: effectiveReplyInThread,
          rootId,
          header: cardHeader,
          note: cardNote,
        });
        streamingStartBackoffUntilByAccount.delete(account.accountId);
      } catch (error) {
        rememberStreamingStartFailure(account.accountId);
        params.runtime.error?.(
          `feishu[${account.accountId}]: streaming start failed; using non-streaming card fallback for ${
            STREAMING_START_FAILURE_BACKOFF_MS / 1000
          }s: ${String(error)}`,
        );
        if (streaming === session) {
          streaming = null;
          streamingStartPromise = null;
          activeStreamingGeneration = undefined;
        }
      }
    })();
  };

  const resetStreamingState = () => {
    streaming = null;
    streamingStartPromise = null;
    activeStreamingGeneration = undefined;
    partialUpdateQueue = Promise.resolve();
    streamText = "";
    lastPartial = "";
    reasoningText = "";
    statusLine = "";
    snapshotBaseText = "";
    lastSnapshotTextLength = 0;
    hasStreamingFinalText = false;
  };

  const rememberClosedStreamingSettlement = (
    generation: number | undefined,
    content: string,
    result: FeishuReplyDeliveryResult,
    error?: unknown,
    disposition: StreamingDisposition = "closed",
  ) => {
    if (generation === undefined || (!content && disposition === "closed")) {
      return;
    }
    closedStreamingSettlements.set(generation, {
      disposition,
      result,
      content,
      ...(error === undefined ? {} : { error }),
    });
  };

  const performStreamingClose = async (
    disposition: StreamingDisposition,
  ): Promise<StreamingCloseOutcome> => {
    const streamingToClose = streaming;
    const generationToClose = activeStreamingGeneration;
    const startPromiseToClose = streamingStartPromise;
    const updateQueueToClose = partialUpdateQueue;
    const finalizedAnswerText = streamText;
    const finalizedReasoningText = reasoningText;
    const outcome = {
      disposition,
      ...(generationToClose === undefined ? {} : { generation: generationToClose }),
    };
    // Seal this generation before provider I/O. Deliveries arriving during close were not part
    // of its captured content and must take a new/static path instead of inheriting its receipt.
    if (generationToClose !== undefined && activeStreamingGeneration === generationToClose) {
      activeStreamingGeneration = undefined;
    }
    try {
      if (startPromiseToClose) {
        await startPromiseToClose;
      }
      await updateQueueToClose;
      let result = noVisibleFeishuReplyDelivery;
      let finalizationError: unknown;
      if (streamingToClose?.isActive()) {
        statusLine = "";
        const text = buildCombinedStreamText(finalizedReasoningText, finalizedAnswerText);
        let closed;
        try {
          if (disposition === "discarded") {
            closed = await streamingToClose.discard();
          } else {
            const finalNote = resolveCardNote(agentId, identity, responsePrefixContextProvider());
            closed = await streamingToClose.closeWithResult(text, { note: finalNote });
          }
        } catch (error: unknown) {
          if (!(error instanceof FeishuStreamingFinalizationError)) {
            throw error;
          }
          closed = error.result;
          finalizationError = error;
        }
        result = createFeishuReplyDeliveryResult({
          results: [closed],
          visibleReplySent: closed.visibleReplySent,
          content: closed.content,
          kind: "card",
        });
        if (result.visibleReplySent) {
          markVisibleReplySent();
        }
        // Only a retained final can satisfy a duplicate text payload. Requested removal
        // and actual accepted content are separate facts when provider cleanup fails.
        if (
          disposition === "closed" &&
          result.visibleReplySent &&
          finalizedAnswerText &&
          (finalizationError === undefined || result.content === text)
        ) {
          deliveredFinalTexts.add(finalizedAnswerText);
        }
        if (
          finalizationError instanceof FeishuStreamingFinalizationError &&
          result.visibleReplySent
        ) {
          finalizationError = createFeishuPartialReplyDeliveryError(
            finalizationError.cause ?? finalizationError,
            result,
          );
        }
      }
      if (
        disposition === "discarded" ||
        finalizationError !== undefined ||
        (result.visibleReplySent && finalizedAnswerText)
      ) {
        // Pending and media-delayed payloads still own this generation. A discarded
        // generation must never recover its obsolete prose through a new static card.
        rememberClosedStreamingSettlement(
          generationToClose,
          finalizedAnswerText,
          result,
          finalizationError,
          disposition,
        );
      }
      return {
        ...outcome,
        result,
        ...(finalizationError === undefined ? {} : { error: finalizationError }),
      };
    } catch (error: unknown) {
      if (disposition === "discarded") {
        rememberClosedStreamingSettlement(
          generationToClose,
          finalizedAnswerText,
          noVisibleFeishuReplyDelivery,
          error,
          disposition,
        );
      }
      return {
        ...outcome,
        result: noVisibleFeishuReplyDelivery,
        error,
      };
    } finally {
      // A delivery overlapping this await may replace the closed session. Never clear that new
      // owner; the idle drain will close it in the next serialized iteration.
      if (streaming === streamingToClose) {
        resetStreamingState();
      }
    }
  };

  const closeStreaming = (
    disposition: StreamingDisposition = "closed",
  ): Promise<StreamingCloseOutcome> => {
    const session = streaming;
    const generation = activeStreamingGeneration;
    // Closing seals the active generation before awaiting I/O. The captured session,
    // not that cleared generation field, owns any concurrent close/discard request.
    if (session && inFlightStreamingClose?.session === session) {
      return inFlightStreamingClose.promise;
    }
    const content = streamText;
    const closePromise = performStreamingClose(disposition);
    if (session && generation !== undefined) {
      const closing = { session, generation, content, disposition, promise: closePromise };
      inFlightStreamingClose = closing;
      const clear = () => {
        if (inFlightStreamingClose === closing) {
          inFlightStreamingClose = undefined;
        }
      };
      void closePromise.then(clear, clear);
    }
    return closePromise;
  };

  const deferStreamingDelivery = (
    result: FeishuReplyDeliveryResult,
    infoKind?: string,
    ownerGeneration?: number,
  ): FeishuReplyDeliveryResultWithFinalization => {
    let resolveFinalization!: (result: FeishuReplyDeliveryResult) => void;
    let rejectFinalization!: (error: unknown) => void;
    const finalization = new Promise<FeishuReplyDeliveryResult>((resolve, reject) => {
      resolveFinalization = resolve;
      rejectFinalization = reject;
    });
    pendingStreamingDeliveries.push({
      result,
      ...(infoKind ? { infoKind } : {}),
      ...(ownerGeneration === undefined ? {} : { streamingGeneration: ownerGeneration }),
      resolve: resolveFinalization,
      reject: rejectFinalization,
    });
    if (idleRequestedForReply) {
      void queueIdleSideEffects().catch((error: unknown) =>
        params.runtime.error?.(
          `feishu[${account.accountId}] late reply finalization failed: ${String(error)}`,
        ),
      );
    }
    return { ...noVisibleFeishuReplyDelivery, finalization };
  };

  const discardStreamingPreview = async () => {
    if (
      streaming &&
      inFlightStreamingClose?.session === streaming &&
      inFlightStreamingClose.disposition === "closed"
    ) {
      // The earlier reply owns this sealed close and its receipt. Detach it so a
      // new payload can progress; the idle pass still settles its captured owner.
      resetStreamingState();
      return;
    }
    const outcome = await closeStreaming("discarded");
    if (outcome.error !== undefined) {
      throw toFeishuError(outcome.error);
    }
  };

  const updateStreamingStatusLine = (
    nextStatusLine: string,
    options?: { startIfNeeded?: boolean },
  ) => {
    statusLine = nextStatusLine;
    const hasStreamingSession = Boolean(streaming?.isActive() || streamingStartPromise);
    if (!hasStreamingSession && (options?.startIfNeeded === false || renderMode !== "card")) {
      return false;
    }
    startStreaming();
    flushStreamingCardUpdate(buildCombinedStreamText(reasoningText, streamText));
    return false;
  };

  const sendChunkedTextReply = async (paramsLocal: {
    text: string;
    useCard: boolean;
    infoKind?: string;
    firstChunkMentions?: MentionTarget[];
    chunkMentions?: MentionTarget[];
    header?: CardHeaderConfig;
    note?: string;
    sendChunk: (params: {
      chunk: string;
      isFirst: boolean;
      mentions?: MentionTarget[];
    }) => Promise<FeishuReplyDeliverySource>;
  }): Promise<FeishuReplyDeliveryResult> => {
    const chunkSource = paramsLocal.useCard
      ? paramsLocal.text
      : materializeFeishuPostMarkdownSoftBreaks(
          core.channel.text.convertMarkdownTables(paramsLocal.text, tableMode),
        );
    const initialChunks = core.channel.text.chunkMarkdownTextWithMode(
      chunkSource,
      textChunkLimit,
      chunkMode,
    );
    const chunkOptions = {
      text: chunkSource,
      limit: textChunkLimit,
      mode: chunkMode,
      firstChunkMentions: paramsLocal.firstChunkMentions,
      chunkMentions: paramsLocal.chunkMentions,
      initialChunks,
    };
    const chunks = resolveTextChunksWithFallback(
      chunkSource,
      paramsLocal.useCard
        ? chunkFeishuCardMarkdown({
            ...chunkOptions,
            header: paramsLocal.header,
            note: paramsLocal.note,
          })
        : chunkFeishuPostMarkdown(chunkOptions),
    );
    const results: FeishuReplyDeliverySource[] = [];
    const acceptedChunks: string[] = [];
    for (const [index, chunk] of chunks.entries()) {
      const mentions = [
        ...(paramsLocal.chunkMentions ?? []),
        ...(index === 0 ? (paramsLocal.firstChunkMentions ?? []) : []),
      ];
      try {
        const result = await paramsLocal.sendChunk({
          chunk,
          isFirst: index === 0,
          mentions: mentions.length > 0 ? mentions : undefined,
        });
        results.push(result);
        acceptedChunks.push(chunk);
        markVisibleReplySent();
      } catch (error: unknown) {
        const acceptedChunk = isChannelPartialDeliveryError(error)
          ? error.deliveryResult
          : undefined;
        if (acceptedChunk) {
          acceptedChunks.push(acceptedChunk.content ?? chunk);
          markVisibleReplySent();
        }
        throw createFeishuPartialReplyDeliveryError(error, {
          ...acceptedChunk,
          ...createFeishuReplyDeliveryResult({
            results,
            visibleReplySent: results.length > 0 || acceptedChunk !== undefined,
            content: acceptedChunks.join(""),
            kind: paramsLocal.useCard ? "card" : "text",
          }),
        });
      }
    }
    if (paramsLocal.infoKind === "final") {
      deliveredFinalTexts.add(paramsLocal.text);
    }
    return createFeishuReplyDeliveryResult({
      results,
      visibleReplySent: results.length > 0,
      content: paramsLocal.text,
      kind: paramsLocal.useCard ? "card" : "text",
    });
  };

  const sendPostReply = (text: string, infoKind?: string, firstChunkMentions?: MentionTarget[]) =>
    sendChunkedTextReply({
      text,
      useCard: false,
      infoKind,
      firstChunkMentions,
      chunkMentions: requiredMentionTargets,
      sendChunk: ({ chunk, mentions }) =>
        sendMessageFeishu({
          cfg,
          to: sendTarget,
          text: chunk,
          replyToMessageId: sendReplyToMessageId,
          replyInThread: effectiveReplyInThread,
          allowTopLevelReplyFallback,
          accountId,
          ...(mentions ? { mentions } : {}),
        }),
    });

  const sendMediaReplies = async (
    payload: ReplyPayload,
    options?: { fallbackText?: string },
  ): Promise<FeishuReplyDeliveryResult> => {
    const mediaUrls = resolveSendableOutboundReplyParts(payload).mediaUrls;
    let sentFallbackText = false;
    let degradedVoiceFallbackText: string | undefined;
    const results: FeishuReplyDeliveryResult[] = [];
    try {
      await sendMediaWithLeadingCaption({
        mediaUrls,
        caption: "",
        send: async ({ mediaUrl }) => {
          const result = await sendMediaFeishu({
            cfg,
            to: sendTarget,
            mediaUrl,
            replyToMessageId: sendReplyToMessageId,
            replyInThread: effectiveReplyInThread,
            allowTopLevelReplyFallback,
            accountId,
            ...(payload.audioAsVoice === true ? { audioAsVoice: true } : {}),
          });
          results.push(
            createFeishuReplyDeliveryResult({
              results: [result],
              visibleReplySent: true,
              kind: result?.voiceIntentDegradedToFile ? "media" : undefined,
            }),
          );
          markVisibleReplySent();
          if (result?.voiceIntentDegradedToFile && options?.fallbackText && !sentFallbackText) {
            degradedVoiceFallbackText = options.fallbackText;
          }
        },
        onError:
          options?.fallbackText === undefined
            ? undefined
            : async ({ error, mediaUrl }) => {
                if (isChannelPartialDeliveryError(error)) {
                  // The attachment is already visible; text recovery would duplicate delivery.
                  markVisibleReplySent();
                  throw toFeishuError(error);
                }
                const fallbackText = await buildFeishuMediaFallbackText({
                  text: sentFallbackText ? undefined : options.fallbackText,
                  mediaUrl,
                });
                sentFallbackText = true;
                results.push(await sendPostReply(fallbackText, "final"));
              },
      });
      if (degradedVoiceFallbackText && !sentFallbackText) {
        sentFallbackText = true;
        results.push(await sendPostReply(degradedVoiceFallbackText, "final"));
      }
    } catch (error: unknown) {
      const partial = isChannelPartialDeliveryError(error) ? error.deliveryResult : undefined;
      if (partial) {
        markVisibleReplySent();
      }
      throw createFeishuPartialReplyDeliveryError(
        error,
        mergeFeishuReplyDeliveryResults([...results, ...(partial ? [partial] : [])]),
      );
    }
    return mergeFeishuReplyDeliveryResults(results);
  };

  const ensureNoVisibleReplyFallback = async (reason: string): Promise<boolean> => {
    await idleSideEffectsPromise;
    if (visibleReplySent) {
      return false;
    }
    if (
      replyOutcome?.kind === "suppressed" ||
      (replyOutcome?.kind === "skipped" && replyOutcome.reason === "silent")
    ) {
      params.runtime.log?.(
        `feishu[${account.accountId}]: no-visible-reply fallback skipped for ${replyOutcome.reason} (${reason})`,
      );
      return false;
    }
    await sendMessageFeishu({
      cfg,
      to: sendTarget,
      text: NO_VISIBLE_REPLY_FALLBACK_TEXT,
      replyToMessageId: sendReplyToMessageId,
      replyInThread: effectiveReplyInThread,
      allowTopLevelReplyFallback,
      accountId,
      ...(requiredMentionTargets?.length ? { mentions: requiredMentionTargets } : {}),
    });
    markVisibleReplySent();
    params.runtime.error?.(
      `feishu[${account.accountId}]: sent no-visible-reply fallback (${reason})`,
    );
    return true;
  };

  const claimClosedStreamingResult = (
    generation: number | undefined,
    content: string | undefined,
  ): ClosedStreamingSettlement | undefined => {
    if (generation !== undefined) {
      // Several logical payloads can share one CardKit session, and media can delay each
      // completion until after close. The per-turn generation settlement is immutable so every
      // owner can reuse the same provider identity without emitting a duplicate fallback.
      const settlement = closedStreamingSettlements.get(generation);
      if (settlement) {
        settlement.contentClaimed = true;
      }
      return settlement;
    }
    let latestKey: number | undefined;
    for (const [key, settlement] of closedStreamingSettlements) {
      if (
        settlement.contentClaimed !== true &&
        (content === undefined || settlement.content === content)
      ) {
        latestKey = key;
      }
    }
    if (latestKey === undefined) {
      return undefined;
    }
    const result = closedStreamingSettlements.get(latestKey);
    if (result) {
      result.contentClaimed = true;
    }
    return result;
  };

  const markClosedStreamingContentClaimed = (generation: number | undefined): void => {
    if (generation !== undefined) {
      const settlement = closedStreamingSettlements.get(generation);
      if (settlement) {
        settlement.contentClaimed = true;
      }
    }
  };

  const ensureVisibleStreamingDelivery = async (
    result: FeishuReplyDeliveryResult | undefined,
    content: string | undefined,
    infoKind?: string,
  ): Promise<FeishuReplyDeliveryResult | undefined> => {
    if (result?.visibleReplySent === true || !content?.trim()) {
      return result;
    }
    const cardHeader = resolveCardHeader(agentId, identity);
    const cardNote = resolveCardNote(agentId, identity, responsePrefixContextProvider());
    return await sendChunkedTextReply({
      text: content,
      useCard: true,
      infoKind,
      header: cardHeader,
      note: cardNote,
      chunkMentions: requiredMentionTargets,
      sendChunk: async ({ chunk, mentions }) =>
        await sendStructuredCardFeishu({
          cfg,
          to: sendTarget,
          text: chunk,
          replyToMessageId: sendReplyToMessageId,
          replyInThread: effectiveReplyInThread,
          allowTopLevelReplyFallback,
          accountId,
          header: cardHeader,
          note: cardNote,
          ...(mentions ? { mentions } : {}),
        }),
    });
  };

  function queueIdleSideEffects(): Promise<void> {
    idleRequestedForReply = true;
    if (activeIdleSideEffectsPromise) {
      return activeIdleSideEffectsPromise;
    }
    const nextIdleSideEffects = idleSideEffectsPromise.then(async () => {
      try {
        do {
          // Include deliveries appended while CardKit close is in flight; every returned
          // finalization promise must be owned by this idle pass or a later loop iteration.
          const completions = pendingStreamingDeliveries.splice(0);
          const closeOutcome = await closeStreaming();
          const finalized = closeOutcome.result;
          const ownsCurrentClose = (completion: PendingStreamingDelivery) =>
            closeOutcome.generation !== undefined &&
            completion.streamingGeneration === closeOutcome.generation;
          if (completions.some((completion) => ownsCurrentClose(completion))) {
            markClosedStreamingContentClaimed(closeOutcome.generation);
          }
          for (const completion of completions) {
            const claimedSettlement = ownsCurrentClose(completion)
              ? {
                  disposition: closeOutcome.disposition,
                  result: finalized,
                  ...(closeOutcome.error === undefined ? {} : { error: closeOutcome.error }),
                }
              : claimClosedStreamingResult(
                  completion.streamingGeneration,
                  completion.result.content,
                );
            const deliveryError = claimedSettlement?.error;
            if (claimedSettlement?.disposition === "discarded") {
              const retained = mergeFeishuReplyDeliveryResults(
                [claimedSettlement.result, completion.result],
                claimedSettlement.result.content ?? "",
              );
              if (deliveryError !== undefined) {
                completion.reject(createFeishuPartialReplyDeliveryError(deliveryError, retained));
              } else {
                completion.resolve(retained);
              }
              continue;
            }
            let providerFinalized = claimedSettlement?.result;
            try {
              providerFinalized = await ensureVisibleStreamingDelivery(
                providerFinalized,
                completion.result.content,
                completion.infoKind,
              );
            } catch (fallbackError: unknown) {
              const fallbackPartial = isChannelPartialDeliveryError(fallbackError)
                ? fallbackError.deliveryResult
                : undefined;
              const fallbackCause =
                fallbackPartial && fallbackError instanceof Error
                  ? (fallbackError.cause ?? fallbackError)
                  : fallbackError;
              completion.reject(
                createFeishuPartialReplyDeliveryError(
                  deliveryError === undefined
                    ? fallbackCause
                    : new AggregateError(
                        [deliveryError, fallbackCause],
                        "Feishu streaming finalization and static fallback failed",
                      ),
                  mergeFeishuReplyDeliveryResults(
                    [
                      ...(providerFinalized ? [providerFinalized] : []),
                      ...(fallbackPartial ? [fallbackPartial] : []),
                      completion.result,
                    ],
                    fallbackPartial?.content ??
                      providerFinalized?.content ??
                      completion.result.content,
                  ),
                ),
              );
              continue;
            }
            // The finalized card is the public identity; each logical payload retains its own text.
            const settledResult = mergeFeishuReplyDeliveryResults(
              [...(providerFinalized ? [providerFinalized] : []), completion.result],
              deliveryError === undefined
                ? (completion.result.content ?? providerFinalized?.content)
                : (providerFinalized?.content ?? completion.result.content),
            );
            if (deliveryError !== undefined) {
              completion.reject(
                createFeishuPartialReplyDeliveryError(
                  isChannelPartialDeliveryError(deliveryError) && deliveryError instanceof Error
                    ? (deliveryError.cause ?? deliveryError)
                    : deliveryError instanceof FeishuStreamingFinalizationError
                      ? (deliveryError.cause ?? deliveryError)
                      : deliveryError,
                  settledResult,
                ),
              );
            } else {
              completion.resolve(settledResult);
            }
          }
          if (closeOutcome.error !== undefined) {
            throw toFeishuError(closeOutcome.error);
          }
        } while (pendingStreamingDeliveries.length > 0);
      } finally {
        typingCallbacks?.onIdle?.();
      }
    });
    activeIdleSideEffectsPromise = nextIdleSideEffects;
    idleSideEffectsPromise = nextIdleSideEffects.catch(() => {});
    const finishIdleSideEffects = () => {
      if (activeIdleSideEffectsPromise === nextIdleSideEffects) {
        activeIdleSideEffectsPromise = null;
      }
      if (pendingStreamingDeliveries.length > 0) {
        void queueIdleSideEffects().catch((error: unknown) =>
          params.runtime.error?.(
            `feishu[${account.accountId}] queued reply finalization failed: ${String(error)}`,
          ),
        );
      }
    };
    void nextIdleSideEffects.then(finishIdleSideEffects, finishIdleSideEffects);
    return nextIdleSideEffects;
  }

  const throwStreamingDeliveryFailure = async (paramsLocal: {
    error: unknown;
    content: string;
    infoKind?: string;
    ownerGeneration?: number;
  }): Promise<never> => {
    let finalized = noVisibleFeishuReplyDelivery;
    let finalizationError: unknown;
    let fallbackPartial: FeishuReplyDeliveryResult | undefined;
    let settlement: StreamingCloseOutcome | undefined = claimClosedStreamingResult(
      paramsLocal.ownerGeneration,
      paramsLocal.content,
    );
    if (
      !settlement &&
      paramsLocal.ownerGeneration !== undefined &&
      inFlightStreamingClose?.generation === paramsLocal.ownerGeneration
    ) {
      const closeOutcome = await inFlightStreamingClose.promise;
      settlement =
        claimClosedStreamingResult(paramsLocal.ownerGeneration, paramsLocal.content) ??
        closeOutcome;
    } else if (
      !settlement &&
      paramsLocal.ownerGeneration !== undefined &&
      activeStreamingGeneration === paramsLocal.ownerGeneration
    ) {
      settlement = await closeStreaming();
    }
    finalized = settlement?.result ?? finalized;
    finalizationError = settlement?.error;
    const discarded = settlement?.disposition === "discarded";
    try {
      if (!discarded) {
        finalized =
          (await ensureVisibleStreamingDelivery(
            finalized,
            paramsLocal.content,
            paramsLocal.infoKind,
          )) ?? finalized;
      }
    } catch (fallbackError: unknown) {
      fallbackPartial = isChannelPartialDeliveryError(fallbackError)
        ? fallbackError.deliveryResult
        : undefined;
      const fallbackCause =
        fallbackPartial && fallbackError instanceof Error
          ? (fallbackError.cause ?? fallbackError)
          : fallbackError;
      finalizationError = finalizationError
        ? new AggregateError(
            [finalizationError, fallbackCause],
            "Feishu streaming finalization and static fallback failed",
          )
        : fallbackCause;
    }
    const mediaPartial = isChannelPartialDeliveryError(paramsLocal.error)
      ? paramsLocal.error.deliveryResult
      : undefined;
    const accepted = mergeFeishuReplyDeliveryResults(
      [
        finalized,
        ...(fallbackPartial ? [fallbackPartial] : []),
        ...(mediaPartial ? [mediaPartial] : []),
      ],
      discarded
        ? (finalized.content ?? "")
        : fallbackPartial?.visibleReplySent === true
          ? fallbackPartial.content
          : finalized.visibleReplySent === true
            ? finalized.content
            : paramsLocal.content,
    );
    const mediaCause =
      mediaPartial && paramsLocal.error instanceof Error
        ? (paramsLocal.error.cause ?? paramsLocal.error)
        : paramsLocal.error;
    const cause = finalizationError
      ? new AggregateError(
          [
            mediaCause,
            finalizationError instanceof Error
              ? (finalizationError.cause ?? finalizationError)
              : finalizationError,
          ],
          "Feishu reply delivery and streaming finalization failed",
        )
      : mediaCause;
    throw createFeishuPartialReplyDeliveryError(cause, accepted);
  };

  const dispatcherOptions: NonNullable<ChannelInboundTurnPlan["dispatcherOptions"]> = {
    responsePrefix,
    responsePrefixContextProvider,
    humanDelay: resolveHumanDelayConfig(cfg, agentId),
    silentReplyContext: {
      cfg,
      sessionKey: params.sessionKey,
      surface: "feishu",
      conversationType: chatId.startsWith("oc_") ? "group" : "direct",
    },
    onSkip: (_payload, info) => {
      if (
        replyOutcome?.kind !== "failed" &&
        (info.kind === "final" || (info.kind === "block" && info.reason === "silent"))
      ) {
        replyOutcome = {
          kind: "skipped",
          reason: info.reason,
          assistantMessageIndex: info.assistantMessageIndex,
        };
      }
    },
    beforeDeliver: (payload, info) => {
      // Enqueue-time silence may be newer than this queued block. Reset before either
      // modifying hook, since cancellation skips native delivery entirely.
      const preservesNewerSilence =
        replyOutcome?.kind === "skipped" &&
        replyOutcome.reason === "silent" &&
        info.kind !== "final" &&
        replyOutcome.assistantMessageIndex !== undefined &&
        info.assistantMessageIndex !== undefined &&
        info.assistantMessageIndex < replyOutcome.assistantMessageIndex;
      if (!preservesNewerSilence && replyOutcome?.kind !== "failed") {
        replyOutcome = undefined;
      }
      return payload;
    },
    onReplyStart: async () => {
      if (!replyLifecycleStateInitialized) {
        replyLifecycleStateInitialized = true;
        deliveredFinalTexts.clear();
        closedStreamingSettlements.clear();
        sentIndependentBlockText = false;
        idleRequestedForReply = false;
        visibleReplySent = false;
        replyOutcome = undefined;
      }
      if (previewStreamingEnabled && renderMode === "card") {
        startStreaming();
      }
      await Promise.resolve(typingCallbacks?.onReplyStart?.());
    },
    onIdle: () => queueIdleSideEffects(),
    onCleanup: () => {
      typingCallbacks?.onCleanup?.();
    },
  };
  const handleDeliveryError = async (error: unknown, info: { kind: string }) => {
    if (info.kind === "final") {
      // Later suppression cannot erase a failed final; accepted visibility still
      // prevents recovery from duplicating any native reply.
      replyOutcome = { kind: "failed" };
    }
    if (isChannelPartialDeliveryError(error)) {
      // Core invokes this before no-visible recovery; keep accepted sends visible even
      // when their normal success bookkeeping could not run.
      markVisibleReplySent();
    }
    params.runtime.error?.(
      `feishu[${account.accountId}] ${info.kind} reply failed: ${String(error)}`,
    );
    await queueIdleSideEffects().catch((cleanupError: unknown) =>
      params.runtime.error?.(
        `feishu[${account.accountId}] reply error cleanup failed: ${String(cleanupError)}`,
      ),
    );
  };
  const delivery: ChannelInboundTurnPlan["delivery"] = {
    observeMessageSent: true,
    onDelivered: (_payload, info, result) => {
      if (result?.visibleReplySent) {
        markVisibleReplySent();
        if (info.kind === "final") {
          replyOutcome = undefined;
        }
        return;
      }
      const reason = result?.suppression?.reason;
      if (
        info.kind === "final" &&
        replyOutcome?.kind !== "failed" &&
        (reason === "cancelled_by_reply_payload_sending_hook" ||
          reason === "empty_after_reply_payload_sending_hook" ||
          reason === "cancelled_by_message_sending_hook" ||
          reason === "empty_after_message_sending_hook" ||
          reason === "channel_transform")
      ) {
        replyOutcome = { kind: "suppressed", reason };
      }
    },
    deliver: async (inputPayload: ReplyPayload, info) => {
      // Delivery runs after modifying hooks. Render here so native cards carry the
      // accepted prose, and a canceled payload never creates a card.
      const prepared = await renderFeishuReplyPayload(inputPayload, {
        to: sendTarget,
        identity,
        // Cards notify only required bot recipients; incoming user mentions remain context.
        mentions: requiredMentionTargets,
      });
      const rendered = consumeFeishuPresentationFallbackMarker(prepared.payload);
      const payload = rendered.payload;
      const presentationCard = prepared.card;
      const hasPresentationFallback = rendered.presentationFallback?.hasVisibleContent === true;
      const hasIndependentPresentation = presentationCard !== undefined || hasPresentationFallback;
      const resolvedText = payload.text;
      const payloadText =
        payload.isReasoning && resolvedText ? formatReasoningMessage(resolvedText) : resolvedText;
      const reply = resolveSendableOutboundReplyParts({ ...payload, text: payloadText });
      const text =
        info?.kind === "final" && !hasIndependentPresentation
          ? mergeStreamingFinalText(
              streamText,
              reply.text,
              payload.isError === true && hasStreamingFinalText,
            )
          : reply.text;
      const hasText = reply.hasText;
      const hasMedia = reply.hasMedia;
      const ttsSupplement = getReplyPayloadTtsSupplement(payload);
      const ttsTextAlreadyVisible = ttsSupplement?.visibleTextAlreadyDelivered === true;
      const hasVoiceMedia =
        hasMedia &&
        reply.mediaUrls.some((mediaUrl) =>
          shouldSuppressFeishuTextForVoiceMedia({
            mediaUrl,
            ...(payload.audioAsVoice === true ? { audioAsVoice: true } : {}),
            ttsSupplement,
          }),
        );
      const finalTextExceedsStreamingLimit =
        info?.kind === "final" && hasText && text.length > textChunkLimit;
      const useStaticCard =
        hasText &&
        (renderMode === "card" ||
          (info?.kind === "block" && coreBlockStreamingEnabled && renderMode !== "raw") ||
          (renderMode === "auto" && shouldUseCard(text)));
      const useStreamingCard =
        hasText &&
        streamingEnabled &&
        !finalTextExceedsStreamingLimit &&
        (info?.kind === "final" || useStaticCard);
      const useCard = useStaticCard || useStreamingCard;
      const skipTextForDuplicateFinal =
        !hasIndependentPresentation &&
        info?.kind === "final" &&
        hasText &&
        deliveredFinalTexts.has(text);
      const shouldDeliverText =
        hasText && (!hasVoiceMedia || hasPresentationFallback) && !skipTextForDuplicateFinal;
      // Error controls supplement a committed answer. Only a replacement final may
      // discard it; block/tool controls also leave the earlier reply owned by idle.
      const shouldDiscardStreamingPreview =
        info?.kind === "final" &&
        !(hasIndependentPresentation && payload.isError === true && hasStreamingFinalText) &&
        (hasIndependentPresentation ||
          finalTextExceedsStreamingLimit ||
          (hasMedia &&
            ((hasVoiceMedia && !shouldDeliverText && !ttsTextAlreadyVisible) ||
              skipTextForDuplicateFinal)));

      const priorClosedStreamingSettlement =
        info?.kind === "final" && hasText && skipTextForDuplicateFinal
          ? claimClosedStreamingResult(undefined, text)
          : undefined;
      if (!shouldDeliverText && !hasMedia && !presentationCard) {
        if (priorClosedStreamingSettlement?.error !== undefined) {
          throw toFeishuError(priorClosedStreamingSettlement.error);
        }
        return priorClosedStreamingSettlement?.result ?? noVisibleFeishuReplyDelivery;
      }

      const deliveredResults: FeishuReplyDeliveryResult[] = priorClosedStreamingSettlement
        ? [priorClosedStreamingSettlement.result]
        : [];
      const collectDelivery = async (
        pending: Promise<FeishuReplyDeliveryResult>,
        acceptedContent?: string,
      ): Promise<void> => {
        try {
          deliveredResults.push(await pending);
        } catch (error: unknown) {
          const partial = isChannelPartialDeliveryError(error) ? error.deliveryResult : undefined;
          const accumulated = mergeFeishuReplyDeliveryResults([
            ...deliveredResults,
            ...(partial ? [{ ...partial, content: partial.content ?? acceptedContent }] : []),
          ]);
          throw createFeishuPartialReplyDeliveryError(
            partial && error instanceof Error ? (error.cause ?? error) : error,
            // Media-only acceptance has no caption; omission would make core report
            // the rejected card's original prose as delivered.
            { ...accumulated, content: accumulated.content ?? "" },
          );
        }
      };

      if (shouldDiscardStreamingPreview) {
        await discardStreamingPreview();
      }

      if (presentationCard) {
        // A logical card owns its controls and attachments even when its prose repeats.
        if (hasMedia) {
          await collectDelivery(sendMediaReplies(payload));
        }
        await collectDelivery(
          sendCardFeishu({
            cfg,
            to: sendTarget,
            card: presentationCard,
            replyToMessageId: sendReplyToMessageId,
            replyInThread: effectiveReplyInThread,
            allowTopLevelReplyFallback,
            accountId,
          }).then((result) =>
            createFeishuReplyDeliveryResult({
              results: [result],
              visibleReplySent: true,
              content: resolvedText,
              kind: "card",
            }),
          ),
          resolvedText,
        );
        markVisibleReplySent();
        return mergeFeishuReplyDeliveryResults(deliveredResults, resolvedText);
      }

      if (shouldDeliverText) {
        // Later finals replace stream text. Each presentation fallback owns a
        // separate message; ordinary blocks retain their streaming policy.
        if (hasPresentationFallback || (info?.kind === "block" && !useStreamingCard)) {
          if (hasPresentationFallback || coreBlockStreamingEnabled) {
            const firstChunkMentions =
              info?.kind === "final" || (info?.kind === "block" && !sentIndependentBlockText)
                ? mentionTargets
                : undefined;
            await collectDelivery(sendPostReply(text, info?.kind, firstChunkMentions));
            if (info?.kind === "block") {
              sentIndependentBlockText = true;
            }
            if (hasMedia) {
              await collectDelivery(sendMediaReplies(payload));
            }
          }
          return mergeFeishuReplyDeliveryResults(deliveredResults, text);
        }
        if (info?.kind === "block") {
          startStreaming();
          if (streamingStartPromise) {
            await streamingStartPromise;
          }
        }

        if (info?.kind === "final" && useStreamingCard) {
          startStreaming();
          if (streamingStartPromise) {
            await streamingStartPromise;
          }
        }

        const shouldStreamText = info?.kind === "block" || info?.kind === "final";
        const matchingInFlightClose =
          info?.kind === "final" &&
          inFlightStreamingClose?.disposition === "closed" &&
          inFlightStreamingClose.content === text
            ? inFlightStreamingClose
            : undefined;
        const ownerGeneration = activeStreamingGeneration ?? matchingInFlightClose?.generation;
        if (
          shouldStreamText &&
          ownerGeneration !== undefined &&
          (streaming?.isActive() || matchingInFlightClose !== undefined)
        ) {
          if (activeStreamingGeneration !== undefined) {
            if (info?.kind === "block") {
              // Some runtimes emit block payloads without onPartial/final callbacks.
              // Mirror block text into streamText so onIdle close still sends content.
              queueStreamingUpdate(text, { mode: "delta", dedupeWithLastPartial: true });
            }
            if (info?.kind === "final") {
              // Final payloads can be cumulative snapshots or independent
              // notices. Preserve both when the latter arrives after an answer.
              streamText = text;
              hasStreamingFinalText = true;
              snapshotBaseText = "";
              lastSnapshotTextLength = text.length;
              flushStreamingCardUpdate(buildCombinedStreamText(reasoningText, streamText));
            }
          }
          // Send media even when streaming handled the text
          if (hasMedia) {
            try {
              await collectDelivery(sendMediaReplies(payload));
            } catch (error: unknown) {
              await throwStreamingDeliveryFailure({
                error,
                content: text,
                infoKind: info?.kind,
                ownerGeneration,
              });
            }
          }
          return deferStreamingDelivery(
            mergeFeishuReplyDeliveryResults(deliveredResults, text),
            info?.kind,
            ownerGeneration,
          );
        }

        if (useCard) {
          const cardHeader = resolveCardHeader(agentId, identity);
          const cardNote = resolveCardNote(agentId, identity, responsePrefixContextProvider());
          deliveredResults.push(
            await sendChunkedTextReply({
              text,
              useCard: true,
              infoKind: info?.kind,
              header: cardHeader,
              note: cardNote,
              chunkMentions: requiredMentionTargets,
              sendChunk: async ({ chunk, mentions }) =>
                await sendStructuredCardFeishu({
                  cfg,
                  to: sendTarget,
                  text: chunk,
                  replyToMessageId: sendReplyToMessageId,
                  replyInThread: effectiveReplyInThread,
                  allowTopLevelReplyFallback,
                  accountId,
                  header: cardHeader,
                  note: cardNote,
                  ...(mentions ? { mentions } : {}),
                }),
            }),
          );
        } else {
          const firstChunkMentions =
            info?.kind === "final" && mentionTargets?.length ? mentionTargets : undefined;
          deliveredResults.push(await sendPostReply(text, info?.kind, firstChunkMentions));
        }
      }

      if (hasMedia) {
        await collectDelivery(
          sendMediaReplies(
            payload,
            !shouldDeliverText && !ttsTextAlreadyVisible && hasVoiceMedia && hasText
              ? { fallbackText: text }
              : undefined,
          ),
        );
      }
      const deliveredContent = hasVoiceMedia ? (deliveredResults.at(-1)?.content ?? text) : text;
      const result = mergeFeishuReplyDeliveryResults(deliveredResults, deliveredContent);
      if (priorClosedStreamingSettlement?.error !== undefined) {
        throw createFeishuPartialReplyDeliveryError(
          isChannelPartialDeliveryError(priorClosedStreamingSettlement.error) &&
            priorClosedStreamingSettlement.error instanceof Error
            ? (priorClosedStreamingSettlement.error.cause ?? priorClosedStreamingSettlement.error)
            : priorClosedStreamingSettlement.error,
          result,
        );
      }
      return result;
    },
    // The shipped SDK declaration stays void; core still awaits the runtime promise.
    onError: handleDeliveryError as NonNullable<ChannelInboundTurnPlan["delivery"]["onError"]>,
  };

  return {
    dispatcherOptions,
    delivery,
    replyOptions: {
      onModelSelected,
      disableBlockStreaming:
        typeof blockStreamingEnabled === "boolean" ? !blockStreamingEnabled : true,
      onPartialReply: previewStreamingEnabled
        ? (payload: ReplyPayload) => {
            if (!payload.text) {
              return false;
            }
            const cleaned = stripReasoningTagsFromText(payload.text, {
              mode: "strict",
              trim: "both",
            });
            if (!cleaned) {
              return false;
            }
            startStreaming();
            queueStreamingUpdate(cleaned, {
              dedupeWithLastPartial: true,
              mode: "snapshot",
            });
            return false;
          }
        : undefined,
      onReasoningStream: reasoningPreviewEnabled
        ? (payload: ReplyPayload) => {
            if (!payload.text) {
              return false;
            }
            startStreaming();
            queueReasoningUpdate(formatReasoningMessage(payload.text));
            return false;
          }
        : undefined,
      onReasoningEnd: reasoningPreviewEnabled ? () => false : undefined,
      onToolStart: previewStreamingEnabled
        ? (payload: {
            name?: string;
            phase?: string;
            args?: Record<string, unknown>;
            detailMode?: "explain" | "raw";
          }) => {
            if (!isChannelProgressDraftWorkToolName(payload.name)) {
              return false;
            }
            const statusLineLocal = formatChannelProgressDraftLineForEntry(
              account.config,
              {
                event: "tool",
                name: payload.name,
                phase: payload.phase,
                args: payload.args,
              },
              {
                detailMode: payload.detailMode,
              },
            );
            if (statusLineLocal) {
              return updateStreamingStatusLine(statusLineLocal);
            }
            return false;
          }
        : undefined,
      onAssistantMessageStart: previewStreamingEnabled
        ? () => updateStreamingStatusLine("", { startIfNeeded: false })
        : undefined,
      onCompactionStart: previewStreamingEnabled
        ? () => updateStreamingStatusLine("📦 **Compacting context...**")
        : undefined,
      onCompactionEnd: previewStreamingEnabled ? () => updateStreamingStatusLine("") : undefined,
    },
    ensureNoVisibleReplyFallback,
    getVisibleReplyState: () => ({
      visibleReplySent,
      skippedFinalReason:
        replyOutcome?.kind === "skipped" || replyOutcome?.kind === "suppressed"
          ? replyOutcome.reason
          : null,
    }),
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
