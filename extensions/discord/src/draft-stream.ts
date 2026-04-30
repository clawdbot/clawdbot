import { createFinalizableDraftLifecycle } from "openclaw/plugin-sdk/channel-lifecycle";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createChannelMessage,
  deleteChannelMessage,
  editChannelMessage,
  type RequestClient,
} from "./internal/discord.js";

/** Discord messages cap at 2000 characters. */
const DISCORD_STREAM_MAX_CHARS = 2000;
const DEFAULT_THROTTLE_MS = 1200;
const DISCORD_PREVIEW_ALLOWED_MENTIONS = { parse: [] };

export type DiscordDraftStream = {
  update: (text: string) => void;
  flush: () => Promise<void>;
  messageId: () => string | undefined;
  clear: () => Promise<void>;
  discardPending: () => Promise<void>;
  seal: () => Promise<void>;
  stop: () => Promise<void>;
  /** Reset internal state so the next update creates a new message instead of editing. */
  forceNewMessage: () => void;
};

export function createDiscordDraftStream(params: {
  rest: RequestClient;
  channelId: string;
  maxChars?: number;
  replyToMessageId?: string | (() => string | undefined);
  throttleMs?: number;
  /** Minimum chars before sending first message (debounce for push notifications) */
  minInitialChars?: number;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}): DiscordDraftStream {
  const maxChars = Math.min(params.maxChars ?? DISCORD_STREAM_MAX_CHARS, DISCORD_STREAM_MAX_CHARS);
  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const minInitialChars = params.minInitialChars;
  const channelId = params.channelId;
  const rest = params.rest;
  const resolveReplyToMessageId = () =>
    typeof params.replyToMessageId === "function"
      ? params.replyToMessageId()
      : params.replyToMessageId;

  const streamState = { stopped: false, final: false };
  let streamMessageId: string | undefined;
  let lastSentText = "";

  const sendOrEditStreamMessage = async (text: string): Promise<boolean> => {
    // Allow final flush even if stopped (e.g., after clear()).
    if (streamState.stopped && !streamState.final) {
      return false;
    }
    const trimmed = text.trimEnd();
    if (!trimmed) {
      return false;
    }
    if (trimmed.length > maxChars) {
      // Discord messages cap at 2000 chars.
      // Stop streaming once we exceed the cap to avoid repeated API failures.
      streamState.stopped = true;
      params.warn?.(`discord stream preview stopped (text length ${trimmed.length} > ${maxChars})`);
      return false;
    }
    if (trimmed === lastSentText) {
      return true;
    }

    // Debounce first preview send for better push notification quality.
    if (streamMessageId === undefined && minInitialChars != null && !streamState.final) {
      if (trimmed.length < minInitialChars) {
        return false;
      }
    }

    lastSentText = trimmed;
    try {
      if (streamMessageId !== undefined) {
        // Edit existing message
        await editChannelMessage(rest, channelId, streamMessageId, {
          body: { content: trimmed, allowed_mentions: DISCORD_PREVIEW_ALLOWED_MENTIONS },
        });
        return true;
      }
      // Send new message
      const replyToMessageId = resolveReplyToMessageId()?.trim();
      const messageReference = replyToMessageId
        ? { message_id: replyToMessageId, fail_if_not_exists: false }
        : undefined;
      const sent = await createChannelMessage<{ id?: string }>(rest, channelId, {
        body: {
          content: trimmed,
          allowed_mentions: DISCORD_PREVIEW_ALLOWED_MENTIONS,
          ...(messageReference ? { message_reference: messageReference } : {}),
        },
      });
      const sentMessageId = sent?.id;
      if (typeof sentMessageId !== "string" || !sentMessageId) {
        streamState.stopped = true;
        params.warn?.("discord stream preview stopped (missing message id from send)");
        return false;
      }
      streamMessageId = sentMessageId;
      return true;
    } catch (err) {
      streamState.stopped = true;
      params.warn?.(`discord stream preview failed: ${formatErrorMessage(err)}`);
      return false;
    }
  };

  const readMessageId = () => streamMessageId;
  const clearMessageId = () => {
    streamMessageId = undefined;
  };
  const isValidStreamMessageId = (value: unknown): value is string => typeof value === "string";
  const deleteStreamMessage = async (messageId: string) => {
    await deleteChannelMessage(rest, channelId, messageId);
  };

  const { loop, update, stop, clear, discardPending, seal } = createFinalizableDraftLifecycle({
    throttleMs,
    state: streamState,
    sendOrEditStreamMessage,
    readMessageId,
    clearMessageId,
    isValidMessageId: isValidStreamMessageId,
    deleteMessage: deleteStreamMessage,
    warn: params.warn,
    warnPrefix: "discord stream preview cleanup failed",
  });

  const forceNewMessage = () => {
    streamMessageId = undefined;
    lastSentText = "";
    loop.resetPending();
  };

  params.log?.(`discord stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);

  return {
    update,
    flush: loop.flush,
    messageId: () => streamMessageId,
    clear,
    discardPending,
    seal,
    stop,
    forceNewMessage,
  };
}
