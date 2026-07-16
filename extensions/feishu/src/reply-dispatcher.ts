// Feishu plugin module implements reply dispatcher behavior.
import { formatReasoningMessage } from "openclaw/plugin-sdk/agent-runtime";
import { logTypingFailure } from "openclaw/plugin-sdk/channel-feedback";
import { createChannelMessageReplyPipeline } from "openclaw/plugin-sdk/channel-outbound";
import {
  formatChannelProgressDraftLineForEntry,
  isChannelProgressDraftWorkToolName,
  resolveChannelPreviewStreamMode,
  resolveChannelStreamingBlockEnabled,
} from "openclaw/plugin-sdk/channel-outbound";
import {
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
import { sendMediaFeishu, shouldSuppressFeishuTextForVoiceMedia } from "./media.js";
import type { MentionTarget } from "./mention-target.types.js";
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
import { FeishuStreamingSession, mergeStreamingText } from "./streaming-card.js";
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

function formatMediaFallbackText(text: string | undefined, mediaUrl: string): string {
  const trimmedText = text?.trim() ?? "";
  const attachmentText = `📎 ${mediaUrl}`;
  return trimmedText ? `${trimmedText}\n\n${attachmentText}` : attachmentText;
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
  // Streaming cards default to enabled: only streaming.mode "off" (or raw
  // render mode) disables them, matching the legacy `streaming: false` boolean.
  const streamingEnabled =
    resolveChannelPreviewStreamMode(account.config, "partial") !== "off" && renderMode !== "raw";
  const blockStreamingEnabled = resolveChannelStreamingBlockEnabled(account.config);
  const coreBlockStreamingEnabled = blockStreamingEnabled === true;
  const reasoningPreviewEnabled = streamingEnabled && params.allowReasoningPreview === true;

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
  let sentIndependentBlockText = false;
  let partialUpdateQueue: Promise<void> = Promise.resolve();
  let streamingStartPromise: Promise<void> | null = null;
  let streamingClosedForReply = false;
  let streamingCloseErroredForReply = false;
  let visibleReplySent = false;
  let skippedFinalReason: string | null = null;
  let idleSideEffectsPromise: Promise<void> = Promise.resolve();
  let replyLifecycleStateInitialized = false;
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
    partialUpdateQueue = partialUpdateQueue.then(async () => {
      if (streamingStartPromise) {
        await streamingStartPromise;
      }
      if (streaming?.isActive()) {
        await streaming.update(combined);
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

      streaming = new FeishuStreamingSession(createFeishuClient(account), creds, (message) =>
        params.runtime.log?.(`feishu[${account.accountId}] ${message}`),
      );
      try {
        const cardHeader = resolveCardHeader(agentId, identity);
        const cardNote = resolveCardNote(agentId, identity, prefixContext.prefixContext);
        const streamingTarget = sendTarget
          .replace(/^(feishu|lark):/i, "")
          .replace(/^(chat|user|group|dm|open_id):/i, "")
          .trim();
        await streaming.start(streamingTarget, resolveReceiveIdType(sendTarget), {
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
        streaming = null;
        streamingStartPromise = null;
      }
    })();
  };

  const resetStreamingState = () => {
    streaming = null;
    streamingStartPromise = null;
    partialUpdateQueue = Promise.resolve();
    streamText = "";
    lastPartial = "";
    reasoningText = "";
    statusLine = "";
    snapshotBaseText = "";
    lastSnapshotTextLength = 0;
    hasStreamingFinalText = false;
  };

  const closeStreaming = async (options?: { markClosedForReply?: boolean }) => {
    try {
      if (streamingStartPromise) {
        await streamingStartPromise;
      }
      await partialUpdateQueue;
      if (streaming?.isActive()) {
        statusLine = "";
        const text = buildCombinedStreamText(reasoningText, streamText);
        const finalNote = resolveCardNote(agentId, identity, prefixContext.prefixContext);
        const contentVisible = await streaming.close(text, { note: finalNote });
        // Track the raw streamed text so the duplicate-final check in deliver()
        // can skip the redundant text delivery that arrives after onIdle closes
        // the streaming card.
        if (contentVisible) {
          markVisibleReplySent();
        }
        if (contentVisible && streamText) {
          deliveredFinalTexts.add(streamText);
          if (options?.markClosedForReply !== false && !streamingCloseErroredForReply) {
            streamingClosedForReply = true;
          }
        }
      }
    } finally {
      resetStreamingState();
    }
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
    sendChunk: (params: { chunk: string; isFirst: boolean }) => Promise<void>;
  }) => {
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
            initialChunks,
          }),
    );
    for (const [index, chunk] of chunks.entries()) {
      await paramsLocal.sendChunk({
        chunk,
        isFirst: index === 0,
      });
      markVisibleReplySent();
    }
    if (paramsLocal.infoKind === "final") {
      deliveredFinalTexts.add(paramsLocal.text);
    }
  };

  const sendMediaReplies = async (payload: ReplyPayload, options?: { fallbackText?: string }) => {
    const mediaUrls = resolveSendableOutboundReplyParts(payload).mediaUrls;
    let sentFallbackText = false;
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
          accountId,
          ...(payload.audioAsVoice === true ? { audioAsVoice: true } : {}),
        });
        markVisibleReplySent();
        if (result?.voiceIntentDegradedToFile && options?.fallbackText && !sentFallbackText) {
          sentFallbackText = true;
          await sendChunkedTextReply({
            text: options.fallbackText,
            useCard: false,
            infoKind: "final",
            sendChunk: async ({ chunk }) => {
              await sendMessageFeishu({
                cfg,
                to: sendTarget,
                text: chunk,
                replyToMessageId: sendReplyToMessageId,
                replyInThread: effectiveReplyInThread,
                allowTopLevelReplyFallback,
                accountId,
              });
            },
          });
        }
      },
      onError:
        options?.fallbackText === undefined
          ? undefined
          : async ({ mediaUrl }) => {
              const fallbackText = formatMediaFallbackText(
                sentFallbackText ? undefined : options.fallbackText,
                mediaUrl,
              );
              sentFallbackText = true;
              await sendChunkedTextReply({
                text: fallbackText,
                useCard: false,
                infoKind: "final",
                sendChunk: async ({ chunk }) => {
                  await sendMessageFeishu({
                    cfg,
                    to: sendTarget,
                    text: chunk,
                    replyToMessageId: sendReplyToMessageId,
                    replyInThread: effectiveReplyInThread,
                    allowTopLevelReplyFallback,
                    accountId,
                  });
                },
              });
            },
    });
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
    });
    markVisibleReplySent();
    params.runtime.error?.(
      `feishu[${account.accountId}]: sent no-visible-reply fallback (${reason})`,
    );
    return true;
  };

  const queueIdleSideEffects = (options?: { markClosedForReply?: boolean }): Promise<void> => {
    const nextIdleSideEffects = idleSideEffectsPromise.then(async () => {
      await closeStreaming(options);
      typingCallbacks?.onIdle?.();
    });
    idleSideEffectsPromise = nextIdleSideEffects.catch(() => {});
    return nextIdleSideEffects;
  };

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
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
          sentIndependentBlockText = false;
          streamingClosedForReply = false;
          streamingCloseErroredForReply = false;
          visibleReplySent = false;
          skippedFinalReason = null;
        }
        if (streamingEnabled && renderMode === "card") {
          startStreaming();
        }
        await Promise.resolve(typingCallbacks?.onReplyStart?.());
      },
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
        const hasVoiceMedia =
          hasMedia &&
          reply.mediaUrls.some((mediaUrl) =>
            shouldSuppressFeishuTextForVoiceMedia({
              mediaUrl,
              ...(payload.audioAsVoice === true ? { audioAsVoice: true } : {}),
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
        const finalTextWouldUseStreamingCard =
          info?.kind === "final" && hasText && streamingEnabled;
        const useCard = useStaticCard || useStreamingCard;
        const skipTextForDuplicateFinal =
          info?.kind === "final" && hasText && deliveredFinalTexts.has(text);
        const skipTextForClosedStreamingFinal =
          info?.kind === "final" &&
          hasText &&
          streamingClosedForReply &&
          !streamingCloseErroredForReply &&
          finalTextWouldUseStreamingCard;
        const shouldDeliverText =
          hasText &&
          !hasVoiceMedia &&
          !skipTextForDuplicateFinal &&
          !skipTextForClosedStreamingFinal;
        const shouldDiscardStreamingPreview =
          info?.kind === "final" &&
          (finalTextExceedsStreamingLimit ||
            (hasMedia && ((hasVoiceMedia && !shouldDeliverText) || skipTextForDuplicateFinal)));

        if (!shouldDeliverText && !hasMedia) {
          return;
        }

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
                await sendChunkedTextReply({
                  text,
                  useCard: false,
                  infoKind: "block",
                  firstChunkMentions,
                  sendChunk: async ({ chunk, isFirst }) => {
                    await sendMessageFeishu({
                      cfg,
                      to: sendTarget,
                      text: chunk,
                      replyToMessageId: sendReplyToMessageId,
                      replyInThread: effectiveReplyInThread,
                      allowTopLevelReplyFallback,
                      accountId,
                      ...(isFirst && firstChunkMentions ? { mentions: firstChunkMentions } : {}),
                    });
                  },
                });
                sentIndependentBlockText = true;
                if (hasMedia) {
                  await sendMediaReplies(payload);
                }
              }
              return;
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
          if (streaming?.isActive() && shouldStreamText) {
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
            // Send media even when streaming handled the text
            if (hasMedia) {
              await sendMediaReplies(payload);
            }
            return;
          }

          if (useCard) {
            const cardHeader = resolveCardHeader(agentId, identity);
            const cardNote = resolveCardNote(agentId, identity, prefixContext.prefixContext);
            await sendChunkedTextReply({
              text,
              useCard: true,
              infoKind: info?.kind,
              sendChunk: async ({ chunk }) => {
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
                });
              },
            });
          } else {
            const firstChunkMentions =
              info?.kind === "final" && mentionTargets?.length ? mentionTargets : undefined;
            await sendChunkedTextReply({
              text,
              useCard: false,
              infoKind: info?.kind,
              firstChunkMentions,
              sendChunk: async ({ chunk, isFirst }) => {
                await sendMessageFeishu({
                  cfg,
                  to: sendTarget,
                  text: chunk,
                  replyToMessageId: sendReplyToMessageId,
                  replyInThread: effectiveReplyInThread,
                  allowTopLevelReplyFallback,
                  accountId,
                  ...(isFirst && firstChunkMentions ? { mentions: firstChunkMentions } : {}),
                });
              },
            });
          }
        }

        if (hasMedia) {
          await sendMediaReplies(
            payload,
            hasVoiceMedia && hasText ? { fallbackText: text } : undefined,
          );
        }
      },
      onError: async (error, info) => {
        streamingCloseErroredForReply = true;
        streamingClosedForReply = false;
        params.runtime.error?.(
          `feishu[${account.accountId}] ${info.kind} reply failed: ${String(error)}`,
        );
        await queueIdleSideEffects({ markClosedForReply: false });
      },
      onIdle: () => queueIdleSideEffects(),
      onCleanup: () => {
        typingCallbacks?.onCleanup?.();
      },
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected: prefixContext.onModelSelected,
      disableBlockStreaming:
        typeof blockStreamingEnabled === "boolean" ? !blockStreamingEnabled : true,
      onPartialReply: streamingEnabled
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
      onToolStart: streamingEnabled
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
      onAssistantMessageStart: streamingEnabled
        ? () => {
            updateStreamingStatusLine("", { startIfNeeded: false });
          }
        : undefined,
      onCompactionStart: streamingEnabled
        ? () => {
            updateStreamingStatusLine("📦 **Compacting context...**");
          }
        : undefined,
      onCompactionEnd: streamingEnabled
        ? () => {
            updateStreamingStatusLine("");
          }
        : undefined,
    },
    markDispatchIdle,
    ensureNoVisibleReplyFallback,
    getVisibleReplyState: () => ({
      visibleReplySent,
      skippedFinalReason,
    }),
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
