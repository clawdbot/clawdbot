import type { MoltbotConfig } from "clawdbot/plugin-sdk";

import { sendZoomMessage } from "./api.js";
import { createZoomConversationStoreFs } from "./conversation-store-fs.js";
import {
  classifyZoomSendError,
  formatZoomSendErrorHint,
  formatUnknownError,
} from "./errors.js";
import { getZoomRuntime } from "./runtime.js";
import { resolveZoomCredentials } from "./token.js";
import type { ZoomConfig } from "./types.js";

export type SendZoomMessageParams = {
  /** Full config (for credentials) */
  cfg: MoltbotConfig;
  /** Conversation ID (user JID or channel JID) to send to */
  to: string;
  /** Message text */
  text: string;
  /** Whether this is a channel message */
  isChannel?: boolean;
  /** Optional: reply to a specific message */
  replyToMessageId?: string;
};

export type SendZoomMessageResult = {
  messageId: string;
  conversationId: string;
};

/** Zoom Team Chat message limit */
const ZOOM_TEXT_CHUNK_LIMIT = 4000;

/**
 * Send a text message to a Zoom Team Chat conversation.
 */
export async function sendZoomTextMessage(
  params: SendZoomMessageParams,
): Promise<SendZoomMessageResult> {
  const { cfg, to, text, isChannel, replyToMessageId } = params;
  const zoomCfg = cfg.channels?.zoom as ZoomConfig | undefined;
  const creds = resolveZoomCredentials(zoomCfg);

  if (!creds) {
    throw new Error("Zoom credentials not configured");
  }

  const core = getZoomRuntime();
  const log = core.logging.getChildLogger({ name: "zoom" });

  // Get conversation reference for account_id if needed
  const conversationStore = createZoomConversationStoreFs();
  const storedRef = await conversationStore.get(to);
  const accountId = storedRef?.accountId ?? creds.accountId;

  log.debug("sending message", {
    to,
    isChannel,
    textLength: text.length,
  });

  // Build message content using Zoom's format
  // Zoom requires both head (title) and body (message content)
  const content = {
    head: {
      text: "Moltbot",
    },
    body: [
      {
        type: "message" as const,
        text: text.slice(0, ZOOM_TEXT_CHUNK_LIMIT),
      },
    ],
  };

  try {
    const result = await sendZoomMessage(creds, {
      robotJid: creds.botJid,
      toJid: to,
      accountId,
      content,
      isChannel,
      replyMainMessageId: replyToMessageId,
    });

    if (!result.ok) {
      const err = { statusCode: result.status, message: result.error };
      const classification = classifyZoomSendError(err);
      const hint = formatZoomSendErrorHint(classification);
      const status = classification.statusCode ? ` (HTTP ${classification.statusCode})` : "";
      throw new Error(
        `zoom send failed${status}: ${result.error ?? "unknown error"}${hint ? ` (${hint})` : ""}`,
      );
    }

    const messageId = result.data?.message_id ?? "unknown";

    log.info("sent message", { to, messageId });

    return {
      messageId,
      conversationId: to,
    };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("zoom send failed")) {
      throw err;
    }
    const classification = classifyZoomSendError(err);
    const hint = formatZoomSendErrorHint(classification);
    const status = classification.statusCode ? ` (HTTP ${classification.statusCode})` : "";
    throw new Error(
      `zoom send failed${status}: ${formatUnknownError(err)}${hint ? ` (${hint})` : ""}`,
    );
  }
}

/**
 * List all known conversation references (for debugging/CLI).
 */
export async function listZoomConversations(): Promise<
  Array<{
    conversationId: string;
    userName?: string;
    conversationType?: string;
  }>
> {
  const store = createZoomConversationStoreFs();
  const all = await store.list();
  return all.map(({ conversationId, reference }) => ({
    conversationId,
    userName: reference.userName,
    conversationType: reference.conversationType,
  }));
}
