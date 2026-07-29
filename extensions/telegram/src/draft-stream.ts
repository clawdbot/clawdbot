// Telegram plugin module implements draft stream behavior.
import type { Bot } from "grammy";
import type { Message } from "grammy/types";
import {
  createFinalizableDraftStreamControlsForState,
  takeMessageIdAfterStop,
} from "openclaw/plugin-sdk/channel-outbound";
import type { MarkdownTableMode, ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isSingleUseReplyToMode } from "openclaw/plugin-sdk/reply-reference";
import { buildTelegramThreadParams, type TelegramThreadSpec } from "./bot/helpers.js";
import {
  escapeTelegramHtml,
  markdownToTelegramChunks,
  splitTelegramHtmlChunks,
  telegramHtmlToPlainTextFallback,
} from "./format.js";
import {
  isRecoverableTelegramNetworkError,
  isSafeToRetrySendError,
  isTelegramClientRejection,
  isTelegramMessageNotModifiedError,
  isTelegramRateLimitError,
  readTelegramRetryAfterMs,
} from "./network-errors.js";
import { TELEGRAM_TEXT_CHUNK_LIMIT } from "./outbound-adapter.js";
import { normalizeTelegramReplyToMessageId } from "./outbound-params.js";
import {
  inputRichBlocksToPlainText,
  type TelegramRichBlocksDegradationReason,
} from "./rich-block-model.js";
import { splitTelegramRichBlocks } from "./rich-block-split.js";
import {
  buildTelegramRichBlocksPlan,
  buildTelegramRichMarkdownPlan,
  getTelegramRichRawApi,
  TELEGRAM_RICH_TEXT_LIMIT,
  type TelegramInputRichMessage,
} from "./rich-message.js";
import {
  buildTelegramPlainFallbackPlan,
  isTelegramHtmlParseError,
  splitTelegramPlainTextChunks,
  warnTelegramRichBlocksDegradations,
} from "./rich-plain-fallback.js";

const DEFAULT_THROTTLE_MS = 1000;
// Retryable preview failures keep the latest text pending for the next throttle
// tick; cap consecutive misses so a persistent outage stops the preview instead
// of warn-spamming for the rest of the run.
const MAX_CONSECUTIVE_PREVIEW_FAILURES = 3;
// Flood waits beyond this freeze the preview longer than it is useful; clamp so
// a large retry_after cannot park the suspension past the run's lifetime.
const MAX_PREVIEW_FLOOD_SUSPEND_MS = 60_000;
// Minimum time the streaming preview ("gerund" box) stays on screen before it
// is deleted at teardown, measured from when it first became visible. On fast
// turns the box otherwise flashed and vanished before it could be read, and the
// immediate delete could race a just-persisted message (intermittently dropping
// the first verbose commentary). The delete is scheduled DETACHED so the turn is
// never stalled waiting on the dwell.
const MIN_PREVIEW_DWELL_MS = 4_000;

export type TelegramDraftStream = {
  update: (text: string) => void;
  updatePreview: (preview: TelegramDraftPreview) => void;
  flush: () => Promise<void>;
  messageId: () => number | undefined;
  lastDeliveredText?: () => string;
  currentMessageSnapshot?: () => TelegramDraftMessageSnapshot | undefined;
  clear: () => Promise<void>;
  stop: () => Promise<void>;
  /** Stop without a final flush or delete. */
  discard?: () => Promise<void>;
  /** Prepared final content not yet accepted after retained pagination pages. */
  remainingFinalContent?: () => TelegramDraftMessageSnapshot | undefined;
  /** True while a pending or visible draft owns a first/batched reply target. */
  hasConsumedReplyTarget?: () => boolean;
  /**
   * Collapse the preview in place: edit the existing window message so its
   * content becomes `preview`, then stop without deleting. Used at end-of-turn
   * so the streaming window becomes the summary bar (no delete + repost, which
   * scroll-jumps the client). Returns the message id if the edit landed.
   */
  finalizeToPreview: (preview: TelegramDraftPreview) => Promise<number | undefined>;
  /** Reset internal state so the next update creates a new message instead of editing. */
  forceNewMessage: () => void;
  /**
   * Reposition the window: rewind so the next update creates a new message,
   * and schedule the superseded message's delete for AFTER the new one lands
   * (post-new-then-delete-old, never delete-then-repost — avoids the client
   * scroll-jump). Returns the superseded message id, if any.
   */
  rotateToNewMessageDeferringDelete: () => number | undefined;
  /** True when a preview sendMessage was attempted but the response was lost. */
  sendMayHaveLanded?: () => boolean;
};

type TelegramDraftMessageSnapshot = {
  text: string;
  sourceText: string;
  sourceTextMode?: "html" | "markdown";
};

export type TelegramDraftPreview = {
  text: string;
  parseMode?: "HTML";
  richMessage?: TelegramInputRichMessage;
  markdownSource?: {
    text: string;
    tableMode?: MarkdownTableMode;
  };
};

type PlannedTelegramDraftPage = TelegramDraftMessageSnapshot & {
  sourceTextMode: "html" | "markdown";
  fullSourceText?: string;
  richMessage?: TelegramInputRichMessage;
  degradationReasons?: readonly TelegramRichBlocksDegradationReason[];
};

type RetainedTelegramDraftPage = {
  messageId: number;
  textSnapshot: string;
  visibleSinceMs?: number;
};

type SingleUseReplyTargetState =
  | { kind: "available" }
  | { kind: "pending"; generation: number }
  | { kind: "retained"; generation: number; messageId: number };

function telegramRichHtmlToParseModeHtml(html: string): string {
  return html.replace(/<br\s*\/?>/giu, "\n");
}

function planTelegramDraftPages(
  preview: TelegramDraftPreview,
  maxChars: number,
  richMessages: boolean,
): PlannedTelegramDraftPage[] {
  if (richMessages) {
    const previewRich = preview.richMessage;
    if (previewRich) {
      const skipEntityDetection = previewRich.skip_entity_detection === true;
      return splitTelegramRichBlocks(previewRich.blocks, {
        textLimit: maxChars,
      }).map((blocks) => {
        const plainText = inputRichBlocksToPlainText(blocks);
        return {
          text: plainText,
          sourceText: plainText,
          sourceTextMode: "markdown" as const,
          richMessage: {
            blocks,
            ...(skipEntityDetection ? { skip_entity_detection: true } : {}),
          },
        };
      });
    }
    const plan = buildTelegramRichMarkdownPlan(preview.text);
    // Every page carries the plan's document-level skip flag: the render already
    // committed to that linkify decision, so per-page re-derivation would leave
    // unprotected file refs in pages without the skip trigger.
    const planSkip = plan.richMessage.skip_entity_detection === true;
    const pages = splitTelegramRichBlocks(plan.richMessage.blocks, {
      textLimit: maxChars,
    }).map((blocks, index) => {
      const page = buildTelegramRichBlocksPlan(blocks, { skipEntityDetection: planSkip });
      const planned: PlannedTelegramDraftPage = {
        text: page.plainText,
        sourceText: page.plainText,
        sourceTextMode: "markdown",
        richMessage: page.richMessage,
      };
      if (index === 0 && plan.degradationReasons.length > 0) {
        planned.degradationReasons = plan.degradationReasons;
      }
      return planned;
    });
    if (pages.length === 0 && preview.text.trim()) {
      // Mirror the durable funnel: markdown that projects to zero blocks
      // (link definitions only) still previews as readable source text.
      return [
        {
          text: preview.text,
          sourceText: preview.text,
          sourceTextMode: "markdown",
          richMessage: { blocks: [{ type: "paragraph", text: preview.text }] },
        },
      ];
    }
    return pages;
  }
  if (preview.markdownSource) {
    // Keep streaming-final pagination on the durable send funnel's chunker;
    // splitting pre-rendered HTML loses Markdown word and block boundaries.
    return markdownToTelegramChunks(preview.markdownSource.text, maxChars, {
      tableMode: preview.markdownSource.tableMode,
    }).map((chunk) => ({
      text: chunk.text,
      sourceText: chunk.html,
      sourceTextMode: "html",
    }));
  }
  // Non-rich path: progress drafts may still pass parseMode HTML text.
  // Blocks-only richMessage is ignored here — richMessages must be enabled.
  const htmlText =
    preview.parseMode === "HTML" ? telegramRichHtmlToParseModeHtml(preview.text) : undefined;
  if (htmlText === undefined) {
    return splitTelegramPlainTextChunks(preview.text, maxChars)
      .map((chunk, index) => (index === 0 ? chunk.trimEnd() : chunk.trim()))
      .filter(Boolean)
      .map((sourceText) => ({
        text: sourceText,
        sourceText,
        sourceTextMode: "markdown",
      }));
  }
  const plainText = telegramHtmlToPlainTextFallback(preview.text);
  const htmlPages = splitTelegramHtmlChunks(htmlText, maxChars);
  return htmlPages.map((sourceText) => ({
    text: htmlPages.length === 1 ? plainText : telegramHtmlToPlainTextFallback(sourceText),
    sourceText,
    sourceTextMode: "html",
    fullSourceText: htmlText,
  }));
}

export function createTelegramDraftStream(params: {
  api: Bot["api"];
  chatId: Parameters<Bot["api"]["sendMessage"]>[0];
  maxChars?: number;
  thread?: TelegramThreadSpec | null;
  replyToMessageId?: number;
  replyToMode?: ReplyToMode;
  richMessages?: boolean;
  throttleMs?: number;
  /** Minimum chars before sending first message (debounce for push notifications) */
  minInitialChars?: number;
  /** Optional preview renderer (e.g. markdown -> HTML + parse mode). */
  renderText?: (text: string) => TelegramDraftPreview;
  /** Called when a completed page remains visible after the stream advances. */
  onRetainedPage?: (page: RetainedTelegramDraftPage) => void;
  /** Called with Telegram's response after a new preview message becomes durable. */
  onProviderMessage?: (message: Message) => Promise<void> | void;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}): TelegramDraftStream {
  const richMessages = params.richMessages === true;
  const transportLimit = richMessages ? TELEGRAM_RICH_TEXT_LIMIT : TELEGRAM_TEXT_CHUNK_LIMIT;
  const maxChars = Math.min(params.maxChars ?? transportLimit, transportLimit);
  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const minInitialChars = params.minInitialChars;
  const chatId = params.chatId;
  const threadParams = buildTelegramThreadParams(params.thread);
  const replyToMessageId = normalizeTelegramReplyToMessageId(params.replyToMessageId);
  const initialSendMessageParams =
    replyToMessageId != null
      ? {
          ...threadParams,
          reply_parameters: {
            message_id: replyToMessageId,
            allow_sending_without_reply: true,
          },
        }
      : (threadParams ?? {});
  const consumesReplyTarget =
    replyToMessageId != null &&
    params.replyToMode !== undefined &&
    isSingleUseReplyToMode(params.replyToMode);
  // A single-use reply belongs to the concrete message that remains visible.
  // Repositioning keeps pending/retained ownership until Telegram confirms the
  // superseded message was deleted; otherwise two visible messages can reply.
  let replyTargetState: SingleUseReplyTargetState = { kind: "available" };
  const reserveReplyTargetForSend = (sendGeneration: number) => {
    if (!consumesReplyTarget) {
      return initialSendMessageParams;
    }
    if (replyTargetState.kind !== "available") {
      return threadParams ?? {};
    }
    replyTargetState = { kind: "pending", generation: sendGeneration };
    return initialSendMessageParams;
  };
  const releasePendingReplyTarget = (sendGeneration: number) => {
    if (replyTargetState.kind === "pending" && replyTargetState.generation === sendGeneration) {
      replyTargetState = { kind: "available" };
    }
  };
  const retainReplyTarget = (sendGeneration: number, messageId: number) => {
    if (replyTargetState.kind === "pending" && replyTargetState.generation === sendGeneration) {
      replyTargetState = { kind: "retained", generation: sendGeneration, messageId };
    }
  };
  const streamState = { stopped: false, final: false };
  let messageSendAttempted = false;
  let suspendedUntilMs = 0;
  let consecutivePreviewFailures = 0;
  let streamMessageId: number | undefined;
  let streamMessageSnapshot: TelegramDraftMessageSnapshot | undefined;
  let streamProviderMessage: Message | undefined;
  const pendingProviderObservations = new Set<Promise<void>>();
  let streamVisibleSinceMs: number | undefined;
  let lastSentPreviewKey = "";
  let lastDeliveredText = "";
  let lastRequestedText = "";
  let lastRequestedPreview: TelegramDraftPreview | undefined;
  let generation = 0;
  let finalPagePlan: { pages: PlannedTelegramDraftPage[]; nextPageIndex: number } | undefined;
  // Generations whose in-flight FIRST send was superseded by a reposition
  // (rotateToNewMessageDeferringDelete). Their late-landing message is a stale
  // ephemeral preview to delete, NOT a durable content chunk to retain — that
  // distinguishes a reposition from forceNewMessage's continuation-chunk race.
  const repositionedSendGenerations = new Set<number>();
  const fallbackSnapshot = (plainText: string): TelegramDraftMessageSnapshot => ({
    text: plainText,
    sourceText: escapeTelegramHtml(plainText),
    sourceTextMode: "html",
  });
  const scheduleProviderMessageObservation = (message: Message | undefined) => {
    if (!message) {
      return;
    }
    const observation = (async () => {
      try {
        await params.onProviderMessage?.(message);
      } catch (err) {
        // Observation follows an accepted Telegram send. Never turn a cache
        // failure into a transport retry that could duplicate the message.
        try {
          params.warn?.(`telegram stream preview observation failed: ${formatErrorMessage(err)}`);
        } catch {
          // Diagnostics must not make the observation task reject.
        }
      }
    })();
    pendingProviderObservations.add(observation);
    void observation.then(() => {
      pendingProviderObservations.delete(observation);
    });
  };
  const observeCurrentProviderMessage = () => {
    const message = streamProviderMessage;
    streamProviderMessage = undefined;
    scheduleProviderMessageObservation(message);
  };
  const drainProviderMessageObservations = async () => {
    await Promise.all(pendingProviderObservations);
  };
  const sendPlannedMessage = async (
    page: PlannedTelegramDraftPage,
    sendMessageParams: ReturnType<typeof reserveReplyTargetForSend>,
  ) => {
    if (page.richMessage) {
      warnTelegramRichBlocksDegradations({
        context: "stream preview",
        reasons: page.degradationReasons ?? [],
        warn: (message) => params.warn?.(message),
      });
      try {
        return {
          message: await getTelegramRichRawApi(params.api).sendRichMessage({
            chat_id: chatId,
            rich_message: page.richMessage,
            ...sendMessageParams,
          }),
          snapshot: page,
        };
      } catch (err) {
        const fallbackPlan = buildTelegramPlainFallbackPlan({
          plainText: page.text,
          err,
          context: "stream preview",
          warn: (message) => params.warn?.(message),
        });
        if (!fallbackPlan) {
          throw err;
        }
        return {
          message: await params.api.sendMessage(chatId, fallbackPlan.plainText, sendMessageParams),
          snapshot: fallbackSnapshot(fallbackPlan.plainText),
        };
      }
    }
    if (page.sourceTextMode !== "html") {
      return {
        message: await params.api.sendMessage(chatId, page.text, sendMessageParams),
        snapshot: page,
      };
    }
    try {
      return {
        message: await params.api.sendMessage(chatId, page.sourceText, {
          parse_mode: "HTML" as const,
          ...sendMessageParams,
        }),
        snapshot: page,
      };
    } catch (err) {
      if (!isTelegramHtmlParseError(err)) {
        throw err;
      }
      return {
        message: await params.api.sendMessage(chatId, page.text, sendMessageParams),
        snapshot: fallbackSnapshot(page.text),
      };
    }
  };
  const sendMessageTransportPreview = async (
    page: PlannedTelegramDraftPage,
    sendGeneration: number,
  ): Promise<boolean> => {
    const targetMessageId = streamMessageId;
    if (typeof targetMessageId === "number") {
      streamVisibleSinceMs ??= Date.now();
      let acceptedSnapshot: TelegramDraftMessageSnapshot = page;
      if (page.richMessage) {
        warnTelegramRichBlocksDegradations({
          context: "stream preview edit",
          reasons: page.degradationReasons ?? [],
          warn: (message) => params.warn?.(message),
        });
        try {
          await getTelegramRichRawApi(params.api).editMessageText({
            chat_id: chatId,
            message_id: targetMessageId,
            rich_message: page.richMessage,
          });
        } catch (err) {
          const fallbackPlan = buildTelegramPlainFallbackPlan({
            plainText: page.text,
            err,
            context: "stream preview edit",
            warn: (message) => params.warn?.(message),
          });
          if (!fallbackPlan) {
            throw err;
          }
          await params.api.editMessageText(chatId, targetMessageId, fallbackPlan.plainText);
          acceptedSnapshot = fallbackSnapshot(fallbackPlan.plainText);
        }
      } else if (page.sourceTextMode === "html") {
        try {
          await params.api.editMessageText(chatId, targetMessageId, page.sourceText, {
            parse_mode: "HTML" as const,
          });
        } catch (err) {
          if (!isTelegramHtmlParseError(err)) {
            throw err;
          }
          await params.api.editMessageText(chatId, targetMessageId, page.text);
          acceptedSnapshot = fallbackSnapshot(page.text);
        }
      } else {
        await params.api.editMessageText(chatId, targetMessageId, page.sourceText);
      }
      if (sendGeneration === generation && streamMessageId === targetMessageId) {
        streamMessageSnapshot = acceptedSnapshot;
      }
      return true;
    }
    messageSendAttempted = true;
    const sendMessageParams = reserveReplyTargetForSend(sendGeneration);
    let sent: Awaited<ReturnType<typeof sendPlannedMessage>>;
    try {
      sent = await sendPlannedMessage(page, sendMessageParams);
    } catch (err) {
      const definitelyRejected = isSafeToRetrySendError(err) || isTelegramClientRejection(err);
      if (sendGeneration === generation && definitelyRejected) {
        messageSendAttempted = false;
      }
      if (definitelyRejected) {
        releasePendingReplyTarget(sendGeneration);
      }
      throw err;
    }
    const sentMessageId = sent.message?.message_id;
    const normalizedMessageId =
      typeof sentMessageId === "number" && Number.isFinite(sentMessageId)
        ? Math.trunc(sentMessageId)
        : undefined;
    if (normalizedMessageId === undefined) {
      if (sendGeneration === generation) {
        streamState.stopped = true;
        params.warn?.("telegram stream preview stopped (missing message id from sendMessage)");
        return false;
      }
      return true;
    }
    retainReplyTarget(sendGeneration, normalizedMessageId);
    if (sendGeneration !== generation) {
      const visibleSinceMs = Date.now();
      if (repositionedSendGenerations.delete(sendGeneration)) {
        // Repositioned late sends are stale previews; delete instead of retaining
        // them as durable continuation pages.
        scheduleDetachedDelete(normalizedMessageId, visibleSinceMs, REPOSITION_DELETE_DELAY_MS);
        return true;
      }
      params.onRetainedPage?.({
        messageId: normalizedMessageId,
        textSnapshot: sent.snapshot.text,
        visibleSinceMs,
      });
      scheduleProviderMessageObservation(sent.message);
      return true;
    }
    const visibleSinceMs = Date.now();
    streamMessageId = normalizedMessageId;
    streamMessageSnapshot = sent.snapshot;
    streamProviderMessage = sent.message;
    streamVisibleSinceMs = visibleSinceMs;
    return true;
  };
  const sendOrEditPlannedPage = async (page: PlannedTelegramDraftPage): Promise<boolean> => {
    const renderedPreviewKey = JSON.stringify([
      page.sourceTextMode,
      page.sourceText,
      page.richMessage?.skip_entity_detection === true,
    ]);
    if (renderedPreviewKey === lastSentPreviewKey) {
      return true;
    }
    const sendGeneration = generation;

    if (typeof streamMessageId !== "number" && minInitialChars != null && !streamState.final) {
      if (page.text.length < minInitialChars) {
        return false;
      }
    }

    const previousSentPreviewKey = lastSentPreviewKey;
    lastSentPreviewKey = renderedPreviewKey;
    try {
      const sent = await sendMessageTransportPreview(page, sendGeneration);
      if (sendGeneration !== generation) {
        return true;
      }
      if (sent) {
        consecutivePreviewFailures = 0;
        suspendedUntilMs = 0;
      }
      return sent;
    } catch (err) {
      if (sendGeneration !== generation) {
        return true;
      }
      const isEdit = typeof streamMessageId === "number";
      if (isEdit && isTelegramMessageNotModifiedError(err)) {
        // Telegram already shows exactly this text; count the edit as delivered.
        consecutivePreviewFailures = 0;
        streamMessageSnapshot = page;
        return true;
      }
      // Roll back the dedupe snapshot so the retried tick is not skipped as a no-op.
      lastSentPreviewKey = previousSentPreviewKey;
      // Flood control is always retryable: Telegram rejected the call outright.
      // Beyond that, edits retry on any transient network error (re-editing the
      // same content is idempotent) while an unsent first preview retries only
      // on provably pre-connect failures — anything ambiguous could duplicate
      // the preview message.
      const retryable =
        isTelegramRateLimitError(err) ||
        (isEdit ? isRecoverableTelegramNetworkError(err) : isSafeToRetrySendError(err));
      consecutivePreviewFailures += 1;
      if (retryable && consecutivePreviewFailures <= MAX_CONSECUTIVE_PREVIEW_FAILURES) {
        const retryAfterMs = readTelegramRetryAfterMs(err);
        if (retryAfterMs !== undefined) {
          suspendedUntilMs = Date.now() + Math.min(retryAfterMs, MAX_PREVIEW_FLOOD_SUSPEND_MS);
        }
        params.warn?.(
          `telegram stream preview ${isEdit ? "edit" : "send"} failed (retrying): ${formatErrorMessage(err)}`,
        );
        return false;
      }
      streamState.stopped = true;
      params.warn?.(`telegram stream preview failed: ${formatErrorMessage(err)}`);
      return false;
    }
  };

  const retainCurrentPage = () => {
    if (typeof streamMessageId !== "number" || !streamMessageSnapshot?.text) {
      return;
    }
    params.onRetainedPage?.({
      messageId: streamMessageId,
      textSnapshot: streamMessageSnapshot.text,
      visibleSinceMs: streamVisibleSinceMs,
    });
    observeCurrentProviderMessage();
  };

  const resolveExactRemainingPage = (plan: {
    pages: PlannedTelegramDraftPage[];
    nextPageIndex: number;
  }): PlannedTelegramDraftPage | undefined => {
    if (plan.nextPageIndex <= 0 || plan.nextPageIndex >= plan.pages.length) {
      return undefined;
    }
    const acceptedSourceText = plan.pages
      .slice(0, plan.nextPageIndex)
      .map((page) => page.sourceText)
      .join("");
    const fullSourceText = plan.pages[0]?.fullSourceText;
    if (!fullSourceText?.startsWith(acceptedSourceText)) {
      return undefined;
    }
    const sourceText = fullSourceText.slice(acceptedSourceText.length);
    const text = telegramHtmlToPlainTextFallback(sourceText);
    // Telegram applies the message limit after parsing entities. Retry the
    // intact rendered suffix when it still fits as one visible message.
    return text.length <= maxChars
      ? { text, sourceText, sourceTextMode: "html", fullSourceText }
      : undefined;
  };

  const sendOrEditStreamMessage = async (text: string): Promise<boolean> => {
    if (streamState.stopped && !streamState.final) {
      return false;
    }
    // Flood-control suspension: returning false keeps the newest text pending,
    // so the first tick after retry_after delivers it. Final flushes still try
    // so the last text has a chance to land.
    if (!streamState.final && Date.now() < suspendedUntilMs) {
      return false;
    }
    const trimmed = text.trimEnd();
    if (!trimmed) {
      return false;
    }
    const fullPreview =
      lastRequestedPreview?.text === trimmed
        ? lastRequestedPreview
        : (params.renderText?.(trimmed) ?? { text: trimmed });
    // Render once, then split the transport HTML so page boundaries preserve
    // open fences, indentation, and nested tags.
    const pages =
      streamState.final && finalPagePlan
        ? finalPagePlan.pages
        : planTelegramDraftPages(fullPreview, maxChars, richMessages);
    const firstPage = pages[0];
    if (!firstPage) {
      return false;
    }
    if (!streamState.final) {
      finalPagePlan = undefined;
      const sent = await sendOrEditPlannedPage(firstPage);
      if (sent) {
        lastDeliveredText = pages.length === 1 ? trimmed : firstPage.text.trimEnd();
      }
      return sent;
    }

    const activePlan = (finalPagePlan ??= { pages, nextPageIndex: 0 });
    for (let index = activePlan.nextPageIndex; index < pages.length; index += 1) {
      const exactRemainingPage = resolveExactRemainingPage(activePlan);
      const page = exactRemainingPage ?? pages[index]!;
      if (index > 0 && typeof streamMessageId === "number") {
        retainCurrentPage();
        resetStreamToNewMessage(true);
      }
      if (!(await sendOrEditPlannedPage(page))) {
        return false;
      }
      if (finalPagePlan !== activePlan) {
        return true;
      }
      activePlan.nextPageIndex = exactRemainingPage ? pages.length : index + 1;
      if (exactRemainingPage) {
        break;
      }
    }
    finalPagePlan = undefined;
    lastDeliveredText = trimmed;
    return true;
  };

  const {
    loop,
    update: updateDraft,
    stopForClear,
  } = createFinalizableDraftStreamControlsForState({
    throttleMs,
    state: streamState,
    sendOrEditStreamMessage,
  });

  const requestDraftUpdate = (text: string, preview?: TelegramDraftPreview) => {
    if (streamState.stopped || streamState.final) {
      return;
    }
    lastRequestedPreview = preview;
    lastRequestedText = text;
    updateDraft(text);
  };

  const updatePreview = (preview: TelegramDraftPreview) => {
    const text = preview.text.trimEnd();
    if (!text) {
      return;
    }
    requestDraftUpdate(text, { ...preview, text });
  };

  const stop = async () => {
    const stopGeneration = generation;
    const waitForRetryAfter = async () => {
      const delayMs = Math.max(0, suspendedUntilMs - Date.now());
      if (delayMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs);
        });
      }
    };
    streamState.final = true;
    // Cancel only the throttle timer, preserving its pending text. An in-flight
    // 429 may establish the retry window that gates the initial final flush.
    loop.resetThrottleWindow();
    await loop.waitForInFlight();
    if (generation !== stopGeneration || streamState.stopped) {
      return;
    }
    await waitForRetryAfter();
    if (generation !== stopGeneration || streamState.stopped) {
      return;
    }
    await loop.flush();
    if (generation !== stopGeneration || streamState.stopped) {
      return;
    }
    const finalText = lastRequestedText.trimEnd();
    if (finalText && finalText !== lastDeliveredText.trimEnd()) {
      // A final flush bypasses normal throttle suspension. Honor Telegram's
      // retry_after before each bounded resume attempt instead of issuing a
      // guaranteed immediate 429 and falling back over already-visible pages.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await waitForRetryAfter();
        if (generation !== stopGeneration || streamState.stopped) {
          return;
        }
        const sent = await sendOrEditStreamMessage(finalText);
        if (generation !== stopGeneration) {
          return;
        }
        if (sent) {
          loop.resetPending();
          break;
        }
        if (!finalPagePlan || streamState.stopped) {
          break;
        }
      }
    }
    streamState.final = true;
    observeCurrentProviderMessage();
    await drainProviderMessageObservations();
  };

  const remainingFinalContent = (): TelegramDraftMessageSnapshot | undefined => {
    const plan = finalPagePlan;
    if (!plan || plan.nextPageIndex <= 0 || plan.nextPageIndex >= plan.pages.length) {
      return undefined;
    }
    const pages = plan.pages.slice(plan.nextPageIndex);
    const exactRemainingPage = resolveExactRemainingPage(plan);
    const exactSourceSuffix = exactRemainingPage?.sourceText;
    const sourceText =
      exactSourceSuffix ||
      pages
        .map((page) =>
          page.sourceTextMode === "html" ? page.sourceText : escapeTelegramHtml(page.text),
        )
        .join("");
    return {
      text: exactRemainingPage?.text ?? pages.map((page) => page.text).join(""),
      // Pagination has already rendered the final. Carry concrete HTML forward;
      // reparsing visible page text as Markdown can change code, links, and tags.
      sourceText,
      sourceTextMode: "html",
    };
  };

  const resetStreamToNewMessage = (
    continueFinalPagination = false,
    retainCurrentProviderMessage = false,
  ) => {
    if (retainCurrentProviderMessage) {
      observeCurrentProviderMessage();
    }
    streamState.stopped = false;
    streamState.final = continueFinalPagination;
    if (!continueFinalPagination) {
      generation += 1;
    }
    messageSendAttempted = false;
    streamMessageId = undefined;
    streamMessageSnapshot = undefined;
    streamProviderMessage = undefined;
    streamVisibleSinceMs = undefined;
    lastSentPreviewKey = "";
    if (!continueFinalPagination) {
      finalPagePlan = undefined;
      lastRequestedText = "";
      loop.resetPending();
      lastRequestedPreview = undefined;
    }
    loop.resetThrottleWindow();
  };

  // Delete a superseded preview message DETACHED (scheduled, never awaited) so
  // teardown is never stalled. The delay is at least the remaining on-screen
  // dwell (so a preview is never flashed), and at least `minDelayMs` — a
  // reposition passes a small floor so the NEW message has landed below before
  // the old one disappears, keeping the viewport anchored instead of jumping.
  const scheduleDetachedDelete = (
    messageId: number,
    visibleSince: number | undefined,
    minDelayMs = 0,
  ) => {
    const runDelete = async () => {
      try {
        const deleted = await params.api.deleteMessage(chatId, messageId);
        if (!deleted) {
          params.warn?.(
            `telegram stream preview cleanup was not confirmed (chat=${chatId}, message=${messageId})`,
          );
          return;
        }
        if (replyTargetState.kind === "retained" && replyTargetState.messageId === messageId) {
          replyTargetState = { kind: "available" };
        }
        params.log?.(`telegram stream preview deleted (chat=${chatId}, message=${messageId})`);
      } catch (err) {
        params.warn?.(`telegram stream preview cleanup failed: ${formatErrorMessage(err)}`);
      }
    };
    const elapsedMs =
      typeof visibleSince === "number" ? Date.now() - visibleSince : MIN_PREVIEW_DWELL_MS;
    const remainingDwellMs = Math.max(0, MIN_PREVIEW_DWELL_MS - elapsedMs);
    const delayMs = Math.max(remainingDwellMs, minDelayMs);
    if (delayMs <= 0) {
      void runDelete();
    } else {
      setTimeout(() => {
        void runDelete();
      }, delayMs);
    }
  };

  const clear = async () => {
    // Capture before the stop; takeMessageIdAfterStop resets streamVisibleSinceMs.
    const visibleSince = streamVisibleSinceMs;
    const messageId = await takeMessageIdAfterStop({
      stopForClear,
      readMessageId: () => streamMessageId,
      clearMessageId: () => {
        streamMessageId = undefined;
        streamMessageSnapshot = undefined;
        streamProviderMessage = undefined;
      },
    });
    if (typeof messageId === "number" && Number.isFinite(messageId)) {
      // Keep the preview on screen for at least MIN_PREVIEW_DWELL_MS from when it
      // first appeared, then delete.
      scheduleDetachedDelete(messageId, visibleSince);
    }
    await drainProviderMessageObservations();
  };

  // Reposition the window: rewind so the NEXT update creates a fresh message
  // (below anything posted since), then delete the superseded one AFTER a short
  // delay so the new message lands first. Post-new-then-delete-old — never
  // delete-then-repost, which scroll-jumps the Telegram client (the on-off
  // durable-🧠 jump). Returns the superseded message id (for tests).
  const REPOSITION_DELETE_DELAY_MS = 1_500;
  const rotateToNewMessageDeferringDelete = (): number | undefined => {
    const supersededMessageId = streamMessageId;
    const supersededVisibleSince = streamVisibleSinceMs;
    // A FIRST send may still be in flight (no id yet): mark its generation so the
    // late-landing message is deleted as a reposition, not retained as a durable
    // chunk (forceNewMessage's contract). resetStreamToNewMessage bumps
    // generation, so capture the current one before rewinding.
    if (messageSendAttempted && streamMessageId === undefined) {
      repositionedSendGenerations.add(generation);
    }
    // Rewind WITHOUT deleting; the old id is captured above.
    resetStreamToNewMessage();
    if (typeof supersededMessageId === "number" && Number.isFinite(supersededMessageId)) {
      scheduleDetachedDelete(
        supersededMessageId,
        supersededVisibleSince,
        REPOSITION_DELETE_DELAY_MS,
      );
      return supersededMessageId;
    }
    return undefined;
  };

  const finalizeToPreview = async (preview: TelegramDraftPreview): Promise<number | undefined> => {
    const finalizeGeneration = generation;
    const text = preview.text.trimEnd();
    if (!text) {
      return undefined;
    }
    // Settle pending updates so we edit the real, current window message.
    streamState.final = true;
    await loop.flush();
    if (generation !== finalizeGeneration) {
      return undefined;
    }
    // A throttled preview can still be pending (the last tool-progress line was
    // coalesced and never sent), leaving no message id even though the window
    // "rendered". Materialize it as a final flush would, so the window message
    // exists and can be edited in place — otherwise on-off collapses missed it
    // and fell back to a delete + repost.
    if (typeof streamMessageId !== "number" && !streamState.stopped) {
      const pending = lastRequestedText.trimEnd();
      if (pending && pending !== lastDeliveredText.trimEnd()) {
        const materialized = await sendOrEditStreamMessage(pending);
        if (generation !== finalizeGeneration) {
          return undefined;
        }
        if (materialized) {
          loop.resetPending();
        }
      }
    }
    // Genuinely no live window message (rv mode never rendered): caller posts a
    // fresh durable bar instead — but it must NOT delete anything.
    if (typeof streamMessageId !== "number") {
      return undefined;
    }
    // Collapse takes ownership of the live window. A stale throttled edit must
    // not replay after either this edit or the caller's durable fallback.
    loop.resetPending();
    // Replace the whole message with the bar line.
    finalPagePlan = undefined;
    lastSentPreviewKey = "";
    lastRequestedText = text;
    lastRequestedPreview = { ...preview, text };
    // The edit can fail to apply (flood-wait 429 or a terminal error both return
    // false). Report that as "not collapsed in place" so the caller falls back to
    // posting a durable bar instead of assuming the tall window became the bar.
    const edited = await sendOrEditStreamMessage(text);
    if (generation !== finalizeGeneration) {
      return undefined;
    }
    streamState.stopped = true;
    observeCurrentProviderMessage();
    await drainProviderMessageObservations();
    return edited ? streamMessageId : undefined;
  };

  params.log?.(`telegram stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);

  return {
    update: requestDraftUpdate,
    updatePreview,
    flush: loop.flush,
    messageId: () => streamMessageId,
    lastDeliveredText: () => lastDeliveredText,
    currentMessageSnapshot: () => streamMessageSnapshot,
    clear,
    stop,
    discard: async () => {
      await stopForClear();
      observeCurrentProviderMessage();
      await drainProviderMessageObservations();
    },
    remainingFinalContent,
    hasConsumedReplyTarget: () => replyTargetState.kind !== "available",
    finalizeToPreview,
    forceNewMessage: () => resetStreamToNewMessage(false, true),
    rotateToNewMessageDeferringDelete,
    sendMayHaveLanded: () => messageSendAttempted && typeof streamMessageId !== "number",
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
