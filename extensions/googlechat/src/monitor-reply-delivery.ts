// Googlechat plugin module implements monitor reply delivery behavior.
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { OpenClawConfig } from "../runtime-api.js";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { deleteGoogleChatMessage, sendGoogleChatMessage, updateGoogleChatMessage } from "./api.js";
import type { GoogleChatCoreRuntime, GoogleChatRuntimeEnv } from "./monitor-types.js";

export type GoogleChatTypingMessage = {
  name: string;
  thread?: string;
};

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
  const typingMessageThreadName = typingMessage?.thread?.trim() || undefined;
  const reply = resolveSendableOutboundReplyParts(payload);
  const text = reply.text;
  let firstTextChunk = true;

  if (typingMessage && typingMessageThreadName !== replyThreadName) {
    // Typing starts before reply directives are resolved. Never edit a placeholder
    // from one thread into a final reply targeted at another conversation surface.
    try {
      await deleteGoogleChatMessage({ account, messageName: typingMessage.name });
    } catch (err) {
      runtime.error?.(`Google Chat typing cleanup failed: ${String(err)}`);
    }
    typingMessage = undefined;
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
  const sendTextMessage = async (chunk: string) => {
    await sendGoogleChatMessage({
      account,
      space: spaceId,
      text: chunk,
      thread: replyThreadName,
    });
  };
  const chunks = core.channel.text.chunkMarkdownTextWithMode(text, chunkLimit, chunkMode);
  for (const chunk of chunks) {
    if (!chunk) {
      continue;
    }
    try {
      if (firstTextChunk && typingMessage) {
        await updateGoogleChatMessage({
          account,
          messageName: typingMessage.name,
          text: chunk,
        });
      } else {
        await sendTextMessage(chunk);
      }
      firstTextChunk = false;
      statusSink?.({ lastOutboundAt: Date.now() });
    } catch (err) {
      runtime.error?.(`Google Chat message send failed: ${String(err)}`);
      if (firstTextChunk && typingMessage) {
        typingMessage = undefined;
        try {
          await sendTextMessage(chunk);
          statusSink?.({ lastOutboundAt: Date.now() });
        } catch (fallbackErr) {
          runtime.error?.(`Google Chat message fallback send failed: ${String(fallbackErr)}`);
        } finally {
          firstTextChunk = false;
        }
      }
    }
  }
}
