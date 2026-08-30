// Discord plugin module implements draft stream behavior.
import { createFinalizableDraftStreamControlsForState } from "openclaw/plugin-sdk/channel-outbound";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createChannelMessage,
  deleteChannelMessage,
  editChannelMessage,
  type RequestClient,
} from "./internal/discord.js";
import { resolveDiscordMessageFlags } from "./send.shared.js";

/** Discord messages cap at 2000 characters. */
const DISCORD_STREAM_MAX_CHARS = 2000;
const DEFAULT_THROTTLE_MS = 1200;
const DISCORD_PREVIEW_ALLOWED_MENTIONS = { parse: [] };

type DiscordDraftStream = {
  update: (text: string) => void;
  flush: () => Promise<void>;
  messageId: () => string | undefined;
  clear: () => Promise<void>;
  deleteCurrentMessage: () => Promise<void>;
  discardPending: () => Promise<void>;
  seal: () => Promise<void>;
  stop: () => Promise<void>;
  /** Move the active draft to another Discord channel, preserving its current text. */
  retarget: (channelId: string) => Promise<void>;
  /** Retry failed preview deletes at the owning turn's cleanup boundary. */
  cleanupPendingMessages: () => Promise<void>;
  /** Reset internal state so the next update creates a new message instead of editing. */
  forceNewMessage: (mode?: "preserve" | "discard") => void;
};

type PendingCleanupMessage = { channelId: string; messageId: string; warnPrefix: string };

export function createDiscordDraftStream(params: {
  rest: RequestClient;
  channelId: string;
  maxChars?: number;
  replyToMessageId?: string | (() => string | undefined);
  throttleMs?: number;
  /** Minimum chars before sending first message (debounce for push notifications) */
  minInitialChars?: number;
  suppressEmbeds?: boolean;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}): DiscordDraftStream {
  const maxChars = Math.min(params.maxChars ?? DISCORD_STREAM_MAX_CHARS, DISCORD_STREAM_MAX_CHARS);
  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const minInitialChars = params.minInitialChars;
  let channelId = params.channelId;
  const rest = params.rest;
  const flags = resolveDiscordMessageFlags({ suppressEmbeds: params.suppressEmbeds });
  const resolveReplyToMessageId = () =>
    typeof params.replyToMessageId === "function"
      ? params.replyToMessageId()
      : params.replyToMessageId;

  const streamState = { stopped: false, final: false };
  let streamMessageId: string | undefined;
  let lastSentText = "";
  let streamGeneration = 0;
  let activeCreateGeneration: number | undefined;
  let discardActiveCreate = false;
  let pendingCleanupMessages: PendingCleanupMessage[] = [];

  const sendOrEditStreamMessage = async (text: string): Promise<boolean> => {
    const generation = streamGeneration;
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
          body: {
            content: trimmed,
            allowed_mentions: DISCORD_PREVIEW_ALLOWED_MENTIONS,
            ...(flags ? { flags } : {}),
          },
        });
        return true;
      }
      // Send new message
      const replyToMessageId = resolveReplyToMessageId()?.trim();
      const messageReference = replyToMessageId
        ? { message_id: replyToMessageId, fail_if_not_exists: false }
        : undefined;
      activeCreateGeneration = generation;
      const sent = await createChannelMessage<{ id?: string }>(rest, channelId, {
        body: {
          content: trimmed,
          allowed_mentions: DISCORD_PREVIEW_ALLOWED_MENTIONS,
          ...(flags ? { flags } : {}),
          ...(messageReference ? { message_reference: messageReference } : {}),
        },
      });
      const sentMessageId = sent?.id;
      const shouldDiscardStaleCreate = activeCreateGeneration === generation && discardActiveCreate;
      activeCreateGeneration = undefined;
      discardActiveCreate = false;
      if (generation !== streamGeneration) {
        if (shouldDiscardStaleCreate && typeof sentMessageId === "string" && sentMessageId) {
          await deleteCleanupMessage({
            channelId,
            messageId: sentMessageId,
            warnPrefix: "discord stale stream preview cleanup failed",
          });
        }
        return true;
      }
      if (typeof sentMessageId !== "string" || !sentMessageId) {
        streamState.stopped = true;
        params.warn?.("discord stream preview stopped (missing message id from send)");
        return false;
      }
      streamMessageId = sentMessageId;
      return true;
    } catch (err) {
      if (activeCreateGeneration === generation) {
        activeCreateGeneration = undefined;
        discardActiveCreate = false;
      }
      if (generation !== streamGeneration) {
        return true;
      }
      streamState.stopped = true;
      params.warn?.(`discord stream preview failed: ${formatErrorMessage(err)}`);
      return false;
    }
  };

  const { loop, update, stop, discardPending, seal } = createFinalizableDraftStreamControlsForState(
    {
      throttleMs,
      state: streamState,
      sendOrEditStreamMessage,
    },
  );

  const forceNewMessage = (mode: "preserve" | "discard" = "preserve") => {
    // In-flight REST calls may finish after a turn boundary. Advance identity
    // synchronously so their result cannot overwrite the next turn's state.
    // Block mode preserves the prior block; progress mode discards its draft.
    if (mode === "discard" && activeCreateGeneration !== undefined) {
      discardActiveCreate = true;
    }
    streamGeneration += 1;
    streamState.stopped = false;
    streamState.final = false;
    streamMessageId = undefined;
    lastSentText = "";
    loop.resetPending();
    loop.resetThrottleWindow();
  };
  const deleteCleanupMessage = async (message: PendingCleanupMessage) => {
    try {
      await deleteChannelMessage(rest, message.channelId, message.messageId);
    } catch (err) {
      pendingCleanupMessages.push(message);
      params.warn?.(`${message.warnPrefix}: ${formatErrorMessage(err)}`);
    }
  };
  const cleanupPendingMessages = async () => {
    const pending = pendingCleanupMessages;
    pendingCleanupMessages = [];
    for (const message of pending) {
      await deleteCleanupMessage(message);
    }
  };
  const retarget = async (nextChannelId: string) => {
    const normalized = nextChannelId.trim();
    if (!normalized || normalized === channelId) {
      return;
    }
    await loop.waitForInFlight();
    const pendingText = loop.takePending?.() ?? "";
    const previousChannelId = channelId;
    const previousMessageId = streamMessageId;
    const previousText = pendingText || lastSentText;
    streamGeneration += 1;
    channelId = normalized;
    streamMessageId = undefined;
    lastSentText = "";
    streamState.stopped = false;
    streamState.final = false;
    loop.resetThrottleWindow();
    if (previousText) {
      update(previousText);
      await loop.flush();
    }
    if (previousMessageId) {
      const stale = {
        channelId: previousChannelId,
        messageId: previousMessageId,
        warnPrefix: "discord stream preview retarget cleanup failed",
      };
      if (!streamMessageId) {
        pendingCleanupMessages.push(stale);
        throw new Error("discord stream preview retarget replacement failed");
      }
      await deleteCleanupMessage(stale);
    }
  };
  const deleteCurrentMessage = async () => {
    loop.resetPending();
    await loop.waitForInFlight();
    const currentMessage = streamMessageId
      ? {
          channelId,
          messageId: streamMessageId,
          warnPrefix: "discord stream preview cleanup failed",
        }
      : undefined;
    streamMessageId = undefined;
    lastSentText = "";
    loop.resetThrottleWindow();
    if (!currentMessage) {
      return;
    }
    await deleteCleanupMessage(currentMessage);
  };
  const clear = async () => {
    await discardPending();
    // Current and detached previews share one failed-delete owner for the final drain.
    await deleteCurrentMessage();
  };

  params.log?.(`discord stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);

  return {
    update,
    flush: loop.flush,
    messageId: () => streamMessageId,
    clear,
    deleteCurrentMessage,
    discardPending,
    seal,
    stop,
    retarget,
    cleanupPendingMessages,
    forceNewMessage,
  };
}
