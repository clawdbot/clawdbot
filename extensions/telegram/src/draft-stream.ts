import type { Bot } from "grammy";
import { createFinalizableDraftLifecycle } from "openclaw/plugin-sdk/channel-lifecycle";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { buildTelegramThreadParams, type TelegramThreadSpec } from "./bot/helpers.js";
import { isSafeToRetrySendError, isTelegramClientRejection } from "./network-errors.js";
import { normalizeTelegramReplyToMessageId } from "./outbound-params.js";

const TELEGRAM_STREAM_MAX_CHARS = 4096;
const DEFAULT_THROTTLE_MS = 1000;
const TELEGRAM_DRAFT_ID_MAX = 2_147_483_647;
const THREAD_NOT_FOUND_RE = /400:\s*Bad Request:\s*message thread not found/i;
const DRAFT_METHOD_UNAVAILABLE_RE =
  /(unknown method|method .*not (found|available|supported)|unsupported)/i;
const DRAFT_CHAT_UNSUPPORTED_RE = /(can't be used|can be used only)/i;

type TelegramSendMessageDraft = (
  chatId: Parameters<Bot["api"]["sendMessage"]>[0],
  draftId: number,
  text: string,
  params?: {
    message_thread_id?: number;
    parse_mode?: "HTML";
  },
) => Promise<unknown>;

type TelegramSendMessageParams = Parameters<Bot["api"]["sendMessage"]>[2];

function hasNumericMessageThreadId(
  params: TelegramSendMessageParams | undefined,
): params is TelegramSendMessageParams & { message_thread_id: number } {
  return (
    typeof params === "object" &&
    params !== null &&
    typeof (params as { message_thread_id?: unknown }).message_thread_id === "number"
  );
}

/**
 * Keep draft-id allocation shared across bundled chunks so concurrent preview
 * lanes do not accidentally reuse draft ids when code-split entries coexist.
 */
const TELEGRAM_DRAFT_STREAM_STATE_KEY = Symbol.for("openclaw.telegramDraftStreamState");
let draftStreamState: { nextDraftId: number } | undefined;

function getDraftStreamState(): { nextDraftId: number } {
  if (!draftStreamState) {
    const globalStore = globalThis as Record<PropertyKey, unknown>;
    draftStreamState = (globalStore[TELEGRAM_DRAFT_STREAM_STATE_KEY] as
      | { nextDraftId: number }
      | undefined) ?? {
      nextDraftId: 0,
    };
    globalStore[TELEGRAM_DRAFT_STREAM_STATE_KEY] = draftStreamState;
  }
  return draftStreamState;
}

function allocateTelegramDraftId(): number {
  const state = getDraftStreamState();
  state.nextDraftId = state.nextDraftId >= TELEGRAM_DRAFT_ID_MAX ? 1 : state.nextDraftId + 1;
  return state.nextDraftId;
}

function resolveSendMessageDraftApi(api: Bot["api"]): TelegramSendMessageDraft | undefined {
  const sendMessageDraft = (api as Bot["api"] & { sendMessageDraft?: TelegramSendMessageDraft })
    .sendMessageDraft;
  if (typeof sendMessageDraft !== "function") {
    return undefined;
  }
  return sendMessageDraft.bind(api as object);
}

function shouldFallbackFromDraftTransport(err: unknown): boolean {
  const text =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : typeof err === "object" && err && "description" in err
          ? typeof err.description === "string"
            ? err.description
            : ""
          : "";
  if (!/sendMessageDraft/i.test(text)) {
    return false;
  }
  return DRAFT_METHOD_UNAVAILABLE_RE.test(text) || DRAFT_CHAT_UNSUPPORTED_RE.test(text);
}

export type TelegramDraftStream = {
  update: (text: string) => void;
  flush: () => Promise<void>;
  messageId: () => number | undefined;
  previewMode?: () => "message" | "draft";
  previewRevision?: () => number;
  lastDeliveredText?: () => string;
  clear: () => Promise<void>;
  stop: () => Promise<void>;
  /** Convert the current draft preview into a permanent message (sendMessage). */
  materialize?: () => Promise<number | undefined>;
  /** Reset internal state so the next update creates a new message instead of editing. */
  forceNewMessage: () => void;
  /** True when a preview sendMessage was attempted but the response was lost. */
  sendMayHaveLanded?: () => boolean;
};

type TelegramDraftPreview = {
  text: string;
  parseMode?: "HTML";
};

type SupersededTelegramPreview = {
  messageId: number;
  textSnapshot: string;
  parseMode?: "HTML";
};

export function createTelegramDraftStream(params: {
  api: Bot["api"];
  chatId: Parameters<Bot["api"]["sendMessage"]>[0];
  maxChars?: number;
  thread?: TelegramThreadSpec | null;
  previewTransport?: "auto" | "message" | "draft";
  replyToMessageId?: number;
  throttleMs?: number;
  /** Minimum chars before sending first message (debounce for push notifications) */
  minInitialChars?: number;
  /** Optional preview renderer (e.g. markdown -> HTML + parse mode). */
  renderText?: (text: string) => TelegramDraftPreview;
  /** Called when a late send resolves after forceNewMessage() switched generations. */
  onSupersededPreview?: (preview: SupersededTelegramPreview) => void;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}): TelegramDraftStream {
  const maxChars = Math.min(
    params.maxChars ?? TELEGRAM_STREAM_MAX_CHARS,
    TELEGRAM_STREAM_MAX_CHARS,
  );
  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const minInitialChars = params.minInitialChars;
  const chatId = params.chatId;
  const requestedPreviewTransport = params.previewTransport ?? "auto";
  const prefersDraftTransport =
    requestedPreviewTransport === "draft"
      ? true
      : requestedPreviewTransport === "message"
        ? false
        : params.thread?.scope === "dm";
  const threadParams = buildTelegramThreadParams(params.thread);
  const replyToMessageId = normalizeTelegramReplyToMessageId(params.replyToMessageId);
  const replyParams =
    replyToMessageId != null
      ? {
          ...threadParams,
          reply_to_message_id: replyToMessageId,
          allow_sending_without_reply: true,
        }
      : threadParams;
  const resolvedDraftApi = prefersDraftTransport
    ? resolveSendMessageDraftApi(params.api)
    : undefined;
  const usesDraftTransport = Boolean(prefersDraftTransport && resolvedDraftApi);
  if (prefersDraftTransport && !usesDraftTransport) {
    params.warn?.(
      "telegram stream preview: sendMessageDraft unavailable; falling back to sendMessage/editMessageText",
    );
  }

  const streamState = { stopped: false, final: false };
  let messageSendAttempted = false;
  let streamMessageId: number | undefined;
  let streamDraftId = usesDraftTransport ? allocateTelegramDraftId() : undefined;
  let previewTransport: "message" | "draft" = usesDraftTransport ? "draft" : "message";
  let lastSentText = "";
  let lastDeliveredText = "";
  let lastSentParseMode: "HTML" | undefined;
  let previewRevision = 0;
  let generation = 0;
  type PreviewSendParams = {
    renderedText: string;
    renderedParseMode: "HTML" | undefined;
    sendGeneration: number;
  };
  const sendRenderedMessageWithThreadFallback = async (sendArgs: {
    renderedText: string;
    renderedParseMode: "HTML" | undefined;
    fallbackWarnMessage: string;
  }) => {
    const sendParams = sendArgs.renderedParseMode
      ? {
          ...replyParams,
          parse_mode: sendArgs.renderedParseMode,
        }
      : replyParams;
    const usedThreadParams = hasNumericMessageThreadId(sendParams);
    try {
      return {
        sent: await params.api.sendMessage(chatId, sendArgs.renderedText, sendParams),
        usedThreadParams,
      };
    } catch (err) {
      if (!usedThreadParams || !THREAD_NOT_FOUND_RE.test(String(err))) {
        throw err;
      }
      const threadlessParams: TelegramSendMessageParams = { ...sendParams };
      delete threadlessParams.message_thread_id;
      params.warn?.(sendArgs.fallbackWarnMessage);
      return {
        sent: await params.api.sendMessage(
          chatId,
          sendArgs.renderedText,
          Object.keys(threadlessParams).length > 0 ? threadlessParams : undefined,
        ),
        usedThreadParams: false,
      };
    }
  };
  const sendMessageTransportPreview = async ({
    renderedText,
    renderedParseMode,
    sendGeneration,
  }: PreviewSendParams): Promise<boolean> => {
    if (typeof streamMessageId === "number") {
      if (renderedParseMode) {
        await params.api.editMessageText(chatId, streamMessageId, renderedText, {
          parse_mode: renderedParseMode,
        });
      } else {
        await params.api.editMessageText(chatId, streamMessageId, renderedText);
      }
      return true;
    }
    messageSendAttempted = true;
    let sent: Awaited<ReturnType<typeof sendRenderedMessageWithThreadFallback>>["sent"];
    try {
      ({ sent } = await sendRenderedMessageWithThreadFallback({
        renderedText,
        renderedParseMode,
        fallbackWarnMessage:
          "telegram stream preview send failed with message_thread_id, retrying without thread",
      }));
    } catch (err) {
      // Pre-connect failures (DNS, refused) and explicit Telegram rejections (4xx)
      // guarantee the message was never delivered — clear the flag so
      // sendMayHaveLanded() doesn't suppress fallback.
      if (isSafeToRetrySendError(err) || isTelegramClientRejection(err)) {
        messageSendAttempted = false;
      }
      throw err;
    }
    const sentMessageId = sent?.message_id;
    if (typeof sentMessageId !== "number" || !Number.isFinite(sentMessageId)) {
      streamState.stopped = true;
      params.warn?.("telegram stream preview stopped (missing message id from sendMessage)");
      return false;
    }
    const normalizedMessageId = Math.trunc(sentMessageId);
    if (sendGeneration !== generation) {
      params.onSupersededPreview?.({
        messageId: normalizedMessageId,
        textSnapshot: renderedText,
        parseMode: renderedParseMode,
      });
      return true;
    }
    streamMessageId = normalizedMessageId;
    return true;
  };
  const sendDraftTransportPreview = async ({
    renderedText,
    renderedParseMode,
  }: PreviewSendParams): Promise<boolean> => {
    const draftId = streamDraftId ?? allocateTelegramDraftId();
    streamDraftId = draftId;
    const draftParams = {
      ...(threadParams?.message_thread_id != null
        ? { message_thread_id: threadParams.message_thread_id }
        : {}),
      ...(renderedParseMode ? { parse_mode: renderedParseMode } : {}),
    };
    await resolvedDraftApi!(
      chatId,
      draftId,
      renderedText,
      Object.keys(draftParams).length > 0 ? draftParams : undefined,
    );
    return true;
  };

  const sendOrEditStreamMessage = async (text: string): Promise<boolean> => {
    // Allow final flush even if stopped (e.g., after clear()).
    if (streamState.stopped && !streamState.final) {
      return false;
    }
    const trimmed = text.trimEnd();
    if (!trimmed) {
      return false;
    }
    const rendered = params.renderText?.(trimmed) ?? { text: trimmed };
    const renderedText = rendered.text.trimEnd();
    const renderedParseMode = rendered.parseMode;
    if (!renderedText) {
      return false;
    }
    if (renderedText.length > maxChars) {
      // Telegram text messages/edits cap at 4096 chars.
      // Stop streaming once we exceed the cap to avoid repeated API failures.
      streamState.stopped = true;
      params.warn?.(
        `telegram stream preview stopped (text length ${renderedText.length} > ${maxChars})`,
      );
      return false;
    }
    if (renderedText === lastSentText && renderedParseMode === lastSentParseMode) {
      return true;
    }
    const sendGeneration = generation;

    // Debounce first preview send for better push notification quality.
    if (typeof streamMessageId !== "number" && minInitialChars != null && !streamState.final) {
      if (renderedText.length < minInitialChars) {
        return false;
      }
    }

    lastSentText = renderedText;
    lastSentParseMode = renderedParseMode;
    try {
      let sent = false;
      if (previewTransport === "draft") {
        try {
          sent = await sendDraftTransportPreview({
            renderedText,
            renderedParseMode,
            sendGeneration,
          });
        } catch (err) {
          if (!shouldFallbackFromDraftTransport(err)) {
            throw err;
          }
          previewTransport = "message";
          streamDraftId = undefined;
          params.warn?.(
            "telegram stream preview: sendMessageDraft rejected by API; falling back to sendMessage/editMessageText",
          );
          sent = await sendMessageTransportPreview({
            renderedText,
            renderedParseMode,
            sendGeneration,
          });
        }
      } else {
        sent = await sendMessageTransportPreview({
          renderedText,
          renderedParseMode,
          sendGeneration,
        });
      }
      if (sent) {
        previewRevision += 1;
        lastDeliveredText = trimmed;
      }
      return sent;
    } catch (err) {
      streamState.stopped = true;
      params.warn?.(`telegram stream preview failed: ${formatErrorMessage(err)}`);
      return false;
    }
  };

  const { loop, update, stop, clear } = createFinalizableDraftLifecycle({
    throttleMs,
    state: streamState,
    sendOrEditStreamMessage,
    readMessageId: () => streamMessageId,
    clearMessageId: () => {
      streamMessageId = undefined;
    },
    isValidMessageId: (value): value is number =>
      typeof value === "number" && Number.isFinite(value),
    deleteMessage: async (messageId) => {
      await params.api.deleteMessage(chatId, messageId);
    },
    onDeleteSuccess: (messageId) => {
      params.log?.(`telegram stream preview deleted (chat=${chatId}, message=${messageId})`);
    },
    warn: params.warn,
    warnPrefix: "telegram stream preview cleanup failed",
  });

  const forceNewMessage = () => {
    // Boundary rotation may call stop() to finalize the previous draft.
    // Re-open the stream lifecycle for the next assistant segment.
    streamState.final = false;
    generation += 1;
    messageSendAttempted = false;
    streamMessageId = undefined;
    if (previewTransport === "draft") {
      streamDraftId = allocateTelegramDraftId();
    }
    lastSentText = "";
    lastSentParseMode = undefined;
    loop.resetPending();
    loop.resetThrottleWindow();
  };

  /**
   * Materialize the current draft into a permanent message.
   * For draft transport: sends the accumulated text as a real sendMessage.
   * For message transport: the message is already permanent (noop).
   * Returns the permanent message id, or undefined if nothing to materialize.
   */
  const materialize = async (): Promise<number | undefined> => {
    await stop();
    // If using message transport, the streamMessageId is already a real message.
    if (previewTransport === "message" && typeof streamMessageId === "number") {
      return streamMessageId;
    }
    // For draft transport, use the rendered snapshot first so parse_mode stays
    // aligned with the text being materialized.
    const renderedText = lastSentText || lastDeliveredText;
    if (!renderedText) {
      return undefined;
    }
    const renderedParseMode = lastSentText ? lastSentParseMode : undefined;
    try {
      const { sent, usedThreadParams } = await sendRenderedMessageWithThreadFallback({
        renderedText,
        renderedParseMode,
        fallbackWarnMessage:
          "telegram stream preview materialize send failed with message_thread_id, retrying without thread",
      });
      const sentId = sent?.message_id;
      if (typeof sentId === "number" && Number.isFinite(sentId)) {
        streamMessageId = Math.trunc(sentId);
        // Clear the draft so Telegram's input area doesn't briefly show a
        // stale copy alongside the newly materialized real message.
        if (resolvedDraftApi != null && streamDraftId != null) {
          const clearDraftId = streamDraftId;
          const clearThreadParams =
            usedThreadParams && threadParams?.message_thread_id != null
              ? { message_thread_id: threadParams.message_thread_id }
              : undefined;
          try {
            await resolvedDraftApi(chatId, clearDraftId, "", clearThreadParams);
          } catch {
            // Best-effort cleanup; draft clear failure is cosmetic.
          }
        }
        return streamMessageId;
      }
    } catch (err) {
      params.warn?.(`telegram stream preview materialize failed: ${formatErrorMessage(err)}`);
    }
    return undefined;
  };

  params.log?.(`telegram stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);

  return {
    update,
    flush: loop.flush,
    messageId: () => streamMessageId,
    previewMode: () => previewTransport,
    previewRevision: () => previewRevision,
    lastDeliveredText: () => lastDeliveredText,
    clear,
    stop,
    materialize,
    forceNewMessage,
    sendMayHaveLanded: () => messageSendAttempted && typeof streamMessageId !== "number",
  };
}

export const __testing = {
  resetTelegramDraftStreamForTests() {
    getDraftStreamState().nextDraftId = 0;
  },
};
