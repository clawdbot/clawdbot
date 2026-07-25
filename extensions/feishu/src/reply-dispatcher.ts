// Feishu plugin module implements reply dispatcher behavior.
import { formatReasoningMessage, resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import { logTypingFailure } from "openclaw/plugin-sdk/channel-feedback";
import {
  isChannelPartialDeliveryError,
  type ChannelInboundTurnPlan,
} from "openclaw/plugin-sdk/channel-inbound";
import { createChannelMessageReplyPipeline } from "openclaw/plugin-sdk/channel-outbound";
import {
  formatChannelProgressDraftLineForEntry,
  isChannelProgressDraftWorkToolName,
  resolveChannelPreviewStreamMode,
  resolveChannelStreamingBlockEnabled,
} from "openclaw/plugin-sdk/channel-outbound";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
import {
  getReplyPayloadTtsSupplement,
  resolveSendableOutboundReplyParts,
  resolveTextChunksWithFallback,
  sendMediaWithLeadingCaption,
} from "openclaw/plugin-sdk/reply-payload";
import { stripReasoningTagsFromText } from "openclaw/plugin-sdk/text-chunking";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { resolveConfiguredHttpTimeoutMs } from "./client-timeout.js";
import { createFeishuClient } from "./client.js";
import { resolveFeishuIdentityEmoji } from "./identity-header.js";
import { chunkFeishuPostMarkdown, materializeFeishuPostMarkdownSoftBreaks } from "./markdown.js";
import { buildFeishuMediaFallbackText } from "./media-fallback.js";
import { sendMediaFeishu, shouldSuppressFeishuTextForVoiceMedia } from "./media.js";
import type { MentionTarget } from "./mention-target.types.js";
import {
  createFeishuPartialReplyDeliveryError,
  createFeishuReplyDeliveryResult,
  mergeFeishuReplyDeliveryResults,
  noVisibleFeishuReplyDelivery,
  type FeishuReplyDeliveryResult,
  type FeishuReplyDeliveryResultWithFinalization,
  type FeishuReplyDeliverySource,
} from "./reply-delivery-result.js";
import {
  createReplyPrefixContext,
  type ClawdbotConfig,
  type OutboundIdentity,
  type ReplyPayload,
  type RuntimeEnv,
} from "./reply-dispatcher-runtime-api.js";
import { streamingStartBackoffUntilByAccount } from "./reply-dispatcher-state.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMessageFeishu, sendStructuredCardFeishu, type CardHeaderConfig } from "./send.js";
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

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
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
  const prefixContext = createReplyPrefixContext({ cfg, agentId });

  let typingState: TypingIndicatorState | null = null;
  const { typingCallbacks } = createChannelMessageReplyPipeline({
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
  type ClosedStreamingSettlement = {
    result: FeishuReplyDeliveryResult;
    error?: unknown;
    content: string;
    contentClaimed?: boolean;
  };
  type StreamingCloseOutcome = {
    result: FeishuReplyDeliveryResult;
    generation?: number;
    error?: unknown;
  };
  const closedStreamingSettlements = new Map<number, ClosedStreamingSettlement>();
  let sentIndependentBlockText = false;
  let partialUpdateQueue: Promise<void> = Promise.resolve();
  let streamingStartPromise: Promise<void> | null = null;
  let streamingGeneration = 0;
  let activeStreamingGeneration: number | undefined;
  let inFlightStreamingClose:
    | { generation: number; content: string; promise: Promise<StreamingCloseOutcome> }
    | undefined;
  let visibleReplySent = false;
  let skippedFinalReason: string | null = null;
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
        const cardNote = resolveCardNote(agentId, identity, prefixContext.prefixContext);
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
  ) => {
    if (generation === undefined || !content) {
      return;
    }
    closedStreamingSettlements.set(generation, {
      result,
      content,
      ...(error === undefined ? {} : { error }),
    });
  };

  const performStreamingClose = async (): Promise<StreamingCloseOutcome> => {
    const streamingToClose = streaming;
    const generationToClose = activeStreamingGeneration;
    const startPromiseToClose = streamingStartPromise;
    const updateQueueToClose = partialUpdateQueue;
    const finalizedAnswerText = streamText;
    const finalizedReasoningText = reasoningText;
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
      if (streamingToClose?.isActive()) {
        statusLine = "";
        const text = buildCombinedStreamText(finalizedReasoningText, finalizedAnswerText);
        const finalNote = resolveCardNote(agentId, identity, prefixContext.prefixContext);
        let closed;
        try {
          closed = await streamingToClose.closeWithResult(text, { note: finalNote });
        } catch (error: unknown) {
          if (!(error instanceof FeishuStreamingFinalizationError)) {
            throw error;
          }
          const failedResult = createFeishuReplyDeliveryResult({
            results: [error.result],
            visibleReplySent: error.result.visibleReplySent,
            content: error.result.content,
            kind: "card",
          });
          if (failedResult.visibleReplySent) {
            markVisibleReplySent();
          }
          if (failedResult.visibleReplySent && finalizedAnswerText) {
            const partialError = createFeishuPartialReplyDeliveryError(
              error.cause ?? error,
              failedResult,
            );
            if (failedResult.content === text) {
              deliveredFinalTexts.add(finalizedAnswerText);
            }
            rememberClosedStreamingSettlement(
              generationToClose,
              finalizedAnswerText,
              failedResult,
              partialError,
            );
            return {
              result: failedResult,
              ...(generationToClose === undefined ? {} : { generation: generationToClose }),
              error: partialError,
            };
          }
          // Preserve the non-visible result so the settlement owner can recover the accepted
          // final text through the same static-card fallback as an ordinary empty close.
          rememberClosedStreamingSettlement(
            generationToClose,
            finalizedAnswerText,
            failedResult,
            error,
          );
          return {
            result: failedResult,
            ...(generationToClose === undefined ? {} : { generation: generationToClose }),
            error,
          };
        }
        const result = createFeishuReplyDeliveryResult({
          results: [closed],
          visibleReplySent: closed.visibleReplySent,
          content: closed.content,
          kind: "card",
        });
        // Track the raw streamed text so the duplicate-final check in deliver()
        // can skip the redundant text delivery that arrives after onIdle closes
        // the streaming card.
        if (result.visibleReplySent) {
          markVisibleReplySent();
        }
        if (result.visibleReplySent && finalizedAnswerText) {
          deliveredFinalTexts.add(finalizedAnswerText);
          rememberClosedStreamingSettlement(generationToClose, finalizedAnswerText, result);
        }
        return {
          result,
          ...(generationToClose === undefined ? {} : { generation: generationToClose }),
        };
      }
      return {
        result: noVisibleFeishuReplyDelivery,
        ...(generationToClose === undefined ? {} : { generation: generationToClose }),
      };
    } catch (error: unknown) {
      return {
        result: noVisibleFeishuReplyDelivery,
        ...(generationToClose === undefined ? {} : { generation: generationToClose }),
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

  const closeStreaming = (): Promise<StreamingCloseOutcome> => {
    const generation = activeStreamingGeneration;
    if (generation !== undefined && inFlightStreamingClose?.generation === generation) {
      return inFlightStreamingClose.promise;
    }
    const content = streamText;
    const closePromise = performStreamingClose();
    if (generation !== undefined) {
      const closing = { generation, content, promise: closePromise };
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
    try {
      if (streamingStartPromise) {
        await streamingStartPromise;
      }
      await partialUpdateQueue;
      if (streaming?.isActive()) {
        await streaming.discard();
      }
    } finally {
      resetStreamingState();
    }
  };

  const updateStreamingStatusLine = (
    nextStatusLine: string,
    options?: { startIfNeeded?: boolean },
  ) => {
    statusLine = nextStatusLine;
    const hasStreamingSession = Boolean(streaming?.isActive() || streamingStartPromise);
    if (!hasStreamingSession && (options?.startIfNeeded === false || renderMode !== "card")) {
      return;
    }
    startStreaming();
    flushStreamingCardUpdate(buildCombinedStreamText(reasoningText, streamText));
  };

  const sendChunkedTextReply = async (paramsLocal: {
    text: string;
    useCard: boolean;
    infoKind?: string;
    firstChunkMentions?: MentionTarget[];
    chunkMentions?: MentionTarget[];
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
    const chunks = resolveTextChunksWithFallback(
      chunkSource,
      paramsLocal.useCard
        ? initialChunks
        : chunkFeishuPostMarkdown({
            text: chunkSource,
            limit: textChunkLimit,
            mode: chunkMode,
            firstChunkMentions: paramsLocal.firstChunkMentions,
            chunkMentions: paramsLocal.chunkMentions,
            initialChunks,
          }),
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
        throw createFeishuPartialReplyDeliveryError(
          error,
          createFeishuReplyDeliveryResult({
            results,
            visibleReplySent: results.length > 0,
            content: acceptedChunks.join(""),
            kind: paramsLocal.useCard ? "card" : "text",
          }),
        );
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

  const sendMediaReplies = async (
    payload: ReplyPayload,
    options?: { fallbackText?: string },
  ): Promise<FeishuReplyDeliveryResult> => {
    const mediaUrls = resolveSendableOutboundReplyParts(payload).mediaUrls;
    let sentFallbackText = false;
    let degradedVoiceFallbackText: string | undefined;
    const results: FeishuReplyDeliveryResult[] = [];
    const sendFallbackText = async (text: string) =>
      await sendChunkedTextReply({
        text,
        useCard: false,
        infoKind: "final",
        chunkMentions: requiredMentionTargets,
        sendChunk: async ({ chunk, mentions }) =>
          await sendMessageFeishu({
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
            : async ({ mediaUrl }) => {
                const fallbackText = await buildFeishuMediaFallbackText({
                  text: sentFallbackText ? undefined : options.fallbackText,
                  mediaUrl,
                });
                sentFallbackText = true;
                results.push(await sendFallbackText(fallbackText));
              },
      });
      if (degradedVoiceFallbackText && !sentFallbackText) {
        sentFallbackText = true;
        results.push(await sendFallbackText(degradedVoiceFallbackText));
      }
    } catch (error: unknown) {
      const partial = isChannelPartialDeliveryError(error) ? error.deliveryResult : undefined;
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
    if (skippedFinalReason === "silent") {
      params.runtime.log?.(
        `feishu[${account.accountId}]: no-visible-reply fallback skipped for intentional silence (${reason})`,
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
    const cardNote = resolveCardNote(agentId, identity, prefixContext.prefixContext);
    return await sendChunkedTextReply({
      text: content,
      useCard: true,
      infoKind,
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
                  result: finalized,
                  ...(closeOutcome.error === undefined ? {} : { error: closeOutcome.error }),
                }
              : claimClosedStreamingResult(
                  completion.streamingGeneration,
                  completion.result.content,
                );
            const deliveryError = claimedSettlement?.error;
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
            throw toError(closeOutcome.error);
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
    const claimedSettlement = claimClosedStreamingResult(
      paramsLocal.ownerGeneration,
      paramsLocal.content,
    );
    if (claimedSettlement) {
      finalized = claimedSettlement.result;
      finalizationError = claimedSettlement.error;
    } else if (
      paramsLocal.ownerGeneration !== undefined &&
      inFlightStreamingClose?.generation === paramsLocal.ownerGeneration
    ) {
      const closeOutcome = await inFlightStreamingClose.promise;
      const completedSettlement = claimClosedStreamingResult(
        paramsLocal.ownerGeneration,
        paramsLocal.content,
      );
      finalized = completedSettlement?.result ?? closeOutcome?.result ?? finalized;
      finalizationError = completedSettlement?.error ?? closeOutcome?.error;
    } else if (
      paramsLocal.ownerGeneration !== undefined &&
      activeStreamingGeneration === paramsLocal.ownerGeneration
    ) {
      const closeOutcome = await closeStreaming();
      finalized = closeOutcome.result;
      finalizationError = closeOutcome.error;
    }
    try {
      finalized =
        (await ensureVisibleStreamingDelivery(
          finalized,
          paramsLocal.content,
          paramsLocal.infoKind,
        )) ?? finalized;
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
      fallbackPartial?.visibleReplySent === true
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
    responsePrefix: prefixContext.responsePrefix,
    responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
    humanDelay: resolveHumanDelayConfig(cfg, agentId),
    silentReplyContext: {
      cfg,
      sessionKey: params.sessionKey,
      surface: "feishu",
      conversationType: chatId.startsWith("oc_") ? "group" : "direct",
    },
    onSkip: (_payload, info) => {
      if (info.kind === "final") {
        skippedFinalReason = info.reason;
      }
    },
    onReplyStart: async () => {
      if (!replyLifecycleStateInitialized) {
        replyLifecycleStateInitialized = true;
        deliveredFinalTexts.clear();
        closedStreamingSettlements.clear();
        sentIndependentBlockText = false;
        idleRequestedForReply = false;
        visibleReplySent = false;
        skippedFinalReason = null;
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
    deliver: async (payload: ReplyPayload, info) => {
      if (info?.kind === "final") {
        skippedFinalReason = null;
      }
      const payloadText =
        payload.isReasoning && payload.text ? formatReasoningMessage(payload.text) : payload.text;
      const reply = resolveSendableOutboundReplyParts({ ...payload, text: payloadText });
      const text =
        info?.kind === "final"
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
        info?.kind === "final" && hasText && deliveredFinalTexts.has(text);
      const shouldDeliverText = hasText && !hasVoiceMedia && !skipTextForDuplicateFinal;
      const shouldDiscardStreamingPreview =
        info?.kind === "final" &&
        (finalTextExceedsStreamingLimit ||
          (hasMedia &&
            ((hasVoiceMedia && !shouldDeliverText && !ttsTextAlreadyVisible) ||
              skipTextForDuplicateFinal)));

      const priorClosedStreamingSettlement =
        info?.kind === "final" && hasText && skipTextForDuplicateFinal
          ? claimClosedStreamingResult(undefined, text)
          : undefined;
      if (!shouldDeliverText && !hasMedia) {
        if (priorClosedStreamingSettlement?.error !== undefined) {
          throw toError(priorClosedStreamingSettlement.error);
        }
        return priorClosedStreamingSettlement?.result ?? noVisibleFeishuReplyDelivery;
      }

      const deliveredResults: FeishuReplyDeliveryResult[] = priorClosedStreamingSettlement
        ? [priorClosedStreamingSettlement.result]
        : [];
      const collectMediaDelivery = async (
        mediaPayload: ReplyPayload,
        mediaOptions?: { fallbackText?: string },
      ): Promise<void> => {
        try {
          deliveredResults.push(await sendMediaReplies(mediaPayload, mediaOptions));
        } catch (error: unknown) {
          const partial = isChannelPartialDeliveryError(error) ? error.deliveryResult : undefined;
          const accumulated = mergeFeishuReplyDeliveryResults([
            ...deliveredResults,
            ...(partial ? [partial] : []),
          ]);
          throw createFeishuPartialReplyDeliveryError(
            partial && error instanceof Error ? (error.cause ?? error) : error,
            accumulated,
          );
        }
      };

      if (shouldDiscardStreamingPreview) {
        await discardStreamingPreview();
      }

      if (shouldDeliverText) {
        if (info?.kind === "block") {
          // Drop internal block chunks unless we can safely consume them as
          // streaming-card fallback content or send them as independent
          // messages for true progressive delivery.
          if (!useStreamingCard) {
            if (coreBlockStreamingEnabled) {
              // Reuse normal text chunking, but notify mentions only on the first visible chunk.
              const isFirstBlock = !sentIndependentBlockText;
              const firstChunkMentions =
                isFirstBlock && mentionTargets?.length ? mentionTargets : undefined;
              deliveredResults.push(
                await sendChunkedTextReply({
                  text,
                  useCard: false,
                  infoKind: "block",
                  firstChunkMentions,
                  chunkMentions: requiredMentionTargets,
                  sendChunk: async ({ chunk, mentions }) =>
                    await sendMessageFeishu({
                      cfg,
                      to: sendTarget,
                      text: chunk,
                      replyToMessageId: sendReplyToMessageId,
                      replyInThread: effectiveReplyInThread,
                      allowTopLevelReplyFallback,
                      accountId,
                      ...(mentions ? { mentions } : {}),
                    }),
                }),
              );
              sentIndependentBlockText = true;
              if (hasMedia) {
                await collectMediaDelivery(payload);
              }
            }
            return mergeFeishuReplyDeliveryResults(deliveredResults, text);
          }
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
          info?.kind === "final" && inFlightStreamingClose?.content === text
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
              await collectMediaDelivery(payload);
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
          const cardNote = resolveCardNote(agentId, identity, prefixContext.prefixContext);
          deliveredResults.push(
            await sendChunkedTextReply({
              text,
              useCard: true,
              infoKind: info?.kind,
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
          deliveredResults.push(
            await sendChunkedTextReply({
              text,
              useCard: false,
              infoKind: info?.kind,
              firstChunkMentions,
              chunkMentions: requiredMentionTargets,
              sendChunk: async ({ chunk, mentions }) =>
                await sendMessageFeishu({
                  cfg,
                  to: sendTarget,
                  text: chunk,
                  replyToMessageId: sendReplyToMessageId,
                  replyInThread: effectiveReplyInThread,
                  allowTopLevelReplyFallback,
                  accountId,
                  ...(mentions ? { mentions } : {}),
                }),
            }),
          );
        }
      }

      if (hasMedia) {
        await collectMediaDelivery(
          payload,
          hasVoiceMedia && hasText ? { fallbackText: text } : undefined,
        );
      }
      const result = mergeFeishuReplyDeliveryResults(deliveredResults, text);
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
      onModelSelected: prefixContext.onModelSelected,
      disableBlockStreaming:
        typeof blockStreamingEnabled === "boolean" ? !blockStreamingEnabled : true,
      onPartialReply: previewStreamingEnabled
        ? (payload: ReplyPayload) => {
            if (!payload.text) {
              return;
            }
            const cleaned = stripReasoningTagsFromText(payload.text, {
              mode: "strict",
              trim: "both",
            });
            if (!cleaned) {
              return;
            }
            startStreaming();
            queueStreamingUpdate(cleaned, {
              dedupeWithLastPartial: true,
              mode: "snapshot",
            });
          }
        : undefined,
      onReasoningStream: reasoningPreviewEnabled
        ? (payload: ReplyPayload) => {
            if (!payload.text) {
              return;
            }
            startStreaming();
            queueReasoningUpdate(formatReasoningMessage(payload.text));
          }
        : undefined,
      onReasoningEnd: reasoningPreviewEnabled ? () => {} : undefined,
      onToolStart: previewStreamingEnabled
        ? (payload: {
            name?: string;
            phase?: string;
            args?: Record<string, unknown>;
            detailMode?: "explain" | "raw";
          }) => {
            if (!isChannelProgressDraftWorkToolName(payload.name)) {
              return;
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
              updateStreamingStatusLine(statusLineLocal);
            }
          }
        : undefined,
      onAssistantMessageStart: previewStreamingEnabled
        ? () => {
            updateStreamingStatusLine("", { startIfNeeded: false });
          }
        : undefined,
      onCompactionStart: previewStreamingEnabled
        ? () => {
            updateStreamingStatusLine("📦 **Compacting context...**");
          }
        : undefined,
      onCompactionEnd: previewStreamingEnabled
        ? () => {
            updateStreamingStatusLine("");
          }
        : undefined,
    },
    ensureNoVisibleReplyFallback,
    getVisibleReplyState: () => ({
      visibleReplySent,
      skippedFinalReason,
    }),
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
