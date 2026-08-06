// Googlechat plugin module implements monitor reply delivery behavior.
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { OpenClawConfig } from "../runtime-api.js";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { deleteGoogleChatMessage, sendGoogleChatMessage, updateGoogleChatMessage } from "./api.js";
import type { GoogleChatCoreRuntime, GoogleChatRuntimeEnv } from "./monitor-types.js";

export type GoogleChatTypingMessage =
  | {
      placement: "top-level";
      name: string;
    }
  | {
      placement: "thread";
      name: string;
      requestedThreadName: string;
      deliveredThreadName: string;
    };

export function createGoogleChatTypingMessage(params: {
  messageName: string;
  requestedThreadName?: string;
  deliveredThreadName?: string;
}): GoogleChatTypingMessage {
  const name = params.messageName.trim();
  const requestedThreadName = params.requestedThreadName?.trim();
  if (!requestedThreadName) {
    return { placement: "top-level", name };
  }
  return {
    placement: "thread",
    name,
    requestedThreadName,
    deliveredThreadName: params.deliveredThreadName?.trim() || requestedThreadName,
  };
}

export async function deliverGoogleChatReply(params: {
  payload: {
    text?: string;
    mediaUrls?: string[];
    mediaUrl?: string;
    replyToId?: string;
  };
  account: ResolvedGoogleChatAccount;
  spaceId: string;
  runtime: GoogleChatRuntimeEnv;
  core: GoogleChatCoreRuntime;
  config: OpenClawConfig;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  typingMessage?: GoogleChatTypingMessage;
}): Promise<void> {
  const { payload, account, spaceId, runtime, core, config, statusSink } = params;
  // Clear this whenever the typing message is deleted or unavailable; otherwise
  // text delivery can keep retrying a dead message and drop content.
  let typingMessage = params.typingMessage;
  const replyThreadName = payload.replyToId?.trim() || undefined;
  const reply = resolveSendableOutboundReplyParts(payload);
  const text = reply.text;
  let firstTextChunk = true;
  let deliveryThreadName = replyThreadName;

  const typingMatchesReply =
    typingMessage?.placement === "thread"
      ? typingMessage.requestedThreadName === replyThreadName
      : typingMessage?.placement === "top-level"
        ? replyThreadName === undefined
        : false;
  if (typingMessage && !typingMatchesReply) {
    // Typing starts before reply directives are resolved. Never edit a placeholder
    // from one thread into a final reply targeted at another conversation surface.
    try {
      await deleteGoogleChatMessage({ account, messageName: typingMessage.name });
    } catch (err) {
      runtime.error?.(`Google Chat typing cleanup failed: ${String(err)}`);
    }
    typingMessage = undefined;
  } else if (typingMessage?.placement === "thread") {
    // The requested thread decides whether the placeholder still belongs to this reply;
    // the provider-returned thread owns every later physical send after fallback.
    deliveryThreadName = typingMessage.deliveredThreadName;
  }

  if (reply.hasMedia) {
    runtime.error?.(
      "Google Chat outbound attachments require user OAuth and are not supported by this service-account channel; sending text fallback only.",
    );
  }

  if (reply.hasMedia && !reply.hasText) {
    try {
      if (typingMessage) {
        await deleteGoogleChatMessage({ account, messageName: typingMessage.name });
      }
    } catch (err) {
      runtime.error?.(`Google Chat typing cleanup failed: ${String(err)}`);
    }
    throw new Error(
      "Google Chat outbound attachments require user OAuth and no text fallback is available.",
    );
  }

  const chunkLimit = account.config.textChunkLimit ?? 4000;
  const chunkMode = core.channel.text.resolveChunkMode(config, "googlechat", account.accountId);
  const recordOutboundStatus = () => {
    try {
      statusSink?.({ lastOutboundAt: Date.now() });
    } catch (err) {
      runtime.error?.(`Google Chat outbound status update failed: ${String(err)}`);
    }
  };
  const sendTextMessage = async (chunk: string) => {
    const sent = await sendGoogleChatMessage({
      account,
      space: spaceId,
      text: chunk,
      thread: deliveryThreadName,
    });
    if (replyThreadName) {
      deliveryThreadName = sent?.threadName?.trim() || deliveryThreadName;
    }
  };
  const chunks = core.channel.text.chunkMarkdownTextWithMode(text, chunkLimit, chunkMode);
  for (const chunk of chunks) {
    if (!chunk) {
      continue;
    }
    if (firstTextChunk && typingMessage) {
      try {
        await updateGoogleChatMessage({
          account,
          messageName: typingMessage.name,
          text: chunk,
        });
      } catch (err) {
        // The typing placeholder may already be gone; resend the chunk as a new
        // message below. Only the resend failing counts as a delivery failure.
        runtime.error?.(`Google Chat message send failed: ${String(err)}`);
        typingMessage = undefined;
      }
      if (typingMessage) {
        firstTextChunk = false;
        recordOutboundStatus();
        continue;
      }
    }
    // Core delivery contract: a failed send must reject so the reply dispatcher
    // routes to onError instead of recording a dropped chunk as delivered.
    await sendTextMessage(chunk);
    firstTextChunk = false;
    recordOutboundStatus();
  }
}
